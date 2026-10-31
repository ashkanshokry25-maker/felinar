# Roadmap

What comes after 0.3.0, in order. It is a list of work, not a schedule: no item has a date. An item moves up when
someone needs it and down when evidence says it matters less. To propose a change, open a feature request or a pull
request against this file (see [CONTRIBUTING.md](../CONTRIBUTING.md) and [GOVERNANCE.md](../GOVERNANCE.md)).

Version 0.3.0 is the first public release (0.2.1 was never published). It carries the
v0.3 and C2 code. It is not called production-ready. That label waits for the release gate
on real devices ([DEMO-RESULTS.md](DEMO-RESULTS.md), item 25 of [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md)),
and passing that gate is what "1.0" means here.

The four research digests hold the full prioritised lists. This page groups them into tiers, and a row that is not
named here is still in its digest and can be picked up. What the 0.2.1 work already took from them (the frozen formats,
the web-seed and tracker fixes, consent, mobile defaults, the publishing gates; 0.3.0 carries all of it) is in
[CHANGELOG.md](../CHANGELOG.md) and in the Status column of [review/DIGEST-AMENDMENTS.md](review/DIGEST-AMENDMENTS.md).

## How to read the evidence column

| Short name | Document | What it is |
|---|---|---|
| RD | [research/RESEARCH-DIGEST.md](research/RESEARCH-DIGEST.md) | Wave 1: foundations (engine, trackers, serving, DNS, mobile) |
| MD | [research/MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md) | Wave 2a: moving existing sites onto felinar |
| PD | [research/PRODUCTION-DIGEST.md](research/PRODUCTION-DIGEST.md) | Wave 2b: trackers, connectivity, observability, abuse and legal |
| ID | [research/IMPROVEMENTS-DIGEST.md](research/IMPROVEMENTS-DIGEST.md) | Wave 2c: ledger, identity, hubs, testing, standards, economics |
| DA | [review/DIGEST-AMENDMENTS.md](review/DIGEST-AMENDMENTS.md) | The normative v0.2.1 amendments (section G is the roadmap list) |
| DR | [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md) | The design review (section 3 is "later", section 7 is code review round 1) |

A cell such as "ID P1-5" means row P1-5 of the improvements digest, which holds the evidence and the reasoning.
"F13" is a finding of code review round 1. Every number the digests give for economics is modelled, not measured.

## Tiers

| Tier | What it holds | It is done when |
|---|---|---|
| Next (0.4) | Known gaps from review, and items that are cheap only while few ledgers and pointers exist | each item is merged with tests and a [CHANGELOG.md](../CHANGELOG.md) line |
| 1.0 | The production-ready bar | the release gate passes with dates, versions and numbers recorded, and every item below is done or moved with a reason |
| Later | After 1.0, or waiting for field data | per item |
| Not planned | Declined, with the reason | only with new evidence |

## Left open by code review round 1

Each item has its reason in the "Code review round 1" section of [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md).
0.3.0 did F13 (its row says how); the other rows wait.

| Item | Why it waits | Tier |
|---|---|---|
| F13: retire `rot=` v1 (a key rotation not bound to the scope) | Done in 0.3.0: the v0.3 hardening removed the silent `rot=` v1 path (MF-28, the changelog's "Breaking"). The frozen vector `ptr-010` stays and now verifies as owner-changed, and the new vector `ptr-023-rot-v1-refused` supersedes it; tools write v2 and loaders verify it. The row stays as the record until 0.3.0 is published. | Done in 0.3.0 |
| F36: a non-extractable posting identity with a separate, passphrase-wrapped export path | In 0.3.0 the backup is a passphrase-wrapped file at the identity origin, not an export of a site key, but a site's working keys can still be used and copied by that site's code while the person is signed in ([SDK.md](SDK.md)), so the non-extractable posting key is still open. | 1.0 |
| F39: patch WebTorrent's web-seed connection to skip BEP 47 pad files | It needs a new patch point in the vendored bundle, which is better done with an own bundle. Until then an external `ws=` is dropped with a warning when the torrent has non-empty pad files, and the drop-in rewrite answers pad paths with zeros. | 1.0 |
| F53: behavioural tests for the guarded buttons still checked as source text (the gate, identity export and import) | The shell guard and the consent waiters are covered by the PEER-CONSENT and FMT-SDK scenarios. The rest are smoke tests. | Next |
| F07 option (b): serve from memory when the Service Worker can't store anything | Today the loader reloads once into limited mode, which covers the case. | Later |
| Fill a new drop-in version from the previous one in IndexedDB (same path and SHA-256) | It needs a "prefill from stored file" hook in the TorrentManager. See file-granular delta updates under 1.0. | 1.0 |
| End-to-end checks still missing: a module Service Worker that integrates `sw-core.js`, a network change from Wi-Fi to mobile data during a drop-in copy, a post written before a key rotation, an unsigned withdrawal link on a shared hub | Each is fixed and tested at unit level only. | Next |
| The consent choice can be lost: a top-level reload in the instant after "Share and load" can abort the IndexedDB write, and the card asks again | Rare and harmless (the visitor answers again). The choice should be written before the card closes. | Next |

## Left open by code review round 2 (v0.3)

The v0.3 code review (2026-10-20 to 2026-10-21) fixed its 84 findings; the area fixers and the integrator left these, each with its reason in
section 8 of [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md). Nothing here is built in 0.3.0.

| Item | Why it waits | Tier |
|---|---|---|
| A member's page signs and sends pin requests (`mw.files.pinRequest`, `mw.media.pinRequest` with `makePinRequest`), and the pin page runs a holder-only chat lane for the pin mailbox (`__mwPinCall('mailbox.*')`) | The node's queue, its signature check and its mailbox store are built; no page sends to them yet, so the documents mark the mailbox, join requests and members' pin requests (proposed). The chat side needs `src/chat/lane.js` to await asynchronous holder operations | Next |
| A per-author byte quota inside the reserved pool (MF-54) | It is a new admission rule every copy must apply the same way, with a chosen share (the review round tried max(64 KiB, pool / 16) and removed it, because it refused honest single-author histories; SCALE-4, SYB-19 in docs/deviations/review-round-chain.md); until then one unvetted key can fill the shared pool within the entry rate (OPERATIONS, "The file lanes") | Next |
| A signed `minSeq` in the ledger policy and its check on load (MF-30, PTR A4, HUB H4) | A new policy field; the withdrawal expiry and two-source disagreement cover the cold-device replay meanwhile | Next |
| A real owner hand-over for a personal page (the identity origin signs key i to i+1, and a pointer with `owner` = key i+1 through `nx=`) | It needs an owner hand-over rule in `src/chain/state.js` and an identity-origin signing round; until then "Replace my keys" keeps the key of a label that owns a page | Next |
| A signed peer-hint record for the rendezvous (MF-77, SYB A10) | Persisted good peers and `ut_pex` bootstrap cannot be built in a browser as stated: a WebRTC wire has no address to dial again and a new peer id each session. SYB A10 is open until a design exists | Later |
| An identity-origin vault API for file keys (R 2.9.4, MF-72) | Own private files and accepted grants are kept in a device vault since round 2 (memory only on a shared computer); they do not follow the person to another device yet | Next |
| `mw.identity.setName('')` clears the display name, or "Leave this site" (R 2.15) with its card | The SDK takes 1 to 48 characters, so the social template's "Delete my page" says the name stays; `PRIVACY.md` marks "Leave this site" (proposed) | Next |
| `mw.hub.withdrawPage()` (the `st=withdrawn` pointer signed by the person's key, social GAP 2) and `mw.report.send({ ..., ledger })` to a followed ledger's moderators | The social template calls them where they exist and says what it cannot do otherwise | Next |
| `mw.db.exportBlocks()` (or `db.snapshot({ blocks: true })`) so "Download my data" holds the signed entries | The template points to the loader's own "Export ledger JSON" meanwhile | Next |
| An identity-page Settings switch that turns one identity on for a hub after a "no" | Only "off" exists there; the hub box of the sign-in card always starts unchecked and the page can no longer preselect it | Next |
| Refuse `chat.enable` when the site names no STUN list | Defense in depth only: `publish` already requires `--stun` with `--chat`, and without a list the lanes gather host candidates only, so no shared STUN server learns anything | Next |
| Directory signing for operators (the `mw-dir-v1` and `mw-dir-hub-v1` signatures the template checks) | Nothing produces `sig` or `hubSig` yet; the directory stays off until a lawyer has looked at it (N-7; none is engaged for 0.3.0) | Later |
| A read-only root filesystem for the pin container, or a seccomp profile shipped with it so Chromium's own sandbox runs inside | Untested here; the image documents `MW_CHROMIUM_NO_SANDBOX=1`, and the one-box pin service drops every capability and privilege gain | Next |
| Turn on the phone notes of calls (`setCallFlag('phoneNotes', true)`) and the delivery states (`STRING_FLAGS.deliveryStates`) | They wait for their gate rows (G-PS-1 to G-PS-4 and G-CL-2; G-CH-1 and G-CH-3) | 1.0 |
| Copy sign-off of the new strings, English and French (R 2.14.1): `publicUpload`, `uploadAsIs`, `hubIdentity`, `recoveryKitIos`, `replaceKeys`, `call.keepOpen`, the identity page's `kitIos`, `hubIdentityText`, `replaceKeysText`, `passphraseNoEscrow`, `passphraseWeak`, `removePrivateDataText` | Owner, with a native French reader for the French; no lawyer is engaged for 0.3.0 | 1.0 |
| End-to-end variants the fixers asked for: a blocked popup (Chromium without `--disable-popup-blocking`, the challenge delayed 6 s); E-ID-11 with `opener` null reaching `/_mw/idp-return` (the `window.open` null case runs since 2026-10-22, docs/deviations/rows-identity.md); E-MD-4 with a throttled uploader seeking to 90 percent; E-CH-1 recording the `RTCPeerConnection` configs (no default STUN once chat is on); E-SO-1 replacing keys and then posting; E-FI-1's `_deny/` half through the moderation queue; upload, reload, sign in, `media.list` mine; E-CH-2 with the pin fixture once the mailbox exists | Each behaviour has unit tests; DOOR-GUEST now checks that a guest door gets no byte request, E-CH-1 that the kit card comes once, and E-FI-1 that premoderation holds until the owner accepts | Next |
| The device rows the media review named: G-MD-2 and G-MD-3 on an iPhone, G-MD-6 (CryptoKey into the worker), an EXIF orientation 6 picture coming out upright and EXIF-free in Chromium and WebKit, `media-browser` with the worker turned off | Real devices ([DEMO-RESULTS.md](DEMO-RESULTS.md)) | 1.0 |
| Check the passphrase floor with people (G-ID-9): a four-word passphrase of 27 characters now scores 59 bits and is refused | The strength estimate became stricter in the review (sequences, keyboard rows, list order); the e2e passphrases were lengthened | Next |

## Left open by the review round (R 5.3, 2026-10-24)

The review round of the v0.3 design review ran from 2026-10-22 to 2026-10-24 and its fixers closed most findings
([CHANGELOG.md](../CHANGELOG.md), "Changed in the review round"; [review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md),
section 5.4). These items it left are design or owner work, each with its reason in the fixer's note in
`docs/deviations/review-round-*.md` or the rows lane's note. A part a fixer could not reach in its own files went to the
integrator as a request and is not listed here.

| Item | Why it waits | Tier |
|---|---|---|
| Verify the 14 serious findings that the refuters did not reach before the session limit | Each was reported by one reviewer and handled by its fixer, but no two refuters confirmed or refuted it | Next |
| Keep the device key that signs the saved pointer record out of reach of same-origin code in shell mode (PTR-11) | The key lives in the origin's IndexedDB, so signed pins and refusals catch accidental edits only; moving it is an architecture change | 1.0 |
| Split a hub page's owner key from the member key, with an owner hand-over (HUB-3, PHISH-1) | Today a page of a hub that you sign in to can post as you on every page of that hub, and the identity card says so | Next |
| A wire frame that carries an owner checkpoint and its state, or a prune delay after a checkpoint (DS-2) | Copies prune covered blocks at once, and `mw_chain1` has no frame for the state; either fix is a wire or storage change | Next |
| A month seeding cap per hub, not only per site (SCALE-12) | It needs a meter shared across origins (the identity origin or the hub apex); the cards now say "on this site" | Later |
| A bound for the first direct message after a join, before the relay holds the recipient's WANT-TAGS route | E-CH-10 measured 1.41 s to 2.90 s once the route exists (bound 5 s); before that a message reaches a random half of the relay's neighbours and otherwise waits for the 30 s acknowledgement timeout or the 60 s outbox retry (docs/deviations/rows-chat.md) | Next |
| Where a hub publishes each followed ledger's recent window, and who writes it (E-SO-6, contract clause C-1) | The building blocks are built and tested; the URL scheme and the writer are not specified (docs/deviations/rows-social.md) | Next |
| The contract of `mw.mod.requestJoin(group)`: return value, errors, the "declined" message and the stranger rule (E-SO-7, C-2) | The social example joins over direct-message grants meanwhile | Next |
| One short id format for a person on the identity card and on sites (rows-social D-3) | The identity card shows 8 base32 characters with a dash, while SDK.md and the social example show 8 hex characters; owner or integrator decision | Next |
| A full, dated Public Suffix List at the identity origin (PHISH-13) | It needs a vendored file and a build step; `src/idp/psl.js` is a curated snapshot | Later |
| The plain JavaScript Argon2id (64 MiB) wherever WebAssembly is missing (SEC-8) | It needs a measured time budget on slow devices | 1.0 |
| Leave the listed SHA-256 of a public file out by default (STALK-13) | Moderators deny by digest; a pin node or a web-seed host would have to compute digests for them first | Later |
| Use the pin node's own file store, with the torrent checked against the approved size (MAL53-8) | Pinned bytes live in the pin page's IndexedDB; the change is not small | Later |
| Create the torrent in a child process that never sees the owner key (SUP-13) | `publish()` runs in-process for the tests, `ship` and the e2e harness | Later |

## Next (0.4)

The rows marked "Next" in the tables above come first, because they are known gaps: the behavioural tests, the
missing end-to-end checks, the consent write and what code review round 2 and the review round left open. The items below join them.

| Item | Why now | Evidence |
|---|---|---|
| Freeze-group leftovers: a restricted character set for block keys (`k`) and list names (`l`), erasure semantics (hidden equals absent; what a tombstoned `put` shows), storage integrity rules (one IndexedDB transaction per batch, verify on load, crash-injection tests) | Each one changes what a valid block is or how a ledger is stored, so it is cheap before public ledgers exist and a format version afterwards. Today `k` and `l` take any non-empty string up to 256 and 64 bytes, and they stay readable after a tombstone because they sit inside the signed block header. | ID P0-2, P0-4, P0-8 |
| Test harness: network impairment armed before navigation, the split of E2E case 5 into HTTP offline, peer loss and tracker down, a web-seed fault server and a hostile-wire harness | A peer-loss test must test peer loss. A few scenarios inject one fault each (PEER-WS, PEER-11, PEER-BLIP, PUBLISH-WS); most other faults are tested at unit level. | ID P0-14, P0-15 |
| Upload byte budgets per visit and per day, shown in Settings | Uploads are rate limited (1 MiB per second on desktop, 128 KiB per second after a mobile opt-in, `src/loader/config.js`) and can be switched off. Since phase C2 there is a monthly cap on what a browser keeps or re-shares (20,000,000,000 bytes on a desktop, at most 1 GiB on a phone; `src/loader/config.js`, `seed.rows`); a per-visit and a per-day budget are not built. | ID P0-26 |
| Web-seed list policy: three or four `ws=` URLs with at least one independent provider, and a lower connection cap per URL on phones | The circuit breaker stops a bad web seed, but nothing sets a policy for several (how many, from whom), and each URL gets WebTorrent's default of 4 connections on every device. | ID P0-13 |
| Rewrite or delete the skipped v0.1 test `test/unit/sw-browser.test.mjs` | It is the one skipped browser test, and it targets the v0.1 worker. The v0.2 worker is covered by `sw-core.test.mjs` and the end-to-end scenarios. | [INTEGRATION-STATUS.md](INTEGRATION-STATUS.md), next steps |
| A moderator-key import in the drop-in panel | The shell's Settings can import a moderator key and the drop-in panel cannot, so a moderator key can't be imported on a drop-in page. | [DEVIATIONS.md](DEVIATIONS.md), status table |
| Paging for `mw.db.list` (a cursor and an order option) | `list` takes `limit` and `newestFirst` and has no cursor, so a page can't continue where the last one ended. A small SDK addition now avoids a breaking one later. | ID P1-37 |
| A swarm calculator tool for owners | Owners should get a number before they rely on peers. The modelled result is that a small site gets little of its first load from peers. | ID P1-33, ID section 9 |
| An SDK read that returns a key's current entry with its author and `h` | 0.3.0 has the unban of the v0.3 freeze group (`mw.mod.unban`, `ledger-admin unban`, `ban --until`; [OPERATIONS.md](OPERATIONS.md#moderation-caps-undo-and-bulk-actions)), but `mw.db.get` still returns only the value, not its author or `h`. | [deviations/onboarding-crud.md](deviations/onboarding-crud.md) |
| An owner setting that forces host-only for a children's site | `aud=kids` makes the blocking gate the default, but the visitor can still choose to load peer-to-peer; nothing lets the owner rule out peers. | [deviations/deploy-ops-security.md](deviations/deploy-ops-security.md) |
| `publish --hub subdomain` writes the `<meta name="mw-hub" content="subdomain">` a production subdomain hub needs | Today only `tools/dev-server.mjs --hub` writes it, and DEPLOY tells the owner to add it by hand. | [DEPLOY.md](DEPLOY.md) |
| "Forget this site" with an option to delete the identity, the ledger copy, the remembered key and the consent choice too | It deletes the stored site versions only (PRIVACY.md says so), which is less than a visitor may expect from the label. | [PRIVACY.md](PRIVACY.md) |
| `check-webseed` run by hand reads a same-origin web seed as cross-origin unless `--origin` is given | `check-site` and `publish --verify-ws` pass the origin; a hand run can report preflight failures that visitors never meet. A hint when the seed's host looks like the site's would help. | [deviations/deploy-ops-security.md](deviations/deploy-ops-security.md) |
| `progress.uploadSpeed` from the same piece counter as `uploaded` | Since the post-wave fix `uploaded` counts only file data sent to other visitors; `uploadSpeed` is still WebTorrent's rate over every byte the page's wires write. | [deviations/post-wave-fix.md](deviations/post-wave-fix.md) |
| Dependabot coverage of `deploy/tracker/docker-compose.yml` | `.github/dependabot.yml` covers npm, the action pins and `deploy/pin/Dockerfile`; the compose file's `caddy:2.11` and its inline tracker image are updated by hand. | [deviations/restructure.md](deviations/restructure.md) |
| A first pass of the release gate on one iPhone, one Android phone on mobile data and desktop Firefox, including the time to mine a post at 16 bits on a real phone (rows G2, G4, G6 and G20 of DEMO-RESULTS) | Open-writing sites ship with 16 bits as the default and the cost has only been estimated. Early device results find bugs before 1.0. | DEMO-RESULTS, ID section 7.2 |

## The v0.3 program: what is deferred and what is rejected

> **Status: v0.3, built and reviewed.** The v0.3 design review ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md),
> cited "R") keeps one build and records what it leaves out. Part of the program is in the tiers above and below (the
> freeze group, the identity origin and the sign-in format replace several rows that wait for it); this section lists
> every item the review deferred or rejected, with its reason, so that nobody has to rediscover why. An item that the
> review accepted for v0.3 is in [CHANGELOG.md](../CHANGELOG.md) and the specification, not here.

R 1.4 lists these, one line each. Sources are the review's finding ids (PRIV, DS, PHISH, STALK, HUB, SCALE, SC and SYB are
the judge and attacker files under `docs/research/v03/`; RT and ID are the two design proposals).

| Item | Status | Reason |
|---|---|---|
| Replace the public allow list with membership credentials or salted commitments (PRIV M5) | deferred to block v2 | It replaces a validity rule that every peer runs with a new trust object. Pruning behind a `checkpoint` and ban expiry cover the history part now, and [PRIVACY.md](PRIVACY.md) states that the current list stays public |
| Relay presence frames two hops (DS F3, part b) | deferred | The battery cost on phones is unmeasured (row G-CH-7). v0.3 relabels the list "Connected to you now" instead |
| A ledger-side op that delegates to a device (PHISH A3 and A6) | rejected for v0.3 | Per-site working keys from the identity origin carry the same per-site exposure without a new ledger object. A `rotate` from the identity origin is the recovery path |
| A QR login that relays another device's browser (PHISH A6) | rejected | No web API proves proximity, so the feature is not offered at all |
| Send each chat message through one random relay (STALK A3, part 3) | deferred | One more party would see size and timing. Jitter and random relay subsets ship first |
| MLS or sender keys for groups (RT 5.4) | deferred (P3, P2) | MLS for the browser has no audit and needs commit ordering (RFC 9420). The `epochId` chain covers groups of up to 32 members (chosen) |
| Message holders on phones (RT 5.7) | rejected | Battery, data and iOS background behaviour (RT 9.3). Phone-class devices relay and hold nothing by default |
| An owner WebSocket mailbox for Tor Browser (RT option D) | deferred (P3) | It is a backend. It may be added later and labelled as one |
| Move WebTorrent into a worker that sees only ciphertext (SC-2, part f) | deferred | WebRTC in workers on Safari is unmeasured. The identity origin already keeps roots out of the WebTorrent realm |
| A 32-byte root and 24 words by default (STALK A5, part 1) | deferred behind a version tag | The optional extra word gives the same protection against a leaked phrase now. A larger root changes every vector |
| Build the hub denylist and the hub directory in v0.3 (HUB H11, SCALE M7) | deferred; counsel gate | This page holds both until a lawyer has looked at them, and no lawyer is engaged for 0.3.0 (under "Later", Hubs, and under "Not planned", A directory of sites on a hub). The rules are written now, in [OPERATIONS.md](OPERATIONS.md#hubs-safeguards-and-the-rules-for-a-denylist-before-any-list-exists), so that the build cannot skip them |
| Static TURN credentials as the recommended default (RT 9.4, option a) | rejected as the default | An open relay invites abuse (SYB A17). TURN stays off. Option (a) is allowed with quotas and a warning, and option (b), a credential endpoint, is labelled a backend ([DEPLOY.md](DEPLOY.md#turn-off-by-default)) |
| A NIP-07 or NIP-46 signer adapter (ID 3.6) | deferred (P3) | It needs an algorithm-tag decision outside the review |
| Send phone uploads to a hub web seed by default (SCALE M1) | accepted only where the hub offers one, never implied elsewhere | A web seed needs a host. Each item shows who keeps it ("Kept by the hub" or "Available only while someone who has it is online") |

### The hub directory (decision N-7): pending counsel

The review's owner decision N-7 reads: directory code ships off by default, behind a hub flag marked "pending counsel";
the alternative, shipping it on, contradicts this page (R 1.5). The design (R 3.4) is signed name records countersigned
by the hub, an append-only log and static shards that make every change visible, the ledger id pinned when someone
follows, a member's own domain (`_magnet.<domain>` TXT) as the strong path, and links and QR codes that work without
any directory. None of it is on by default, and nothing turns it on before a lawyer has looked at it; the owner has not
engaged one for 0.3.0, so the directory and the denylist stay off. The same holds for a hub-wide denylist, whose rules
are already written ([OPERATIONS.md](OPERATIONS.md)). The code may be built, because a flag marked "pending counsel" is
not a promise to run it, or a promise that a lawyer will be asked.

## Phase C2 of v0.3: seeding, zero-setup hosting, adoption and calls

> **Status: v0.3 C2, built and reviewed.** Built by eight lanes and integrated on 2026-10-20 (doors too; deviations/integration-c2.md);
> the real-device gate rows have not run. The items of the phase C2 specification
> ([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), "SZ"; ARCHITECTURE 8.1 and 15.14; INTERFACES, C2). Effort: S under a
> week, M one to four weeks, L more. Browser only (owner decision, 2026-10-20): nothing here asks a member to install anything. No tokens, points,
> rankings or public per-member counts (ARCHITECTURE 8).

What phase C2 builds (SZ 3.3, "C2" rows):

| Item | Effort | Basis |
|---|---|---|
| Evidence labels, hand-off states, the carry meter, and the qualified line "Readers who agree help carry this site while their page is open" (never "every reader is a mirror") | M | S1 D6; S3 2.2 |
| Smart seeding: three lanes, budgets by device, network proof, power, session and month, windows, local wires outside the data cap | M to L | ARCHITECTURE 8.1; S1 D1 to D3 |
| Dock mode and the keeper tab | S | S1 D3 |
| The pin node's receipts (`mw_pin1`), signed heartbeat, owner auto-accept and month cap: measured counts of keys, not people | M | S1 D4; S3 2.4 |
| `ship`, the one-box server and the LAN tracker proxy | M | S2 |
| Calls: a reason to be online together | L | SZ 3.5; ARCHITECTURE 15.14 |

Owner decisions SZ-1, SZ-2 and SZ-4 to SZ-6 are not signed (SZ-3, the 399-day record, was accepted on 2026-10-25); the build ships each one behind a flag or default that keeps today's behaviour
([ARCHITECTURE.md](ARCHITECTURE.md), 15.11). The real-device rows G-PS, G-ZS and G-CL ([DEMO-RESULTS.md](DEMO-RESULTS.md)) decide the numbers marked
"chosen", and G-PS-1 to G-PS-4 and G-CL-2 run before any card describes phones in the background.

Recommendations of SZ section 4. Its P0 items are the owner's signing of SZ-1 to SZ-6, the first device rows named above and the C2 lanes
themselves; the rest wait for those rows:

| Priority | Item | Effort |
|---|---|---|
| P1 | Super-seeding by default, after G-PS-8; spot-checks of claimed holders (E2); a spoken safety code for calls; desktop Picture-in-Picture calls; a LAN QR code and trust page; `publish --move` (an RFC first); the nip.io cookie probe (S2 Q3) | S to M each |
| P2 | Partial seeding for large media, after G-PS-10; a Node-only pin; a hub copy at R2; hand-off between a person's own devices; a bare-IP certificate rung; calls in the drop-in widget | M each |
| P3 | Web Push rings from a hub pin; uses of Background Fetch and Periodic Sync; a mixing server with end-to-end frame encryption; a WordPress plug-in, site packs, an open hub (after a lawyer has looked at it; none is engaged for 0.3.0); a Public Suffix List entry for a project domain | M to L |

### The v0.4 adoption list

What SZ 3.3 puts after C2. Each item changes how people find or keep a site, not the rules above.

| Item | Effort | Basis |
|---|---|---|
| `<mw-comments>` and `add comments` (works with no peers online) | S to M | S3 2.5 |
| `try`, the classroom kit (QR code, trust page, CA fingerprint) and `share --hub` | M to L | S3 2.5; R7 5.3 |
| Owner `status` and the signed status badge; a probed count of the pins an owner lists | M | S3 2.2, 2.4 |
| The showcase hub H1a, lifeboat pages, Hugo and Astro plug-ins, host adapters | S each; M per adapter | S3 2.6 to 2.9; S2 Rc8 |
| `web+felinar:` links (desktop only), a Light Drop file, a crawler shell | S; M; M | S3 2.3; R5 F12 |

## Where help is most useful

These are well defined and change no format and no specification text. Open an issue first
([CONTRIBUTING.md](../CONTRIBUTING.md)).

| Task | Where to start |
|---|---|
| Run a row of the release gate on a real device and record the result | [DEMO-RESULTS.md](DEMO-RESULTS.md) |
| Behavioural tests for the guarded buttons that are still checked as source text (F53) | [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md), section 7 |
| The swarm calculator for owners (`tools/swarm-calc.mjs`) | ID P1-33 (effort S) and the model in [research/labs/w2c-07-lab/](research/labs/w2c-07-lab/) |
| Paged `mw.db.list` | ID P1-37 (effort S) |
| A recipe for a framework or host that has none | [CONTRIBUTING.md](../CONTRIBUTING.md), "Adding a recipe" |
| One of the five research topics never researched | [research/README.md](research/README.md), "Gaps" |

## 1.0: the production-ready bar

The gate comes first. Every row of [DEMO-RESULTS.md](DEMO-RESULTS.md) (G1 to G22) has to pass on real devices and be
recorded with the date, the versions and the measured numbers, and each failure has to link to an issue. The gate covers
a real domain with a `_magnet` record, iOS 18 and an older iOS, Android Chrome on mobile data, Samsung Internet,
Firefox in normal and private windows, Brave with aggressive Shields, Edge with sleeping tabs, cold start, an
update, a key-change prompt, the kill switch, the drop-in fixture and 7-day persistence on iOS (DR item 25).

| Item | Why | Evidence |
|---|---|---|
| Recoverable guest identity: a seed-derived key created at the first write, a recovery phrase with backup and restore, honest durability prompts, name hygiene, local mute and block, no persistent identity on a shared-origin hub | Browser storage isn't durable: Safari may clear it after 7 days without a visit. The research ranks this before any public release, and 0.3.0 carries it in the v0.3 form: the identity origin (one root, per-site keys, a recovery phrase and a backup file) replaces this design. The row stays until the identity origin's real-device rows (G-ID in [DEMO-RESULTS.md](DEMO-RESULTS.md)) pass. | ID P0-18 to P0-23, ID section 10.1, DA G |
| An own WebTorrent bundle | It replaces the build-time string patches (five patch points today, pinned in `build.lock.json`) with a build the project owns, and it unblocks F39. Each WebTorrent upgrade has to re-check every patch point now. | RD P1-1, DA G |
| The site ledger as a production database: owner checkpoint blocks with self-verifying snapshots, the `vanish` operation, an import tool for existing data, deterministic per-author quotas for open writing, reports and an owner queue, a decision on multiple devices | These are what a production data layer needs beyond append and delete. The names `checkpoint`, `vanish` and `grp` are already reserved; the v0.3 freeze group defines `checkpoint` and the reserved byte pools, and leaves `vanish` and `grp` reserved. | ID P1-5 to P1-9, P1-11, P1-12; DA G |
| Pointer additions: first-serve verification of `files.json` (`fj=`), pre-rotation (`nk=`; the v0.3 pointer adopts it as `nx=`), a signed per-file manifest (`mf=`), and hardware-backed owner signing (a security key through `ssh-keygen -Y sign`) | A pointer keeps and signs keys it doesn't know, so `fj=`, `nk=` and `mf=` can be added without a format version. They protect files at rest and on update. Hardware signing adds a signature algorithm that readers have to learn, and it keeps the owner key off the build machine. | RD P1-5, ID P1-1; PD P1-14, P1-15 |
| An availability plan owners can follow: finish `tools/pin.mjs` with a one-command recipe and a signed pinner heartbeat, run an own tracker with monitoring, keep always-on seeders at two providers | "Stays up when nobody is online" holds only with `ws=` and `xs=` in the pointer, and the ledger needs a snapshot or a pinned node. | ID P1-36; PD P1-2, P1-4, P1-5 |
| MW-PTR/1 and MW-LOG/1 as standalone specifications with vectors, and the `xs` and `ws` contract written down | Nobody else will specify them, and a second implementation needs a stable text. | ID P1-20, P1-21 |
| Test evidence: a chaos catalogue, a NAT and relay matrix, fuzz targets for every parser of untrusted input, a real-device program, accessibility, performance budgets, soak runs, a migration corpus, upgrade and version-skew tests, model-based tests of ledger order, a cross-engine pipeline in a pinned image | The design review makes passing gates the definition of production-ready, and Playwright results can't stand in for cross-engine peer-to-peer behaviour. | ID P1-22 to P1-30, P0-16, P0-17 |
| Size budgets, and a smaller drop-in runtime: `/_mw/mw.js` is 859 KB (276 KB with `gzip -9`) in the 0.3.0 build (measured 2026-10-21), up from 323 KB (105 KB gzip) in the 0.2.1 build and 265 KB in the v0.2 note, and the first page view of a drop-in site downloads it. Split it, and fail CI when a bundle outgrows its budget | Size is paid by every visitor and nothing in CI watches it. For comparison, the 0.3.0 `loader.js` is 1,131 KB (364 KB with `gzip -9`) and the vendored `webtorrent.min.js` 222 KB (64 KB); the 0.2.1 build's `loader.js` was 357 KB (117 KB gzip), measured with `gzip -c` after the post-wave fix (2026-10-20). The v0.3 services are inlined, with no code splitting. The digests propose one gzip budget for the initial JavaScript. | [DEVIATIONS.md](DEVIATIONS.md), status table; ID P1-27, section 2.2 row 17 |
| Migration acceptance: a corpus of generated sites and CMS exports run in shell and drop-in mode in Chromium and WebKit, one `publish --check` report (generator lint, SEO lint, size budgets), and an immutable-seed naming audit | The migration digest ranks these P0 for any claim that felinar "migrates existing sites". Today the path, budget and secrets gates are unit-tested, but the only existing-site fixture that runs end to end is the hand-made `examples/existing-site-dropin/`. | MD M01, M13, M17; ID P1-29 |
| Migration tooling for existing sites: budgeted peer-first copy completion for drop-in, file-granular delta updates, a feature audit, support for sites served under a sub-path, a `_redirects` and `_headers` compiler | A drop-in copy can multiply the host's egress (13.3 times in a model: a 20 MB copy completed after a 1.5 MB page view, arithmetic rather than a measurement, MD M10); a credible migration story needs the rest. MD section 3 lists 27 P1 rows in all; the others (search, forms adapters, web components, a WordPress adapter, DNS publisher modules) follow what compatibility reports ask for. | MD M19, M20, M27, M28, M43 |
| Operations without analytics: scheduled probes and a canary, a visitor-run `health.html`, local-first diagnostics | With no analytics, an owner learns that a site is unreachable from a probe or not at all. | PD P0-10, P1-4, P1-7, P1-8, P1-11 |
| Release provenance beyond 0.3.0's: npm provenance for `felinar` and `@felinar/verify` from a publishing workflow, supply-chain tripwires, a release manifest bound to the pointer | The loader is the trust root, and owners copy `dist/` onto their own hosts. A 0.3.0 release carries the built loader, the identity page, the npm package, `SHA256SUMS`, a build provenance attestation and two per-file hash lists that the owner signs offline (`tools/verify-release.mjs`, ECDSA P-256), made by a workflow whose actions are pinned to commit hashes. Both npm packages are published by hand (or not at all), so they carry no provenance; no workflow publishes to npm. | PD P1-16, P1-17, P1-19; R 2.19 |
| Measured economics: bytes by source (web seed, peers, host) in the network status, owner opt-in aggregates, measured consent and connect rates in DEMO-RESULTS | Every offload figure in the documents is modelled until then. | ID P1-34, MD M57 |
| A legal and privacy package, reviewed by a lawyer if the owner engages one (none is engaged for 0.3.0): controller roles, a DPIA template, an erasure runbook, a notice-and-notice forwarder for Canada, a playbook for the worst content | Open-writing sites redistribute strangers' posts. The documents here are not legal advice. | ID P1-10, PD P1-21 |
| A hub operating layer, only if a public hub is offered: labels enforced at the edge, share links that survive a cache loss, a takedown path that reaches installed visitors, a domain plan and an abuse program | A hub without these is a phishing host. A hub that shares one browser origin never claims to keep sites apart; hub mode stays for one publisher and demos until then. | ID P0-28 to P0-31, P1-15 to P1-19; RD P0-13 |

## Later (1.x and 2)

| Theme | Items | Evidence |
|---|---|---|
| Identity v2 | Passkey-protected seeds (PRF), verified names over DNS-over-HTTPS, subscribable owner and moderator lists, device sub-keys | ID P2-12 to P2-15, DA G |
| Ledger growth | Grants with caveats, a sealed owner inbox, member groups with epoch keys, pruning behind a checkpoint fence, retention epochs, a split query layer, range-based set reconciliation (negentropy) for returning visitors, Ed25519 identities only if P-256 persistence fails on real devices | ID P2-6 to P2-11; PD P2-9; DR section 3 |
| Content and standards | Pointer hint keys, an Arweave anchor, a single-file bundle mode, an always-on native seeder, nsite export, an IANA entry for `_magnet`, `mw_v` in the extended handshake, pkarr, wire-format DNS-over-HTTPS, BitTorrent v2 and hybrid torrents | ID P2-1 to P2-5, P2-25 to P2-30; DR section 3 |
| Mirrors and relays | Nostr and Blossom mirroring published by pinners only, TURN with short-lived credentials (measure the stranded share first; v0.3 lets an owner run a relay (`publish --turn`), off by default), a second discovery plane over Nostr or MQTT, peer-assisted signaling | DA G; PD section 10, P1-23; RD P2-1, P2-3, P3-10 |
| Hubs | A signed double-hashed denylist (its rules are written in [OPERATIONS.md](OPERATIONS.md#hubs-safeguards-and-the-rules-for-a-denylist-before-any-list-exists) before any list exists), a gate-only apex, a Public Suffix List entry, a 451 and `Clear-Site-Data` takedown, no directory, bring-your-own-domain hosting, a bare-magnet hub design that would separate sites with an opaque-origin renderer and an in-memory identity (not built; today's shared-origin hub gives no separation) | DA G; ID P2-16 to P2-19; DR section 3 |
| Sites | Drop-in on multi-page sites with opt-in soft navigation or "upgrade to shell", capability write mode, local "hide and purge", cross-origin isolation for hosted sites, streaming media before the download completes, partial copies that seed only viewed files, the `magnet:` protocol handler for installed desktop Chromium apps | DR section 3; MD M62 |
| Testing extras | Visual regression, scale generators and mining calibration per engine and phone class, a synthetic swarm over `node-datachannel`, clock seams, flake hygiene | ID P2-20 to P2-24 |
| Economics | Network-type detection limits per engine, a desktop hidden-tab bound and battery rule, a Chrome Local Network Access check, a peer-first trial for sites of 50 MiB or more | ID P2-31 to P2-34 |
| Performance | Measurements from the never-run topic 07, a latency model that replaces the placeholder | DA G; PD section 11 |

## Not planned

| Item | Why not | Source |
|---|---|---|
| Anonymity or a private mode | Peers, trackers and STUN servers see each visitor's IP address, and no design in the research removes that. A non-goal of v1. v0.3 adds the anonymity statement ([WHY.md](WHY.md#v03-sign-in-for-any-site-and-the-honest-ceiling)) and no anonymity. | ARCHITECTURE section 2; [SECURITY-MODEL.md](SECURITY-MODEL.md) |
| Mining, consensus, finality or tokens | The site ledger is a signed, hash-linked log that every visitor copies and verifies. The small proof-of-work on each post is a spam fee, not security. | ARCHITECTURE section 2; DR section 4.1 |
| An incentive layer for seeding (points, credits, rankings) | Visitors seed because of a default, a cause or enforcement, and a generic site has none of the three at full strength. | ID verdict 4 |
| Dynamic server logic, sites above the size caps, TURN relays for a site's files and ledger in v1 | Stated non-goals of v1. A call can use a relay that the owner sets up (v0.3 C2, off by default); TURN for the site's swarms is under "Later" and starts with a measurement. | ARCHITECTURE section 2 |
| Browser-side DNSSEC validation, ENS or a layer-2 chain as a root of trust | No maintained library exists for the first, and the second needs RPC servers. | RD P3-11 |
| A directory of sites on a hub | Only after a lawyer has looked at it, and no lawyer is engaged for 0.3.0. The v0.3 social example ships it off behind a flag marked "pending counsel" (decision N-7, above). | ID section 3.6 (hub) |
| Helia (IPFS in the browser) and hybrid BitTorrent v2 torrents from `publish`, for now | Revisit if Helia gets named maintainers, a router operator and a lazy bundle under about 300 KB, or if WebTorrent ships BEP 52. | ID section 3.6 (content), section 7.3 |

### Not planned (owner decision 2026-10-20: browser only)

The owner decided that phase C2 asks a member to install nothing: no native app, no desktop keeper, no extension. An installed web app counts
as the browser, and the owner's or a hub's pin node is infrastructure beside the static host and the tracker. These items are recorded so that
nobody rediscovers them ([SZ](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), section 0 item 5).

| Item | Why not | Source |
|---|---|---|
| A keeper command line or container that a member runs | something a member installs | S3 K1 |
| A browser extension | the same | S3 K2 |
| A desktop app | the same | S3 K3 |
| Keeper pods, and an operating-system `felinar:` handler | the same (the `web+felinar:` link of the v0.4 list uses the web manifest and works on desktop only) | S3 |
| Native Android and iOS wrappers, and a push inbox for wrappers | something a member installs, and the platforms' own limits and fees apply (S1 D7) | S1 O6 to O8 |
| The audio-session trick and push-to-wake to keep a page alive | they tell the operating system something false, at the person's expense | S1 F3 |

## Research still owed

Five planned topics were never researched ([research/README.md](research/README.md), "Gaps"). Each is a good first
contribution (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

- Operational reality: PeerTube lessons, CDN and peer hybrids, consent norms, costs (w1-14).
- Multi-page site UX inside the iframe shell (w2a-08; raw runs exist, no write-up).
- Updating a torrent-addressed site: versioning, cache invalidation, delta reuse, rollback (w2a-11).
- Loader shell quality bar: performance budgets, accessibility, installability (w2a-12).
- Performance engineering for small sites, measured on real hardware (w2b-07).

## Watch list

Not work items, only things that would change a decision above: Helia's three conditions, WebTorrent issue #1117
(BEP 52), signature-based Subresource Integrity and web application integrity proposals, Isolated Web Apps, a revival
of DNSLink, and the draft BEP "Magnet-URI Webseeding" (pull request #171). Source: ID section 7.3.
