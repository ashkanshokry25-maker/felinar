# R1 - Landscape and differentiators: magnet-web against what exists

- **Project:** magnet-web 0.2.1, research for v0.3 (the WHY, identity, chat and files).
- **Date:** 2026-10-20. All "access date" entries below are 2026-10-20 unless stated.
- **Author:** research agent R1 (landscape-differentiators).
- **Builds on, does not repeat:** [w1-07-prior-art](../w1-07-prior-art.md) (ZeroNet, Maelstrom, Beaker, IPFS, Fleek, Skynet, Arweave, Swarm, Peergos, Freenet, nsite, PeerTube; researched 2026-10-17), [WHY.md](../../WHY.md), [CRITIQUE.md](../../CRITIQUE.md), [w2c-03-identity-ux](../w2c-03-identity-ux.md) and its VERIFY, [SECURITY-MODEL.md](../../SECURITY-MODEL.md), [PRIVACY.md](../../PRIVACY.md).
- **Confidence scale:** High = primary page fetched this session (or taken from a cited repo doc that itself read a primary page); Medium = one primary page read through a model-summarised fetch, or one news source; Low = search snippet, background knowledge not re-checked, or my inference (always labelled).
- **Method limits (read this).** WebFetch returns a model summary of a page, not the page; where a summary said a topic "is not covered", I record that as NOT VERIFIED rather than as a negative. WebSearch returned unrelated results for one query (Pear) and no confirmation for another (Web5). No browser was launched against any non-local address (docs/DEV-NETWORK.md). Items I could not verify are listed in section 7 and marked UNVERIFIED in the text. Nothing here is legal advice.
- **Wording:** this file follows the project rules: "no backend", "site ledger", and no claim of resistance to takedown, unstoppability or full decentralisation. Where I quote another project's words, the quotation is theirs.

---

## 1. Summary (10 bullets)

1. **Nothing in the landscape does what magnet-web's loader does in one piece.** The closest relatives each drop one of its properties: the IPFS Service Worker gateway gives in-browser verification but the site lives on a gateway-controlled origin and has no shared-data layer; nsite gives signed manifests on Nostr but, per the gateway's own README, serves through a server-side gateway; Pear gives signed logs and peer hosting but needs an installed runtime and, per its docs page, does not mention browsers; ZeroNet had a per-site database but needed a local client and is frozen. The combination "same-URL site from a plain static host, verified in the browser, optional peers, signed per-site log, no install" is unoccupied. That is a statement about a gap, not proof the gap matters (section 5).
2. **Identity is where magnet-web is weakest, not strongest.** Nostr (one keypair, NIP-07 signer in the browser, cross-app), atproto (DID plus handle, portable between PDSes) and Farcaster (onchain id) all give an identity that works across sites and apps. magnet-web's identity is one P-256 key per browser profile and per site, with export/import in Settings. That is simpler, has no operator, and does not leak across sites, but it is not portable across sites and has no recovery beyond the export. For v0.3 the honest pitch is "per-site, self-owned, exportable, with an optional bridge to a wider identity", not "better identity".
3. **Every system with shared data has an operator somewhere.** Nostr: relays and Blossom servers. atproto: a PDS, a relay, an AppView and the did:plc directory (being moved to a Swiss association). Farcaster: Snapchain nodes plus an onchain registry, with the protocol's stewardship sold to Neynar in January 2026. ActivityPub: your server. Solid: your pod host. Local-first sync engines (Zero, Electric, PowerSync): a Postgres database and a sync service. magnet-web's site ledger has no operator in the data path, but pays for that with no availability guarantee when nobody holding a copy is online.
4. **The incumbents are not weak on price for small sites.** Cloudflare Workers Free gives 100,000 requests a day and static asset requests are free and unlimited; Vercel Hobby includes 100 GB of Fast Data Transfer a month (non-commercial only); Firebase Spark and Supabase Free cover small apps. magnet-web cannot honestly claim a cost advantage for a small site (WHY.md already says so). Its cost argument exists only for traffic that would be billed per GB, and for freedom from a vendor's pause, pricing and terms.
5. **The strongest true reason is independence, not savings.** Free tiers have rules that can change or stop a site: Supabase pauses a free project after 1 week of inactivity; Vercel Hobby is non-commercial only; free IPFS gateways ended on 2026-09-21; Fleek Hosting shut down on 2026-01-31 (per w1-07). A site whose files and data a visitor can re-serve survives the end of a free tier for returning visitors. That claim is true only after a first visit and only while a copy exists.
6. **Two big projects in this space changed hands or ended in 2026, which supports "do not depend on one steward".** Neynar announced it was acquiring Farcaster on 2026-01-21 (founders stepping back from day-to-day work). Replicache is in maintenance mode and its users are told to move to Zero. Pinning and hosting services closed repeatedly (w1-07 section 3). A single-file loader that any static host can serve has no steward to lose, but it also has one maintainer today.
7. **Survivors of honest scrutiny (section 5):** (D1) the site at its own origin with unchanged URLs, from a plain static host, no install; (D2) drop-in under an existing site with one script tag that fails open to the host; (D3) the host's web seed as the floor with peers as an optional accelerator, and consent before any peer, tracker, STUN or DNS-over-HTTPS connection; (D4) a per-site signed, hash-linked log with owner and moderator control decided inside the log, with no relay, hub or PDS in the data path; (D5, narrower) no account and no operator for the site's own identity: a visitor can write after one click, under a key only the browser holds.
8. **What magnet-web lacks versus each rival is large and should be said first** (section 4): private or access-controlled data, search and queries over big data, any availability guarantee, cross-site identity, social graph, payments, server-side secrets, SEO for shell mode, mobile seeding, and a track record (0.2.1, tested over loopback on one machine per CRITIQUE.md).
9. **Chat and file sharing (new requirement) have good precedent for the transport and poor precedent for privacy.** Hyperswarm/Keet-style blind peers and Nostr relays solve offline delivery with an always-on third party; Trystero, Bugout and P2PT (w1-07) show tracker-rendezvous WebRTC messaging in browsers works but depends on volunteer trackers. Every one of them exposes IP addresses to peers and swarm membership to the rendezvous service. The v0.3 design must state that, as the owner asked, and offer relays or host-only modes as mitigation (section 6).
10. **Top recommendations (section 6):** P0 write the comparison as a table of "who runs / who holds identity / what breaks" into WHY.md with these sources; P0 drop "identity" from the differentiator list and describe it as per-site and exportable; P1 specify a NIP-07-shaped signer adapter and a did:key export so a visitor can bring a Nostr or other key, without making Nostr a dependency; P1 publish a pin-node recipe as the answer to availability; P2 a "what only we do" page limited to D1 to D4.

---

## 2. Basis

Statements about magnet-web come from the repo docs listed above and the v0.3 brief, not from reading source. Operator: an HTTPS static host (also the web seed), WebSocket trackers, STUN, optional DoH. Identity: owner key signs the pointer; each visitor has a P-256 key per browser profile (`p256:` tag, export/import). Payer: the owner pays the host; visitors pay bandwidth only if they share (off by default on phones). Breaks: new visitors need the host; ledger data spreads only while a holder is online; no finality; ledger public; host and DNS are the trust root (SECURITY-MODEL.md, WHY.md).

---

## 3. Findings: system by system

Each entry answers the four questions asked (who runs the infrastructure, who holds identity, who pays, what breaks) and gives the 2026 status. Rows marked "see w1-07" are summarised from that file's research of 2026-10-17 and I did not re-fetch them.

### 3.1 IPFS, Fleek, Pinata and public gateways (see w1-07, F-series)

- **Who runs:** content is served by whoever pins it: your own node, a pinning service, or public gateways. Since 2026 the public `ipfs.io` and `dweb.link` hostnames hand the browser a Service Worker that fetches and verifies blocks locally; the HTTP gateway was scheduled to retire on 2026-09-21 (w1-07 summary 2).
- **Who holds identity:** nobody by default. Mutable names use IPNS (a key) or DNSLink (a DNS TXT record) or ENS; none gives visitors an identity.
- **Who pays:** the pinner. Pinning services are a business; w1-07 lists closures: Scaleway pinning 2024-11-27, NFT.Storage Ltd 2025-04-16, Fleek Hosting 2026-01-31, Shipyard 2026-09-30.
- **What breaks:** content disappears when the last pinner stops; names depend on resolver honesty; free gateways are sponsor funded. Brave removed native `ipfs://` on 2024-08-22 for low use (w1-07 summary 1).
- **Relation to magnet-web:** the IPFS Service Worker gateway is the nearest architecture (static bootstrap, Service Worker, in-browser verification, one origin per site). It differs in that the site lives at a gateway-derived origin (path or subdomain of the gateway), there is no per-site signed log, and bytes come over HTTP from gateways and libp2p peers. Whether DNSLink lets a site keep its own domain through the Service Worker gateway is not something I verified (UNVERIFIED; w1-07 covers DNSLink parsing, not this).
- **Confidence:** High for the closures and dates (w1-07 read primary pages); Medium for the Service Worker gateway details (w1-07 says several were read through summarised fetches).

### 3.2 Nostr: NIP-07 identities, relays, Blossom, nsite

- **Who runs:** relays (anyone) store and forward signed events; Blossom servers store blobs addressed by SHA-256 and expose HTTP endpoints; nsite gateways turn manifest events into web pages. Sources: Blossom README lists BUD-00 to BUD-12 covering retrieval, upload, mirroring, payment and authorisation, blobs "addressed by their SHA-256 hash", auth by kind 24242 events, user server lists as kind 10063 (https://github.com/hzrd149/blossom, accessed 2026-10-20; Medium, summarised fetch). nsite-gateway: a Deno/Hono app that maps the hostname to a site (npub subdomain, snapshot label or named-site label, or CNAME), fetches the manifest and blobs and verifies blobs by hash; manifests are kinds 15128, 35128 and 5128; it relies on lookup relays for kind 10002 and 10063 events (https://github.com/hzrd149/nsite-gateway, accessed 2026-10-20; Medium). The same repo page showed 158 commits, 19 stars and 11 forks that day, which indicates a small project (Medium).
- **Who holds identity:** the visitor, as a keypair. NIP-07 is a draft, optional spec for `window.nostr` with `getPublicKey()` and `signEvent(event)`, plus optional `nip44.encrypt/decrypt` (https://github.com/nostr-protocol/nips/blob/master/07.md, accessed 2026-10-20; Medium). The key lives in an extension or a remote signer, not in the site, so one identity works on every site and the site never sees the private key. That is a real structural advantage over magnet-web's per-site key, whose "non-extractable" property protects against theft and not against same-origin use (w2c-03 F1).
- **Who pays:** relay operators and Blossom operators; some relays and Blossom servers charge (BUD-07 "payment required" exists). OpenSats funds Blossom (search result https://opensats.org/topics/blossom, Low: snippet only).
- **What breaks:** relays keep what they choose; there is no global availability promise; the web-page path still goes through a trusted server gateway (w1-07: "no client-verifying implementation found"; I did not re-verify that this still holds in October 2026).
- **Relation to magnet-web:** Nostr is the most natural identity partner, not a rival. A site that already accepts `window.nostr` could sign ledger entries with the visitor's Nostr key. The cost: Nostr uses secp256k1 Schnorr signatures; magnet-web entries are algorithm-tagged (`p256:` today), so an added tag is possible by design, but a new tag changes the block format and needs a version decision (see Recommendations). Not verified: whether NIP-07 extensions in 2026 are installed widely on mobile, where most visitors are (UNVERIFIED).
- **Lacks vs Nostr:** social reach and existing clients, relay-level search, zaps/payments, cross-app identity.
- **Adds vs Nostr:** the site itself at its own origin from a plain host; a deterministic per-site order and moderator model inside the log, rather than "whatever each relay stored".

### 3.3 AT Protocol and Bluesky: DID:PLC, PDS, relays, AppViews

- **Who runs:** a PDS holds each user's data repository and can be self-hosted (Bluesky runs many PDSes behind an entryway; community implementations exist, per https://atproto.com/guides/self-hosting, accessed 2026-10-20; Medium). Relays replicate from all PDSes; "AppViews are resource-intensive and generally need to replicate network data". The did:plc directory maps a DID to the signing keys and the PDS; Bluesky announced in September 2025 that it is supporting an independent organisation, formed as a Swiss association, to operate the directory, setting policy and rate limits (search result summary, Medium: https://www.manton.org/2025/09/19/bluesky-is-spinning-out-the.html and https://atprotocol.dev/bluesky-and-did-plc/, accessed 2026-10-20; I could not fetch the primary post on bsky.network, so board and handover dates are UNVERIFIED). A community post in the same search noted close to all accounts use did:plc.
- **Who holds identity:** the user holds rotation keys in principle; in practice most accounts rely on the PDS operator to manage them. Changing a PDS's domain means updating the PLC entry for each hosted account (self-hosting guide). I did not verify how many users hold their own rotation key (UNVERIFIED).
- **Who pays:** the PDS operator (Bluesky for most users), relay and AppView operators.
- **What breaks:** the directory is a single logical service even after the spin-out; relays and AppViews are expensive to run so few exist; app-level moderation is by the AppView.
- **Relation to magnet-web:** atproto gives a handle and DID that survive a change of host, at the price of an always-on PDS per user. The w2c-03 v2 idea (domain-based name verification via TXT/DoH) is the cheap analogue.
- **Lacks vs atproto:** portable accounts, a large graph, apps, durable storage. **Adds:** no per-user server.

### 3.4 Solid pods and WebID

- **Who runs:** a pod provider or yourself; WebID profile documents are "a single document" served by Solid servers; reading uses HTTP GET and writing uses PUT or PATCH (https://solid.github.io/webid-profile/, accessed 2026-10-20; Medium). The `solid:oidcIssuer` property names an identity provider that authenticates the WebID owner via Solid-OIDC.
- **Who holds identity:** the WebID URI is controlled by whoever controls the profile document's host; login goes through an OIDC issuer. The Solid project's own about page says only that data stays yours "even when you change providers" (https://solidproject.org/about, accessed 2026-10-20; Medium) and says nothing on adoption. Adoption and 2026 spec status: UNVERIFIED.
- **Who pays:** the pod host.
- **What breaks:** the pod server and the OIDC issuer are always-on dependencies; access control is server enforced.
- **Relation to magnet-web:** Solid suits private data on a server you choose, which magnet-web cannot do. Not a v0.3 item.

### 3.5 Farcaster

- **Who runs:** identity and keys are onchain on OP Mainnet; most actions (posts, follows, reactions) live off-chain in a peer-to-peer server network called Snapchain (https://docs.farcaster.xyz/learn/architecture/overview, accessed 2026-10-20; Medium). The page does not say who operates the servers. 
- **Who holds identity:** an onchain account (fid) with keys the user adds for apps. 
- **Who pays:** registration and storage rent are paid onchain (the page says onchain use is kept minimal; I did not verify current prices: UNVERIFIED). 
- **What breaks / 2026 status:** Neynar announced on 2026-01-21 that it is acquiring Farcaster (the protocol, the app and Clanker) from Merkle Manufactory; the founders step back from day-to-day work; Merkle said it would repay investors the $180 million raised and that the protocol is "not shutting down" (https://neynar.com/blog/neynar-is-acquiring-farcaster and https://www.theblock.co/post/386816/farcaster-repays-venture-backers, via search summary, accessed 2026-10-20; Medium; one aggregator claiming the reverse acquisition conflicts with all primary-looking sources and is disregarded). Reported usage in December 2025 was 250,000 monthly active users (same source, Medium).
- **Relation to magnet-web:** a cautionary tale about a funded steward leaving, not a technical rival. Its identity needs a chain wallet and money, which magnet-web's no-account model avoids on purpose.

### 3.6 The Fediverse (ActivityPub)

- **Who runs:** each user is an actor on a particular server; servers deliver to each other's inboxes. The W3C spec ties object identity to the originating server: identifiers should be dereferenceable URIs "with their authority belonging to that of their originating server" (https://www.w3.org/TR/activitypub/, accessed 2026-10-20; Medium via summary). It also states that once content reaches a remote server the protocol cannot force deletion; deletions are requests.
- **Who holds identity:** the server that hosts the account (domain plus username). Portability between servers is not specified in that document (the summary says no portability section; any Mastodon-specific migration detail is background knowledge, Low).
- **Who pays:** instance operators, often donations.
- **What breaks:** the instance dying or its admin changing policy; spam handling is left to implementations ("Filtering for spam is recommended but not specified").
- **Lacks vs ActivityPub:** a large network, mature clients, admin moderation tools, durable storage. **Adds:** no server; but no interoperability either (a ledger is not an actor).

### 3.7 Hypercore, Holepunch, Pear, Keet (see also w1-07)

- **Who runs:** nobody in the data path by design; but availability needs holders. Hypercore is "a secure, distributed append-only log" using "signed merkle trees", each core with its own key pair; the current line is Hypercore 10 (https://github.com/holepunchto/hypercore, accessed 2026-10-20; Medium). Pear is an installable runtime that "loads applications remotely from peers" and runs on Bare; targets desktop, mobile and terminal; the docs page does not mention browsers; it documents "blind peering" to keep data available when peers are offline (https://docs.pears.com, accessed 2026-10-20; Medium). The page does not say who runs any infrastructure.
- **Who holds identity:** the core's key pair; there is no accounts layer in the log itself.
- **Who pays:** peers; blind peers need an operator.
- **What breaks:** data is available only while a holder is online, which is why blind peers exist (w1-07 row "Pear / Holepunch"). A browser page cannot join the Hyperswarm network directly without a proxy (inference from the docs not mentioning browsers, Low; I did not verify any hyperswarm-web gateway status).
- **Relation:** closest in log design and in chat (Keet; its 2026 status UNVERIFIED), but needs install. Hypercore is single-writer unless layered (Autobase, per w1-07); the magnet-web ledger is multi-writer.

### 3.8 Secure Scuttlebutt (SSB)

Peers plus "pubs" relay append-only feeds, one identity key per feed (https://scuttlebutt.nz, accessed 2026-10-20; Medium, navigation only). 2026 maintenance state: UNVERIFIED. Treat as precedent for signed logs plus gossip, already cited in WHY.md.

### 3.9 Freenet and Hyphanet, Peergos, ZeroNet, Beaker, Maelstrom (see w1-07)

Not re-researched; the conclusions I rely on are from w1-07 (2026-10-17):

- **ZeroNet:** needed a local Python client; a per-site SQLite database rebuilt from signed JSON; six security fixes from the shared-origin wrapper in three years; original frozen after 2019, forks with one maintainer each. Why it ended: creator silence, no governance, install friction, spam and centralised identity (zeroid), legal exposure.
- **Beaker and Dat/Hypercore:** an Electron browser; archived 2022-12-27; slow first paint, no stickiness, not in other browsers, no mobile.
- **Maelstrom:** a closed Chromium fork, dead by 2016; no update path; seeded with no visible indicator.
- **Freenet (new, Rust) and Hyphanet:** a local node plus an HTTP proxy; the new network launched 2026-03-15 and is "still alpha". Contract state is merged; no DNS by design. Not a drop-in for ordinary sites.
- **Peergos:** end-to-end encrypted storage and sharing; you need a Peergos server, either the paid peergos.net or your own (w1-07). Its site says it uses X25519 and MLKEM-1024 for hybrid sharing, offers expiring or password-protected links and has two published audits (https://peergos.org, accessed 2026-10-20; Medium). It is the best existing reference for private file sharing, and it has an operator by design.

### 3.10 Local-first stacks: Automerge, Yjs, Replicache, Zero, ElectricSQL, PowerSync

These are libraries for application state, not site delivery. They answer a different question ("how do I make an app feel instant and offline-capable with sync") and mostly assume a server.

| Stack | Server in the data path | Identity | 2026 status (source) | Notes |
|---|---|---|---|---|
| Automerge | none required: "network-agnostic", works client/server, peer-to-peer or by passing files | none built in | Automerge 3 migration guide exists; keyhive guides "Coming Soon" (https://automerge.org/docs/hello/, accessed 2026-10-20; Medium) | CRDT library only; no site delivery, no authentication layer yet |
| Yjs | none required; providers for WebRTC, WebSocket, Hyper; hosted options (Liveblocks, Y-Sweet, Tiptap) | not covered by Yjs | docs page https://docs.yjs.dev, accessed 2026-10-20; Medium | the page does not name y-webrtc or y-websocket; signalling not covered there |
| Replicache | your backend | yours | maintenance mode: "no longer charges", no new features, users should migrate to Zero (https://replicache.dev, accessed 2026-10-20; Medium) | a closed chapter |
| Zero (Rocicorp) | zero-cache plus your database (architecture not in the page I fetched) | yours | "a sync engine for web apps"; alpha/beta label not verified (https://zero.rocicorp.dev/docs/introduction, accessed 2026-10-20; Medium) | queries sync a local datastore |
| Electric | Postgres plus an Electric service; "a read-path sync engine for Postgres" over HTTP "Shapes"; writes go through your API; Electric Cloud recommended for production (https://electric.ax/docs/intro, redirected from electric-sql.com, accessed 2026-10-20; Medium) | yours | active; the redirect to electric.ax shows a rebrand or domain move | PGlite = browser Postgres |
| PowerSync | a PowerSync Service replicating from Postgres, MongoDB, MySQL (beta), SQL Server (beta) and others to in-app SQLite (https://docs.powersync.com/intro/powersync-overview, accessed 2026-10-20; Medium) | yours | active; many SDKs | pricing not on the page I fetched |

- **Relation:** these tools make an app with a backend feel local. magnet-web removes the backend for public, small, append-style data. They overlap only on "offline-capable shared state". Automerge and Yjs are plausible inside a future `mw.db` document type (an idea, not a recommendation; the project chose a signed log over CRDTs in research 06).
- **Lacks vs these:** relational queries, fine-grained permissions, large datasets, server-validated writes.
- **Adds vs these:** no database to run at all.

### 3.11 Urbit

The fetched Urbit ID page says an ID is "a hierarchical deterministic crypto wallet" with proxies so it can be used without the master key (https://docs.urbit.org/user-manual/id.md, accessed 2026-10-20; Medium). Hosting, cost, adoption and 2026 status: UNVERIFIED. It needs a running ship and a scarce paid identity, a different philosophy from a free per-site key. Not a competitor.

### 3.12 Web5 and TBD DIDs

- The Web5 JS SDK repository showed no archive banner, 743 commits and "DWN" support; most recent dated reference was Hacktoberfest 2024; several agent packages were marked "coming soon" (https://github.com/TBD54566975/web5-js, accessed 2026-10-20; Medium). A search turned up a deprecated npm package under the old scope (https://npmjs.com/package/@tbd54566975/web5, Low: snippet only) and no confirmation of any shutdown or handover. I cannot say whether TBD's Web5 work is maintained in October 2026 (UNVERIFIED).
- **Concept:** Decentralized Web Nodes store a user's data on nodes they or a host operate, with DIDs as identity. That is a PDS-like operator model again.
- **Relation:** the P-256 `did:key` form (multicodec 0x1200) is already noted in the identity research as a compatible export format (w2c-03-VERIFY, row 4, citing the did:key spec https://w3c-ccg.github.io/did-key-spec/). That is a cheap way to be DID-compatible without adopting any DWN stack.

### 3.13 Incumbents: Firebase, Supabase, Cloudflare Workers and Pages, Vercel, Netlify

| Service | Who runs / who pays | Identity | Free tier facts used here (source, access 2026-10-20) | What can break for a small site |
|---|---|---|---|---|
| Firebase | Google; pay-as-you-go on Blaze | Firebase Auth / Identity Platform | Firestore free: 1 GiB stored, 10 GiB/month egress, 20K writes/day, 50K reads/day (Standard edition); Auth free up to 50K MAUs; phone auth billed per SMS (https://firebase.google.com/pricing; Medium) | quota caps; vendor lock-in; account tied to a Google account |
| Supabase | Supabase (Postgres, Auth, storage); you pay Pro from $25/month | Supabase Auth | Free: 2 active projects, 500 MB database, 5 GB egress, 50,000 MAUs, **pauses after 1 week of inactivity** (https://supabase.com/pricing; Medium) | an idle site's backend pauses |
| Cloudflare Workers | Cloudflare; Paid from $5/month | yours (or Access) | Free: 100,000 requests/day, 10 ms CPU per invocation; "requests to static assets are free and unlimited" (https://developers.cloudflare.com/workers/platform/pricing/; Medium) | daily request cap on dynamic parts |
| Cloudflare Pages | Cloudflare | n/a | docs recommend new projects start with Workers and link a Pages-to-Workers migration guide; Free plan limit 500 deploys/month (https://developers.cloudflare.com/pages/; Medium) | product direction changes |
| Vercel | Vercel | yours | Hobby: 100 GB Fast Data Transfer, 1,000,000 CDN requests, 1,000,000 function invocations; **non-commercial, personal use only**; exceeded limits mean waiting 30 days (https://vercel.com/docs/plans/hobby, page updated 2026-09-14; High) | commercial use needs Pro ($20 per developer seat per month) |
| Netlify | Netlify | yours | Free: 300 credits/month; bandwidth 20 credits/GB, requests 2 credits per 10,000, production deploy 15 credits; Pro $20/month with 3,000 credits (https://www.netlify.com/pricing/; Medium) | credits run out; pricing model has changed before (inference: the credit model is new to me, so I treat it as recent) |

- **Honest reading:** for a small static site with a comment box, the incumbents are free and easier. magnet-web's case is not "cheaper than free". Its case is that nothing in the path is a vendor's account, free-tier rule, pause policy or acceptable-use clause, and the shared data is a file format that visitors hold.
- **Lacks vs incumbents:** private data, auth with real accounts and recovery, server-side secrets (payment keys, email), SQL, analytics, preview deploys, support, uptime guarantees, SEO for shell mode.

---

## 4. What magnet-web lacks

The per-system tables in section 3 give the comparison; this is the plain list of gaps versus the field.

1. Private or access-controlled data. Everything in the ledger is public and copied to every visitor (SECURITY-MODEL.md "What is not protected").
2. Availability with nobody online. Peers can withhold entries; the host snapshot or a pin node is the floor.
3. Cross-site identity and a social graph (Nostr, atproto, Farcaster, ActivityPub have both).
4. Accounts with recovery, passwords or email links, rate limits tied to real accounts.
5. Server-side secrets and effects (payments, email, webhooks).
6. Queries over large data. The ledger is capped (w1-07 mentions a plan cap of 50,000 blocks; check the code before quoting).
7. Search-engine visibility for shell mode (CRITIQUE.md "Shell mode hides the site from crawlers").
8. Mobile peer support. Phones are mostly downloaders (WHY.md).
9. A track record, an audit, a second maintainer, a community. CRITIQUE.md states 0.2.1 was tested over loopback on one machine and never on a real phone.

---

## 5. What only magnet-web does, and the differentiators that survive scrutiny

### 5.1 Candidate list and test

For each candidate I ask: does a named rival already do it, and is the claim true of the current code?

| Candidate | Rival that does it | Verdict |
|---|---|---|
| Site served with no backend | every static host; IPFS; nsite | Not a differentiator on its own |
| Content verified by hash in the browser | IPFS Service Worker gateway; Planktos; PeerWeb | Not unique |
| Visitors as peers | WebTorrent, PeerTube (removed), PeerWeb | Not unique; and the benefit is real only for large sites (WHY.md economics) |
| Signed per-site log | Hypercore, SSB, ZeroNet, Nostr events | Not unique as an idea |
| Self-owned identity | Nostr, atproto, Farcaster | Rivals do it better across sites |
| No accounts | many sites | Weak; "no account" also means no recovery |
| Cheaper | the incumbents are free for small sites | False for small sites |
| Wide distribution claims | none of the above deliver them | Do not claim |

### 5.2 The differentiators that survive

**D1. The site at its own origin, unchanged URLs, from a plain static host, with no install.** The loader serves the verified site through a Service Worker at the site's own URL (shell mode: same-URL iframe). Rivals: the IPFS Service Worker gateway serves from gateway-derived origins (w1-07 summary 6); nsite needs a server gateway; Pear/Beaker/ZeroNet need installed software. True of the current code per ARCHITECTURE s3.1 and WHY.md "Existing sites". Condition: the first visit trusts the host and DNS (SECURITY-MODEL.md). Counter: PeerWeb and KayleePop/magnet-web did the Service Worker plus iframe idea earlier (CRITIQUE.md "What is new"); the differentiator is the same-URL frame plus the rest of this list, not the Service Worker as such.

**D2. Drop-in: one script tag under an existing site, failing open to the host.** No rival I found in this survey offers a one-tag overlay that leaves every HTML page on the host and degrades to the plain site (WHY.md "What you get"). I did not search for P2P CDN products (PeerCDN, Peer5, Streamroot were listed as unsearched in w1-07), which do solve a related problem for video, so the claim is limited to "static site plus ledger". Condition: filling copies can raise host egress (WHY.md).

**D3. The host is the floor; peers are an accelerator; and nothing peer-to-peer happens before the visitor agrees.** The web seed means a site loads with nobody online; PeerWeb and PeerTube's experience (w1-07) show the opposite failure. Consent-first is rare: Maelstrom seeded with no visible indicator (w1-07). Honest limit: this is a discipline, not a technology no one else could use, and after consent peers and servers see IP addresses.

**D4. A per-site site ledger with moderation decided inside the log, and no relay, hub or PDS in the data path.** Entries are signed, hash-linked and ordered deterministically on every copy; the owner and moderators can remove entries and ban authors; a small hashcash fee slows spam; sites use it through `mw.db` create/read/update/delete (WHY.md). Compare: Nostr needs relays, atproto needs a PDS and AppView, Farcaster needs hubs and a chain, ZeroNet needed its client, Firebase and Supabase need a vendor. Condition: no finality, public data, availability only while a holder is online. An owner can remove content, and copies elsewhere persist (SECURITY-MODEL.md "Takedown").

**D5 (narrower). A visitor can write to a site's ledger with no account and no operator for the key.** One P-256 key per browser profile, created lazily, exportable, algorithm-tagged. Rivals that offer the same "key as account" model are Nostr and SSB, with cross-app reach. So D5 is a convenience of the combination (D1 to D4 plus a key the browser holds), not a unique identity system. For v0.3, the self-owned identity work should be pitched as "authentication through the site ledger with no backend, key held by the visitor, profile record only the visitor can decrypt" (the brief's goal), which is new as a combination, while avoiding any claim that this identity is more portable than Nostr or atproto.

### 5.3 What is the "only" claim, worded to be true

Draft sentence for WHY.md, subject to the owner's edit: "magnet-web is the only system in our survey that serves an ordinary website at its own address from a plain static host, checks every byte in the browser, lets visitors help carry it only after they agree, and gives the site a shared signed log without a database, an account system or an installed app. It does not make the site private, permanent or hard to take down." The words "only system in our survey" are limited to the 20-odd systems in section 3 and w1-07 and must be re-checked before each release because the IPFS Service Worker gateway and nsite are moving.

---

## 6. What this means for magnet-web

### 6.1 Today (true of the current code and docs)

- D1 to D4 hold as described in WHY.md and the architecture; the per-visitor key exists with export and import (brief; w2c-03 gives the v1 plan).
- No connection to peers, trackers, STUN or DoH before the visitor's choice (WHY.md).
- Everything in the ledger is public (SECURITY-MODEL.md).

### 6.2 Upgrade (v0.3, achievable with work)

- **Identity interop without dependence.** Offer an adapter so a site can sign entries through a NIP-07-shaped `window.nostr`-like signer or import a `did:key`, keeping the built-in P-256 key as the default. The brief's goal (visitors own identity; sites authenticate through the ledger; each visitor can decrypt only their own auth and profile record) is compatible with a per-site key. Cost: a new algorithm tag means a block-format decision (see R-IDs below).
- **Name verification by domain** (w2c-03 v2): reuses the TXT/DoH machinery; analogous to Nostr NIP-05 and atproto handles.
- **Chat and files.** Precedent: Trystero, Bugout and P2PT show tracker-rendezvous WebRTC messaging in browsers; Hypercore/Keet-style blind peers and Nostr relays show how offline delivery is solved by an always-on third party; Peergos shows hybrid post-quantum sharing and expiring links with an operator. For magnet-web: presence and messages over the existing peer protocol, end-to-end encrypted between identities, files as torrents referenced from the ledger and optionally encrypted (the brief). The research that the landscape supports: offline delivery requires either a relay or an always-on holder; without one, messages reach only online peers.
- **Residual exposures the design must state** (the owner's requirement): peers and relays see IP addresses; trackers and STUN servers see swarm membership; anyone knowing the infohash or ledger id can join the swarm and list who is online (SECURITY-MODEL.md); the ledger rendezvous infohash is a label, not a secret; a malicious visitor can learn who is online, when, and the sizes and timing of encrypted traffic; a tracker can tamper with WebRTC offers (SECURITY-MODEL.md "Confidentiality between peers"). Mitigations to offer, each with its own cost: host-only mode (already exists), an optional relay (TURN) or an operator-run relay for chat, mobile defaults off, padding, and shorter swarm identifiers per room. I did not research WebRTC IP leak mitigations here; that belongs to another track.
- **Availability answer.** Publish a pin-node recipe (CRITIQUE.md names this as the gap) because every rival's answer to "nobody online" is an always-on holder (blind peers, relays, PDS, pinners).

### 6.3 Cannot (do not promise)

- Private data in the ledger (even encrypted: WHY.md advises keeping personal data out; encrypted records still reveal size, timing and author, and old ciphertexts persist on devices that never sync again).
- Recovery when the browser key is lost and no export exists.
- Hiding IP addresses from peers and connection servers after consent.
- Anything resembling a guarantee of persistence or of removal; ActivityPub's spec itself says deletion cannot be forced once content is delivered, and the same is true here.
- Cross-site identity as good as Nostr's, unless the site accepts an external signer.

---

## 7. Recommendations

| ID | Priority | Effort | Recommendation |
|---|---|---|---|
| R1-1 | P0 | S | Put sections 3 to 5 into WHY.md "How it compares" as a four-column table (who runs, who holds identity, who pays, what breaks), with the dates and sources, and keep the incumbents row honest that free tiers beat magnet-web on price for small sites. |
| R1-2 | P0 | S | Replace any "better identity" framing in the v0.3 pitch with D5's narrow wording; state plainly that the identity is per-site, exportable and not cross-site. |
| R1-3 | P0 | S | Adopt the "only system in our survey" sentence limited by scope and date, and add a release-gate item to re-check IPFS Service Worker gateway and nsite before each release. |
| R1-4 | P1 | M | Specify an external-signer adapter (NIP-07-shaped) and a `did:key` import/export for the P-256 key; decide the algorithm-tag list before freezing the block format. |
| R1-5 | P1 | M | Publish a pin-node recipe (an always-on holder for the ledger and chat history) and say it is the answer to "nobody online", as every rival's is. |
| R1-6 | P1 | M | For chat and files, write the exposure register (IP, tracker, STUN, infohash membership, timing and size metadata, malicious visitor learnings) in PRIVACY.md before any feature ships, and make host-only and relay options explicit. |
| R1-7 | P1 | S | Re-verify the items I could not: Hypercore/Keet 2026 status, Urbit, Web5, SSB, Solid adoption, did:plc handover dates, Farcaster current prices, and whether the IPFS Service Worker gateway works with a custom domain. |
| R1-9 | P2 | S | A "what we are not" box in README: no private data, no uptime guarantee, no cross-site identity, no cost savings for small sites. |

---

## 8. Open questions

1. Does the IPFS Service Worker gateway let a site keep its own domain (DNSLink) and its own URLs? If yes, D1 shrinks to "plus the site ledger and drop-in".
2. Is there a client-verifying nsite implementation in 2026? w1-07 found none on 2026-10-17; check at release time.
3. How many atproto users hold their own did:plc rotation keys, and what has the Swiss association actually taken over as of October 2026?
4. What is the real state of Keet, Pear browser support and blind-peer hosting in 2026?
5. Are NIP-07 signers common on mobile browsers? If not, an external-signer adapter helps desktop only.
6. Is a P-256 `p256:` tag plus a secp256k1 or Ed25519 tag the right set before the format freezes? w2c-03-VERIFY notes Ed25519 is in every engine and that WebAuthn L3 lists EdDSA first; the choice should be deliberate.

---

## 9. Sources

Every external URL is cited inline with its access date (2026-10-20) and a confidence label. Repo files used: README.md; docs/WHY.md; docs/CRITIQUE.md; docs/SECURITY-MODEL.md; docs/PRIVACY.md; docs/research/w1-07-prior-art.md; docs/research/w2c-03-identity-ux.md and its VERIFY. Search-result-only sources (not fetched): bsky.network PLC post (fetch returned empty), manton.org and atprotocol.dev on did:plc, theblock.co and neynar.com on Farcaster, opensats.org, npmjs.com Web5 package.
