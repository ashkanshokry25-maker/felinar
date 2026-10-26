# Review round R 5.3: integration (integrator, 2026-10-24)

Written by the integrator of the review round of [review/V03-DESIGN-REVIEW.md](../review/V03-DESIGN-REVIEW.md), section 5.3,
on 2026-10-24 between 05:05 and 07:20 ET (times from `TZ=America/Toronto date`). Inputs read first: R Part 1 and 5.3,
[INTEGRATION-STATUS.md](../INTEGRATION-STATUS.md), [integration-v03.md](integration-v03.md), the ten fixer notes
(review-round-chain, -identity, -chat, -tools, -media, -docs, -examples, -tests, -loader-pointer, -loader-ui) and the six lane
notes ([firefox.md](firefox.md), [a11y.md](a11y.md), [rows-identity.md](rows-identity.md), [rows-chat.md](rows-chat.md),
[rows-media.md](rows-media.md), [rows-social.md](rows-social.md)). Files this integrator owns: `src/`, `tools/`, `test/`,
`examples/`, `packages/`, `package.json`, the lock files, [INTEGRATION-STATUS.md](../INTEGRATION-STATUS.md) and this note. No name
or brand string was changed (the rename lane ran at the same time; where its edits met mine, see "Shared files"). Nothing was
pushed, tagged or published.

## 1. Lane defects applied

| Lane, defect | Fix (file:line) | Test | Result |
|---|---|---|---|
| firefox: E-CL-1F hang-up step reads a closed connection's descriptions | `test/e2e/scenarios-calls.mjs:394` (the reads in `try`); `FIREFOX_HELD` is empty (`test/e2e/scenarios-firefox.mjs:25`) | `--only E-CL-1F` | PASS in Firefox 157.0 (connected 1,452 ms after the accept, screen shared) |
| firefox: `pressCard` 3,000 ms click timeout | `test/e2e/idp-driver.mjs:57` (15,000 ms) | `MW_E2E_FIREFOX_TRY=... --only F:E-ID-2,F:E-ID-2B,F:E-ID-4,F:E-SO-1,F:E-SO-2,F:E-SO-11` | F:E-ID-2, F:E-ID-2B, F:E-ID-4, F:E-SO-1, F:E-SO-11 pass and are added to `FIREFOX_CONTEXT_SOURCES` (`scenarios-firefox.mjs:40`); F:E-SO-2 fails at "Follow by link" (`locator.click` 30 s), left out |
| firefox: no poster in Firefox (F:E-MD-1) | cause found: Firefox 157.0 plays a Blob made of parts (the stripped, fast-started upload) but never finishes a seek in it; a flat copy seeks at once. `src/media/poster.js:28` (`SEEK_TIMEOUT_MS` 3 s), `:126` (`videoPosterOnce`; on a stuck seek, one retry from a flat copy up to 128 MiB, else the decoded frame) | unit `media-strip.test.mjs` (a parted Blob that never seeks: one retry from a flat copy, seek to a tenth); `--only F:E-CH-6M,F:E-MD-1` | F:E-MD-1 passes in Firefox; `E-MD-1` added to `FIREFOX_CONTEXT_SOURCES` |
| firefox: E-SO-3 to E-SO-9 reuse pages E-HD-1 closed | `test/e2e/scenarios-social-rows.mjs:47` (`adaBo` makes ADA and BO again when their browser context was closed, not when only their pages were, which E-SO-9 does on purpose); `cyOf` likewise | `--only E-SO-1,E-SO-2,E-HD-1,E-SO-3` | E-SO-3 passes after E-HD-1 |
| rows-media D-1: `--approve` on a running pin node waits for a restart | `tools/pin.mjs:1413` (`startMissing`: each status tick starts pinned files the page does not hold) | e2e E-MD-6 | E-MD-6: "the running node started it" (no restart branch) |
| rows-media D-2: a restarted pin never seeds with nobody else online | `src/loader/pinwire.js:601` (`torrentFiles`: the item's .torrent kept beside its bytes and passed as `torrentFile` on start, checked against the infohash by `addFileTorrent`); wired at `src/loader/app.js:4523` (`pin-torrent-<ih>` in the profile's IndexedDB) | unit `torrent-seed-lanes.test.mjs` (kept, reused, a wrong copy falls back); e2e E-MD-6 | E-MD-6: "it played (206, readyState 4) from the pin's run 2"; no "OPEN D-2" |
| rows-social D-1: a page whose ledger opens after the lane is never held | `src/loader/app.js:3841` (`holdOwnLedger`, called from the lane, the ledger opening and the sign-in), with chain request 4 (STALK-3): only the signed-in key's own page is held in full | e2e E-SO-2 | the lane state on a miss shows ADA's ledger held and followed by BO (section 4, item 9); E-SO-9B stays named-only |
| rows-social D-2 (stranger join request refused) and D-3 (two short-id formats) | not applied | | section 3 |
| rows-chat: E-CH-7 control and E-CH-10 warm-up | fixed by the lane in its own file (the route wait) | | pass |
| a11y: violations to fix | none: the lane found 0 violations on 60 screens and `test/e2e/scenarios-a11y.mjs` has no allow-list, so nothing was removed | | |

## 2. Fixer requests applied

| Request | Change (file:line) | Test |
|---|---|---|
| tests 2, tools R-LAYOUT: `SECURITY-KEY.asc` | `test/unit/repo-layout.test.mjs:21` lists it | repo-layout passes |
| chain 1, tests 1: hub-moderator-gaps todos | the ten `{ todo }` options removed | 13 of 13 pass |
| chain 3 and 4 (STALK-3): private follows; hold only one's own page | `mw.hub.follow(target, { private })`: `src/loader/api.js:196`, `src/sdk/sdk.js:66` (`['target', 'opts']`), `src/loader/personal-site.js:341` (passed to `multi.follow`, kept in the prefs, restored), `examples/social/js/hub.js:126`, `examples/social/js/data.js:357` (a follow the person keeps private); hold: `src/loader/app.js:3841` | unit `sdk-v03-personal.test.mjs` (private reaches the lane, survives a visit, a public follow made private) |
| chain 7 (DS-10): the newest window decides truncation | `src/chain/recent.js:330` | unit `hub-lane-recent.test.mjs` |
| chain 10: the consensual self rotation | | unit `tools-v03-ledger.test.mjs` (`--next-key` carries `nsig`, the key change is linked) |
| chain 2 (HUB-5, loader side, in part): a planted recovery commitment | `src/loader/api.js:1018` (`rotationBlocker`), `src/loader/app.js:3579` (the retry stops and a warning banner says so), `src/loader/strings.js:135` (`rotationBlocked`) | unit `sdk-v03-wiring.test.mjs` |
| chat R1 (UX-6, UX-7, UX-8, UX-20): the chat panel | `src/widget/chat-panel.js:120` (name and short id, never "?"), `:164` (typed line and focus kept), `:216` (a form: Enter sends), `:262` (own room line), tabs with `role="tab"`; `src/loader/strings.js:704` (`chatYou`) | unit `widget-chat-panel.test.mjs`; e2e E-CH-R asserts no "?:" line |
| chat R2, R4, R5 (PRIV-2, STALK-2, UX-14): the CK only with a reason; chat resumes after a reload | `src/loader/api.js:2156` (`ckShare: 'reason'`, `chat.resume()` on sign-in); the calls fixture (`test/fixtures/calls/peers.mjs:201`: contacts first, a non-contact's key handed over as a ledger copy would) and the chat lab (`test/e2e/scenarios-chat-rows.mjs:420`, `ckShare: 'reason'`, contacts first) | unit calls and chat suites; e2e E-CH-1, E-CH-8, E-CH-6, E-CH-R, E-SI-1W, E-CL-1, E-CL-2, E-CL-3, E-CH-2, E-CH-3, E-CH-10, E-CH-12 |
| chat R7 (STALK-12): listing time | `src/files/lane.js:612` (the minute) | unit `media-review-round.test.mjs` |
| chat R8 (STALK-9, tools part) | `tools/ledger-admin.mjs` help and comment: `introduced` takes no message requests in 0.3.0 | |
| docs 5: `tools/init.mjs` prompts | `tools/init.mjs:240`, `:366` | |
| docs 6, tools R-SCALE-15 (SCALE-9, SCALE-15): pin capacity flags | `tools/pin.mjs:1601` (`--max-total`, `--mailbox-bytes`, `--mailbox-source-fraction`), `:1607` (`pinCapacity`), passed to `runPin` and `runModeration` | unit `tools-v03-pin.test.mjs` |
| docs 9, 10 (HON-9, HON-5, HON-7): example texts | `examples/social/js/views/settings.js:228`, `examples/peer-guestbook/about.html:68`, `members.html:65` | `npm run test:example` |
| docs 11, loader-pointer 10 (CONF-1): `<mw-chat-panel>` attributes | `src/widget/chat-panel.js` usage comment; `tools/publish.mjs:720` prints `<mw-chat-panel></mw-chat-panel>`; `examples/existing-site-dropin/with-widgets/index.html:28` and its README; `test/example/dropin-widgets.test.mjs` | `tools-v03-publish`, `npm run test:example` |
| docs 12: the upload note and the iOS hint | already in the tree (`src/loader/app.js` `pinKeyOf`, `iosHomeScreenV03`) | |
| examples 1 (SYB-12): notice sender | `examples/social/js/data.js:424` as the fixer wrote it | `social-notice-sender.test.mjs` 7 of 7, no todo |
| identity 1 (UX-5): `countPostsBy` null when unsynced | `src/loader/api.js:2092` | unit `sdk-v03-wiring.test.mjs` |
| identity 2 (PHISH-1, HUB-3): `--hub-template` | `tools/build-idp.mjs:44` (flag, part of the build id, `MW_HUB_TEMPLATES`) | unit `idp-protocol.test.mjs` |
| identity 3 (PRIV-4): drop-in example referrer | `examples/existing-site-dropin/_headers:4` (`no-referrer`) | |
| identity 7 (UX-12): `HUB_IDENTITY` | `examples/social/js/strings.js:66` | |
| identity 14 (SUP-7): the identity origin's packages | `tools/build-idp.mjs:120` (`checkIdpPackages`: metafiles of the three bundles against `build.lock.json`; today none) | unit `idp-protocol.test.mjs` |
| loader-pointer 5 (GATE-1, PHISH-7, PTR-1, PTR-12, PTR-14): strings | `src/loader/strings.js:135` and on (`keyChangedReview`, `rotationPending`, `lineageUnproven`), `:183` (the withdrawal reason quoted as the publisher's), `:1059` (door texts, English and French); `test/e2e/scenarios-formats.mjs:103` | strings suites; e2e FMT-WITHDRAW |
| loader-pointer 7 (PTR-5): `--prev-key` | `tools/publish.mjs:1476` (two notes: the 24 h wait after each publish that signs `rot=` again; a `--prev-key` that is not the genesis key) | |
| loader-pointer 9 (SYB-18): `_mw.cfg` from a moderator | `src/loader/api.js:575` (`OWNER_ONLY_CFG`, `narrowNonOwnerCfg`: such an entry turns features off, never on) | unit `sdk-v03-wiring.test.mjs` |
| loader-ui R1 (UX-10): sign-in cooldown | `src/widget/signin.js:79` (a block or a cancel does not start it; a second block says to open the page in a browser) | unit `widget-signin.test.mjs` |
| loader-ui R2, R3 (SCALE-6): the hub lane's own swarm kind | `src/loader/app.js:3821` (`kind: 'hub'`, `wanted`, `syncing`; `joinHubLane` at `:3812`), `src/chain/multi.js:375` (`syncing`) | unit `hub-lane-multi.test.mjs` |
| loader-ui R6 (MAL53-6): `expectedLength` | `src/files/lane.js:221`, `src/media/lane.js:149` | unit `media-review-round.test.mjs` |
| loader-ui R8 (MAL53-10): offer and grant caps | `src/media/service.js:117` (3 open offers per sender, 20 in all, `offersDropped`), `src/files/lane.js:60`, `:804` (20 pending grants per sender, 200 in all, `grantsDropped`) | unit `media-service.test.mjs`, `media-review-round.test.mjs` |
| loader-ui R9 (MAL53-1, blocker): the tool's acceptance bound to the author | `tools/ledger-admin.mjs:813` (`listedKey(ih, author)`), `:834` (`acceptListing` reads the single lister or asks for `--author`; value `{ by, t, ih, author }`), CLI `listed --author` | unit `tools-v03-ledger.test.mjs` (a second key's re-listing stays queued), `review-round-loader-ui.test.mjs` |
| loader-ui R11, R12, R13 (UX-11): error sentences | `src/loader/api.js:238` (every code maps to itself); `examples/peer-guestbook/js/common.js`, `js/app.js`, `examples/social/js/strings.js` copy the loader's sentences | `npm run test:example` |
| media R2 (PRIV-5): unchecked file kinds | `src/loader/api.js:761`, `src/loader/ui.js` (upload card), `src/loader/strings.js:689` (English and French) | unit `ui-v03-cards.test.mjs` |
| media R3 (SCALE-13): files budget | `src/loader/api.js:2213` (the ledger's bytes and, when the loader passes them, the site copy's) | |
| media R4 (MAL53-3, page side): a denied item is never pinned | `src/loader/pinwire.js:652` (`'denied'`; the extra wave moved it from :614 and added the sweep that leaves a held item on a later deny, :626-:637), wired at `src/loader/app.js` (`denyChecker`, `discard`) | unit `torrent-seed-lanes.test.mjs`, `pinwire.test.mjs` |
| media R5 (DS-4): hand-off evidence | `src/loader/torrent.js:2221` (bytes sent per holder wire), `:2274` (`_copies({ served })`), `:2437` (`_handoffCheck` counts only peers that got the whole item from this device) | unit `torrent-seed-lanes.test.mjs` (two have-all claims end nothing) |
| tools R-SUP-11 (package.json part) | `package.json:46` (`engines.npm >=11.19`), `:91` (`allowScripts` false for five packages); the root `engines` of both lock files | the todo stays until `.npmrc` and the workflows change (not this integrator's) |

## 3. Requests not applied, with the reason

| Request | Reason |
|---|---|
| chain 5 (SCALE-11): meter `mw_chain2` egress | a seed-budget design change across `torrent.js` and `multi.js`; left open |
| chain 6 (DS-2): checkpoint distribution | a wire change (a frame carrying `S`) or a prune delay; an owner or format decision; open |
| chain 8 (MP-12), chain 7 second half, media R1 (`filesOk` length) | minor or optional defence in depth; open |
| chain 9, 11 (docs) and docs 1 to 4, 7, 8, 13, 14, 16; identity 4, 6, 11, 15; loader-pointer 4, 6; loader-ui R5, R10 | files of the docs lane or other owners |
| chat R3 (PRIV-3): SDP sanitising on tracker peers | needs a seam in `bittorrent-tracker`'s peer creation that the fixer did not confirm; open |
| chat R6 (docs), R8 vault seam, R9 (`T_SKEW_MS`), R10 vectors | docs, a design item, a choice the calls owner makes, optional |
| identity 5 (SCALE-5 warning wiring), 8 (PTR-10), 9 (PHISH-1 `createPage`), 10, 12 (PRIV-7 `signInOpens`), 13 (SUP-6 `check-site --idp`) | 8 and 9 change who chooses the identity origin on hubs and E-SO-1 depends on today's rule; 12 is the string the rename lane was editing; 5, 10, 13 are new features; open |
| loader-pointer 1 (PTR-6 drop-in), 2 (PTR-8 trackers and signed web seeds), 3 (PHISH-7 acknowledgement), 8 (SYB-11) | PTR-8's tracker rule would drop the loopback `ws://` trackers the harness needs (a development exception must come first); PTR-6 and PHISH-7 are changes on both sides of a protocol; SYB-11 a ROADMAP item; open |
| loader-ui R4 (SCALE-7 persistent follows), R7 (French boot texts) | a new store; `boot.js` texts; open |
| rows-social D-2, D-3, C-1, C-2 | the join path for strangers (with the CK policy above a stranger cannot reach a moderator at all), one short-id format and two missing clauses are owner or design decisions; open |
| tools R-SUP-* except the `package.json` part, R-BIN | `.github/`, `.npmrc`, `docs/` and `bin/` are not this integrator's |
| tools R-SCALE-2-E2E (review-round-tools.md:137 to :140): an allow-list tracker option in `test/e2e/lib.mjs` | not applied: `test/e2e/lib.mjs` has no `MW_E2E_TRACKER` option, so E-FI-1, E-MD-4 and E-SO-2 still run on the open loopback tracker; the tracker side is unit-tested (`test/unit/tools-tracker.test.mjs:230` and on); open (added by verifier round 1's reconcile step, 2026-10-24) |
| tools R-MAL53-8 (review-round-tools.md:146 to :149): validate and quarantine the pin page host's torrent | not applied: the tools fixer marked it deferred, an outline only (MAL53-8 is rejected as deferred in R 5.4.4); open |
| docs 15 (review-round-docs.md:142 to :144, HON-13, optional): a card sentence or stopping the swarm after a private item is played | not applied: optional, and a media design choice; the documents describe the current behaviour; open |
| "Requests" item 3 (below): pin capacity flags, `--approve` on a running node, the kept .torrent | applied by the docs fixer after verifier round 3 (2026-10-24, about 11:00 ET): `docs/recipes/hub-pin.md:4` to `:8`, `docs/OPERATIONS.md:873` to `:878`; the "code constant" wording also corrected at `docs/FAQ.md:474` and `docs/SECURITY-MODEL.md:407`; closed |
| "Requests" item 4 (below): `mw.hub.follow(target, { private: true })`, `ERROR_STRING_KEYS`, PRIV-2 | applied by the docs fixer after verifier round 3: `docs/SDK.md:221`, `:603` to `:608` (private follow), `:1002` to `:1004` (`ERROR_STRING_KEYS`); `docs/INTERFACES.md:1173`, `:1836` to `:1840`; `docs/PRIVACY.md:432` (the chat key only with a reason); `docs/THREAT-MODEL.md:63` already carried it (verifier round 2); closed |
| "Requests" item 5 (below) and loader-ui R10: `ledger-admin listed --ih <ih> [--author <key>]` | applied by the docs fixer after verifier round 3: `docs/OPERATIONS.md:784` to `:788` (the request's `:717` had moved), `docs/INTERFACES.md:1781` to `:1786`, `docs/ARCHITECTURE.md:1959` to `:1962` and `:2099`; closed |

## 4. Defects found by this integration

1. `snapshot (cs=) refused` on loopback: the loader-pointer fixer's PTR-8 check (`src/loader/app.js` `fetchSnapshot`) refused every
   `cs=` that is not this origin or public https, so on the e2e hub (`<label>.localhost` reading `localhost`) E-SO-6 and E-SO-7
   failed. A page on a loopback host may now read a loopback `cs=` (`loopbackPair`, `src/loader/app.js:2757`); a page on a public
   host still cannot. Unit `review-round-loader-pointer.test.mjs`.
2. Two e2e runs started in the same millisecond shared a run directory and the second refused to overwrite `owner.jwk`; the
   brief's three concurrent suites hit it at once. `test/e2e/lib.mjs:188` adds the process id and random characters.
3. E-CL-3 under the CK policy: a caller who is not the callee's contact never learns the callee's chat key, so `calls.start` stays
   `E_PEER_UNREACHABLE`; the step now accepts that or a ring that never arrives (`test/e2e/scenarios-calls.mjs:530`), and waits for
   the keys after the callee adds the caller.
4. CONF-1 cascaded into the drop-in example (`stage()` filled attributes the panel never read); the page, its README and the
   tests now carry the bare element.
5. A WebKit run of `npm run test:browser` once read `module: undefined` in the door view (`loader-doors-browser.test.mjs:51`);
   the rerun passed 41 of 41 (1 skipped). Seen once, not fixed.
6. The author-bound `acceptListing` (MAL53-1) refused the e2e scenarios' offline acceptances, which pass the host's snapshot (it
   does not hold the listing): E-FI-1, E-FI-5, E-FI-6 and E-PS-3 failed in all three first runs with "no listing of <ih> in
   this ledger file". The scenarios now name the author (`scenarios-members.mjs:305`, `scenarios-c2.mjs:437`,
   `scenarios-media-rows.mjs:453`, `:539`), as an operator does with `--author`.
7. The 20-minute watchdog of `test/e2e/run.mjs` stopped the first concurrent Chromium and WebKit runs at 1,200 s (the default
   run grew from 72 scenarios on 2026-10-21 to 102); it is 45 minutes now, 60 with `--firefox` (`test/e2e/run.mjs:108`).
8. E-CH-11 asserted that the relay's capture held decrypted CK frames; under the CK policy a relay that is nobody's contact gets
   none, so the proof that the capture reads the decrypted layer is now a parsed WANT-TAGS frame or a CK
   (`scenarios-chat-rows.mjs:578`). E-CH-9, E-CH-11, E-CH-4, E-CH-5 and E-CH-7, which failed under the load of the first
   concurrent runs, passed 5 of 5 alone (84.3 s).
9. E-SO-2 (an intermittent the chain fixer reported, request 11): the step now prints both tabs' hub lane state on a miss. In the
   first concurrent runs ADA held her ledger and BO followed it, and neither tab had a single lane wire in 45 s (`attached` 0,
   `peers` []), so the miss is in the lane swarm's connection (tracker or WebRTC under load), not in what is held or followed.
   It passed alone and in the first Firefox run. Not fixed.

## 5. Scenario registration

`test/e2e/run.mjs` imports each of the 17 `scenarios-*.mjs` files and `peer-scenarios.mjs` exactly once (four of them through the
splice before scenario 13), no scenario id is defined twice (86 `S['...']` definitions, no duplicate), and `--firefox` adds the
F-* and F:<id> scenarios with a 30-minute watchdog; `FIREFOX_HELD` is empty.

## 6. Suites

Times ET, 2026-10-24. Every e2e run ended with "PASS network policy: every request stayed on 127.0.0.1".

| Suite | Result |
|---|---|
| before (05:06) `npm test` | 2,266 tests, 2,246 pass, 1 fail (repo-layout), 19 todo |
| `npm test` | lint floor clean (147 files); 2,281 tests, 2,272 pass, 0 fail, 9 todo (06:01 and 07:16) |
| `npm run build` | ok (06:01) |
| `node build.mjs --check-lock` | "0 bundled package(s) match build.lock.json" (06:01, 07:17) |
| `npm run test:browser` | 42 tests: 40 pass, 1 fail (WebKit door view, `module: undefined`), 1 skipped; again: 41 pass, 1 skipped |
| `npm run test:example` | 183 of 186 (06:02), 186 of 186 after the CONF-1 and `E_NO_HOST` fixes |
| `npm run test:fuzz` | "PASS: 30000 inputs in 6.3 s, 0 violation(s), 6 note(s), seed 836161467" |
| `npm run build:idp` | ok, build id 6af6d1206fef; npm packages in the bundles: none |
| e2e round 1, concurrent (06:05) | Chromium and WebKit stopped by the 1,200 s watchdog; Firefox 129 of 140 in 1,499.9 s |
| e2e round 2, concurrent (06:30): `npm run test:e2e` | Chromium 156.0.8078.4: 101 of 102, 1,213.7 s; E-SO-9 failed |
| `npm run test:e2e:webkit` | 106 of 107 (WebKit 27.2), 1,252.9 s; E-SO-7 failed |
| `npm run test:e2e:firefox` | 137 of 140 (Firefox 157.0), 1,454.9 s; E-MD-6, E-CH-5, E-SO-9 failed |
| alone (`--only`) | E-SO-7 pass (128.4 s), E-MD-6 pass (108.4 s), E-CH-5 pass (20.5 s); E-SO-9 fail (99.9 s, and three diagnostic runs) |

Per browser after the alone reruns: Chromium 101 of 102, WebKit 107 of 107, Firefox 139 of 140. E-SO-9 is open: ADA's post written
offline is in the app's data but the timeline shows "1 new post" instead of it; it passed in the WebKit run and at 05:48 after E-SO-3 to
E-SO-8. Its failure probe now also prints the "new posts" box (`scenarios-social-rows.mjs`).

## Shared files

`src/loader/strings.js`, `package.json`, the lock files, `examples/social/js/strings.js`, `test/e2e/run.mjs` and several
others were edited by the rename lane while this integrator worked; every edit here was a minimal replacement made on the file
as it stood at that moment, and no brand string was touched. `examples/social/js/strings.js` `E_NO_HOST` now uses the loader's
sentence as the rename lane left it.

## Requests

For the docs lane (exact edits; none of these files is this integrator's):

1. `docs/deviations/integration-v03.md` R 4.2: E-MD-6 becomes `| E-MD-6 | pass | E-MD-6 | ... a restarted pin plays the kept
   grant with nobody else online; an --approve on a running node is started within one status tick (rows-media D-1 and D-2 fixed
   by the R 5.3 integrator) |`; then recount the "In all" line and this repo's INTEGRATION-STATUS sentence together (the test
   `docs-claims` reads both).
2. `docs/DEMO-RESULTS.md` (the sentence above the v0.3 table) and `docs/deviations/integration-v03.md:397`: Firefox launches in the
   harness (31 scenarios on 2026-10-22, more since); a real-device row still never passes from the harness (firefox.md Requests).
3. `docs/recipes/hub-pin.md:4-5` and `docs/OPERATIONS.md`: `--max-total`, `--mailbox-bytes`, `--mailbox-source-fraction` exist;
   `--approve` on a running node is started within one status tick; the pin keeps each item's .torrent in its profile.
4. `docs/SDK.md` and INTERFACES: `mw.hub.follow(target, { private: true })` (STALK-3); `ERROR_STRING_KEYS` maps every code to
   itself; PRIVACY and THREAT-MODEL: the loader now sends its chat key only with a reason (PRIV-2: a contact, a key it looks for,
   open requests, public presence), so a neighbour that is none of these does not learn the site key from chat.
5. `docs/OPERATIONS.md:717` (and R10 of review-round-loader-ui): `ledger-admin listed --ih <ih> [--author <key>]` writes the
   author-bound key; with two listers it asks for `--author`.
6. CHANGELOG: the changes of sections 1, 2 and 4.
7. For the owner: rows-social D-2 (a stranger's join request) and D-3 (one short-id format), DS-2, PTR-8's development exception
   for trackers, and F:E-SO-2's "Follow by link" click in Firefox.

## After verifier round 1 (2026-10-24)

Section 4 item 9 and the open E-SO-9 of section 6 were closed by the social fixer after verifier round 1. E-SO-2's miss was a
consent race, not load: a hub lane joined while the consent card was open found no peers and never started, because
`TorrentManager._onConsentChange` rebuilt nothing when a client with peers already existed (`src/loader/torrent.js:3628` to
`:3637`; test `test/unit/social-fixer-hub-lane.test.mjs`). E-SO-9's "1 new post" came from the social app's timeline keeping
its old top when the offline write resolved before the data layer's change (`examples/social/js/model.js:286` to `:296`
`timelineTop`, used at `examples/social/js/views/timeline.js:77`). The record, with the suites, is
[review-round-verify-1.md](review-round-verify-1.md).

## After verifier round 2 (2026-10-24)

The D-1 row of section 1 said E-SO-9B stays named-only; it still does, and it now passes. With D-1 fixed, what kept it failing
was the harness: the offline reload of E-SO-9 signs ADA out (the plan's "Stay signed in" is off, `test/e2e/idp-driver.mjs:9`,
`:72`; the loader restores only a stay-signed-in key, `src/loader/app.js:3393` to `:3394`), and a signed-out page holds nothing
on the hub lane (`holdOwnLedger`, `:3841`; holding after a sign-in, `:3554`). ADA now signs in again once online
(`test/e2e/scenarios-social-rows.mjs:597` to `:615`). The hub lane still joins with kind `'hub'` (`src/loader/app.js:3821`, the
attach passing `lane.kind` at `:3826`). The record, with the suites, is [review-round-verify-2.md](review-round-verify-2.md).
Requests for the integrator or the owner that this round raised: (a) E-SO-5 needs either a way to sign each seeder in with a
synthetic owner's key (the tools make those pages with raw key pairs, `test/e2e/hub-stack.mjs:126` to `:168`, and the identity
origin issues passphrase identities only) or a product rule for holding pages one opens or follows, which reverses part of
STALK-3's privacy choice; (b) whether E-SO-9B joins the default `SOCIAL_ROWS_ORDER` (`test/e2e/scenarios-social-rows.mjs:34`),
which would change the full suites' scenario counts in RUNBOOK, CRITIQUE, the checklist and INTEGRATION-STATUS.

## After verifier round 3 (2026-10-24)

Requests 3, 4 and 5 above were applied to the documents by the docs fixer after verifier round 3; section 3 lists each with
its file and lines. The record, with the checks and the suites to re-run, is [review-round-verify-3.md](review-round-verify-3.md).
