# R2: Privacy failures of the current web (2024-2026) and what magnet-web does about each

- **Date:** 2026-10-20. **Applies to:** magnet-web 0.2.1 (as built) and the planned v0.3 (self-owned identity, owner-only-decryptable records, site-scoped pseudonyms, chat and file sharing).
- **Method:** WebSearch and WebFetch only; no browser was launched against any non-local address. Every external source carries an access date of 2026-10-20 unless stated. Repo claims cite the file and section.
- **Confidence scale:** High = primary page fetched and read this session. Medium = vendor, trade or law-firm summary of a primary source, or a search summary that was not cross-checked. Low = single blog or inference. Where only a secondary source was reachable, the finding says so. Sources older than 2024 are marked "older".
- **Wording:** "no backend", "site ledger". Nothing here says magnet-web is private by default. It is not (see section 2).

---

## 1. Summary

1. **Tracking is intact.** At least one tracker sits on 75% of desktop and 74% of mobile pages (Web Almanac 2025); Chrome kept third-party cookies and retired most Privacy Sandbox APIs in 2025 (F1). magnet-web adds none of its own but cannot stop an owner adding some.
2. **Breaches scale and passwords are reused.** Verizon 2025: 12,195 breaches, 30% with a third party, 22% starting with credential abuse; HIBP added 1.96 billion emails and 1.3 billion passwords from stuffing lists in November 2025 (F4, F8). A site with no accounts has no password database to stuff. That is a claim about absence, not a cleverer defence.
3. **Age-verification laws create honeypots.** Paxton (June 2025), UK checks (July 2025), Australia (March 2026), Utah SB 73; about 70,000 Discord ID photos exposed via a vendor in October 2025 (F10). magnet-web cannot verify age and must never put ID material in the public ledger.
4. **Big-provider sign-in is a surveillance and lockout point** by design; v0.3 removes the provider, at the price that nobody can reset a lost key (F9).
5. **magnet-web imports a failure it cannot remove:** peers, trackers, STUN servers and the DoH resolver see IP addresses and site membership once the visitor shares. With sign-in, a peer can link an IP address to a key (F13, F16).
6. **Design conflict (P0):** PRIVACY.md says no personal data in the ledger, even encrypted; v0.3 plans encrypted auth and profile records in it (F17).
7. **AI scraping:** AI-only crawlers are a large share of crawler traffic and rarely send visitors back (Cloudflare, 2025). A public ledger cannot be robots.txt'ed; owner-only encryption protects private records, not public posts (F11).
8. **Centralisation:** the AWS us-east-1 fault (19-20 Oct 2025) and the Cloudflare outage (18 Nov 2025, about 5 h 46 min). magnet-web helps returning visitors but keeps one HTTPS host as trust root and leans on Cloudflare defaults (F12).
9. **ISP metadata:** Salt Typhoon showed what bulk metadata is worth; Tor Browser disables WebRTC, so the strongest network protection is unavailable to swarm features (F13).
10. **Bottom line:** today it solves (for itself) analytics, cookies, accounts, passwords and IdP; mitigates first-party data flow; does not address IP exposure, ISP metadata, scraping of public posts, age duties or the host as trust root. v0.3 can add self-owned keys, site-scoped pseudonyms, owner-only-decryptable records and no IdP. It cannot add IP anonymity, copy deletion or key recovery.

## 2. Baseline (repo facts used below)

- Loader: no analytics, telemetry, third-party scripts or cookies; before the visitor chooses, it talks only to hosts the owner chose (PRIVACY.md, In short and Recipients register).
- After "Share and load": WebSocket trackers (defaults tracker.webtorrent.dev, tracker.openwebtorrent.com, tracker.novage.com.ua, open.ftorrent.com), STUN (stun.cloudflare.com, global.stun.twilio.com) and peers see the IP address and the site viewed. Shell pages also ask a DoH resolver (Cloudflare, then dns.sb, then Google) for the site name's _magnet record. "Load from host only" avoids all of this (PRIVACY.md).
- Identity: ECDSA P-256 key pair per ledger id in IndexedDB, passphrase-wrapped export and import, 8-hex fingerprint (ARCHITECTURE.md 6.1). Ledger entries are public, signed, hash-linked and copied by every visitor (SECURITY-MODEL.md).
- Same-origin site scripts can use the visitor's key (SECURITY-MODEL.md; w2c-03 F1, confirmed in VERIFY claim 1). Safari may delete site data after 7 days of Safari use without interaction (WHY.md; VERIFY claim 2).
- Not in 0.2.1: TURN relays, Nostr relays, analytics (PRIVACY.md).

---

## 3. Findings

Each finding has: the evidence, whether magnet-web today solves / mitigates / does not address it, what v0.3 would add, and the residual risk.

### F1. Third-party tracking

**Evidence.**
- HTTP Archive Web Almanac 2025, Privacy chapter: at least one tracker on 75% of desktop pages and 74% of mobile pages, counting only the WhoTracks.me categories advertising, pornvertising, site_analytics and social_media. `_ga` cookie on 46% of pages, `_fbp` on 14%, doubleclick.net third-party cookies on 20% of desktop sites. The chapter does not state the page count in the text I read. https://almanac.httparchive.org/en/2025/privacy (accessed 2026-10-20; High for the numbers as printed, with the chapter's own internal inconsistencies noted by the fetch, e.g. Facebook Pixel 15% vs 16%).
- Peer-reviewed measurement, June 2025: Google trackers on 72.6% of 40,150 sites vs Meta 28.2%; Meta trackers were configured to collect form data far more often (62.3% vs 11.6%). Numbers confirmed on the arXiv abstract; the 40,150 figure is from a search summary. https://arxiv.org/abs/2506.16891 (accessed 2026-10-20; High/Medium).
- Chrome kept third-party cookies (April 2025) and retired most Privacy Sandbox APIs (October 2025). https://betanews.com/2025/10/20/google-is-retiring-privacy-sandbox/ (accessed 2026-10-20; Medium, trade press).
- FTC staff report, 19 Sep 2024: nine platforms ran "vast surveillance of consumers in order to monetize their personal information", kept data indefinitely, covered non-users and took in broker data. https://www.ftc.gov/news-events/news/press-releases/2024/09/ftc-staff-report-finds-large-social-media-video-streaming-companies-have-engaged-vast-surveillance (accessed 2026-10-20; High).

**magnet-web today: solves for itself, does not address for the site owner.** The loader sends nothing to an ad or analytics party (PRIVACY.md). That is a property of the loader, not of the site. In drop-in mode the owner's own HTML still decides which third-party scripts load, and SECURITY-MODEL.md already warns they run with the loader's privilege. The honest statement is: "magnet-web adds no tracker; it does not remove the ones you add."

**v0.3 upgrade.** A build-time audit listing every third-party origin a built site contacts, failing a "no third-party" profile. Decrypted records need an origin or unlock that site scripts cannot reach (w2c-03 F1: not free).

**Residual.** Trackers that already run on the owner's other sites. Browser-level tracking (cookies set by other sites). A swarm tracker operator sees the IP address with the infohash of every magnet-web site that visitor opens (see F16).

### F2. Fingerprinting

**Evidence.**
- WWW 2025 paper "The First Early Evidence of the Use of Browser Fingerprinting for Online Tracking" (Texas A&M, Johns Hopkins, F5; FPTrace) reports that changing a browser's fingerprint changed ad bids and server-side behaviour, and that fingerprinting can bypass GDPR and CCPA opt-outs. Summary seen via search; paper not fetched. https://research.buaa.edu.cn/en/publications/the-first-early-evidence-of-the-use-of-browser-fingerprinting-for/ (accessed 2026-10-20; Medium).

**magnet-web today: does not address, and slightly worsens one surface.** The loader does not fingerprint. But a P-256 posting key is a stable identifier visible to every peer that receives your entries, and WebRTC behaviour (candidate types, timing, uptime) is observable by peers. I found no study of WebRTC-swarm fingerprinting in the 2024-2026 results; this is an inference, flagged Low.

**v0.3 upgrade.** Site-scoped pseudonyms (a key derived per site from a seed, as w2c-03 section 4.2 recommends) prevent two sites' ledgers from being joined by key. Keep the profile record encrypted so the display name and avatar are not a fingerprint to strangers.

**Residual.** Browser fingerprinting by any script on the same origin. IP address plus key linking inside one swarm.

### F3. Data brokers and real-time bidding

**Evidence.**
- FTC 2024 report (F1) records brokers as an input to platforms' profiles.
- California Delete Act: the DROP platform opened to consumers on 1 January 2026, brokers must process requests from 1 August 2026, and the registry lists over 600 brokers per an August 2026 secondary report (Malwarebytes). The registry page itself should be checked for the current count. https://cppa.ca.gov/data_brokers and https://www.malwarebytes.com/blog/news/2026/08/californians-can-tell-data-brokers-to-drop-their-information (accessed 2026-10-20; Medium).

**magnet-web today: mitigates by absence.** There is no ad request, so no bid request, and no email or account to match. It does not touch what brokers already hold. The IP address leaking to peers is itself raw material a broker or a monitoring firm can collect (F16).

**v0.3 upgrade.** Do not ask for email, phone or real name anywhere in the sign-in flow; make that a written rule, not just a default. Site-scoped pseudonyms mean there is no cross-site key for a broker to join.

**Residual.** A visitor's IP address and device are already in broker datasets. magnet-web cannot remove anyone from them.

### F4. Breach statistics

**Evidence.**
- Verizon 2025 DBIR: over 22,000 incidents, 12,195 confirmed breaches; third-party involvement doubled to 30%; credential abuse 22% and exploited vulnerabilities 20% as initial vectors; ransomware in 44% of breaches. http://www.verizon.com/about/news/2025-data-breach-investigations-report (accessed 2026-10-20; High).
- Identity Theft Resource Center, 2025 annual report: 3,322 compromises (a record, vs 3,202 in 2023) but 278,827,933 victim notices vs 1,367,117,021 in 2024; 70% of notices gave no attack details; PowerSchool alone about 71.9 million. Primary page returned 403; figures from a podcast summary on ITRC's site and press. https://www.idtheftcenter.org/podcast/fraudian-slip-2025-annual-data-breach-report-by-itrc/ (accessed 2026-10-20; Medium).

**magnet-web today: mitigates.** A site's backend, user table and password hashes do not exist, so there is no central store to breach. The static host holds public files. The site ledger is public by design, so "a breach" of it means nothing new leaks, and the harm instead is whatever the owner or visitors wrongly put in it (F17). The weak point is the host as trust root: a compromised host or DNS controls what code visitors run (SECURITY-MODEL.md).

**v0.3 upgrade.** Records encrypted to their owner's key limit what a ledger copy reveals. Third-party risk (30% of breaches) shrinks if the site includes no third-party service, which magnet-web can only encourage (F1).

**Residual.** Device compromise, malicious extensions (out of scope per SECURITY-MODEL.md), a stolen owner key, and the host.

### F5. Consent dark patterns

**Evidence.**
- Nouwens et al., CHI 2020 (older): of 680 consent-management-platform instances on the top 10,000 UK sites, only 11.8% met minimal legal requirements; 12.6% offered reject-all as easily as accept-all; 56.2% pre-ticked optional purposes. https://discovery-pp.ucl.ac.uk/id/eprint/10088400/1/CHI1912.pdf (accessed 2026-10-20; Medium, from search summary).
- Gap: no 2024-2026 dark-pattern sweep or large study turned up in search.

**magnet-web today: mitigates, with a self-inflicted risk.** There is no tracking banner because there is no tracking. But the loader has its own consent card ("Share and load", "Load from host only"), and CRITIQUE.md notes the consent rate (0.30) is a planning figure. The temptation to raise that rate by design is the dark-pattern risk. WHY.md cites uBlock Origin's rule that undisclosed peer-to-peer scripts "MUST be opt-in, with complete informed consent from the visitor".

**v0.3 upgrade.** Add a testable consent-card rule: both buttons the same size, same layer, same prominence; no pre-selected "share"; a plain list of what each recipient sees; a regression test that fails if the host-only path takes more clicks than the share path. The chat and file features must be off until the visitor opts in separately for each (presence, uploads).

**Residual.** Whether consent is valid at all for Service Worker storage and peer upload is the research's inference, since the EDPB's guidelines do not name these technologies (CRITIQUE.md, Privacy has a cost in friction; PRODUCTION-DIGEST 4.2). Counsel must confirm.

### F6. Cross-device identity graphs

**Evidence.**
- Universal IDs derived from hashed email (UID2, RampID) and ID5's mixed deterministic and probabilistic matching (ID5 launched "Adaptive Identity" in June 2025 and bought TrueData in November 2025) matter most where third-party cookies are absent: Safari, apps, connected TV. FTC restated in July 2024 that hashing does not make data anonymous. Trade and consultancy sources only. https://flexyconsent.com/blog/universal-ids-consent-audit-publishers-2026/ and https://ppc.land/identity-graph/ (accessed 2026-10-20; Medium/Low).

**magnet-web today: mitigates.** No email or phone number is collected, so there is nothing to hash and match. The key is per ledger id (ARCHITECTURE.md 6.1), so two magnet-web sites do not share a posting key.

**v0.3 upgrade.** Keep it: derive the key per site (HKDF from a single seed), never expose the seed, never use the same public key across sites, never use email for sign-in.

**Residual.** The IP address is the common thread. A tracker or STUN operator, or a monitor that sits in several swarms, can join one visitor's activity across sites by IP address and timing without any key (inference; supported by the monitoring studies in F16). Mobile carriers' shared (CGNAT) addresses blur this; home broadband does not.

### F7. Email and link tracking

**Evidence.** Apple Mail Privacy Protection pre-fetches images through a proxy and inflates opens; a trade blog cites a July 2026 Litmus figure of Apple clients at 62.26% of tracked opens and about half of reported opens inflated (not checked against Litmus). https://www.webtonic.io/blog/open-rate-statistics (accessed 2026-10-20; Low). I found no reliable figure for the share of marketing email carrying a tracking pixel.

**magnet-web today: does not address.** It sends no email and wraps no links; an owner who emails a magnet link uses their own mailer.

**v0.3 upgrade.** For private invites, put the decryption key in the URL fragment (not sent to servers by URL semantics) and warn that mailing it through a tracking mailer leaks the key to the mailer. Prefer end-to-end-encrypted delivery.

**Residual.** Outside magnet-web once the owner chooses email.

### F8. Password databases and credential stuffing

**Evidence.**
- Have I Been Pwned, 5 November 2025: 1,957,476,021 unique email addresses and 1.3 billion unique passwords (625 million never seen before) from Synthient's credential-stuffing threat data. https://www.troyhunt.com/2-billion-email-addresses-were-exposed-and-we-indexed-them-all-in-have-i-been-pwned/ (accessed 2026-10-20; High).
- DBIR 2025: credential abuse 22% of initial vectors (F4).

**magnet-web today: solves by absence for the login case, and has no login.** There is no password database. The honest flip side: there is no account recovery. The existing identity is a browser-stored key; Safari and storage-clearing can lose it, and w2c-03 section 1 already makes backup mandatory.

**v0.3 upgrade (the heart of the design).** A seed-derived key pair per site; the site authenticates a visitor by a signed challenge recorded in the site ledger; no password exists to steal, reuse or stuff. Recovery is the visitor's seed (recovery phrase or passphrase-wrapped file, w2c-03 section 4.2). A passkey is an optional wrapper, not the foundation (w2c-03 summary points 5 and 6; WebAuthn Level 3 is a W3C Recommendation as of 2026-08-25 per that doc).

**Residual.**
- Anyone who holds the seed is the visitor. Phishing for a recovery phrase replaces phishing for a password.
- Same-origin site scripts can use the unlocked key (w2c-03 VERIFY claim 1), so a malicious or compromised site can sign as the visitor on that site.
- No help desk. A lost seed means a lost identity and every record encrypted to it.
- No Sybil resistance: a person can mint any number of keys. The hashcash fee is a fee, not a defence (CRITIQUE.md, Proof-of-work).

### F9. Sign-in with Google, Apple or Facebook

**Evidence.**
- Design point: in OpenID Connect the provider issues the token for a named relying party, so it can learn each login to each site. I found no 2025 measurement of this and no recent consumer-protection study of third-party login tracking (the search for one came back empty). Flagged Low; treat as architecture, not a statistic.
- Lockout and lock-in cases are user reports: a developer whose Google Cloud project was suspended around 24 May 2026 could not use or move its Android Google Sign-In OAuth client, with no appeal answer after about six weeks (https://discuss.google.dev/t/live-app-blocked-requested-entity-already-exists-android-oauth-client-reserved-by-a-suspended-project/377358); Figma and Netlify users reported suspension messages after Google sign-in (accessed 2026-10-20; Low, anecdotal).

**magnet-web today: solves (it has no IdP) but also provides no login.** An owner can still wire any IdP script into a site; the loader does not stop it.

**v0.3 upgrade.** The site ledger records "this key signed in", with a challenge bound to the site and a time, so nobody outside the site's swarm learns it. No IdP, so no third party learns the login. Keep the example site free of any IdP script.

**Residual.** Peers in the swarm can see a sign-in entry's author key (unless the auth record is encrypted, which hides the contents but not the existence and timing of an entry). Lost-seed recovery is on the visitor. Federated identity wallets such as the EU Digital Identity Wallet are a different thing (F10).

### F10. Age verification and digital-ID laws

**Evidence.**
- Free Speech Coalition v. Paxton, decided June 2025, 6-3: Texas's age-verification law for sexually explicit sites is judged under intermediate scrutiny; "adults have no First Amendment right to avoid age verification". https://www.faegredrinker.com/en/insights/publications/2025/6/supreme-court-decides-free-speech-coalition-inc-v-paxton (accessed 2026-10-20; Medium; one source said 26 June, another 27 June).
- Utah SB 73, signed 19 March 2026, treats a person behind a VPN as accessing from Utah and bars certain sites from facilitating VPN use; Utah agreed not to enforce until 3 September 2026 and then agreed on 17 September 2026 not to enforce against Aylo pending a ruling or rules. EFF warns this pushes sites to block VPN addresses or verify everyone. https://www.eff.org/deeplinks/2026/04/utahs-new-law-regulating-vpns-goes-effect-next-week (accessed 2026-10-20; High).
- UK Online Safety Act checks began July 2025; Australia began enforcement 9 March 2026 (https://www.comparethecloud.net/news/uk-age-verification-law-drove-vpn-downloads-above-800000-a-month-and-they-havent-come-back-down; Low/Medium). EU Digital Identity Wallet (Regulation 2024/1183, due end of 2026): EDRi and others said in March 2026 that draft rules weaken unlinkability (https://edri.org/our-work/the-eid-wallet-still-doesnt-deserve-your-full-trust/; Medium).
- Breach of age-check data: Discord said about 70,000 users' ID photos may have been exposed through a third-party support vendor in October 2025; the attackers claimed far more and Discord called that claim inaccurate. https://hothardware.com/news/discord-data-breach-exposes-scanned-ids (accessed 2026-10-20; Medium).

**magnet-web today: does not address.** It has no gatekeeper to check age and PRIVACY.md says a children's site should run host-only, with no owner setting that forces it in 0.2.1. A site owner that falls under such a law remains responsible for compliance; magnet-web does not satisfy it.

**v0.3 upgrade.** Nothing in v0.3 verifies age. What it can do is let a visitor hold a credential from a third party (for example, a wallet-issued age proof) and present only a yes-or-no to the site, never storing the document. Do not build this in v0.3; design the record format so an attestation can be added later. Write a rule: no identity document, face image or date of birth ever goes into the public site ledger, encrypted or not (F17).

**Residual.** If a law requires a site to verify its visitors, a no-backend site has no compliant path inside magnet-web alone. That is a limit, stated plainly.

### F11. AI scraping and training on personal content

**Evidence.**
- Cloudflare, 29 August 2025 (data Jan-Jul 2025): crawls per referred visit in July 2025 were Anthropic 38,065.7, OpenAI 1,091.4, Perplexity 194.8, Google 5.4; AI-only crawler share July 2025: GPTBot 28.1%, ClaudeBot 23.3%, Meta-ExternalAgent 17.7%; training's share of AI crawling rose from 72% to 79% over the year. https://blog.cloudflare.com/crawlers-click-ai-bots-training/ (accessed 2026-10-20; High).

**magnet-web today: does not address, and public posts are easier to scrape here than on a normal site.** Anyone can join the ledger swarm (its rendezvous infohash is derived from the ledger id, a label not a secret, SECURITY-MODEL.md) and copy every entry. There is no robots.txt for a swarm. Shell mode does hide content from crawlers that do not run the loader (CRITIQUE.md), but that is an accident of rendering, not a defence; a crawler can run a headless browser or the SDK.

**v0.3 upgrade.** Owner-only-decryptable auth and profile records mean a scraper gets ciphertext, a size and a timestamp. Private chat and private files are ciphertext to everyone but the intended identities. Public posts should be labelled "public and scrapeable" in the UI and the privacy notice.

**Residual.** Public means scraped. Ciphertext can be stored today and read later if the cryptography is broken (harvest now, decrypt later; NIST's draft IR 8547 proposes deprecating RSA and ECC algorithms by 2030 and disallowing them by 2035, draft per secondary sources; https://www.encryptionconsulting.com/nist-ir-8547-2030-2035-action-plan/ accessed 2026-10-20; Medium). P-256 signatures are not the confidentiality risk; the key agreement used for encryption is. Record the algorithm tag with every encrypted record so it can be migrated (the p256: tag already supports this for keys, ARCHITECTURE.md section 4).

### F12. CDN, DNS and cloud centralisation

**Evidence.**
- AWS us-east-1 (19-20 October 2025): a latent race condition in DynamoDB's DNS management left the regional endpoint with an empty DNS record; DynamoDB impact ran from 11:48 PM PDT on 19 October to 2:40 AM PDT on 20 October, and knock-on effects lasted until 2:20 PM PDT. https://aws.amazon.com/message/101925/ (accessed 2026-10-20; High). Ookla's Downdetector analysis called it the year's largest outage with over 17 million reports (secondary; https://www.fonearena.com/blog/471254/largest-outages-2025-ookla.html; Medium).
- Cloudflare, 18 November 2025: a database permissions change made a Bot Management feature file twice its intended size; the proxy exceeded its 200-feature limit and returned HTTP 5xx; impact began 11:20 UTC, all systems normal by 17:06 UTC (about 5 h 46 min); Turnstile, Workers KV and Access were hit; not an attack. https://blog.cloudflare.com/18-november-2025-outage/ (accessed 2026-10-20; High).

**magnet-web today: mitigates partly, and imports its own centralisation.**
- Mitigates: after the first visit the site files are in IndexedDB and the loader in a Service Worker cache (PRIVACY.md, What stays on the device), and the ledger is copied by every visitor, so reading an already-visited site and syncing the ledger do not require the origin host each time. This is code-reading; the tests are loopback only on one development machine (WHY.md, It is young), so it is not demonstrated on real networks.
- Does not remove: the first visit, updates, a new visitor who has no peer, and the trust root all need the HTTPS host and DNS (SECURITY-MODEL.md). Default STUN is Cloudflare and Twilio; the DoH resolver tried first is Cloudflare; the four default trackers are small third parties that appear on DNS block lists (WHY.md). An owner who puts the host behind Cloudflare inherits its outage.

**v0.3 upgrade.** Ship defaults an owner can replace without code (own tracker, own STUN, own DoH meta), document a "no big-provider defaults" profile, and show the visitor which third party each connection uses. Chat and file features should not add a new always-on hosted relay by default; if a relay is offered, it is the owner's choice and named in the consent card.

**Residual.** First-visit and update availability, and any shared hosting or CDN the owner picks.

### F13. ISP and metadata exposure

**Evidence.**
- Salt Typhoon: disclosed in December 2024 as a compromise of at least eight US telecom firms with call-record metadata (who called whom, duration, location); officials said full eviction timing was unknown; a CISA/FBI/NSA advisory dated August 2025 (AA25-239A) is cited by secondary sources but I did not verify its text. https://wtop.com/j-j-green-national/2024/12/the-worst-telecommunications-hack-in-us-history-chinese-cyber-group-salt-typhoon-intrusions-likely-started-years-ago/ (accessed 2026-10-20; Medium/Low).
- Repo research: WebRTC hides only private LAN addresses with mDNS; the public IP is always visible to peers, STUN servers and trackers; `iceTransportPolicy: "relay"` hides it from peers but not from the TURN operator and costs relay bandwidth; Tor Browser disables WebRTC; Safari Lockdown Mode disables RTCPeerConnection (docs/research/03-webrtc-nat-privacy.md, summary 7 and 8, F-16, F-23, G-05).

**magnet-web today: does not address.** The visitor's ISP sees the connection to the static host, the TLS names of the WebSocket trackers, STUN traffic, and DTLS to peer addresses. Using DoH hides the DNS query from the ISP and shows it to the resolver; it moves the exposure rather than removing it.

**v0.3 upgrade.** Offer an owner-chosen TURN or relay option for chat and file sessions ("relay option" in the owner's goal), clearly marked as a trade: peers stop seeing the IP, the relay operator sees it and the traffic volume, bandwidth is spent. Default on mobile data should be host-only plus no uploads (already the 0.2.1 default for uploads, WHY.md Phones are mostly downloaders). Document that magnet-web cannot be used inside Tor Browser for swarm features.

**Residual.** The ISP or a network observer can tell that a visitor is using a peer-to-peer WebRTC client and when. Chat timing, message sizes and who connects to whom (by IP) stay visible to anyone watching the network or the swarm.

### F14. Platform lock-in and deplatforming

**Evidence.** Bluesky's AT Protocol separates identity (a DID) from the hosting server and allows moving host; Mastodon's move carries followers but not posts; a Bluesky developer wrote in October 2025 that live migration works but is still a developer task (secondary). https://dev.to/pfefferle/the-at-protocol-3107 and https://techcrunch.com/2025/08/25/bounce-launches-a-service-for-moving-accounts-between-bluesky-and-mastodon (accessed 2026-10-20; Low/Medium). Nothing on Digital Markets Act portability was found in this pass. Google suspension cases: see F9.

**magnet-web today: mitigates for owners, partly for visitors.** A site is a signed pointer plus an infohash, so an owner can move the host (WHY.md, Lock-in and ownership); a visitor's key is theirs and exportable, and no platform can suspend it. Owners and moderators can still ban a key from their ledger, and a host or registrar can still remove the domain. Takedown cannot reach offline devices (SECURITY-MODEL.md). That is fewer single points of control, not none.

**v0.3 upgrade.** One seed with per-site derived keys, so a ban on one site does not touch others; export of one's own decrypted records in a standard file.

**Residual.** A banned visitor loses history on that site; the loader host can still be removed.

### F15. The economics behind the failures

**Evidence.** Company-reported 2025 advertising revenue: Google about $294.7 billion, Meta about $196.2 billion, Amazon about $68.6 billion (secondary page citing SEC filings; unverified). eMarketer forecasts the three at 62.3% of worldwide digital ad spend in 2026; Warc forecasts nearly 55% outside China for 2025; methods differ. https://www.marketingdive.com/news/meta-to-surpass-google-in-digital-ad-revenue-for-first-time-emarketer/817384/ (accessed 2026-10-20; Medium/Low). The FTC report (F1) says platforms monetise the data for billions of dollars a year.

**magnet-web today: does not change this.** It can lower serving cost for static, unmonetised sites if enough visitors seed (WHY.md, Honest economics). It offers no ad, subscription or payment layer; the hashcash fee is a spam fee paid to nobody.

**v0.3 upgrade.** None that changes incentives. It removes reasons to hold personal data (no login provider, no user table) but funds no one.

**Residual.** A site that lives on ads or data will not move. The honest audience already does not do that.

### F16. Surveillance of the swarm itself (a failure magnet-web imports)

**Evidence (older, but the mechanism is unchanged).**
- Birmingham study (2008): monitoring firms logged IPs of users in popular BitTorrent swarms within about three hours of joining. Omnify (Purdue and Microsoft Research, 2011) analysed 2.75 million swarms with 71 million IP addresses and found evidence of copyright monitors worldwide. A University of Washington paper (2008) reported that all DMCA notices it received during its experiments were false positives. https://www.cs.purdue.edu/homes/fahmy/papers/PAM2011.pdf and https://dada.cs.washington.edu/research/tr/2008/06/UW-CSE-08-06-01.pdf (accessed 2026-10-20; Medium; older).
- Repo: anyone who knows an infohash can join and list who is online (SECURITY-MODEL.md); the legal reading of "making available" for informed visitors comes from the CJEU Mircom decision (CRITIQUE.md, Legal exposure); a hub's shared domain attracts phishing (CRITIQUE.md).

**magnet-web today: does not address, and says so** (PRIVACY.md, SECURITY-MODEL.md, WHY.md all state it). Direct consequence for v0.3: with sign-in, a peer who sees an IP address and a signed entry from a key can link them, even when the key is pseudonymous. That is the single most important residual in the whole design.

**v0.3 upgrade.** Mitigations that can be built, none of which gives anonymity:
1. Host-only mode, kept as an equal-prominence choice.
2. A relay option so peers see the relay, not the visitor.
3. A "read without announcing" path: fetch the ledger snapshot over HTTPS without joining the swarm.
4. Sign-in only after the visitor opts into the swarm for that site; guest browsing never sends a key.
5. Do not publish presence by default; presence for chat is opt-in and per-room.
6. No cross-site key, so IP-to-key linking in one swarm does not extend to others by key (it still extends by IP).

**Residual.** Peers and relays see IP addresses; trackers see swarm membership (infohash plus IP); STUN servers see IPs. A malicious visitor can record who is online, when, and which keys post. No v0.3 option makes this disappear. The documents must say so.

### F17. Permanence of the public site ledger (a design conflict to resolve)

**Evidence.**
- PRIVACY.md (Impact assessments): "No personal data in the ledger, even encrypted: encrypted personal data is still personal data (EDPB Guidelines 02/2025, MIGRATION-DIGEST L3). The salted hash in a deleted entry's stub keeps short values from being guessed, but keys and list names are never deleted." WHY.md: "Keep personal data out of the ledger, even encrypted."
- EDPB Guidelines 02/2025 (subject: chain-based storage of personal data; adopted 8 April 2025 for consultation; secondary sources disagree on a later final version): immutability collides with erasure; the guidance favours keeping personal data off the chain and recording only references or commitments; encrypted data usually remains personal data; destroying keys can make data unidentifiable only while the encryption holds. Law-firm summaries; EDPB text not fetched. https://www.mccannfitzgerald.com/knowledge/data-privacy-and-cyber-risk/considering-using-blockchain-with-personal-data-the-edpb-has-provided-guidance-open-for-public-consultation-until-9-june-2025 and https://ppc.land/edpb-forces-blockchain-firms-to-avoid-storing-personal-data-on-chain/ (accessed 2026-10-20; Medium). The guidelines are applied here by analogy to a replicated signed log; counsel should confirm.

**magnet-web today:** consistent with itself: no personal data in the ledger.

**v0.3 conflict.** Storing each visitor's encrypted auth and profile record in the site ledger puts personal data in a log that every visitor copies and nobody can delete everywhere. Options (an owner decision, section 5): (a) keep the profile record in the visitor's device and export, and put only a salted commitment or a signed sign-in event in the ledger; (b) keep an encrypted record in the ledger and state clearly in the privacy notice that it is personal data, that deletion is by key destruction only, that copies persist, and that this holds only while the cipher holds; (c) store encrypted profile records as torrents (the file-sharing path) referenced from the ledger, so that the owner of the file can stop seeding. Option (c) is not erasure either.

**Residual.** Whichever is chosen, some copy will outlive a deletion. State that.

---

## 4. Summary matrix

Legend: S = magnet-web 0.2.1 solves (for what it controls), M = mitigates, N = does not address. "v0.3" is the planned upgrade; R = residual risk level (High / Med / Low).

| # | Failure | 0.2.1 | v0.3 adds | R |
|---|---|---|---|---|
| F1 | Third-party tracking | S for the loader; N for site-owner scripts | third-party audit; origin isolation for decrypted data | Med |
| F2 | Fingerprinting | N | site-scoped keys; encrypted profile | Med |
| F3 | Data brokers, RTB | M (no ad calls) | no email or phone anywhere in sign-in | Med (IP remains) |
| F4 | Breaches | M (no user table) | records encrypted to owner | Med |
| F5 | Consent dark patterns | M (own card; no tracking) | equal-prominence rule and test; separate opt-ins for chat and uploads | Med |
| F6 | Cross-device identity graphs | M | per-site derivation | Med (IP joins) |
| F7 | Email and link tracking | N (out of scope) | fragment-key invites with warning | Low in-product |
| F8 | Password databases, stuffing | S (no passwords) | key-based sign-in; recovery phrase | Med (seed loss/theft) |
| F9 | Big-provider sign-in | S (no IdP) | ledger sign-in without IdP | Med |
| F10 | Age verification, digital ID | N | later attestation slot; never ID in ledger | High (legal) |
| F11 | AI scraping | N | ciphertext for private records | High (public posts) |
| F12 | CDN/DNS/cloud centralisation | M (cache, peers) | replaceable defaults | Med |
| F13 | ISP and metadata | N | relay option, host-only | High |
| F14 | Lock-in, deplatforming | M | one seed, per-site keys, export | Med |
| F15 | Economics | N | none | High (structural) |
| F16 | Swarm surveillance | N (stated) | six mitigations above, none anonymising | High |
| F17 | Ledger permanence | consistent today | conflict to resolve | High |

---

## 5. What this means for magnet-web

Today and upgrade are in each finding and the matrix above. What the technology cannot do:



### Cannot (state plainly in the docs)
- Hide IP addresses from peers, trackers and STUN once the visitor joins a swarm; a relay only moves who sees them.
- Make a visitor anonymous: with sign-in, an observer can link an IP address to a key inside a swarm.
- Delete every copy of a public or encrypted ledger record.
- Recover a lost seed.
- Verify age or satisfy a legal duty to identify visitors.
- Stop an owner from adding trackers, or a script on the same origin from using an unlocked key (w2c-03 VERIFY claim 1).
- Remove the host, DNS and TLS from the first-visit trust path (SECURITY-MODEL.md).
- Work inside Tor Browser or Safari Lockdown Mode for swarm features (docs/research/03-webrtc-nat-privacy.md).
- Change the advertising economics.

---

## 6. Recommendations

Effort: S = a day or less, M = days, L = weeks.

| Pri | Recommendation | Effort | Why / source |
|---|---|---|---|
| P0 | Resolve the F17 conflict before any v0.3 write-up: PRIVACY.md and WHY.md forbid personal data in the ledger even encrypted, v0.3 plans encrypted auth and profile records there. Choose option (a), (b) or (c), and update both documents together | S to decide, M to implement | PRIVACY.md Impact assessments; EDPB 02/2025 (secondary) |
| P0 | Put a "what peers, relays, trackers and STUN can see" table in the sign-in and chat UI, shown before the first message, and add the statement "signing in links your IP address to your key for peers" | S | F16, SECURITY-MODEL.md |
| P0 | Make sign-in and presence require a separate opt-in after "Share and load"; guest reading never sends a key | M | F16, F5 |
| P0 | Hard rule in the docs and the SDK: no identity document, face image, date of birth, email or phone number in the ledger or in a file torrent by default; the example site never asks | S | F3, F10 |
| P1 | Consent-card equal-prominence rule with an automated test (same size, same layer, no pre-selection; host-only path no longer than share path) | S | F5 |
| P1 | Seed-derived per-site keys with export and recovery phrase as the primary identity (w2c-03 section 4.2); record the algorithm tag with every encrypted record | M | F6, F8, F11; w2c-03 |
| P1 | Relay (TURN) option, owner-configured, named in the consent card, with the trade-off text; off by default | M | F13, F16; 03-webrtc-nat-privacy.md D |
| P1 | Read-without-announcing: HTTPS snapshot path that fetches the ledger without joining the swarm | M | F16 |
| P1 | Build-time third-party audit for built sites and a "no third-party origins" profile | M | F1, F4 |
| P1 | A plain-language limits page: IP exposure, scraping, no deletion, no recovery, no age verification, no Tor | S | Sections 5 and F10, F11, F13 |
| P2 | Keep tracker, STUN and DoH defaults overridable by meta tag, and document a no-big-provider profile | S | F12 |
| P2 | Reserve a record type for a future third-party age or identity attestation (a yes/no, not a document) without building it | S | F10 |
| P3 | Plan the encryption migration to post-quantum key agreement before enabling long-lived private chat history | L | F11; NIST IR 8547 (draft, secondary) |

---

## 7. Open questions

1. Which option for F17 does the owner want: nothing personal in the ledger, an encrypted record that is declared as personal data, or a referenced torrent? Counsel should read the EDPB text (only summaries were available here) and say whether a replicated signed log falls under those guidelines.
2. Does the owner accept that sign-in makes an IP-to-key link visible to swarm peers, or should sign-in be impossible without the relay option for any site flagged sensitive?
3. Should "Load from host only" remain the visitor's default for sites aimed at children or in jurisdictions with age laws (PRIVACY.md says 0.2.1 has no owner setting that forces it)?
4. How far should the loader isolate the decrypted-record unlock from site scripts (a separate origin, or a sandbox that the Service Worker cannot enforce, per w2c-03 F1 and 04 F11)? Without it, the "owner-only-decryptable" claim holds against other visitors and scrapers but not against a malicious site script.
5. Re-fetch primaries before publication: ITRC PDF, Verizon DBIR PDF, EDPB final text, CalPrivacy registry, Litmus.
6. Gaps: no 2024-2026 source found for email-pixel prevalence, a dark-pattern audit, third-party login tracking, or WebRTC-swarm fingerprinting; IBM and Verizon 2026 figures were not read from the full reports.

