# Critique: the case against felinar

[WHY.md](WHY.md) makes the case for felinar. This page makes the case against it, as hard as the evidence
allows: what is really new and what is repackaged, where the design is weakest, what earlier projects teach,
what would sink it and what would carry it, and what nobody has measured yet. The README's
[twelve plain statements](../README.md#what-it-is-not) are the short version; the long versions are here and in
[SECURITY-MODEL.md](SECURITY-MODEL.md).

Every number names its source. Model outputs say so. Statements of opinion are marked as the project's
judgement.

## The verdict

felinar is a careful assembly of known parts. Its real contributions are an honest delivery path (the host's
web seed as the floor, and nothing peer-to-peer before the visitor agrees), a one-tag mode for existing static
sites that fails open to the host, and a per-site signed log with owner moderation that is small enough to verify
in a browser. Its weaknesses are the ones every predecessor hit: most of the time nobody else is online, phones
won't share, discovery depends on volunteers' trackers, and the static host remains the trust root. For most
small sites peer-to-peer delivery adds work and saves nothing; what it buys is resilience for returning visitors
and shared data without a backend, and both come with conditions. It is 0.3.0, a pre-release (0.2.1 was never
published), tested on one machine over loopback, and has never run on a real phone. This page argues against the
delivery and ledger design; the case against what v0.3 adds (one identity origin as a new central trust point, chat,
calls and private media) is made in [the v0.3 design review](review/V03-DESIGN-REVIEW.md) and
[THREAT-MODEL.md](THREAT-MODEL.md).

## What is new, and what is repackaged

| Part | Already done by | What felinar adds |
|---|---|---|
| BitTorrent in the browser over WebRTC | WebTorrent, which felinar vendors (`webtorrent@3.0.21`, with five patches applied at build time) | nothing in the protocol |
| Web seeds over HTTP (BEP 19) | BitTorrent clients for years | treats `ws=` and `xs=` as the floor rather than a fallback, and checks a host's `Range` and CORS answers before a pointer is published |
| A verified copy served by a Service Worker | the IPFS Service Worker gateway, Planktos, PeerWeb, and an earlier project with this very name and idea, [KayleePop/magnet-web](https://github.com/KayleePop/magnet-web) (MIT, last commit 2022-12-14) | the site at its own origin with unchanged URLs (a same-URL frame), and a drop-in mode under existing pages |
| A mutable pointer to immutable content | DNSLink, IPNS, ENS, ar.io names, Nostr nsite manifests | a signed record with `seq`, expiry, key rotation and a fail-closed withdrawal, and the key remembered on first use; the research judged it at least as strong as any of them, which is a judgement, not a measurement (research w1-07, summary 5) |
| A signed log every reader verifies | OrbitDB, Merkle-CRDTs, Secure Scuttlebutt, Hypercore; ZeroNet's per-site database rebuilt from signed files with per-user quotas | an in-house log with owner moderation decided by its own causal history, revocation on hand-over, and deletable payloads behind a salted hash |
| A proof-of-work fee per message | Hashcash-style stamps | nothing; it is used as a fee and documented as one |
| Asking before peer-to-peer | rare: Maelstrom seeded with no visible indicator (research w1-07, F4) | consent before any tracker, peer or DNS-over-HTTPS connection, with a refusal on the same layer |

The project's judgement: no single part is new. What is new is the combination in one loader that runs in an
ordinary browser with no install, and the discipline around it (the web seed floor, consent first, the
wording rules, the release gate). That is worth doing, and it is not a breakthrough.

## Where the design is weakest

### Durability without a pin node

- **Files** are durable only on your host. Without `ws=` and `xs=`, a site loads only while another visitor is
  online, and visitors are not an availability plan ([WHY.md](WHY.md#honest-economics)).
- **The ledger** is worse off. A new entry exists only on the devices of visitors who were online when it spread,
  until you publish a new snapshot. `pin.mjs` writes snapshots, but copying them to the `cs=` URL is a job you
  write yourself ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 7.2). Safari may delete a visitor's copy and
  posting identity after 7 days without a visit.
- **A pin node** is a headless Chromium kept open on a server. It works, but it is the heaviest way to keep a
  copy online, its cost per site is not measured, and it sends no heartbeat. "Comments without a backend" on a
  small site quietly means "comments plus a browser that never closes".

### Mobile seeding

- iOS suspends WebRTC within 5 to 20 seconds of a page going to the background, after a prepare-to-suspend window
  of about 20 seconds ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), D38).
- Every phone uploads nothing until its visitor turns sharing on for the site, because uploading 15 MiB on
  mobile data costs a visitor about 30 times what the host saves (2023 prices,
  [IMPROVEMENTS-DIGEST](research/IMPROVEMENTS-DIGEST.md), 9.4). Between 63% and 88% of Wikimedia's views are
  mobile (same, 9.5), so most visitors of most sites never serve anyone.
- A shell site downloads whole into memory before it renders: one unreviewed desktop run measured about 548 MB of
  renderer memory for a 128 MiB site ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), Q18). Phones are capped at
  48 and 24 MiB for this reason: the mobile research put peak memory at about 95 MB plus 2.7 times the site size
  ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), D9).
- In practice the swarm is desktops with long-open tabs: the longest 10% of visits hold 51% to 60% of all time on
  site (IMPROVEMENTS-DIGEST, 9.5).

### Tracker dependence

- Browser peers find each other only through WebSocket trackers. The four public ones are run by volunteers with
  no service level or abuse policy, ten earlier tracker hostnames have died, one of the four never pairs two
  seeders, and a common DNS block list (HaGeZi Anti-Piracy) blocks all four
  ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), 5.3; [PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md),
  verdict 3).
- After a two-second blip the stock client stayed away for a median of 174 seconds. felinar's reconnect shim
  brings it back in one to two seconds, but it patches WebTorrent's internals, which every upgrade can break.
- The fix for all of this is your own tracker on a neutral hostname. A tracker is a small, stateless server, but
  it is a server: "no backend" stays true and "nothing to operate" doesn't.
- A tracker sees every visitor's IP address and the infohash: the operator of a site's tracker sees its whole
  audience.

### Swarm sizes for small sites

- At 1,000 visits a day and a 60-second mean visit, 0.69 visitors are online at a time and half of all visitors
  arrive alone. Counting only visitors who agree to share, on a desktop or a confirmed network, with a direct
  connection that works, a site has 0.06 such seeders online, and a 5 MiB site gets 0% of its first-load bytes from
  peers. 25 eligible seeders online take about 448,000 visits a day (model outputs,
  [IMPROVEMENTS-DIGEST](research/IMPROVEMENTS-DIGEST.md), 9.1 to 9.4).
- Plan for 10% to 30% of peer pairs needing a relay; the only first-party figure with a sample (22%) is from
  2016 ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), verdict 4). felinar ships no relay, so those visitors
  load from the host.
- For the long tail of the web, the peer-to-peer half does nothing for first loads. Peers matter for large files
  with large simultaneous audiences, and for ledger sync between visitors who overlap.

### The ledger as a database

- **No finality, no transactions.** "Latest" means last in a deterministic order (depth, then hash), not last in
  time, and an entry that arrives late can change it. Two visitors can disagree for a while.
- **Public and permanent in shape.** Everything is visible to every visitor. A deletion removes the value from
  copies it reaches; keys and list names stay in the signed header of every copy. No personal data belongs in it.
- **Small.** 8 MiB by default (64 MiB at most), 2 KiB per value, 4 KiB per block, 20 writes a minute per page. A
  200-character comment takes 798 to 1,267 bytes as a block ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md),
  V18), so the default ledger holds roughly 6,600 to 10,500 comments (our arithmetic).
- **Fully replicated.** Every visitor downloads the whole ledger (a full 8 MiB ledger is a 3.1 to 3.9 MiB gzip
  snapshot, [PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), section 10) and keeps it in memory. There is no
  partial sync, no index beyond an in-memory reducer and no paging cursor yet.
- **Fragile identities.** A visitor's posting key lives in one browser, is created on the first visit, is lost when
  Safari clears storage unless exported by hand, and is readable by any script on the site's origin. Names are
  self-chosen and prove nothing.
- **One key rules.** The owner key has total authority, there is no pre-committed next key yet, and bans or
  deletions signed with a stolen key can't be undone.

### Proof-of-work is a fee, not security

One RTX 4090 hashes about 1,650 times faster than a browser using five workers on an M3 laptop
([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), verdict 8); one GPU mints about 300,000 entries a second at 16
bits (same, D30), and a native attacker on one core fills the default 8 MiB ledger in about 13 minutes
([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 4.1). Meanwhile honest visitors pay in battery, and nobody
has measured the cost on a phone. Open writing therefore means a moderation workload; that is why the default
lets only the owner write.

### The host is still the trust root

Every visit runs code from your host, and the remembered site key is checked by that code. A page can't verify
itself, and the browser fetches Service Worker updates in a way no page script can intercept
([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), verdict 6). Whoever controls your host or your DNS controls
the site. That is the trust model of every website; felinar adds integrity against other visitors, not
against your host. Pieces are named by SHA-1, and the per-file SHA-256 list is not yet bound to the pointer.

### Shell mode hides the site from crawlers

Shell mode answers every URL with the loader, so search crawlers, link previews and crawl-validated checkouts see
one title for every URL, no Open Graph tags, and a hard or soft 404 on deep links
([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), verdict 2). The mode that keeps working when the host is down
is the mode without search traffic; drop-in keeps search traffic and needs the host for every new visitor.

### Complexity for owners

Compared with dragging a folder onto a static host, an owner now handles a signing key, a pointer that expires
every 90 days by default, TXT strings of 255 bytes, CORS and `Range` on the web seed, a deploy order, a 7-day
retention rule, a kill switch drill, a privacy notice and a notice-and-action process. Failures are often silent:
a web seed that answers a range with the whole file looks like a hang. Only 6 of 24 hosts passed WebTorrent's stock
web seed request, 13 of 24 once two headers were dropped ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md),
verdict 5). The tools catch most of this (`check-webseed`, `check-site`, the publish gates), but each check is a
step someone can skip.

### Drop-in can cost more than it saves

Each drop-in visitor on an unmetered network downloads the whole copy of a site's non-HTML files from the host
once. In the research model (arithmetic, not a measurement), a 20 MB copy completed after a 1.5 MB page view
costs the host 13.3 times the bytes of that view ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), M10). Sharing happens in page-view-sized bursts, and every page
view opens new tracker sockets.

### Privacy has a cost in friction

The consent card appears on every first visit. Content blockers already treat undisclosed peer-to-peer delivery
as resource abuse, and the rule text uBlock Origin uses says such scripts "MUST be opt-in, with complete informed
consent from the visitor" ([WHY.md](WHY.md)). The consent rate is a planning figure (0.30), not a measurement.
After consent, visitors' IP addresses are visible to strangers, and anyone can list a site's audience. The legal
reading of consent for Service Worker storage and peer upload in the EU is the research's inference: the EDPB's
guidelines name local storage, WebSQL, caches and networks of peers but not Service Workers or IndexedDB, and do not
analyse the exemptions ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 4.2; EDPB Guidelines 2/2023, version 2.0).

### Legal exposure for visitors and hubs

Visitors who share "make available" what their browsers upload, when duly informed (the CJEU's Mircom reading,
conditional on an informed user). Shared gateway domains attract phishing: Fleek and Skynet were the top two
services in Web3 credential-phishing URLs in 2022, and Shipyard-run IPFS gateways were 84% of Netcraft's
IPFS-fronted phishing in 2026 (research w1-07, summary 3; vendor telemetry). A Safe Browsing listing of a hub's
domain covers every label under it. 0.3.0 has no hub denylist, so a public hub is not viable yet.

### Maturity

On 2026-10-26, 0.3.0 passed 2,305 of 2,314 unit tests (0 fail, 1 skipped, 8 todo), 102 of 102 end-to-end scenarios in Chromium 156,
107 of 107 in Playwright's WebKit 27.2 and 140 of 140 in Firefox 157 (the three suites ran at the same time; E-MD-6
missed a wait under that load and passed alone right after), and 186 of 186 example checks, all on one
development machine over loopback ([INTEGRATION-STATUS.md](INTEGRATION-STATUS.md)). These counts
come after the review round of the v0.3 design review (2026-10-22 to 2026-10-24) and the independence round (2026-10-25), and Firefox has run in the harness
since 2026-10-22, but no real phone was used,
no timing was taken on a real network, and five planned research topics
were never written ([ROADMAP.md](ROADMAP.md), "Research still owed"), performance among them.

## What prior art teaches

From the prior-art research ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), 2.3; research `w1-07-prior-art.md`):

| Project | What happened | The lesson | Does felinar escape it? |
|---|---|---|---|
| ZeroNet | a local client; a shared-origin wrapper produced repeated security fixes (at least nine labelled security entries from 2016 to 2019, up to five of them wrapper escapes); visitors hosted everything; a central identity issuer invited spam; its creator's activity ended by early 2021 | no install, one origin per site, bounded hosting, no central identity | mostly: no install, per-site origins, visitors share only the site they view after consenting, per-site keys. Spam on open ledgers and the maintainers' staying power remain |
| Project Maelstrom | a closed Chromium fork (alpha 2014-12, beta 2015-04) that seeded with no visible indicator and had no update path; it ended over "investor problems" | no custom browser, visible sharing, mutable pointers | yes on all three; funding is the open question for every such project |
| Beaker and Dat | its own post-mortem: no stickiness, slow first paint, nobody online, "don't bloat your MVP"; archived 2022-12-27 | first paint and a reason to come back decide adoption | first paint comes from the web seed; the reason to come back is unproven, and first paint has not been measured on a real network |
| IPFS public gateways | over 614 million requests a day, of which 9.4% were browsers loading pages and 67.4% scripts using a free CDN (a three-day vendor sample); the sponsor stopped, and `ipfs.io` and `dweb.link` stopped fetching content for visitors on 2026-09-21 | free shared infrastructure ends, and an open gateway becomes someone else's CDN | the owner's own host is the floor; a public hub would face the same pull |
| The IPFS Service Worker gateway | the same shape as felinar (static bootstrap, Service Worker, in-browser verification, one origin per site); a stale CDN copy of its worker bricked it (issue #1155, July 2026) | purge the CDN on every deploy, keep a kill switch | both are documented and the worker refuses an inconsistent install; neither has been drilled on a real host |
| PeerTube | removed its WebTorrent player in 6.0.0 ("the P2P aspect of WebTorrent is not really used") and kept peer-to-peer behind HLS, origin first; the library it kept (P2P Media Loader) says public trackers alone can handle 1,000 to 2,000 simultaneous viewers | the origin is the product; peers help large simultaneous audiences | the design follows this exactly, which also means peers rarely help a small site |
| PeerWeb | a same-origin iframe with DOMPurify, demos stuck on "Connecting to peers", one tab reportedly at about 15 GB | a frame on one origin is no boundary; nobody online is a dead end; bound memory | own origins, the web seed and size caps; memory on phones is unmeasured |
| Paid persistence | Skynet (2022-08), Cloudflare's gateway (2024-05), NFT.Storage (2025-04-16), Fleek Hosting (2026-01-31) and Shipyard (2026-09-30) closed, ended or changed hands (announcement or transition dates) | keep your own host in the loop | yes |
| Brave's native `ipfs://` | used by under 0.1% of users and removed on 2024-08-22 | don't build on native protocol support | no `magnet:` handler ships in 0.3.0 |

## What would make it fail

The project's judgement, from the evidence above:

- **Selling it as cheap hosting.** For small sites it isn't, and the first owner who checks the bill will say so.
- **Overclaiming.** Words that promise availability, permanence or resistance to takedown break trust and, after
  Cox v. Sony, marketing is part of what decides inducement ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 5.3).
- **Becoming a piracy channel.** A public hub without abuse handling ends in block lists for its trackers and
  domains, Safe Browsing listings and legal notices, and it drags every honest site down with it.
- **Silent failures.** A web seed that half works, an expired pointer nobody re-signed, a tracker that died: each
  looks like "it doesn't load", and owners leave.
- **iOS.** If Safari's storage deletion and backgrounding make the offline copy and the identity unreliable on the
  most common phones, the returning-visitor story breaks where most visitors are.
- **Upstream drift.** Five string patches on a minified third-party bundle and a shim on its internals mean each
  WebTorrent release can break felinar until someone re-checks every patch point.
- **Consent fatigue.** If few visitors choose "Share and load", the peer-to-peer half stays dormant and the ledger
  syncs only through snapshots.
- **Maintainers or funding walking away,** which ended or froze ZeroNet, Maelstrom, Beaker and Shipyard's IPFS
  work.

## What would make it succeed

Also the project's judgement:

- **Lead with what needs no peers to be useful:** a drop-in tag that gives an existing static site offline revisits
  and a moderated comment or guestbook log, failing open to the host. Pair it with a one-command pin node, because
  a small site's posts otherwise reach only visitors who overlap.
- **Aim the peer-to-peer half where it pays:** large files with large simultaneous audiences, such as events,
  courses, mirrors and datasets. A 128 MiB site with 10 eligible seeders online gets about 47% of first-load bytes
  from peers in the model ([IMPROVEMENTS-DIGEST](research/IMPROVEMENTS-DIGEST.md), 9.3).
- **Make the web seed path impossible to get wrong:** host recipes that pass `check-webseed`, CI templates that
  gate the pointer on it, and canaries that page someone.
- **Run the release gate and publish the numbers,** failures included ([DEMO-RESULTS.md](DEMO-RESULTS.md)), then fix
  identity durability with a recovery phrase.
- **Stay boring and honest:** neutral wording, no public hub until the operating layer exists, specifications with
  test vectors so a second implementation can exist ([ROADMAP.md](ROADMAP.md)).

## Open questions still to measure

| Question | Why it matters | Where it gets answered |
|---|---|---|
| Does the loader work on real iPhones (iOS 18 and 16 or 17), Android Chrome on mobile data, Samsung Internet, Firefox (normal and private), Brave and Edge? | every browser claim beyond Chromium and Playwright WebKit is unverified | [DEMO-RESULTS.md](DEMO-RESULTS.md), rows G1 to G9 |
| How often does a phone on mobile data connect to a laptop on home Wi-Fi, in both directions? | the share of visitors who need a relay | G10 |
| How long does a cold start take on real networks? | first paint decided Beaker's fate; topic 07 was never researched | G11; [PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), section 11 |
| What share of visitors consent, how long do they stay, and what offload results? | every offload figure is a model | [ROADMAP.md](ROADMAP.md), measured economics |
| How long does a 16-bit posting fee take on a mid-range phone? | open-writing sites ship with 16 bits and the cost is only estimated | G20 |
| Does Safari keep the copy and the identity for 7 days, and in a Home Screen app? | the returning-visitor promise on iOS | G16 |
| How long does the kill switch take in Firefox and WebKit? | measured only in Chromium (about 3 seconds after the next navigation) | G14 |
| How long from a notice to a withdrawal taking effect? | the takedown targets (P0 under 60 minutes) | G19 |
| How much memory does a whole-site download take on a phone? | the phone caps rest on desktop runs and a formula, not on phones | [MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), Q18 |
| Do the browsers at the floor send a preflight for a plain `Range` request? | decides whether web seeds can skip CORS preflight support | [ARCHITECTURE.md](ARCHITECTURE.md), section 14 |
| Does Firefox keep the worker's navigation deadline and keep-alive working? | tested only in Chromium and in unit tests | G6 |
| Does Safari report `resultingClientId`, and does the iOS key-storage fallback work? | drop-in mapping and identity creation on iOS | G21, G22 |
| How many visitors sit behind DNS filters that block the public trackers? | decides how urgent an own tracker is | [PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 6.1 |
| Is the consent card enough under EU, UK and Quebec law, and who is the controller for trackers and STUN servers? | a legal question, not an engineering one | a lawyer where the site's visitors are, asked by each site owner; no lawyer has reviewed it for the project, and none is engaged for 0.3.0 ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 6.2) |
