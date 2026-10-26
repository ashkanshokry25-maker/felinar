# R4: Why, and how to say it (positioning research for v0.3)

- **Topic:** why-and-positioning. **Date:** 2026-10-20. **Target:** magnet-web 0.2.1 going to 0.3.
- **Method:** the repo's own documents were read by heading (README, WHY, CRITIQUE, PRIVACY, ROADMAP, INTEGRATION-STATUS, w1-07 prior art, w2c-03 identity). External facts were fetched or searched on 2026-10-20 and each carries a URL and that access date. Where I only saw a search summary and not the primary page, the finding says so. No browser was launched.
- **Marks used:** `[X]` after a sentence means the sentence would break a wording rule (say 'no backend', 'site ledger', no 'censorship-resistant', 'unstoppable', 'fully decentralized', 'sub-second', 'production-ready', no 'serverless', no 'blockchain' for our ledger). `[TRUE-IF]` means true only after something ships. `[MODEL]` is a model output, not a measurement.
- **Limits:** no field data exists. The release gate on real phones has not run (`docs/DEMO-RESULTS.md`, rows G1 to G20 "not yet run"). Urbit and Nostr/Bluesky user numbers come from search summaries, not primary dashboards.

---

## 1. Summary (10 bullets)

1. **The strongest true case is narrow.** magnet-web is for a static site that needs a little shared state and wants to keep its readers' data out of third parties' hands, with no application server or database to run. It is not a cheaper way to host a small site and not a way to hide. (WHY.md, "The short version"; CRITIQUE.md, "What would make it fail".)
2. **The job to be done is "I want comments, a guestbook or a poll, and I do not want to run or rent a backend, or hand my readers to a vendor."** The seven audiences in section 3 fit that job in different degrees. Communities with small public boards, event pages, educators on one network and mirrors fit best; independent publishers fit if they accept public, moderated entries.
3. **The economic case is real but is not "cheaper bandwidth".** Static egress is already free or near-free on several hosts (R2 egress is free; GitHub Pages has a 100 GB soft monthly limit). The savings that exist are the backend you do not run, the vendor tier you do not buy, and the breach surface you do not hold. Peer offload is about 0% for a site under 16 MiB `[MODEL]`.
4. **Breach liability is the most defensible economic argument, with a caveat.** IBM's 2026 report gives a global average breach cost of US$4.99 million; that is an average over breached organisations, not a cost a small site would face. The honest form is "data you never collect cannot be breached from your server", and it stops at the ledger, which is public and in every visitor's browser.
5. **The emotional and political case is ownership, stated without drama.** Your domain, your owner key and your readers' data stay with you; there are no accounts to leak because identity is a key in the visitor's browser; the one thing that can take the site down is the host (and DNS), because the host is the trust root. The words "nothing to deplatform except the host" are true; "cannot be taken down" is not.
6. **History says: install friction, availability and stickiness kill these projects, not cryptography.** Beaker (archived 2022-12-27), ZeroNet (creator silent after 2019), Maelstrom, Brave's `ipfs://` (removed 2024-08-22, under 0.1% use), IPFS gateways (free ones ended 2026-09-21). The recurring lesson: lead with a benefit that needs no peers, keep the host in the loop, keep the install to one script tag.
7. **Most pitches over-promised the internet; the survivors promised one job.** Bluesky has about 46 million registered accounts (August 2026, secondary sources) yet falling app activity; Solid has had low retention; Nostr counts vary by metric by an order of magnitude. Do not cite user counts as proof of the idea in either direction.
8. **The counter-arguments are mostly correct, and the docs should concede them first.** IP exposure, durability without peers, mobile limits, trackers and STUN as third parties, no search in shell mode, hub isolation, and "the ledger is not a database" are all in CRITIQUE.md. Section 6 gives short honest answers.
9. **Measurable claims available today are few and local.** 938 of 938 unit tests, 25 of 25 end-to-end scenarios in Chromium and 26 of 26 in WebKit, all over loopback on one machine; cold start 162 ms and cached render 118 ms on loopback (INTEGRATION-STATUS.md). None of these is a field number. `[X]` if written as "fast" without "over loopback".
10. **Proposed fix:** rewrite the README top and WHY.md around one sentence, one table of "you get / you give up", and one section called "Who should not use this". The identity, chat and file-sharing work of v0.3 should be positioned as the same job extended (members, not just readers), with its IP-exposure limits stated before the features, never after.

---

## 2. Findings

### F1. What the repo already says, and where it is already honest

**Claim.** The existing WHY.md and CRITIQUE.md already contain nearly every concession a sceptic would raise; the weakness is ordering and tone, not honesty.
**Evidence.** WHY.md leads with "What you get is resilience and independence ... What you don't get is a smaller bill for a small site, privacy from other visitors, or a guarantee that anything stays online when nobody is." CRITIQUE.md lists 14 weak areas (durability without a pin node, mobile seeding, tracker dependence, swarm sizes, ledger as a database, proof-of-work as a fee, host as trust root, crawlers, owner complexity, drop-in cost, privacy friction, legal exposure, maturity). README "What it is not" has twelve statements.
**Source.** `README.md` (top, "What it is not"); `docs/WHY.md` "The short version", "The trade-offs"; `docs/CRITIQUE.md` headings, 2026-10-20 read.
**Gap.** README.md's "Why" table opens with "Hosting that costs next to nothing", which WHY.md itself undercuts for small sites ("A cheaper bill for a small site" is listed under "When not to use it"). A reader who stops at the README's first row gets the wrong idea. `[X]` if that row is kept as the lead.

### F2. Who benefits most: ranked by fit to the job, with the condition each needs

The job: "keep my site static, add light shared state or resilience, and not rent or run a backend." Fit is judged against what the code does now (0.2.1: ledger, `mw.db`, drop-in and shell modes, consent gate, web seed).

| Audience | Job they hire it for | Fit | Condition that must hold | Where it breaks |
|---|---|---|---|---|
| Communities with comments, guestbooks, polls | public board with no database, moderated by owner keys | High | open writing is acceptable to be public; owner will moderate | spam on open ledgers; a poll counts keys, not people (WHY.md use-case table); late posts reach only visitors who overlap unless a pin node runs |
| Event pages that spike | large files (programme, slides, handouts) passed between many simultaneous visitors | High for big files only | 20 MiB or more of payload; many visitors online at once `[MODEL]` 47% offload at 128 MiB with 10 eligible seeders | small pages come from the web seed anyway; the host still serves every loader |
| Educators and classes on one network | same material opened by a class at once; revisits work offline | Medium to high | laptops that chose to share; same LAN helps connectivity | phones are download-only until opt-in; the loader still comes from the host |
| Archives and mirrors | same files under the same name give the same infohash; every copy verified | Medium | someone keeps a copy online (web seed or pin node) | updates and withdrawal stay with the owner key; no availability when nobody holds it |
| Independent publishers | resilient copy for returning readers, comments without a vendor | Medium | drop-in mode for anything that must be indexed | shell mode hides content from crawlers; the bill barely changes |
| Small apps with light shared state | boards, polls, display names, `_` keys for owner settings | Medium | public data only; 20 writes a minute per page, 2 KiB values, 8 MiB ledger by default | not a database: no private data, no transactions, no finality |
| People who want readers' data out of third-party hands | no analytics, no third-party scripts, no connection to peers, trackers, STUN or DoH before the visitor's choice | High, with a stated limit | the owner adds no third-party embeds of their own | once a visitor shares, peers, trackers and STUN see an IP address and the site; "Load from host only" removes that |

**Source.** `docs/WHY.md` "Use cases" and "What this means for you"; offload figure from `docs/WHY.md` "Where the bytes come from" (IMPROVEMENTS-DIGEST table 9.3).
**What this says about the pitch.** The two audiences with the clearest pull (communities and event pages) have opposite relationships to peers: communities want the ledger and no peers at scale; events want peers at scale. A single headline cannot name both mechanisms. Lead with the job, then show the two mechanisms.

### F3. Economic case: hosting and egress price lists (accessed 2026-10-20)

| Item | Price or limit | Source (accessed 2026-10-20) |
|---|---|---|
| Cloudflare R2 egress | "does not incur data transfer (egress) charges and is free" over the Workers API, S3 API or r2.dev; storage US$0.015 per GB-month; Class A US$4.50 per million; Class B US$0.36 per million; free tier 10 GB-months, 1 M Class A, 10 M Class B | https://developers.cloudflare.com/r2/pricing/ |
| GitHub Pages | published site no larger than 1 GB; "soft bandwidth limit of 100 GB per month"; soft limit of 10 builds per hour; not allowed "as a free web-hosting service to run your online business" | https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits |
| Netlify | bandwidth metered in credits, 20 credits per GB; Free plan 300-credit limit; Personal 1,000 credits per month; about US$0.13 per GB at the Pro credit-pack rate (the page gave no per-GB overage price for Free or Personal) | https://www.netlify.com/pricing/ |
| Supabase (the nearest "backend in a box" for a guestbook) | Free: 500 MB database, 5 GB egress, 50,000 auth MAU. Pro from US$25 per month: 8 GB disk, 250 GB egress then US$0.09 per GB, 100,000 MAU then US$0.00325 per MAU | https://supabase.com/pricing |
| CloudFront list price (from the repo) | US$0.085 per GB for the first 10 TB in the US and EU, price list of 2026-10-03 | `docs/WHY.md` "Bandwidth bills scale with success", citing `docs/research/w2c-07-incentives-economics.md` summary 4 (not re-fetched here) |

**What this means.**
- A guestbook on Supabase Free costs US$0 until 5 GB of egress or 500 MB of data, then US$25 per month for Pro. So the money argument against "a vendor for light shared state" is: US$0 to US$25 per month plus a login, a schema and a dependency. For a hobby site that is not a strong money case. It is a strong independence case.
- Free-tier static hosts already carry the traffic of small sites. The money argument for magnet-web exists only where egress is metered and the site is large with long visits (section 4), or where a paid backend would otherwise be added.
- GitHub Pages' "not allowed ... to run your online business" clause matters: a commercial site cannot rely on Pages as the host, which narrows the "free host" story to non-commercial sites or to R2 and similar.
- Honest sentence: "For a site under 16 MiB, expect to save the backend, not the bandwidth." `[MODEL]` for the offload figure.

### F4. Economic case: breach cost reports (accessed 2026-10-20)

- IBM, Cost of a Data Breach Report 2026: global average US$4.99 million, described as "a 12% increase over last year and a record high", "driven by higher detection, escalation and lost business costs". The page did not show the US average or the lost-business share. Source: https://www.ibm.com/reports/data-breach (fetched 2026-10-20).
- IBM 2025 edition: global average US$4.44 million, US average US$10.22 million, healthcare US$7.42 million. Seen only in secondary coverage (https://cyberscoop.com/ibm-cost-data-breach-2025/ , search summary 2026-10-20); the primary was not opened. The 2026 and 2025 numbers disagree in direction with the 2025 "down 9%" finding, which is why a single year should not be quoted as a trend.
- Verizon 2025 DBIR: third-party involvement in breaches doubled to 30%; credential abuse the top initial vector at 22%, vulnerability exploitation 20%; 12,195 confirmed breaches analysed. Secondary coverage of the press release (https://verizon.com/about/news/2025-data-breach-investigations-report ; https://www.helpnetsecurity.com/2025/04/23/verizon-2025-data-breach-investigations-report-dbir/ , search summaries 2026-10-20); the full report was not opened.
- Munich Regional Court, 2022-01-20, case 3 O 17493/20: a site that loaded Google Fonts from Google's servers disclosed visitors' dynamic IP addresses without consent; the court awarded the plaintiff EUR 100 under GDPR Art. 82 and ordered the operator to stop. That is damages to one claimant, not a regulatory fine. Source: https://thehackernews.com/2022/01/german-court-rules-websites-embedding.html and https://www.activemind.legal/guides/ruling-google-fonts/ (search summaries 2026-10-20). Older than 2024; flagged. Note the cost: **magnet-web after "Share and load" discloses a visitor's IP address to trackers, STUN servers and peers.** That is the same class of disclosure and is why the consent card exists.

**What this means.** The breach argument is true as a reduction of surface: there is no accounts table, no password hashes, no email list on the owner's server, because identity is a key the visitor holds and the ledger is public by design. It does not say "no breach risk": the host, the owner key and the DNS record remain targets, and the ledger leaks whatever visitors write. The honest line is "less to lose", not "nothing to lose".

### F5. The emotional and political case, stated honestly

What can be said truthfully, each tied to code or design that exists in 0.2.1:

1. **Your domain.** The site is named by its infohash but served at the owner's own origin; the pointer is signed by the owner key and carries a sequence number that never goes back and an expiry (README "Why"; WHY.md "The idea"). Visitors remember the key on first visit and refuse a different one unless they confirm.
2. **Your key.** The owner key never enters a browser (README "Why" row 3). Losing it is a real risk; there is a hand-over and `--prev-key` path (INTEGRATION-STATUS code-review notes).
3. **Your readers' data.** No analytics, no third-party scripts, no connection before the visitor's choice (PRIVACY.md "In short"). The first-run card names the DoH service. This is the strongest honest privacy claim and it is about **who receives what**, not about anonymity.
4. **No accounts to leak.** True for the host: the host holds no user table. False if read as "no identity data exists": visitors' public keys and names are in the public ledger, and in v0.3 identity records are meant to be per-visitor encrypted (other R-documents).
5. **Nothing to deplatform except the host.** True in the narrow sense that no vendor holds the site's shared data. The host, the DNS registrar, the tracker operators and the browser's Service Worker rules are all points of failure; the kill switch exists for the owner's use (INTEGRATION-STATUS I2-M2). A hostile host can serve anything. `[X]` for "cannot be taken down", "free from platforms", "unstoppable".

The tone that works for this audience (and survives scrutiny) is the one in the Beaker post-mortem and the CRITIQUE: say what it does, name the dependency, show the off switch. Prior art evidence for the tone: Beaker's author wrote that the product "didn't solve a problem for people" and that its value proposition was "pretty dubious" by 2016 (`docs/research/w1-07-prior-art.md` F5, quoting the 2022-12-27 archive notice).

### F6. "Future of the internet" pitches: what happened, what to learn

Dates and figures are from the repo's prior-art research unless a URL is given.

| Pitch | What happened | Lesson for how to talk | Lesson for what to build |
|---|---|---|---|
| **Beaker / Dat / Hypercore** | Archived 2022-12-27; "no stickiness", "bad time-to-first-paint and variable uptime"; "the only demographic that Beaker actually helped was teachers on a LAN" (w1-07 F5) | Do not call a static-site tool a new web. Name the one job. | First paint from the host. Reasons to return. The LAN-classroom case is a real niche and is in our use-case table. |
| **ZeroNet** | Original frozen 2019-09-06; creator silent after 2019; six sandbox/wrapper/XSS fixes 2016 to 2019; "no reliable spam protection"; forks with one maintainer (w1-07 F1 to F3) | Do not promise "visitors host everything". Bound what visitors carry and say so. | One origin per site; no central identity issuer; hosting limited to the site viewed after consent. |
| **IPFS** | Brave removed `ipfs://` 2024-08-22 ("less than 0.1% of users"); public gateways served 614 million requests a day, of which 9.4% browsers loading pages and 67.4% scripts using a free CDN; `ipfs.io` and `dweb.link` stopped fetching for visitors on 2026-09-21 (WHY.md; w1-07 summary 1) | "Decentralized storage" invites the question "who pays for pins". Answer it before it is asked. | The owner's host is the floor. No dependence on someone else's free gateway. |
| **Nostr** | Counts depend on the metric: about 144,202 daily active pubkeys over a two-week window ending December 2025; 4.96 million publishing users in one week (August 2026, down 22.4%); another analysis 3,675 daily active (October 2025). None is a clean 2026 daily figure. Sources: https://glukhov.org/post/2025/10/nostr-overview-and-statistics/ ; Nostr weekly recap 2026-08-03 via https://nostr.ae (search summaries 2026-10-20) | Never quote a user count without naming the metric. | The nsite draft (NIP-5A) still needs a server gateway (w1-07 table), the pre-Service-Worker IPFS shape. We already have the client-verifying part. |
| **Bluesky / atproto** | About 46 million registered accounts by August 2026; mobile app 10.4 million MAU (Similarweb, June 2026), down 27.2% year on year. Sources: https://gigazine.net/gsc_news/en/20260812-blueskys-active-user/ , https://proxidize.com/blog/bluesky-user-count-2026/ (search summaries 2026-10-20; secondary). Beaker's author joined it, saying it keeps "account portability while retaining the performance and reliability advantages of servers" (w1-07 F5) | Registered is not active. The winners kept servers where servers help. | Same stance as ours: the host first, portability second. |
| **Solid / Inrupt** | Founded 2018; Enterprise Solid Server 2020; early adopters named as the BBC, NatWest and NHS; a 2024 W3C mailing-list post by a former large pod operator reports 50k to 100k signups, retention low, fewer than 100 daily actives. Source: https://lists.w3.org/Archives/Public/public-swicg/2024Oct/0028.html and https://www.computing.co.uk/news/4022941/ (search summary 2026-10-20; the mailing-list claim is one person's report, low confidence) | "You own your data" with no user-visible reason to switch has weak retention. | Tie ownership to a visible, immediate benefit (own identity, no login form). |
| **Urbit** | Not researched this session (the search returned nothing). **UNVERIFIED.** Do not cite. | n/a | n/a |
| **Web3 broadly** | The repo records that Fleek and Skynet were the top two services in Web3 credential-phishing URLs in 2022 and that Shipyard-run IPFS gateways were 84% of Netcraft's IPFS-fronted phishing in 2026 (w1-07 summary 3d). | Do not use the word at all; the audience has learned to read it as risk. The owner uses "blockchain" loosely; the docs must not. | Own the abuse path (`ct=` contact, withdrawal) before any public hub. |

**What this says.** Every failure above shares three causes: (a) the visitor had to install or understand something, (b) availability was someone else's business, (c) the pitch was about the future and the product was about the protocol. magnet-web's design answers (a) (one script tag, no install) and (b) (the web seed on the owner's own host). It must answer (c) in the words.

### F7. The three honest "unique" things, to the extent they are unique

Not exhaustive (other R-documents cover differentiators). From the positioning side, these are the ones that survive the prior-art table:
1. A static site served at its **own origin and unchanged URLs** with in-browser verification and a consent gate, with a web seed so it loads when nobody is online (README "What magnet-web adds" in WHY.md "Prior art").
2. **Drop-in mode** that fails open to the owner's pages (INTEGRATION-STATUS scenario 10: JS-off output identical on six URLs; kill switch tested in scenario 9).
3. A **signed, moderated, ordered log per site** with a fee per entry, accessed through `mw.db`, with no server of the owner's.
None of these is "decentralized" in a sense the docs can use. The mechanism is replication with verification.

---

## 3. What this means for magnet-web (today, upgrade, cannot)

### 3.1 Today (0.2.1, true of the code)

- Say: a static site, with an optional ledger for shared data, verified in the browser, served from the owner's host and, after consent, by other visitors.
- Say: no analytics, no third-party scripts, nothing connects to peers, trackers, STUN or DoH before the visitor chooses.
- Say: the host is the trust root and the only thing that has to stay online.
- Say: tested over loopback in Chromium and WebKit; real phones and browsers not yet tested.
- Do not say: anything about saving money for small sites, anything about phones working well, anything about search, anything about "private".

### 3.2 Upgrade (v0.3, only `[TRUE-IF]` it ships)

- **Self-owned identity:** "a visitor's identity is a key in their browser with a recovery phrase". `[TRUE-IF]` recovery phrase and export/import ship and are tested on iOS. Today export and import exist in Settings (task brief), but Safari can delete storage after 7 days without a visit unless the site is on the Home Screen (WHY.md; w2c-03 F2).
- **Sign-in without a backend:** "the site recognises the visitor by a signed record in the site ledger; there is no password and no account table". `[TRUE-IF]` the login and logout flow in the example site passes a browser test.
- **Own-record privacy:** "only the visitor can decrypt their auth and profile record". `[TRUE-IF]` the key-wrapping design is reviewed; the ledger still shows that a record exists, its size and when it changed (metadata).
- **Chat and files:** "end-to-end encrypted between identities". `[TRUE-IF]` implemented. Always paired with the same sentence: "peers and relays still see IP addresses; trackers and STUN servers see swarm membership; mitigations are a relay option, host-only mode and mobile defaults".

### 3.3 Cannot (state plainly)

- Cannot hide a visitor's IP address from peers, trackers or STUN servers once they share (PRIVACY.md "In short"; arXiv 2510.16168 reports that mDNS hides only local addresses and that Chrome on mobile can disclose LAN or CGNAT addresses; https://arxiv.org/pdf/2510.16168.pdf, search summary 2026-10-20).
- Cannot keep data available when nobody has a copy.
- Cannot erase an entry from devices that never sync again.
- Cannot act as a database: no private data, no transactions, no finality.
- Cannot be indexed in shell mode.
- Cannot protect visitors from a malicious or compromised owner host.
- Cannot make "the whole internet" private. It can make this one site's relationship with its readers smaller and more visible.

---

## 4. The counter-arguments, and honest answers

Each answer is short on purpose and should appear in the docs in this form.

| # | Counter-argument | Honest answer | Where it already lives |
|---|---|---|---|
| 1 | "Peers see my IP address." | Yes, after you choose "Share and load". Trackers and STUN servers also see your IP and that you are on this site. "Load from host only" avoids all three. A relay option is a v0.3 mitigation `[TRUE-IF]`. There is no private mode and none is claimed. | PRIVACY.md; WHY.md "IP addresses are visible" |
| 2 | "If nobody is online it dies." | The site still loads from the owner's host (the web seed). The ledger's recent posts need someone with a copy; a pin node and a snapshot (`cs=`) are the durable floor. Visitors are not an availability plan. | WHY.md "Will my site have peers?" |
| 3 | "Phones can't help." | Correct. They download and sync while the page is on screen; they upload nothing until the visitor opts in; iOS suspends peers within seconds. | WHY.md "Phones are mostly downloaders" |
| 4 | "Trackers and STUN are third parties." | Yes. The default list is four public trackers, all on at least one DNS block list, and two STUN servers. Owners should run their own tracker. Visitors never touch them before consent. | WHY.md "Third parties carry the introductions" |
| 5 | "There is no search." | In shell mode, crawlers see the loader. Use drop-in for anything that must be indexed. | WHY.md "Search engines and shell mode" |
| 6 | "Hub isolation: a shared origin is unsafe." | Agreed: ZeroNet's six wrapper fixes show it. Production sites use their own origin; the shared-origin hub is a dev and demo convenience until a subdomain hub is operated. | CRITIQUE; w1-07 F2; ROADMAP "hub subdomain" |
| 7 | "The ledger is not a database." | Agreed. It is a signed, ordered, public log: good for a guestbook, comments, a poll with one entry per author, settings in `_` keys. Not for private, relational or transactional data. 20 writes a minute per page, 2 KiB values, 8 MiB ledger by default. | WHY.md use cases; CRUD.md |
| 8 | "So why not a normal backend?" | Often you should. This is for the case where the backend would be bigger than the job. Section 5 gives the test. | New (section 7 proposes the text) |
| 9 | "Proof-of-work is theatre." | It is a fee that slows a flood, not a defence. Writer policy, allow lists and moderators are the real tools. | README "Why not a blockchain?"; WHY.md "Open writing" |
| 10 | "Chat and files over WebRTC leak who talks to whom." | Content is encrypted between identities `[TRUE-IF]`. Peers still see that your IP is connected to theirs, and when. Presence is metadata. Group membership is visible to members. | v0.3 design documents (not this file) |

---

## 5. A test an owner can run in two minutes: "should I use this?"

1. Is the site static, or can it be? If no, stop.
2. Does it need shared data? If no, the gain is resilience only; fine, but do not expect savings.
3. Is the shared data public? If it must be private, stop (or wait for the v0.3 per-visitor records and read their limits).
4. Is your payload over 20 MiB with many visitors at once? If yes, peers may carry a real share `[MODEL]`. If no, the host carries it.
5. Are you willing to moderate what visitors redistribute? If no, use `closed` writing or no ledger.
6. Do you need search indexing? Use drop-in.
7. Can you accept that phones mostly download and that there is no finality?

If all seven hold, the fit is good. If 1 or 3 fail, use a normal backend.

---

## 6. Measurable claims the current test results allow

From `docs/INTEGRATION-STATUS.md` (post-wave, 2026-10-20 00:40 ET, Round 3 at 06:55 ET). All numbers are from one development machine over loopback; the release gate on real devices has not run.

| Claim you can make | Number | Source line | Wording that stays true |
|---|---|---|---|
| Unit tests | 938 of 938 pass, about 8 s | INTEGRATION-STATUS "Round 3" and "npm test" | "938 unit tests pass" |
| End-to-end, Chromium | 25 of 25 scenarios pass in 127.5 s; network policy passes (no request left 127.0.0.1) | "npm run test:e2e" | "25 end-to-end scenarios pass in local Chromium" |
| End-to-end, WebKit 27.2 | 26 of 26 and network policy pass in 129.5 s | "npm run test:e2e:webkit" | "26 in Playwright WebKit" |
| Browser unit tests | 31 pass, 1 skipped | "npm run test:browser" | include the skip |
| Example site | 29 pass | "npm run test:example" | |
| Cold start (nobody online, loopback) | 162 ms | code review round 1 summary (timing targets) | "162 ms over loopback" `[X]` if said without "over loopback" |
| Cached render | 118 ms | same | same |
| Peer drop recovery | PEER-11 drop 66 ms; PEER-BLIP re-announce 1.3 s | same | "over loopback" |
| Consent gate | 0 tracker announces and 0 WebSockets before consent; 0 RTCPeerConnections while the hub gate is open | scenarios 10B and 8 | "in the test harness, nothing connected before the choice" |
| JS off | output identical to the plain host on 6 URLs (status, headers, text, redirects, screenshot bytes) | scenario 10 | "in the drop-in fixture" |
| Kill switch | reloads only pages an earlier worker controlled; about 3 s after next navigation in Chromium | scenario 9; CRITIQUE open questions | "in Chromium" |
| Loader size | `loader.js` about 117 KB gzip, `webtorrent.min.js` about 64 KB gzip; `mw.js` about 105 KB gzip | WHY.md "The loader costs bytes" | "on the 0.2.1 build, measured with gzip -9" |
| Offload | 0% under 16 MiB; 47% at 128 MiB with 10 eligible seeders `[MODEL]` | WHY.md tables | always labelled model |

What the numbers do **not** license: any statement about real networks, phones, Firefox, Safari on iOS, Brave or Edge; any speed comparison with other hosting; any "fast" or "instant" claim; "sub-second" `[X]`.

---

## 7. Proposed structure for the rewritten WHY and README top, with concrete sentences

Sentences marked `[X]` are the tempting versions that break a rule; the unmarked one under each is the replacement.

### 7.1 README top (above the fold)

Title line:
- `[X]` "The serverless, unstoppable web, loaded by magnet link."
- "Websites loaded by magnet link, verified in the browser, from a plain static host. No backend."

Second paragraph (the job):
- `[X]` "A fully decentralized website platform with a blockchain for your data."
- "Keep your site a folder of static files. Add a guestbook, comments or a poll without a database or a vendor: the visitors' browsers keep and check a signed log called the site ledger. Large files can pass between visitors who choose to share."

Third paragraph (the price, immediately):
- "What it costs: your HTTPS host stays in the loop and is the trust root. Once a visitor chooses to share, peers and the connection servers see their IP address and that they are on your site. Everything in the ledger is public."

Fourth (status, honest):
- `[X]` "Production-ready and fast."
- "Status: 0.2.1, pre-release. 938 unit tests and 25 end-to-end scenarios pass on one machine over loopback; the release gate on real phones and browsers has not run."

### 7.2 "Is this for you?" table (replaces the first "Why" table row)

| You want | Use magnet-web? | Because |
|---|---|---|
| Comments or a guestbook on a static site, public, moderated by you | Yes | the site ledger replaces the database; you hold the moderator key |
| Large files for a crowd online at the same time | Yes, for 20 MiB or more | peers can carry a real share `[MODEL]` |
| A cheaper bill for a small site | No | the web seed carries nearly all of it |
| Private data, accounts, payments | No | everything in the ledger is public (v0.3 per-visitor records are the exception and have their own limits) |
| Anonymity | No | peers, trackers and STUN servers see IP addresses |
| Search indexing | Use drop-in mode | shell mode shows crawlers the loader |

### 7.3 WHY.md outline (replace the current order)

1. **The job** (one paragraph): "light shared state and a resilient copy, without running or renting a backend".
2. **Who it is for** (the seven-row table from F2, shortened to three columns).
3. **What you get and what you give up** (a two-column table; every benefit row has its condition in the same row, as WHY.md does now).
4. **Your data, your readers' data** (the F5 list: domain, key, readers' data, no account table; with the metadata caveats).
5. **The money, honestly** (F3 and F4 in four sentences: backend and vendor savings are real; bandwidth savings are for large sites with simultaneous visitors `[MODEL]`; breach surface is smaller, not zero).
6. **What went wrong for others, and what we did about it** (the F6 table cut to five rows: Beaker, ZeroNet, IPFS gateways, Nostr gateways, PeerTube).
7. **When not to use it** (move up from near the bottom; make it the section most people read).
8. **The proof so far** (section 6 of this file, with "over loopback" in the heading).
9. **v0.3: members, not just readers** (identity, sign-in, chat, files; each feature followed by its exposure statement in the same paragraph).

### 7.4 Concrete sentences for the sections that are hardest to write

- On privacy: "magnet-web reduces who receives your readers' data. It does not make them anonymous. Before a visitor chooses, the browser contacts only the hosts you chose. After, trackers and STUN servers see their IP address and which site they joined, and other visitors see it too. 'Load from host only' removes all three."
- On money: "If your site is under about 16 MiB, peers will not lower your bandwidth bill, and your host may already charge nothing for it. What you save is the backend: the database, the login, the patching."
- On ownership: "The site is yours because the pointer is signed with your key and served from your domain. Anyone who controls your host or your DNS controls what visitors run. Keep the key offline."
- On chat and files (v0.3): "Messages and private files are encrypted between visitors' identities. The people you talk to still see your IP address, and the trackers see that you joined the site's swarm. If that matters, use host-only mode, which turns chat and file sharing off."
- On availability: "Your host is the floor. Peers are a bonus. A pin node is how you keep recent posts alive between visits."
- On history: "Earlier projects asked visitors to install a browser or a client, relied on someone else's free gateway, or promised a new web. This one asks for one script tag and keeps your host in the loop. Whether people will come back to such sites is not yet measured."

### 7.5 Wording-rule audit of existing text (as of 2026-10-20)

Found by grep in README.md and docs/WHY.md:
- `README.md` line 87: heading "Why not a blockchain?" uses the banned word. It is used to explain what the ledger is not, which is acceptable in meaning but a literal reading of the rule (the docs do not use the word) is broken. `[X]` Suggested heading: "Why not a global chain with mining?" or "Why the site ledger is not a currency chain".
- `README.md` line 240 and `docs/WHY.md` line 146 use "production-ready" in the sentence "nothing here is called production-ready until the gate passes". It is a negation, and still contains the word. `[X]` Suggested: "nothing here is called ready for production use until the release gate passes", or keep and add an explicit exemption in the rules file.
- No other occurrences of "serverless", "censorship-resistant", "unstoppable", "fully decentralized" or "sub-second" were found in those two files.
- README "Why" table first row: "Hosting that costs next to nothing." Not a banned word; contradicted by WHY.md for small sites. Replace per 7.1.

---

## 8. Recommendations (P0 to P3, effort S/M/L)

| Priority | Recommendation | Effort | Why |
|---|---|---|---|
| P0 | Rewrite README top per 7.1 and the "Is this for you?" table per 7.2; put "Who should not use this" above the fold | S | the first row currently promises what the economics section denies |
| P0 | State the IP exposure for chat and file sharing in the same paragraph as the feature, in every v0.3 document and in the UI copy; mirror it in PRIVACY.md's recipient register (add peers-as-chat-correspondents, relay if offered) | S | the owner asked for no gaps; privacy documents that trail the feature are how trust is lost |
| P0 | Fix the two literal wording-rule hits (README line 87 heading; "production-ready" in README line 240 and WHY.md line 146) or record the negation exemption in the docs-links test | S | the docs-links test already enforces section 4 wording rules; a consistent rule beats a case-by-case argument |
| P1 | Reorder WHY.md per 7.3; move "When not to use it" to section 7 and add the two-minute test (section 5) | M | readers who stop early should leave with the right idea |
| P1 | Run release-gate rows G1 to G11 on real devices and publish the results, failures included, before 0.3 is announced | L | every browser and phone sentence is currently unmeasured; Beaker's cold-start story is the reason this matters |
| P1 | Add a "Compared with Supabase/Firebase for a guestbook" paragraph with the F3 numbers and dates | S | the honest money case is against a vendor tier, not against a CDN |
| P2 | Add a short "History" page to docs from F6 (five rows, each with its date and source), and link it from WHY.md | S | pre-empts the "this was tried" objection on the owner's terms |
| P2 | Measure and publish consent rate, visit length and offload for the example site once hosted (ROADMAP "measured economics") | M | replaces every `[MODEL]` figure |
| P2 | Re-verify the IBM 2025 and Verizon figures against primary pages, and add Ponemon/IBM per-record cost only if a primary source is read | S | this file relied on secondary coverage for both |
| P3 | A one-page owner-facing "fit check" in the CLI (`magnet-web fit --size --visits --dwell`) that prints the section 5 test plus the swarm calculator result | M | turns the honest answer into a tool; fits ROADMAP "swarm calculator" item |
| P3 | Plain-language status page: what is measured, what is modelled, what is untested | S | the three-way split is the project's credibility |

---

## 9. Open questions

1. **Who is the first real owner?** The positioning rests on a job that nobody outside the project has yet confirmed. A small paid-for-nothing community (a classroom, an event) would test the "teachers on a LAN" niche that Beaker found.
2. **Will owners accept public-only shared data?** v0.3 per-visitor encrypted records change this partly; do owners and visitors read "encrypted record in a public log" as safe? Needs user research.
3. **Does the owner want to name the project's relationship to piracy?** The CRITIQUE already ties marketing to inducement risk (Cox v. Sony, PRODUCTION-DIGEST 5.3). Legal review of the final README is still owed (other R-documents cover legal).
4. **Is "site ledger" understood?** The owner uses "blockchain" loosely; test whether readers grasp "signed log copied by every visitor" without the word.
5. **What is the right threshold for "large"?** The model says peers matter from about 20 MiB with ten or more eligible seeders. Real consent rates may move this.
6. **Urbit, Solid and Nostr facts above are secondary or unverified.** Do not publish those rows until primary dashboards are read.
7. **Do GitHub Pages' commercial-use terms make the "free host" story false for businesses?** The cited clause says so; confirm per host before the QUICKSTART names one.

---

## 10. Sources (all accessed 2026-10-20 unless stated)

- https://developers.cloudflare.com/r2/pricing/ (fetched)
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits (fetched)
- https://www.netlify.com/pricing/ (fetched)
- https://supabase.com/pricing (fetched)
- https://www.ibm.com/reports/data-breach (fetched; 2026 report)
- https://cyberscoop.com/ibm-cost-data-breach-2025/ (search summary; 2025 report)
- https://verizon.com/about/news/2025-data-breach-investigations-report ; https://www.helpnetsecurity.com/2025/04/23/verizon-2025-data-breach-investigations-report-dbir/ (search summaries)
- https://thehackernews.com/2022/01/german-court-rules-websites-embedding.html ; https://www.activemind.legal/guides/ruling-google-fonts/ (search summaries; 2022)
- https://arxiv.org/pdf/2510.16168.pdf (search summary; WebRTC leak study, October 2025)
- https://gigazine.net/gsc_news/en/20260812-blueskys-active-user/ ; https://proxidize.com/blog/bluesky-user-count-2026/ (search summaries)
- https://glukhov.org/post/2025/10/nostr-overview-and-statistics/ (search summary); Nostr recaps via https://nostr.ae (search summary)
- https://lists.w3.org/Archives/Public/public-swicg/2024Oct/0028.html ; https://www.computing.co.uk/news/4022941/berners-lee-inrupt-releases-commercial-offering-privacy-preserving-enterprise-solid-server (search summary)
- Repo files read 2026-10-20: `README.md`, `docs/WHY.md`, `docs/CRITIQUE.md`, `docs/PRIVACY.md`, `docs/ROADMAP.md`, `docs/INTEGRATION-STATUS.md`, `docs/research/w1-07-prior-art.md`, `docs/research/w2c-03-identity-ux.md`.
