# Code review v0.3: spec conformance and honesty

Lens: SPEC CONFORMANCE AND HONESTY (`.orchestration/scripts/v03-review.js`, label `review:conformance`).
Date: 2026-10-20, 21:55 to 22:45 ET. Tree reviewed: checkpoint `99d7a7c` (auto, 22:01 ET; the working tree was clean, and
`src/`, `tools/`, `test/`, `build.mjs` and `examples/` are identical to `470f7ea`, the checkpoint the C2 integration results
describe). Code in scope: everything under `src/`, `tools/`, `bin/`, `build.mjs`, `test/e2e/`, `examples/social` and
`examples/existing-site-dropin` written since `709feff` (`git diff 709feff --stat`: 368 files, 93,447 insertions), read
against the parts of the wave 1 code it calls (`src/identity/*`, `src/chat/*`, `src/media/*`, `src/chain/state.js`).

Normative inputs, read first: [V03-DESIGN-REVIEW.md](V03-DESIGN-REVIEW.md) ("R"; Part 1 must-fix list, Part 2 resolved
design, Part 3 `examples/social`, Part 4 test plan), [SEEDING-AND-ZERO-SETUP-DESIGN.md](../research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md)
("SZ"), [ARCHITECTURE.md](../ARCHITECTURE.md) (8.1, 15), [INTERFACES.md](../INTERFACES.md) (v0.3 and v0.3 C2 parts),
[INTEGRATION-STATUS.md](../INTEGRATION-STATUS.md), [deviations/integration-v03.md](../deviations/integration-v03.md),
[deviations/integration-c2.md](../deviations/integration-c2.md), the lanes' notes they cite, and the wording rules of
[DESIGN-REVIEW.md](DESIGN-REVIEW.md) section 4. IP visibility to peers is the premise of the light web and is not
reported as a defect here. This review changed nothing in the repository except this file.

What was run (Node 24.22; every browser local-only: Chromium with `chromiumArgs()`, WebKit on `http://127.0.0.1` only):

| Run | Where | Result |
|---|---|---|
| `npm test` | the shared tree (allowed in place) | lint-floor clean; 1,967 tests, 1,967 pass, 0 fail, 0 skipped (23.5 s) |
| `node test/e2e/run.mjs` | own clone under the session scratchpad (`conformance-copy`, `node_modules` symlinked) | 71 of 71 PASS, network policy PASS ("every request stayed on 127.0.0.1"), 440.5 s |
| `node test/e2e/run.mjs --webkit` | own clone | 76 of 76 PASS (the 71, then W7, W-SI, W-MD, E-CL-1W and DOOR-GUEST-W in WebKit 27.2), network policy PASS, 478.9 s |
| `npm run test:example` | own clone | 170 tests, 170 pass (31.8 s) |
| `npm run test:browser` | own clone, after `node build.mjs` | 40 tests, 39 pass, 1 skipped (the v0.1 worker test); without a built `dist/` the seeder test skips too (38 pass, 2 skipped) |
| Probes against the real modules, no browser | a short Node script kept outside the repository that imports `cardFor` (`src/loader/api.js`), `CARD_TEXT` and `fmt` (`src/loader/strings.js`) and `labelFor` (`src/identity/derive.js`) | the "Turn on chat" card text as the chat service fills it (finding C3); the identity labels a member gets with the hub box left at its default (finding H1) |

So the INTEGRATION-STATUS counts for `npm test`, `test:browser`, `test:example` and both e2e runs are confirmed on this tree. What the suites do
not show is the subject of this review: several documented behaviours have no code path, and several user-facing
sentences promise more than the code keeps.

## 0. Progress at a glance

Code status per must-fix item: **implemented** = the item's decision is in the code (tested at least by unit tests);
**partial** = a named part of the decision is missing or wrong; **missing** = not started.

| Set | Implemented | Partial | Missing |
|---|---|---|---|
| Must-fix MF-01 to MF-78 (R 1.3) | 54 | 24 | 0 |
| C2 P0s (SZ section 4) | 1 (the lanes) | 0 | 2 (owner sign-off of SZ-1 to SZ-6; the phone gate rows before cards describe the background) |
| `examples/social` mechanisms (R 3.1 to 3.7: 49 rows) | 32 | 13 | 4 |

Findings (section 6): 4 critical, 11 high, 6 medium, 4 low. The four critical ones: "Replace my keys on all sites" moves no
site to the new key on its ledger, so a person loses their own personal page and every `allow` membership (C1); the public
upload card says location and camera details were removed for files the loader never strips (C2); chat, files and private
media use the two public default STUN servers while PRIVACY.md says they never do, and the chat consent card prints an
empty STUN recipient (C3); a door is told which site a visitor opens although PRIVACY.md, DEPLOY.md and `publish` say it is
not (C4).

## 1. Must-fix matrix (R 1.3, MF-01 to MF-78)

Evidence is the code that carries the decision (file:line where one place does), then the test that covers it. "Unit"
means a Node unit test; "e2e" a scenario of `test/e2e/run.mjs` that passed in this review's run. A gap names the finding
of section 6 when there is one.

### A. Identity and the cross-site sign-in

| MF | Status | Evidence | Gap |
|---|---|---|---|
| 01 `mw-signin-v1`, `@magnet-web/verify` | implemented | `src/identity/signin.js:214` buildChallenge; `packages/verify/verify.js` (382 lines, zero imports; its SHA-256 `677e25d1...` matches `docs/specs/mw-signin-v1.md` section 11 and the README); vectors `test/vectors/signin.json`; e2e E-SI-1 to E-SI-4, E-SI-1W | the package is not published (owner step) |
| 02 root only at the IdO | implemented | `src/identity/derive.js` is imported only by `src/idp/*` (grep); the bundle `src/idp/idp.js:708-722` carries per-label scalars only | |
| 03 phrase and file only at the IdO | implemented | `src/loader/ui.js:778-786` (0.2.1 fields only without the identity service), `src/dropin/panel.js:400`; copy `src/idp/strings.js:79-80`; e2e E-ID-10 | |
| 04 labels from the browser-reported origin | implemented | `src/identity/derive.js:267-312` labelFor, `src/idp/idp.js:128` verifyPointerFor (lineage, `org=`, seq floor) | the "not listed" warning fires on every hub label (finding M5); `listed` compares `host` with port against a hostname scope (`derive.js:300`), so a mirror on a non-default port never gets the ledger label (no finding: no deployment uses one) |
| 05 device link commit-then-reveal | implemented | `src/idp/link.js` (commit, SAS, 120 s window, `LinkOldDevice` at 206); unit idp-link | e2e E-ID-14 open |
| 06 high-risk cards only in the IdO popup | implemented | `src/idp/idp.js` recordRead, confirmSame, link; `src/widget/redress.js:43` checkElement for in-page cards | e2e E-ID-15 open |
| 07 reverse-proxy phishing | implemented | origin from `event.origin`; `src/idp/cards.js:70` approvalAllowed (first approval needs UV) | e2e E-SI-5 does not exercise the IdO (finding M2) |
| 08 one passkey per IdO | implemented | `src/idp/passkey.js` (RP ID = IdO host, random `user.id`, nickname, fixed PRF salt); provider sentence `src/idp/strings.js:53` | |
| 09 one tap | implemented | `passkey.js` prfFor (PRF at `create()`, one `get()` only if needed), self-test reuses the output (`idp.js:228-233`); "Tap to finish" `src/loader/ui.js:1251` | |
| 10 cross-device once per device | implemented | `src/idp/link.js`; escrow blobs `src/idp/store.js` acceptEscrow | `largeBlob` not used (stated) |
| 11 recovery traps | partial | iOS kit every visit (`src/idp/cards.js:81` kitDue), visit-only sentence (`cards.js:324`), check code and "Found N posts" (`idp.js:661-672`) | the recovery kit after the first meaningful action never appears outside iOS (finding H2) |
| 12 "same identity" | partial | menu only, second press, 30 days (`cards.js:23, 37-66`), nothing written to a ledger | a page can preselect the hub-wide link: `mw.auth.signIn({ hubDefault: true })` checks the "one identity on all of <hub>" box (`src/identity/service.js:423`, `cards.js:308`), against R 2.3.5 "no SDK parameter can preselect it" (finding H1) |
| 13 hub-scoped identity | partial | the hub label `h\|<suffix>` (`derive.js:278-285`), PSL check (`src/idp/psl.js`) | "default on for social hubs" is not built: the default comes from a page parameter that the social template never sends (finding H1) |

### B. Keys, sessions and recovery

| MF | Status | Evidence | Gap |
|---|---|---|---|
| 14 signed out means no usable key | implemented | `src/identity/store.js:448` destroy (memory, IndexedDB, epoch, broadcast); no proof in sessionStorage (only the redirect's one-request page key, `client.js:620`); e2e E-ID-2B | |
| 15 the non-extractable sentence | partial | the replacement sentence is in PRIVACY.md, WHY.md, SECURITY-MODEL.md and `strings.js` | SDK.md says the site's code never sees the keys (finding M3) |
| 16 bearer proofs | implemented | `src/identity/signin.js:19, 326-335` (local proofs at most 15 min, epoch); server proofs need a verifier nonce; e2e E-SI-3 | |
| 17 passphrase KDF at the IdO | implemented | `src/idp/_headers` (`'wasm-unsafe-eval'`), `idp.js:69` chooseKdf, PBKDF2 named on the card; test:browser idp-browser (E-ID-12) | Argon2id is plain JavaScript (1.3 to 2.5 s measured), so the PBKDF2 fallback is not needed for it; stated in ARCHITECTURE 15.1 |
| 18 random chat, record and own keys | implemented | `src/identity/vault.js:71` Vault.create, per-label random keys; unit identity-core-vault | |
| 19 backup file | implemented | `vault.js:367` generatePassphrase(6), `vault.js:386` strength floor; "Do not email" `src/idp/strings.js:117` | |
| 20 `keyinfo`, `rotate`, "Replace my keys" | partial | the ops in the reducer (`src/chain/state.js:854-895`, `block.js:65`); keyinfo at personal genesis (`src/loader/personal-site.js:69-76`); the IdO button (`src/idp/idp.js:817`) | no client ever writes the `rotate` op, so the button breaks every site the person owns or is listed on and no contact sees a key change (finding C1) |

### C. Ledger format and the freeze window

| MF | Status | Evidence | Gap |
|---|---|---|---|
| 21 schemas are a state rule | implemented | `src/chain/state.js:288` cfgOk and the list schemas; unit freeze-schema | |
| 22 `_mw.cfg`, owner settings, `tools/init` | implemented | `state.js:250` CFG, `tools/ledger-admin.mjs cfg`, `tools/init.mjs` | the schema has no `blockTiers`, `wall` or `introduced`, which three documents or lanes rely on (finding M1) |
| 23 chat keys off-ledger | implemented | `src/chat/ck.js`, `mw.ck` opt-in card (`chat/service.js:810-812`) | |
| 24 ledger fill | implemented | reserved pool and `E_LEDGER_FULL` at 80 percent (`src/chain/node.js:138, 595-612`), checkpoint, 32 sealed items and one synced update an hour (`src/identity/service.js:48-49, 355`) | |
| 25 permanent records | implemented | `ban.until`, checkpoint pruning (`state.js:922-1019`; unit harden-chain-prune) | |
| 26 erasure path | implemented | checkpoint, per-site record keys, the transfers section (PRIVACY.md 327-345) | the erasure claim about record keys overstates (finding M4) |
| 27 moderator keys and gestures | implemented | `src/loader/app.js:3569` storeModeratorKey (non-extractable), `src/loader/mod.js` UI methods with the card; e2e 4 | |
| 28 stolen owner key | implemented | `nx=` sticky (`src/common/pointer.js`), rot v1 removed (vector ptr-023), `src/loader/harden.js:271` rotationDecision wired at `app.js:3464` | |
| 29 insider levers | implemented | owner-protected payload, `unban`, `voided`, 24 h grace (`node.js:46, 139, 1209`), `modAllowPerDay` | |
| 30 loader state | partial | TTL and timer clamps (`src/loader/doh.js`, `harden.js`), signed pins and expiring refusals (`app.js:3500`), withdrawal expiry (`app.js:1063`), PSL probe (`app.js:3005`) | no signed `minSeq` policy field anywhere; `#host:name@<fp>` links are parsed by an unused helper (`harden.js:324`); the badge prints "(DNSSEC)" instead of "resolver says validated" (finding H8) |
| 31 withdrawal pressure, ownerless hub ledgers | implemented | `harden.js:180` isReadOnlyHubLedger used at `app.js:1041`; OPERATIONS denylist rules | |

### D. Chat transport

| MF | Status | Evidence | Gap |
|---|---|---|---|
| 32 flood relay | implemented | `src/chat/frames.js` (clear header, hop outside frameId), `stamp.js`, `lane.js` (fair queues, jitter, interest routing); unit chat-core-frames, chat-lane-routing | e2e E-CH-3, E-CH-10, E-CH-11 open |
| 33 holders and the inbox oracle | partial | `src/chat/holder.js:65` (hold flag, COLLECTED, quotas, INBOX-CHAL) | COLLECTED cannot be checked by a holder (chat O-1, open); the pin mailbox in `tools/pin.mjs` is never fed a frame (finding H5) |
| 34 presence | implemented | `src/chat/presence.js` (padded, signed or MAC'd), label `src/chat/limits.js:119` | |
| 35 "held by N" | implemented | HOLDING frame; delivery strings behind `STRING_FLAGS.deliveryStates` (`src/loader/strings.js:291, 688`) | |
| 36 replay and order | implemented | `src/chat/replay.js:33` ReplayGuard | |
| 37 groups | implemented | `src/chat/groups.js:120` GroupState (epoch chain, admin list); unit chat-lane-groups | e2e E-CH-5 open |
| 38 buckets | implemented | `src/chat/limits.js:34` | |
| 39 one wire budget per tab | implemented | `src/loader/config.js:128-134`, `src/loader/policy.js:349`, `torrent.js` allocateWireBudget | the hub lane joins as kind `'group'` (open, stated) |
| 40 wire handshake | implemented | `src/chat/noise.js:168` XXHandshake | e2e E-CH-12 open |
| 41 deniable DMs | implemented | `src/chat/seal.js:313` | |
| 42 direct-channel signalling | implemented | calls accept SIG from contacts only and filter candidates (`src/calls/ice.js:174`); e2e E-CL-3 | chat direct channels are P2 and not built (stated) |
| 43 parser surface | implemented | stated maxima in `src/chat/limits.js`; fuzzers `test/fuzz/targets/chat.mjs` | |
| 44 shared trackers and STUN | partial | private media and file swarms announce only to the site's own tracker (`src/media/lane.js:118`, `src/files/lane.js:186`); group lanes are not joined at all (groups ride the chat lane by tag, chat O-9); chat refuses without an own tracker (`chat/service.js:795`) | the site's own STUN is never used for chat, files or private media, and the chat card names no STUN server (finding C3) |
| 45 phone uploads and rebuilds | implemented | the per-upload card `phone-upload` (`src/files/lane.js:22`), retained stores (`retain: true`), "one full copy reached" from bitfields | |
| 46 offline DMs | partial | sender outbox `src/chat/outbox.js:28`, strings behind the flag | the hub pin mailbox, the hub-mode default path, is not wired (finding H5) |

### E. Files, private media and dangerous content

| MF | Status | Evidence | Gap |
|---|---|---|---|
| 47 streaming store and routes | implemented | `src/files/store-idb.js:128`, routes in `src/sw/core.js` and `src/sw/media-route.js`; e2e E-MD-2, E-MD-7, E-MD-8 | |
| 48 inert serving | implemented | `src/files/serve.js:65` headers; e2e E-FI-3 (3b, 3c) | |
| 49 no fetch without a click | implemented | `src/files/lane.js:567` offer card before any fetch, `:597` never re-seeded without "Help share" | |
| 50 pin node and web seed | partial | `tools/pin.mjs` moderator queue, `--quarantine`, disk stores; `tools/webseed-file.mjs` | no page can send a pin request (integration-c2 O-1); the docs that describe the path as working are finding H5 |
| 51 verified is not safe | partial | names (`src/files/names.js:28`), risk tiers (`src/files/preview.js:121`), pixel cap | owners cannot block a tier: `_mw.cfg.blockTiers`, which ARCHITECTURE 15.7 documents, hides the whole `_mw.cfg` (finding M1) |
| 52 takedown remembered | partial | `_deny/` checked before fetch and seed (`src/loader/api.js:1712` denyChecker; `files/lane.js:199, 564`; `media/lane.js:699`) | a moderator's "deny" on a report writes a key that never matches, and no tombstone (finding H3) |
| 53 ban evasion by new keys | partial | `allow` gating, per-author listing cap (`files/lane.js:338`) | premoderation of a new key's first files is not wired: `queueListing` (`src/loader/mod.js:226`) has no caller (finding H9) |
| 54 unsolicited shares, reports | partial | offers never auto-accept (`media/lane.js`, `files/lane.js`), metadata-only reports (`mod.js:305-339`), OPERATIONS file-lane section | no per-author byte quota (MAL A12) beyond the shared reserved pool, and no open-writing warning, both of which OPERATIONS.md says apply (finding H10) |
| 55 torrent metadata | implemented | `src/files/validate.js:92`; unit files-validate | e2e E-FI-6 open |
| 56 size fingerprints | implemented | `src/media/pad.js`, no public announce | |
| 57 EXIF and names | implemented | `src/media/strip.js:398` stripImage, MP4 and WebM box rewriting, random names (`src/files/names.js:91`) | the public upload card claims removal for types that are never stripped (finding C2) |

### F. Privacy copy, consent, law and honesty

| MF | Status | Evidence | Gap |
|---|---|---|---|
| 58 sentences replaced | partial | the R 2.14.2 table is in PRIVACY.md 213-235 and the string tables; tests ui-v03-strings, strings-c2 | SDK.md (finding M3); the hub card copy that R 2.14.1 itself gives (finding L1) |
| 59 register and texts | partial | PRIVACY.md v0.3 register (238-257), on-device table, retention, roles | the register says the default STUN servers are not used for chat and media (finding C3); "Leave this site" is listed as available (finding H6); the pin mailbox is listed as a working recipient (finding H5) |
| 60 most-private defaults | implemented | requests off, lanes separate opt-ins, "Stay signed in" off (`src/idp/cards.js`), PRIVACY.md "Defaults" | |
| 61 compatibility matrix | implemented | COMPATIBILITY.md floor rows | |
| 62 local test plan | implemented | DEMO-RESULTS rows "not yet run", PUBLISH-CHECKLIST owner steps, Firefox "not run" | |
| 63 strings for every code | partial | English and French tables (`src/loader/strings.js:300-395`), `me.get` is a UI method | seven codes borrow another code's sentence (integration-v03 open); the French C2 strings are unreviewed (owner step) |

### G. Scale and the social demo

| MF | Status | Evidence | Gap |
|---|---|---|---|
| 64 personal-site class | partial | browser genesis with `keyinfo` (`src/loader/personal-site.js:69-76, 168-189`), owner actions through the IdO card (`ownerAction`); e2e E-SO-1 | `rotate` is never written (C1); a page made with the default hub choice is owned by the template label's key (H1) |
| 65 hub follow lane | partial | `src/chain/multi.js` (`mw_chain2`, RECENT, HAVE), `recent.js`, the lane clock (`app.js` startHubLaneClock); e2e E-SO-2 | snapshot-first (E-SO-6), shards above 1 and a wire-budget kind of its own are "(proposed)" (stated) |
| 66 durability and cost | partial | labels need E3 or E4 (`src/loader/availability.js`); the cost table in DEPLOY | nothing can ask the pin to keep an item, so "Kept by the hub" is unreachable for members (O-1, finding H5) |
| 67 directory | partial | off by default behind `config.json` (`examples/social/js/directory.js`) | entries' `sig` and `hubSig` are not checked (`directory.js:6`; finding L4) |
| 68 honest ceiling | implemented | WHY.md 352-376, the About page | |
| 69 `examples/social` exists | implemented | `examples/social/**`; section 3 below lists its gaps | |
| 70 names and impersonation | implemented | short ids, "New contact" (`examples/social/js/views/messages.js:38, 63`), roles from the ledger, short-code verification | |
| 71 joining an `allow` site | partial | moderator caps (`state.js` modAllowPerDay), `mod.decide` accept writes `allow` (`mod.js:291-292`) | no join request can be sent (`mw.mod.requestJoin` missing, examples GAP 4), and no mailbox holds one (finding H5) |
| 72 private record capacity | implemented | `src/identity/sealed.js`, 1,024-byte items, index plus 31 data items | |

### H. v0.2.1 works-today blockers and majors

| MF | Status | Evidence | Gap |
|---|---|---|---|
| 73 HELLO bounds | implemented | `src/chain/gossip.js`, `wire-ext.js`; unit harden-chain-hello; e2e E-HD-1 | |
| 74 wire caps and eviction | implemented | `src/loader/torrent.js` (caps by wire, ignoreWire, anchors, idle close), `config.js:141` | |
| 75 policy before signature | implemented | `src/chain/node.js` admit order; unit harden-chain-admit | |
| 76 unsigned web seeds | implemented | `src/common/magnet.js:243` filterWebseeds | |
| 77 reaction stuffing, rendezvous poisoning | partial | author-scoped `@` keys (state rule), counts "from people you follow" | PEX bootstrap and persisted good peers (SYB A10) are not built, and no open list has them while THREAT-MODEL marks the attack mitigated by them (`torrent.js:1168` `utPex: false`; finding H11) |

### I. Supply chain

| MF | Status | Evidence | Gap |
|---|---|---|---|
| 78 releases and dependencies | partial | `build.lock.json` pins, `npm-shrinkwrap.json`, `tools/verify-release.mjs`, release and rebuild workflows (never run), `ml=` floor, self-hosted SRI widget | the kill switch's purge mode has no code ("(proposed)"); no CODEOWNERS file and no Dependabot cooldown (`.github/dependabot.yml`), which SECURITY.md lists as required; npm names not reserved (owner step). SECURITY.md says "partly built", so these are not honesty findings |

## 2. The C2 design's P0s (SZ section 4)

| P0 | Status | Evidence |
|---|---|---|
| The owner signs SZ-1 to SZ-6 before C2 starts | missing (an owner step) | ARCHITECTURE 15.11 lists all six as unsigned; the build ships each behind a default that keeps the earlier behaviour (`src/loader/config.js` `seed.phoneDefaultOn`, `handoffWhileHidden`; `tools/pin.mjs --auto-accept owner`; constants in `src/calls/limits.js`). C2 was built before the sign-off, which the P0 put first; INTEGRATION-STATUS says so |
| G-PS-1 to G-PS-4 and G-CL-2 on one iPhone and one Android **before any card describes phones in the background** | missing, and the condition is broken | no gate row has run, yet the call panel shows `call.ios` ("On iPhone, video stops when you leave this page, and an app on the Home Screen loses the microphone too.") and `call.android` ("Android may cut the connection when the screen is off.") on every call from a phone (`src/calls/service.js:202-203`, `src/loader/call-ui.js:123, 379`); both describe background behaviour taken from WebKit bug reports (SZ [WKB1], [WKB2]) and are not behind a flag such as `STRING_FLAGS` (finding M6) |
| The seven C2 lanes (seed-policy, pin-node, zero-setup, docs-strings, calls, seed-engine, wire-ui) | implemented, with stated gaps | all built, plus the doors lane; e2e E-PS-1 to E-PS-4, E-ZS-1, E-CL-1, E-CL-2, E-CL-3 (and E-CL-1W in WebKit) passed in this review's run. Stated gaps: no page-to-pin request path (O-1), "same local network" and "Hide my IP" have no switch, the keeper tab lists nothing, drop-in mode has no `net` control |

The rest of SZ section 3 was checked where it makes a promise: the budget table (`src/loader/config.js:160-188`) matches SZ
3.1.3 row by row; the evidence tiers and labels (`src/loader/availability.js`, `src/loader/strings.js:736-774`) never show a
number above their evidence and "Kept by the site" needs E3 or E4 (e2e E-PS-1, E-PS-2); the contribution lint
(`test/unit/lint-contrib.test.mjs`) holds; `ship` names every host before it contacts one (`tools/ship.mjs:431-441`) and
never copies the owner key (it sends only the publish output, `tools/ship.mjs:327-331`); the calls' SIG frames are sealed
under `K_pair` and the DTLS fingerprint is checked (e2e E-CL-1).

## 3. `examples/social` against R Part 3

"Present" means the template does what the row says against the landed SDK (most rows are checked against the mock SDK
only: R 4.2 rows E-SO-3 to E-SO-10, E-SO-12 and E-SO-13 are open, see section 5). 49 rows: 32 present, 13 partial, 4
missing.

| R | Mechanism | Status | Where, or what is missing |
|---|---|---|---|
| 3.3 | Sign up: identity and personal site | partial | `js/hub.js` createPage, `src/loader/personal-site.js`; e2e E-SO-1 passes only because the harness ticks the hub box (`test/e2e/scenarios-social.mjs:95`). With the box at its default the new page is owned by a key the member never gets on that page (finding H1) |
| 3.3 | Sign in, sign out | present | `js/app.js:149-156` |
| 3.3 | Profile: name, bio, avatar, links | present | `js/data.js:285-302`, avatar through `files.share` |
| 3.3 | Private record | present | `mw.me` (`js/views/settings.js`) |
| 3.3 | Data export | partial | `js/data.js:450-458` exports the snapshot (lists, keys, names) and local state; R asks for `exportBlocks()` (the signed blocks) and the decrypted record fields (finding L3) |
| 3.3 | Delete account | partial | `js/views/settings.js:255-281`: no withdrawal pointer (GAP 2), reactions and the name stay, no directory removal (finding H7) |
| 3.3 | Recovery and devices | present | `mw.identity.openIdentity()` (`js/views/settings.js:94`) |
| 3.4 | Links with the pointer in the fragment | present | `js/views/invite.js` |
| 3.4 | QR invite | present | `js/qr.js` |
| 3.4 | Own domain handle | partial | shown as claimed, not checked (examples D-8); R calls it the strong path |
| 3.4 | Hub directory (off, "pending counsel") | partial | off behind `config.json`; entry signatures not checked (finding L4) |
| 3.4 | Local search | present | `js/search.js` (10 MiB cap on phones) |
| 3.4 | Suggestions | present | `js/model.js`, `js/views/side.js` |
| 3.5 | Wall post | present | `js/data.js:241` |
| 3.5 | Edit with history | present | `js/model.js` edit history |
| 3.5 | Delete | present | tombstone (`js/data.js:250`) |
| 3.5 | Drafts | partial | plain `localStorage`, not sealed under `K_local` (examples D-5; the README says so) |
| 3.5 | Follow, unfollow | present | public `mw.f` and private follows in `mw.me`; the private list also sits in plain `localStorage` (README) |
| 3.5 | Followers and following lists | present | "Followers you can see" |
| 3.5 | Blocks | present | `js/chat.js:93-94`, `mw.me.set('blocks')` |
| 3.5 | Who may post on my wall | partial | kept in `mw.prof`, because `_mw.cfg.wall` hides the whole `_mw.cfg` (examples D-2; finding M1) |
| 3.5 | Who may message me | present | requests off by default |
| 3.5 | Timeline | present | `js/model.js`; e2e E-SO-2 |
| 3.5 | Comments and replies | present | `mw.c`, notices, `mw.ok` batches (`js/data.js:256, 420-440`); real-loader row E-SO-3 open |
| 3.5 | Edit or delete a comment | present | `js/data.js:262-268` |
| 3.5 | Reactions | present | `js/data.js:279-284` (own ledger `re/...`, group `@`-scoped) |
| 3.5 | Reaction counts | present | "from people you follow"; `mw.cnt` read (`js/model.js:193`) |
| 3.5 | Shares and quotes | present | `mw.q` (`js/data.js:273`) |
| 3.5 | Mentions | present | 10 per post (`js/config.js:26`) |
| 3.5 | Notifications in the page | partial | notices are direct messages (examples D-3), dropped silently when the target takes no requests; no hub mailbox holds them (finding H5) |
| 3.5 | Groups | partial | group ledgers, moderation through `mw.mod`; no join request (GAP 4) and no private group chat (examples D-7) |
| 3.5 | Join, leave | missing | `mw.mod.requestJoin` does not exist (`js/hub.js` throws `NOT_AVAILABLE`) |
| 3.5 | Realtime | partial | "Connected to you now", DMs, rooms; private group chats not built (D-7); typing indicators not built (off by default in R, so no gap in behaviour) |
| 3.5 | Media and files | partial | private photos and videos work (e2e E-MD-4); public video has no player (D-6); a picture listed on a followed ledger cannot be fetched from one's own page (examples request 4); "Kept by the hub" unreachable (finding H5) |
| 3.5 | Report, hide, block | partial | hide and block work; a report from one's own page reaches nobody and still says "Report sent." (finding H4) |
| 3.5 | Hub denylist and takedown | partial | `_deny/` on group ledgers is written by `mod.decide`, with the key mismatch of finding H3; "Removed by this hub" rests on the assumed GAP 5 |
| 3.6 | The honest ceiling on the About page | present | `index.html` About template, README "What needs an index" |
| 3.7 | Routes and deep links | present | `js/router.js`; e2e E-SO-11 (needs `--spa`) |
| 3.7 | Forms and validation | present | `js/views/composer.js`, alt text required for public pictures |
| 3.7 | Empty and 404 states | present | `js/strings.js` (the three R 3.7 sentences verbatim) |
| 3.7 | Loading and offline | present | sync line, `offlineLine` (`js/strings.js:91`), drafts kept on failure; writes are stored by the ledger node and sent when peers connect |
| 3.7 | Responsive layout | present | `css/app.css` (one column to 1,023 px, 44 px targets) |
| 3.7 | Accessibility | present in code | labels, live regions; the axe-core row (E-SO-12) is not run (owner decision) |
| 3.7 | Themes | present | `prefers-color-scheme` and a stored toggle |
| 3.7 | Settings | present | `js/views/settings.js` |
| 3.7 | JavaScript off | present | `<noscript>` notice in `index.html` |
| 3.1, 3.2.2 | Hub-scoped identity default on for this template | missing | finding H1 |
| 3.2.2 | First screen from hub `cs=` snapshots | missing | "(proposed)" in ARCHITECTURE 15.8; E-SO-6 not built |
| 3.2.4 | Hub pin and mailbox as the offline path | missing | finding H5 |

## 4. Wording rules and the claims the code does not keep

Scanned: `README.md`, `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`, every `docs/*.md`, `docs/recipes/`,
`docs/specs/`, `examples/` (pages, scripts, READMEs), `deploy/`, and the strings in `src/` and `tools/` (CLI output).

- **Banned words** (`blockchain`, `serverless`, "no servers", `unstoppable`, `censorship-resistant`, "fully decentralized"):
  none outside the places that state the rule (README "Why not a blockchain?", CONTRIBUTING's wording table,
  ARCHITECTURE's header, ONBOARDING's "Don't promise") and the tests that enforce it.
- **Dashes and quotes:** no em or en dash and no curly quote in any user-facing file. The only hits are two code
  comments of the 0.2 file `src/loader/cache.js` (484, 535), which no person reads as copy.
- **Durability words** ("forever", "every reader is a mirror", "erase", "delete everywhere"): none in any string table
  (`src/loader/strings.js`, `src/idp/strings.js`, `examples/social/js/strings.js`, the guestbook pages); removal copy reads
  "hide from copies that sync" and "remove"; presence reads "Connected to you now"; "online" appears only for whether a
  holder can be reached, as `src/loader/strings.js:730` says.
- **Claims that the code does not keep** (each is a finding in section 6):

| Where | The claim | What the code does | Finding |
|---|---|---|---|
| `src/loader/strings.js:428` (the public upload card) | "Location and camera details were removed." | true only for images and MP4, MOV and WebM; a PDF, an office document or an archive is shared as it is | C2 |
| PRIVACY.md:248, CHANGELOG.md:102-103, `src/loader/strings.js:422` | the two default STUN servers are not used for chat, groups or private media; `--stun` is required for them; the chat card names the STUN host | every wire uses the defaults; `--stun` reaches only calls; the card prints an empty name | C3 |
| PRIVACY.md:551, DEPLOY.md:1039, `tools/publish.mjs:539` | a door does not see which site | the loader asks every candidate door, the current one first, for `/_mw/t/<btih>.torrent` and adds its `/ws/` as a web seed | C4 |
| `src/idp/strings.js:180`, OPERATIONS.md:836-838, THREAT-MODEL.md:92, SECURITY.md:91 | "Replace my keys on all sites": each site moves to the next key and contacts see that it changed | no `rotate` op is ever written; the new key is a stranger on every ledger | C1 |
| DEPLOY.md:1091-1095, recipes/hub-pin.md:4, 19-20, 55-57, WHY.md:372, examples/social/README.md:97, THREAT-MODEL.md:391 | the hub pin mailbox holds messages and join requests for people who are offline; members ask for pins; items show "Kept by the hub" | the mailbox in `tools/pin.mjs` receives nothing, because no page passes it a frame, and nothing can request a pin | H5 |
| PRIVACY.md:320 | "Leave this site" tombstones every payload, empties the profile, stops seeding, revokes grants | no such action exists | H6 |
| `examples/social/js/views/settings.js:280` | "Delete my page" withdraws the page's address | `withdrawPage` does not exist; reactions and the name stay | H7 |
| `examples/social/js/views/post-card.js:72` | "Report sent." | sent to nobody from one's own page | H4 |
| THREAT-MODEL.md:157, 219, 279, 280 ("the design as built") | `minSeq`, `#host:name@<fp>` links and the "resolver says validated" wording mitigate PTR A3, A4 and HUB H4 | none of the three is in the loader; the badge says "(DNSSEC)" | H8 |
| OPERATIONS.md:763, THREAT-MODEL.md:245 | `ledger-admin` warns when a policy opens writing, and a per-author byte quota applies | neither exists | H10 |
| THREAT-MODEL.md:156, 336 | rendezvous poisoning is mitigated by PEX bootstrap and persisted good peers | `utPex: false`; no peer list is persisted | H11 |
| ARCHITECTURE.md:1483-1484 | owners block a sniffed tier with `_mw.cfg.blockTiers` | the reader's schema hides any `_mw.cfg` with that key, chat, files and media included | M1 |
| docs/SDK.md:352-356 | "the site's code never sees them, only the public key" | same-origin site code can use and copy the working keys (R 2.1 rule 2, MF-15) | M3 |
| PRIVACY.md:324, `src/idp/strings.js:136` | a removed record key cannot be recovered by the person or by anyone | escrow vault blobs on other sites and older backup files still hold it (idp lane item 18) | M4 |
| `src/idp/strings.js:75` (from R 2.14.1) | "Other sites still cannot match you." | other sites can match by IP address, timing or name (R 2.14.2) | L1 |

## 5. INTEGRATION-STATUS claims, checked

| Claim | Check | Result |
|---|---|---|
| C2: `npm test` 1,967 of 1,967; `test:browser` 40 (39 pass, 1 skipped); `test:example` 170; e2e 71 of 71 and `--webkit` 76 of 76 with network policy PASS | re-run (section 0) | confirmed |
| v0.3: "Of the 64 end-to-end rows of R 4.2, 33 ran and passed (24 as written, 9 in part)" | the per-row table in deviations/integration-v03.md against the scenarios | E-SI-5 is listed as "pass" but its scenario says "PARTIAL: the identity origin's event.origin binding waits for lane idp" (`test/e2e/scenarios-v03.mjs:16`) and the proof comes from the stand-in `lab.proofFor` (`:328`), so the IdO binding the row is about never runs: 23 as written, 10 in part (finding M2) |
| v0.3: E-SO-1 "sign-up creates the personal site in the browser" | the scenario's plan | passes only with the hub box ticked by the harness (`scenarios-social.mjs:95`); the default path makes a page its owner cannot write to (finding H1) |
| v0.3: "marked v0.3 where the code landed and '(proposed)' where it did not" | the documents in section 4 | not true for ARCHITECTURE 15.7 (`blockTiers`), PRIVACY "Leave this site", OPERATIONS and THREAT-MODEL rows on rotation, `minSeq`, fingerprint links, PEX and quotas |
| C2: "what is not built keeps '(proposed)' in place (the pin request path, S4's second phase)" | DEPLOY, recipes/hub-pin.md | DEPLOY marks the request path (860-863) but not the mailbox; recipes/hub-pin.md (status "v0.3, built") still describes requests reaching the queue and the mailbox holding mail (finding H5) |
| C2: "`--chat`, `--files` and `--media` ... require `--tracker` and `--stun`" (CHANGELOG) | `tools/publish.mjs`, `src/loader/app.js:3972` | the STUN list is required and written, then used only by calls (finding C3) |
| v0.3 open lists | the lanes' requests | two requests of the idp lane to the sdk lane (`docs/deviations/idp.md:179-181`: forward the `kit` event to a loader prompt; write the `rotate` op on a `keychange` with `rsig`) were dropped and appear in no open list (findings H2, C1) |

## 6. Findings, most severe first

Each finding names the code, a concrete failure, the fix and the test that would have caught it. Severity follows the
review brief: critical = exploitable, key or data loss, or a privacy promise broken; high = a documented behaviour is
wrong in a floor browser or a must-fix item is unimplemented; medium = an edge case or a claim with a narrower effect;
low = hygiene.

### C1 (critical). "Replace my keys on all sites" writes no `rotate`, so a person loses the sites they own and every membership

- **Where:** `src/idp/idp.js:817-830` (replaceAllKeys bumps every label's sign index and records `rotated`);
  `src/idp/idp.js:491-504` (rotateNoticeFor: `{ from, next, rp, rsig }` signed by the recover key); `src/identity/service.js:404`
  (the notice only becomes a `keychange` event); no code under `src/` writes `{ t: 'rotate', ... }` (the only writer is
  `tools/ledger-admin.mjs:529-534`). Copy: `src/idp/strings.js:180`; runbook OPERATIONS.md:836-838; THREAT-MODEL.md:92;
  SECURITY.md:91. MF-20, MF-64; R 2.5.3; the idp lane's request in `docs/deviations/idp.md:180-181`, dropped.
- **Failure:** Ana owns her personal page on `hub.example` (`writers: 'owner'`, owner = her key `i = 1`) and is an
  `allow` member and moderator of a group. After an identity-origin incident she does what OPERATIONS.md tells her and presses
  "Replace my keys on all sites". At her next sign-in the identity origin hands every site key `i = 2`, and the identity
  service emits `keychange` to the page. Nothing writes the `rotate` (with `by: 'recover'`, `rp` and `rsig`, which the
  notice carries for exactly this) or an owner hand-over. On her own page she is now a `reader`: posting answers `E_POLICY`,
  and she can no longer edit or tombstone anything she wrote, because the identity origin never hands out key 1 again and
  has no undo. In the group she is neither a member nor a moderator. Her contacts see no key change. The card promised "people
  who know your old key see that it changed", and the runbook says it "moves each site to the next key".
- **Fix:** on `installFrom` with `keys.rotateNotice` whose `ledger` is this ledger and that carries `rsig`, write
  `{ t: 'rotate', from, next, by: 'recover', rp, rsig }` through `ChainNode.writeControl` before the first write with the new
  key; for a personal site also move owner standing (R 2.5.3 says `rotate` never carries it): re-sign the pointer with the
  committed `nx=` key and write the `owner` hand-over, which needs the identity origin to sign it with the old key during the
  same sign-in. Until that exists, the button must say that owned pages and memberships will not follow, and the runbook and
  THREAT-MODEL row must not offer it as the answer to stolen keys.
- **Test:** an integration test with the in-process identity origin (as `integration-v03-reconcile` does): create a personal
  site, `replaceAllKeys()`, sign in again, then assert a `rotate` block in the ledger, `role === 'owner'` for the new key and
  a post that succeeds; the same on an `allow` site asserts membership is kept; an e2e variant of E-SO-1 that replaces keys and
  posts again.

### C2 (critical). The public upload card says location and camera details were removed for files that are never stripped

- **Where:** `src/loader/strings.js:428` (`publicUpload`, the R 2.14.1 sentence), used unconditionally by the upload card
  (`src/loader/ui.js:1278-1289`); `src/files/lane.js:301-303` (`_strip` returns `removed: []` and the bytes as they are when
  `stripperFor` gives null); `src/media/strip.js:419-424` (only `image/*` other than SVG, MP4 or QuickTime, WebM).
- **Failure:** on a site with `_mw.cfg.files` on, a member shares a PDF flyer exported from a phone (its embedded photos keep
  their EXIF GPS block, and the PDF names its author) or a DOCX. The card reads "This file will be public on this site.
  Location and camera details were removed. People who fetch it will see your IP address while you share it." Nothing was
  removed; every visitor who fetches it gets the location and the name. This is the doxxing path MF-57 exists for, and the
  card tells the person it is closed.
- **Fix:** build the card from what happened: keep the sentence only when `removed.length > 0` for an image or a video;
  otherwise say that the file is shared exactly as it is and that documents and archives can carry a name or a location.
  The R 2.14.1 copy needs the same condition (owner and counsel review).
- **Test:** a unit test over `cardFor('file-share', { public: true, removed: [], mime: 'application/pdf' })` and the rendered
  upload card: no "were removed"; with `removed: ['exif']` and `image/jpeg` the sentence stays.

### C3 (critical). Chat, files and private media use the default STUN servers that PRIVACY.md says they never use, and the chat card names no STUN server

- **Where:** `src/loader/app.js:1420` (`A.iceServers = gateIceServers(A.config.stun, report)`, applied to every wire of the
  TorrentManager) with `src/loader/config.js:22` (Cloudflare and Twilio); the site's own STUN list from `publish --stun`
  (`/.mw/site.json`) is read only for calls (`src/loader/app.js:3971-3972`); `src/chat/service.js:801`
  (`card('chat.enable', { ledgerCopy, tracker })`, no `stun`), `src/loader/api.js:713` (`stun: d.stun || ''`),
  `src/loader/strings.js:422`. Claims: PRIVACY.md:248, CHANGELOG.md:102-103. MF-44, MF-59; R 2.1 rule 5, 2.7.1.
- **Failure:** an owner publishes with `--chat --tracker wss://t.example --stun stun:stun.example:3478`, as `publish` requires.
  A visitor taps "Turn on chat" and reads (probe output, the chat service's own card data): "Chat connects your browser to
  other visitors of this site through wss://t.example and . They see your IP address and when you are active." The STUN
  operator is missing from the one card that must name every recipient before data flows. Then the separate chat lane,
  every private media swarm and every file swarm gather ICE through `stun.cloudflare.com` and `global.stun.twilio.com`, so the
  two shared operators PRIVACY.md excludes see the start of each of these sessions, across every site that uses them (the
  cross-site observer MF-44 is about), while the owner's own STUN server is never contacted.
- **Fix:** when chat, files or media are on, give the TorrentManager the site's own STUN list for those swarms (simplest: for
  every wire once a feature is on), refuse the features when the list is empty (as chat already refuses without a tracker),
  and pass `stun` to the `chat.enable` card; or, if the defaults stay, correct PRIVACY.md, the CHANGELOG line and the card to
  name Cloudflare and Twilio.
- **Test:** a unit test that renders the card from the chat service's real `prompt` data and asserts no " and ." and a STUN
  host; an e2e assertion in E-CH-1 (an init script records every `RTCPeerConnection` configuration) that no default STUN URL
  appears once chat is on.

### C4 (critical). A door is told which site the visitor opens, although three texts say it is not

- **Where:** `src/loader/app.js:4400-4438` (doorDownloadPlan: `xsUrls(...).concat(doorTorrentUrls(cands, btih))` and
  `doorWebseeds(cands, ...)`); `src/loader/doors.js:89-135` (the current door is the first candidate; every candidate gets
  `/_mw/t/<btih>.torrent` and `/ws/`, with no check that it is a full door). Claims: PRIVACY.md:551 ("it does not see which
  site"), DEPLOY.md:1039, `tools/publish.mjs:539`.
- **Failure:** the site's own address is blocked, so a visitor opens its light link at a guest door, a loader-only host run by
  a third party. Without a quick `xs=` answer the loader requests `https://<guest door>/_mw/t/<btih>.torrent` within 250 ms
  (staggered `fetchFirst`), and it adds `https://<guest door>/ws/` as a web seed, whose requests carry the torrent's name and
  file paths. The guest door's access log now holds the visitor's IP address next to the site's infohash: the door knows
  which site was opened. The person was told the opposite, in exactly the situation doors exist for.
- **Fix:** ask for `.torrent` and web seed bytes only from doors that declare that they serve the site (a field in
  `door.json`, or the owner's signed `_doors` list marking full doors), and never from a loader-only door; or reword the three
  texts to say that a door the loader fetches the site from sees which site.
- **Test:** extend DOOR-GUEST: count the guest door's requests and assert that none has the btih or `/ws/` in its path; a
  unit test of the candidate filter in doorDownloadPlan.

### H1 (high). The hub-wide identity is off by default for the social template, so "Create my page" makes a page its owner cannot use; and a page can pre-tick the choice

- **Where:** `examples/social/js/app.js:153` (`mw.auth.signIn()` with no `hubDefault`); `src/idp/cards.js:308` (the box is
  checked only when the page sent `hubDefault: true`); `src/identity/service.js:423` (any site may send it); `src/idp/idp.js:620`
  (the first answer is stored as the hub decision); `src/loader/app.js:3274-3292` (createPage uses the current label's keys);
  `test/e2e/scenarios-social.mjs:95` (E-SO-1 ticks the box). MF-13, MF-12, N-6; R 3.1, 3.3, 2.3.5.
- **Failure:** Bo opens the social hub, signs in and leaves "Use one identity on all of hub.example" as it is (unticked),
  then taps "Create my page". The genesis is signed by Bo's pairwise key for the template's label, and the identity origin
  records the hub choice as off. When his new page opens, the identity origin derives `o|https://<bo-label>.hub.example`, a
  different pairwise key (probe: `o|https://aaaa...` and `o|https://bbbb...` with the box unticked, `h|hub.example` ticked).
  On his own page Bo is a `reader`: every post answers `E_POLICY` ("This site does not allow that."), the
  template treats the page as someone else's (`isHome()` needs `role === 'owner'`, `js/data.js:70`), and nothing in the
  template can repair it. The other half: any page on a Public Suffix List hub can call `mw.auth.signIn({ hubDefault: true })`
  and pre-tick the hub-wide link, which R 2.3.5 forbids ("no SDK parameter can preselect it").
- **Fix:** decide the default at the identity origin from something the page cannot set (a hub flag in the hub's signed
  pointer or configuration, or the template's btih), drop `hubDefault` from the SDK; make `mw.hub.createPage()` refuse, with
  its own sentence, unless the keys are hub-scoped (or ask the identity origin to turn hub scope on in the same card).
- **Test:** E-SO-1 with `hub: undefined` (the defaults) must still post on the new page; a unit test that
  `auth.signIn({ hubDefault: true })` from site code does not reach the request; a unit test that createPage refuses
  `keyMode !== 'hub'`.

### H2 (high). The recovery kit is never offered after the first meaningful action, except on iOS

- **Where:** `src/identity/service.js:273-280` (markMeaningful emits `kit`), called only from `identity.setName` (490) and
  `me.set` (546); `src/loader/api.js:141` (`SERVICE_EVENTS.identity.events` has no `kit`, so nothing subscribes); no loader
  prompt for it anywhere; `src/idp/idp.js:760` (the identity origin computes `kitDue` with `meaningful: false`). R 2.2.6
  ("the recovery-kit card appears after the first meaningful action: first ledger write, first message, first upload, first
  `mw.me.set`, first keep-history toggle"); the idp lane's request (`docs/deviations/idp.md:179-180`), dropped.
- **Failure:** Ana uses desktop Chrome with a passkey, posts, chats and uploads for weeks. No card ever asks her to save the
  12 words or a backup file (the `kit` event is emitted at most once, after a name or record change, and reaches no
  listener). Her laptop is lost and her passkey provider does not sync it, or the new device has no PRF: there is no phrase
  and no file, so every identity and every per-site key is gone. The design shows the kit exactly to prevent this.
- **Fix:** call markMeaningful on the first ledger write, message, upload and keep-history choice; forward `kit` (add it to
  the identity events, or subscribe in app.js and engine.js) to a loader prompt whose button calls
  `identity.openIdentity({ intent: 'kit' })` inside the click; or let the identity origin show the kit at the next sign-in
  when the site reports activity and `kitSaved` is false.
- **Test:** a unit test: a signed-in identity service with `kitSaved: false`, one `db.append`, then a pushed `kit` event and
  an open loader prompt; an e2e step after E-ID-1's post that sees the kit prompt in Chromium.

### H3 (high). A moderator's "deny" on a report writes a deny key that never matches, and no tombstone

- **Where:** `src/loader/mod.js:216` (a report item keeps only `target`), `:293-298` (`ident = item.ih || item.target.media ||
  item.target.h`, then `put('_deny/' + b64url(sha256(ident)))`); the checks: `src/files/lane.js:199, 564`
  (`isDenied(rec.ih, rec.sha256)`), `src/media/lane.js:699` (`isDenied(M.ih)`); a media id is `hex(fid)` (`media/lane.js:332`).
  MF-52; R 2.8.7, 2.9.10.
- **Failure:** a member reports an illegal public file (`report.send({ target: { h: <listing block hash> } })`) or a private
  video (`{ media: <id> }`). The moderator presses "Deny". The ledger gets `_deny/<sha256 of the block hash>` (or of the fid);
  the files lane looks for `_deny/<sha256 of the infohash>` or of the content hash, the media lane for the infohash. Nothing
  matches, no tombstone is written, so the listing stays visible and every honest loader keeps fetching and seeding the file;
  the moderator's queue shows the item as decided. The one-hour P0 action of OPERATIONS fails silently.
- **Fix:** on the moderator's device resolve a `{ h }` target to its listing and deny by its `ih` and `sha256`, and tombstone
  the listing in the same step (R 2.8.7); carry the infohash in media reports (it is metadata) and deny by it; flag a
  tombstone of a listing that has no deny entry.
- **Test:** a unit test of `mod.decide` for a report of an `mw.files` listing: afterwards `isDenied(listing.ih)` is true and
  the listing is tombstoned; the same for a media report with the files and media lanes refusing to fetch; the `_deny/` half of
  E-FI-1 run through the moderation UI.

### H4 (high). A report in the social template reaches nobody and says "Report sent."

- **Where:** `examples/social/js/views/post-card.js:72` (`report.send({ target: { h: item.h } })`, then "Report sent." whatever
  it returns); `src/loader/mod.js:331-339` (sends to `moderatorsOf(api.node)`, the page's own ledger, skipping the reporter).
  R 3.5 ("to the page or group's moderators, or for personal pages to the hub's moderation contact").
- **Failure:** in the home model every post Ana sees renders inside her own page. She reports Bo's harassing post: the
  moderators of her own personal ledger are only herself, so `sent` is 0, and the dialog says "Report sent.". A report of a
  group post read from her home goes nowhere either. The text above the button says the report goes "to the moderators".
- **Fix:** let `report.send` take `{ ledger }` and send to that ledger's moderators from the followed view; in the template,
  read `sent` and, at 0 (personal pages), say that nobody received it and show the hub's moderation contact instead.
- **Test:** an example test with the mock reporting `sent: 0`: the page does not say "Report sent."; a unit test that
  `report.send({ ..., ledger })` addresses that ledger's moderators.

### H5 (high). The pin mailbox never receives a frame, and five documents describe it, join requests and pin requests as working

- **Where:** `src/chat/service.js:1219` (`new Holder({ now })`; nothing in `src/` builds a pin-mailbox holder); `tools/pin.mjs:194`
  (`Mailbox`, a `Holder({ pinMailbox: true })` in Node) and `:1084-1100` (`mailbox.offer`, `want`, `challenge`, `respond`,
  `collected`), which no code in `src/` calls, so no frame ever reaches it;
  `src/loader/app.js:4057-4093` (the pin page's host offers files only). Claims: DEPLOY.md:1091-1095,
  recipes/hub-pin.md:4, 19-20, 55-57 (status "v0.3, built"), WHY.md:372, examples/social/README.md:97, THREAT-MODEL.md:391,
  CHANGELOG ("a mailbox protocol"). MF-33, MF-46, MF-66, MF-71; R 2.7.5 item 7, 3.2.4.
- **Failure:** a hub operator follows the recipe: `pin --mailbox --files`, `_mw.cfg.pin` set. Bo writes to Ana while she is
  offline; the sender flags the frame for holding, but no holder is reachable (the pin's page never joins the chat lane as a
  holder, and the Node mailbox gets no frames), so it ends
  "Not delivered" or waits in Bo's outbox while his page stays open. Join requests and the notices of the social template are
  never held, and no member item can ever become "Kept by the hub" (with O-1, nothing can ask the pin to keep it). The operator
  pays for a mailbox that receives nothing, and members are told the hub keeps their messages and media.
- **Fix:** run the pin page's chat lane as a pin-mailbox holder that stores through `__mwPinCall('mailbox.*')`, or mark the
  mailbox, join requests and the pin request path "(proposed)" in each of the documents above.
- **Test:** E-CH-2 with the pin fixture as the holder: a held frame for an offline recipient is collected after she comes
  online and deleted on COLLECTED; a docs test that the hub-pin recipe's status names its unbuilt parts.

### H6 (high). "Leave this site" is offered by PRIVACY.md and does not exist

- **Where:** PRIVACY.md:320 ("Leave this site | ... also tombstones every payload this key wrote, empties the profile, stops
  seeding and revokes grants"); R 2.15; no method, card or page in `src/` or `examples/` (grep).
- **Failure:** a visitor exercising the rights PRIVACY.md describes looks for "Leave this site": there is none. Their public
  posts and name stay, their uploads keep seeding while the page is open, and grants they gave are not revoked. A data-rights
  statement in the privacy page promises an action the software does not have.
- **Fix:** build it in the identity service (tombstone every payload of this key, set the profile empty, stop seeding, revoke
  grants, then `me.erase`) with its card, or move the row to "(proposed)".
- **Test:** a unit test of the new method over a ChainNode; a docs test that every action of the rights table names an SDK
  method or a card that exists.

### H7 (high). The social template's "Delete my page" keeps the name and every reaction public, and cannot withdraw the page it says it withdraws

- **Where:** `examples/social/js/views/settings.js:255-281` (the card: "This hides every post, comment, share and follow ...
  and withdraws your page's address"); `examples/social/js/data.js:460-463` (ownPayloads walks `lists` only, so `re/...` puts
  and the profile name are never removed); `examples/social/js/hub.js:148-150` (withdrawPage throws `NOT_AVAILABLE`, GAP 2).
  R 3.3 ("tombstones every payload on the person's ledger; a withdrawal pointer").
- **Failure:** Ana deletes her page. Her posts disappear, but every reaction she made (`re/<ledger>/<h>` keys, which show what
  she reacted to and when) and her display name stay on her ledger, and her address keeps serving them, because the
  withdrawal step fails with "This copy of the loader does not offer that yet.". The card had promised the withdrawal.
- **Fix:** also tombstone or delete every key this author wrote (reactions, `@`-scoped keys) and set the profile name empty;
  build `mw.hub.withdrawPage()` or take the withdrawal out of the card until it exists.
- **Test:** an example test: after "Delete my page" the own snapshot has no live `re/` keys and an empty name, and the card
  promises only what ran.

### H8 (high). MF-30 is partly missing: no signed `minSeq`, no `#host:name@<fp>` links, and a "(DNSSEC)" badge

- **Where:** `src/loader/strings.js:137` (`'DNS via ' + resolver + (ad ? ' (DNSSEC)' : '')`, shown by the pointer badge at
  `src/loader/app.js:1621`) against `src/loader/doh.js:23-26` (`AD_WORDING = 'resolver says validated'`, "the UI shows this
  wording and never a validated badge", unused by any UI); `src/loader/harden.js:324` (parseHostFingerprintLink, no caller);
  no `minSeq` anywhere in `src/` or `tools/`. Claims: THREAT-MODEL.md:157, 219, 279, 280 ("the design as built"). MF-30; PTR
  A3, A4; HUB H4.
- **Failure:** (a) a resolver that sets AD makes the badge read "Pointer: DNS via Cloudflare (DNSSEC), signed", a validated
  badge for a check the loader never made (PTR A3). (b) A cold device that is handed an old signed pointer (seq below the
  owner's current one) has no ledger-signed `minSeq` to refuse it, so the rollback THREAT-MODEL marks mitigated still works
  (PTR A4, HUB H4). (c) A shared `#host:name@<fp>` link, the mitigation for first-use DNS trust, is not understood by the loader.
- **Fix:** show `AD_WORDING` in the badge; add the `minSeq` policy field (freeze group, a state rule) and check it on load;
  wire parseHostFingerprintLink into hub-root and shell resolution; or mark the three as "(proposed)" in THREAT-MODEL.
- **Test:** a strings test that no badge text contains "DNSSEC" without "resolver says"; a vector and a loader unit test for a
  pointer with a seq below `minSeq`; a resolve test for `#host:example.com@<fp>`.

### H9 (high). MF-53: a new key's first public files are not premoderated

- **Where:** `src/loader/mod.js:225-236` (`queueListing`, "lane media calls it through the API") has no caller in `src/files`,
  `src/media` or `src/loader`; `src/files/lane.js` publishes a public listing at once. MF-53; R 2.10.2 (`mw.files`:
  "premoderated for new keys"), 2.17.1, 2.5.4.
- **Failure:** on an `open` site with public files on, a fresh key (one fee, unlinkable by design) lists malware or illegal
  material; it is listed for every visitor at once, and a ban only hides it after the fact. The cost the design puts on new keys
  is absent.
- **Fix:** when the author has no prior accepted listing (or is not `allow`-listed), hold the listing in the moderators'
  queue (`queueListing`) and show it only after `mod.decide(..., 'accept')`, as a state or SDK rule.
- **Test:** a unit test: a new key's `files.share({ public: true })` on an open site produces a queue item and no visible
  listing until a moderator accepts.

### H10 (high). OPERATIONS.md and THREAT-MODEL.md rely on an open-writing warning and a per-author byte quota that do not exist

- **Where:** OPERATIONS.md:763 ("`ledger-admin` warns when a policy opens writing, and a per-author byte quota applies
  (MF-54)"), THREAT-MODEL.md:245 ("per-author quotas"); `tools/ledger-admin.mjs` has no such warning (its only warnings are at
  982 and 1075-1076), and no per-author byte limit exists beyond the shared reserved pool (`src/chain/node.js` admit). MF-54;
  MAL A12.
- **Failure:** an owner who sets `writers: 'open'` gets no warning and trusts the documented quota. The reserved pool for
  unvetted authors (25 percent of `maxChainBytes`, 2 MiB of the 8 MiB default) is shared, so one key inside its rate limit (30
  entries in 10 minutes, SDK.md) fills it with about 900 entries of 2 KiB in about five hours (arithmetic), and a handful of
  keys in minutes; every other newcomer then gets `E_CAP`.
- **Fix:** add the warning to `ledger-admin policy` (and `publish`) when `writers` becomes `open`, and a per-author byte cap as
  an admit rule; or correct both documents.
- **Test:** a tools test that `ledger-admin policy --writers open` prints the warning; an admit test that one unvetted author
  cannot take more than its share of the pool.

### H11 (high). MF-77: PEX bootstrap and persisted good peers are not built, and THREAT-MODEL marks rendezvous poisoning mitigated by them

- **Where:** `src/loader/torrent.js:1168` (`utPex: false`), no persisted peer list in `src/loader` or `src/chain`;
  THREAT-MODEL.md:156, 336 ("mitigated | own tracker, persisted peers, PEX"). MF-77; SYB A10.
- **Failure:** a Sybil set that fills the rendezvous swarm on a public tracker (SYB A10) feeds a cold visitor only its own
  peers; with no remembered good peers and no PEX from them, the visitor has no way out of the poisoned set, which the threat
  model says is mitigated.
- **Fix:** persist the peers that delivered valid blocks (the anchored wires) per ledger and dial them first; enable
  `ut_pex` from anchored wires only; or move the row to "open" with its reason.
- **Test:** a unit test that a ledger's anchored peers are stored and offered first on the next start; a THREAT-MODEL check
  that each "mitigated" row names a mechanism found in the code.

### M1 (medium). ARCHITECTURE 15.7 documents `_mw.cfg.blockTiers`, which hides the site's whole `_mw.cfg`

- **Where:** ARCHITECTURE.md:1483-1484 ("Owners block a sniffed tier with `_mw.cfg.blockTiers`"); `src/files/lane.js:668-669`
  reads it; `src/chain/state.js:250-300` (`CFG`, `cfgOk`) refuses any `_mw.cfg` with a key it does not list, so honest
  readers hide the whole object. OPERATIONS.md:690-695 warns not to write it. R 2.8.5 ("Owners may block a tier").
- **Failure:** an owner follows ARCHITECTURE and writes `_mw.cfg = { chat: 'members', files: 'members', blockTiers: ['executable'] }`;
  every honest loader hides the object, so chat, files and media read as off and executables are not blocked either (the
  C2-5 failure, again, for another key).
- **Fix:** add `blockTiers` (a list of known tier names) to `CFG` and a `ledger-admin cfg --block-tiers` flag, or drop the
  sentence from ARCHITECTURE; do the same decision for `wall` and `requests: 'introduced'`.
- **Test:** the C2-5 test generalised: every `_mw.cfg` key a document or a lane names passes `cfgOk`.

### M2 (medium). E-SI-5 is counted as passing as written, but it never exercises the identity origin

- **Where:** docs/deviations/integration-v03.md:328 ("E-SI-5 | pass"); `test/e2e/scenarios-v03.mjs:16` ("PARTIAL: the
  identity origin's event.origin binding waits for lane idp") and `:328` (the proof comes from `lab.proofFor`, a stand-in
  that signs the proxy origin by construction). INTEGRATION-STATUS ("24 as written, 9 in part"). R 4.2 E-SI-5, MF-07.
- **Failure:** the row's point is that a rewritten loader cannot make the identity origin sign the real origin; the scenario
  only shows that the verifier refuses a wrong `origin`, which E-SI-2 already shows. A regression that let the identity origin
  take `origin` from the request would pass E-SI-5.
- **Fix:** drive the real identity origin through the rewriting proxy (the e2e stack already serves one) and assert the proof's
  `origin` is the proxy's; until then list the row as "pass, partial" and the count as 23 and 10.
- **Test:** the scenario itself, with `signInPopup` instead of `lab.proofFor`.

### M3 (medium). SDK.md says site code never sees the working keys

- **Where:** docs/SDK.md:352-356 ("the site's code never sees them, only the public key"). MF-15, R 2.1 rule 2, 2.14.2.
- **Failure:** a site developer reads that third-party scripts on the page cannot touch the visitor's keys and adds them
  freely; in shell mode the site frame is same-origin with the loader, so such a script can use the keys of this site, and
  copy the scalars as they pass through the loader's realm, while the person is signed in.
- **Fix:** "No SDK method returns them, but code on this site, including scripts you include, can use and copy the keys for
  this site while the person is signed in."
- **Test:** add the sentence to the replaced-sentence list that `ui-v03-strings` checks, and run that check over SDK.md.

### M4 (medium). PRIVACY.md and the removal card say a removed record key cannot be recovered

- **Where:** PRIVACY.md:324; `src/idp/strings.js:136` and `src/loader/strings.js:436` ("remaining copies can no longer be
  opened by you or anyone who later gets your 12 words"); against `docs/deviations/idp.md` item 18 (older vault blobs kept as
  escrow on other sites still hold the old keys) and the backup files made before the removal. The idp lane asked for this
  limitation in PRIVACY.md (`docs/deviations/idp.md:185`); it was not added. R 2.15, PR-2.
- **Failure:** Ana removes her private data on a site, believing the copies are now unreadable even to her. Her identity origin
  later loses its storage and adopts the escrow vault blob another site kept from last month, or she restores last month's
  backup file: the shredded `K_rec` is back, and with it the "removed" record.
- **Fix:** state the limit in both texts ("copies of your identity made before, such as an older backup file, can still open
  them"), or make removal rotate `K_vault` and refresh every escrow copy at the next sign-in on each site.
- **Test:** a unit test at the identity origin: erase, then restore from the earlier vault blob, then show whether `K_rec`
  returns, with the copy matching the result.

### M5 (medium). Every sign-in on a hub label shows "This address is not one of this site's addresses."

- **Where:** `src/idp/idp.js:582` (notListed from `preLabel.reason === 'not-listed'`); a personal pointer is signed for the
  `btih:` scope (`src/loader/personal-site.js`), so `verifyPointerFor` returns `host: null` and labelFor reports `not-listed`
  for the template label and every personal label (`src/identity/derive.js:300-308`) until a hub decision is on record.
  R 2.2.3 (the sentence is for "a look-alike origin claiming the ledger id"). Listed as open in INTEGRATION-STATUS.
- **Failure:** the first sign-in on the social hub, and every sign-in when the hub box is off, carries the look-alike warning
  for the real site: people learn to ignore the one sentence meant to stop a look-alike.
- **Fix:** do not show it when the origin is a label of a hub on the Public Suffix List and the pointer's btih is the hub's
  template, or let the hub list its suffix in the pointer's `org=`.
- **Test:** an IdO card test for a personal pointer on a hub label: no `notListed` line.

### M6 (medium). Phone background behaviour is described on call cards before the C2 gate rows ran

- **Where:** `src/calls/service.js:202-203`, `src/loader/call-ui.js:123, 379`, `src/loader/strings.js:823-824`
  (`call.ios`, `call.android`). SZ section 4 P0 and 3.1.10 ("rows 1 to 4 run before any card describes phones in the
  background"); MF-63 handles the same risk for iOS and Tor strings with `STRING_FLAGS.iosTorStrings`.
- **Failure:** every iPhone caller is told that "an app on the Home Screen loses the microphone too", a sentence from a
  2023 bug report that no gate row has checked on iOS 26 or 27; if it is wrong, the card misleads exactly where the P0 said
  not to.
- **Fix:** put `call.ios` and `call.android` behind a flag that stays false until G-CL-2 and G-CL-3 pass (as
  `iosTorStrings`), and show the neutral "Keep this page open during the call." meanwhile.
- **Test:** a strings test that the background sentences render only with the flag set.

### L1 (low). The hub identity card says other sites "cannot match you"

- **Where:** `src/idp/strings.js:75` ("Everyone on {hub} will see one identity for you. Other sites still cannot match you."),
  copied from R 2.14.1, which conflicts with R 2.14.2's own replacement of "Sites cannot match a visitor by key".
- **Failure:** the person reads an unconditional promise that other sites cannot match them, although they can by IP address,
  timing or a reused name.
- **Fix:** "Other sites still cannot match you by key." (owner sign-off, since R gives the copy).
- **Test:** the replaced-sentence test: "cannot match you" must be followed by "by key".

### L2 (low). The social template rewrites `_mw.cfg` without the keys it does not know, `calls` among them

- **Where:** `examples/social/js/data.js:310-322` (ensureFeature copies only `CFG_KEYS`), `examples/social/js/config.js:17`
  (no `calls`, added to the schema in C2).
- **Failure:** on a personal ledger whose `_mw.cfg` has `calls: 'contacts'`, the first private photo rewrites `_mw.cfg`
  without it and switches calls off.
- **Fix:** keep every key the current schema accepts (read the list from the SDK, or keep unknown keys that `cfgOk` accepts).
- **Test:** an example model test: ensureFeature over `{ calls: 'contacts' }` keeps it.

### L3 (low). "Download my data" is not the export R 3.3 specifies

- **Where:** `examples/social/js/data.js:450-458` (lists, keys and names from the snapshot, plus local state).
- **Failure:** the file has no signed blocks (it cannot be checked or re-imported elsewhere) and none of the private record's
  fields, both of which R 3.3 lists.
- **Fix:** add `mw.db.exportBlocks()` (or the loader's `node.exportBlocks()` through the SDK) and the record fields after the
  record card.
- **Test:** an example test that the export holds the blocks with signatures and the record fields.

### L4 (low). Directory entries are shown without checking their signatures

- **Where:** `examples/social/js/directory.js:6, 19-29` ("This template does not check hubSig or the person's signature").
  MF-67; R 3.4. The directory ships off, behind "pending counsel".
- **Failure:** once an operator turns it on, a CDN or a compromised shard can map a name to another person's ledger; the
  first follow pins the wrong ledger, and the warning only catches later changes.
- **Fix:** verify the person's `sig` over `{ name, ledgerId, pointer, t }` with the key in the pointer, and `hubSig` with the
  hub's key, before showing an entry.
- **Test:** a directory test with a forged entry: shown as unverified, not followable.
