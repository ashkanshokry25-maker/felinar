# Judge: scale and economics (v0.3 design review)

- **Lens:** scale and economics. Attack the identity and realtime proposals against the demo the owner chose on 2026-10-20 (`examples/social`: hub mode, every person and every group is its own site with its own site ledger and swarm, a merged follow feed built in the browser, names through a hub directory or the member's own domain, "only the directory and the tracker grow with users").
- **Under review:** [IDENTITY-AUTH-DESIGN.md](IDENTITY-AUTH-DESIGN.md), [REALTIME-AND-FILES-DESIGN.md](REALTIME-AND-FILES-DESIGN.md). Goals: [DIFFERENTIATORS-AND-WHY.md](DIFFERENTIATORS-AND-WHY.md), [PRIVACY-UPGRADES.md](PRIVACY-UPGRADES.md).
- **Spec and code read:** ARCHITECTURE sections 3.2, 5.5, 6.1 to 6.7, 8; `src/loader/config.js`; `src/chain/block.js` limits; `src/loader/cache.js` `enforceBudget`.
- **Numbers come from:** ARCHITECTURE 6 and 8 and `config.js` (caps); research w1-08 (mobile memory, radio, lifecycle), w2b-01 (tracker capacity and egress, measured), w2c-07 (Little's law model, eligibility shares, NetSession), w2a-03 (block sizes, ingest rate, measured), w2c-02 VERIFY (verify rate in WebKit, measured), review/distributed-systems (phone verify estimate), w2c-04 and w2a-07 (prices). Anything else is arithmetic on those inputs and is labelled "model". Nothing here was measured on a network or a phone.
- **Wording:** "no backend", "site ledger". The proposals pass the wording rules (no banned words, no em dashes, straight quotes; checked by search).

## 1. Verdict

Neither proposal was written for the social demo. Both describe one site with its own visitors. The social model runs one site per person, so every per-site cost in the proposals gets multiplied by the number of people a member follows: swarms, tracker announces, wires, PoW fees, chat-key records, ledgers held in memory. And every per-site availability assumption gets divided by the audience of one person. Two problems stop the demo shipping as written. A browser cannot create a person's site, because the owner key never enters a browser (B2). A phone cannot follow 200 people with one swarm and one set of wires per person (B1). The rest are gaps that users will see: about 80 to 99% of a typical member's ledger and media is unreachable without a pin (model, section 2.4), offline delivery depends on opt-in holders who will in practice almost never exist, the tracker and the holders can rebuild the follow graph, and the cost model and the honest ceiling are missing. "Nothing central holds everyone's data" stops being true once a hub pins for durability, and the docs must say so.

## 2. The scaling model, computed

### 2.1 Caps that bind (sources)

| Cap | Value | Source |
|---|---|---|
| Ledger size | 8 MiB default, 64 MiB ceiling per ledger | ARCHITECTURE 6.1 `DEFAULT_POLICY`, `LIMITS`; `src/chain/block.js` lines 38, 47 |
| Block size | at most 4,096 B; a 200-character comment is 798 B with one parent and 1,267 B with more | ARCHITECTURE 6.1; w2a-03 summary 3 (measured) |
| Allow list, moderators | 1,000 and 50 | ARCHITECTURE 6.1 |
| Rendezvous wires per ledger swarm | 6/9 desktop, 3/5 mobile, **per swarm, with no cap across swarms** | ARCHITECTURE 8; `config.js` `policy.rendezvous` |
| Content wires | 30 desktop, 8 / 6 / 4 mobile classes | ARCHITECTURE 8 |
| Site storage budget | 512 MiB desktop, 128 MiB mobile, **sites only** (`enforceBudget` evicts by btih; ledgers are not counted) | `config.js` `limits`; `src/loader/cache.js` line 665 |
| Phone uploads | off until "Share on this network", then 128 KiB/s | ARCHITECTURE 8 |
| Public file | 25 MiB per file, 256 MiB per site | REALTIME 7 |
| iPhone tab memory | soft limit about 1.5 GB, killed without a JS exception | w1-08 F-16 (WebKit engineers, bugs 277848, 268816) |
| Hidden iOS page | loses the network about 5 to 20 s after hiding | w1-08 F-07 (inference from UIKit docs and WebKit source) |
| STUN consent checks | every 5 s per peer connection | RFC 7675, via w1-08 F-13 |
| Radio tail | each transfer keeps a typical radio active at least 18 s; three transfers a minute keep it on permanently | Android networking guide, via w1-08 F-13 |
| Ledger startup | "Startup loads all blocks" into memory | ARCHITECTURE 6.7 |

### 2.2 What a phone can follow and hold

- **Swarms and wires.** One ledger is one rendezvous swarm (ARCHITECTURE 5.5). Following 200 people live means 201 swarms. At the mobile per-swarm budget of 3 soft and 5 hard wires, that is 603 to 1,005 RTCPeerConnections, against a content budget of 4 to 8 for the whole tab. Each connection runs STUN consent checks every 5 s. A WebTorrent wire belongs to one infohash, so wires cannot be shared between ledgers. Chromium is reported to cap peer connections per page, at around 500 (not verified here; G-SC-2). **Ceiling under today's design: a phone can follow about 1 to 2 ledgers live at the mobile class budget.**
- **Bytes.** If every followed ledger stays at the 8 MiB default, 200 ledgers come to 1,600 MiB. At the 64 MiB ceiling they come to 12.5 GiB. Both are loaded whole at startup. 1,600 MiB is above the roughly 1.5 GB iPhone tab limit before any JS object overhead (not measured). Ledgers are outside the 128 MiB budget, so nothing evicts them.
- **Realistic fill (model).** Take 300 blocks per person (about a year at one post a day plus a few reactions) at about 1 KiB each. That is 300 KiB per ledger and 59 MiB for 200, which fits. At 1,000 blocks per person it is 195 MiB, which is already above the mobile site budget. At 5,000 blocks it is 977 MiB.
- **Media.** The 128 MiB mobile budget is the only cache, and it is shared with the site copies. It holds 5 files at the 25 MiB cap, so a phone cannot keep a follow feed's media offline.

### 2.3 First-open sync for a member who follows 200 people (model)

- **CPU.** Signature verification runs at 8.8k to 9.9k verifies/s in WebKit on an M3 (w2c-02 VERIFY, measured) and 6k to 12k blocks/s for the full ingest check in Node (w2a-03, measured). Phones are estimated at 1 to 3 ms per block (review/distributed-systems, not measured). For 60,000 blocks (200 ledgers × 300) that is about 7 s on an M3 and 60 to 180 s on a phone, halved at best by the pool of 2 verifier workers (`config.js` `verifierPoolSize`). For 200,000 blocks it is 200 to 600 s on a phone.
- **Network.** Every ledger needs its own tracker announce, an ICE exchange and SYNC from depth window 0. v1 has no tail sync: the `checkpoint` op is reserved and undefined, the orphan pool holds 2,000 blocks in total, and state needs each block's causal past (ARCHITECTURE 6.4, 6.5). The glare watchdog waits 20 s before it re-announces. Per-ledger connection setup on a real network is not measured. At 4 to 8 wires the 200 ledgers are synced one batch after another.
- **Availability decides it.** Section 2.4 shows that for a typical personal ledger, nobody who holds it is online at a given moment 80 to 98% of the time. In practice, then, first-open sync means 200 `cs=` snapshot fetches from the hub, or nothing. **No first-open time can be stated today. The proposals give none, set no target and name no test.** G-SC-1 below produces one.

### 2.4 Media and ledger durability when the author is offline (model)

The number of holders online is Poisson with mean (visits/day × mean dwell / 86,400) × eligible share. That is Little's law, checked by simulation in w2c-07 F25. Eligible shares come from the w2c-07 baseline: ledger gossip needs consent and a connection, 0.3 × 0.8 = 0.24; media seeding also needs the upload policy, 0.3 × 0.35 × 0.8 = 0.084. Here a "visit" is a follower's feed session that syncs the ledger, and dwell is how long that tab stays open. The calculator `docs/research/labs/w2c-07-lab/little-calc.mjs` reproduces the media column.

| Feed sessions per day touching this person | Mean open time | P(no ledger holder online) | P(no media seeder online) |
|---|---|---|---|
| 60 (e.g. 20 followers, 3 sessions each) | 120 s | 98% | 99% |
| 600 (200 followers × 3) | 120 s | 82% | 93% |
| 600 | 600 s | 37% | 71% |
| 2,000 | 120 s | 51% | 80% |
| 6,000 (2,000 followers × 3) | 120 s | 14% | 50% |
| 20,000 | 120 s | 0.1% | 10% |

- **Reading.** Follower counts follow a long tail, so most people's sites sit in the top two rows. For them, about 82 to 99% of reads of their wall, and 93 to 99% of reads of their media, find nobody to serve them unless there is a pin or a hub snapshot. Old media is worse, because only visitors who opened that item seed it. The author's phone counts only while the page is in the foreground (w1-08 F-07). REALTIME 6.5 says "available only while you keep this page open", which is true, but nobody has stated the fraction. The fraction is the number a member needs to know.

### 2.5 The directory: size and trust

- **As a site ledger.** One entry block is about 0.8 to 1.2 KB (w2a-03 sizes), so the 64 MiB ceiling holds about 56,000 to 84,000 names and the 8 MiB default about 7,000 to 10,000. `writers: 'allow'` stops at 1,000 members. `writers: 'open'` at 16 bits costs a squatter 65,536 hashes per name. At 3.2 to 3.7 million hashes/s (w1-11, measured on an M3), 1 million fake names take about 5 core-hours (arithmetic). Every hub visitor syncs the whole directory ledger.
- **As static files the hub builds.** At about 300 B per entry (model), 1 million members is about 300 MB, so it must be sharded by name hash. The build job runs on the hub operator's machine, so it is a hub component, and the docs should call it that.
- **Trust.** Whoever controls the directory can point a name at a different ledger. Per-site keys are unlinkable by design, so a follower cannot tell a substituted ledger from the real one. ROADMAP lists "a directory of sites on a hub" as "only after counsel has looked at it", and the demo now contradicts that.

### 2.6 Tracker load per hub (model on measured rates)

Each tab announces each swarm it is in every 120 s per tracker. The w2b-01 Linux load test measured 4,002 announces/s at 0.81 core and about 21 to 25 KiB of RSS per socket. Offers are 0.69 to 0.74 KB and answers about 0.5 KB (w2b-01, measured). The upper-bound egress column assumes 3 offers and 3 answers per swarm per announce, which is the policy before the P4 count-aware rule. P4 stops offers once a swarm is connected, which brings egress close to keepalives only.

| Concurrent members | Ledgers followed live | Announces/s | Tracker cores | Peer entries | Egress, upper bound |
|---|---|---|---|---|---|
| 1,000 | 200 | 1,675 | 0.34 | 201,000 | 6 MB/s, 15.6 TB/month |
| 10,000 | 50 | 4,250 | 0.86 | 510,000 | 15 MB/s, 40 TB/month |
| 10,000 | 200 | 16,750 | 3.4 | 2.0 M | 60 MB/s, 156 TB/month |
| 100,000 | 200 | 167,500 | 34 | 20 M | 603 MB/s, 1,563 TB/month |

For comparison, the largest public WebTorrent tracker reported 288,483 sockets and 890,101 peer entries at 2.78 GB RSS (w2b-01, operator figure). Oracle's free tier includes 10 TB of egress a month (w2b-01). Memory per peer entry is not measured.

### 2.7 Cost model

| Party | Item | Price (source) | Example (arithmetic) |
|---|---|---|---|
| Hub operator | shell and loader | about $2.40 per million cold visits on Workers Paid, about $21 on CloudFront pay-as-you-go (w2c-04 summary 11) | 10 M visits/month: about $24 to $210 |
| Hub operator | tracker | $0 (Oracle A1) to about $65/month at 20,000 sockets (w2b-01 table) | multiplied by follows (2.6); at 10,000 members × 200 swarms the upper bound needs 156 TB/month of egress |
| Hub operator | pins and snapshots for durability | R2 $0.015/GB-month, egress free, 10 GB-month free, Class B reads $0.36 per million (w2a-07 F7) | 100,000 members × 1 GiB is about 107,000 GB, about $1,610/month for storage |
| Member | durability on their own | a VPS running `tools/pin.mjs`, $4 to $6/month (w2b-01 table), or their own R2 bucket filled from Node tooling | a phone-only member cannot upload to a bucket without a credential endpoint, which is a backend |
| Member | seeding | desktop up to 1 MiB/s while open; phone 0 until opt-in, then 128 KiB/s (0.47 GB/h worst case, w1-08) | none in money terms; battery (2.8) |

### 2.8 Seeding and battery on mobile

A live follow feed keeps a phone radio on all the time. That comes from STUN consent every 5 s per connection, `mw_chain1` HELLO every 30 s per wire, PRES every 30 s, a tracker keepalive after 55 s of silence, and the 18 s radio tail (sections 2.1 and 6.6). Phones do not upload site files by default, but they still pass ledger blocks to every wire: "posts are still passed between connected visitors" (ARCHITECTURE 8 settings). Neither proposal gives a battery budget for following. REALTIME 7 covers chat frames only. G-SC-3 measures the cost.

### 2.9 The honest ceiling against a central service

| Capability | This design | Why |
|---|---|---|
| Chronological feed of people you follow | yes, while their ledgers are reachable (2.4) | merged in the browser |
| Ranked global feed, trending | no | needs everyone's data in one place |
| Search across everyone | no; only what this browser holds | same |
| Replies and mentions from people you do not follow, "who follows me", follower counts | no without an index | only ledgers you sync are visible |
| Spam fighting at scale | per ledger only (bans, PoW, allow) | no global reputation |
| Offline delivery and push | best effort; no push | Web Push needs a server (REALTIME 7) |
| Durability | only with pins, which are central storage | 2.4, 2.7 |

## 3. Findings

### Blockers

**B1. One swarm per person cannot be followed at scale (ARCHITECTURE 5.5 and 8; REALTIME 4.1 and 6.2).**
- *Problem:* the social model puts every person on their own rendezvous swarm. The wire budget applies per swarm and nothing caps the total across swarms. The proposals then add a chat lane per site and a torrent per file. Wires cannot be shared between infohashes.
- *Failure:* a member on Android follows 200 people. The tab opens 201 rendezvous swarms and asks for 603 to 1,005 peer connections. The mobile tab budget is 4 to 8. Each connection runs 5 s STUN consent checks. The page hits the browser's peer-connection ceiling (reported at about 500, G-SC-2) or the radio never sleeps. Most followed ledgers never get a wire, so the feed shows stale or empty walls.
- *Fix:* decide before the format freezes:
  - a hub follow lane: one hub-wide rendezvous swarm, or a few sharded by ledger-id hash, carrying a multi-ledger gossip extension (`mw_chain2`, ledger id on every frame, WANT by ledger and window);
  - a per-tab wire budget across all swarms (mobile at most 8 in total);
  - sync concurrency bounded to, say, 4 ledgers at a time, round-robin;
  - snapshot-first sync from the hub;
  - "pull, then disconnect" on phones.

  The REALTIME 4.1 cost line ("one more announced infohash per tab") should say "per site, multiplied by follows".

**B2. A browser cannot create a person's site (ARCHITECTURE 6.2; IDENTITY 2 non-goals).**
- *Problem:* "every person is a site" needs a genesis `policy` block signed by the owner. ARCHITECTURE 6.2 says the owner key never enters a browser and that only `publish.mjs` mints genesis. IDENTITY 2 lists "owner login from a browser" as a non-goal. So "sign up = create identity" makes a key but no site.
- *Failure:* a new member signs up on a phone. No site ledger exists for them. They have no wall, nothing to follow and no owner standing to ban on their own wall. The owner's PoW exemption does not apply to their own posts.
- *Fix:* add a "personal site" class in which the member's derived site key for their own ledger is the owner, with browser genesis. That makes D-10 `rotate`/`recover` mandatory, because otherwise a lost phone means a lost site. The alternative is hub-signed genesis, which makes the hub the owner of every personal site, and the docs must say so. Either is a format decision for the freeze window.

### Majors

**M1. Durability without pins is a minority case, and no proposal gives the number (REALTIME 6.5, 5.7; DIFFERENTIATORS line 106).**
- *Problem:* section 2.4 computes P(no media seeder) at 93 to 99% and P(no ledger holder) at 82 to 98% for typical personal sites.
- *Failure:* a member opens a friend's photo from last month. There is no seeder, the fetch returns `E_FILE_UNAVAILABLE`, and that is what most people see most of the time.
- *Fix:*
  - make a hub pin and snapshot service a standard component of hub mode, and state that it is central storage;
  - write a `cs=` snapshot per personal ledger;
  - send phone uploads to the hub web seed by default where the hub offers it;
  - show "kept by the hub" or "available only while someone who has it is online" on each item;
  - publish the table in 2.4 and run G-SC-4.

**M2. Opt-in holder peers will almost never exist (REALTIME 5.7).**
- *Problem:* offline DMs rely on desktop visitors who opt in to holding. Akamai NetSession is the closest precedent: 99.96% of 15.9 M default-off clients never turned uploads on (w2c-07 summary 1).
- *Failure:* on a hub of 1,000 members, expect well under one holder online. "Held by N peers" reads 0 and almost every message to an offline contact is "not delivered". The UI is honest, but the feature does not work.
- *Fix:* say in the design that offline delivery means the pin mailbox or nothing. Make the hub mailbox the hub-mode default, with its exposure row, or drop holders from v0.3. Measure with G-SC-7.

**M3. The tracker and the holders can rebuild the follow and contact graph (REALTIME 9.1; IDENTITY 9 "linkability across sites").**
- *Problem:* a tab announces `sha1("mw-ledger/1/" + ledgerId)` for its own ledger and for every followed ledger, and the directory makes those infohashes computable. Per-site keys are unlinkable, but one IP announcing one set of swarms is linkable. A holder sees WANT-TAGS from a recipient's IP covering all their pair tags for 7 days (200 contacts × 7 days = 1,400 tags, 44 frames), and it sees ENV frames from senders' IPs.
- *Failure:* the hub tracker operator, or anyone who runs a holder, rebuilds who follows whom and who writes to whom by IP. That refutes "never sender or recipient" (REALTIME 5.7) and the cross-site unlinkability row (IDENTITY 9), and the 9.1 tracker row leaves it out.
- *Fix:* add both rows to 9.1 and PRIVACY. Mitigations:
  - the B1 hub lane, which puts one infohash on the tracker and moves the graph to peers;
  - WANT-TAGS by tag-prefix bucket, so a holder sees k candidates and not exact tags;
  - snapshot fetches over HTTP, which moves the graph to the host, and the docs should say so;
  - cap the WANT-TAGS sent per holder.

**M4. Per-site unlinkable keys work against a social network (IDENTITY 3.1, 3.7; REALTIME 5.2, 5.3).**
- *Problem:* Alice comments on 200 walls with 200 unrelated keys. For anyone to see "Alice commented", she needs a link statement per ledger, which costs a PoW fee each and is permanent, or a hub-wide "same identity here" choice. Chat keys are also per ledger, so there is no common lane for DMs between personal sites. Presence on 200 chat lanes is another 200 swarms, and keeping the chat-key records current costs 200 fees every 90 days.
- *Failure:* comments show strangers' keys. DMs work only if both people happen to be on the same site's chat lane. Presence doubles the B1 load.
- *Fix:* add hub-scoped identity (`siteSeed` derived per hub for every site on that hub) chosen once, visibly, at hub sign-up. Run one hub chat lane and address inboxes by the hub-scoped key. State that people on one hub are linkable to each other by design, while different hubs and other sites stay unlinkable.

**M5. On a subdomain hub, each person's site is a separate origin for identity and storage (IDENTITY 3.3, 3.4; ARCHITECTURE 3.2, 5.9).**
- *Problem:* `mw-id` lives in the loader origin's IndexedDB, and on a subdomain hub every person's site is its own origin. So the member must restore or unlock the root on every person's origin. A passkey on the parent RP ID would cover all subdomains, but then every person's site on the hub can trigger the PRF prompt with any salt, and the 3.4 "honest limit" applies across the whole hub. The timeline origin and each person's origin also keep duplicate ledger replicas and duplicate swarms (one engine per origin).
- *Failure:* "one tap, nothing to type" becomes one unlock per person visited. Storage doubles and ITP clears the person-origin copies after 7 days.
- *Fix:* build the identity origin (IDENTITY 6.5) for hub mode in v0.3, not later. Make the timeline the one engine and the one store. Have person pages read through it, or say what the subdomain isolation costs.

**M6. Popular walls hit the ledger ceiling (ARCHITECTURE 6.1, 6.3; IDENTITY 6.2).**
- *Problem:* 8 MiB holds about 8,000 to 14,700 reactions (w2a-03) and 64 MiB about 65,000 to 118,000. Past the cap, only the owner, moderators and allow-listed authors are ingested. Every follower downloads the whole ledger, up to 64 MiB, and the mobile site caps are 24 to 48 MiB.
- *Failure:* a person with 10,000 followers who react to 10 posts each reaches the ceiling (100,000 blocks). After that, comments from everyone else silently stop counting, and each new follower's phone downloads 64 MiB.
- *Fix:* keep comments and reactions on the commenter's own ledger with a reference, and have the wall owner's ledger carry only posts and moderation. Or use per-post child ledgers. State the per-wall ceiling and show it to the owner, and run G-SC-10.

**M7. The directory has no size plan, Sybil plan or trust model (demo brief; ROADMAP "directory").**
- *Problem:* see 2.5. A single ledger stops at 56,000 to 84,000 names, the allow list at 1,000, and open registration costs about 5 core-hours per million fake names. A static directory is a hub build job. The operator can remap names.
- *Failure:* squatters register every common name in an afternoon, or the operator points "alice" at an impostor ledger and followers cannot tell.
- *Fix:*
  - use name records signed by the member's site key and countersigned by the hub;
  - keep an append-only directory whose history is visible;
  - shard it as static files;
  - pin the ledger id at follow time and warn when it changes;
  - offer a member's own domain TXT as the strong path;
  - get counsel review as ROADMAP requires;
  - say that rate-limiting registrations needs an endpoint, which is a backend.

**M8. Tracker load grows with members multiplied by follows, not with members (demo brief "only the directory and tracker grow").**
- *Problem:* see 2.6. 10,000 concurrent members each following 200 means 16,750 announces/s, about 3.4 cores, 2 million peer entries and up to 156 TB/month of egress, which is 15 times Oracle's free 10 TB.
- *Failure:* a hub sized from the w2b-01 table (built for one site) falls over at its first busy evening.
- *Fix:* the B1 hub lane brings this to about 1 to 4 infohashes per tab. Make the P4 count-aware policy mandatory in hub mode and run G-SC-5.

**M9. No first-open target and no battery budget for following (both proposals).**
- *Problem:* see 2.3 and 2.8. On a phone, verification alone is 60 to 180 s for 60,000 blocks (estimate), connection setup is unmeasured, and the radio stays on.
- *Failure:* a new member who follows 200 people waits minutes for a feed that is mostly empty (2.4), and the battery drains while the tab is open.
- *Fix:*
  - set a target, for example a first merged screen from snapshots before peer sync;
  - load newest first;
  - verify per ledger lazily;
  - on phones, sync and then close the wires;
  - run G-SC-1 and G-SC-3 before any number reaches the docs.

**M10. The cost model is missing, and "nothing central holds everyone's data" is false once durability is offered (demo brief; DIFFERENTIATORS 3.5 "the money").**
- *Problem:* see 2.7. Durability for everyone means the hub stores everyone's media, about $1,610/month at 100,000 members × 1 GiB on R2 (arithmetic). A phone-only member cannot buy durability without a credential endpoint.
- *Failure:* the README promises a social network with no central data holder. Then the only setup in which walls stay up is the hub keeping every file.
- *Fix:* publish the 2.7 table in DEPLOY and WHY. Present hub pinning as central storage the operator pays for and can be compelled to remove. Present the member's own pin as a VPS or a desktop that stays on.

**M11. Neither proposal states the honest ceiling (section 2.9).**
- *Problem:* ranked feeds, search across everyone, trending, mentions from people you do not follow, follower counts, spam fighting at scale and push are all impossible in this design. Neither proposal says so, and the demo brief lists them as premises to answer.
- *Failure:* users expect replies from strangers to show up and they never do. Reviewers read the gap as a bug.
- *Fix:* add a "needs an index" table to the social spec. Name the optional, labelled backends that would close each row (a hub indexer that crawls as a peer, a push relay) and keep them out of v0.3.

### Minors

**m1. Ledgers are outside the storage budget (`config.js` limits; `cache.js` `enforceBudget`).** Following many people grows IndexedDB without any bound or eviction. Fix: count ledger bytes in the budget, evict unfollowed ledgers by LRU, and show per-follow bytes in Settings.

**m2. The PoW fee multiplies by sites written to (IDENTITY 6.2; REALTIME 5.2).** A chat-key record and a link item on each of 200 ledgers costs 400 fees at 16 bits. That is about 20 ms each on an M3 (w1-11) and not measured on phones (G-CH-6, G-SC-8). Fix: hub-scoped keys (M4), or batch the records into one.

**m3. "Public files per site 256 MiB" is a lifetime media cap for a wall, and it is enforced only by honest clients (REALTIME 7).** Listings also use space in the 8 MiB ledger. Fix: state that it is a lifetime cap, count listing bytes, and say what happens at the cap.

**m4. The stamp economics are not given (REALTIME 5.6).** 20 bits is about 1.05 million hashes, about 0.3 s on a desktop at 3.2 to 3.7 million/s (w1-11), so roughly 12,000 first-contact messages per core-hour. Fix: add the number next to "a fee, not a defence".

## 4. Claims that need a measurement, and the test that produces each

| Row | Claim or number | Test |
|---|---|---|
| G-SC-1 | first-open sync for 200 follows | 200 synthetic ledgers (`tools/gen-chain.mjs`, w2c-05 R-19) at 100, 300 and 1,000 blocks served by Node peers and by `cs=` snapshots; low-end Android and an iPhone on LTE and Wi-Fi; record time to first merged screen, time to full sync, peak memory and CPU |
| G-SC-2 | swarms and peer connections per tab | raise the swarm count and wires per swarm per browser until failure; record the ceiling and the error |
| G-SC-3 | battery of a live feed | 30-minute foreground session: live follow, then pull-then-disconnect, then host-only; record battery drop and radio-active time (Android Battery Historian; iOS energy log from a Mac) |
| G-SC-4 | durability without pins | staging hub with real members for 14 days; share of ledger and media fetches that succeed without a pin, by content age; compare with section 2.4 |
| G-SC-5 | tracker load per hub | replay C tabs × F swarms against the `deploy/` tracker with and without P4; CPU, RSS per peer entry, egress |
| G-SC-6 | directory size and squatting cost | resolve a name from a sharded static index on a phone (bytes, time); time per registration at 16 bits on a phone |
| G-SC-7 | holder opt-in and offline delivery | extend G-CH-3: opt-in rate and delivery success over a week |
| G-SC-8 | PoW fees on phones | 16 and 20 bits on a low-end Android and an iPhone (extends G-CH-6) |
| G-SC-9 | reducer and IndexedDB at 200 ledgers | 200,000 blocks across 200 databases on phones; the reducer at 50,000 blocks is unmeasured (w2c-02) |
| G-SC-10 | popular wall at the cap | 100,000 synthetic reactions; behaviour at 8 and 64 MiB; download time for a new follower |
| G-SC-11 | hub bill | a staging hub with 1,000 members for a month; actual shell, tracker, pin and egress costs against section 2.7 |
| existing | per-site chat numbers in REALTIME (relay budgets, stamp time, iOS background) | G-CH-1 to G-CH-6 as written |

## 5. Sources

- Repository: docs/ARCHITECTURE.md 3.2, 5.5, 6.1 to 6.7, 8; src/loader/config.js; src/chain/block.js lines 38 and 47; src/loader/cache.js line 665; docs/ROADMAP.md line 142.
- Research (each cites its primary sources): w1-08-mobile-constraints F-07, F-13, F-16, F-17; w1-11-security-threats (hash rates); w2a-03-dynamic-feature-replacements (block sizes, ingest rates, like counts); w2a-07-hosting-cost-bandwidth F7 (R2 prices, page updated 2026-10-01); w2b-01-tracker-resilience (offer sizes, Linux load test, operator stats, cost table); w2c-02-chain-production-features and VERIFY (IndexedDB load, WebKit verify rate); w2c-04-hub-gateway-operations summary 11; w2c-07-incentives-economics F25, summary 1, eligibility baseline and `labs/w2c-07-lab/little-calc.mjs`; review/distributed-systems (phone verify estimate).
- External, via those files: RFC 7675; Android networking guide (updated 2026-10-16); WebKit bugs 277848 and 268816; Akamai NetSession study as cited in w2c-07.
