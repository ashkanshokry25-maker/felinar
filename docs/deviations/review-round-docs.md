# Review round (R 5.3), fixer "docs": findings, fixes and requests

Lane: docs (README.md, docs/*.md except THREAT-MODEL, OPERATIONS, DEPLOY, DEMO-RESULTS, PUBLISH-CHECKLIST and DEV-NETWORK,
docs/recipes/**, string fixes in src/loader/strings.js and src/idp/strings.js, the CHANGELOG known-gaps lines). Date:
2026-10-24, 04:00 to 04:20 ET. An earlier run of this fixer was cut off after editing README.md, docs/FAQ.md, docs/PRIVACY.md and
docs/WHY.md (`git diff 4e82be5 HEAD`); those edits were checked against the code, kept, and corrected in two places (WHY.md said
a phone's own uploads have month caps: the month cap counts K and E only, `src/loader/seed-budget.js:28`, `:178`; and the four
documents now say adding a site to the Home Screen "is not a way to keep" the identity rather than asserting the untested
opposite, because row G-ID-1 has not run, `docs/DEMO-RESULTS.md:360`). README.md had no security mailbox line to keep.

Regression test: `test/unit/docs-review-round.test.mjs` (new, 20 tests). Each test reads the document or the card text and the
code it describes; where the claim depends on code that another fixer may change, the test checks the code first and names the
sentence to update.

## Findings

| Id | Status | Files | Test |
|---|---|---|---|
| HON-1 | partial | CHANGELOG.md:371-376 (known gap: STALK A3 for blocks, A4, A7, A11, A12 not built); THREAT-MODEL.md is owned by tools: Request 1 | `HON-1, STALK-11` |
| HON-2 | fixed in owned files, partial elsewhere | docs/FAQ.md:496-500, docs/PRIVACY.md:362-377 and :564-565 (no age-keyed defaults; the setting changes nothing; profiles follow the writer policy), CHANGELOG.md:379-381; OPERATIONS.md, DEPLOY.md and tools/init.mjs: Requests 2, 3, 5 | `HON-2` |
| HON-3 | fixed | docs/PRIVACY.md:352-355 (an owner duty; the tools do not check it), CHANGELOG.md:379-381 | `HON-3` |
| HON-4 | fixed (one checklist grep requested) | docs/FAQ.md:385-387 (no default identity page, N-2), :488-490 (a hash each release will list once releases are published); PUBLISH-CHECKLIST.md:1311: Request 8 | `HON-4` |
| HON-5 | fixed in owned files, partial elsewhere | README.md:78-81, docs/FAQ.md:418-423, docs/WHY.md:129-134 (no Settings export in 0.3.0), docs/COMPATIBILITY.md:78-83 and :262 (the Home Screen exemption is not shown for the identity origin); the Settings hint `iosHomeScreen` and examples: Requests 9, 10 | `HON-5` (asserts `kitDue().offerHomeScreen` is false for every input, `src/idp/cards.js:83-87`) |
| HON-6 | fixed in owned files, partial elsewhere | docs/SECURITY-MODEL.md:314-318 (fuzz targets named, unfuzzed parsers listed), CHANGELOG.md:377-378; SECURITY.md is owned by tools: Request 4 | `HON-6` (every parser the document calls fuzzed maps to a `loadTargets()` name) |
| HON-7 | fixed in owned files, partial elsewhere | docs/PRIVACY.md:252 (chat also rides the ledger wires; those servers do not learn that you chat), src/loader/strings.js `turnOnChat` en and fr (a sentence added after the one the card test pins); THREAT-MODEL.md:62, DEPLOY.md:1149, OPERATIONS.md:703, CHANGELOG.md:119, tools/init.mjs:240: Requests 1 to 3, 5, 7 | `HON-7` (checks `registerChatWire` still registers on `'rendezvous'`, `src/chat/wire.js:115-123`) |
| SCALE-9 | fixed in owned files, partial elsewhere | docs/recipes/hub-pin.md:3-6 and :22, docs/FAQ.md:465-470, CHANGELOG.md:382-383; DEPLOY.md:1095-1114: Request 2; `--max-total` in tools/pin.mjs (no fixer may touch it): Request 6 | `SCALE-9` (checks `PIN_LIMITS.maxTotalBytes`, no `--max-total`, no member code in `tools/pin.mjs`) |
| STALK-11 | partial | as HON-1 (same rows A4, A7, A11, A12) | `HON-1, STALK-11` |
| CONF-1 (chat panel) | fixed in owned files | docs/INTERFACES.md:1145; chat-panel.js:13 and publish.mjs:728: Request 11 | `CONF-1, CONF-4` (the panel reads only `lang`) |
| CONF-1 (upload note, `app.js`) | rejected: minor, deferred | loader code, not this lane's; exact fix in Request 12 | |
| CONF-2 (spec section 7) | rejected: minor, deferred | docs/specs/mw-signin-v1.md is the identity lane's; Request 13 | |
| CONF-2 (ARCH 15.14) | fixed | docs/ARCHITECTURE.md:1754-1758 (E_NEEDS_GESTURE before E_POLICY, as `src/loader/api.js:25-29` and `:1549-1553`) | `CONF-2` |
| CONF-3 (spec section 3) | rejected: minor, deferred | docs/specs/mw-signin-v1.md; Request 13 | |
| CONF-3 (ARCH 15.15) | fixed | docs/ARCHITECTURE.md:1800-1814 (hints, `dr=` and `_doors` serve the loader only; byte doors only), as `src/loader/doors.js:115-132` | `CONF-3` (calls `byteDoors` with every candidate kind) |
| CONF-4 (INTERFACES nonce store) | fixed | docs/INTERFACES.md:768 (`consume(nonce, expMs, origin)`, as `packages/verify/verify.js:362`) | `CONF-1, CONF-4` |
| CONF-4 (ARCH 15.12 prefixes) | fixed | docs/ARCHITECTURE.md:1591-1604 | `SEC-11, CONF-4, CONF-5` |
| CONF-5 | fixed | docs/ARCHITECTURE.md:1591-1604 | `SEC-11, CONF-4, CONF-5` |
| CONF-6 | rejected: minor, deferred | docs/specs/mw-signin-v1.md:174 is the identity lane's; Request 13 | |
| GATE-2 | rejected: minor, deferred | docs/DEMO-RESULTS.md (no fixer may touch it); Request 14 | |
| HON-8 | fixed in owned files | docs/PRIVACY.md:409-411 (the smallest of the four buckets, `src/chat/seal.js` `chooseBucket`); THREAT-MODEL.md:118: Request 1 | `HON-8` |
| HON-9 | fixed | docs/PRIVACY.md:273 (memory, while the page is open), src/loader/strings.js `holdMessages` en and fr; examples/social copy: Request 9 | `HON-9` (checks `src/chat/holder.js` has no storage) |
| HON-10 | fixed | docs/FAQ.md:88-104 (lanes H, K, E, the month and session caps, 2.25 MiB/s), docs/WHY.md:121-127 | `HON-10` (recomputes every figure from `CONFIG.seed.rows`) |
| HON-11 | fixed | docs/PRIVACY.md:66 and :73-74 (the row is for builds without the identity service; the ROADMAP sentence is gone) | `HON-11` |
| HON-12 | fixed in owned files, partial elsewhere | README.md:248-251, docs/WHY.md:156-158 ("passed in the last full runs recorded in INTEGRATION-STATUS"); CHANGELOG.md:335-339 is not a known-gaps line: Request 7 | `HON-12, HON-14` |
| HON-13 | fixed | docs/SECURITY-MODEL.md:246 (files never re-seeded after a fetch; opened private media stays on the Echo lane, `src/media/lane.js:132-141`, `:620`, `:862`; `src/files/lane.js:752`), docs/PRIVACY.md:396-401; the media card sentence: Request 15 | `HON-13` |
| HON-14 | fixed | README.md:89 (heading "Why the site ledger has no mining or global agreement"; the word is gone from README); the exception in PUBLISH-CHECKLIST.md:577 and CONTRIBUTING.md:195: Request 8 | `HON-12, HON-14` |
| HUB-11 | rejected: minor, deferred | the rows it reopens depend on HUB-1 to HUB-6 and HUB-9, which the chain and identity fixers are changing in this round; THREAT-MODEL.md and OPERATIONS.md are the tools lane's. Re-read SECURITY-MODEL.md:217 and :222 and PRIVACY.md:249 once those land | |
| SCALE-16 | fixed | docs/WHY.md:255 (about 2,000 to 3,700 likes from visitors: 25% of 8,388,608 bytes is 2,097,152, divided by 1,039 and 570) | `SCALE-16` (from `DEFAULT_POLICY.maxChainBytes` and `FREEZE_POLICY_DEFAULTS.reservedPool`) |
| SEC-11 | fixed | docs/ARCHITECTURE.md:1591-1604: `mw-release-v1`, `mw-local-cache-v1`, `mw-idp-record-v1`, `mw-idp-legacy-v1`, `mw-idp-bundle-v1`, `mw-vault-gone-v1`, `mw-pin-v1`, `mw-refusal-v1`, `mw-pin1-request`, `mw-rot-v2`, `mw-label-v1`, `mw-inbox-v2`, the three `mw-dm-v2|` sub-purposes, and two prefixes other fixers added during this round (`mw-rotate-self-v1`, `src/chain/block.js:83`; `mw-collect-v1`, `src/chat/limits.js:226`) | `SEC-11, CONF-4, CONF-5` (every `mw-*-v<n>` and `mw-pin1-*` literal in src, tools and packages must appear in ARCHITECTURE.md or R 2.10.3) |
| UX-19 | fixed | docs/QUICKSTART.md:155 (rung 2c: `npm install node-datachannel` in a clone, then `npx lightweb seed`; the package is not on npm) | `UX-19` |

## Tests run

- `node tools/run-unit.mjs docs-review-round.test.mjs`: 20 of 20 pass (04:17 ET).
- `node tools/run-unit.mjs ui-v03-strings.test.mjs loader-review-v03-torrent.test.mjs ui-v03-cards.test.mjs sdk-v03-wiring.test.mjs
  docs-links.test.mjs docs-claims.test.mjs`: 58 of 58 pass after the string edits.
- `npm test` (04:14 ET): lint floor clean over 147 files; 2,145 tests, 2,133 pass, 12 fail, none in this lane's files: chat-core-seal,
  chat-lane-holder, chat-lane-routing (3), chat-lane-service (2), idp-cards, idp-protocol (2), pinwire and repo-layout
  (`SECURITY-KEY.asc`, already reported in deviations/review-round-tests.md:76-81). Those files belong to fixers editing the tree at
  the same time.
- `node test/e2e/run.mjs --only E-CH-1` (04:17 ET, every request on 127.0.0.1): failed at "MA and MB add each other as contacts"
  with `contacts.add: E_INTERNAL`, before any card text this lane changed is shown; `src/chat/*` was being edited by the chat fixer at
  the time (the chat unit failures above). No e2e scenario asserts the `turnOnChat` or `holdMessages` text (`grep` over test/e2e).
  Re-run E-CH-1 after the chat fixer lands.

## Requests

1. **tools, docs/THREAT-MODEL.md** (HON-1, STALK-11, HON-7, HON-8). Line 12: after "describes the design as built" add "except the
   rows marked (not built)". Line 60, "After" cell: `relay jitter and random subsets for chat frames (STALK A3); new ledger blocks go
   to every neighbour at once (not built)`. Line 62, "After" cell: `the separate chat lane, group lanes and private media swarms
   announce only to the site's own tracker and use its STUN; chat also travels over the ledger rendezvous wires, which the pointer's
   trackers and the default STUN helped set up (they do not learn that a person chats)`. Line 65, "After" cell: `unchanged; the poll
   keeps its interval (TTL, at least 5 minutes) while the tab is hidden (STALK A11, not built)`. Line 118, last cell: replace "an offer
   or an answer uses the 16,000-byte bucket" with "an offer or an answer is padded to the smallest bucket that holds it, so its size
   hints at the media". Line 299: `| STALK A3 first-seen origin inference | mitigated for chat frames; open for ledger blocks | jitter
   and relay subsets for chat frames; ledger blocks: not built |`. Line 300: `| STALK A4 Sybil harvest of the swarm | open by design
   (IPs are visible to peers) | per-IP-prefix wire caps and a members-only lane id: not built |`. Line 303: `| STALK A7 cross-site
   re-linking by metadata | mitigated in part | self-hosted widget, own trackers; the announce delay after sign-in is not built (only the
   0 to 1.5 s rendezvous join jitter, src/loader/config.js:86); open for IP |`. Line 308: `| STALK A12 profile metadata and style |
   open | the reused-name hint is not built |`. Test: add to `test/unit/docs-claims.test.mjs` (tests lane): every STALK row whose
   mechanism `test/unit/docs-review-round.test.mjs` "HON-1, STALK-11" finds missing in code carries "not built".
2. **tools, docs/DEPLOY.md** (SCALE-9, HON-2, HON-7). Line 1096: "It pins each member's recent ledger window and public media and
   writes the `cs=` snapshots." becomes "`tools/pin.mjs` pins one site (the URL it is given), writes that site's `cs=` snapshot and
   keeps at most 2 GiB of approved files in all; pinning each member's ledger window and writing per-member snapshots is
   **(proposed)**." Line 1114, figure cell: "about US$1,610 a month once member pinning is built (proposed; one node holds 2 GiB of
   files today)". Line 1081: "leave the children's defaults on unless you have an age method" becomes "keep chat, uploads and open
   writing off for a site that children use (nothing checks age; `_mw.cfg.age` changes nothing in 0.3.0)". Line 1149: after "are not
   used for chat, groups or private media" add "lanes; chat also travels over the ledger wires those servers helped set up, and they
   do not learn that a person chats". Test: `SCALE-9` in docs-review-round can then also read DEPLOY.md.
3. **tools, docs/OPERATIONS.md** (HON-2, HON-7). Line 690, fourth cell: "`none`: the default; in 0.3.0 no code reads this setting,
   so it changes no default ([PRIVACY.md](PRIVACY.md#defaults))". Lines 905-906: "**Children.** Nothing checks age, and the age
   method setting changes nothing in 0.3.0. Do not turn on chat, uploads or open writing for a site that children use unless you have
   an age method of your own and have completed an assessment." Line 703: as Request 2, line 1149.
4. **tools, SECURITY.md** (HON-6). Line 73: "the fuzzers in `test/fuzz/`" becomes "the fuzzers in `test/fuzz/` (targets for the
   ledger, pointer, sign-in, files and chat-frame parsers; see the Fuzzing row)". Line 88, after the parser list add: "Targets today:
   gossip, blocks, JCS, pointer, pointer TXT, magnet, bencode, torrent files, inflate, sign-in proofs, the verify package, file
   listings, chat frames and points. Not yet: the Noise handshake, sealed items and the sealed box, the media chunk format, MP4 and
   WebM rewriting, image headers." Test: extend `HON-6` in docs-review-round to read SECURITY.md the same way.
5. **tools, tools/init.mjs** (HON-2, HON-7). Line 366: "Age method: 'none' (children's defaults apply) or an age verifier's public
   key" becomes "Age method: 'none' or an age verifier's public key (0.3.0 does not use this setting yet)". Line 240: "(the shared
   public trackers are not used for chat, groups or private media)" becomes "(the chat, group and private media lanes use only your own
   tracker)". Optional (HON-2, HON-3 fix option 1): `ledger-admin cfg` (chain lane) prints "Nothing checks age: _mw.cfg.age is none"
   when chat, files or media are turned on with age none. Test: `tools-v03-init.test.mjs` asserts the prompt text.
6. **integrator, tools/pin.mjs** (SCALE-9; no fixer may touch it). Add `'max-total': { type: 'size' }` to `PIN_FLAGS` (`:1556-1582`)
   and pass `limits: { maxTotalBytes }` to `createPinHost` in `runPin` (`:1322-1326`) and `runModeration` (`:1533`). Test
   (tools-v03-pin): `createPinHost` with the CLI's limits accepts more than 2 GiB of declared sizes. Then update
   docs/recipes/hub-pin.md:4-5 and the `SCALE-9` test, which checks for the flag.
7. **integrator, CHANGELOG.md outside the known gaps** (HON-7, HON-12). Line 119: "(these three require `--tracker` and `--stun`:
   the features never use the public default trackers)" becomes "(these three require `--tracker` and `--stun`: the feature lanes
   announce only to the site's own tracker; chat also rides the ledger wires)". Line 335: "as run on the final tree on 2026-10-21"
   becomes "as run on 2026-10-21 between 00:22 and 02:39 ET, before the verify fix round 2 (whose full e2e run was 69 of 72, E-MD-4
   flaking: docs/INTEGRATION-STATUS.md)".
8. **integrator, docs/PUBLISH-CHECKLIST.md and CONTRIBUTING.md** (HON-4, HON-14). PUBLISH-CHECKLIST.md:1311, add `|project
   publishes (one|an identity)` to the `-E` pattern. PUBLISH-CHECKLIST.md:577 and CONTRIBUTING.md:195: README no longer has the
   "Why not a blockchain?" section, so drop the exception ("`blockchain` may appear once ..." becomes "`blockchain` appears only where
   the rule is quoted"). `test/unit/docs-links.test.mjs:77-92` (tests lane) can drop its `inWhyNotBlockchain` allowance.
9. **integrator, examples/social/js/views/settings.js:228** (HON-9; no fixer may touch it): "You will store encrypted messages from
   other people that you cannot read, for up to 7 days. Not available on phones." becomes "While this page is open, and for up to 7
   days, you will keep encrypted messages from other people that you cannot read. Nothing is written to disk. Not available on
   phones."
10. **examples, examples/peer-guestbook/about.html:68** (HON-5): replace the sentence that ties the identity to the Home Screen with
    "Safari may delete the site's local copy after 7 days without a visit. Your identity lives at the identity page, so adding the site
    to the Home Screen is not a way to keep it: keep your 12 words or the backup file." `members.html:65` (HON-7): append "Chat also
    travels over the connections your browser already has for this site's ledger."
11. **tools and identity, `<mw-chat-panel>` attributes** (CONF-1): `src/widget/chat-panel.js:13` usage comment becomes
    `//   <mw-chat-panel></mw-chat-panel>` (only `lang` is read, `:42`); `tools/publish.mjs:728` prints `'<mw-chat-panel></mw-chat-panel>'`;
    add an F-6 follow-up line to docs/deviations/ui.md item 8. Test: publish's printed tag carries no tracker or stun attribute.
12. **loader, src/loader/app.js** (CONF-1, upload note): at the `setUploads` call (`app.js:3978-3979` in the finding),
    `note: rows.length && !cfg.pin ? ...` becomes `note: rows.length && !pinKeyOf(A) ? ...` (`pinKeyOf`, `app.js:4093`). Test: a
    `_mw.cfg.pin` not in `state.ownerWritten` gives `SEED_TEXT 'avail.noPin'`; an owner-written one gives null. Also (HON-5) the
    Settings hint `STRINGS.iosHomeScreen` (`src/loader/strings.js:99`) offers an export that v0.3 mode turns off (`app.js:2801`); in
    v0.3 mode show instead: "Safari may delete this site's copy after 7 days without a visit. Your identity lives at the identity page:
    keep your 12 words or the backup file." (a new key `iosHomeScreenV03`; `test/unit/loader-app-review1.test.mjs:557` pins the old
    text for 0.2.1 mode).
13. **identity, docs/specs/mw-signin-v1.md** (CONF-2, CONF-3, CONF-6), the texts of the findings: section 7 step 1 adds "or a string
    that does not serialise under RFC 8785 (a lone surrogate), checked by building the signing input before step 5", and section 12
    the round-2 change; line 52's nonce cell becomes "`challenge.nonce` for `purpose: 'server'`; for `purpose: 'site'`, always 16
    random bytes from the IdO (a challenge with purpose site is refused, `E_BAD_REQUEST`)" and section 2 says a challenge goes only
    with purpose server; line 174 "382 lines" becomes "386 lines" (`wc -l packages/verify/verify.js`). Tests as the findings give.
14. **integrator, docs/DEMO-RESULTS.md G13** (GATE-2): step 3 becomes "Focus the tab (or wait a minute), then reload B: ..."; step 4
    becomes "Choose "Forget this site" in Settings, reload, and choose "Confirm new key": version 2 renders. A kept key stays refused
    until Forget this site."
15. **media** (HON-13, optional): the open path of a private photo or video keeps it on the Echo lane without a card sentence; either
    add "Others can see which files you share." to the card shown when a granted item is opened, or stop the swarm after playback
    unless the person keeps it. The documents now describe the current behaviour.
16. **integrator, docs/review/V03-DESIGN-REVIEW.md** (not a docs-lane file): the STALK status rows (:1324, :1327, :1332) and the
    residual row (:1170) as Request 1; the like figure at :1432 as WHY.md:255; and the R 2.10.3 list (:968) can point to ARCHITECTURE
    15.12 for the prefixes added in the build.
