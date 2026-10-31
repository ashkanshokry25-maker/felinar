# Threat model

The living threat model of the felinar v0.3 design: who can see or do what before and after the design, which
attacks the red team found, what the design does about each, and what stays open. [SECURITY-MODEL.md](SECURITY-MODEL.md)
is the short model (assets, trust, protections, non-protections) of 0.3.0: its first sections
cover the parts that 0.3.0 kept from 0.2.1 (never published), and a v0.3 section at its end covers what v0.3 adds;
this page holds the long tables. It is built from sections 2.16 and 2.17 of the v0.3 design review
([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), cited "R"; a number after R is its section) and from the
notes of the lanes that have built parts of it. To report a problem, follow [SECURITY.md](../SECURITY.md) and never open
a public issue for anything exploitable.

> **Status: v0.3, built and reviewed in the review round of R 5.3.** Every "after" column below describes the design as
> built, which is the code that 0.3.0 runs, except where a row says "not built". The code has
> landed with unit tests, the integrators' end-to-end runs on loopback, the code review of the v0.3 and C2 code
> ([INTEGRATION-STATUS.md](INTEGRATION-STATUS.md)) and the review round of R 5.3, which ran from 2026-10-22 to 2026-10-24
> and re-read the rows against the code (R 5.4, [deviations/review-round.md](deviations/review-round.md)); the rows it
> changed say so with "review round" and the finding id. The real-device gate ([DEMO-RESULTS.md](DEMO-RESULTS.md)) has
> not run: no row is a claim about real devices or a public network. A row marked "blocked" means the design stops the
> attack as built.

Wording used throughout: "no backend" and "site ledger"; a number is measured (with its source), arithmetic (derived
in place from cited constants) or chosen (a design parameter that a gate row confirms or tunes). Nothing in this file
was measured on a phone or a public network.

## How this document changes

R 2.19 makes this a living document:

1. A row keeps its id for good (PEER A1, HUB H3, SC-4 and so on). A closed row says in which release and by which
   test it closed.
2. Every release adds rows or closes them. A release cannot ship with a row whose "after" column changed without a
   review of that row.
3. The review round after a build re-runs the six judges and the eight attackers read-only against the built code,
   plus a conformance agent (R 5.3). Every row is re-read against code then.
4. Statuses: **blocked** (the design stops it), **mitigated** (the cost is raised or the harm bounded, and the rest is
   stated), **open** (stated and not solved), **open (needs measurement)** (a gate row decides, and the row is named).
5. A change to this model goes through an RFC like any other change to the security model
   ([GOVERNANCE.md](../GOVERNANCE.md)).

## What the design rests on

1. **The identity origin's served code** is trusted with every root that is unlocked there. It is a static bundle with
   a published hash, a reproducible build, signed releases and a build id on every card. A person who wants no third
   party in that position runs their own identity origin or, later (P2), the extension build. A compromise of the host
   that serves altered code takes the roots of people who unlock there afterwards. This is the one central trust point
   the design adds, and it replaces the far larger one in the proposals (every site host).
2. **Each site's host** stays the trust root for that site ([SECURITY-MODEL.md](SECURITY-MODEL.md)). It can take that
   site's working keys, read that site's sealed items and the private media of people signed in there, and act as them
   there. It cannot reach other sites or the root.
3. **The browser** enforces origins, `event.origin`, WebAuthn RP IDs and Service Worker scope. Malicious extensions and
   compromised devices are out of reach (PHISH A16).
4. **Peers, trackers, STUN servers, relays and holders** are untrusted for content and integrity, and are assumed to
   log everything they can see.

## Residual exposure by observer, before and after

"Before" is 0.2.1 plus the two proposals (identity, and chat with files) as written. "After" is the v0.3 design. The
third column lists what the design does about the "before" column; the fourth is what an observer can still do.

| Observer | Before | Mitigations in this design | After (what remains) |
|---|---|---|---|
| Ledger-swarm peers | IP next to key on every signed action; first-seen author inference | each peer hears of a new local block after its own random delay of 0.5 to 3 s, a relayed block after up to 1 s (review round STALK-8, `src/chain/gossip.js`); relay subsets for new blocks are not built | IP next to key for neighbours; timing analysis by wide Sybil sets; on a hub's follow lane, the ledgers a member holds and follows: a private follow is never named in HAVE, because the loader passes the page's `{ private }` to `multi.follow` (review round STALK-3; `src/loader/personal-site.js:349`, `:424`) |
| Chat-lane neighbours | IP, that you chat, sizes, timing; key-to-IP through the public inbox tag; public presence beacon; flood-origin inference | no public inbox tag on the wire; prefix buckets and decoys; padded PRES; presence off by default; own frames leave after a jitter at a random hop (0 to 2) to a random half of neighbours, and stranger frames show one byte of the inbox tag (review round PRIV-1, STALK-7) | IP next to the chat key and the site key: a neighbour gets this tab's signed CK only when there is a reason, the loader's default since the integration (`src/loader/api.js:2156`; review round STALK-2, PRIV-2); what remains is the chat key that stays the same for 90 days (the Noise static); that you use chat on this site; padded sizes and times; a first-hop neighbour can guess a frame's author by timing |
| Public default trackers (four, PRIVACY.md) | which IPs open which felinar sites, chat lanes, group lanes, private file swarms | the separate chat lane, group lanes and private media swarms announce only to the site's own tracker and use its STUN; chat also travels over the ledger rendezvous wires, which the pointer's trackers and the default STUN helped set up (review round HON-7) | which IPs open which sites (ledger rendezvous and content swarms); not that a person chats |
| Site's own tracker, hub tracker | | named in the chat and media cards | IPs on the chat lane and in private swarms (edges between uploader and recipients), times |
| STUN operators | IP and session starts for every site using the defaults | site's own STUN required for chat and files | IP and session starts |
| DoH resolvers | IP and site names every 5 minutes while open | unchanged; the poll keeps its interval (the TTL, at least 5 minutes) while the tab is hidden: lengthening it (STALK A11) is not built (review round HON-1) | IP and site names |
| TURN relay (if the owner runs one) | both IPs, bytes, times | off by default; operator named; logging off in the compose file | both IPs, bytes, times of each pair it relays: a call goes through it only when a direct connection fails (a choice to relay every call is planned, not built) |
| Opt-in holders | every flooded DM for 7 days; IP pairs depositor to collector; inbox oracle | hold flag; contact mail only; COLLECTED; prefix buckets; per-source quotas | that an address left padded ciphertext and another address collected something in the same bucket |
| Pin mailbox and pin node | IPs, tags and sizes of everyone; files in memory | stated recipient; inbox mail only with key proof; moderator queue for pins | IPs, tags, sizes, times; ciphertext of held and pinned items; plaintext of public pinned files |
| The site's host (loader code) | every root unlocked on that site, hence every site | root never on site origins | that site's working keys, records and media of people signed in there |
| Identity origin host | n/a (did not exist) | static bundle, cached by its own worker; no referrer; build id and hash | IP and time of popup loads that miss the cache and of update checks; with altered code, the roots of people who unlock after the change |
| Passkey provider | a credential per site origin (the list of sites) | one RP ID at the IdO | that the person has a felinar identity at that IdO |
| Server relying party | proofs replayable for up to 7 days | 5-minute challenge-response, nonce, origin | the person's key for that site, IP, user agent, time |
| Other visitors | public posts, profile names, keys | short ids and badges against impersonation | public posts, names, keys, and IPs when connected |
| Recipients and group members | everything sent, provable to third parties | deniable DMs | everything sent (can keep and forward); group messages provable inside the group's trade-off |
| Site owner reading the ledger | sealed-item metadata; permanent membership, bans, chat-key rotation history | chat keys off-ledger; ban expiry; checkpoint pruning | membership and bans in current state; sealed items' author, time, fixed size |
| Site owner through code, or a hostile same-origin script | every root, every site, while unlocked or after | per-site keys only | everything on that site while the person is signed in there |
| Hub operator | the loader for every personal site; tracker; pins | refuse persistent identity on shared-origin hubs; recipient rows; hub-scoped identity only by choice; the hub key goes only to pages the identity origin takes for the hub's template (review round PHISH-1) | the loader for its labels, tracker data, pinned ciphertext and public files; with hub-scoped identity, any page of the hub the person signs in to can post as them on every page of the hub (the card says so), and a page owner who claims the template's infohash in his own pointer is not stopped yet (review round HUB-3, PHISH-1) |
| Anyone with a ledger copy, forever | stubs, membership, bans, chat-key records, record times | checkpoint pruning for honest copies; chat keys off-ledger | whatever was copied before a checkpoint, on copies that never prune |
| Network observer or ISP | connections to trackers, STUN, peers | none in a browser | that you use peer-to-peer sites, when and how much |
| Someone with your 12 words | every key, record and recorded message on every site | random content keys; extra word option | your public identities on every site (and enumeration of where you posted); not past content without the vault |
| Someone with your unlocked device | every site key after "sign out" | sign out deletes keys; shared-computer mode; the identity page's Settings lists sites only after an unlock (review round STALK-6) | sites where you stay signed in; the IdO if its window is open; the identity page's display cache, which lists the sites signed in to (anyone with the device's storage can read its IndexedDB record) |

## Threats added by v0.3, and their rows

Each of these exists only because v0.3 adds the feature; none was possible in 0.2.1.

| Threat | Mitigation | What remains |
|---|---|---|
| A relying party names another site's ledger to get that key | labels from `event.origin`; ledger label only with pointer lineage and `org=` | none known |
| The IdO host as a tracker of sign-ins | worker cache, no referrer, static | popup loads that miss the cache |
| A third site replays a "same identity" link | links live only in the vault and change only which key the IdO hands to which origin | none in the ledger |
| Phishing for the 12 words | words only at the IdO; site cards have no phrase field | a person who types them elsewhere |
| Stolen working keys on one site | rotate (from the IdO), key-change notices; "Replace my keys" writes the recover rotation, so `allow` membership follows the new key, and the old key's later blocks, chat keys and roles stop counting (code review v0.3) | that site until rotation; a label that owns a page keeps its key (a page cannot move to a new key yet), and a moderator role stays with the old key until the owner adds the new one |
| Proofs replayed at a verifier | nonce, 5 minutes, origin | inside 5 minutes at the same verifier before the real use |
| Wire relay posing as a contact | Noise XX handshake | a hostile tracker in the middle of the WebRTC transport sees IPs and timing |
| Private media keys taken by site code | not in the SDK; held in the worker | hostile code on that origin |
| Media seek patterns | padding of total size | which pieces a viewer asks for (roughly where they seek) is visible to the peers serving them |
| Sites correlate one person by the escrow copies they keep (review round SEC-1, STALK-1, PHISH-2) | each site gets copies made for its origin: the root copy wrapped again with a fresh IV and no credential id, the vault copy encrypted again, padded to a size bucket and named per origin | none known |
| A page claims to be another site when it sends a person to the identity page by redirect (review round SEC-2, PHISH-9) | a redirect carries only a key sign-in or the record read, and its sign-in is unverified: no approval, hub decision, same-identity link or vault site; the card says the page cannot be confirmed | a person who signs in anyway from a page they did not check |
| A restore or a device link started by a site replaces the person's identity (review round SEC-3, PHISH-4, PHISH-5) | a restore on a device that has an identity shows its check code first and never replaces it silently; `#restore` and `#link` in a window a site opened only say "open the identity page yourself" | a person who opens the identity page and restores other words after seeing both check codes |
| A stranger's page on a hub receives the hub-scoped key (review round PHISH-1, HUB-3) | the hub label goes only to pages the identity origin takes for the hub's template; any other label gets its own key, and the card says that a page of the hub can post as the person on every page of the hub | a pointer owner who claims the template's infohash for his own ledger, until the loader loads only template code on a hub |
| A link names the identity origin of a site (review round PTR-10) | `idp=` is read only from a signed record | a hub still takes the identity origin from a link-carried signed pointer until the loader passes the operator's own |

## Threats added by v0.3 C2

> **Status: v0.3 C2, built; reviewed in the review round of R 5.3 (R 5.4).** Built and integrated on 2026-10-20, tested on loopback only (e2e E-PS-1 to E-PS-4, E-ZS-1, E-CL-*,
> DOOR-*; deviations/integration-c2.md). Rows for the features of phase C2: smart seeding on phones, the pin node's receipts and heartbeat,
> the zero-setup ladder and peer-to-peer calls ([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), "SZ";
> ARCHITECTURE 8.1 and 15.14). The rules above apply: a row keeps its id for good, and the status is the status after the design, not after a
> build. Nothing was tested on a phone or a public network. A build lane's note replaces a "By" cell with the code once the lane lands.

| Id and threat | Status | By | What remains |
|---|---|---|---|
| CALL 1 SIG spoofing: a stranger or a peer forges a ring, an offer, an answer or a candidate | blocked for outsiders | the kind `sig` exists only inside the box sealed with `K_pair` (R 2.7.4); a SIG from a non-contact or from outside an active listen set, a `sig` inside an ENV, a stale `t` and a repeated `(c, s)` are dropped | a stolen chat key impersonates in calls as in chat |
| CALL 2 Ring spam and call harassment | mitigated | contacts only; one pending ring per contact and at most 10 an hour; a 45-second expiry; calls off by default; no connection exists before the callee accepts | a contact can ring ten times an hour: block them |
| CALL 3 A relay or tracker on the signalling path alters an offer or an answer | blocked | the fingerprints are inside the sealed SIG; after the connection is up the certificate fingerprint is compared with the one in the SDP, and a mismatch ends the call with `E_CALL_FAILED` | a TURN relay in the media path still shows addresses, sizes and times |
| CALL 4 An address leaked by ringing (PEER B6, for calls) | blocked | a ring has no SDP; the callee creates no connection before it accepts; the caller sends no candidate before the accept | after an accept the participants see each other's addresses, and the card says so first |
| CALL 5 A contact makes your browser probe your network through candidates | blocked | received private, loopback and link-local candidates are dropped unless both chose "same local network"; mDNS candidates pass | the "same local network" choice |
| CALL 6 Same-origin code and the microphone (R 2.1 rule 2) | open (stated) | the SDK returns no media stream; start, accept and screen need a loader card and a verified click; the media APIs occur only under `src/calls/` (a lint) | hostile code on the site's origin can call the browser's media APIs itself once the person has allowed the site; the browser's prompt and indicator govern it |
| CALL 7 An open relay used for free traffic (SYB A17, for calls) | mitigated | a relay only where the owner configured TURN (R 2.7.8 option a or b), named on the card, with quotas and `allowed-peer-ip` deny lists | static credentials are open to anyone who loads the site |
| CALL 8 Address exposure in a group call | open (stated) | contacts or the group's members only; 6 with audio only or 4 with video; the card says each participant sees your address; a roster of at most 5 keys | in a mesh every participant learns every other's address and the roster keys |
| CALL 9 A call as a fan-out of bytes (a mesh sends N-1 streams) | mitigated | caps of 6 and 4; a metered network starts with audio only; the adaptation ladder; torrent wires yield on phones | a 4-way video mesh sends 3 x (400 + 32) = 1,296 kbit/s per participant (arithmetic) |
| CALL 10 Call-setup metadata: the neighbours that carry SIG frames see that a call is being set up | open (stated) | the offer, the answer and the candidates are sealed with `K_pair`; the tag is a per-day HMAC that only the pair can compute; relay stamps and jitter as for chat | the type, the size (an offer or an answer is padded to the smallest bucket that holds it, so its size hints at the media; review round HON-8), the time and the day's pair tag are in the clear (R 2.7.3) |
| SEED 1 Lying bitfields: a peer claims pieces it does not serve | mitigated | a holder count is "reported" and "at least"; "Kept by the site" needs a verified receipt, a fresh heartbeat or a web-seed probe | a liar can raise the N of a "reported" count until spot-checks (E2, v0.4) |
| SEED 2 Re-sharing shows which files a member holds (S1 D1) | open (stated) | a sentence on each kept file and one site-level sentence; the Echo lane never fetches what the person did not open; on phones it needs the person's agreement | peers and the tracker see the address and the infohash of each file torrent announced |
| SEED 3 Draining a phone's data or battery | mitigated | per-lane rates; session and month caps; K and E lock when the page is hidden; calls take priority | the cap binds before the rate (arithmetic: 256 MiB in 34 minutes at 128 KiB/s) |
| SEED 4 A keep-alive trick (silent audio, audio-session writes) | blocked | the contribution lint over this repository's code, and the owner's rejection of the trick | the lint reads this repository only |
| PIN 1 The pin key misused through a page | blocked | `isPinSignable`: only the hello and the receipt forms; the heartbeat is signed by the Node tool; the key never enters a page; it is not the owner key | a stolen pin key signs false receipts until `_mw.cfg.pin` is replaced |
| PIN 2 A replayed hello, receipt or heartbeat | blocked inside its window | a nonce per wire, the infohash and a time (5 minutes, chosen); a heartbeat at most 15 minutes old (chosen) | a label can be 15 minutes stale ("checked {age} ago") |
| PIN 3 The heartbeat file discloses what the pin keeps | mitigated | items are the first 16 bytes of SHA-256 of a domain-separated infohash; the file counts keys and bytes, not people | someone who knows an infohash can test whether the pin holds it |
| PIN 4 A pin filled up through a stolen owner key (SZ-6) | mitigated | the pin store's caps per file and in all (`PIN_LIMITS` in `tools/pin.mjs`: 100 MiB and 2 GiB today); files are never opened or rendered; quarantine; the month cap bounds the bytes the pin uploads | the store caps |
| ZS 1 The name service of a no-domain site is part of its trust root | open (stated) | S2 F1 and F3; the `ship` texts Z1 to Z3; a domain you own removes it | the operators, two volunteers, can point the name elsewhere or block it |
| ZS 2 The page tag expires and no DNS record renews it | open (stated) | `ship` signs 399 days (SZ-3) and prints the date to re-sign | after that date new visitors cannot load the site until the owner publishes again |
| ZS 3 The owner key leaves the owner's machine | blocked | `ship` never copies the key | none |
| ZS 4 A phone trusts a local certificate authority for the LAN demo | open (stated) | the text of S2 Z8 | whoever holds the authority's key can read the secure traffic of every phone that trusts it |

#### Residual exposure by observer, C2

| Observer | Before | Mitigations in this design | After (what remains) |
|---|---|---|---|
| The other people in a call | n/a: v0.3 as built has no calls | contacts only; a loader card and an accept before any address is revealed | your IP address; in a group call every participant's address and the roster keys; the media; your key for this site |
| Chat-lane neighbours that carry SIG frames | n/a | the sealed box; contacts only; relay stamps | that a call is being set up between two day tags, when, and roughly which message by size; not the offer, the addresses or the names |
| The operator of a call relay (if the owner runs one) | n/a | off by default; named on the card; DTLS-SRTP between the browsers | both addresses of each relayed pair, sizes and times; not content |
| Peers of a file swarm you re-share | IP address and the site's files | a sentence on each kept file; phones only with agreement | which files you hold, as well as the address |
| The site's own tracker | IP address and the infohashes it is asked about | none beyond naming it on the card | the infohash of each file torrent you announce |
| Readers of `pin-status.json` | n/a | hashed item ids, no people | the pin's key, the site, the time, the bytes this month and the cap; whether a known infohash is held |
| The operators of `nip.io` or `sslip.io` | n/a | none in software | the name of the site with the resolver of each visitor |
| A network observer or ISP | connections to trackers, STUN and peers | none in a browser | the flows between call participants, their volume and timing; not the content |

## The v0.2.1 hardening, carried by 0.3.0

These defects were in the 0.2.1 code, independent of v0.3 (R 1.3 section H, 2.16.4). 0.2.1 was never published, and
0.3.0 fixes them, because every v0.3 limit multiplies them. Seven of the rows below are the seven 0.2.1 defects that
work today, the reason 0.2.1 is never published: MF-27, MF-28, MF-30 and MF-73 to MF-76 (the list of
[PUBLISH-CHECKLIST.md](PUBLISH-CHECKLIST.md), section 0). MF-30's signed `minSeq` is not built (proposed; the withdrawal
expiry, a per-ledger seq floor on each device and resolver failover on empty or older answers cover the cold-device replay
meanwhile: review round PTR-4). MF-77 concerns the author-scoped keys that the
v0.3 social features need, and its rendezvous part stays open (SYB A10). Values in this table are chosen (R 2.16.4,
MF-30, MF-74, MF-75) unless the row says measured.

| Item | Defect in 0.2.1 | Fix | Source |
|---|---|---|---|
| Frame bounds | One 205-byte HELLO with an unbounded `d` freezes a tab (measured in a scratch run outside the repository: d = 2e10 took 34 s and 290 MB) | validate `n` (at most `maxChainBytes` over the smallest block) and `-1 <= d < n`; clamp `last` in `_startSync`; a strike; a unit test with `Number.MAX_SAFE_INTEGER`; a fuzzer over every numeric field | MF-73, PEER A1 |
| Caps by wire | Wire caps are bypassed by one reused peer id; ignored peers keep slots; ties in tenure allow an eclipse; idle wires are never closed | count by wire; close ignored wires; anchor slots for wires that delivered valid blocks; random eviction among ties; close wires that are silent 2 minutes after the handshake; poll `cs=` when there are peers but no progress | MF-74, PEER A2, A3, A10, SYB A9 |
| Policy before signature | The signature is checked before the policy; the throttle is bypassed by a backdated `ts`; `ut_metadata` requests amplify past the choke lock | admit, writer and fee checks before ECDSA; a per-wire verification budget; throttle by arrival time for live blocks; drop `ut_metadata` requests beyond 4 per wire per minute once the metadata is complete | MF-75, PEER A4, A5, SYB A2, A12 |
| Web seeds from unsigned magnets | One link turns visitors into a probe of loopback and LAN addresses, and into a reflector | unsigned records: at most 4 `ws=` and 2 `xs=`, https only, no loopback, link-local, private or `.local` hosts except the page's own origin; no per-URL failure reasons | MF-76, PEER A9 |
| Author-scoped keys | Reactions and follows can be stuffed; a `put` overwrites across authors; the rendezvous can be poisoned | `@`-prefixed keys take effect only from their author (freeze group); counts from vetted keys where a site vets; PEX bootstrap and persisted good peers are not built and cannot be as stated: a browser's WebRTC wire has no address to dial again and a new peer id each session, and `ut_pex` carries `ip:port` values a browser cannot use (code review v0.3, round 2; a signed peer-hint record is on [ROADMAP.md](ROADMAP.md)) | MF-77, SYB A10, A13 |
| Loader state | Withdrawals and pointers replay to cold devices; the DNS TTL is uncapped; first-use DNS trust shows an "AD" badge; hub Public Suffix List tricks; same-origin code can poison stored state | clamp the TTL (5 minutes to 1 day) and timers at 2^31-1 ms; withdrawals expire after at most 30 days and are re-signed; a signed `minSeq` in the ledger policy **(proposed)**; `#host:name@<fp>` links (built); the wording "resolver says validated" (built); a Public Suffix List probe that disables persistent identity on other hubs; pins and refusals signed by a per-device key, refusals expiring after 7 days (same-origin code can use that key in shell mode, so the signatures catch accidental edits only: review round PTR-11) | MF-30, PTR A2 to A4, A8, A9, HUB H4 |
| Moderator keys | The key is extractable in IndexedDB; moderation needs no gesture; nothing can be undone | non-extractable after import; `mod.ban`, tombstones of other people's items and bulk actions need a loader card with `isTrusted` input; a per-moderator cap per hour as a policy field; `unban` | MF-27, HUB H2 |
| A stolen owner key | A silent `rot=`, a hand-over, a deliberate `ownerConflict` freeze and a `seq` race | the pointer commits to the next owner key (`nx=`); the `rot=` v1 path is deleted; loaders show "owner changed N minutes ago" and delay a rotation for first-time visitors unless `nx` matches; a test that equivocation cannot lock out the committed key | MF-28, HUB H3, H12, PTR A5 |
| Remaining items of R 2.16.4 | Frames are decoded before their length is charged; the deferred pool is shared; the want table fills; sync slots can be squatted; ownerless hub ledgers cannot be moderated | decode only after charging the frame length to the budget, with per-peer shares for the deferred pool; per-source want caps of 256; idle sync sessions closed after 3 s without new blocks, with proven peers pre-empting; hub loaders show ownerless ledgers read-only | PEER A6 to A8, HUB H10 |

The loader-hardening lane (`docs/deviations/harden-loader.md`) records two choices the review left open: the `nx=`
commitment is sticky under one owner (a thief holding the current key could otherwise re-commit `nx=` to their own
key and then rotate, in two steps), and a first-time visitor's delay before accepting a rotation is 24 hours (chosen
there; R gives no number).

## Every red-team attack and its status

Six judges and eight attackers produced 258 findings ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md),
Part 1). This is R 2.17.6, row for row, in groups by attacker. "By" names the rule, section or must-fix item that
answers the attack. The status is the status **after the design as built**: the review round of R 5.3 re-read each row
against the code (2026-10-22 to 2026-10-24, R 5.4), and the rows it changed name the finding.

| Group | Attacker | Rows |
|---|---|---|
| PEER | malicious peers and wire attacks (A: the 0.2.1 code; B: the proposals) | 21 |
| HUB | hub takeover, moderation abuse and insiders | 13 |
| MAL | malware and illegal content through shared files | 15 |
| PHISH | phishing and account takeover | 18 |
| PTR | poisoned pointers, DNS and hosts | 10 |
| STALK | stalking, doxxing and deanonymisation | 15 |
| SC | supply chain, builds and updates | 10 |
| SYB | Sybil, spam and flooding | 18 |


### Malicious peers and wire attacks (PEER)

| Attack | Status | By |
|---|---|---|
| PEER A1 HELLO freeze | blocked | MF-73 |
| PEER A2 cap bypass by a reused peer id | blocked | caps by wire, ignored wires closed |
| PEER A3 rendezvous eclipse | mitigated | anchor slots, random tie eviction, idle close, `cs=` poll on "peers but no progress"; tracker Sybil share unmeasured |
| PEER A4 signature before policy | mitigated | policy and fee checks first, per-wire verify budget |
| PEER A5 `ut_metadata` amplification | blocked | 4 requests per wire per minute after metadata |
| PEER A6 want table fill | mitigated | 256 wants per source |
| PEER A7 sync-slot squatting | mitigated | 3 s idle, proven peers pre-empt |
| PEER A8 decode before budget, shared pools | blocked | charge by length first, per-peer shares |
| PEER A9 web seeds from unsigned magnets | blocked | MF-76 |
| PEER A10 idle and slow wires | mitigated | idle close; lab check that a hash failure destroys the wire |
| PEER B1 relay flood | mitigated | frame-bound stamps, fair queues, interest routing; an attacker with enough compute still pays per frame |
| PEER B2 reusable stamp, computable tag | blocked | 2.7.3, 2.7.5 |
| PEER B3 holder poisoning and wipe | mitigated | per-source quotas keyed by the Noise static key, stamp-weighted eviction, a COLLECTED proof the holder checks (a hash lock: review round DS-7, SYB-15) |
| PEER B4 WANT/HELD amplifier and oracle | blocked | rate per tag per wire; inbox key proof |
| PEER B5 presence and room spoofing | blocked | signed or MAC'd PRES, room check order and `t` window |
| PEER B6 direct-channel signalling from strangers | blocked | 2.7.8 |
| PEER B7 challenge relaying | blocked | Noise XX handshake |
| PEER B8 parser surface | mitigated | stated bounds, fuzzing |
| PEER B9 untrusted torrent metadata | blocked | 2.8.3 |
| PEER B10 decode bombs and name spoofing | blocked | pixel cap, worker decode, name rules |
| PEER B11 drop-in card overlay | blocked for high-risk cards (IdO window); mitigated in-page | 2.3.4 |

### Hub takeover, moderation abuse and insiders (HUB)

| Attack | Status | By |
|---|---|---|
| HUB H1 hostile host takes the root | blocked | root only at the IdO; that site's keys remain exposed to its host |
| HUB H2 moderator key theft, silent mass moderation | mitigated | MF-27 |
| HUB H3 stolen owner key | mitigated | `nx=`, visible delay, rot v1 deleted; open if both the current key and the committed next key are stolen |
| HUB H4 replay of old withdrawals or pointers | mitigated | withdrawal expiry 30 days, a per-ledger seq floor on each device, resolver failover on empty or older answers (review round PTR-4); `minSeq` (proposed: not built) |
| HUB H5 moderator tombstones owner entries | blocked | state rule; a moderator `put` cannot replace an owner-written entry, a `_deny/` entry changes only by the owner or its author, and a voided author's `_` writes have no effect (review round HUB-6) |
| HUB H6 a removed moderator's bans survive | mitigated | `unban`, `voided` |
| HUB H7 values dropped before a revocation | mitigated | 24 h grace, for moderator bans and bulk tombstones too (review round HUB-2) |
| HUB H8 D-9 and D-10 levers | mitigated | caps, also per checkpoint epoch (24 hours of actions, 7 days of allow additions: review round SYB-2); a moderator acts only with its appointment in its causal past (HUB-4); standing rules; recover precedence; a self rotation passes bans and history to the next key only with that key's signature `nsig` and needs the write right (HUB-1, HUB-7); `keyinfo` |
| HUB H9 fake credible report | mitigated | narrow first action |
| HUB H10 ownerless hub ledgers | blocked | read-only on hubs |
| HUB H11 denylist or directory as a point of control | mitigated by written rules; build deferred | 2.17.5 |
| HUB H12 pointer seq race | mitigated | `nx=` |
| HUB H13 impersonation, linkability levers | mitigated | badges, short ids, once per 30 days |

### Malware and illegal content through shared files (MAL)

| Attack | Status | By |
|---|---|---|
| MAL A1 shared file runs as the site | blocked | 2.8.5 |
| MAL A2 auto-preview seeders | blocked | 2.8.4 |
| MAL A3 pin node keeps anything | mitigated | moderator queue, quarantine; the pin page host refuses to join an item the site's ledger denies, by infohash or declared SHA-256, and leaves an item it already holds when a later `_deny/` entry names it, within about 2 s (review round MAL53-3: `src/loader/pinwire.js:607` `createPinPageHost`, `:626` to `:637` `sweep()`, `:648` to `:653` in `start()`, `:687` to `:691` in `status()`; wired at `src/loader/app.js:4525`, `denyChecker`; the left item's bytes and kept `.torrent` are deleted from the pin's browser profile, `discard` at `src/loader/app.js:4527`); the pin node's queue quarantines a denied item in `decide('accept')` and `restore()` (`tools/pin.mjs:465` to `:486`, `:501` to `:515`); open: the node's Node process asks the page host and has no ledger of its own, so an offline `--approve` or the month cap leaves a denied item on disk until the next status tick or the month's end, and the heartbeat can list it for one `--interval` (review-round-media.md, "Still open after R4", O-1 and O-2) |
| MAL A4 verified malicious files | mitigated | tiers (LNK, CHM, OneNote, AppleScript, CAB, VHD, VHDX, ISO and UDF named by their bytes; unknown, html, svg, xml and pdf need a second confirmation: review round MAL53-7), wording; open for people who run what they download |
| MAL A5 MIME confusion | blocked | sniff and allow-list |
| MAL A6 takedown evasion | mitigated | `_deny/`, checked against every public fetch's own digest (review round MAL53-4); open for near-duplicates |
| MAL A7 ban evasion by keys | mitigated | premoderation, `allow`; an acceptance credits only the listing's own author (review round MAL53-1); open by design |
| MAL A8 unsolicited private shares | blocked | no auto-accept, hidden names |
| MAL A9 moderation blind spot for private shares | mitigated | metadata reports; open for sharing nobody reports |
| MAL A10 reporting duties without a channel | mitigated | OPERATIONS file-lane section, quarantine |
| MAL A11 takedown by false report | mitigated | narrow actions, user files on a separate path |
| MAL A12 the ledger carries content | mitigated in part | the reserved pool shared by unvetted authors, the per-author entry rate, premoderation of a new key's first public files, and the open-writing warning of `ledger-admin` and `publish`; the per-author byte quotas of MF-54 are **(proposed)**, not built (OPERATIONS, "The file lanes") |
| MAL A13 hash substitution | blocked | fetch fails closed |
| MAL A14 decoder exploits in previews | mitigated | short list, click first, worker, "never preview"; open |
| MAL A15 holders store unknown ciphertext | mitigated | card text; open by design |

### Phishing and account takeover (PHISH)

| Attack | Status | By |
|---|---|---|
| PHISH A1 fake loader asks for the phrase | blocked on site origins; open for a person who types the words into another page or a fake IdO | 2.2.6 |
| PHISH A2 hostile page paints a fake panel | blocked for secrets; mitigated for overlays | 2.3.4 |
| PHISH A3 same-origin script takes the root | blocked | that site's keys remain |
| PHISH A4 passkey prompt abuse | blocked | RP ID at the IdO |
| PHISH A5 UI redress | blocked for high-risk cards; mitigated in-page | 2.3.4 |
| PHISH A6 malicious device B, quishing | blocked | commit-reveal, requested screen, in person; open for a person who links an attacker's device in person |
| PHISH A7 reverse-proxy phishing | blocked | browser-stamped origin, user verification on first approval; open for a person who approves the wrong origin |
| PHISH A8 verifier misuse | mitigated | library rules; open for server code that ignores them |
| PHISH A9 shared browser | blocked | sign out deletes keys |
| PHISH A10 key-selection spoofing | blocked | 2.2.3 |
| PHISH A11 rotate races, social engineering | blocked (races); mitigated (social engineering) | 2.5.3 |
| PHISH A12 phishing inside a site | mitigated | badges, short ids, link warnings |
| PHISH A13 same-identity dark pattern | blocked | 2.3.5 |
| PHISH A14 offline guessing of the file | mitigated | generated passphrase; open for a chosen passphrase above the floor |
| PHISH A15 provider recovery becomes identity recovery | open, stated | phrase-only mode offered |
| PHISH A16 malicious extension | open, out of scope | stated |
| PHISH A17 hostile host or loader update | mitigated for the root; open for that site | 2.16.1 |
| PHISH A18 nonce contradiction | blocked | 2.3.2 |

### Poisoned pointers, DNS and hosts (PTR)

| Attack | Status | By |
|---|---|---|
| PTR A1 ledger-id squatting | blocked | lineage precondition (`pointerLineage`: a hub address refuses a record whose `lo=` is unproven, a shared hub or a door mounts it read only; the loader's check was missing and was added in review round PTR-1), read-only mount, labels |
| PTR A2 uncapped TTL | blocked | clamp |
| PTR A3 first-use DNS trust | mitigated | fingerprint links (matched against `owner=`, or `lo=` with proven lineage: review round PTR-2), AD wording; open without a fingerprint |
| PTR A4 cold-device rollback | mitigated | withdrawal expiry; a per-ledger seq floor on each device; resolver failover on empty or older answers (review round PTR-4); `minSeq` (proposed: not built) |
| PTR A5 rotation without revocation | mitigated | `nx=` (checked on every update path since review round PTR-3), rot v1 deleted |
| PTR A6 withdrawal abuse | mitigated | resolver failover on empty answers, quote frame, purge scope |
| PTR A7 compromised host, root on that origin | blocked for the root; open for that site | |
| PTR A8 hub PSL tricks | mitigated | PSL probe |
| PTR A9 state poisoning by same-origin code | partly mitigated | the floor and `nx=` come from the signed saved record (review round PTR-11); signed pins and expiring refusals catch accidental edits only, because same-origin code can use the device key in shell mode; open for deletion |
| PTR A10 `mw-doh` override | mitigated | not used for a device's first lookup |

### Stalking, doxxing and deanonymisation (STALK)

| Attack | Status | By |
|---|---|---|
| STALK A1 inbox-tag test | mitigated | 2.7.5; a stranger frame shows one byte of the recipient's inbox tag and leaves at a random hop (review round STALK-7); a first-hop neighbour can still guess by timing |
| STALK A2 public presence beacon | mitigated | off by default, honest card; open by choice |
| STALK A3 first-seen origin inference | mitigated | a 0.5 to 3 s per-peer delay before a new ledger block is announced (review round STALK-8); own chat frames leave after a jitter at a random hop to a random half of neighbours (PRIV-1); relay subsets for ledger blocks are not built; open against wide Sybil sets |
| STALK A4 Sybil harvest of the swarm | open by design (IPs are visible to peers) | per-IP-prefix wire caps and a members-only lane id: not built (review round HON-1) |
| STALK A5 phrase leak is retroactive | mitigated | random content keys, extra word; open for public identities |
| STALK A6 public link statements | blocked | nothing in the ledger |
| STALK A7 cross-site re-linking by metadata | mitigated in part | self-hosted widget, own trackers; the escrow copies no longer link sites (review round SEC-1, STALK-1); the announce delay after sign-in is not built, only the 0 to 1.5 s rendezvous join jitter (`src/loader/config.js`; review round HON-1); open for IP |
| STALK A8 EXIF | blocked for images (TIFF and camera RAW included), MP4 and MOV (an allow-list of boxes, times zeroed), WebM, MP3, AVI and WAV (review round PRIV-5, STALK-10); mitigated for other types (warning) | 2.8.2 |
| STALK A9 hashes, sizes, timing | mitigated | padding, optional `sha256` |
| STALK A10 stalker in the group | mitigated in part | requests off; `introduced` takes no requests until introductions are built (review round STALK-9); blocks kept in the vault and "a new identity with no link" are not built |
| STALK A11 malicious hub operator | mitigated | shared-origin rule, recipient rows; open: the hub serves the loader |
| STALK A12 profile metadata and style | open | the reused-name hint is not built (review round HON-1) |
| STALK A13 presence and write timing | open (needs measurement) | G-CH-7 |
| STALK A14 WebRTC address exposure | open (needs measurement) | G-CH-8 |
| STALK A15 roles as surveillance posts | open, stated | owner docs |

### Supply chain, builds and updates (SC)

| Attack | Status | By |
|---|---|---|
| SC-1 forged or swapped release | mitigated | 2.19: signed per-file lists checked against a key built into the tools (`PINNED_RELEASE_KEYS`), `--expect-version` against rollback, `sign --rebuilt`, attestation checks bound to workflow, tag and commit (SECURITY.md); open until the tag-creation rule, the main-ancestry step and the named second pin are in place (review round SUP-2, requests in `docs/deviations/review-round-tools.md`) |
| SC-2 hostile dependency | mitigated | lock everything, cooldown, two-person rule; open for a reviewed malicious upstream |
| SC-3 npm tarball without lockfile | mitigated | shrinkwrap; `--ignore-scripts` in SECURITY.md, the tools and the deploy recipes; install scripts listed with a reason (`tools/install-scripts.json`); open until the release notes, README, CHANGELOG and checklist install lines carry the flag (review round SUP-1) |
| SC-4 verification library name squat | mitigated | reserved names, vendorable file; no npm provenance (both packages are published by hand, no workflow publishes to npm), and the registry copy is not yet tied to the signed release (review round SUP-10) |
| SC-5 phrase into a hostile loader copy | blocked | no phrase on site origins |
| SC-6 worker pins a hostile loader; kill switch leaves keys | mitigated | `ml=` floor, purge mode, backup nudge |
| SC-7 shared-CDN widget | blocked | self-hosted with SRI only |
| SC-8 reproducibility | mitigated | cross-OS rebuild job, `verify-release`, `sign --rebuilt` (the owner signs only what the source builds on the signing machine) |
| SC-9 demo deploy on push | open | every push to `main` deploys the demo origin, and the `github-pages` environment has no required reviewer yet (review round SUP-14) |
| SC-10 canonicalisation drift | blocked | RFC 8785 normative, shared negative vectors |

### Sybil, spam and flooding (SYB)

| Attack | Status | By |
|---|---|---|
| SYB A1 ledger bloat to the cap | mitigated | reserved pools, checkpoint, raised `bits`, a lifetime block cap for every author, the fee on an orphan's parents (review round SCALE-8, MP-6); open: one unvetted key can fill the reserved pool, because there is no per-author share (review round SCALE-4, deferred to the owner) |
| SYB A2 backdated `ts` | blocked | arrival-time throttle |
| SYB A3 ban evasion | mitigated; open by design | `allow`, premoderation |
| SYB A4 cleanup cannot keep up | mitigated | bulk tombstone, checkpoint |
| SYB A5 one stamp, unlimited messages | blocked | frame-bound stamps |
| SYB A6 trial-decrypt flood | blocked | stamp before ECDH, per-tag cap |
| SYB A7 ROOM flood | mitigated | role first, buckets, verify cap (20 ROOM signature checks a second per wire, 100 in all: review round SYB-10) |
| SYB A8 holder quota squatting | mitigated | per-source quotas keyed by the Noise static key, stamp-weighted eviction (review round DS-7) |
| SYB A9 eclipse | mitigated | as PEER A3 |
| SYB A10 rendezvous poisoning | open | own tracker only: persisted good peers and PEX bootstrap (MF-77) cannot be built in a browser as stated (no dialable address, a new peer id each session); public tracker behaviour unmeasured |
| SYB A11 offer and ICE flood | open (needs measurement) | drop offers at the hard cap before creating a peer connection, if measured as real |
| SYB A12 verification asymmetry | blocked | policy before signature |
| SYB A13 reaction and follow stuffing, `put` overwrite | mitigated | author-scoped keys, counts of keys |
| SYB A14 file-drop floods | mitigated | click to fetch, listing caps applied by every honest copy when it reads (25 MiB a file, 256 MiB a site, the first 20 listings per author, one row per infohash: review round SCALE-1, SYB-13), verified lengths |
| SYB A15 pin node and tracker DoS | mitigated | tracker: listed swarms never refused, unlisted swarms capped per connection (256) and in all (10,000), a closed connection takes every peer id it announced (review round SCALE-10); pin: total connection cap, egress bucket; open: no per-IP cap behind the proxy |
| SYB A16 signup and nonce flood | mitigated | stateless nonces, cheap-first checks, optional difficulty |
| SYB A17 TURN abuse | mitigated | off by default, quotas, option (b) |
| SYB A18 fabricated presence, look-alike names | mitigated | signed presence, badges |

## Honest limits

These are the limits the project says out loud, in the same words everywhere (README, WHY, FAQ, the cards). Each is a
property of the design, not a bug waiting for a fix.

1. **No forward secrecy for retained envelopes.** A direct message is sealed to the recipient's chat key. Whoever
   later obtains that chat private key can open every envelope they recorded; there is no ratchet and no
   post-compromise security (R 2.7.4).
2. **Harvest now, decrypt later on P-256.** Envelopes recorded today could be opened by a future break of P-256.
   Records and private media use symmetric keys and are not affected by that (R 2.7.4).
3. **Hostile site code can use that site's keys.** "Code on a site you are signed in to can copy your keys for that
   site." In shell mode the site frame is same-origin with the loader, and in drop-in mode the page is the loader's
   realm, so the design never claims that site code cannot use the keys of the site it runs on. It is built so that
   such code cannot reach the root, the phrase, another site's keys or another site's data, which rests on the
   browser enforcing origins (R 2.1 rule 2, 2.14.2).
4. **The same code can read what the site can read.** While a person is signed in, the site's own code can read their
   sealed record (after the first card) and the playback keys of that site's private media. The owner cannot read
   private lanes from the ledger or the swarm, but can read them through the code visitors run.
5. **A hub can take personal-site owner keys.** A hub serves the loader for every label on its domain. A hostile hub
   operator could take the owner keys of the personal sites it serves (R 3.3, STALK A11). Hub-scoped identity is
   offered only by choice, and shared-origin hubs never hold a persistent identity. With hub-scoped identity, a page of
   the hub that the person signs in to can post as them on every page of the hub; the card says so (review round
   HUB-3).
6. **A tracker can sit in the middle of the WebRTC transport.** It relays the offers and answers, so it learns both
   addresses and the timing. It cannot read or forge sealed messages, and the wire handshake means a relay that
   swaps peer ids holds a different transcript (R 2.4.3, MF-40).
7. **The identity origin's served code is a central trust point.** Altered code at the identity origin takes the roots
   of people who unlock afterwards. The mitigations are a published bundle hash, a reproducible build, signed
   releases and the option to run your own identity origin; none removes the trust.
8. **Anyone who learns the 12 words can act as the person on every site.** They get the public identities and can
   enumerate where the person posted. They do not get old messages, records or own media unless they also have the
   backup file or an unlocked device, because those keys are random and live in the vault (R 2.2.2, 2.16.2). With an
   optional extra word, a leaked phrase alone derives nothing. A person who types the words into another page or a
   fake identity page loses every identity; felinar never asks for them on the site you are signing in to.
9. **A passkey provider's account recovery becomes a recovery path** for the identity unless the person chooses
   phrase-only mode (PHISH A15, open and stated).
10. **Pseudonymous, not anonymous.** Everyone the browser connects to sees its IP address; so do trackers, STUN
    servers and any relay. They can see when it is active and which felinar sites it opens, and can link activity
    on several sites by that address (R 2.18). Nothing proves who a person is, their age, or that one key is one
    person.
11. **Recipients keep what you send.** A recipient can keep, forward or screenshot a message, a file or a video.
    Revoking a share is best effort in honest apps only. Group messages are provable inside the group; direct
    messages are not provable to a third party, but the recipient knows who wrote them.
12. **Permanence of the ledger's outline.** Anyone with a ledger copy keeps what they copied before a checkpoint.
    Membership and bans in the current state are public. A deleted entry leaves a stub (who signed it and when) until
    the owner writes a checkpoint, and copies on devices that never sync stay.
13. **Availability is not guaranteed.** Private media plays only while some holder of the ciphertext is reachable.
    Offline delivery needs an opted-in holder (the hub pin mailbox is proposed: no page sends it frames yet). "Delivered" is shown only when an
    acknowledgement came back. Phones relay and hold nothing by default.
14. **Keys cost nothing but the fee.** The design never claims Sybil resistance. Open writing on a public ledger stays
    usable under an attacker with a GPU only for vetted users; recommend an `allow` list or vouching for any site
    that matters (R 2.17.1).
15. **"Verified" is not "safe".** For a shared file it means only that the bytes match what the sender listed.
    Near-duplicates and re-encodings are not caught by a `_deny/` entry.
16. **New cryptographic code has had no outside review.** The identity derivation and wrapping, `mw-signin-v1`, the
    Noise XX instantiation over P-256, the sealed box, the media chunk format and the freeze-group rules are new. None
    is called secure before the independent audit that R 2.19 requires before 1.0.
17. **Malicious extensions and compromised devices are out of scope** (PHISH A16).

### Honest limits added by v0.3 C2

The same words are used in the README, WHY, FAQ and the cards. The numbering continues the list above.

18. **A call shows your IP address to every participant.** A relay hides it from them only when the owner runs one and you choose to hide it,
    and then the relay's operator sees both addresses, sizes and times.
19. **A call needs the page open.** On iPhone call video stops when you leave the page, a Home Screen app can lose the microphone, and a phone call
    pauses capture; Android can cut the network of a phone that is unplugged, still and dark. A call rings only while the callee has the site
    open. iOS 26 and 27 and Android with the screen off are unmeasured (G-CL-2, G-CL-3).
20. **Hostile site code can use a camera or microphone permission the person gave the site.** The SDK returns no media stream and no call
    starts without a click on a loader card, and none of that stops same-origin code that calls the browser's own API (R 2.1 rule 2).
21. **Phones never provide durability.** A closed or suspended page seeds, relays, holds and rings nothing, and no website can wake it. A pin
    node is the only durable tier; without one, or a host copy, nothing stays available while nobody who has it is online.
22. **A holder count is a claim.** A bitfield can lie, and a phone sees at most 8 wires, so counts read "at least" and "reported". Only a
    verified receipt, a fresh signed heartbeat or a web-seed probe can say "Kept by the site", and that label carries its age.
23. **Sharing shows which file you hold.** Peers and the tracker see the address and the infohash; the carry meter counts bytes locally and
    proves nothing about anyone.
24. **A name from `nip.io` or `sslip.io` puts its operators in the trust root.** They are two volunteers with no uptime promise and a phishing
    block list; the name changes with the server's IP address; the signed address record is the only pointer and expires (90 days by default, 399
    at most: ARCHITECTURE section 4), after which new visitors cannot load the site until the owner publishes again. A bare IP address cannot hold passkeys (reported),
    and a home connection behind carrier-grade NAT cannot be reached.
25. **A local-network demo asks each phone to trust a local certificate authority.** Whoever holds its key can read the secure traffic of every
    phone that trusts it; keep it on one computer and remove the certificate afterwards.

## Findings of the build lanes that touch a row

The lanes that have built parts of the design recorded these while building. They are inputs to the review round,
not conclusions. Each points to the lane note that holds the detail.

| Lane note | Finding | Row it touches |
|---|---|---|
| [deviations/chat.md](deviations/chat.md), O-1 | A holder cannot verify the COLLECTED proof, because it does not know the pair key. A collector that asked for a 1-byte prefix bucket can delete every frame of that bucket it was handed. A real fix needs a commitment the holder can check, which changes the envelope layout, so it is left to the owner and the review. Closed in the review round (SYB-15, HUB-8): a contact frame's iv is `SHA-256("mw-collect-v1" | s)[:12]` with `s = HMAC(K_pair, "collect|" | tag | epk)`, COLLECTED carries `s`, and the holder deletes only a frame that `s` opens; the frame sizes did not change ([deviations/review-round-chat.md](deviations/review-round-chat.md)) | PEER B3, B4 (holder poisoning and wipe), MF-33 |
| [deviations/chat.md](deviations/chat.md), D-1 | A message request's sender key is inside the ciphertext, so stranger frames are keyed by the ephemeral exchange alone and carry an inner authenticator under the pair key. Without it anyone holding a public chat-key record could send requests in that person's name. The recipient can still build such a frame itself, so deniability holds | MF-41, STALK A10 (message requests) |
| [deviations/chat.md](deviations/chat.md), O-7, O-8, O-9 | Stranger stamps at 20 bits are minted inline on the main thread, with nothing measured on a phone (G-CH-6); the `introduced` setting behaves like `on` because introductions are not built (since the review round, STALK-9, it takes no requests); a group's own swarm is not joined, groups ride the chat lane by tag | SYB A5, MF-32 |
| [deviations/idcore.md](deviations/idcore.md), items 1 and 2 | The P-256 public point is computed by a small BigInt routine that is not constant time; it runs at the identity origin on the person's device once per derived key, and signing stays in WebCrypto. Argon2id runs as plain JavaScript and was measured at 1.3 to 2.5 s for 64 MiB, 3 passes, on an Apple M3 in Node, Chromium and WebKit (the review expected about 0.1 s from a WebAssembly build). Mobile is not measured (G-ID-6). Constant-time arithmetic or WebAssembly Argon2id is open before 1.0 | PHISH A14, MF-17 |
| [deviations/harden-loader.md](deviations/harden-loader.md), items 1 to 3 | The `rot=` v1 path is gone, so the frozen vector `ptr-010` now verifies as owner-changed; `nx=` is sticky under one owner; an `nx=` match needs no `rot=` | HUB H3, PTR A5 |
| [deviations/media.md](deviations/media.md), item 15 | 16,384 pieces would need 327,680 bytes of piece hashes, more than the 256 KiB (262,144 bytes) `.torrent` cap, so the cap binds first at about 13,100 pieces (arithmetic: 262,144 / 20). Both limits are enforced | PEER B9, MF-55 |
| [deviations/media.md](deviations/media.md), item 16 | Chromium adds its own sRGB colour profile to every re-encoded JPEG. The profile of the original is gone; "ICC profiles dropped" means the original profile | STALK A8, MF-57 |
| [deviations/media.md](deviations/media.md), Open | Streamed `206` from the worker on iOS Safari and `CryptoKey` cloning into a worker are unverified (G-MD-2, G-MD-3, G-MD-6); a chunk that never arrives errors the stream after 120 s (chosen) | MAL A1 (route), media playback |
| [deviations/freeze.md](deviations/freeze.md), decision 4 and Requests | The depth of a block whose covered parent this copy never held is the deepest covered depth, so windows can differ from a full copy there; the reserved pool, `E_LEDGER_FULL` and the moderator grace are admit and node rules that the chain-net lane still has to build | SYB A1, HUB H7 |

## What a release has to re-check

Before a release that touches any row above, the maintainers re-read these rows against the code and say so in the
release notes (R 2.19):

- every row whose "after" column mentions a rule the release changes (for example, the freeze group, the wire
  handshake, the media route headers);
- the open rows, to see whether a gate row has since decided them;
- the findings table above, to see which are closed;
- the sign-in and identity rows against the identity origin's build id and bundle hash.

## Sources

R 2.16 and 2.17 (this page's tables are copied from them); R 2.19 (the program); the six judge files and eight
red-team files under `docs/research/v03/` (cited by finding id in R); the lane notes under
[deviations/](deviations/). The security program itself (releases, provenance, audit) is in
[SECURITY.md](../SECURITY.md).
