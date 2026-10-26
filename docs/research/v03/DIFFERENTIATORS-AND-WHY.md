# Differentiators and the WHY (v0.3 synthesis)

- **Status:** synthesis, 2026-10-20. Proposal for the owner; nothing here is shipped. Applies to magnet-web 0.2.1 (`src/loader/config.js` line 14) going to 0.3.
- **Built from:** [R1 landscape](R1-landscape-differentiators.md), [R4 positioning](R4-why-and-positioning.md), [R5 weak areas](R5-weak-area-audit.md), [R7 ease of use](R7-ease-of-use.md), with legal limits from [R6](R6-legal-compliance.md) and privacy rows from [R2](R2-privacy-failures-2026.md). It does not repeat [WHY.md](../../WHY.md) or [CRITIQUE.md](../../CRITIQUE.md); it says what to change in them.
- **Source rule:** every external number below is carried from an R-file that fetched or searched it on 2026-10-20, and keeps that file's confidence label. "R4 F3" means finding F3 of R4. Repo facts cite a file and section or line. `[TRUE-IF]` marks a sentence that becomes true only when the named thing ships. `[MODEL]` marks a model output, not a measurement.
- **Wording:** "no backend", "site ledger". The words the project rules forbid are not used in this file, not even in negation.

## 1. Summary (10 bullets)

1. **Four differentiators survive scrutiny, plus one narrow one.** D1 the site at its own address from a plain static host with no install; D2 drop-in with one script tag that fails open to the host; D3 the host as the floor, peers as an optional extra, nothing peer-to-peer before consent; D4 a per-site signed, ordered, moderated log with no relay, hub or personal data server in the data path; D5 (narrow) a visitor can write with no account and no operator holding the key. None of them is unique alone; the combination is unoccupied in a survey of about 20 systems (R1 summary 1 and section 5).
2. **Identity is a weakness against Nostr, AT Protocol and Farcaster, not a strength.** Their identities work across sites; magnet-web's key is per site and per browser profile (R1 summary 2). v0.3 turns this into a defensible property (pairwise keys from one recovery root, R3 F21) but must never be pitched as "better identity".
3. **The money case for small sites is false and must leave the README's first row.** Static egress is free or near-free (Cloudflare R2 egress free; GitHub Pages 100 GB soft limit; R4 F3), and peers carry about 0% of a site under 16 MiB `[MODEL]` (WHY.md "Where the bytes come from"). The saving is the backend, not the bandwidth.
4. **The strongest true reason is independence from a vendor's rules, plus data you never collect.** Supabase Free pauses after 1 week idle; Vercel Hobby is non-commercial only; free IPFS gateways stopped on 2026-09-21; Fleek Hosting closed 2026-01-31 (R1 summary 5). A site whose files and log visitors can re-serve survives a free tier ending, for returning visitors, while a copy exists.
5. **The breach argument is "less to lose", not "nothing to lose".** No accounts table, no password hashes, no email list on the owner's server (R4 F4). The host, the owner key and DNS remain targets, and the ledger leaks whatever visitors write.
6. **Audiences that fit best:** small communities with public boards, event pages with large files and many simultaneous visitors, a class on one network, archives and mirrors. Independent publishers and small apps fit with conditions (R4 F2).
7. **History says install friction, availability left to others and future-of-the-internet pitches killed earlier projects** (Beaker archived 2022-12-27, ZeroNet frozen 2019, Brave removed `ipfs://` 2024-08-22; R4 F6). The pitch must lead with one job and keep the host in the loop.
8. **The release gate has never run** (all 22 rows of DEMO-RESULTS.md "not yet run"; R5 F1). Every claim beyond "passes on one machine over loopback" is design, not evidence. This is the largest adoption risk and the cheapest to start on.
9. **The weak-area list has 19 items from R5 and 8 owner-journey items from R7.** Section 8 maps each to an upgrade, an effort and a v0.3 yes or no. Eleven are in v0.3 as must-do.
10. **v0.3's new features (identity, sign-in, chat, files) are the same job extended from readers to members.** Each must carry its exposure statement in the same paragraph: peers and relays see IP addresses, trackers and STUN see swarm membership (R4 section 3.2).

## 2. The differentiators that survive

Each row: the claim worded so that it is true of 0.2.1, the evidence, the nearest rival and what it lacks, the condition attached, and what would falsify the claim at the next release check.

| ID | Claim (true of 0.2.1) | Evidence | Nearest rival and gap | Condition | Falsified if |
|---|---|---|---|---|---|
| D1 | The site is served at its own address with unchanged URLs from a plain HTTPS static host, verified in the browser, with nothing to install | ARCHITECTURE 3.1 (shell mode, same-URL iframe), 7.1 (Service Worker); WHY.md "Existing sites" | IPFS Service Worker gateway: in-browser verification, but the site lives at a gateway-derived origin (R1 3.1, Medium); nsite: a server-side gateway (R1 3.2); Pear, Beaker, ZeroNet: install (R1 3.7, 3.9) | The first visit trusts the host and DNS (SECURITY-MODEL "Who is trusted with what") | The IPFS Service Worker gateway serves a DNSLink site at its own domain and URLs (R1 open question 1, UNVERIFIED) |
| D2 | Drop-in: one script tag under an existing site; every HTML page stays on the host; with JavaScript off the output is identical | ARCHITECTURE 3.4; e2e scenario 10 (identical output on 6 URLs, R4 section 6) | P2P CDN products for video (PeerCDN, Peer5, Streamroot) were never searched (R1 D2), so the claim is limited to "static site plus site ledger" | A filling copy can raise host egress (WHY.md "The loader costs bytes") | A surveyed product offers a one-tag overlay with a signed shared log |
| D3 | The host's web seed is the floor; peers are an optional accelerator; no tracker, STUN, DoH or peer connection happens before the visitor chooses | PRIVACY.md "Recipients register"; e2e scenarios 10B and 8 (0 announces, 0 WebSockets before consent, R4 section 6) | Maelstrom seeded with no indicator (w1-07); PeerWeb and PeerTube show the no-floor failure (R1 D3) | After consent, peers, trackers and STUN see IP addresses (PRIVACY.md "In short") | Never by a rival; by our own code if a later feature connects before the card |
| D4 | A per-site site ledger: signed, hash-linked entries in one deterministic order on every copy, owner and moderator control inside the log, a hashcash fee per entry, used through `mw.db` | ARCHITECTURE 6.1 to 6.6, 9 | Nostr needs relays, AT Protocol a PDS and AppView, Farcaster hubs and a chain, ZeroNet its client, Firebase and Supabase a vendor (R1 5.2) | No finality, everything public, available only while a holder is online (SECURITY-MODEL "What is not protected") | A surveyed system ships a per-site moderated log with no operator in the path and no install |
| D5 (narrow) | A visitor can write after one click, under a key only the browser holds, with no account system and no key operator | ARCHITECTURE 6.1 (P-256 per ledger, export and import in Settings) | Nostr and SSB use the same key-as-account model with cross-app reach (R1 D5) | Not cross-site; no recovery beyond the export file today (R5 F7) | Never unique; keep it as "part of the combination" |

**Candidate D6 for v0.3, `[TRUE-IF]` it ships and passes the gate:** "A site can sign visitors in and out with no backend: the visitor proves a key they hold, the site checks it in the browser against the site ledger's membership, and each visitor's private record is encrypted to a key derived only on their devices, one unrelated key per site." Rivals: Nostr NIP-07 gives cross-site keys with an extension; SIWE gives the message shape but needs a wallet (R3 F10, F16). The combination with D1 to D4 is new. Its limits (same-origin code, IP linkability, no recovery service) are in [IDENTITY-AUTH-DESIGN.md](IDENTITY-AUTH-DESIGN.md) section 9 and must travel with the claim.

**Candidate D7, `[TRUE-IF]`:** "Signed-in visitors can chat and pass files to each other inside the site's own swarm, end-to-end encrypted between their keys, with nothing stored by anyone unless they choose." Precedent for the transport exists (Trystero, Bugout, P2PT, PairDrop; R1 6.2, R8 F10), so this is not a differentiator by itself; it extends D4. It always carries [REALTIME-AND-FILES-DESIGN.md](REALTIME-AND-FILES-DESIGN.md) section 9.

### 2.1 What does not differentiate (do not claim)

| Tempting claim | Why not | Source |
|---|---|---|
| "No backend" alone | every static host, IPFS and nsite also serve files with no application server | R1 5.1 |
| Hash verification in the browser | the IPFS Service Worker gateway, Planktos and PeerWeb do it | R1 5.1 |
| Visitors as peers | WebTorrent, PeerTube (removed), PeerWeb; and it pays only for large sites | R1 5.1; WHY.md "Honest economics" |
| Self-owned identity | Nostr, AT Protocol and Farcaster do it across sites | R1 summary 2 |
| Cheaper hosting | false for small sites | R4 F3 |
| Privacy | true only as "fewer recipients, all named"; never anonymity | R2 summary 5 |

### 2.2 The "only" sentence, worded to be true

> "magnet-web is the only system in our survey that serves an ordinary website at its own address from a plain static host, checks every byte in the browser, lets visitors help carry it only after they agree, and gives the site a shared signed log without a database, an account system or an installed app. It does not make the site private, permanent or hard to take down."

"In our survey" means the systems in R1 section 3 and [w1-07](../w1-07-prior-art.md), checked 2026-10-17 and 2026-10-20. Re-check the IPFS Service Worker gateway and nsite before every release (R1-3) and change the sentence if either closes the gap.

## 3. The strongest honest WHY

### 3.1 The one sentence

**"Keep your site a folder of static files and still give it comments, a guestbook or members, without running or renting a backend and without handing your readers to a vendor."**

Everything else in the README and WHY.md is the condition attached to that sentence.

### 3.2 Structure for the README top (replaces the current first screen)

Title line (R4 7.1):

> Websites loaded by magnet link, verified in the browser, from a plain static host. No backend.

The job:

> Keep your site a folder of static files. Add a guestbook, comments or a poll without a database or a vendor: the visitors' browsers keep and check a signed log called the site ledger. Large files can pass between visitors who choose to share.

The price, immediately:

> What it costs: your HTTPS host stays in the loop and is the trust root. Once a visitor chooses to share, other visitors and the connection servers (trackers and STUN) see their IP address and that they are on your site. Everything in the site ledger is public.

Status:

> Status: 0.2.1, pre-release. 938 unit tests and 25 end-to-end scenarios in Chromium (26 in WebKit) pass on one machine over loopback. The release gate on real phones and browsers has not run.

What v0.3 adds, `[TRUE-IF]` each ships:

> v0.3 lets visitors become members: sign in with a key only they hold and a 12-word recovery phrase, keep a private record only they can open, chat and share files with other members, encrypted between their keys. The people you talk to still see your IP address, and trackers see that you joined the site's swarm. "Load from host only" turns all of it off.

### 3.3 "Is this for you?" (replaces README "Why" row 1, "Hosting that costs next to nothing")

| You want | Use magnet-web? | Because |
|---|---|---|
| Comments, a guestbook or a board on a static site, public, moderated by you | Yes | the site ledger replaces the database; you hold the owner key |
| Large files for a crowd online at the same time | Yes, for about 20 MiB and up | peers can carry a real share `[MODEL]`: 47% at 128 MiB with 10 eligible seeders (WHY.md) |
| A smaller bill for a small site | No | the web seed carries nearly all of it; many hosts are already free |
| Accounts with password reset, payments, server secrets | No | there is no server to hold them |
| Private data | Mostly no | the ledger is public; v0.3 private records and chats are the exception, with stated limits |
| Anonymity | No | peers, trackers and STUN see IP addresses after you share |
| Search indexing | Use drop-in mode | shell mode shows crawlers the loader (CRITIQUE "Shell mode hides the site") |

### 3.4 WHY.md new order (R4 7.3, adopted)

1. The job (3.1 above). 2. Who it is for (section 4 below, three columns). 3. What you get and what you give up (keep the existing condition-per-row table). 4. Your data and your readers' data (domain, key, readers' data, no account table, with the metadata caveats). 5. The money, honestly (four sentences, section 3.5). 6. What went wrong for others and what we did about it (Beaker, ZeroNet, IPFS gateways, Nostr gateways, PeerTube). 7. When not to use it (moved up). 8. The proof so far (section 9, with "over loopback" in the heading). 9. v0.3: members, not just readers (each feature followed by its exposure sentence in the same paragraph). 10. How it compares (section 5 table). 11. Prior art.

### 3.5 Sentences ready to paste

- **Privacy:** "magnet-web reduces who receives your readers' data. It does not make them anonymous. Before a visitor chooses, the browser contacts only the hosts you chose. After, trackers and STUN servers see their IP address and which site they joined, and other visitors see it too. 'Load from host only' removes all three."
- **Money:** "If your site is under about 16 MiB, peers will not lower your bandwidth bill, and your host may already charge nothing for it. What you save is the backend: the database, the login, the patching. A guestbook on Supabase costs US$0 until its free limits, then US$25 a month (supabase.com/pricing, accessed 2026-10-20, R4 F3); the real difference is that nobody's free-tier rules can pause yours."
- **Breaches:** "Data you never collect cannot leak from your server. There is no accounts table and no password list. The site ledger is public by design, so anything visitors write there is already public."
- **Ownership:** "The site is yours because the pointer is signed with your key and served from your domain. Anyone who controls your host or your DNS controls what visitors run. Keep the key offline."
- **Availability:** "Your host is the floor. Peers are a bonus. A pin node is how you keep recent posts alive between visits."
- **History:** "Earlier projects asked visitors to install a browser or a client, relied on someone else's free gateway, or promised a new web. This one asks for one script tag and keeps your host in the loop. Whether people come back to such sites is not yet measured."
- **Identity (v0.3, `[TRUE-IF]`):** "Your identity on a site is a key in your browser, created from a 12-word recovery phrase that only you hold. Each site gets a different key, so two sites cannot match you by key. They can still match you by IP address, by a name you reuse, or by timing. Nobody, including the site owner, can reset a lost phrase."
- **Private record (v0.3, `[TRUE-IF]`):** "Your private record on a site is encrypted to a key only your devices can derive. Other visitors and the owner see that a record exists, its fixed size and when it changed, never its contents. Code running on the site while you are signed in can use your key, so a site you do not trust can still act as you while it is open."
- **Chat and files (v0.3, `[TRUE-IF]`):** "Messages and private files are encrypted between visitors' keys. The people you talk to still see your IP address, and the trackers see that you joined the site's swarm. If that matters, use host-only mode, which turns chat and file sharing off."

## 4. Audiences and their jobs

Ranked by fit to what 0.2.1 does now (R4 F2), with the v0.3 change added.

| Audience | Job they hire it for | Fit today | Condition | Where it breaks | v0.3 changes |
|---|---|---|---|---|---|
| Small communities (clubs, forums, guestbooks, polls) | a public board with no database, moderated by owner keys | High | public writing is acceptable; the owner moderates | spam on open ledgers; a poll counts keys, not people; late posts reach only overlapping visitors without a pin node | members sign in, private records, live chat between members; moderator-approved membership if the freeze decision allows it |
| Event pages that spike | large files passed between many simultaneous visitors | High for 20 MiB and up | many visitors online at once `[MODEL]` | small pages come from the web seed anyway | files uploaded by attendees seeded in the event's swarm |
| A class on one network | the same material opened at once; offline revisits | Medium to high | laptops that chose to share | phones download only until opt-in | class chat and file passing on one network |
| Archives and mirrors | same files, same infohash, every copy verified | Medium | someone keeps a copy online | no availability when nobody holds it | none |
| Independent publishers | a resilient copy for returning readers; comments without a vendor | Medium | drop-in for anything indexed | shell mode hidden from crawlers; the bill barely changes | reader sign-in without an identity provider |
| Small apps with light shared state | boards, display names, owner settings in `_` keys | Medium | public data; 20 writes a minute per page, 2 KiB values, 8 MiB ledger | not a database: no private data, no transactions, no finality | per-visitor private records, `mw.db` paging and entry metadata |
| Readers' data kept from third parties | no analytics, no third-party scripts, nothing before consent | High, stated limit | the owner adds no third-party embeds | after sharing, IP addresses reach peers, trackers and STUN | sign-in with no identity provider, so no third party learns logins |

Two-minute fit test for owners (R4 section 5, adopt as-is in WHY.md): static? needs shared data? data public? payload 20 MiB and many visitors at once? willing to moderate? needs search (use drop-in)? accepts phones mostly downloading and no finality? If 1 or 3 fail, use a normal backend.

## 5. How it compares (for WHY.md "How it compares")

Condensed from R1 section 3 (sources and confidence labels there; access 2026-10-20).

| System | Who runs the data path | Who holds identity | Who pays | What breaks |
|---|---|---|---|---|
| magnet-web 0.2.1 | the owner's static host (also web seed); visitors after consent; WebSocket trackers and STUN for introductions | the owner key (offline); visitors' per-site browser keys | the owner pays the host; visitors pay bandwidth only if they share | new visitors need the host; ledger data spreads only while a holder is online; host and DNS are the trust root |
| IPFS (Service Worker gateway) | pinners and gateways | nobody by default | the pinner | content gone when the last pinner stops; free gateways ended 2026-09-21 |
| Nostr (NIP-07, relays, Blossom, nsite) | relays and blob servers; nsite through a server gateway | the visitor's keypair, cross-app | relay operators | relays keep what they choose |
| AT Protocol / Bluesky | PDS, relay, AppView, did:plc directory | DID plus handle; rotation keys mostly held by the PDS operator | the PDS and AppView operators | the directory is one logical service |
| Farcaster | Snapchain nodes, onchain registry | onchain fid | users onchain, operators | stewardship sold to Neynar, announced 2026-01-21 |
| ActivityPub | each instance | the instance | instance operators | the instance closing or changing policy |
| Hypercore / Pear | peers, blind peers | per-core key | peers, blind-peer operators | needs an installed runtime |
| Supabase / Firebase / Vercel / Netlify / Cloudflare | the vendor | the vendor's auth | free tiers, then the owner | pauses, caps, non-commercial terms, product changes |

The incumbents row must say plainly that their free tiers beat magnet-web on price for small sites (R1-1).

## 6. Counter-arguments and honest answers

| # | Counter-argument | Honest answer | Where it lives |
|---|---|---|---|
| 1 | "Peers see my IP address." | Yes, after "Share and load". Trackers and STUN see it too. "Load from host only" avoids all three. A relay option is a v0.3 mitigation `[TRUE-IF]` that moves the exposure to the relay operator. | PRIVACY.md; WHY.md |
| 2 | "If nobody is online it dies." | The site still loads from the host. Recent ledger posts need a holder; a pin node and a `cs=` snapshot are the floor. | WHY.md "Will my site have peers?" |
| 3 | "Phones can't help." | Correct. They download; they upload nothing until opted in (`config.js` lines 59 to 61); iOS suspends peers soon after backgrounding. | WHY.md; R5 F3 |
| 4 | "Trackers and STUN are third parties." | Yes: four public trackers, all on at least one block list, and two STUN operators. Run your own tracker. Nothing touches them before consent. | WHY.md; R5 F4 |
| 5 | "There is no search." | In shell mode crawlers see the loader. Use drop-in, or the v0.3 crawler shell `[TRUE-IF]`. | CRITIQUE; R5 F12 |
| 6 | "A shared-origin hub is unsafe." | Agreed. Production sites use their own origin; v0.3 refuses persistent identity on a shared origin. | R5 F19 |
| 7 | "The ledger is not a database." | Agreed: a signed, ordered, public log with 2 KiB values and an 8 MiB default cap. | CRUD.md; R5 F6 |
| 8 | "Why not a normal backend?" | Often you should. This is for when the backend would be bigger than the job. | section 4 fit test |
| 9 | "Proof-of-work is theatre." | It is a fee that slows a flood: one GPU mints about 300,000 entries a second at 16 bits (CRITIQUE). Writer policy, allow lists and moderators are the real tools. | CRITIQUE |
| 10 | "Chat over WebRTC leaks who talks to whom." | Content is encrypted between keys `[TRUE-IF]`. Peers see that your IP is connected to theirs, and when. Presence is metadata. Group membership is visible to members. | REALTIME-AND-FILES-DESIGN 9 |
| 11 | "Nostr already gives me a key that works everywhere." | True, and it is better for cross-site reach. magnet-web's key is per site on purpose, so sites cannot match you by key. An optional external-signer adapter is P3. | R1 summary 2; R3 F10 |
| 12 | "Key login loses users who lose keys." | Yes. Only 43% of 643 respondents in a CHI 2025 study recognised a seed phrase (search summary, R3 F23). v0.3 offers several recovery routes and says plainly that nobody can reset a lost one. | IDENTITY-AUTH-DESIGN 3.5 |
| 13 | "The site's own scripts can steal my key." | In 0.2.1, yes: the key is extractable (`src/loader/app.js` line 546). In v0.3 it is non-extractable, so a hostile script can use it while the page is open but cannot copy it out. Only a separate identity origin fixes use (design only). | R5 F7; R3 F18 |
| 14 | "No backend means no legal duties." | Wrong. The owner is plausibly the controller for visitor-posted personal data (Russmedia, C-492/23, secondary sources, R6 F3) and a hosting or user-to-user service under the DSA and Online Safety Act where those apply (R6 F9). | R6 |

## 7. Wording fixes owed in existing docs (R4 7.5)

| Where | Problem | Fix |
|---|---|---|
| README.md line 87 heading | uses the word the rules ban for the ledger | "Why the site ledger is not a currency chain" |
| README.md line 240, WHY.md line 146 | a forbidden phrase appears inside a negation | "nothing here is called ready for production use until the release gate passes", or record an exemption in the docs-links test |
| README "Why" table row 1 | "Hosting that costs next to nothing" contradicts WHY.md for small sites | replace with section 3.3 |
| [deviations/dropin.md](../../deviations/dropin.md) "Known limits" | says the drop-in panel has no identity screens; `src/dropin/panel.js` lines 341 to 354 render Export and Import | update (R5 F7) |

## 8. The complete weak-area list, with the upgrade for each

Severity is R5's (Blocker, High, Medium, Low). Effort S under a week, M one to four weeks, L more (R5 scale).

| # | Weak area (evidence) | Severity | Upgrade | Effort | In v0.3 |
|---|---|---|---|---|---|
| W1 | Release gate never run; loopback only (DEMO-RESULTS; `test/e2e/run.mjs` line 43) | Blocker | first pass G2, G4, G6, G11, G16, G20, G22, published with failures; new rows for login, chat, files, restore | M | **Yes** |
| W2 | Durability with nobody online rests on the host (`tools/pin.mjs` lines 2 to 5) | High | `pin.mjs --upload` on a timer, signed `_health` heartbeat, compose file; offline chat delivery stated as opt-in store-and-forward | M | **Yes** |
| W3 | Phones are passengers (`config.js` lines 59 to 61) | High | keep defaults; phone uploads go to the web seed or pin node when configured; "only while open" notice; measure the fee on phones | S to M | **Yes** (notice, G20); pin routing if files ship |
| W4 | Four volunteer trackers, two STUN operators, no TURN (`config.js` lines 19, 22, 116) | High | `deploy/tracker` plus optional coturn in one compose file; relay-only visitor setting; connect-failure counts | M | **Yes** if chat ships |
| W5 | Swarm sizes for small sites (IMPROVEMENTS-DIGEST 9.1 to 9.4) | Medium | `swarm-calc` with "members online together" | S | Yes |
| W6 | Ledger limits as a database (`src/chain/block.js` lines 33 to 60) | High | sealed per-visitor records; `mw.db` cursor and `entry()`; in-memory query helper; unban op; `k` and `l` charset and erasure semantics in the freeze window | S to M each | **Yes** |
| W7 | Identity extractable, no recovery, no cross-device, no key-agreement key (`app.js` line 546; `dropin/identity.js` line 143) | Blocker for v0.3 | seed-derived non-extractable keys, lazy creation, phrase, restore, separate chat ECDH key, QR linking, honest same-origin statement; identity origin as a design | M; L for the origin | **Yes** (origin: design only) |
| W8 | No sign-in; only the owner signs `allow`, from `tools/` (ARCHITECTURE 6.8) | High | `mw.auth`; member requests approved by a moderator key if the freeze allows it | M | **Yes** |
| W9 | Chat, files and sharing have no exposure table | High | the table before code ([REALTIME-AND-FILES-DESIGN](REALTIME-AND-FILES-DESIGN.md) 9) | S | **Yes** |
| W10 | Onboarding: 12 to 14 commands, a 9-flag publish, `private: true` in `package.json`, npm name unreserved, no sub-paths (QUICKSTART; R7 2.1) | High | reserve the name; `init`, `ship`, `try`; GitHub Pages and R2 adapters; CI re-sign reminder; sub-path `--base` later | S to M each | **Yes** (name, init, ship, try, two adapters) |
| W11 | Drop-in limits: first view from host, 105 KB gzip `mw.js`, no moderator import (ARCHITECTURE 3.4) | Medium | sign-in panel and moderator import in the drop-in; split `mw.js` | M | Partly |
| W12 | Shell mode invisible to crawlers (w2a-05) | Medium | crawler shell: one static HTML per URL with title, description, Open Graph, `<noscript>` | M | Recommended |
| W13 | No streaming, no files above 128 MiB; w2a-10 unfinished; `critical()` does not reorder (COMPATIBILITY limitation 6) | Medium, High once files ship | per-file torrents with device-class caps and the blob chunk store | M | **Yes** for files |
| W14 | No accessibility audit (`src/loader/ui.js` lines 90, 132 to 142) | Medium | axe-core in e2e on consent, Settings, drop-in panel, sign-in; manual VoiceOver and TalkBack pass | S | **Yes** |
| W15 | English only, no right-to-left (`index.html` line 2; `strings.js`) | Medium | per-locale tables, `dir="rtl"`, English and French first | M | **Yes** (mechanism and French) |
| W16 | No owner observability (w2b-04) | Medium | local debug bundle; scheduled `check-site` with a dead-man's switch | S | **Yes** |
| W17 | Five string patches on a minified WebTorrent bundle; unsigned `SHA256SUMS` (`build.lock.json`) | Medium | signed sums and attestations before identity code ships; own bundle later | S now, M later | Sums yes |
| W18 | Consent can be lost on a reload after "Share and load"; Chrome Local Network Access may gate LAN WebRTC (Chrome blog, updated 2025-09-29, R5 F18) | Low | write the choice before the card closes; G-row for LNA | S | **Yes** |
| W19 | Shared-origin hubs have no isolation (COMPATIBILITY limitation 11) | Low | refuse persistent identity there | S | **Yes** |
| W20 | Owner reading load about 111 KB before first publish (R7 summary 2) | Medium | one-screen QUICKSTART "Do this"; reference below | S | Yes |
| W21 | Publish warns on success instead of failing for peers-only shells (R7 2.2) | Medium | one end-of-run block with the fixing command | S | Yes |
| W22 | Identity is silent; backup not offered when it matters (R7 2.4) | High | backup card after the first meaningful action | S to M | **Yes** |
| W23 | No legal templates: DPIA, notice and action, statement of reasons, hub DPA (R6 recommendations 8 to 14) | Medium | templates in OPERATIONS.md and ONBOARDING.md | M | DPIA and notice templates yes |
| W24 | Encrypted personal data in the ledger conflicts with PRIVACY.md (R2 F17; R3 A1; R6 F1) | Blocker for v0.3 records | owner and counsel decision; recommended answer in IDENTITY-AUTH-DESIGN 6.1 | S to decide | **Yes** (decision) |

## 9. Claims the current tests allow

All from [INTEGRATION-STATUS.md](../../INTEGRATION-STATUS.md) (post-wave 2026-10-20 00:40 ET, Round 3 06:55 ET), one development machine, loopback (R4 section 6).

| Claim | Number | Wording that stays true |
|---|---|---|
| Unit tests | 938 of 938, about 8 s | "938 unit tests pass" |
| End-to-end, Chromium | 25 of 25 in 127.5 s; no request left 127.0.0.1 | "25 end-to-end scenarios pass in local Chromium" |
| End-to-end, WebKit 27.2 | 26 of 26 in 129.5 s | "26 in Playwright WebKit" |
| Browser unit tests | 31 pass, 1 skipped | say the skip |
| Example site | 29 pass | |
| Cold start, nobody online | 162 ms | "162 ms over loopback" |
| Cached render | 118 ms | "118 ms over loopback" |
| Peer drop recovery | 66 ms drop; 1.3 s re-announce | "over loopback" |
| Consent gate | 0 tracker announces, 0 WebSockets before consent; 0 RTCPeerConnections while the hub gate is open | "in the test harness, nothing connected before the choice" |
| JS off, drop-in | identical output on 6 URLs | "in the drop-in fixture" |
| Kill switch | about 3 s after the next navigation | "in Chromium" |
| Sizes | `loader.js` about 117 KB gzip; `webtorrent.min.js` about 64 KB; `mw.js` about 105 KB | "0.2.1 build, gzip -9" |
| Offload | 0% under 16 MiB; 47% at 128 MiB with 10 eligible seeders | always "model" |

**Not licensed:** anything about real networks, phones, Firefox, Safari on iOS, Brave or Edge; any speed comparison with other hosting; "fast" or "instant"; any statement about v0.3 features before their tests exist.

## 10. What this means for magnet-web

**Today (0.2.1, true of the code).** D1 to D5 hold as worded in section 2. No connection to peers, trackers, STUN or DoH before the visitor's choice. Everything in the ledger is public. The identity is one extractable P-256 key per ledger per browser profile. Tests are loopback only.

**Upgrade (v0.3).** D6 and D7 as `[TRUE-IF]` claims; the README and WHY.md rewrite (sections 3 and 7); the weak-area items marked Yes in section 8; the first gate pass, which is the precondition for publishing any browser or phone sentence.

**Cannot (say it in WHY.md and PRIVACY.md).** Lower a small site's bill; hide IP addresses from peers, trackers, STUN or a relay; keep data available when nobody holds it; erase copies that left; protect keys from code on the same origin while the page is open; recover a lost phrase; give cross-site identity as good as Nostr's without an external signer; stop a determined spammer with proof of work; verify anyone's age (R6 F10).

## 11. Recommendations

| Pri | Effort | Recommendation | Source |
|---|---|---|---|
| P0 | S | Rewrite README top and add "Is this for you?" (sections 3.2, 3.3); remove "Hosting that costs next to nothing" as the lead | R4 P0 |
| P0 | S | Fix the four wording items in section 7 | R4 7.5 |
| P0 | S | Adopt D1 to D5 wording and the scoped "only" sentence; add a release-gate row to re-check IPFS Service Worker gateway and nsite | R1-1, R1-3 |
| P0 | M | First gate pass (W1) and publish results, failures included, before 0.3 is announced | R5 F1 |
| P0 | S | Every v0.3 feature paragraph carries its exposure sentence in the same paragraph, in docs and UI | R4 P0; R2 P0 |
| P0 | S | Reserve the npm name or move to a scoped name | R5 F10; R7 5.8 |
| P1 | M | Reorder WHY.md per 3.4; add the comparison table (section 5) and the fit test | R4 P1; R1-1 |
| P1 | M | `init`, `ship`, `try`; GitHub Pages and R2 adapters | R7 5.1 to 5.5 |
| P1 | M | Pin-node recipe with upload and heartbeat as the standard answer to "nobody online" | R1-5; R5 F2 |
| P2 | S | A short History page (five rows, dated, sourced) | R4 P2 |
| P2 | M | Measure consent rate, visit length and offload on the hosted example site to replace `[MODEL]` figures | R4 P2 |
| P3 | S | A plain status page: measured, modelled, untested | R4 P3 |

## 12. Open questions

1. Does the IPFS Service Worker gateway serve a DNSLink site at its own domain and URLs? If yes, D1 shrinks to "plus the site ledger and drop-in" (R1 Q1).
2. Who is the first real owner? The job has not been confirmed by anyone outside the project (R4 Q1).
3. Do readers understand "site ledger" without the word the owner uses loosely? Needs a five-person test (R4 Q4).
4. Should the docs name the project's relationship to piracy before a reviewer does? Legal review of the final README is owed (R4 Q3; CRITIQUE "Legal exposure").
5. Is GitHub Pages' "not allowed ... to run your online business" clause (R4 F3) a reason to name R2 first in QUICKSTART for commercial owners?
6. Re-verify before publishing: IBM 2025 and Verizon figures (secondary only), Bluesky, Nostr, Solid and Urbit numbers (do not cite), did:plc handover dates (R1-7, R4 Q6).

## Sources

Repo: README.md; docs/WHY.md; docs/CRITIQUE.md; docs/PRIVACY.md; docs/SECURITY-MODEL.md; docs/ARCHITECTURE.md 3, 6, 9; docs/INTEGRATION-STATUS.md; docs/DEMO-RESULTS.md; docs/research/w1-07-prior-art.md; docs/research/v03/R1 to R8. External facts are cited inline through the R-file that fetched them, all accessed 2026-10-20: supabase.com/pricing, developers.cloudflare.com/r2/pricing/, docs.github.com (Pages limits), vercel.com/docs/plans/hobby (updated 2026-09-14), netlify.com/pricing, ibm.com/reports/data-breach (2026 report, US$4.99M global average), neynar.com/blog/neynar-is-acquiring-farcaster (search summary), replicache.dev. Confidence labels are those of R1 and R4.
