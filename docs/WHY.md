# Why felinar

This is the long-form case for felinar: the problem it answers, the idea behind it, what you get, what it
costs you and your visitors, and when you should use something else. Every number names its source. Numbers
from the economics model are model outputs, not measurements, and say so.

## The short version

> This page describes 0.3.0 (0.2.1 was never published). The section "v0.3: sign-in for
> any site and the honest ceiling" near the end covers what v0.3 adds: one identity for many sites, private messages and
> media, and a social network of personal sites, with what each can and cannot do.
> Its last part, "Readers who agree help carry the site, and calls", covers phase C2: sharing from phones, sites
> with no domain and calls.

Most websites are a folder of static files, and static hosting is cheap or free. Trouble starts the moment a
site needs a little shared data (a guestbook, comments, a poll): you add a database, a server or a vendor, and
with it a bill, a login, patches and a single point of failure. felinar keeps the site static and moves
the rest into the visitors' browsers. Files travel by magnet link between visitors and from your plain static
host, every byte is checked against the published infohash, and shared data lives in the site ledger: a
signed, hash-linked log that every visitor copies and verifies. No mining, no consensus, no finality.

What you get is resilience and independence: no backend to run, a copy that keeps working for returning
visitors when your host is down, and shared data without a vendor. What you don't get is a smaller bill for a
small site, privacy from other visitors, or a guarantee that anything stays online when nobody is. The rest of
this page explains both halves.

## The problem

### Shared data drags in a backend

A static site generator produces HTML, CSS, JavaScript and images, and any bucket or CDN can serve them. Add a
comment box and the picture changes: you need somewhere to store comments, an API to write them, an account
system or spam filter in front of it, and someone to keep all of that patched, backed up and paid for. A
guestbook with ten posts a week ends up with the same moving parts as a small web application.

### Bandwidth bills scale with success

On metered CDNs the bill follows traffic: CloudFront's list price was $0.085 per GB for the first 10 TB in the
US and EU on the price list of 2026-10-03 ([w2c-07](research/w2c-07-incentives-economics.md), summary 4).
Many hosts charge nothing for this traffic (R2 egress is free, GitHub Pages has a 100 GB monthly soft limit),
and those are a large part of why felinar works at all: your host can be a free bucket.

### One origin, one point of failure

When the origin is down, the site is down. Hosted alternatives that promised permanence keep closing: the free
public IPFS gateways `ipfs.io` and `dweb.link` ended on 2026-09-21, and several paid persistence services
announced shutdowns or transitions ([IMPROVEMENTS-DIGEST](research/IMPROVEMENTS-DIGEST.md), verdict 9;
[RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), section 2.3). A design that depends on someone else's free
infrastructure inherits its lifespan.

### Lock-in and ownership

A backend-as-a-service holds your site's shared data in its schema, behind its API and its pricing. Moving
away means an export, a rewrite and a migration window. The data your visitors wrote belongs to a vendor's
database rather than to the site and the people who use it.

## The idea

felinar combines four ideas, each old and well tested, and ties them to your domain with a signed pointer.

1. **Static files are enough.** The site stays a folder of files on a plain HTTPS host. Nothing of yours runs
   on a server.
2. **Content addressing.** The files are published as a BitTorrent v1 torrent, named by its infohash. Anyone
   can deliver the bytes, because every browser checks every piece against the infohash before it uses or
   passes it on.
3. **Visitors as peers, with consent.** While a page is open, the visitor's browser can pass pieces to other
   visitors over WebRTC, after the visitor chooses "Share and load". Your host's copy (the web seed) races
   them and needs nobody else online.
4. **A signed log for shared state.** Each site gets a site ledger: entries signed by their authors, linked by
   hash, ordered the same way on every copy, with an owner and moderators who can remove entries and ban
   authors, and a small proof-of-work fee per entry to slow down spam. Sites use it through `mw.db`.

The **pointer** binds it together: a short record signed with your owner key that names the infohash, the web
seed, the trackers and the ledger, with a sequence number and an expiry. It lives in a `<meta>` tag of the
loader page and, optionally, in a `_magnet` TXT record. Visitors remember your key on the first visit and
refuse a different one unless they confirm, and your key can withdraw the site.

## What you get, and the condition attached to each

| Benefit | How | The condition |
|---|---|---|
| No backend to run | a static host serves the loader and the files; trackers and STUN servers (public or yours) introduce visitors | you still need an HTTPS static host, and shell pages on a public hostname ask a DNS-over-HTTPS service for updates once a visitor shares |
| Low hosting cost | the host is a plain bucket, free or cheap for most sites | peers carry a real share of the bytes only for large sites with many visitors online at once (see [honest economics](#honest-economics)) |
| Shared data with `mw.db` | the site ledger, copied and checked by every visitor | public, no finality, and it spreads only while someone with a copy is online; keep a snapshot (`cs=`) or a pin node |
| Your domain and key in charge | signed pointer, remembered key, `seq` that never goes back, expiry, withdrawal | your host and DNS stay the trust root on every visit |
| Existing sites switch with one tag | drop-in mode leaves every HTML page on the host and fails open | new visitors still need the host; filling copies can multiply host egress |
| Returning visitors survive a host outage | shell mode keeps a verified copy and the Service Worker serves it | only after a previous visit, and only while the browser keeps the copy |
| No tracking added by the loader | no analytics, no telemetry, no third-party scripts, no connection to peers, trackers, STUN or DoH before the visitor's choice | your host sees each visitor's IP address, as any web host does; once a visitor shares, peers and connection servers see it too |

## The trade-offs, stated plainly

**Your host is still the trust root.** Your domain still serves a small loader over HTTPS, and a DNS record
can't replace your host. A first visit trusts your HTTPS host and your DNS. Later visits also check the
remembered site key. Peer-to-peer delivery protects the site's files from tampering by other visitors, not by
your host: whoever controls your host or your DNS controls what visitors run.

**IP addresses are visible.** There's no private mode. Peers, trackers and STUN servers see each visitor's IP
address, and anyone who knows the site's infohash can see who's online. There are no relay (TURN) servers, so
some visitors, often on mobile data, can't reach peers and load from your host instead. The loader says this
before it connects, and "Load from host only" keeps a visitor away from peers entirely.

**Third parties carry the introductions.** Visitors find each other through WebSocket trackers (by default
`tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.novage.com.ua` and `open.ftorrent.com`) and
STUN servers (`stun.cloudflare.com`, `global.stun.twilio.com`). None of them publishes a service level, and
all four public trackers appear on at least one DNS block list
([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), verdict 3), so production sites should add their own
tracker on a neutral hostname (`tools/tracker.mjs`, [DEPLOY.md](DEPLOY.md)). The default `<meta>` pointer loads the
site without a lookup, but after a visitor chooses "Share and load", a shell page on a public hostname also asks
a DNS-over-HTTPS service (Cloudflare first, then dns.sb or Google) for a newer pointer, whether or not you
publish one in DNS: right after the choice, then every 5 minutes or the record's TTL while the page is open, and
at most once a minute on focus. That service sees the site's name and the visitor's IP address, and the
first-run card names it. "Load from host only" makes no lookup on a site with a page tag; on a site found only
through DNS, either load button makes the lookup and the page keeps checking. Drop-in pages never query DNS. The
full register is in [PRIVACY.md](PRIVACY.md).

**No finality, and everything is public.** An entry that arrives late can change what "latest" means, and
two visitors can briefly see different states until they connect. Everything written with mw.db is public and
copied to every visitor. Deleting an entry hides it for visitors who receive the deletion. Copies on devices
that never sync again stay where they are. Keep personal data out of the ledger, even encrypted.

**Phones are mostly downloaders.** Phones load the site and sync the ledger while the page is open and on
screen. iOS stops peer connections within seconds of switching apps or locking the screen, and Android can do
the same. A phone passes on other people's items only after the visitor turns on "Share on this network" for
that site or starts dock mode, and never on mobile data, because a visitor on mobile data pays real money for
every byte (see below); its own uploads go out after a card, at up to 128 KiB/s on mobile data and with a session
cap on every phone row ([ARCHITECTURE.md](ARCHITECTURE.md), 8.1.3). Sites are capped at 128 MiB on desktop and
24 to 48 MiB on phones.

**Storage is a cache.** Browsers can evict a site's copy, and Safari may delete the site's local copy after 7 days
without a visit, and the identity page's data after 7 days without a visit there. The identity lives at the
identity page, not in the site, so adding the site to the Home Screen is not a way to keep it: a passkey identity comes
back from a site's sealed copy, a passphrase identity only from the 12 words or the backup file made at the
identity page. Only a build without the identity service keeps the 0.2.1 export in Settings. The ledger's
durable floor is the snapshot on your host and a pinned node.

**Open writing is an owner's duty.** With open writing, every visitor stores and passes on posts by strangers.
You moderate what your site makes visitors redistribute. The proof-of-work on each post is a fee that slows a
flood down, not a defence against a determined attacker; writer policy, allow lists, moderators and bans are
the real tools ([DEPLOY.md](DEPLOY.md), "Owner duties").

**Search engines and shell mode.** Shell mode answers every URL with the loader, so crawlers and link
previews that don't run it see no content. Drop-in mode keeps every page as plain HTML on the host and is the
right mode for anything that must be indexed.

**The loader costs bytes.** On the 0.3.0 build, gzip-compressed (measured with `gzip -9` on 2026-10-21): the shell's
`loader.js` is about 364 KB and the vendored `webtorrent.min.js` about 64 KB; the drop-in runtime `mw.js` is
about 276 KB plus the same WebTorrent bundle. On the 0.2.1 build they were about 117 KB and 105 KB: the v0.3 features
are inlined, and nothing splits them yet ([ROADMAP.md](ROADMAP.md), size budgets). A returning visitor gets them from
the Service Worker's cache.

**Filter lists notice peer-to-peer.** Content blockers already block undisclosed peer-to-peer delivery as
resource abuse; uBlock Origin's rule text says such scripts "MUST be opt-in, with complete informed consent
from the visitor" ([w2c-07](research/w2c-07-incentives-economics.md), summary 8). felinar asks first, and
it has to keep doing so.

**It is young.** 0.3.0 passed the automated suites in the last full runs on one development machine, over
loopback only (the counts, dates and the rows that fail now and then are in
[INTEGRATION-STATUS.md](INTEGRATION-STATUS.md)), but the release gate on real phones and
browsers has not run ([DEMO-RESULTS.md](DEMO-RESULTS.md)); the review round of the v0.3 design review ran from
2026-10-22 to 2026-10-24. Nothing here is production-ready until the gate passes.

## Honest economics

Peer-to-peer delivery buys resilience and host independence, not a smaller bill. The numbers below are model
outputs of `docs/research/labs/w2c-07-lab/little-calc.mjs` under stated assumptions, taken from
[IMPROVEMENTS-DIGEST.md](research/IMPROVEMENTS-DIGEST.md) section 9 and
[w2c-07](research/w2c-07-incentives-economics.md); field data will replace them.

### How many visitors are online at once

Visitors online = visits per day x mean seconds on the site / 86,400 (Little's law). The chance that an
arriving visitor finds nobody else is `exp(-visitors online)`. Use the mean time on site, not the median: most
visits end in seconds, and the few long ones decide how many people overlap.

| Visits per day | 20 s | 60 s | 180 s | 600 s |
|---|---|---|---|---|
| 100 | 0.02 (98% alone) | 0.07 (93%) | 0.21 (81%) | 0.69 (50%) |
| 1,000 | 0.23 (79%) | 0.69 (50%) | 2.08 (12%) | 6.94 (0.10%) |
| 10,000 | 2.31 (9.9%) | 6.94 (0.10%) | 20.8 (0.00%) | 69.4 (0.00%) |
| 100,000 | 23.1 (0.00%) | 69.4 (0.00%) | 208 (0.00%) | 694 (0.00%) |

Cells: mean visitors online, with the chance of arriving alone (IMPROVEMENTS-DIGEST table 9.1).

### Not every visitor can help

A visitor shares only after choosing to (planning figure 0.30), on a desktop or a phone network they confirmed
(0.35), with a direct connection that works (0.80): about 1 visit in 12. With that share and a 60-second mean
visit, a site needs about 448,000 visits a day to have 25 eligible seeders online; a desktop audience that
shares by default needs about 82,000 (IMPROVEMENTS-DIGEST 9.2).

### Where the bytes come from

On a first visit the web seed and the peers race. A peer connection needs 1.5 to 3 seconds before bytes flow,
and a fast web seed delivers about 16 MiB in that time, so small sites finish before any peer helps.

| Site size | 1 eligible seeder online | 10 online | 100 online |
|---|---|---|---|
| 2 MiB | 0% | 0% | 0% |
| 20 MiB | 2.0% | 11% | 19% |
| 50 MiB | 6.9% | 37% | 63% |
| 128 MiB | 8.8% | 47% | 81% |

Cells: expected share of first-load bytes from peers, web seed at 8 MiB/s (IMPROVEMENTS-DIGEST table 9.3). A
slow host path raises the peer share a lot: a 20 MiB site with 10 seeders online gets 66% from peers when the
host delivers 2 MiB/s.

### What it saves, and what it costs a visitor

| Visits per day | Site | Egress per month | Expected offload | Saved per month at $0.085/GB |
|---|---|---|---|---|
| 1,000 | 5 MiB | 146 GB | 0% | $0 |
| 10,000 | 50 MiB | 14,648 GB | 4.0% | about $50 |
| 100,000 | 50 MiB | 146,484 GB | 27% | about $3,325, less with volume tiers |

(IMPROVEMENTS-DIGEST table 9.4.) On mobile data the arithmetic turns around: uploading 15 MiB costs a visitor
about $0.038 at the 2023 global mean price of $2.59 per GB, about 30 times the $0.00125 the host saves
([w2c-07](research/w2c-07-incentives-economics.md), summary 5; the prices are from 2023). That is why phones
upload nothing until the visitor turns it on.

### Will my site have peers?

Run the calculator with your own numbers (mean seconds per visit from your analytics, site size in MiB):

```sh
node docs/research/labs/w2c-07-lab/little-calc.mjs --visits 1000 --dwell 60 --size 5
```

For 1,000 visits a day it prints 0.69 visitors online, a 50% chance of arriving alone, 0.06 eligible seeders
and an expected offload of 0% for a 5 MiB site. If availability matters more than speed, run a pin node
(`tools/pin.mjs`) and keep the web seed in the pointer; visitors are not an availability plan.

### What this means for you

- **Small sites (under about 16 MiB)** get about 0% of their first-load bytes from peers at any audience size.
  Their gain is resilience: a verified local copy, instant and offline revisits, the ledger replicated between
  visitors who are online together, and service from peers while the host is down if anyone is online.
- **Medium sites (20 to 50 MiB)** see single-digit percentages until about 10,000 visits a day with visits
  of minutes.
- **Large sites with big audiences or long visits** can reach 40 to 80%.
- **Drop-in copies can cost more than they save.** Each drop-in visitor on an unmetered network fills a copy
  of the non-HTML files from your host once, at idle. With a copy of S bytes, a visit that would have loaded
  B bytes anyway, and a share p of the copy coming from peers, the host serves (S x (1 - p) + p x B) / B times
  what the visit alone would have cost. In the research model (arithmetic, not a measurement) that is 13.3
  times for a 20 MB copy completed after a 1.5 MB visit with no peer help, and 7.2 times with half from peers
  ([w2a-07](research/w2a-07-hosting-cost-bandwidth.md), F21;
  [MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), verdict 4). On a host with free egress, such as R2, this
  costs nothing; elsewhere it is billed. `publish --dropin` prints the copy size for your site.

## Use cases

| Use case | Why it fits | Watch out for |
|---|---|---|
| Documentation sites | generator output is static; drop-in keeps search and links intact; readers keep visited pages offline; per-page comments through `mw.db` | shell mode hides content from crawlers, so docs usually stay in drop-in |
| Blogs | free static hosting, a guestbook or comments without a database, a copy that survives a host outage in shell mode | comments are public and need moderation; a small blog is usually alone online |
| Communities: guestbooks, comments, polls, reactions | the site ledger gives every visitor the same entries in the same order, with an owner and moderators | open writing invites spam; a visitor's key belongs to a device, so a poll counts devices, not people; one entry per author per item is the pattern for votes ([CRUD.md](CRUD.md)), and each like costs about 570 to 1,039 bytes (measured on the v0.2 block format: [w2a-03](research/w2a-03-dynamic-feature-replacements.md), summary 3), so the default 8 MiB ledger holds about 8,000 to 14,700 in all, of which authors who are not vetted share the 25% reserved pool: about 2,000 to 3,700 likes from visitors (arithmetic: 2,097,152 bytes / 1,039 to 570), the rest for the owner, moderators and allow-listed members |
| Event pages that spike | many visitors online at the same moment can pass large files (programmes, slides, handouts) to each other | the host still serves every loader and first page; small pages come from the web seed anyway; a shell site downloads whole before it renders, so keep video out of the torrent |
| Mirrors and archives | content addressing: the same files, published under the same name, give the same infohash wherever they are published, and every copy is verified | updates and withdrawal stay with the owner key; someone must keep a copy online (a web seed or a pin node) |
| Education | a class on one network opens the same course material at once; laptops that choose to share do so at full speed, and revisits work offline | phones are download-only until the visitor confirms the network; the loader still comes from the host |
| Low-budget publishing | a free Pages site or bucket, plus the public trackers, is the whole infrastructure | full mode needs HTTPS and the root of a domain (a custom domain, or a user or organisation Pages site) |
| Apps that need light shared state | small public boards, polls, display names, and settings in `_` keys that only the owner and moderators can write | 20 writes a minute per page, 2 KiB values and an 8 MiB ledger by default; no private data, no transactions |

## When not to use it

- **Private or personal data.** Everything in the ledger is public and copied to every visitor, and erasure
  reaches only the copies that receive it.
- **Accounts, payments, email, webhooks and secrets.** These stay on a server; at most the browser hands off to
  a third-party service (a form relay, a payment link). See the four feature classes in
  [MIGRATION.md](MIGRATION.md).
- **Strong consistency.** The ledger has no finality and no transactions; two visitors can briefly disagree.
- **Anonymity.** Peers see each other's IP addresses, and anyone who knows the infohash can see who's online.
- **Streaming media.** A shell site is downloaded whole before it renders, within the size caps above. Keep
  video on HTTP.
- **Search-critical pages in shell mode.** Use drop-in for anything that must be indexed or previewed.
- **Mostly-mobile audiences expecting offload.** Phones upload only after the visitor opts in.
- **A cheaper bill for a small site.** The web seed carries nearly all of it anyway.
- **Anything that must not depend on browsers keeping data.** Storage is a cache; durability comes from your
  host's snapshot and a pin node.

## How it compares

| | Backend you run | Shared data | When the origin is down | Main trade-off |
|---|---|---|---|---|
| **felinar** | none: a static host plus public or own trackers | site ledger through `mw.db`: public, signed, no finality | returning shell visitors keep their copy; new visitors need your host for the loader | IP addresses visible to peers; a young project |
| **Static host and CDN** | none | needs a third-party service | the CDN may serve cached copies for a while | no shared data of its own; some CDNs bill egress per GB |
| **Backend as a service or functions** (Firebase, Supabase, AWS Lambda) | the vendor runs it, you pay per use | a real database: private data, accounts, queries | data is unavailable while the vendor is | lock-in and a bill that grows with use |
| **IPFS** (Fleek, gateways) | a pinning service or your own node | none built in | gateways serve while someone pins it | free public gateways (ipfs.io, dweb.link) ended on 2026-09-21 and hosted pinning keeps closing ([IMPROVEMENTS-DIGEST](research/IMPROVEMENTS-DIGEST.md), verdict 9) |
| **Nostr** (the nsite draft) | relays and blob servers run by others | signed events on relays | relays keep what they choose to keep | static sites only through server gateways so far; relays are an untrusted, lossy cache |
| **Traditional CMS** (WordPress and similar) | a server, a database, updates and backups | comments, forms, accounts | down, unless a cache serves it | maintenance and attack surface |

felinar sits on top of the first row: it is a static site with a loader. It does not replace a backend for private
or transactional data.

## Prior art

felinar is built on [WebTorrent](https://github.com/webtorrent/webtorrent) and on lessons from earlier
attempts ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), section 2.3, and
[w1-07](research/w1-07-prior-art.md)):

| Project | What it taught us |
|---|---|
| ZeroNet | a shared local origin produced repeated sandbox escapes, and "visitors host everything" invited spam: use per-site origins and bounded hosting |
| Beaker and Dat | slow first paint and nobody online killed stickiness: keep the loader small and the host in the loop |
| IPFS gateways and the Service Worker gateway | a static bootstrap, a Service Worker and in-browser verification work, but free gateways and sponsors come and go |
| PeerTube | it removed WebTorrent playback and kept peer-to-peer behind an HTTP origin: the origin first, peers as an accelerator |
| PeerWeb | a same-origin iframe is not a boundary between untrusted sites, and "Connecting to peers" with nobody online is a dead end |
| [KayleePop/magnet-web](https://github.com/KayleePop/magnet-web) | an earlier project with the same name and the same Service Worker plus iframe idea (MIT, last commit 2022-12-14) |

What felinar adds: the web seed as the floor, so a site loads with nobody online; the site's own origin and
unchanged URLs; a signed pointer with expiry, key rotation and withdrawal; consent before any peer, tracker,
STUN or DNS-over-HTTPS connection; drop-in mode for existing sites; and the site ledger for shared data.

## v0.3: sign-in for any site and the honest ceiling

> **Status: v0.3, built and reviewed.** This section is about v0.3 as built from the design in
> [review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md) (cited "R"; a number after R is its section), as 0.3.0
> runs it. Everything above stays true in 0.3.0. Each benefit below comes with its condition, as everywhere on this page.

### Sign in to any site, in plain words

You keep one identity, and you open it at one address: the **identity page**. A site you visit never sees your 12
words, never holds your identity in a form it can open (with a passkey it keeps a sealed copy that it cannot open), and
never sees the keys you use on other sites. When you sign in to a site, the
identity page opens in its own window, shows that site's address (taken by the browser, not by the site) and what the
site asked, and you approve with a passkey or a passphrase. The site then gets one of two things:

- **a signed proof** that a key signed in, if the site has a server that mints its own sessions; or
- **keys for that site only**, if it is a felinar site, so that it can sign what you post there.

By default your key is different on every site. Two sites cannot tell that you are the same person by your key. You may
choose to use on one site the same identity as on another; the card names the other site. That choice needs a second
deliberate press, says that both sites will then know it is you and that this cannot be undone once the site has seen
it, is offered at most once in 30 days for each site (chosen), and is never made for you by a page.

**felinar never asks for your 12 words on the site you are signing in to.** You type or see them only at the identity page. If a site, a
widget or a pop-up asks for them, it is not us.

| What you get | How | The condition |
|---|---|---|
| One identity for many sites, with no password | the identity page; a passkey or a passphrase unlocks it | your passkey provider (iCloud Keychain, Google Password Manager or another) stores a credential for the identity page and its account recovery becomes a way back in; losing both the 12 words and the backup file loses the identity |
| A different key on every site | per-site keys derived at the identity page | your IP address, the time you are active, a reused name and your writing style can still link your activity on several sites |
| Sign out means signed out | signing out deletes that site's keys from the browser | "Stay signed in" is your choice and keeps them; code on a site you are signed in to can copy your keys for that site while you are |
| A recovery you control | 12 words, an optional extra word, a backup file with a generated passphrase, a link between your own devices | anyone who learns the 12 words can act as you on every site (they cannot open older content without the backup file or an unlocked device), and a person who types the words into another page loses every identity |
| Your own sites on a hub, as a social network | each person's data is their own ledger | a hub that pins is central storage that its operator pays for and can be compelled to empty; the hub serves the loader for every site, so a hostile hub could take a personal site's owner key |

### Private messages, photos and videos

Messages, a private record and private photos and videos are encrypted before they leave your device, and peers, trackers
and holders see only ciphertext, its padded size and timing. "Encrypted" has conditions, and they are on the cards:

- Other visitors and anyone holding a copy of the ledger see only ciphertext. The site's own code can read your record
  while you are signed in.
- The owner cannot read private lanes from the ledger or the swarm; the owner can read them through the code visitors run.
- The people you share with can keep what you send. Revoking a share works in honest apps only.
- A direct message is not provable to a third party, and the person who gets it knows who wrote it. A message in a
  group can be proved to others by any member, and a public room is signed.
- Messages have no forward secrecy: whoever later gets a recipient's chat key can open the envelopes they recorded.
- A video plays only while someone who holds it is online, unless the hub pins it ("Kept by the hub").

Read the whole list in [THREAT-MODEL.md](THREAT-MODEL.md), "Honest limits".

### What needs no backend, and what needs an index

A social network of personal sites is possible without a backend for some things and impossible for others. The design
answers each premise (R 3.2.1):

| Premise | Answer |
|---|---|
| A chronological follow feed needs no backend processing | True. The browser merges the recent windows of the ledgers it follows, newest first |
| A global ranked feed, search across everyone, trending, spam fighting at scale | These need an index over everyone's data. **Out of scope for v0.3, and said plainly** |
| Storage is not unlimited | Content lives while its author's devices, its readers (who opt in) or a pin seed it |
| "Global and scalable" | Per-identity sharding: each person's data is one ledger, and a member syncs only what they follow, within caps that gate rows measure |

The honest ceiling (R 3.6): what the design does, and what would close the gap. Each way of closing a gap would be a
labelled backend or a central component, and none is in v0.3.

| Capability | In this design | What would close it |
|---|---|---|
| A chronological feed of the people you follow | yes, while their windows are reachable | |
| A ranked or algorithmic feed, trending | no | a hub indexer that crawls ledgers as a peer |
| Search across everyone | no; only what your browser holds | the same indexer |
| Replies and mentions from people you do not follow while you are offline | only through notices held by the hub's pin mailbox (proposed: no page sends it frames yet) | the mailbox (a central component) |
| Global follower counts and like counts | no; counts are of what you can see, or reported by the author | an indexer |
| Spam fighting across the hub | per ledger only (bans, the fee, `allow` lists, premoderation) | a hub reputation service |
| Push notifications when the page is closed | no | a Web Push relay |
| Durability for people who only use phones | only with the hub pin | the hub pin (central storage) |

Without a pin, for a typical person whose ledger 20 followers read three times a day with each session open for 120
seconds, nobody who holds the ledger is online 98 percent of the time and nobody who holds their media is online 99
percent of the time (a model, with the lab and the arithmetic in [DEPLOY.md](DEPLOY.md#central-storage-the-hub-pin-and-snapshot-service);
the real figure is gate row G-SC-4). That is why a hub that wants its members reachable runs a pin, and why the app says
which case an item is in.

### Pseudonymous, not anonymous

The statement below is the one used in the app's help, the FAQ and the privacy page (R 2.18).

> felinar identities are **pseudonymous by design**: a key, not a person, and by default a different key on every
> site. They are **not anonymous**. Whenever your browser connects to other visitors, they see your IP address, and so do
> the connection servers (trackers and STUN) and any relay; they can see when you are active and, for the sites you
> open, link your activity on several sites by that address. **Host-only mode** connects to nobody but the site's own
> host, so other visitors see nothing of you, but chat, file sharing and private media do not work there and the host
> still sees your address. **Tor Browser** hides your address from the host and the connection servers for what it can
> carry, but it does not run WebRTC (to be confirmed from a primary source), so in Tor Browser you can read and sign
> in but cannot connect to other visitors. Nothing in felinar proves who you are, your age or that one key is one
> person.

### Readers who agree help carry the site, and calls

> **Status: v0.3 C2, built and reviewed.** What the seeding, zero-setup and calls work of phase C2 gives, each with its price (built and integrated
> on 2026-10-20, tested on loopback only)
> ([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), "SZ"; [ARCHITECTURE.md](ARCHITECTURE.md) 8.1 and 15.14).
> Nothing below is measured on a phone yet ([DEMO-RESULTS.md](DEMO-RESULTS.md), rows G-PS and G-CL). Browser only: a member installs nothing.

Readers who agree help carry this site while their page is open. That is the whole promise, and it is a qualified one. The line never says that every
reader is a mirror: a visitor shares only after choosing to, a phone only while the page is on screen, and a site that nobody has open is carried by
nobody. What the design adds is honesty about it: labels that say what is known ("Only on this device", "Kept by you and at least N others online now
(reported)", "Kept by the site (checked N minutes ago)", "Nobody who has this is online right now"), a meter that shows measured bytes by source
for the visit and never a score, and a pin node, run by the owner or a hub, for the part that has to stay.

| What you get | How | The condition and the price |
|---|---|---|
| Readers carry part of the load | a reader who chose "Share and load" passes pieces on while the page is open; a desktop tab can stay in "Keep this site" mode; a phone on a charger can run dock mode | a phone shares only a budget (a month cap, a session cap) and only while the page is on screen; the people it connects to see its IP address, and sharing a file shows which file it holds |
| Honest availability labels | a label comes from evidence: this device, the peers' bitfields, a probe of the host's copy, a pin's signed receipt | a count of holders is the peers' own claim, so it reads "at least" and "reported"; only a pin node makes something stay available |
| An upload that reaches the site | a phone hands its own upload to the owner's pin node, which answers with a signed receipt | the page has to stay open until it says "Kept by the site"; the owner or a hub runs a pin node (`tools/pin.mjs`) |
| A site with no domain | `ship` to a rented server named like `203-0-113-7.nip.io`, GitHub Pages, or a hub link | the name costs nothing and needs no sign-up, but the server is rented under an account its provider can close (GitHub Pages is an account too); the name is the server's IP address and changes with it; `nip.io` is run by two volunteers; the signed address record expires (399 days at most) |
| Calls between members: voice, video and screen sharing | a call between contacts runs directly between their browsers, with no server in the media path | every participant sees your IP address once you accept; 6 people with audio only, 4 with video (chosen caps); iPhone video stops when you leave the page; a call rings only while the other person has the site open; 10% to 30% of pairs may need a relay that the site owner has to run (a planning range, not a measurement) |

#### What cannot be done

The plain words, as they are used in the FAQ, DEPLOY and the cards (SZ 3.4).

**On phones.** A phone stops sharing, passing on messages and keeping files available seconds after you leave the page or lock the screen (iPhone: about
20 seconds). No website can wake a phone to share: the background tasks browsers allow only make web requests. An iPhone gives web pages no background sync,
no battery or network information, and a notification for every push. Safari deletes a site's saved data after 7 days without use; a Home Screen app keeps
it. Android cuts the network of a phone that is unplugged, still and dark. On iPhone, call video stops when you leave the page, a Home Screen app loses the
microphone too, and a phone call pauses it. Android browsers cannot share the screen. A call rings only while the site is open.

**Without a domain.** The address record lives in the page and expires; after that date new visitors cannot load the site until you publish again. A name made
from the server's IP address changes with the IP, and visitors start again. nip.io is run by two volunteers with no uptime promise and blocks addresses used
in phishing. A bare IP address cannot keep passkeys. Home connections behind carrier-grade NAT cannot be reached. Free hosts can close accounts; tunnels see
everything and rename every run.

**Anywhere.** Without a pin node or a host copy, nothing stays available while nobody who has it is online. Peers see your IP address, and sharing a file
shows which file you hold. Calls above 6 people (4 with video) need a mixing server, which v0.3 does not have. Plan for 10% to 30% of pairs needing a relay to
connect (a planning range, not a measurement).

## Where to go next

- [QUICKSTART.md](QUICKSTART.md): publish a site, step by step.
- [MIGRATION.md](MIGRATION.md): move an existing site.
- [CRUD.md](CRUD.md): model shared data on the ledger.
- [CRITIQUE.md](CRITIQUE.md): the harshest case against this design.
- [THREAT-MODEL.md](THREAT-MODEL.md) and [PRIVACY.md](PRIVACY.md): who sees what in the v0.3 design, and its honest limits.
- [ARCHITECTURE.md](ARCHITECTURE.md): how it works, exactly.
