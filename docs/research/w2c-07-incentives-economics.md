# w2c-07 - Why would visitors seed? Incentives, fairness and realistic P2P offload

- **Project:** magnet-web (static loader + Service Worker, sites fetched by magnet link over WebTorrent, visitors seed while a tab is open, signed site ledger, pointer from fragment / `<meta>` / DNS TXT over DoH / cache)
- **Topic:** evidence on altruistic seeding in browser P2P and BitTorrent, free-riding and tit-for-tat in small swarms, token-incentive history, "proof of visit", ethical defaults, measured acceptance of "this site shares your bandwidth" notices, visitor data costs by region, a "thanks" UX without dark patterns, and a Little's-law calculator for expected concurrent peers; ends with an honest economics text for the docs and a default incentive design
- **Research date:** 2026-10-17. Every "current" statement is as of this date. Sources older than 2024 are marked **(OLD)**. This topic leans on OLD measurement papers because I found no newer public dataset of browser-P2P offload by audience size (see section 7).
- **Resume note:** on resume, `docs/research/` held no `w2c-07-*` file and the session scratchpad held no notes for this topic, so nothing was lost or overwritten. Working notes with every source read are kept in the session scratchpad (`.../scratchpad/w2c07/notes/`); the calculator and its outputs are in `docs/research/labs/w2c-07-lab/` (`little-calc.mjs`, `RUN.txt`, `results/`). While I worked, other agents rebuilt `src/loader/{policy,config,ui,app,torrent,strings}.js` (last write seen 18:13 ET); section 5 describes the tree as read at about 18:15 ET and uses function names rather than line numbers because the files are still moving.
- **Method limits (read this):** the shared WebSearch budget (200 calls per turn, all agents) was already used up when this task started, so I made **zero** successful searches (my first five calls were refused with "web search budget is used up" and I did not retry). Every source is a direct fetch of a known primary URL (papers as PDFs read with `pdftotext`, raw GitHub files, vendor docs, price lists, public JSON/CSV APIs, filter lists). I did not use search engines, archives or proxies. Pages summarised by the fetch tool's small model are labelled **WebFetch summary**; I quote only strings I also saw in raw text, otherwise I say so. Hosts that did not answer from this machine on 2026-10-17 (curl status 000): `streamroot.io`, `peer5.com`, `docs.peer5.com`, `filstation.app`, `spark.filecoin.io`, `saturn.tech`, `doc.bittorrent.com`, `docs.btfs.io`. This is a gap, not a finding about those projects. Dash glyphs inside quotations are normalised to ASCII hyphens.
- **Confidence legend:** **High** = primary text read in this session and a second independent source (or my own computation/simulation) agrees. **Medium** = one primary source, or a WebFetch summary of a primary page. **Low** = secondary source or inference (labelled). **Model** = my calculation from stated assumptions, not a measurement.
- **[DESIGN-CRITICAL]** = would change the architecture or a compatibility promise if wrong.
- **Overlap:** `w1-07-prior-art.md` (PeerTube retreat F21, availability is a business problem F-3, pinner R1), `w2b-06-abuse-legal-ops.md` (legal basis for IP exposure, PeerTube notice, Tor/EFF), `w2b-04-observability-no-backend.md` (offload-ratio telemetry, randomized response arithmetic), `03-webrtc-nat-privacy.md` (STUN-only success, CGN on cellular), `w1-10-static-hosting-bootstrap.md` (hosting prices, egress), `review/distributed-systems.md` (first Little's-law table, peer path latency). This file adds the free-riding and defaults evidence, volunteer-network numbers, token history, filter-list posture, consent-rate data, visitor cost arithmetic, a validated concurrency/offload model, and the default incentive design.
- **Baseline I checked recommendations against:** `docs/ARCHITECTURE.md` v0.2 section 8 (policy table, consent), `docs/review/DESIGN-REVIEW.md` section 4.5 (consent strings), `src/loader/policy.js` and `src/loader/config.js` (column policy table), `src/loader/torrent.js` (choke lock, `setUploadsEnabled`), `src/loader/ui.js`, `src/loader/strings.js` and `src/loader/app.js` (consent notice, gate, `pending`/`accepted`/`host-only` states).

---

## 1. Summary

1. **Visitors do not seed because of anything we give them; they seed because of a default, a cause, or enforcement.** Akamai NetSession (25 M+ clients, no tit-for-tat): of 23.3 M installs, 31.7% shipped with uploads on, and **98.11%** of those never changed it, while **99.96%** of the 15.9 M that shipped with uploads off never turned them on (only 0.04% of the default-off group ever changed the setting, against 1.89% of the default-on group). By customer default the share with uploads on ranged from under 1% to 94%. Cause-driven volunteers (Snowflake, Conduit, BOINC) and enforced ratios (private BitTorrent trackers: 2% never seed vs 20% in The Pirate Bay) are the other two routes. A static-site loader can use none of the three at full strength: a silent default-on is exactly what blocklists punish (item 8), nobody is moved by a cause on an arbitrary website, and there is no ratio to enforce. So seeding must be a by-product of caching plus honest, bounded defaults, and **availability must come from a web seed or a pinner, not from visitors**. [DESIGN-CRITICAL]
2. **Reciprocity is free and nearly empty.** In the local `webtorrent@3.0.21` source the default is 10 upload slots (9 ranked by download speed plus 1 optimistic), rechoked every 10 s, so up to 10 interested peers are all unchoked and tit-for-tat changes nothing in a small swarm. Measured elsewhere: where seeds are plentiful, free riders download as fast or faster (Andrade 2005); with ratio enforcement tit-for-tat is "hardly influential" (Meulpolder 2010); BitTorrent performance depends on "significant altruism from high capacity peers" (Piatek 2007). Keep what WebTorrent already does; do not market fairness. [DESIGN-CRITICAL for wording]
3. **Offload needs a crowd, and our crowd is small.** NetSession: peer efficiency "below 10%" with fewer than 50 registered copies, about 80% at about 10,000 copies, and 80% with about 25-30 peers suggested per download; that system moved GB-sized files for 25 M clients with a trusted control plane. Little's-law model (60 s mean dwell, 3 s to become a seeder, Poisson arrivals): 25 eligible seeders online needs about **448,000 visits/day** under baseline eligibility (82,000 optimistic, 9 million pessimistic). A site with 1,000 visits/day is alone on arrival 50% of the time (E[N] = 0.69). [DESIGN-CRITICAL]
4. **Small sites get about 0% offload even when peers exist, and dollar savings are tiny.** The peer path needs 1.5-3 s before bytes flow (`review/distributed-systems.md`); a web seed at 8 MiB/s delivers 16 MiB in that time, so in a parallel race any site up to about 16 MiB finishes before the first peer wire is useful (model). A 50 MiB site gets an expected 17% of its bytes from peers when 3 eligible seeders are online on average, and 37% at 10 (model). At CloudFront list price (US/EU $0.085/GB first 10 TB, $0.025/GB beyond 1 PB, price list of 2026-10-03) the saving is $0 for 5 MiB sites at any traffic level and about $50/month for a 50 MiB site at 10,000 visits/day; R2 egress is free, GitHub Pages has a 100 GB/month soft limit, the CloudFront flat-rate Free plan includes 100 GB. Sell P2P as resilience and host independence, not as a hosting-bill reduction below very large scale.
5. **A mobile visitor pays about 30 times what the host saves.** Cable.co.uk (2023 edition, OLD): global mean USD 2.59/GB (Israel 0.02, Zimbabwe 43.75, Northern America 4.59, Sub-Saharan Africa 3.31). Uploading 15 MiB costs $0.038 at the mean against $0.00125 saved at CDN list: 30.5x. Wikimedia's human page views are 63-88% mobile, web plus app (three projects, 45 days), and only Chromium on Android exposes `connection.type`. So "uploads off on cellular/unknown" in ARCH section 8 is economically necessary; the same rule means most visitors can never seed (desktop is 12-38% of Wikimedia views).
6. **Token incentives: the record is poor and the unit economics are worse.** CoinGecko on 2026-10-17: BTT -89.6% from its 2022-01-20 all-time high, THETA -98.8%, TFUEL -98.7%, FIL -99.56%, LPT -98.3%. Filecoin Station (earn FIL for idle resources) carries "This repository is no longer mantained" with an announcement dated 2025-06-10 (decoded from the tweet id); BitTorrent's own BTT page (v1.3.13, 2026) still marks BTFS "Coming soon"; Theta now describes GPU compute for AI. A payment per MiB uploaded is about $0.00008 at CDN list prices, far below any payment-rail minimum. Verifying "who uploaded what" needs a trusted party (NetSession: its edge servers; BOINC: replication; Privacy Pass: hoarding attacks). **No tokens, no points.** [DESIGN-CRITICAL]
7. **Volunteers exist where there is a cause, and a "keep this tab open" widget is the weakest channel.** Snowflake broker metrics (24 h window ending 2026-10-17): 139,657 distinct proxy IPs; browser extension 80,704 (57.8%), mobile-embedded `iptproxy` 25,392 (18.2%), standalone 5,974 (4.3%), **web badge 306 (0.22%)**; 34.1 M idle polls vs 7.7 M client matches (supply exceeds demand). Psiphon Conduit shows 2,168,237 stations on its page; BOINC has about 700,000 active devices, with 5-10% of people who learn about volunteer computing taking part, and corporate-branded clients produced no "significant long-term increase". The badge figure is not a conversion rate (the number of embedding sites is unknown) but the shape is clear.
8. **Social licence is a hard constraint.** uBlock Origin's default-enabled "uBlock filters - Privacy" list (2026-10-16 build) contains the merged resource-abuse rules; their source header says such scripts "MUST be opt-in, with complete informed consent from the visitor". They block Edgemesh, Streamroot DNA (france.tv, rt.com, tf1), Douyu and Huya P2P libraries and disable WebRTC on bilibili.com and v.qq.com. The france.tv report reads "I didn't opt-in to anything ... just like a crypto miner would use your CPU without asking." Hola sold users' bandwidth as Luminati at $20/GB and added a disclosure only after a public complaint (2015). EasyPrivacy, StevenBlack, AdGuard DNS, HaGeZi Pro and OISD list `tracker.cdnbye.com`; magnet-web's default trackers and STUN hosts appeared on none of the lists I tested. [DESIGN-CRITICAL]
9. **Disclosure design moves participation more than any reward could.** Utz et al. (CCS 2019, more than 80,000 users): 5.5% to 55% of visitors interact with a consent notice depending on screen size, position and device; highlighting "Accept" lifted accepts from 39.2% to 50.8% on mobile and 21.1% to 26.9% on desktop. Nouwens et al. (CHI 2020, n = 40): removing the refuse button from the first page adds 22-23 percentage points. EDPB 03/2022: "lack of consent should be considered the default state, until consent has been given." An honest, symmetric prompt yields low participation; the model uses 5-30% for an explicit click and treats a stored consent from a returning visitor as the main lever.
10. **Dwell time makes the swarm thinner than traffic suggests.** Chartbeat (2014, OLD): 55% of visits had under 15 s of active time. One German site's analytics (Utz 2019): 84.81% under 10 s, 5.21% 11-60 s, 5.83% up to 3 min. Dwell is heavy-tailed ("negative aging", Liu/White/Dumais 2010), so the mean is far above the median (model: Weibull shape 0.6, mean 60 s, median 21.6 s) and the longest 10% of visits carry about half of all dwell time. Little's law and the M/G/infinity insensitivity result still hold for the **mean**: my simulation gives variance/mean 0.998-1.002 for Weibull dwell (Poisson). Diurnal factor from 36 full days of Wikimedia hourly views: peak hour 1.25x the daily mean for English (global audience) and 1.63-1.94x for German, Persian and Japanese; trough 0.74x (English) and 0.21-0.32x (German, Persian, Japanese).
11. **Fairness means bounded generosity.** Windows Delivery Optimization (doc of 2026-05-20): default LAN-only peering, Internet peering opt-in, 20 GB/month upload cap to Internet peers, no uploads on battery by default, none on VPN, files of 50 MB and up only. Microsoft eCDN: viewers "only share while they're actually watching", WAN peering off by default. Psiphon Conduit: user-set maximum peers and maximum MB/s per peer, estimated usage shown, "counts toward your data plan". magnet-web caps the **rate** (1 MiB/s desktop, 256 KiB/s mobile Wi-Fi, 0 on cellular) but has **no byte budget**; add one.
12. **Default incentive design: none beyond (a) free tit-for-tat, (b) the self-interest by-product of a verified offline copy and instant revisits, (c) transparency (live sharing meter, visible caps, plain language), (d) one rate-limited, non-manipulative thanks message, and (e) availability from an owner web seed or pinner.** No tokens, points, streaks, leaderboards or guilt copy (section 4).
13. **A calculator and tables are shipped** in `docs/research/labs/w2c-07-lab/` and summarised in section 3 and Appendix B. They are model outputs; the model's only measured inputs are the ones cited.
14. **Not verified:** Streamroot, Peer5 and Swarmify offload-by-audience curves (hosts unreachable or no figures on the pages reached); PeerTube's actual P2P ratio (no published statistic found); Spotify's paper numbers (PDF 404); newer-than-2023 mobile data prices; Honeygain/EarnApp payout rates (403). See sections 7 and 8.

---

## 2. Findings

Source IDs (S1...) are defined in Appendix A; every URL there was actually fetched on 2026-10-17 unless a date says otherwise. "Source date" is the publication or last-update date of the source where one was visible.

### 2.1 Free riding, defaults and offload evidence

**F1 Without incentives or a default, contribution is concentrated in a small minority (OLD).** *Confidence: High for the 2000 numbers, Medium for the 2005 figure.*
- Adar and Huberman sampled Gnutella for 24 hours in August 2000: 33,335 hosts sharing 3,100,464 files after removing NAT hosts. "22,084, or approximately 66%, of the peers share no files, and ... 73% share ten or less files." The top 1% of sharing hosts returned "nearly 47% of all answers, and the top 25 percent provide 98%."
- Andrade et al. (2005) cite Hughes et al. (2005) for 85% free riders on Gnutella (I did not read Hughes).
- Sources: S5, S6. Source dates: 2000-10 (OLD), 2005-08 (OLD).

**F2 Seeding after completion is brief unless a community enforces ratios (OLD).** *Confidence: High (two independent measurement papers agree).*
- Andrade 2005: "no incentive for seeding is present in the protocol"; in one community (etree, hourly snapshots over 10 days in March 2005, 2,500-3,700 seeders) "A majority of seeders do not remain seeding for more than a day."
- Meulpolder 2010 (more than 500,000 peers, five communities): The Pirate Bay "20% of the peers do not seed at all, 44% of the peers seed for less than one hour, and only 13% of the peers seed more [than] 1 day"; EZTV 20% more than a day; their 2003-04 data: "83% of 53,883 measured peers were seeding for less than one hour". In private communities with ratio enforcement "more than 43% of the peers are seeding longer than 1 day and even 6-9% ... longer than 1 week"; PolishTracker: only 2% never seed. Their reading: "communities have to rely either on altruism or on some additional incentive mechanism".
- Browser analogue: a tab "seeds" until the visitor leaves, and median dwell is seconds (F26).
- Sources: S6, S7. Source dates: 2005-08, 2010-04 (both OLD).

**F3 [DESIGN-CRITICAL] Tit-for-tat is mechanically empty in small swarms and weak when seeds are plentiful.** *Confidence: High (code read plus four papers).*
- BEP 3: a peer unchokes "the four peers which it has the best download rates from and are interested", re-evaluates "once every ten seconds", and one optimistic unchoke "rotates every 30 seconds"; a complete peer "uses its upload rate rather than its download rate".
- Local `webtorrent@3.0.21` `lib/torrent.js`: `RECHOKE_INTERVAL = 10_000`; `_rechokeNumSlots` is the `uploads` option, default **10**, and `false`/`0` gives 0; `_rechoke()` unchokes wires in rank order until `numInterestedUnchoked < _rechokeNumSlots - 1` (9), then picks one random interested wire as the optimistic unchoke, and chokes only the rest. Up to 10 interested peers are therefore all unchoked; reciprocity can only bite above that. (This is also why a runtime "uploads off" needs the choke lock in `torrent.js`: `_rechokeNumSlots` is fixed when the torrent is constructed and `_rechoke()` re-issues `unchoke()` every 10 s.)
- Measured: with plentiful seeders "freeriders may download faster than collaborating peers" (Andrade, 21 torrents, Oct 2004 and Mar 2005); "tit-for-tat is almost irrelevant" where seeders supply the data and, with ratio enforcement, "hardly influential anymore" (Meulpolder); tit-for-tat "works reasonably well during flashcrowds, but is insufficient for sustainable performance" (Meulpolder); "all peers contribute resources that do not directly improve their performance" and "Average download times currently depend on significant altruism from high capacity peers" (Piatek 2007); NetSession runs with no tit-for-tat at all and still gets 71.4% peer efficiency (F5).
- Implication: for magnet-web the web seed and any pinner are "plentiful seeds", so free riding costs nothing and reciprocity is a side effect, not an incentive. Wording must not promise "fair sharing".
- Sources: S2, S3, S4, S6, S7, S8, S1. Source dates: BEP 3 (2008 text, current page); Cohen 2003-05-22 (OLD); local source read 2026-10-17.

**F4 [DESIGN-CRITICAL] Defaults, not preferences, decide participation.** *Confidence: High (primary table); transfer to a web notice is my judgement.*
- NetSession (Akamai; data October 2012; more than 25 M users, 239 countries): "About 31% of the peers have uploading enabled, but the setting is rarely changed - more than 99% of the peers keep their initial setting". The installer comes in "one with uploads initially enabled and one with uploads initially disabled", chosen by the content provider who bundles it.

| Initial setting | Nodes | Never changed | Changed once | Changed 2+ times |
|---|---|---|---|---|
| Uploads disabled | 15,913,255 | 99.96% | 0.03% | 0.01% |
| Uploads enabled | 7,395,867 | 98.11% | 1.80% | 0.09% |

- Share of peers with uploads on, by the content provider whose default shipped (Table 4, customers A-J): under 1, 20, 2, 94, 2, 45, 47, under 1, 91, under 1 (%). Changing the setting at least once: 0.04% of default-off nodes against 1.89% of default-on nodes, a 47:1 asymmetry.
- The authors: "Most users simply stick with whatever the default is" and "users either don't care enough about the uploads to change the setting or are not aware of the choice, despite its mention in the NetSession user agreement." They speculate users keep uploads on because content is centrally vetted and a back-off mechanism "can avoid the second problem by consuming bandwidth only when the connection is idle".
- Brave's built-in `ipfs://` support was removed on 2024-08-22 because "less than 0.1% of users made use of this feature" (from `w1-07`, not re-read here): the same order of magnitude as the default-off NetSession figure.
- Sources: S1 (S34 for Brave via w1-07). Source date: 2013-10 (OLD), data from 2012.

**F5 [DESIGN-CRITICAL] Offload scales with the number of copies and peers online, and the best dataset is for GB-sized downloads.** *Confidence: High for the numbers, Medium for transfer.*
- NetSession abstract: "it can offload 70-80% of the traffic to the peers without a corresponding loss of performance or reliability". Peer-to-peer downloads were enabled for "only 1.7% of the files, but these downloads accounted for 57.4% of the downloaded bytes overall"; "the average peer efficiency for peer-assisted downloads was 71.4%"; "there is always at least one connection to the infrastructure".
- Copies and peers: "with less than 50 registered copies, peer efficiency was below 10%, but rose rapidly after that, and reached 80% for approximately 10,000 copies"; "80% peer efficiency is generally reached with about 25-30 peers", "consistent with earlier results for BitTorrent ... which also requires a few tens of peers to achieve good performance". The authors caution "NetSession's 80% peer efficiency depends on many factors that may be different in other systems".
- Regime differences from magnet-web: objects of several GB, so downloads last minutes and peer setup is amortised; cached copies are kept "for a certain amount of time" (copies are not concurrent peers); a trusted control plane picks peers and handles accounting; an idle-only back-off protects the user's line. magnet-web copies exist only while a tab is open and downloads last seconds.
- Sources: S1. Source date: 2013-10 (OLD).

**F6 Vendor offload claims are unmethodical, absent, or unreachable.** *Confidence: Medium (WebFetch summaries).*
- Hive Streaming's site claims offload of "up to 99%" with no baseline, method or minimum audience (marketing). P2P Media Loader's README gives no offload figure; it states "For smaller setups (1,000-2,000 simultaneous viewers), public trackers alone can handle peer connections" (a tracker-capacity statement, not an offload one). CDNBye's README gives no numbers ("Let your viewers become your unlimitedly scalable CDN"). Neither README says anything about telling viewers or obtaining consent.
- Swarmify's landing page now sells "unlimited bandwidth on every plan" with "a global CDN ... as intelligent overflow", "Plans from $19/mo", and (per the fetch summary) does not mention peer-to-peer.
- Microsoft eCDN documents the metric ("Overall P2P" = bytes via P2P divided by total bytes) but no typical value. Its silent-test guide gives the arithmetic bound for n simultaneous viewers of one live stream: "the maximum peering efficiency/offload rate is 50%, 3 users - 66.7%" because at least one viewer must pull from the HTTPS source (the page lists "4 users - 80%", which does not match (n-1)/n = 75%).
- I could not retrieve Streamroot or Peer5 material (hosts unreachable) and the quota prevented searching. I will not quote offload-vs-audience curves from memory.
- Sources: S10, S11, S12, S13. Source dates: eCDN silent test ms.date 2026-05-04; others undated, fetched 2026-10-17.

**F7 P2P retreated wherever the origin became affordable.** *Confidence: High for PeerTube, Low-Medium for Spotify and Brave (secondary).*
- PeerTube issue 5465 (opened 2022-12-15, closed 2023-07-10): "the P2P aspect of WebTorrent is not really used since most of new and popular videos are using HLS now." Its CHANGELOG adds a P2P switch for anonymous users, an embed `p2p` query parameter, an admin option to disable the tracker "to improve users privacy", and a live-latency trade-off ("small latency without P2P or high latency to increase P2P ratio"). No P2P ratio statistic is published in the sources I read.
- Spotify: Wikipedia (citing TorrentFreak): "In April 2014, Spotify moved away from the peer-to-peer (P2P) system", quoting a Spotify representative: "We're gradually phasing out the use of our desktop P2P technology" and "We're now at a stage where we can power music delivery through our growing number of servers" I could not read Kreitz and Niemela's 2010 paper (KTH URL returned 404), so I make no claim about the share of bytes peers served.
- WebTorrent's own FAQ lists no incentive for peers to seed: "visitors help to host the site's content", "The more people that use a WebTorrent-powered website, the faster and more resilient it becomes", "There are no plans to make a profit from WebTorrent"; non-profits "could reduce bandwidth and hosting costs by letting visitors chip in".
- Sources: S14, S15, S35. Source dates: 2022-12 to 2023-07; Wikipedia and FAQ fetched 2026-10-17.

### 2.2 Ethical defaults in production P2P

**F8 Windows Delivery Optimization is a well-documented template for bounded generosity.** *Confidence: High (primary, ms.date 2026-05-20).*
- Default Download Mode is LAN (1): peers behind the same public IP; Internet peering (mode 3) is opt-in. `DOMonthlyUploadDataCap` default **20 GB** per month to Internet peers (0 = unlimited). `DOMinBatteryPercentageAllowedToUpload`: "By default, devices won't upload while on battery" (recommended value 40). VPN: "peering isn't allowed" by default. Peer caching only for files of 50 MB or more, devices with 4 GB RAM or more and 32 GB disk or more. Cache age three days, 20% of disk. HTTP fallback is not delayed by default (peers and HTTP run in parallel). The old `DOMaxUploadBandwidth` (deprecated) defaulted to unlimited but "dynamically optimizes for minimal usage of upload bandwidth".
- Sources: S9. Source date: 2026-05-20.

**F9 Microsoft eCDN pairs HTTP and P2P, shares only during use, and keeps Internet peering off by default.** *Confidence: High for the quotes seen in page text.*
- "each viewer can download resources from both the P2P network and the HTTP network simultaneously"; manifests and licences always come from the HTTP edge; peers are chosen "based on network proximity, cache allocation, stream relevance". Authorised viewers "only share while they're actually watching the stream". In subnet mapping, WAN (STUN-based peering between Internet users) is "(default) Off"; each group is P2P On, Off or Leech (consume only). The service needs viewers' IP addresses exposed (browsers "conceal their users' IP address"), and peering is confined to one /8.
- Sources: S10. Source dates: technical overview 2022-08-05 (updated 2023-12-21); peering groups 2026-06-24; intro and analytics updated 2026-08-03.

**F10 Psiphon Conduit gives the volunteer two dials and tells the truth about cost.** *Confidence: Medium-High (page text read).*
- FAQ: "Maximum peers" limits simultaneous users; "Maximum MB/s per peer" limits bandwidth per user; "The app shows estimated bandwidth usage"; "Any data transferred through your station counts toward your data plan"; Wi-Fi or fixed line and a plugged-in device are recommended; "A Conduit Station can see the IP addresses of clients that connect through it". "Hosted Conduit" runs in Psiphon's cloud and "does not use your device's battery, data, or connection": a way to donate infrastructure instead of your own line.
- Sources: S17. Source date: fetched 2026-10-17.

### 2.3 Volunteer networks

**F11 [DESIGN-CRITICAL] Even for a strong cause, the embeddable "keep this tab open" widget is a marginal channel.** *Confidence: High for the counts; the interpretation has limits.*
- Snowflake broker `/metrics` (86,400 s windows; 749 daily blocks since 2024-09-19):

| Window ending (broker clock) | Proxy IPs total | Browser extension | Mobile-embedded (`iptproxy`) | Standalone | Web badge | Client matches | Idle polls |
|---|---|---|---|---|---|---|---|
| 2026-10-17 20:18:16 | 139,657 | 80,704 (57.8%) | 25,392 (18.2%) | 5,974 (4.3%) | 306 (0.22%) | 7,690,664 | 34,069,080 |
| 2026-10-16 20:18:16 | 147,630 | 89,189 | 25,115 | 6,047 | 323 | 7,711,272 | 35,306,136 |
| 2026-10-15 20:18:16 | 150,938 | 91,472 | 26,155 | 6,025 | 355 | 7,905,248 | 34,592,080 |

- Over the last 14 windows the badge ranged 294-374 proxy IPs per day against 137,697-152,124 in total. Tor Metrics' user estimate for Snowflake was 62,672 on 2026-10-13 (obfs4 about 102,000).
- The project page describes the badge exactly as our model: "embed this widget on your own website so visitors can spin up their own Snowflakes by opening your website and keeping the tab open". Its `embed.html` template uses message keys `popupConsent`, `popupStatusOff`, `popupEnabled`, `popupRunInBackground` (string text not retrieved).
- Limits: counts are distinct proxy IPs per 24 h, not visitors; how many sites embed the badge is unknown; `iptproxy` is not defined in the sources I read. Idle polls exceed matches 4.4:1, so volunteer supply already exceeds demand: the scarce resource there is demand and matching, not donors.
- Sources: S16. Source date: 2026-10-17.

**F12 Conduit's page reports millions of stations; its counter semantics are unclear.** *Confidence: Medium.*
- Conduit's page shows "TOTAL CONDUIT STATIONS 2,168,237", "PSIPHON NETWORK MONTHLY BYTES 65,684 TB", "MONTHLY USERS 20,886,573", while a step description says "people are running hundreds of thousands of Conduit stations worldwide" (cumulative vs live is not stated). The `Psiphon-Inc/conduit` repository was created 2024-09-13 and last pushed 2026-09-30. The page also advertises "Ryve", described as a wallet tying participation to on-chain ownership (not investigated).
- Sources: S17. Source date: 2026-10-17.

**F13 BOINC: 5-10% of people who learn about it take part; recognition (credit) sustains them; branded corporate pushes did not.** *Confidence: High (primary preprint, Dec 2018).*
- "About 700,000 devices are actively participating in VC projects ... average throughput of 93 PetaFLOPS." "Studies suggest that of people who learn about VC, between 5% and 10% participate, and that desktop and mobile devices are available to compute for VC about 60% and 40% of the time respectively." Credit "provides a measure of progress for individual volunteers; it is the basis of competition between volunteers and teams ... and can serve as proof-of-work for virtual currency systems"; it must "resist credit cheating" (result replication and validation). SETI@home drew "on the order of 1M volunteers" in 1999-2001 and "the user base has shrunk to 200K or so". Intel, HTC and Samsung branded clients: "None of these resulted in a significant long-term increase in volunteers."
- Sources: S18. Source date: 2018-12 (OLD).

### 2.4 Tokens, points and unit economics

**F14 Token-paid resource sharing: prices collapsed and consumer programmes were retired or repositioned.** *Confidence: High for prices (API snapshot), Medium for status notes.*

| Token | Role in this story | Price 2026-10-17 | All-time high (date) | From high | Status note |
|---|---|---|---|---|---|
| BTT | BitTorrent Speed: "downloaders will have the option of providing tokens to uploaders in exchange for faster download speed", so that "uploaders have a reason to seed files longer"; after a download "you can automatically earn BitTorrent (BTT) by seeding" | $3.55e-7 | $3.43e-6 (2022-01-20) | -89.6% | Official page (v1.3.13, 2026) still lists BTFS as "Coming soon"; Tron acquired BitTorrent in 2018 (Wikipedia) |
| THETA | Video-delivery edge nodes | $0.189 | $15.72 (2021-04-16) | -98.8% | Site title now "Decentralized GPU Cloud for AI, Media and Rendering"; EdgeCloud launched 2024-05-01 (CoinGecko text) |
| TFUEL | Edge-node reward / gas | $0.00874 | $0.682 (2021-06-08) | -98.7% | same |
| FIL | Storage and retrieval market | $1.048 | $236.84 (2021-04-01) | -99.56% | Filecoin Station README: "This repository is no longer mantained", announcement tweet id decodes to 2025-06-10; Spark and Checker "continue to operate in a permissioned architecture"; Saturn L1-node repo last pushed 2024-08-14; docs retrieval page names no retrieval market |
| LPT | Video transcoding market | $1.64 | $99.03 (2021-11-09) | -98.3% | Docs: operators "earn ETH fees plus LPT rewards"; inflation is "governance-controlled" |

- Where tokens did attract supply: Theta's own description (CoinGecko text) claims "over 10,000 active global nodes" and Grass claims 8.5M installs (F15), so supply of volunteered capacity is not the hard part when a reward exists. The hard parts are a paying buyer for the specific resource and a reward whose value holds. BitTorrent's page publishes no adoption number for BitTorrent Speed (it says only that BTFS is "supported by millions of BitTorrent user nodes"), so I cannot say whether paying seeders changed seeding behaviour.
- Reading: rewards denominated in volatile tokens stop being a stable incentive; programmes aimed at ordinary users (Station) were wound down; positioning moved from "your bandwidth" to GPU/AI compute.
- Sources: S19, S20, S21, S22. Source dates: price snapshot 2026-10-17 21:40 UTC; READMEs fetched 2026-10-17.

**F15 Points-for-bandwidth schemes scale in installs, but the buyer is not a content site, and undisclosed versions became scandals.** *Confidence: Medium (vendor page; Wikipedia secondary).*
- Grass: "Trusted by over 8.5M users worldwide"; the bandwidth is used by "verified institutions"; users earn Uptime and Network Points that feed "future distributions of Grass Tokens or USDC"; "will ask for your consent" at install; "One tap stops everything"; it "stays under" the measured capacity. Marketing claims, unaudited.
- Hola: from late 2014 it sold users' connections as exit nodes under the name Luminati at $20 per GB (ZDNet, 2015-05-29, via Wikipedia); the founder said it had always been in the agreement; an FAQ notice was added after a public complaint; botnet and DDoS allegations followed (Business Insider 2015-05-28, The Register 2015-06-10, via Wikipedia). EasyPrivacy lists `||luminati.io^` and `||perr.hola.org^`.
- Sources: S22, S23, S24. Source dates: 2015 (OLD) for Hola; Grass fetched 2026-10-17.

**F16 [DESIGN-CRITICAL] Unit economics: the host's saving per MiB is smaller than almost any visitor's cost on mobile data, and for many hosts it is zero.** *Confidence: High for prices; ratios are Model.*
- Host side (price list `publicationDate` 2026-10-03T00:04:26Z): CloudFront US and EU $0.085/GB first 10 TB, $0.080 next 40 TB, $0.060 next 100 TB, $0.040 next 350 TB, $0.030 next 524 TB, $0.025 next 4 PB; Australia $0.114, South America $0.110, India $0.109 for the first 10 TB. That is $0.000024 to $0.00011 per MiB. Cloudflare R2: egress "does not incur data transfer (egress) charges and is free", storage $0.015/GB-month. GitHub Pages: 1 GB site limit, "soft bandwidth limit of 100 GB per month". CloudFront flat-rate plans: Free $0 (1M requests, 100 GB), Pro $15, Business $200, Premium $1,000.
- Visitor side: $0.02 to $43.75 per GB of mobile data (F23), i.e. $0.00002 to $0.043 per MiB, global mean $0.0025 per MiB. At the 2023 global mean a visitor spends 30.5 times what a US/EU host saves per byte; in Zimbabwe 515 times. On unmetered Wi-Fi or fixed lines the visitor's marginal cost is about zero.
- Payment side: a micro-payment per visit is smaller than any card, bank or on-chain fee floor; probabilistic-ticket schemes exist (from memory, e.g. Livepeer; the Livepeer page I read mentions ETH fees but gave no ticket detail, so treat this as unverified), which I judge disproportionate for a static-site loader. Conclusion: money cannot clear this market; only free transfer on unmetered links is positive-sum.
- Sources: S28, S29, S22. Source dates: AWS 2026-10-03; Cloudflare, GitHub, AWS plans fetched 2026-10-17; mobile prices 2023 (OLD).

**F17 "Proof of visit" or "proof of seeding" cannot be built without a trusted counter-party or a Sybil cost, and a visit proves nothing about bandwidth.** *Confidence: Medium (documented limits plus my inference).*
- NetSession: "accounting attacks, in which compromised peers misreport the amount of service they have provided"; it "relies on data from the (trusted) edge servers to detect such attacks and to filter out incorrect reports". BOINC replicates jobs and validates results to stop "credit cheating". RFC 9576 (Privacy Pass, June 2024): unlinkable tokens; clients "assume that Issuers and Origins are malicious"; the "hoarding attack" (section 7.1) is mitigated by rate-limiting issuance. Hashcash already prices chain writes in magnet-web (ARCH), which stops spam but not Sybil identities.
- Inference (not sourced): a signed "visited at T" token is trivially farmed by a headless browser; bilateral signed byte receipts between two peers are collusion-prone; the one fact an owner can verify cheaply is "my own pinner is reachable", by probing it.
- Sources: S1, S18, S27. Source dates: 2013, 2018 (OLD), 2024-06.

### 2.5 Social licence, consent and "thanks" design

**F18 [DESIGN-CRITICAL] The privacy-tool community treats undisclosed P2P bandwidth use as resource abuse, and its default list ships the rules.** *Confidence: High.*
- `uBlock filters - Privacy` (`ublock-privacy`, group `default`, not `off` in uBlock Origin's `assets.json`) contains, in the 2026-10-16 build, a "Merge in resource-abuse.txt" section: `/edgemesh.*.js$script,domain=~edgemesh.com|~edgeno.de`, `||backend.dna-delivery.com^$domain=france.tv|rt.com`, `||cdn.streamroot.io/dna-client/$script,domain=prod-player.tf1.fr`, Douyu and Huya P2P libraries, and `bilibili.com,dandanzan.top,v.qq.com##+js(nowebrtc)` under "Block some Chinese web pages from using P2P". The source file's header: "To foil sites potentially abusing CPU/bandwidth resources without informed consent. Any such resource-abuse scripts MUST be opt-in, with complete informed consent from the visitor."
- Reports behind the rules: issue 659 (2017-08-30), "Edgemesh P2P CDN crapware ... unwittingly turns site visitors into miniature CDN edge nodes and wastes users' bandwidth and disk space"; issue 6433 (2019-10-13), france.tv: "The pages consume a lot of upload while the video is playing ... I didn't opt-in to anything ... a blatant case of resource abuse, just like a crypto miner would use your CPU without asking. I couldn't find an opt-out setting"; issue 10602 (2021-11-25), douyu.com.
- Implication: the bar a P2P loader is judged by is "opt-in, informed, with an obvious off switch", and the filter is URL- and domain-based, so first-party paths and honest naming matter (R8).
- Sources: S24. Source dates: list build 2026-10-16; issues 2017-2021.

**F19 Mainstream blocklists flag commercial P2P-CDN infrastructure, not magnet-web's current defaults.** *Confidence: High (grep of fetched lists on 2026-10-17); will drift.*
- `tracker.cdnbye.com` appears in EasyPrivacy, StevenBlack hosts, AdGuard DNS filter, HaGeZi Pro and OISD small. I found **no** entry for `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.novage.com.ua`, `open.ftorrent.com`, `stun.cloudflare.com` or `global.stun.twilio.com` in EasyPrivacy, EasyList, uBlock filters (Ads, Badware, Privacy, Unbreak, Quick fixes, Annoyances), StevenBlack hosts, AdGuard DNS, AdGuard Base, HaGeZi Pro and TIF, or OISD small. (`tracker.cdnbye.com` is absent from EasyList, AdGuard Base, HaGeZi TIF and the uBlock lists.)
- Sources: S24. Source date: 2026-10-17.

**F20 An explicit consent click is a minority action, and small design choices move it by tens of points.** *Confidence: High for Utz (n above 80,000, one German site), Medium for Nouwens (n = 40).*
- Utz et al.: bottom-left notices drew interaction from 37.1% of visitors; overall 15.8% without an ad blocker and 12.6% with; only 5.5% of visitors on 1,920x1080-or-larger screens against 25.6% on smaller screens; in Experiment 2 interaction ranged 13.8% to 55.3%, highest (55%) for binary notices on mobile with larger type; median time to interact 4-8 s. When "Accept" was highlighted 50.8% (mobile) and 26.9% (desktop) accepted against 39.2% and 21.1% when it was a text link. "In a privacy-by-default (opt-in) setting, less than 0.1% of visitors allow cookies to be set for all purposes."
- Nouwens et al.: of 680 CMPs on UK top-10k sites "only 11.8% meet the minimal requirements"; in a 40-participant experiment "removing the opt-out button from the first page increases consent by 22-23 percentage points" and more granular first-page controls cut consent by 8-20 points.
- Gap: I found no study that measures acceptance of a **website notice about sharing the visitor's bandwidth**. The nearest proxies are NetSession's installer defaults (F4), cookie-notice experiments (above) and Snowflake's badge adoption (F11); all differ from magnet-web's notice, so treat the 5-30% planning range as an assumption to be replaced by R7.
- Sources: S25. Source dates: 2019-10, 2020-01 (OLD).

**F21 Regulators and practitioners give usable definitions for a "thanks" message that stays honest.** *Confidence: High for the quotes; applicability to a non-social-media site is by analogy.*
- EDPB Guidelines 03/2022 v2.0 (adopted 2023-02-14): six categories, Overloading, Skipping, Stirring ("appealing to their emotions or using visual nudges"), Obstructing, Fickle, Left in the dark; "While consent must be expressed by a positive action on the part of the users, lack of consent should be considered the default state, until consent has been given."
- FTC, "Bringing Dark Patterns to Light" (2022-09-14): "Digital Dark Patterns are design practices that trick or manipulate users into making choices that they might not otherwise have made"; "companies should avoid default settings that lead to the collection, use, or disclosure of consumers' information in a way that they did not expect".
- deceptive.design taxonomy (names used in section 4): nagging, confirmshaming, forced action, fake social proof, fake scarcity, fake urgency, preselection, trick wording, hidden costs, addictive design.
- Sources: S26. Source dates: 2023-02, 2022-09, undated (fetched 2026-10-17).

**F22 PeerTube is the nearest browser-P2P precedent for in-product transparency.** *Confidence: High (raw strings).*
- Player strings (en-US): "Watching this video may reveal your IP address to others."; a stats overlay reads "{1} from servers · {2} from peers" and "From peers: ". The privacy guide (via `w2b-06` F14) records notice plus switch-off per user and per admin.
- Sources: S14. Source date: fetched 2026-10-17.

### 2.6 Visitor cost and platform signals

**F23 Mobile data is cheap in some markets and ruinous in others; the latest edition I could reach is 2023 (OLD).** *Confidence: High for the numbers, OLD.*
- Cable.co.uk (page now at `bestbroadbanddeals.co.uk`, 301): 237 countries, "over 5,600 mobile data plans"; worldwide average USD 2.59 per GB in the regional section and 2.61 in the 2023 row of the history table (the page does not reconcile them); cheapest Israel 0.02, then Italy 0.09, Fiji 0.09, San Marino 0.10, Cambodia 0.12; dearest Zimbabwe 43.75, Falkland Islands 40.58, Saint Helena 40.13, South Sudan 23.70, Tokelau 17.24. Regional averages: Northern Africa 0.86, Asia (excl. Near East) 1.10, Eastern Europe 1.27, Central America 1.50, CIS 1.80, Baltics 1.87, Western Europe 2.08, Caribbean 2.15, Near East 2.42, Sub-Saharan Africa 3.31, Oceania 3.72, South America 3.74, Northern America 4.59. The collection date is not stated on the page.
- ITU (fetched 2026-10-17): its price baskets include a 5 GB data-only mobile broadband basket and a 2025 data collection (about 200 economies); "2.2 billion people remain offline - most of them in low and middle income countries"; I could not extract the affordability percentages (summary pages only).
- Whether uploads count toward a plan's allowance varies by operator; Conduit's FAQ states transfers "count toward your data plan" (that is a relay, so both directions). Treat "uploads are billed" as likely, not universal.
- Sources: S28, S17, S36. Source dates: 2023 (OLD); ITU 2025 pages.

**F24 [DESIGN-CRITICAL] Most visitors cannot be classified as "on Wi-Fi", and most visits are on phones, so the eligible seeder pool is a small share of traffic by construction.** *Confidence: High.*
- MDN browser-compat-data (fetched 2026-10-17): `NetworkInformation` Chrome 61, Chrome Android 38, Firefox 31 (removed in 32 on desktop, removed in 99 on Android), Safari false (iOS follows). `type`: Chrome 61 **partial, ChromeOS only**, Chrome Android 38. `effectiveType`, `downlink`, `rtt`: Chromium only; `downlink` capped at 10 Mbps and `rtt` at 3,000 ms for anti-fingerprinting. `saveData`: Chrome 65, none elsewhere. CSS `prefers-reduced-data`: experimental, Chrome 85 behind a flag, Firefox and Safari false.
- Device mix, Wikimedia human page views 2026-09-01 to 2026-10-15 (45 days): en.wikipedia desktop 36.1%, mobile web 61.3%, mobile app 2.6%; de.wikipedia 37.5 / 57.6 / 5.0; fa.wikipedia 11.7 / 87.7 / 0.7.
- Consistency check: the current `policy.js` `networkTypeOf` already maps anything but `wifi`/`ethernet`/`cellular` to `'unknown'`, and `policyColumn` treats unknown on a phone as cellular until `shareOnNetwork`. Correct, and it means iOS and Firefox-on-Android phones never upload by default.
- Sources: S30, S31, S34. Source dates: 2026-10-15 data.

### 2.7 Concurrency, dwell time and the model

**F25 Little's law and the M/G/infinity result are the right tools, and the simulation confirms them for heavy-tailed dwell.** *Confidence: High.*
- Little (2011): L = lambda W "holds under nonstationary conditions" and is "independent of queue discipline"; Wikipedia: "not influenced by the arrival process distribution". For Poisson arrivals and independent dwell times the number online is Poisson with mean lambda E[S] for any dwell distribution, and an arriving visitor sees the same distribution (PASTA), so P(alone) = exp(-lambda E[S]). For a time-varying rate the count stays Poisson with mean E[lambda(t - S_e)] E[S] (Eick, Massey and Whitt 1993; I could not fetch that paper, so this clause is from memory and unverified); for dwell of minutes against a daily cycle this is the instantaneous rate times E[S].
- My simulation (`labs/w2c-07-lab/little-calc.mjs --montecarlo`, 20-80 simulated days, Weibull dwell, seed-fixed): mean concurrency 2.096 vs theory 2.083 (3,000 visits/day, mean 60 s); 20.73 vs 20.83 (30,000/day); variance/mean 0.9975, 1.002, 0.9982; P(N = 0) 0.1234 vs 0.1245. A diurnal run (peak factor 1.9) reproduced the daily mean (20.87 vs 20.83) and a peak-hour mean of 1.914x the day mean.
- Sources: S33. Source dates: 2011 (OLD); simulation 2026-10-17.

**F26 Dwell is short and heavy-tailed; use the mean, measure it, and expect it to be well above the median.** *Confidence: Medium (OLD, one site, vendor landing page).*
- Chartbeat via TIME (2014-03-09, 2 billion visits in a month): "a stunning 55% spent fewer than 15 seconds actively on a page"; "if you can hold a visitor's attention for just three minutes they are twice as likely to return than if you only hold them for one minute".
- Google Analytics on the Utz partner site (2019): "84.81 % of visitors spend less than 10 seconds on the site, 5.21 % 11 to 60 seconds, and 5.83 % up to 3 minutes". Assuming values spread evenly within each bin, the mean is 28 s if the over-3-minute tail (4.15% of visits) averages 360 s and 55 s if it averages 1,000 s, and visits under 10 s are 85% of visits but only 8-15% of dwell time (my computation). A single Weibull fits these bimodal bins badly (best fit shape 0.16), so the model's shape-0.6 Weibull is a convenience, not a fit.
- Liu, White and Dumais (SIGIR 2010): dwell time is modelled with a Weibull distribution and shows "negative aging", i.e. "some initial screening has to be passed before a page is examined in detail" (no numbers on the abstract page).
- Contentsquare's 2026 benchmark landing page: "Engagement dropped -10% year on year" (Q4 2024 vs Q4 2025; 6,500+ sites, 99 billion sessions); no absolute dwell figure on the page.
- Sources: S32. Source dates: 2014, 2019, 2010 (OLD); 2026 landing page.

**F27 Time of day and bursts change the picture by a factor of two to four.** *Confidence: High for Wikimedia, Medium for transfer.*
- Wikimedia hourly human page views, 2026-09-10 to 2026-10-16 UTC (883 hourly points, 36 full days): 

| Project | Median peak-hour share of a day | Average-profile peak / mean | Average-profile trough / mean | Whole-period max hour / mean |
|---|---|---|---|---|
| en.wikipedia | 5.20% | 1.25 (19h UTC) | 0.74 (08h) | 1.41 |
| de.wikipedia | 8.01% | 1.94 (19h) | 0.21 (02h) | 2.26 |
| fa.wikipedia | 6.90% | 1.63 (18h) | 0.31 (01h) | 1.91 |
| ja.wikipedia | 6.81% | 1.65 (12h) | 0.32 (19h) | 2.95 |

- A country-concentrated site is therefore nearly empty at night (a quarter of the mean) and about twice the mean at the peak hour; a news spike can reach 2-3x the period mean for an hour.
- Sources: S31 plus my computation (`labs/w2c-07-lab/diurnal.py`, commands in `RUN.txt`). Source date: 2026-10-16.

**F28 [Model] Concurrency and offload thresholds.** *Confidence: Model (assumptions below).*
- Assumptions: Weibull dwell, shape 0.6; 3 s before a visitor can seed; eligibility p = consent x policy x connect with pessimistic 0.05 x 0.12 x 0.70, baseline 0.30 x 0.35 x 0.80, optimistic 0.90 x 0.60 x 0.85 (reasons in Appendix B); web seed 8 MiB/s in parallel, peers 1 MiB/s each (the desktop cap), first peer wire after 2 s.
- Results (Appendix B has the full tables): at 60 s mean dwell the baseline scenario gives a mean of 0.06, 0.56 and 5.6 eligible seeders online at 1,000, 10,000 and 100,000 visits/day. Visits/day needed for 25 eligible seeders online: 8,964,665 (pessimistic), 448,233 (baseline), 82,030 (optimistic). Expected share of bytes from peers (web seed 8 MiB/s): 0% for 2 and 5 MiB sites at any seeder count; 20 MiB: 2.0% at 1 seeder online, 11% at 10; 50 MiB: 6.9%, 37%; 128 MiB: 8.8%, 47%. With a slow host path (2 MiB/s) the same cells are 5.3%, 16% (5 MiB), 21%, 66% (20 MiB), 24%, 75% (50 MiB).
- Worked examples (calculator): hobby blog 400 visits/day, 45 s: E[N] 0.21, alone 81%, expected offload 0%. Docs site 8,000/day, 90 s, 20 MiB: E[N] 8.3, 0.68 eligible seeders, P(no seeder) 51%, offload 1.4% (2.5% at peak hour). Desktop-heavy tool, 100,000/day, 120 s, optimistic eligibility, 50 MiB: 62 eligible seeders, offload 60%. Media site 5,000/day, 20 min dwell, 500 MiB: E[N] 69, 13.9 eligible seeders, offload 60%.

**F29 [Model] Seeding time is concentrated in a few tabs.** *Confidence: Model.*
- In the simulation the longest 10% of visits hold 51% (shape 0.6) to 60% (shape 0.5) of total dwell time, the longest 1% hold 12-16%. A few long-lived tabs would carry most of the upload unless each has a byte budget, which supports a per-tab budget and a daily per-origin budget (R3).
- Sources: `results/montecarlo.txt`. Source date: 2026-10-17.

### 2.8 Platform risk to peer connections

**F30 Chrome's Local Network Access gate reaches WebRTC; same-LAN peer connections may trigger a browser permission prompt.** *Confidence: Medium (two primary pages that agree on the prompt but not on the WebRTC version).*
- Chrome's LNA post (updated 2025-09-29): the prompt text (from the alt text of the page's screenshot) is "Look for and connect to any device on your local network." and it was launching in Chrome 142 for `fetch()`, subresources and subframes; WebSocket, WebTransport and WebRTC were "planned" with no version given. Microsoft's eCDN page (ms.date 2025-10-29, updated 2026-01-29): "Chrome enforces Local Network Access restrictions as of Chrome 142, Microsoft eCDN's peer-to-peer technology isn't impacted until Chrome 146, when enforcement extends to WebRTC connections"; without an enterprise policy, browser clients "may be prevented from establishing peer-to-peer connections within your organizational network"; Firefox has a similar restriction in Nightly only.
- Peers on the public Internet use public candidates and fall outside the definition of a local-network request (the Chrome post's definitions imply this but do not say so). The open risk is two visitors behind the same router: their host candidates are local. I did not test this.
- Sources: S10, S37. Source dates: 2025-10-29 (updated 2026-01-29), 2025-09-29.

---

## 3. Honest economics (draft text for README.md and DEPLOY.md)

Plain statements the docs can make today. Numbers marked (model) come from `labs/w2c-07-lab/little-calc.mjs` with the stated assumptions; they are planning figures, not measurements, and should be replaced by field data (R7).

### 3.1 README: "What the peer-to-peer part does and does not do"

> **Your site still needs a home.** A magnet link is not a server. Something must always have your files: the web seed on your static host (S3, GitHub Pages, Cloudflare R2 or any host that serves byte ranges) or a pinner you run. Visitors help only while their tab is open.
>
> **What visitors add.** Visitors who are on the page at the same time can pass pieces of your site to each other, and the shared database (the ledger) replicates between people who are online together. A returning visitor keeps a verified copy, so your site opens instantly and works offline for them even when your host is down. None of this replaces the host.
>
> **How many visitors are online at once?** Visitors online = visits per day x average seconds on the site / 86,400 (Little's law). 1,000 visits a day at a 60 second average is 0.7 visitors online: half of all arrivals find the site empty. 10,000 a day is 7. Use the average time on site, not the median. Most visits end in seconds and a few last minutes, and the average is what decides how many people overlap.
>
> **Not every visitor can help.** A visitor shares only if they said yes, are on a desktop browser (or on a phone and confirmed the network is fine), and their network allows a direct connection. Our planning figure is about 1 visit in 12 (model; 1 in 240 for a mobile-heavy site where almost nobody clicks, 1 in 2 for a desktop audience that is shared by default).
>
> **What that means for your bill.** On first load a web seed finishes small sites before a peer connection is ready, so a site under about 16 MiB gets about 0% of its bytes from peers (model). A 50 MiB site moves an expected 17% from peers when 3 eligible visitors are online on average, 37% at 10 (model). At US/EU CloudFront list prices ($0.085 per GB for the first 10 TB; price list of 2026-10-03) a site with 10,000 visits a day and 50 MiB per visit saves about $50 a month (model), and many hosts charge nothing for bandwidth. Choose magnet-web for resilience and independence, not to cut your hosting bill.
>
> **What visitors get.** A verified copy of the site on their device. There are no tokens, points or rankings, and nobody is paid to share.
>
> **What it costs visitors.** On Wi-Fi or ethernet, bandwidth they were not using. On mobile data, money: about USD 2.59 per GB worldwide on 2023 prices, from 0.02 in Israel to 43.75 in Zimbabwe. So phones upload only after the visitor confirms the network, every visit and every day has an upload budget, and nothing runs in a hidden phone tab.
>
> **Visitors are asked first.** Before anything is shared they see what is shared and who can see their IP address; they can say no and still use the site; they can see how much was sent. Some content blockers treat undisclosed peer-to-peer sharing as resource abuse, and the rule they apply is "opt-in, with complete informed consent".

### 3.2 DEPLOY: "Will my site have peers?"

1. From your analytics take visits on a busy day and the **mean** engaged seconds per visit.
2. Run `node tools/swarm-calc.mjs --visits 8000 --dwell 90 --size 20` (R6). It prints visitors online (Little), the chance of being alone, eligible seeders online, and expected offload.
3. Read the result against this table (model, web seed 8 MiB/s, peers 1 MiB/s each, first peer after 2 s):

| Eligible seeders online (mean) | Expected share of bytes from peers, 20 MiB site | 50 MiB site | 128 MiB site | Treat P2P as |
|---|---|---|---|---|
| under 1 | 0 to 2% | 0 to 7% | 0 to 9% | resilience only; the web seed does the work |
| 1 to 3 | 2 to 5% | 7 to 17% | 9 to 22% | a small bonus |
| 10 | 11% | 37% | 47% | a real saving for large sites |
| 30 | 16% | 53% | 69% | |
| 100 | 19% | 63% | 81% | |

4. Eligible seeders online = visits/day x eligible share x average seconds as a seeder / 86,400. With the planning share (0.084) and 60 s mean dwell you need about 448,000 visits a day for 25 (model); with a desktop audience that shares by default (0.46) about 82,000.
5. If availability matters more than speed, run a pinner (R9). Visitors are not an availability plan.

### 3.3 Words for the status bar (existing idea, refined)

- Alone: "You are the only visitor online. Loading from the host."
- Sharing: "Sharing with 2 visitors. 14 MB sent this visit. [Pause] [Settings]"
- Phone, unconfirmed: "Not sharing on mobile data. [Share on this network]"

---

## 4. Default incentive design

**Position: there is no incentive layer.** What exists is reciprocity that WebTorrent already provides, a self-interest by-product, transparency, bounded generosity and an availability plan that does not depend on visitors.

### 4.1 Principles

1. **Optional:** the site loads fully with sharing off; declining carries no penalty and no nag (EDPB: lack of consent is the default state).
2. **Informed before it happens:** the notice says what is shared, with whom, who sees the IP address, and where the off switch is, before the first announce (existing rule, DESIGN-REVIEW 4.5).
3. **Bounded:** rate, bytes per visit, bytes per day, hidden-tab time, mobile, battery and VPN limits, all visible in Settings.
4. **Reversible:** one tap pauses; "Forget this site" clears the cache; decisions are stored per origin and can be revisited.
5. **Honest about cost and benefit:** no claims of "helping the planet"; say what is true: faster for others when they overlap, resilient if the host fails.
6. **Not farmable:** nothing of value is attached to counters, so nobody has a reason to fake them (F17).

### 4.2 What the visitor gets (self-interest hooks that are real)

- A verified, persistent copy: instant revisits and offline use. This is the honest answer to "why would I?" and it is why seeding can be a by-product of caching.
- Faster loads when other visitors overlap (already true of any swarm).
- Nothing else. Specifically: no credits, no points, no badges, no ranking, no referral rewards, no "supporter" wall.

### 4.3 Defaults (rate values exist in `config.policy`; budgets are proposals to tune with field data)

| Setting | Desktop | Phone, Wi-Fi confirmed | Cellular, unknown or Save-Data | Evidence |
|---|---|---|---|---|
| Sharing after the notice | on (explicit choice recorded) | on (explicit choice recorded) | off until "Share on this network" | F4, F16, F24 |
| Upload rate | 1 MiB/s | 256 KiB/s | 0 | existing table; Conduit per-peer MB/s dial (F10) |
| **Upload budget per visit (new)** | min(256 MiB, 4 x site size) | min(32 MiB, 1 x site size) | 0 | F3 (reciprocity does not bound load), F29 (heavy tail), F8 |
| **Upload budget per day per origin (new)** | 512 MiB | 64 MiB | 0 | Windows DO 20 GB/month device-wide default (F8); per-origin because browsers partition storage |
| Hidden tab | keep sharing for at most 60 minutes, then pause (new); destroy after 10 min on battery (existing) | destroy client | nothing runs | F8 battery rule, F10 plugged-in advice |
| Battery | pause uploads while discharging and below 40% charge (new; 40 is Delivery Optimization's recommended value) | n/a (client destroyed when hidden) | n/a | F8 |
| VPN / metered hint | respect `Save-Data` (existing); browsers expose no VPN or metered signal beyond that | same | same | F24 |
| Connections | 30 | 10 | 6 | existing |
| Counters shown | sent this visit, sent today, current limit | same | same | F22, F10 |

### 4.4 Fairness rules

- **No discrimination between sharers and non-sharers.** Free riding is invisible and costless in a seeded swarm (F3), and punishing non-sharers is a dark pattern. Declined visitors get the same service.
- **Rotate who is served.** WebTorrent's optimistic unchoke already rotates every 30 s; do not add weighting that favours a few peers.
- **Cap the burden, not the benefit.** Budgets cap what a tab gives. They never reduce what the visitor receives.
- **Long-lived tabs carry the load (F29),** so the per-day budget matters more than the per-visit one.

### 4.5 "Thanks for keeping this site alive" without dark patterns

**When it appears.** All of: the tab is visible; sharing is on by the visitor's own choice; this visit has sent at least 8 MiB to at least 2 distinct peers; at least 60 s since load; no keyboard or pointer input for 5 s; fewer than 1 thanks per origin in the last 30 days (local timestamp); never on cellular or unknown networks; never after a decline or pause; never in a hidden tab.

**What it says (plain, factual, no em dashes).**

> Thanks for helping. This tab has passed on 18 MB of this site to 3 other visitors since you opened it. Sharing stops when you close the tab.
> [Keep sharing] [Stop sharing] [Settings]

**How it behaves.** A status region (`role="status"`), no focus steal, no sound, no animation under `prefers-reduced-motion`, stays for 15 s or until dismissed, pauses on hover or focus. Numbers come from `torrent.uploaded` and the count of distinct wires that received a piece, rounded down; they stay on the device.

**Never.** Confirmshaming ("No, let the site die"); nagging (more than one per 30 days, or reappearing after dismissal); loss framing or fake urgency ("this site needs you now"); fake social proof ("12,000 people are sharing" without a real, labelled count); streaks, badges, "top contributor", leaderboards, comparisons with other visitors; rewards that look like money; preselected "Keep sharing" that hides "Stop sharing" (both buttons equal weight); copy that calls non-sharers leeches. These map to the deceptive.design types in F21 and to EDPB's "Stirring" and "Obstructing".

**Watch it.** Track locally (and, with owner opt-in, in aggregate per R7) the share of visitors who press "Stop sharing" within a minute of the thanks. If it is above the baseline opt-out rate, the message is annoying: turn it off by default.

### 4.6 Settings text (proposal)

> **Share this site with other visitors.** While this tab is open, your browser sends this site's files to other visitors. Other visitors and the connection servers can see your IP address while you load from peers or share. It uses your upload bandwidth, only on Wi-Fi or ethernet unless you say otherwise. It stops after 256 MiB this visit and 512 MiB today.
> Sent this visit: 18 MiB. Today: 40 MiB. [Pause] [Turn off]
> **Host only.** No peer connections at all. Slower, and shared data will not sync.

### 4.7 Not built, on purpose

Tokens, credits, points, rankings, referral rewards, a supporters wall, auto-start on mobile, background sync uploads, cross-site persistent seeding, any server that counts contributions. If a recognition feature is ever wanted, it must be local-only, non-transferable and derived from local counters (R2).

---

## 5. Concrete recommendations for magnet-web

Priority: P0 = before any public claim or release; P1 = this milestone; P2 = next; P3 = optional. Effort: S = under a day, M = a few days, L = a week or more. File names refer to the tree as of 2026-10-17 (`src/loader/policy.js` was rewritten during this run; `computePolicy` now returns `column`, `uploadLimit`, `uploadsEnabled`, `hiddenBehaviour`, and has no byte budget).

| ID | Pri | Eff | What to build or change | Evidence | Acceptance |
|---|---|---|---|---|---|
| R1 | P0 | S | Publish the honest economics (section 3) in README, DEPLOY and CRITIQUE; reword the "visits x dwell" table in `review/distributed-systems.md` and ARCH when next edited to say **mean** dwell and **eligible** seeders | F5, F16, F26, F28 | README states: the web seed or a pinner is the product; peers help only when visitors overlap; small sites get about 0% offload; mobile uploads are off; no tokens |
| R2 | P0 | S | Record "no incentive layer in v1" as a compatibility promise in ARCH section 8: no tokens, points, rankings or referral rewards; any recognition is local-only, non-transferable, derived from local counters; `mw.net` exposes read-only counters, no `credit` API | F14-F17, F21 | ARCH has the clause; INTERFACES has no reward or credit symbol |
| R3 | P0 | M | **Upload byte budgets.** `config.js`: `policy.uploadBudget` per column (visit and day, values in 4.3). `policy.js`: `computePolicy` returns `uploadBudgetVisitBytes`, `uploadBudgetDayBytes`. `torrent.js`: in the existing `torrent.on('upload', ...)` handler add the chunk length to a per-visit counter (WebTorrent 3.0.21 emits `upload` with the byte count on the torrent and on the client; `torrent.uploaded` is the per-torrent running total the stats code already reads); at the budget call `TorrentManager.setUploadsEnabled(false)` (which runs `_lockAll()`, the choke lock) and emit `budget`. `ui.js` Settings: sent this visit / today / limit. Persist the day counter (try/catch around storage; per local midnight) | F3, F8, F10, F29 | Unit test: lock engages at the budget and not before; day counter survives reload and resets after midnight; ledger gossip (extension messages) still flows while locked |
| R4 | P0 | S | **Symmetric, honest notice.** The notice currently offers `[Settings] [OK]` with OK styled `mw-primary`; declining means ignoring it or finding Settings. Add a `Host only` button of identical size and weight next to `OK` (new string `noticeHostOnly`, handler `setConsent(A, 'host-only')`), stop styling OK as primary, and keep `pending` = no peer traffic (already implemented: "Waiting for your OK before connecting to other visitors."). Expect 5-30% explicit OKs, so plan for it | F4, F18, F20, F21 | DOM test: OK and Host only have identical classes; consent stays `pending` until a click; `pending` never opens tracker sockets or WebRTC |
| R4b | P1 | S | **Show the notice after 10 s of visible dwell** (still before the first announce): in `app.js` the `showNotice(A)` call that runs right after the cache lookup moves behind a visibility-aware 10 s timer | F20 (84.81% of visits end under 10 s; median interaction time 4-8 s), F26 | Notice absent for visits under 10 s; with the Utz bins this skips 85% of prompts and forgoes at most 8-15% of seeding time (my computation); record accept rate among those shown |
| R5 | P1 | S | **Sharing meter and thanks message** per 4.5: pure `shouldThank(state, now)` in `policy.js` (unit-testable), render in `ui.js`, visitor-facing strings in `strings.js` (and in the verbatim list in DESIGN-REVIEW 4.5), last-shown timestamp in the per-origin prefs; counts from `torrent.uploaded` and distinct wires served | F10, F11, F13, F21, F22 | Tests: no thanks before 8 MiB to 2 peers, in hidden tabs, within 60 s of load, within 5 s of input, after decline or pause, twice within 30 days, on cellular |
| R6 | P1 | S | Promote the calculator to `tools/swarm-calc.mjs`; add the DEPLOY section 3.2; optional `check-site.mjs --expect-swarm` that takes visits and dwell and prints the same readout | F25-F28 | DEPLOY has the formula, the table and three worked examples; the tool reproduces `results/tables.txt` |
| R7 | P1 | M | **Measure instead of model.** (a) `mw.net.stats()` and Settings show bytes by source (cache, web seed, peers) and uploaded; (b) owner opt-in aggregate report using the randomized-response scheme in `w2b-04` (about 1,400 reports for plus or minus 5 points at epsilon = ln 3) for consent click-through, eligible share and offload; (c) the real-device gate in DEMO-RESULTS records measured consent click-through, policy share, connect success and offload on the example site | F4, F20, F28; `w2b-04` | DEMO-RESULTS has measured p_consent, p_policy, p_connect and offload; README numbers cite them |
| R8 | P1 | S | **Filter-list hygiene.** Keep every P2P asset first-party under `/_mw/` with neutral names (prefer plain names over vendor-like ones such as `p2p-*.js`, `dna-client`, `edgemesh.*.js`); CI job that downloads EasyPrivacy, EasyList, uBlock filters (all default sub-lists), AdGuard Base and DNS, HaGeZi Pro, OISD small, StevenBlack and fails on a match for the project's hostnames or `/_mw/` paths; a plain-language page "How magnet-web uses your connection" linked from the notice and Settings | F18, F19 | CI job exists and is green on the 2026-10-17 baseline (zero matches); page exists and is linked |
| R9 | P1 | M | **Availability kit instead of a volunteer scheme.** Finish `pin.mjs`, a one-command deploy recipe, a hosted-pinner option, and an owner-signed pinner heartbeat on the ledger so the status bar can say "a pinner was seen 4 min ago". Cross-reference `w1-07` R1 | F11, F12 (always-on stations; supply exceeds demand), `w1-07` R1 | A pinned site stays loadable 24 h with no visitors; the status bar shows the heartbeat age |
| R10 | P2 | S | Document and test the detection limits: iOS and Firefox cannot be classified as Wi-Fi, so phones upload only after "Share on this network"; add test-matrix rows for Chrome Android (`type` available), Firefox Android, iOS Safari | F24 | COMPAT lists the behaviour per engine; tests cover `networkTypeOf` for each |
| R11 | P2 | S | Desktop hidden-tab bound: after 60 minutes hidden, pause uploads (setting `hiddenSeedMaxMs`, default 3,600,000); battery rule: uploads pause when discharging below 40% | F8, F10 | `computePolicy` returns `hiddenSeedMaxMs`; lifecycle test with a fake clock |
| R12 | P2 | S | Add a real-device check for Chrome 146 and later: two visitors behind one router, expecting either no prompt or the LNA prompt; record what the visitor sees and whether peering still works | F30 | DEMO-RESULTS row with the observed prompt text and outcome |
| R13 | P2 | M | Optional **peer-first mode** for large sites (50 MiB and up): delay the web seed by `D` (default 0, trial 1.5 s) when the tracker returns many peers, modelled on Delivery Optimization's `DODelayForegroundDownloadFromHttp`; measure first paint | F8, F28 (the peer share is very sensitive to host-path speed: 17% at 8 MiB/s against 50% at 2 MiB/s for a 50 MiB site with 3 eligible seeders online) | A/B in the demo: p50 first-paint regression under 500 ms before it can be a default |
| R14 | P3 | S | Owner-configured "support this site" link (or a Web Monetization pointer), clearly separate from sharing; no coupling to counters | F16, F10 (Hosted Conduit: donate infrastructure, not your line) | Link renders only if the pointer record carries it; never inside the sharing UI |
| R15 | P3 | L | Research spike, only if field data shows swarms with 10 or more eligible seeders regularly: local-only bilateral receipts to order unchokes | F3 (reciprocity bites only above about 10 interested peers), F17 (collusion) | Written go or no-go with field numbers |

### 5.1 Notes on the P0 and P1 items

**R3 details.** The budget protects the visitor, not the site: Windows Delivery Optimization defaults to a 20 GB monthly cap, no uploads on battery and no peering on VPN (F8), Conduit gives the volunteer a maximum-peers and a per-peer MB/s dial (F10), and the model shows a few long-lived tabs carry most of the upload (F29). Defaults in 4.3 are proposals chosen to be conservative: with a 5 MiB site the per-visit cap on desktop is 20 MiB (four newcomers), with a 128 MiB site 256 MiB (two newcomers). Per-day is per origin because browsers partition storage; only hub shared-origin mode could enforce a cross-site total. Web-seed responses served by the Service Worker are not peer uploads and do not count.

**R4 details.** The current notice text is "This site is delivered peer-to-peer. While it's open, your browser connects to other visitors and to connection servers, and they can see your IP address and that you're viewing this site. On Wi-Fi your browser also shares this site's files and posts with other visitors." with `[Settings]` and a primary-styled `[OK]`; the gate (hubs and `consent=gate`) already offers `Load`, `Load from host only` and `Cancel` with equal buttons. The spec and the code now agree that nothing connects to peers until OK (`pending`), which is the right default: an explicit OK is consent and silence is "not consented", the default state in EDPB's wording. What is missing is a visible, equal-weight way to say no on the notice itself, and the primary styling on OK is the highlighted-accept nudge that moved acceptance by 6-12 points in Utz et al. The legal-basis analysis stays in `w2b-06`; this item is about making participation figures honest. The trade is real: Nouwens et al. saw consent rise 22-23 points when the refusal was hidden (F20), so an honest prompt will show lower numbers than a nudged one.

**R4b details.** In the Utz site's analytics 84.81% of visits ended in under 10 s and the median time to interact with a notice was 4-8 s. Prompting at load interrupts the 85% of visitors who leave before they could share anyway. Prompting after 10 s of visible dwell reaches the 15% who stay, who supply most of the seeding time, and skips everyone else. It is not a dark pattern (it happens before any announce and nothing is hidden) and removes most of the annoyance. Hypothesis, to be tested in R7.

**R5 details.** The meter and message use only local counters; do not add a network call. Keep the copy in 4.5 verbatim unless a content designer improves it; avoid em dashes and AI-sounding phrases in all visitor-facing strings.

**R7 details.** The model has three soft inputs that dominate the result: the explicit-click rate, the desktop-or-confirmed share, and mean dwell. All three can be measured on the example site in a day of device testing plus a week of opt-in aggregate reports.

**R8 details.** uBlock Origin ships P2P-CDN rules by URL and domain, and the stated rule is "MUST be opt-in, with complete informed consent". Being first-party and opt-in is the defence, but a neutral file name costs nothing. Keep the CI check informational at first (the lists change daily).

**R9 details.** Snowflake's idle polls exceed its client matches 4.4:1 (F11): when a cause is clear, volunteers are not the bottleneck. A general website has no such cause, so the owner runs the always-on node, and the product should make that cheap and visible. This is the same conclusion as `w1-07` R1.

---

## 6. Gotchas

1. **Coverage gap from the quota.** No searches were possible, so Streamroot, Peer5, Swarmify and PeerTube offload-by-audience data are missing, not negative. Do not read the absence of numbers as evidence that offload is low or high.
2. **NetSession is the best dataset and the wrong regime.** GB-sized files, 25 M clients, a trusted control plane, idle-only back-off, cached copies kept for hours. Use it for the shape (a threshold of tens of peers, defaults dominate), not for the percentages.
3. **Mean dwell, not median.** Little's law needs the mean. The median can be a third of it (model) and 85% of visits can end in under 10 s while the mean is 28-55 s (one site). Ask owners for mean engaged seconds per visit, and warn that bots and forgotten background tabs inflate session duration, so engaged time is the safer input.
4. **Peers cannot help a small site's first load.** The web seed wins the race for anything under about 16 MiB (model). Do not promise faster loads or lower bills from peers on small sites; promise resilience.
5. **Silence is not consent, and a highlighted OK nudges.** The notice wording and button symmetry decide participation by tens of points (F20), and EDPB treats silence as no consent (F21); the loader already waits in `pending` until OK. The modelled 5-30% explicit-click rate is a planning range, not a forecast.
6. **Filter lists match on names and paths.** `tracker.cdnbye.com` is on five lists while the project's default trackers and STUN hosts are on none today (F19); that can change in a day. `nowebrtc` scriptlets can disable WebRTC on listed domains, and an unlisted site can still be flagged by a user report.
7. **Network type is invisible on most phones.** `connection.type` exists only in Chromium on Android (ChromeOS partial); Firefox removed it; iOS never had it; `saveData` is Chromium only (F24). Default-off on unknown is correct and also removes most phones from the seeder pool.
8. **Mobile data prices are from 2023** and the page does not state the collection date; use them for order of magnitude. Whether uploads count against a plan varies by operator.
9. **Token figures are a single-day API snapshot** (2026-10-17 21:40 UTC); the point is the scale of the drawdown, not the digits.
10. **Counter semantics.** Snowflake's 24 h windows count distinct proxy IPs, not people; the badge share is not a conversion rate. Conduit's "total stations" may be cumulative. Grass's 8.5M users is a vendor claim.
11. **The Poisson model assumes independent arrivals.** Real traffic clumps (a link on a popular forum is a burst, not a rate). It also ignores partial seeders (conservative), shares each seeder's uplink poorly (optimistic) and assumes consent and dwell are independent (consenting desktop visitors probably dwell longer, which would raise the seeder pool).
12. **Seeding costs the visitor more than bandwidth.** CPU, battery, upstream queueing delay and the IP exposure in the notice are real; none was measured here. The caps are a mitigation, not a proof of harmlessness.
13. **Hidden tabs.** Per `review/browser-mobile.md`: mobile browsers suspend hidden tabs within about 20 s, desktop Edge "sleeping tabs" and Chrome Memory Saver can discard hidden tabs, and Firefox desktop expects one timer per minute after 5 minutes hidden; Android Chrome exempts pages with an open data channel from timer throttling. A hidden desktop tab therefore seeds less than the cap implies (not measured here).
14. **Chrome's Local Network Access gate** may show "Look for and connect to any device on your local network." for same-LAN WebRTC pairs from Chrome 146 (F30): a browser-level prompt we do not control.
15. **Legal and regulatory aspects of paying people** (securities, money transmission, tax) were not researched; the recommendation to avoid tokens does not depend on them.

---

## 7. Open questions

1. What is the real explicit-click rate for magnet-web's notice, by device, with and without the 10 s deferral? (R4b, R7.)
2. What are typical **mean** engaged seconds per visit for the target sites (docs, blogs, small tools)? One pilot site's analytics would replace the assumption.
3. How many sites embed Snowflake's web badge and how many visitors do they show it to? That would turn 306 proxy IPs per day into a conversion rate.
4. What do Streamroot, Peer5, Hive and CDNBye measure for offload against audience size, with method? The quota and unreachable hosts prevented retrieval; try again when searches are available.
5. What P2P ratio do real PeerTube instances report? The playback-metrics schema exists (`w2b-04` F17); ask an admin or read an instance's OpenTelemetry output.
6. How did Spotify's 2010 numbers (share of bytes from peers) compare with NetSession's 70-80%? The paper was unreachable.
7. Are there 2024-2026 mobile-data price datasets (Cable.co.uk successor, ITU price baskets as % of GNI per capita) that replace the 2023 figures?
8. Does a click on OK under the current notice text count as valid consent for IP exposure under GDPR and ePrivacy, or is "legitimate interest plus notice and switch-off" (PeerTube's practice) the safer route? (`w2b-06` open question.)
9. Can an idle-only back-off like NetSession's section 3.9 be approximated in a browser (there is no API for line utilisation)? Round-trip time probes to the web seed might act as a proxy.
10. Does Chrome 146+ really prompt for same-LAN WebRTC pairs, and does the prompt reduce acceptance of the whole page? (R12.)
11. Is a cross-site upload budget possible in hub shared-origin mode, and is it desirable?
12. Is there any evidence that "proof of visit" tokens are valued by visitors or owners at all? I found none.

---

## 8. Not verified, or only partly verified

- Offload-versus-audience curves from Streamroot, Peer5, Swarmify, Hive, CDNBye (hosts unreachable, pages without figures, or marketing without method).
- PeerTube P2P usage statistics; Brave's "less than 0.1%" `ipfs://` figure (taken from `w1-07`, not re-read).
- Spotify's 2010 paper and the share of bytes served by peers; the 2014 end of P2P rests on Wikipedia citing TorrentFreak.
- Hughes et al. 2005 (85% free riders) and Toth 2011 (5-10% participation), both cited secondhand through Andrade and BOINC; Eick, Massey and Whitt 1993 (time-varying M/G/infinity) from memory.
- The wording of Snowflake's badge consent strings, Conduit's controls beyond the FAQ, and the meaning of `iptproxy`.
- Latest-edition mobile data prices, Honeygain and EarnApp payouts, home-ISP data caps.
- Whether any magnet-web visitor would actually see the Chrome LNA prompt.

---

## Appendix A. Sources actually read

All fetched on 2026-10-17 from this machine unless noted. "Summary" = read through the fetch tool's model summary; "text" = raw text or PDF text read by me.

| ID | Source | URL | Kind | Date of source |
|---|---|---|---|---|
| S1 | Zhao et al., "Peer-assisted Content Distribution in Akamai NetSession", IMC 2013 | https://haeberlen.cis.upenn.edu/papers/netsession-imc2013.pdf | PDF text | 2013-10 (data 2012), OLD |
| S2 | BEP 3, The BitTorrent Protocol Specification | https://www.bittorrent.org/beps/bep_0003.html | summary with quotes | current page |
| S3 | Cohen, "Incentives Build Robustness in BitTorrent" | http://bittorrent.org/bittorrentecon.pdf | PDF text | 2003-05-22, OLD |
| S4 | WebTorrent 3.0.21 source, `lib/torrent.js` (lines 84-85, 147-150, 1790-1875) and repo metadata | `node_modules/webtorrent/lib/torrent.js`; https://api.github.com/repos/webtorrent/webtorrent | local text; API | 2026-10-17 |
| S5 | Adar and Huberman, "Free Riding on Gnutella", First Monday 5(10) | https://firstmonday.org/ojs/index.php/fm/article/download/792/701 | HTML text | 2000-10, OLD |
| S6 | Andrade et al., "Influences on Cooperation in BitTorrent Communities", SIGCOMM P2PEcon workshop | https://conferences.sigcomm.org/sigcomm/2005/paper-AndMow.pdf | PDF text | 2005-08, OLD |
| S7 | Meulpolder et al., "Public and private BitTorrent communities: a measurement study", IPTPS | https://www.usenix.org/legacy/event/iptps10/tech/full_papers/Meulpolder.pdf | PDF text | 2010-04, OLD |
| S8 | Piatek et al., "Do incentives build robustness in BitTorrent?", NSDI | https://homes.cs.washington.edu/~arvind/papers/bittyrant.pdf | PDF text | 2007, OLD |
| S9 | Microsoft Learn, Delivery Optimization reference | https://learn.microsoft.com/en-us/windows/deployment/do/waas-delivery-optimization-reference | page text | ms.date 2026-05-20 |
| S10 | Microsoft Learn, eCDN: intro, technical overview, peering groups, analytics, silent test, Local Network Access policy | https://learn.microsoft.com/en-us/ecdn/intro ; .../technical-documentation/technical-overview ; .../how-to/set-up-peering-groups ; .../technical-documentation/analytics ; .../how-to/perform-silent-test ; .../how-to/configure-local-network-access-policy | page text | 2022-08 to 2026-08 (per page) |
| S11 | Hive Streaming home page (marketing) | https://www.hivestreaming.com/ | summary | undated |
| S12 | P2P Media Loader README; CDNBye `hlsjs-p2p-engine` README; repo metadata | https://raw.githubusercontent.com/Novage/p2p-media-loader/main/README.md ; https://raw.githubusercontent.com/cdnbye/hlsjs-p2p-engine/master/README.md ; https://api.github.com/repos/Novage/p2p-media-loader | summary; API | pushed 2026-10-17 |
| S13 | Swarmify home page | https://www.swarmify.com/ | summary | undated |
| S14 | PeerTube issue 5465; CHANGELOG; player strings | https://api.github.com/repos/Chocobozzz/PeerTube/issues/5465 ; https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/CHANGELOG.md ; https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/client/src/locale/player.en-US.json | text | 2022-12 to 2023-07; develop branch 2026-10-17 |
| S15 | Wikipedia, Spotify (P2P phase-out; secondary, cites TorrentFreak) | https://en.wikipedia.org/wiki/Spotify | summary | fetched 2026-10-17 |
| S16 | Tor Snowflake: project page, embed page, broker metrics, Tor Metrics CSV, community page | https://snowflake.torproject.org/ ; https://snowflake.torproject.org/embed.html ; https://snowflake-broker.torproject.net/metrics ; https://metrics.torproject.org/userstats-bridge-transport.csv?start=2026-07-01&end=2026-10-14&transport=snowflake ; https://community.torproject.org/relay/setup/snowflake/ | text; CSV | 2026-10-17 |
| S17 | Psiphon Conduit: home, FAQ, README, repo metadata | https://conduit.psiphon.ca/en/index.html ; https://conduit.psiphon.ca/en/faq.html ; https://raw.githubusercontent.com/Psiphon-Inc/conduit/main/README.md ; https://api.github.com/repos/Psiphon-Inc/conduit | page text; API | 2026-10-17 |
| S18 | Anderson, "BOINC: A Platform for Volunteer Computing" (preprint) | https://arxiv.org/pdf/1903.01699 | PDF text | 2018-12 (OLD) |
| S19 | CoinGecko public API, coins `bittorrent`, `theta-token`, `theta-fuel`, `filecoin`, `livepeer` | https://api.coingecko.com/api/v3/coins/bittorrent (and the others) | JSON | 2026-10-17 about 21:40 UTC |
| S20 | BitTorrent BTT page; Wikipedia, BitTorrent (company) | https://www.bittorrent.com/token/btt/ ; https://en.wikipedia.org/wiki/BitTorrent_(company) | summary | footer v1.3.13 (c) 2026; Wikipedia fetched 2026-10-17 |
| S21 | Filecoin Station README; Saturn L1-node README and metadata; Filecoin docs, retrieval | https://raw.githubusercontent.com/filecoin-station/desktop/main/README.md ; https://raw.githubusercontent.com/filecoin-saturn/L1-node/main/README.md ; https://api.github.com/repos/filecoin-saturn/L1-node ; https://docs.filecoin.io/basics/how-retrieval-works/basic-retrieval | text; summary | announcement tweet id 1932472254245298504 decodes to 2025-06-10T16:17:43Z (computed; tweet not read) |
| S22 | Grass; Livepeer network docs; Theta home page | https://www.grass.io/ ; https://docs.livepeer.org/network ; https://www.thetatoken.org/ | summary | 2026-10-17 |
| S23 | Wikipedia, Hola (VPN) (secondary; cites ZDNet 2015-05-29, Business Insider 2015-05-28, The Register 2015-06-10) | https://en.wikipedia.org/wiki/Hola_(VPN) | summary | 2015 events, OLD |
| S24 | Filter lists and issues: uBlock filters Privacy (min build), `resource-abuse.txt`, `assets.json`, uAssets issues 659, 6433, 10602; EasyPrivacy, EasyList, StevenBlack, AdGuard DNS, AdGuard Base, HaGeZi Pro and TIF, OISD small | https://ublockorigin.github.io/uAssetsCDN/filters/privacy.min.txt ; https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt ; https://raw.githubusercontent.com/gorhill/uBlock/master/assets/assets.json ; https://api.github.com/repos/uBlockOrigin/uAssets/issues/659 (also /6433, /10602) ; https://easylist.to/easylist/easyprivacy.txt ; https://easylist.to/easylist/easylist.txt ; https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts ; https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt ; https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt ; .../tif.txt ; https://small.oisd.nl/ ; https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt | text | privacy list built 2026-10-16; EasyPrivacy 2026-10-17 21:36 UTC |
| S25 | Utz et al., "(Un)informed Consent", CCS 2019; Nouwens et al., "Dark Patterns after the GDPR", CHI 2020 | https://arxiv.org/pdf/1909.02638 ; https://arxiv.org/pdf/2001.02479 | PDF text | 2019-10; 2020-01 (OLD) |
| S26 | EDPB Guidelines 03/2022 v2.0; FTC "Bringing Dark Patterns to Light"; deceptive.design types | https://www.edpb.europa.eu/system/files/documents/2023-02/edpb_03-2022_guidelines_on_deceptive_design_patterns_in_social_media_platform_interfaces_v2_en_0.pdf ; https://www.ftc.gov/system/files/ftc_gov/pdf/P214800%20Dark%20Patterns%20Report%209.14.2022%20-%20FINAL.pdf ; https://www.deceptive.design/types | PDF text; summary | 2023-02-14; 2022-09-14 |
| S27 | RFC 9576, The Privacy Pass Architecture | https://www.rfc-editor.org/rfc/rfc9576.txt | summary | 2024-06 |
| S28 | Cable.co.uk worldwide mobile data pricing (301 to the host below), 2023 edition | https://www.cable.co.uk/mobiles/worldwide-data-pricing/ -> https://bestbroadbanddeals.co.uk/mobiles/worldwide-data-pricing/ | summary | 2023, OLD |
| S29 | AWS CloudFront price list; CloudFront flat-rate plans; Cloudflare R2 pricing; GitHub Pages limits | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudFront/current/index.json ; https://aws.amazon.com/cloudfront/pricing/ ; https://developers.cloudflare.com/r2/pricing/ ; https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits | JSON; summaries | price list `publicationDate` 2026-10-03T00:04:26Z |
| S30 | MDN browser-compat-data: `NetworkInformation`, `Navigator.connection`, `prefers-reduced-data` | https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/NetworkInformation.json ; .../api/Navigator.json ; .../css/at-rules/media.json | JSON | main branch 2026-10-17 |
| S31 | Wikimedia REST API, aggregate pageviews (hourly and daily; human "user" agent) | https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/{project}/{access}/user/{granularity}/{start}/{end} | JSON | 2026-09-01 to 2026-10-16 |
| S32 | Haile, TIME (Chartbeat); Liu, White, Dumais, SIGIR 2010 (abstract page); Contentsquare 2026 benchmark landing page | https://time.com/12933/what-you-think-you-know-about-the-web-is-wrong/ ; https://www.microsoft.com/en-us/research/publication/understanding-web-browsing-behaviors-through-weibull-analysis-of-dwell-time/ ; https://contentsquare.com/guides/digital-experience-benchmarks/ | summaries | 2014-03-09 (OLD); 2010 (OLD); 2026 |
| S33 | Little, "Little's Law as Viewed on Its 50th Anniversary", Oper. Res. 59(3); Wikipedia, Little's law; local simulation | https://people.cs.umass.edu/~emery/classes/cmpsci691st/readings/OS/Littles-Law-50-Years-Later.pdf ; https://en.wikipedia.org/wiki/Little%27s_law ; `docs/research/labs/w2c-07-lab/` | PDF text; summary; code | 2011 (OLD); 2026-10-17 |
| S34 | Local project files and sibling research | `docs/ARCHITECTURE.md`, `docs/review/DESIGN-REVIEW.md`, `docs/review/distributed-systems.md`, `docs/review/browser-mobile.md`, `src/loader/{policy,config,ui,app,torrent}.js`, `docs/research/{03-webrtc-nat-privacy,w1-07-prior-art,w1-10-static-hosting-bootstrap,w2b-04-observability-no-backend,w2b-06-abuse-legal-ops}.md` | local text | read 2026-10-17 |
| S35 | WebTorrent FAQ | https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/faq.md | summary | master 2026-10-17 |
| S36 | ITU: Facts and Figures 2025; ICT price baskets page | https://www.itu.int/itu-d/reports/statistics/facts-figures-2025/ ; https://www.itu.int/en/ITU-D/Statistics/Pages/ICTprices/default.aspx | summaries | 2025 |
| S37 | Chrome for Developers, Local Network Access | https://developer.chrome.com/blog/local-network-access | summary | updated 2025-09-29 |

Attempted and not readable (so not used): Honeygain help centre (HTTP 403), Xfinity data-usage page (403), Whitt's publications page (403), Kreitz and Niemela Spotify paper at KTH (404, three URL variants), Locher et al. "Free riding in BitTorrent is cheap" (404), NSDI 2007 USENIX URLs (404; the author copy in S8 worked), ITU price-report pages (no figures extractable), Web Monetization home page (no body text), Coinhive via Wikipedia (redirects to the Monero article; no relevant detail), Tribler README (no incentive text).

---

## Appendix B. The calculator, its assumptions and its outputs

Files: `docs/research/labs/w2c-07-lab/little-calc.mjs`, `RUN.txt`, `diurnal.py`, `results/tables.txt`, `results/montecarlo.txt`. Run with Node 22 or later, no dependencies.

### B.1 Formulas

- Mean visitors online: `E[N] = visits_per_day x mean_dwell_s / 86400` (Little's law, with Poisson arrivals this is also the Poisson mean for any dwell distribution). Chance a visitor arrives alone: `exp(-E[N])`. At the busiest hour multiply by the peak factor (1.25 global, about 1.6-1.9 national).
- Eligible seeders online: `a_seed = (visits_per_day / 86400) x p x E[(S - t_ready)+]`, where `p = P(consent) x P(policy allows upload) x P(a direct connection works)` and `t_ready` is the time before a visitor holds the whole site (3 s). `E[(S - t)+]` is computed from the Weibull dwell model (shape 0.6 unless set).
- Share of one download's bytes from peers with `k` eligible peers online and the web seed running in parallel: let `pre = webseed_rate x setup_time`; if `pre >= size` the share is 0; otherwise `share = (size - pre) / size x (k x peer_rate) / (webseed_rate + k x peer_rate)`. The expectation is taken over `k ~ Poisson(a_seed)`.

### B.2 Scenario parameters and why

| Parameter | Pessimistic | Baseline | Optimistic | Basis |
|---|---|---|---|---|
| P(consent): visitor clicks Share or has a stored consent | 0.05 | 0.30 | 0.90 | Utz et al.: 5.5% interaction on large desktop screens, 13.8-37.1% typical un-nudged range; 0.90 mimics a default-on design where NetSession users kept the default 98.11% of the time (weaker consent semantics, shown only as an upper bound) |
| P(policy): desktop, or phone on confirmed Wi-Fi | 0.12 | 0.35 | 0.60 | Wikimedia desktop shares 11.7% (fa), 36.1% (en), 37.5% (de); 0.60 is an assumed desktop-heavy audience |
| P(connect): direct WebRTC works without TURN | 0.70 | 0.80 | 0.85 | `03-webrtc-nat-privacy.md`: STUN-only success "around 85%" and "common lore around 80%", cellular worse |
| `t_ready` | 3 s | 3 s | 3 s | upper end of the 1.5-3 s peer path in `review/distributed-systems.md` |
| Web seed rate | 8 MiB/s (2 in T3b) | | | assumption: CDN-backed host over broadband |
| Peer upload rate | 1 MiB/s | | | `config.policy.desktop.uploadLimit` = 1,048,576 B/s |
| Peer setup | 2 s | | | midpoint of 1.5-3 s |
| Dwell shape | 0.6 | | | convenience for "negative aging"; a single Weibull fits the Utz bins badly (F26) |

### B.3 Limits of the model

Partial seeders are ignored (conservative). Each seeder's uplink is assumed free for the newcomer (optimistic when downloads overlap). Churn during a download is ignored (optimistic). Consent, device class and dwell are treated as independent (probably conservative: desktop consenters likely stay longer). Arrivals are Poisson, so bursts are only captured through the peak factor. Nothing here measures CPU, battery or queueing delay on the seeder.

### B.4 Outputs (`node little-calc.mjs --tables`)

```
T1. Little's law: mean visitors online E[N] = visits/day x mean dwell / 86400, and P(alone on arrival) = e^-E[N]
visits/day            dwell 20s         dwell 60s        dwell 180s        dwell 600s
100                  0.02 (98%)        0.07 (93%)        0.21 (81%)        0.69 (50%)
1000                 0.23 (79%)        0.69 (50%)        2.08 (12%)      6.94 (0.10%)
10000               2.31 (9.9%)      6.94 (0.10%)      20.8 (0.00%)      69.4 (0.00%)
100000             23.1 (0.00%)      69.4 (0.00%)       208 (0.00%)       694 (0.00%)
1000000             231 (0.00%)       694 (0.00%)      2083 (0.00%)      6944 (0.00%)

T2. Eligible seeders online (a_seed), mean dwell 60 s, Weibull shape 0.6, ready after 3 s; and daily visits needed for a_seed = 25
scenario      p        seedTime         V=100     V=1000    V=10000   V=100000  V=1000000   visits/day for a_seed=25
pessimistic   0.0042   0.96              0.00       0.00       0.03       0.28       2.79                   8964665
baseline      0.0840   0.96              0.01       0.06       0.56       5.58       55.8                    448233
optimistic    0.4590   0.96              0.03       0.30       3.05       30.5        305                     82030

T3. Expected share of bytes from peers (model), web seed 8 MiB/s, peers 1 MiB/s each, first peer wire after 2 s
site MiB     a_seed=0.1    a_seed=1    a_seed=3   a_seed=10   a_seed=30  a_seed=100
2                 0.00%       0.00%       0.00%       0.00%       0.00%       0.00%
5                 0.00%       0.00%       0.00%       0.00%       0.00%       0.00%
20                0.22%        2.0%        5.1%         11%         16%         19%
50                0.75%        6.9%         17%         37%         53%         63%
128               0.96%        8.8%         22%         47%         69%         81%

T3b. Same, but a slow or distant web-seed path (2 MiB/s effective): peers matter more when the host path is slow
site MiB     a_seed=0.1    a_seed=1    a_seed=3   a_seed=10   a_seed=30  a_seed=100
2                 0.00%       0.00%       0.00%       0.00%       0.00%       0.00%
5                 0.65%        5.3%         11%         16%         19%         20%
20                 2.6%         21%         44%         66%         75%         78%
50                 3.0%         24%         50%         75%         86%         90%
128                3.2%         26%         53%         79%         91%         95%

T4. Egress and list-price savings per month (30 days), baseline scenario, CloudFront list $0.085/GB (first 10 TB)
visits/day  site MiB  egress GB/mo  a_seed   offload   saved GB/mo   saved $/mo
1000        5         146           0.06     0.00%     0.0           $0.00
10000       5         1465          0.56     0.00%     0.0           $0.00
100000      5         14648         5.58     0.00%     0.0           $0.00
10000       50        14648         0.56     4.0%      584.5         $49.69
100000      50        146484        5.58     27%       39118.6       $3325.08
100000      500       1464844       5.58     38%       556864.3      $47333.47

T5. What a mobile visitor pays to upload (price per GB from cable.co.uk 2023 edition; both directions count toward caps on most plans: assumption)
region                        5 MiB up   15 MiB up   50 MiB up   vs host saving at $0.085/GB
Israel (cheapest)              $0.0001     $0.0003     $0.0010   visitor cost = 0.2x host saving
Asia ex Near East avg          $0.0054     $0.0161     $0.0537   visitor cost = 12.9x host saving
global avg (2023)              $0.0126     $0.0379     $0.1265   visitor cost = 30.5x host saving
Sub-Saharan Africa avg         $0.0162     $0.0485     $0.1616   visitor cost = 38.9x host saving
Northern America avg           $0.0224     $0.0672     $0.2241   visitor cost = 54.0x host saving
Zimbabwe (dearest)             $0.2136     $0.6409     $2.1362   visitor cost = 514.7x host saving
```

Note on T4: it prices every saved GB at the first-tier $0.085, so the three large-volume rows overstate dollar savings (the blended US/EU list price falls to $0.06 above 50 TB a month and $0.025 above 1 PB; price list of 2026-10-03). T5 assumes uploads count toward the visitor's allowance; that varies by operator.

### B.5 Simulation check (`node little-calc.mjs --montecarlo`)

Fields: `fano` = variance / mean of the sampled concurrency (1.0 means Poisson); `simP0` / `theoryP0` = share of samples with nobody online vs `exp(-E[N])`; `top10Share` = share of total dwell time held by the longest 10% of visits.

```
{"name":"V=3000/day  dwell 60s k=0.6 homogeneous","visits":119880,"perDay":2996.9,"theoryMean":2.0833,"simMean":2.0959,"simVar":2.0907,"fano":0.99753,"simP0":0.12343,"theoryP0":0.12451,"medianDwell":21.811,"meanDwell":60.459,"top10Share":0.51379,"top1Share":0.12228}
{"name":"V=30000/day dwell 60s k=0.6 homogeneous","visits":599100,"perDay":29955,"theoryMean":20.833,"simMean":20.726,"simVar":20.766,"fano":1.002,"simP0":0,"theoryP0":8.9577e-10,"medianDwell":21.592,"meanDwell":59.819,"top10Share":0.51034,"top1Share":0.11919}
{"name":"V=300/day   dwell 20s k=0.5 homogeneous","visits":23901,"perDay":298.76,"theoryMean":0.069444,"simMean":0.069559,"simVar":0.069433,"fano":0.99819,"simP0":0.93276,"theoryP0":0.93291,"medianDwell":4.8313,"meanDwell":20.21,"top10Share":0.59637,"top1Share":0.16359}
{"name":"V=30000/day dwell 60s k=0.6 diurnal phi=1.9","visits":600680,"perDay":30034,"theoryMean":20.833,"simMean":20.865,"simVar":197.27,"fano":9.4546,"simP0":0.010782,"theoryP0":8.9577e-10,"medianDwell":21.724,"meanDwell":60.043,"top10Share":0.51015,"top1Share":0.11878,"peakHourMeanOverDayMean":1.9142,"peakHourUtc":15}
```

The diurnal run has a Fano factor of 9.5 because it mixes 24 hourly Poisson means; within an hour it is Poisson, and `peakHourMeanOverDayMean` (1.914 at 15:00 UTC) matches the set peak factor 1.9.
