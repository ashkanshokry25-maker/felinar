# Integration status (integration-1, integration-2: v0.2; harden-verify: v0.2.1; code review round 1; v0.3 build, reconciliation and final integration; v0.3 C2; v0.3 code review round 2; review round R 5.3; independence round)

Living document: updated after every milestone so the next integrator can resume. Newest first.

**Release status (2026-10-24):** the tree is 0.3.0, the release being prepared and the first public one (0.2.1 was never
published: [PUBLISH-CHECKLIST.md](PUBLISH-CHECKLIST.md), section 0). It runs the v0.3 and C2 code. The review round of the v0.3
design review (R 5.3) ran from 2026-10-22 to 2026-10-24; the independence round of 2026-10-25 (the project holds no domain and
runs no service) is the newest section below, with the latest counts; the release gate on real devices
([DEMO-RESULTS.md](DEMO-RESULTS.md)) has not run.

## Independence round (2026-10-25)

- **Publish preparation runs (2026-10-26, 11:17 to 11:51 ET), on the tree after checklist steps 2, 3, 3b and 3c (OWNER placeholders,
  changelog dated, release key pinned, npm sentences) and the test update for the pinned key (`docs/deviations/independence-integration.md`,
  section 5). Logs: `.orchestration/logs/publish/`.** `npm test`: 2,314 tests, 2,305 pass, 0 fail, 1 skipped (the release-notes case of
  IND-6 skips once the changelog is dated), 8 todo; lint floor clean. Build 976caba51866, lock check clean; identity build 9d6a24e3eb7f.
  Browser 41 pass, 1 skipped; example 186 of 186; fuzz 30,000 inputs, 0 violations. The three full end-to-end suites at once:
  Chromium 100 of 102 (E-CL-1 at 409 s, E-CH-5 at 934 s), WebKit 105 of 107 (E-CL-1 at 407 s, E-MD-6 at 675 s), Firefox 139 of 140
  (E-MD-6 at 934 s); alone: E-CL-1 and E-MD-6 pass in every engine, E-CH-5 passes 3 of 3 by itself but missed once when it ran right
  after E-CL-1 in one `--only` run (a harness order effect, not seen in the suites' own order). Totals after the alone reruns:
  Chromium 102 of 102, WebKit 107 of 107, Firefox 140 of 140. The door rows pass in all three engines with the updated
  `tools/publish.mjs` and `tools/ship.mjs`. Every run ended with the loopback network policy line. Step 4b: all 8 action pins match
  their tags.

Integrator, 2026-10-25 09:55 to 10:40 ET, after the three fixers (code: IND-10 to IND-12; release documents: IND-2 to IND-6;
design documents: IND-1, IND-7 to IND-9 and SZ-3), answering the owner's request of 2026-10-25 to make the project domain
independent. Records: [deviations/independence-code.md](deviations/independence-code.md),
[deviations/independence-release-docs.md](deviations/independence-release-docs.md),
[deviations/independence-design-docs.md](deviations/independence-design-docs.md) and, for the integration (the fixers' requests
applied, what is open, log paths), [deviations/independence-integration.md](deviations/independence-integration.md).

- **Independence round, 2026-10-25: suites on the integrated tree** (logs in `.orchestration/logs/independence/`, not
  tracked; the clone and the end-to-end runs were on checkpoint `0507946` of 10:01 ET, which holds every code and test change
  of the round; only documents changed after it). Every end-to-end run ended "PASS network policy: every request stayed on
  127.0.0.1".
  - `npm test`, 10:00:00 to 10:00:28: lint floor "147 files, no APIs or syntax past the browser floor"; 2,314 tests, 2,306 pass,
    0 fail, 8 todo (the SUP-3 todo now passes and lost its todo flag). Exit 0.
  - `npm run build` exit 0, build 976caba51866 (`dist/build.json`); `node build.mjs --check-lock` exit 0 (the vendored bundle
    and its five patches match `build.lock.json`).
  - `npm run test:browser`, 10:00:49 to 10:01:00: 42 tests, 40 pass, 1 fail, 1 skipped; the failure was the door view in WebKit
    (`test/unit/loader-doors-browser.test.mjs:51`: `module` undefined where 42 was expected, read as soon as the frame said it
    rendered). Alone 3 of 3 (10:01 ET) and the whole suite again, 10:01:57 to 10:02:08: 42 tests, 41 pass, 0 fail, 1 skipped
    (the v0.1 worker test). No file of the door view changed in this round; the intermittent read is open.
  - `npm run test:example`, 10:01:00 to 10:01:32: 186 tests, 186 pass.
  - `npm run test:fuzz`, 10:02:18 to 10:02:25: "PASS: 30000 inputs in 6.4 s, 0 violation(s), 6 note(s), seed 936938904".
  - `npm run build:idp` exit 0: build id 9d6a24e3eb7f, bundle sha256 67a742cd3a0df066... (the build id of 2026-10-24).
  - `npm pack --dry-run` exit 0: `felinar-0.3.0.tgz`, 182 files, 1.3 MB packed, 4.6 MB unpacked.
  - Fresh clone (section 6 of [PUBLISH-CHECKLIST.md](PUBLISH-CHECKLIST.md)), 10:02:59 to 10:03:31, `git clone` of checkpoint
    `0507946` into an empty folder outside the tree: `npm ci --prefer-offline` added 227 packages; `npm test` 2,314 tests, 2,306
    pass, 0 fail, 8 todo; `npm run build` exit 0 with the same build id 976caba51866. On the clone, the project-domain search
    `git grep -n -I -i -P 'felinar\.(dev|app|ca|io|com|org|net)\b'` printed nothing and `node tools/build-idp.mjs` gave build id
    9d6a24e3eb7f with no host input. The clone was removed.
  - The three full end-to-end suites at the same time, 10:03:49 to 10:27:55: `npm run test:e2e` (Chromium 156.0.8078.4)
    "OK: 102 passed, 0 failed, total 1189.6s"; `npm run test:e2e:webkit` "FAILED: 106 passed, 1 failed, total 1137.4s", E-MD-6
    at 645.9 s at the step "RA and RE, RA and RF: contacts, and a first message gets through": "RA reaches RF: not reached
    within 30000 ms" (the same step and wait it missed under the same load on 2026-10-24); `npm run test:e2e:firefox`
    "OK: 140 passed, 0 failed, total 1445.9s".
  - Alone after them, 10:28:15 to 10:30:03: `node test/e2e/run.mjs --webkit --only E-MD-6` "OK: 1 passed, 0 failed, total
    108.4s".
  - **Per-browser end-to-end totals after the alone rerun: Chromium 102 of 102, WebKit 107 of 107, Firefox 140 of 140.** No
    scenario opens a hosting-platform name (IND-10); the first-visit rows 7 and E-ZS-1 passed in all three runs, W7 in the WebKit
    run and F7 in the Firefox run.
  - The open rows of the R 4.2 table are unchanged (E-SO-5, E-FI-4, E-SO-10, E-SO-13; see the review round below).

## Review round R 5.3 (2026-10-24)

Integrator, 2026-10-24 05:05 to 07:20 ET, after the review round's ten fixers and the six lanes of the finish run. The record,
request by request with file and line: [deviations/review-round-integration.md](deviations/review-round-integration.md).

- **Final full runs (2026-10-24, verifier round 3):** every suite on the final tree (checkpoint `2146ae0` plus the one-line
  comment at `examples/social/js/directory.js:3`, committed by the checkpoint loop as `ad7e6fb` at 17:44), run by the
  orchestrator after the final gate's runner returned early; written here by the counts writer at 18:05 ET. The end-to-end
  numbers are copied from the logs in `.orchestration/logs/final/` (not tracked); the others from the gate runner's record
  (`.orchestration/RUNS.log`, 17:34), which kept no log file.
  - Gate runner, 17:29 to 17:31: `npm test` 2,291 tests, 2,282 pass, 0 fail, 9 todo, lint floor clean; `npm run build` exit 0,
    build a40b9601949c (`dist/build.json`); `node build.mjs --check-lock` exit 0; `npm run test:browser` 42 tests, 41 pass,
    1 skipped (the v0.1 worker test); `npm run test:example` 186 of 186; `npm run test:fuzz` 30,000 inputs, 0 violations,
    6 notes, seed 877495839; `npm run build:idp` ok, build id 9d6a24e3eb7f.
  - The three full end-to-end suites at the same time, 17:33 to 17:58, each ending "PASS network policy: every request stayed
    on 127.0.0.1": `npm run test:e2e` (Chromium 156.0.8078.4) "FAILED: 101 passed, 1 failed, total 1136.9s", E-MD-6 failed at
    656.7 s at the step "RA shares it with RE and RF (the share card) ...": "the offer card at RE: not reached within 30000 ms";
    `npm run test:e2e:webkit` "FAILED: 105 passed, 2 failed, total 1134.6s", E-MD-6 failed at 652.6 s at the step "RA and RE,
    RA and RF: contacts, and a first message gets through": "RA reaches RF: not reached within 30000 ms", and E-CH-5 at
    882.8 s at the step `A writes "m1 before D"; B and C read it`: "m1 at CR5-B: not reached within 20000 ms";
    `npm run test:e2e:firefox` "OK: 140 passed, 0 failed, total 1438.9s".
  - Alone after them, 17:58 to 18:02, each ending with the same network-policy PASS: `node test/e2e/run.mjs --only E-MD-6`
    "OK: 1 passed, 0 failed, total 108.3s"; `node test/e2e/run.mjs --only E-MD-6,E-CH-5` "OK: 2 passed, 0 failed, total
    128.9s" (E-MD-6 108.0 s, E-CH-5 20.5 s). Both scenarios run in a Chromium context in every suite (`--webkit` only adds the
    W scenarios), so the rerun without `--webkit` is the context they failed in.
  - Failed in a concurrent run and passed alone: E-MD-6 (the Chromium and the WebKit run) and E-CH-5 (the WebKit run); each
    missed a 30 s or 20 s wait with three suites on one machine. E-SO-9 passed in all three runs.
  - **Per-browser end-to-end totals after the alone reruns: Chromium 102 of 102, WebKit 107 of 107, Firefox 140 of 140.**
  - Open rows of the R 4.2 table, unchanged (4): E-SO-5 runs only with `--only E-SO-5`, so it was not in these suites; it
    last failed alone (09:23 to 09:26) at "SEED-A opens Synthetic 01 ... held on the hub lane" (role reader, lane held []
    after 40 s: its seeders open the tool-made pages signed out). E-FI-4 (real-device row G-MD-5), E-SO-10
    (`mw.hub.withdrawPage()` does not exist) and E-SO-13 (the directory stays off pending counsel; mock-SDK checks only) do
    not run in the harness, so they have no failing step. E-SO-9B passes 3 of 3 with `--only E-SO-9,E-SO-9B` but is not in
    the default order; F:E-SO-2 is still left out of `--firefox`.
- **Verifier round 2 fixes (2026-10-24, 10:16 to 10:47 ET):** verifier round 2's suites part (10:22 ET) was not ready on three
  end-to-end items: `npm run test:example` 185 of 186 (this file said 186), E-SO-4 passing only with E-SO-3 in the selection, and
  E-SO-5 and E-SO-9B failing; its checks part was not ready on three document lines, closed by hand before the wave (see
  "After verifier round 2" in [deviations/review-round-verify-1.md](deviations/review-round-verify-1.md)). Three fixers, then a
  reconcile step; record, item by item: [deviations/review-round-verify-2.md](deviations/review-round-verify-2.md). No `src/` or
  `examples/` code changed.
  - Social fixer: the example composer test now waits for the textarea to clear (`test/example/social-browser.test.mjs:105` to
    `:108`): since E-SO-9's fix the own post shows from the data layer's change before the write resolves, and the composer clears
    after it (`examples/social/js/views/composer.js:140`; the mock holds the write for `writeDelay`, `test/example/mock-sdk.js:177`).
    E-SO-4 makes E-SO-3's two follows by link when they are missing (`test/e2e/scenarios-social-rows.mjs:238` to `:250`). E-SO-9B:
    the offline reload signs ADA out (the plan's "Stay signed in" is off) and since STALK-3 a signed-out page holds nothing on the
    hub lane, so ADA signs in again once online and the step asserts role `owner` and her ledger held (`:597` to `:615`); it now
    passes, so E-SO-9 counts as written (R 4.2 bullet below). E-SO-5 is still open (its seeders are readers; a decision for the
    integrator or the owner). Suites, each e2e run ending "PASS network policy: every request stayed on 127.0.0.1":
    `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-9` 5 of 5, three runs in a row (10:21 to 10:29:47);
    `--only E-SO-1,E-SO-2,E-SO-4` 3 of 3, three runs (10:29:47 to 10:35); `--only E-SO-9,E-SO-9B` 2 of 2, three runs (10:35:40 to
    10:42); `npm run test:example` 186 of 186 (10:42 to 10:43); `npm test` 2,291 tests, 2,282 pass, 0 fail, 9 todo (10:43).
  - Rename fixer: nothing left to change; the `lightweb` bin alias line of the checklist was already fixed
    (`docs/PUBLISH-CHECKLIST.md:409`, checkpoint `5e2c547`); `git grep -n -i lightweb -- src test` prints only
    `test/unit/cli-bin.test.mjs:86`. Suites: `npm test` 2,291, 2,282 pass, 0 fail, 9 todo (10:22); `npm run build` ok, 21 files,
    build a40b9601949c (10:23).
  - Docs fixer: THREAT-MODEL :62 was already right; :63 lost a repeated clause; RUNBOOK and CRITIQUE name where their counts come
    from. Suites: docs-links 5 of 5; docs-claims and docs-review-round 25 of 25; `npm test` 2,291, 2,282 pass (10:24).
  - Counts the verifier disputed, as they stand now: `npm run test:example` 186 of 186 again (10:43); `npm test` 2,291 tests,
    2,282 pass (the round's 2,290 plus `test/unit/pin-page-discard-wiring.test.mjs`, added by hand at 10:05); the R 4.2 table 48
    as written and 12 in part. The three full end-to-end suites and `npm run test:browser` have not run since these fixes; the
    per-browser totals below are still those of the second concurrent round.
- **Extra wave after verifier round 1 (2026-10-24, 09:39 to 09:44 ET):** two fixers, then a reconcile step for the documents;
  record, item by item: [deviations/review-round-verify-1.md](deviations/review-round-verify-1.md), "Extra items".
  - Scheme fixer: the never-published `web+lightweb:` scheme is `web+felinar:` (`src/common/pointer.js:70`, `FELINAR_SCHEME`;
    `:1179` and `:1180` the prefix patterns) and the door kinds are `felinar-door` (`src/loader/doors.js:47`, `build.mjs:648`) and
    `felinar-doors` (`tools/publish.mjs:1680`); no old form is read. Suites: the unit files `common-pointer`, `loader-doors` and
    `tools-publish-doors` 84 of 84; `npm test` 2,286 tests, 2,277 pass, 0 fail, 9 todo (09:39; a first run a minute earlier failed
    once on `docs/PUBLISH-CHECKLIST.md`, which another fixer was editing); `npm run build` ok, build b33f182a92d1, `dist/_mw/door.json`
    kind `felinar-door`; `node test/e2e/run.mjs --webkit --only DOOR-DOWN,DOOR-HASH,DOOR-GUEST,DOOR-GUEST-W` 4 of 4 and
    `node test/e2e/run.mjs --firefox --only F:DOOR-DOWN,F:DOOR-HASH,F:DOOR-GUEST,DOOR-GUEST-F` 4 of 4 (09:40), each ending "PASS
    network policy: every request stayed on 127.0.0.1".
  - Pin fixer (MAL53-3, pin side): the pin page host leaves an item it already holds when a later `_deny/` entry names it
    (`src/loader/pinwire.js:626` to `:653`, through `status()` at `:687` to `:691`, read every 2 s by `tools/pin.mjs`), and the pin
    node's queue quarantines a denied item in `decide('accept')` and `restore()` (`tools/pin.mjs:465` to `:486`, `:501` to `:515`).
    Left open (review-round-media.md, "Still open after R4"): the node's Node process has no deny check of its own (request R4-b),
    and the heartbeat can list a left item for one `--interval`. The third gap, the left item's bytes in the pin's browser
    profile, was closed by hand by the orchestrator with request R4-a (`discard`, `src/loader/app.js:4527`; its record is the
    section "By hand, before verifier round 2" of the note). Suites: `node --test test/unit/tools-v03-pin.test.mjs
    test/unit/pinwire.test.mjs` 35 of 35; `npm test` 2,290 tests, 2,281 pass, 0 fail, 9 todo (09:44). No end-to-end run.
  - Reconcile step (09:45 to 09:50 ET): THREAT-MODEL MAL A3, ARCHITECTURE's MAL53-3 lines, SECURITY-MODEL, R 5.4.3 and 5.4.7,
    the CHANGELOG and the rename note say what is built and what is left. `node --test test/unit/docs-links.test.mjs` 5 of 5;
    `node --test test/unit/docs-claims.test.mjs test/unit/docs-review-round.test.mjs` 25 of 25; `npm test` 2,290 tests, 2,281
    pass, 0 fail, 9 todo (09:49); pinwire, tools-v03-pin and torrent-seed-lanes 57 of 57. No full end-to-end suite and no
    `npm run test:browser` ran after the extra wave.
- **Verifier round 1 fixes (2026-10-24, 08:28 to 09:30 ET):** four fixers closed what verifier round 1 found, and a reconcile step
  brought the documents in line; record, item by item: [deviations/review-round-verify-1.md](deviations/review-round-verify-1.md).
  - Social fixer: E-SO-2's intermittent miss was a consent race, not load: a hub lane that joined while the consent card was open
    never started, because `TorrentManager._onConsentChange` rebuilt nothing when a client with peers already existed
    (`src/loader/torrent.js:3628` to `:3637`; unit `test/unit/social-fixer-hub-lane.test.mjs`). E-SO-9's "1 new post" came from
    the social app's timeline keeping its old top (`examples/social/js/model.js:286` to `:296`, `timelineTop`). SCALE-6's kind
    `'hub'` is kept. `ensureTorrentManager` is single-flight (`src/loader/app.js:2184`). E-CH-7's control step no longer depends on
    the order of earlier scenarios (`test/e2e/scenarios-chat-rows.mjs:787` to `:803`). Suites, each e2e run ending "PASS network
    policy: every request stayed on 127.0.0.1": `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-9` 5 of 5, three
    runs in a row (09:08 to 09:14); `--only E-CH-7` 3 of 3 (09:15 to 09:16); `--only E-SO-1,E-SO-2` 2 of 2, twice (09:16, 09:18);
    `npm test` 2,286 tests, 2,277 pass, 0 fail, 9 todo (09:20).
  - Binding fixer: a fresh clone (`npm ci` with the tracked `.npmrc` `ignore-scripts=true`, so `node-datachannel` has no binding)
    failed 3 unit files; they now load the WebRTC layer through a stub that throws if used (`test/unit/no-native-webrtc.mjs`).
    Fresh clone `npm test`: 2,281 tests, 2,272 pass, 0 fail, 9 todo (verifier round 1 had 2,267, 2,255 pass, 3 fail).
  - Rename fixer: the last brand strings in `src/` say felinar (passkey `RP_NAME` `src/idp/passkey.js:26`, the risk warning
    `src/files/preview.js:21`, the drop-in console prefix, the SDK errors); `git grep -i lightweb -- src test` shows only the
    compatibility names (the scheme and the door kinds, renamed in the extra wave above). `npm test` 2,281, 2,272 pass, 0 fail, 9 todo (08:30); `npm run build` ok, build 3329978977d3.
  - Docs fixer: the counsel clause on 15 lines, the checklist mailbox line, the stale threat row MAL A3, and the RUNBOOK and
    CRITIQUE counts; `node --test test/unit/docs-links.test.mjs` 5 of 5; `npm test` 2,281, 2,272 pass, 0 fail, 9 todo (08:32).
  - Reconcile step: E-MD-6 counts as written in the R 4.2 table (47 and 13, below); the finding counts in the next bullet and in
    R 5.4.1 to 5.4.7 are corrected; E-SO-5 rerun alone still fails (09:23 to 09:26: since STALK-3 a reader holds no tool-made
    page), and E-SO-9B fails after E-SO-9 passes (09:26 to 09:29: ADA's page is a reader after the offline reload); both with
    the network-policy PASS line. No full Chromium, WebKit or Firefox suite and no `npm run test:browser` ran after these fixes;
    the per-browser totals below are still those of the second concurrent round.

- **The round (R 5.3, 2026-10-22 to 2026-10-24):** 16 reviewers; 203 finding records (199 distinct ids: CONF-1 to CONF-4 have two
  records each), 136 of them serious; 121 confirmed by two refuters, 1 refuted and 14 left unverified when the session limit came
  (`.orchestration/reports/all-findings-2026-10-22.json`, `verdicts-2026-10-23.json`). Six blockers were confirmed: HUB-1, PTR-1,
  PTR-2, PTR-3, MAL53-1 and SCALE-1. The status columns of the ten fixer notes (`deviations/review-round-*.md`, the index table
  of [deviations/review-round.md](deviations/review-round.md)) count 126 fixed, 59 fixed in part and 18 rejected or deferred (203
  records). By distinct id (R 5.4.1): 121 fixed, 62 in part, 15 rejected and 1 refuted at the fix wave; after this integration's
  section 2, 140 fixed, 45 in part, 13 rejected and 1 refuted (R 5.4.1 names the 19 ids that moved).
- **The lanes (2026-10-22):** Firefox ([deviations/firefox.md](deviations/firefox.md)): Playwright Firefox 157.0 runs in the harness on
  loopback (`npm run test:e2e:firefox`); its five defects are fixed here (E-CL-1F's closed-connection reads, the 3,000 ms card click,
  no poster from a Blob made of parts, the social rows reusing pages E-HD-1 closed; the scenario-13 order the lane fixed itself).
  a11y ([deviations/a11y.md](deviations/a11y.md)): axe-core 4.14.0, 0 violations on 60 screens, no allow-list to empty. Identity rows: 7
  of 7 pass. Chat rows: 9 rows, 7 pass and 2 pass in part. Media rows: E-FI-5, E-FI-6, E-MD-3B and E-MD-5R pass; E-MD-6 passes as
  written now that the pin's D-1 and D-2 are fixed here; E-FI-4 stays the real-device row G-MD-5. Social rows: E-SO-3, 4, 7 and 8
  pass, E-SO-6 and E-SO-9 in part, E-SO-5 open.
- **Applied here (section 1 and 2 of the note):** the lanes' defects; from the fixers' requests the hub-moderator-gaps todos, the
  layout entry for `SECURITY-KEY.asc`, SYB-12, MAL53-1 in the tool (`ledger-admin listed` bound to the author), the CK only with a
  reason in the loader (PRIV-2, STALK-2) and chat resuming after a reload (UX-14), private follows and holding only one's own page
  (STALK-3), the hub lane's own swarm kind (SCALE-6), DS-4, DS-10, SYB-18, UX-5, UX-6 to UX-8, UX-10, UX-11, UX-20, PRIV-4, PRIV-5,
  MAL53-3 (page side), MAL53-6, MAL53-10, SCALE-9, SCALE-13, SCALE-15, SUP-7, `--hub-template`, HUB-5 (loader side, in part), PTR-5
  and the loader-pointer strings, with a test for each.
- **Found and fixed by this integration:** a loopback page could not read a loopback `cs=` after PTR-8 (E-SO-6 and E-SO-7 failed);
  two e2e runs started in one millisecond shared a run directory; the 20-minute e2e watchdog stopped the first concurrent Chromium
  and WebKit runs at 1,200 s (now 45 minutes, 60 with `--firefox`); the author-bound acceptance needed the scenarios to name the
  author (E-FI-1, E-FI-5, E-FI-6, E-PS-3); E-CL-3 and E-CH-11 asserted what the CK policy now forbids; CONF-1 reached the drop-in
  example's page and tests.
- **Measured by the chat rows lane** (rows-chat.md, 2026-10-22, one machine, loopback, two runs): six contact DMs under a flood at
  the relay's caps took 1.41 s to 2.90 s (bound 5 s, met once the relay holds the recipient's WANT-TAGS route); a 20-bit stamp took
  147 ms and 502 ms to mint (two Chromium samples).
- **The R 4.2 table** of [deviations/integration-v03.md](deviations/integration-v03.md) counts 64 rows: 60 ran and passed (48 as written,
  12 in part) and 4 open (E-FI-4, E-SO-5, E-SO-10, E-SO-13). E-MD-6 counts as written since the reconcile step of verifier round 1
  (Request 1 of the note; it was 46 and 14 before), and E-SO-9 since verifier round 2, when its second half E-SO-9B passed
  (47 and 13 before).
- **Results (times ET):**
  - `npm test`: the lint floor clean over 147 files; 2,281 tests, 2,272 pass, 0 fail, 9 todo (07:16; the same at 06:01). Before
    the integration (05:06): 2,266 tests, 2,246 pass, 1 fail (repo-layout), 19 todo. The 9 todo wait on `.npmrc`, the workflows and
    `docs/` (tools requests R-SUP-*).
  - `npm run build`: ok (06:01). `node build.mjs --check-lock`: "0 bundled package(s) match build.lock.json" (06:01 and 07:17).
  - `npm run test:browser`: 42 tests, 40 pass, 1 fail, 1 skipped (06:02; the WebKit door view read `module: undefined` once); run
    again, 41 pass, 0 fail, 1 skipped (the v0.1 worker test, skipped by design).
  - `npm run test:example`: 183 of 186 at 06:02 (CONF-1 and the rename lane's `E_NO_HOST`), then 186 of 186 after the fixes.
  - `npm run test:fuzz`: "PASS: 30000 inputs in 6.3 s, 0 violation(s), 6 note(s), seed 836161467".
  - `npm run build:idp`: ok, build id 6af6d1206fef, "npm packages in the bundles, checked against build.lock.json: none".
  - e2e, first concurrent round (from 06:05): Chromium and WebKit were stopped by the watchdog at 1,200 s; Firefox finished, 129 of
    140, 1,499.9 s. The failures were the four listing scenarios (fixed), and E-SO-2, E-SO-3, E-SO-4, E-SO-8, E-SO-9, E-CH-5,
    E-CH-7 and E-CH-11 under the load of three runs; E-CH-9, E-CH-11, E-CH-4, E-CH-5 and E-CH-7 then passed 5 of 5 alone.
  - e2e, second concurrent round (from 06:30), each ending "PASS network policy: every request stayed on 127.0.0.1":
    `npm run test:e2e` (Chromium 156.0.8078.4) 101 of 102 in 1,213.7 s, E-SO-9 failed; `npm run test:e2e:webkit` (adds WebKit 27.2)
    106 of 107 in 1,252.9 s, E-SO-7 failed; `npm run test:e2e:firefox` (adds Firefox 157.0) 137 of 140 in 1,454.9 s, E-MD-6, E-CH-5 and
    E-SO-9 failed.
  - Alone (`--only`), each with "PASS network policy: every request stayed on 127.0.0.1": E-SO-7 passed (128.4 s), E-MD-6 passed
    (108.4 s), E-CH-5 passed (20.5 s). E-SO-9 failed alone too (99.9 s and three diagnostic runs).
- **Scenario totals per browser** (second round): Chromium 102 scenarios; with `--webkit` 107 (the 102 and W7, W-SI, W-MD,
  DOOR-GUEST-W, E-CL-1W in WebKit); with `--firefox` 140 (the 102, F7, F-SI, F-MD, E-CL-1F, DOOR-GUEST-F and 33 F:<id> in a Firefox
  context). Counted as passing after the alone reruns: Chromium 101 of 102, WebKit 107 of 107, Firefox 139 of 140 (the one failure in
  Chromium and Firefox is E-SO-9, which passed in the WebKit run).
- **Open, with reasons:** E-SO-9 failed in the Chromium and Firefox runs of the second round and four times alone, and passed in the
  WebKit run and at 05:48 (after E-SO-3 to E-SO-8): ADA's post written offline is in the app's data but the timeline shows "1 new
  post" instead of it; the cause was not found. E-SO-2 misses
  intermittently under load with both tabs on the lane and no lane wire (the step now prints the lane state; chain request 11).
  (Both closed after verifier round 1; see the bullet "Verifier round 1 fixes".) F:E-SO-2
  ("Follow by link" click in Firefox). DS-2, SCALE-7, SCALE-11, PTR-6, PTR-8's tracker rule, PHISH-7, PTR-10, PHISH-1 `createPage`,
  rows-social D-2 and D-3, C-1, C-2: owner or design decisions or changes on both sides of a protocol. The docs requests of the
  fixers and lanes are the docs lane's (section 3 and Requests of the note). The release gate on real devices has not run.
- Nothing was pushed, tagged or published.

## v0.3 verify fix round 2 (fixer, 2026-10-21 03:45 to 05:00 ET)

The independent verifier's not-ready findings ([deviations/v03-verify.md](deviations/v03-verify.md)) were closed: the two
files that still held the build machine's username, the release framing of every published document (0.3.0 is the release,
the v0.3 and C2 code is what runs, 0.2.1 is history that was never published), the claims the code does not keep, and the
18 gaps of the publish checklist. The record, finding by finding, is [deviations/v03-fix.md](deviations/v03-fix.md). One
defect was found on the way: `lightweb demo` served no identity page, so its guestbook answered every post with
`E_IDP_UNREACHABLE`; the desktop tier now builds and serves one (`--idp-port`, default 8081), and a loopback browser run
posted from one browser and saw the entry in a second.

- **Results:** `npm test` 2,074 of 2,074 (the lint floor clean over 147 files) before and after the edits;
  `npm run test:example` 177 of 177; `npm run check:example` 2 sites, 7 pages, 0 errors; `node test/e2e/run.mjs` 69 passed
  and 3 failed of 72 in 502.0 s (04:42 to 04:51 ET), every request on 127.0.0.1. E-MD-4 failed with "no loadeddata", the
  intermittent failure seen once before (below), while a unit test built the loader in parallel, and E-MD-3 and E-MD-5
  failed because they need it. The members group alone (`--only E-CH-1,E-CH-8,E-CH-6,E-FI-1,E-FI-2,E-MD-4,E-MD-3,E-MD-5`)
  then passed 8 of 8 in 39.4 s, every request on 127.0.0.1 (E-MD-4 on its own cannot run: its share needs the contacts
  that E-CH-1 makes). Not run in this round: `--webkit` and `npm run test:browser`.
- Nothing was pushed, tagged or published.

## v0.3 code review round 2 integrated (integrator, 2026-10-21 00:22 to 02:39 ET)

The four reviewers of the v0.3 and C2 code ([review/code-review-v03-security.md](review/code-review-v03-security.md),
[correctness](review/code-review-v03-correctness.md), [browser](review/code-review-v03-browser.md),
[conformance](review/code-review-v03-conformance.md)) reported 84 findings, 9 critical and 29 high. The four area fixers (ledger-tools,
loader-sw, chat-calls-media, examples-docs) fixed them with regression tests and rejected none; their 41 requests for other areas went to
the integrator, who applied the ones that are fixes and put the rest on [ROADMAP.md](ROADMAP.md) ("Left open by code review round 2"). The
record of every finding, fix, file and test is [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md), section 8; the contracts are in
ARCHITECTURE 15.17 to 15.19 and the three "v0.3 code review" sections of INTERFACES.

- **Applied by the integrator (with tests that fail on the code before):** premoderation in the files lane (pending listings shown only to
  their author, `E_POLICY` for anyone else's fetch) and `ledger-admin listed` for the owner's offline acceptance; the pin key from
  `ownerCfgPin` in the files and media lanes; the chat-key cache after a recovery (`ck-rotated`, `ck-epoch-jump`, `CK_EPOCH_MAX`) and
  clock-aware ban and role fallbacks in the chat and identity services; `<mw-signin>` opening the identity window inside the click; the
  verifier building its signing input before it uses the nonce (new `verify.js` sha256); `mw-chunk-cancel` answered, `mw-message-error`
  from the worker, and own media re-seeded after a reload; a failed ledger meta flush keeping its entries; `createPage` needing the hub
  key; `build-idp --hub-suffix` and `--shared-origin`; `call.keepOpen` on phones; the "reported" delivery wording; the identity page's
  removal limit and weak-passphrase texts; the open-writing warning of `ledger-admin` and `publish`; the pin container's sandbox note
  and hardening.
- **Breakage the e2e runs found and fixed:** the loader's recovery kit card (new, after the first meaningful action) queued every later
  card, so E-FI-1, E-FI-2 and E-MD-4 timed out waiting for "Continue" (the card helpers now answer it, and E-CH-1 checks that it comes
  once); the stricter passphrase estimate refused the social scenarios' four-word passphrases by one bit, and the identity origin's driver
  then retyped them until the step timed out (E-SO-1, E-SO-2, E-SO-11; longer passphrases, a driver that fails at once, and a message that
  names the rule); `byteDoors` never asks a guest door, so the doors scenarios list their full doors in `org=` too (DOOR-DOWN, DOOR-HASH)
  and DOOR-GUEST now checks that a guest door gets no byte request; E-PS-1's unsigned pin request is refused by the bridge now, so the
  scenario asserts the refusal and enters the request at the node's store; the E-SI lab's stand-in identity client awaits the challenge
  like the real one.
- **Found by the unit runs under load and fixed:** a SIG or a message sent right behind a CK frame was dropped as nobody's, because the
  CK's interest refresh ran in the background (the E-CL-1 shape test in `calls-service` lost its ring in 4 of 7 full runs); the
  chat lane now reads a wire's next frame after the CK frame before it is handled, and a refresh that a later one replaced waits for that
  one (`src/chat/lane.js` `_emitWait`, `src/chat/service.js`; a new `chat-lane-service` test fails on the code before). The moderator-cap
  test of `chain-v03-review` named a late tombstone's target that could already be hidden (19 effects in 1 of 40 runs alone); it now
  names one that is not. In `pinwire` the receipts are awaited (a load flake).
- **e2e changes:** E-FI-1 checks premoderation end to end (pending for its author, hidden and refused for the other member, then the
  owner's offline acceptance reaches the member through a new visitor's `cs=` snapshot); E-PS-3 accepts its listing the same way; E-CH-1
  checks the kit card; DOOR-GUEST checks a guest door. E-SI-5W, written by the examples-docs fixer, ran and passed, so the R 4.2 table
  counts 33 ran and passed (23 as written, 10 in part) and 31 open ([deviations/integration-v03.md](deviations/integration-v03.md)).
- **Before the pass (00:24 to 00:36 ET, the tree as the fixers left it):** `npm test` 2,058 of 2,058; `node test/e2e/run.mjs` 61 passed and
  11 failed of 72 (E-SO-1, E-SO-2, E-SO-11, E-FI-1, E-FI-2, E-MD-4, E-MD-3, E-MD-5, E-PS-1, DOOR-DOWN, DOOR-HASH).
- **Results (the final tree):** `npm test` 2,074 of 2,074 (the lint floor clean), four times after the last code change (02:20 to 02:40 ET,
  the last one after this entry was written); `npm run test:browser` 42 tests, 41 passed and 1 skipped (the v0.1 worker test, skipped by
  design), against a fresh `node build.mjs` in the copy; `npm run test:example` 177 of 177; `npm run check:example` 2 sites, 7 pages, 0
  errors; `node test/e2e/run.mjs` 72 of 72 passed, every request on 127.0.0.1 (472.2 s, 02:22 to 02:30 ET); `node test/e2e/run.mjs --webkit`
  77 of 77 passed, every request on 127.0.0.1 (468.5 s, 02:31 to 02:38 ET). Both e2e runs had passed before the chat lane fix as well (72 of
  72 in 493.1 s, 01:40 to 01:48 ET; 77 of 77 in 497.6 s, 01:48 to 01:57 ET).
- **Seen and not fixed:** E-MD-4 (private media played with a seek, in Chromium) failed once with "no loadeddata" in the first WebKit run of
  this pass (01:22 to 01:31 ET), and E-MD-3 and E-MD-5 with it because they need it; it passed three times alone and in all four later full
  runs, and the media session now forgets its cancelled requests when a stream registers again, but the cause of that one failure was not
  found. The main tree's `dist/` is still the C2 build (2026-10-20 21:22 ET): the tree is shared, so `node build.mjs` ran only in the copy
  (`dist/` is not tracked).
- **Open:** [ROADMAP.md](ROADMAP.md), "Left open by code review round 2": members' signed pin requests and the pin mailbox's sender, the
  per-author byte quota, a signed `minSeq`, an owner hand-over for personal pages, a peer-hint record (SYB A10 is open), an identity-origin
  vault for file keys, `setName('')` or "Leave this site", `withdrawPage`, `report.send({ ledger })`, `exportBlocks`, the copy sign-off of
  the new strings, the gate rows, and the e2e variants the fixers listed. The real-device gate has still not run.
- Nothing was pushed, tagged or published.

## v0.3 C2 integrated (C2 integrator, 2026-10-20 19:37 to 21:50 ET)

All eight C2 lanes landed: seed-policy, docs-strings, pin-node, zero-setup, seed-engine, calls, wire-ui and doors (no lane unbuilt). Source of
truth: [research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) and the lanes' briefs; the contracts are in
ARCHITECTURE 8.1, 15.14, 15.15 and 15.16 and the "v0.3 C2" part of INTERFACES. Details, findings C2-1 to C2-24, the scenarios and the open
items: [deviations/integration-c2.md](deviations/integration-c2.md).

- **Breakage found and fixed:** `pinwire.js` was imported nowhere, so no page sent a challenge, no receipt could arrive and the pin's own page
  offered no pin host (C2-7; with C2-8, `tools/pin.mjs` offering pinned files only after a reload, and C2-22, the pin page's host now starting
  only files the node lists as pinned); `_mw.cfg` naming `calls` was hidden whole by every reader (C2-5); the call panel could not be used (its
  first card cancelled by its own redress guard while its stylesheet loaded, overlapping the loader cards so each overlay cancelled the other's
  buttons, unstyled in WebKit where its stylesheet never loaded; C2-11 to C2-13); two browsers on one machine could never connect a call (C2-9);
  the carry meter's lines in the loader bar covered the site's own controls (C2-10, e2e E-ID-7); the door view's SDK hello, the loader import on
  a second door and a cross-origin activation target (C2-4, C2-6); the e2e media lab no longer loaded (C2-14); the vectors, docs-links and five
  exact-surface tests (C2-1 to C2-3); two flaky unit tests (C2-16); the e2e sites shared one ledger (C2-23); the social template's error
  table lacked the call codes (C2-24).
- **e2e:** 13 new scenarios (11 in Chromium, 2 more with `--webkit`): E-PS-1 to E-PS-4 and E-ZS-1 (`test/e2e/scenarios-c2.mjs`),
  E-CL-3, E-CL-1, E-CL-2 and, with `--webkit`, E-CL-1W (`scenarios-calls.mjs`, lane calls, made to run), DOOR-DOWN, DOOR-HASH,
  DOOR-GUEST and, with `--webkit`, DOOR-GUEST-W (`scenarios-doors.mjs`). Measured on loopback: a 5 MiB hand-off "Kept by the site"
  5,057 to 5,074 ms after the approval (six runs); calls connected 629 to 716 ms (Chromium, seven runs) and 650 to 686 ms (WebKit,
  three runs) after the accept.
- **Results (the final tree):** `npm test`: lint-floor clean (146 files); 1,967 tests, 1,967 pass, 0 fail, 0 skipped (21:46 ET, after the last document edits). `npm run
  test:browser`: 40 tests, 39 pass, 1 skipped (the v0.1 worker test) (21:43 ET). `npm run test:example`: 170 tests, 170 pass (21:44 ET).
  `node test/e2e/run.mjs`: 71 of 71 PASS and network policy PASS, 487.1 s (21:26 to 21:34 ET); `node test/e2e/run.mjs --webkit`: 76 of 76 PASS
  (the 71, then W7, W-SI, W-MD, E-CL-1W and DOOR-GUEST-W in WebKit 27.2) and network policy PASS, 494.8 s (21:34 to 21:42 ET). The same counts
  passed at 21:03 to 21:19 ET before C2-24, which changed only the social template's strings. Before the pass (19:37 to 19:47 ET): 1,962
  unit tests with 14 failing; e2e 41 passed and 8 failed of the 60, then the run ended on an unhandled rejection in E-ID-7.
- **Specs and documents:** the "v0.3 C2 (proposed)" marks are now "v0.3 C2" with the status line "Status: v0.3 C2, built, not yet reviewed."
  in ARCHITECTURE (8.1, 15.14, the new 15.15 Doors and 15.16 C2 integration), INTERFACES (with "As built" notes per lane and the doors
  contracts), PRIVACY (and its Doors section), SECURITY-MODEL ("Trust on first door"), THREAT-MODEL, COMPATIBILITY, ROADMAP, WHY and
  DEMO-RESULTS (G-DR-1 to G-DR-4 added); what is not built keeps "(proposed)" in place (the pin request path, S4's second phase). DEPLOY
  (the pin request gap), QUICKSTART (E-ZS-1), DEVIATIONS (a C2 paragraph) and CHANGELOG (`## [Unreleased] - 0.3.0`: "Added in phase C2",
  "Changed in phase C2", "Fixed in the C2 integration", "Known gaps of phase C2") are updated. `dist/` rebuilt (build 09cdc2c0a63a:
  `_mw/loader.js` 1,072,217 bytes, the drop-in `_mw/mw.js` 809,155).
- **Open:** the release gate on real phones, servers and networks (G-PS-1 to G-PS-14, G-ZS1 to G-ZS4, G-CL-1 to G-CL-9, G-DR-1 to G-DR-4: none
  run); owner decisions SZ-1 to SZ-6 unsigned; no path from a member's page to the pin's queue (O-1); "same local network" and "Hide my IP"
  have no switch or strings; the French C2 strings unreviewed; the fetch note that "fetching also shares it" overstates sharing under a budget;
  Firefox not run; the review round (R 5.3) has not looked at C2; the lanes' smaller open items (drop-in mode's net control, the keeper
  tab's list, the Caddy digest and others) are listed in [deviations/integration-c2.md](deviations/integration-c2.md).
- Nothing was pushed, tagged or published.

## v0.3 integrated (final integrator, 2026-10-20 13:28 to 15:54 ET)

All twelve lanes landed: freeze, harden-loader, idcore, chat, media, ui, docs, idp, chain-net, tools, sdk and examples. The
examples (the social template, the guestbook's v0.3 pages, the Example Forum's widgets) and the identity origin now run through
the real loader, SDK and identity origin end to end; the mock SDK stays only in `test/example/`'s fast logic and layout tests.
Details, findings F-1 to F-14, the 64-row table of the review's end-to-end rows and the open items:
`docs/deviations/integration-v03.md`, "Final integration".

- **Breakage found and fixed:** F-1 a page made with "Create my page" could never load the template (its signed pointer had no
  `tr=`, `ws=` or `xs=`, and a signed record uses only its own lists); F-2 `mw.ready()` kept its first answer in shell and hub
  mode, so a page stayed signed out after signing in; F-3 nothing ran the hub follow lane's clock (`MultiGossip.tick()`), so a
  followed page never showed a later post; F-4 every file and media item fetched by infohash failed its torrent check
  (WebTorrent's early `torrentFile` has no info dictionary); F-5 `<mw-signin>` on a drop-in page could not find its identity
  origin; F-6 the chat panel asked for the consent twice; F-7 the shell's 0.2.1 export and import fields were in the DOM of
  every v0.3 page; F-8 to F-10 loopback hub builds (the loader's PSL test entries, the development CSP, `*.localhost` in the
  network policy); F-11 three bugs of the social template (links that escape only spaces, opening the new page after the
  identity cards, `--spa`); F-12 the forum's documented `--chat members` refused every visitor; F-13 SDK.md's `files.preview`
  shapes; F-14 `.gitignore`.
- **e2e:** 22 new scenarios (E-SO-1, 2, 11; E-SI-1W; E-CH-R; E-ID-1, 2, 2B, 4, 5, 6, 7, 10; E-CH-1, 6, 8; E-FI-1, 2; E-MD-3, 4,
  5; E-HD-1) in `test/e2e/scenarios-{social,dropin-v03,identity,members,hardening}.mjs`, with `hub-stack.mjs` (a loopback
  subdomain hub at `<label>.localhost`) and `idp-driver.mjs` (answers the identity origin's cards with real clicks). Of the 64
  end-to-end rows of R 4.2, 33 ran and passed (22 as written, 11 in part) and 31 are open, each with its reason (the v0.3 code
  review moved E-SI-5 and E-FI-3 from "as written" to "in part"; E-SI-5W, written then, runs E-SI-5 with the real identity origin).
- **Results (live tree):** `npm test`: lint-floor clean (127 files); 1,533 tests, 1,533 pass, 0 fail (15:52 ET). `npm run test:browser`:
  37 tests, 36 pass, 1 skipped. `npm run test:example`: 170 tests, 170 pass (15:53 ET). `node test/e2e/run.mjs`: 60 of 60 PASS
  and network policy PASS, 378.2 s (15:42 to 15:49 ET); `node test/e2e/run.mjs --webkit`: 63 of 63 PASS (the 60, then W7, W-SI
  and W-MD in WebKit 27.2) and network policy PASS, 368.6 s (15:35 to 15:42 ET). Before the pass (13:28 to 13:40 ET): 1,529
  unit tests, 170 example tests, 38 of 38 and 41 of 41 e2e scenarios.
- **Specs and documents:** ARCHITECTURE 15 and the v0.3 part of INTERFACES are marked v0.3 where the code landed and
  "(proposed)" where it did not (the durable-grant reader, the hub's first screen from `cs=` snapshots, shards and a hub
  wire-budget kind, the kill switch's purge mode, examples GAP 2 to 4); ARCHITECTURE 15.13 and the last INTERFACES subsection
  list this pass's contract changes. The user documents' status lines read "Status: v0.3, built, not yet reviewed."; CHANGELOG.md
  has `## [Unreleased] - 0.3.0`, drafted from the lanes' notes.
- **Open:** the review round (R 5.3) and the outside review of the new cryptographic code (R 2.19); every real-device row and
  Firefox; the 31 open end-to-end rows (E-ID-9 and E-SO-12 need the owner to allow axe-core); examples GAP 2 to 5 and reads of
  files on a followed ledger; durable grants, the hub's first screen, the hub wire-budget kind, the kill switch's purge mode;
  UX seen end to end (the identity card's "This address is not one of this site's addresses." on hub labels, the 10 s card
  cooldown before "Create my page", "Follow by link" only on an empty timeline, a follower tab's sign-in sentence); the
  drop-in bundle size; the owner's sign-off of R 1.5.
- Nothing was pushed, tagged or published.

## v0.3 reconciliation (integrator after lane sdk, 2026-10-20 12:02 to 13:05 ET)

Lanes landed: freeze, harden-loader, idcore, chat, media, ui, docs, idp, chain-net, tools, sdk; the examples lane was still running
(nothing under `examples/` or `test/example/` was touched). The sdk lane's contract-first adapters are wired to the landed modules,
the contract mocks of its tests are replaced or backed by real-module tests, and every drift found was fixed in the implementation.
Details, findings R-1 to R-17, the adapter table and the open items: `docs/deviations/integration-v03.md`, "Reconciliation".

- **Breakage found and fixed:** R-1 WorkingKeys' `ecdh` took key strings only while the chat lane's Noise handshake passes raw points,
  so no chat wire could complete with real working keys; R-2 the signed-pin cache threw in every built loader (getter-only namespace
  exports), so MF-30 pins stayed unsigned; R-3 the first write after a sign-in could fail E_IDENTITY (keys bound after an await); R-4
  followed-ledger reads in hub mode ignored the recent window (the view's result taken for a state); R-5 the chat panel widget missed
  room messages and every direct message (event shapes); R-8 owner actions kept the identity origin's whole answer, secret scalars
  included, and `owner.policy` was unavailable in the shell; R-9 `media.share({ durable: true })` failed after the grant had gone out;
  R-10 a share to a group id had no member lookup; R-11 a tab holding a moderator key told the site it was a guest; R-17 a lane idp
  test failed about 1 run in 64 (its tamper step sometimes changed nothing).
- **Adapters wired:** `ChainNode.setIdentity` and `ChainNode.writeControl` (added to lane chain-net's node.js), the identity service's
  `ownerAction(card)` (added to lane idp's service.js), the chat service's `groupMembers(groupId)`, `ChainNode.genesis` as the only
  minting path, WorkingKeys and `keys()` only; MultiGossip, recent.js, wire-ext, `createDropinIdentity`, the migration deps, the
  sealed adapter and the PSL check checked against the landed code. `scope` now reaches the identity origin from both modes.
- **Tests:** new `test/unit/integration-v03-reconcile.test.mjs` (9 tests, real modules: the identity service with an in-process
  identity origin, chat over fake BEP 10 wires through the SDK seam, files, media, sealed.js, ChainNode, MultiGossip, recent.js, the
  drop-in engine); `widget-chat-panel` (+1); `dropin-v03`, `sdk-v03-wiring` and `sdk-v03-personal` follow the real shapes.
- **e2e:** the stack builds the identity origin (`tools/build-idp.mjs`) and serves it on a second loopback port; the published pointer
  names it (`idp=`) and every post signs in at its popup ("For this visit only"). Scenario 2's follower posts through the engine tab's
  sign-in (R 2.4.1), scenario 4 confirms the MF-27 card, PEER-WS bounds requests by the breaker limit times the files of a piece, FMT-SDK
  checks the v0.3 surface. `window.__mwShell.rectOf(label)` lets a test click a loader card in its closed root.
- **Results (live tree):** `npm test`: lint-floor clean (127 files); 1,529 tests, 1,529 pass, 0 fail (12:52 and 13:00 ET). `npm run test:browser`:
  37 tests, 36 pass, 1 skipped. `node test/e2e/run.mjs`: 38 of 38 PASS and network policy PASS, 140.9 s (12:48 to 12:50 ET);
  `node test/e2e/run.mjs --webkit`: 41 of 41 PASS (with W7, W-SI and W-MD in WebKit 27.2) and network policy PASS, 145.5 s (12:53 to
  12:55 ET). Before the pass (12:03 and 12:08 ET): 1,517 of 1,519 unit tests and 32 of 38 e2e scenarios.
- **Version:** package.json, npm-shrinkwrap.json and package-lock.json say 0.3.0 (I-6 closed).
- **Specs:** INTERFACES v0.3 carries every contract change of this pass and the sdk lane's hub amendment; status still proposed.
- **Open:** the hub lane's own wire-budget kind (joins as 'group'); a reader for durable grants; the ui lane's sentences and card kind
  the sdk lane asked for; a guest's sign-in from a follower tab reads as E_POLICY's sentence in the guestbook; E-ID-*, E-CH-*
  beyond the media gate, E-FI-1, 2, 4 to 6, E-MD-3 to 6, E-SO-* and E-HD-1 (final integration; E-ID-9 and E-SO-12 need axe-core);
  the drop-in bundle size; Firefox rows; real-device G rows.
- Nothing was pushed, tagged or published.

## v0.3 wave 1 (integrator, 2026-10-20 10:48 to 11:50 ET)

Lanes integrated: freeze, harden-loader, idcore, chat, media, ui (all six reported green on their own tests). The wave 2
lanes (chain-net, idp, tools, docs, sdk, examples) were writing during the pass, so wave 1 was tested on checkpoint `0d13fda`
(10:16 ET: every wave 1 file final, no wave 2 file touched) with the integration changes copied onto it; the same changes
are in the live tree. Details, findings I-1 to I-8 and the requests to the running lanes: `docs/deviations/integration-v03.md`.

- **Breakage found and fixed:** I-1 the redress check threw on a real shadow root, so no drop-in panel button worked (e2e 10B
  and OPFS failed after wave 1); I-2 `<mw-signin>` posted `{ proof }` where the spec and the server take the proof text;
  I-3 the file-torrent handle lacked the calls the media and files lanes make (deleted, revoked and unshared items kept
  seeding; the metadata check was skipped); I-4 grants and joins must be 1,040-byte boxes or the freeze schema hides them
  (contract written, adapter tested); I-6 the runtime and tools version follow `SDK_VERSION = '0.3.0'`; I-8 the chat service
  read `hostOnly` as a value, so a later host-only choice did not stop it (now a boolean or a function). I-5 (grant hints) and
  I-7 (the chat wire on the real TorrentManager seam) fit as built. `test/unit/integration-v03.test.mjs` pins all of them.
- **Vectors:** 136 LOCK lines appended (169 entries; frozen v0.2.1 head unchanged); `formats-vectors` lists ledger, identity,
  signin, chat and media and applies the supersedes rule (ptr-023 supersedes ptr-010); the browser vector test too.
- **Specs:** INTERFACES v0.3 and ARCHITECTURE 15 carry the wave 1 contract changes ("built by lane X", status still proposed;
  ARCHITECTURE 15.12 lists the new prefixes).
- **Wave 1 state (`0d13fda` plus the integration changes):** lint-floor clean (108 files); unit 1,253 tests, 1,252 pass,
  0 fail, 1 skipped; `test:browser` 35 tests, 34 pass, 1 skipped (the v0.1 worker test); `test:example` 29 of 29;
  `node test/e2e/run.mjs --webkit`: 41 of 41 PASS (the 26 v0.2.1 scenarios with W7, the 13 new Chromium scenarios, W-SI and W-MD in WebKit 27.2) and network policy PASS, 137.2 s (11:36 to 11:38 ET).
- **New e2e** (`test/e2e/scenarios-v03.mjs`, before 13): E-SI-1 to E-SI-5, E-CH-6M (the media gates of E-CH-6), E-MD-1, E-MD-2,
  E-MD-10, E-MD-7, E-MD-8, E-MD-9, E-FI-3 (3b, 3c), and with `--webkit` W-SI and W-MD. E-SI-1, E-SI-5, E-MD-1, E-MD-2 and
  E-FI-3 are partial (stand-in identity origin, no swarm or SDK wiring yet); each scenario says which half waits.
- **Live tree at 11:44 ET (wave 2 still writing):** `npm test`: lint-floor clean (127 files); 1,517 tests, 1,513 pass, 4 fail: `docs-links` (`examples/social/README.md` links the examples lane's deviations file, not written yet), `sdk-v03-tables` and `sw-sdk` (lane sdk mid-edit), `v021-integration` (package.json still says 0.2.1; lane tools owns it). `test:browser`: 37 tests, 36 pass, 1 skipped. `node test/e2e/run.mjs --webkit` (11:38 to 11:41 ET): 35 of 41 and network policy PASS; failing 2, 4, 12 and PEER-RV ("no identity page is configured for this site": the in-flight v0.3 wiring signs guestbook posts through the identity origin and the e2e stack has none yet), PEER-WS (48 web-seed requests before the breaker tripped) and FMT-SDK (the v0.3 SDK did not get ready in the site frame). Every new v0.3 scenario passed there too. These belong to the reconciliation integrator once the lanes land.
- **Not added yet** (lanes still building): E-HD-1 (chain-net), E-ID-* (idp), E-CH-* beyond the media gate (sdk), E-FI-1, 2,
  4, 5, 6 and E-MD-3 to 6 (swarm wiring), E-SO-* (examples). E-ID-9 and E-SO-12 need axe-core (not installed; owner decision).
  Firefox rows not run; real-device G rows not run.
- Nothing was pushed, tagged or published.

## Current state: post-wave (2026-10-20 00:40 ET, after the post-wave fix)
- Round 3 (2026-10-20 06:55 ET): consent fix N1 (host-only after a re-ask no longer inherits DNS permission on a page-tag site), one new unit test; `npm test` 938 of 938, e2e 25 of 25; details in `docs/deviations/post-wave-fix.md` Round 3.

- The writers', fresh-eyes' and editor's open items (A to Q of the post-wave brief and the 54 observations) are
  fixed, on `docs/ROADMAP.md`, or owner steps in `docs/PUBLISH-CHECKLIST.md`: `docs/deviations/post-wave-fix.md`.
  Code: `progress.uploaded` counts piece data sent to peers only (it counted 178 B of web-seed protocol messages
  before any choice; nothing left the page); the card and the gate name the DoH service on every page that asks it;
  per-folder demo ledgers; drop-in publish outputs; the `--prev-key` hint; gzip `ledger-admin` files; the `snapshot`
  message; named `_redirects` skips. Docs: the 13.3x model, DoH timing, RUNBOOK, the privacy scrub of the home path
  and the username (105 files), the checklist's pin check, npm and first-CI steps.
- `npm test`: lint-floor clean (62 files), 938 unit tests pass, 0 fail, about 8 s (929 plus 8 new; 00:35 ET).
- `npm run test:e2e`: 25 of 25 PASS and network policy PASS in 127.5 s (00:35 to 00:38 ET);
  `npm run test:e2e:webkit`: 26 of 26 and network policy PASS in 129.5 s (00:38 to 00:40 ET). Scenarios 7 and 10B
  now also check that nothing connects and nothing counts as passed on before the choice.
- `npm run test:browser`: 31 pass, 1 skipped. `npm run test:example`: 29 pass.
- Nothing was pushed, tagged or published.

## State after the editor's final pass (2026-10-19 23:18 ET; superseded by the section above)

- The examples hold only their sites: the guestbook's checks moved from `examples/peer-guestbook/.dev/` to
  `test/example/` and the drop-in helpers from `examples/existing-site-dropin/.fixture/` to
  `test/fixtures/existing-site-dropin/` (`test/e2e/run.mjs`, `test/unit/dropin-fixture.test.mjs` and the npm scripts
  follow; `repo-layout` keeps dot-directories out of `examples/`). The tracked `localhost` TLS key of the research lab
  `w1-13-lab` is gone; the package no longer carries `CHANGELOG.md` (87 files). Notes: `docs/deviations/editor.md`.
- `npm test`: lint-floor clean (62 files), 929 unit tests pass, 0 fail, about 7 s (23:12 ET).
- `npm run test:e2e`: 25 of 25 PASS and network policy PASS in 128.1 s (23:13 to 23:15 ET);
  `npm run test:e2e:webkit`: 26 of 26 and network policy PASS in 128.8 s (23:15 to 23:17 ET).
- `npm run test:browser`: 31 pass, 1 skipped. `npm run test:example`: 29 pass (from `test/example/`).
- Nothing was pushed, tagged or published. `docs/PUBLISH-CHECKLIST.md` holds the owner's commands.

## State after the fresh-eyes check (2026-10-19 22:28 ET; superseded by the section above)

- A fresh `git clone` of checkpoint `095ed87`, then `npm ci`, `npm run build`, README's tour, QUICKSTART's demo,
  track A (publish, the deploy tree, `check-webseed` against a local copy of it), MIGRATION's drop-in preview against
  `examples/existing-site-dropin/` and README's CRUD sample, all in local-only Chromium: each ran as documented once
  the mismatches listed in `docs/deviations/fresh-eyes.md` were fixed.
- `npm test`: lint-floor clean (62 files), 929 unit tests pass, 0 fail, about 8 s (913 plus the 16 tests the wave
  added in `cli-bin` and `repo-layout`). `tools/run-unit.mjs` now stops a hanging test file's process with its
  watchdog; before, every run left one running.
- `npm run test:browser`: 31 pass, 1 skipped. `npm run test:example`: 29 pass.
- `npm run test:e2e`: 25 of 25 PASS and network policy PASS in 128.0 s; `npm run test:e2e:webkit`: 26 of 26 (W7 in
  WebKit 27.2) and network policy PASS in 129.4 s.

## State after code review round 1 (2026-10-19 19:52 ET; superseded by the section above)

- `node build.mjs`: OK (the vendored bundle now carries five hash-asserted patch points and is linted against the
  browser floor). `npm test`: lint-floor clean (62 files), 913 unit tests pass, 0 fail.
- `npm run test:browser`: 31 pass, 1 skipped (v0.1 `sw-browser`, unchanged). `npm run test:example`: 29 pass.
- `npm run test:e2e`: 25 of 25 PASS (7, 1 to 6, 8, 14, 12, 10, 10B, 9, VIEWPORT, OPFS, SW-INSTALL, PUBLISH-WS, PEER-CONSENT, PEER-11, PEER-RV, PEER-BLIP, PEER-WS, FMT-SDK, FMT-WITHDRAW, 13) in 127.9 s; every timing target met (cold start 162 ms, cached render 118 ms, PEER-11 drop 66 ms, PEER-BLIP re-announce 1.3 s). `node test/e2e/run.mjs --webkit`: 26 of 26 PASS (adds W7) in 128.0 s. Network policy PASS in both (no request
  left 127.0.0.1).
- `docs/review/DESIGN-REVIEW.md` section 7 ("Code review round 1") lists all 58 findings: 54 fixed, 4 fixed in
  part with the rest deferred (F13 `rot=` v1 retirement, F36 non-extractable identity, F39 web-seed pad patch,
  F53 remaining behavioural tests), none rejected. Deferred items are on `docs/ROADMAP.md`.
- First versions of `docs/DEPLOY.md`, `docs/SECURITY-MODEL.md`, `docs/PRIVACY.md`, `docs/ROADMAP.md`,
  `docs/DEMO-RESULTS.md` and `CHANGELOG.md` exist (the documentation wave expands them); `test/unit/docs-links.test.mjs`
  checks that every referenced document exists and the section 4 wording rules hold.

## Code review round 1 (fixer, 2026-10-19 16:23 to 19:52 ET)

Brief: verify and fix the 58 findings of the four code reviews (`docs/review/code-review-*.md`), with regression
tests, keep ARCHITECTURE and INTERFACES in sync, run every suite until green. The per-finding table (fix, files,
tests) is in DESIGN-REVIEW section 7; the contract changes in short:
- Site ledger: a hand-over revokes the old key; contested hand-overs settle on the new owner's endorsement
  (`ledger-admin accept`); gossip at the cap stops re-fetching refused surplus; one gossip peer per wire; local
  writes are stored before they enter the DAG; writes take `{ signal, onProgress }` (the spam fee's progress, a
  cancel that keeps a timed-out write from being published: `pow`, `write.cancel`, `E_TIMEOUT`).
- Pointer: `lo=` (a rotation keeps the ledger), `rot=` v2 bound to scope and chain, the seq-future rule, empty
  `st=` withdraws, domain-separated hub labels; golden vectors `ptr-014` to `ptr-018` appended (LOCK 33 entries).
- Loader and worker: hub withdrawal and gate fixes, two tabs across a publish, limited mode in its own CSP (with
  module cycles and the real pathname), the site's viewport on phones, the network class re-evaluated, the identity
  created atomically by the engine tab only, `/_mw/ws/` for the engine only, pad files, the bundle hash-checked on
  fetch, a mode-specific install, a non-root deployment explained.
- Harness: the e2e run builds its own `dist/` and `build()` swaps its output atomically; wall-clock targets are
  reported (met or MISSED) and only generous bounds fail a run.
- New e2e scenarios: `VIEWPORT` (phone emulation: 980, 1024 and 390 CSS px as on the plain host; light-mode
  background), `OPFS` (a site's `chunks/keep.txt` survives the shell and drop-in; `tools/live.mjs` consents on a
  drop-in page). Extended: 2 (worker verifier pool), 10 (`/_mw/ws/` navigation is the host's 404), 13 (a second
  tab renders the next version and the first stops announcing the old one).
- Observation (on the roadmap): a top-level reload in the instant after "Share and load" can abort the consent
  record's IndexedDB write, so the card asks again.

## State when harden-verify finished (2026-10-19 14:40 ET; superseded by the sections above)

- `node build.mjs`: OK, 15 files (the vendored webtorrent bundle patched by the three B3 patch points; build id
  printed by the build). `npm test`: lint-floor clean (59 files), 836 unit tests pass, 0 fail, about 7 s.
- `npm run test:browser`: 28 pass, 1 skipped (v0.1 `sw-browser`, unchanged; Firefox is not launchable on this
  machine and is reported, not failed). `npm run test:example`: 29 pass.
- `node test/e2e/run.mjs`: 23 of 23 PASS (7, 1 to 6, 8, 14, 12, 10, 10B, 9, SW-INSTALL, PUBLISH-WS, PEER-CONSENT,
  PEER-11, PEER-RV, PEER-BLIP, PEER-WS, FMT-SDK, FMT-WITHDRAW, 13), network policy PASS (no request left
  127.0.0.1), about 100 s. `--webkit` adds W7: 24 of 24. Final code, three runs in a row: 23 of 23 (99.9 s), `--webkit` 24 of 24 (100.0 s),
  23 of 23 (99.2 s); PEER-BLIP re-announced both swarms of both visitors 1.0 to 1.5 s after a real drop.
- `docs/review/DIGEST-AMENDMENTS.md` has a Status column per item (33 rows): 24 done, 3 partial (E4 CI job, E5 README and
  DEPLOY, F4 DEPLOY.md), 6 skipped (F1, F2, F3, F5, F6 for the documentation wave; G roadmap).
- Notes, fixes and the CHANGELOG 0.2.1 draft: `docs/deviations/harden-verify.md`; the implementers' notes:
  `docs/deviations/{formats,network,serving-publishing}.md`.

## harden-verify (v0.2.1, 2026-10-19 13:51 to 14:40 ET)

Brief: run every suite after the three hardening implementers (formats, network, serving-publishing), fix the
integration breakage between their changes (INTERFACES wins), confirm the v0.2.1 marks, add the Status column.
Baseline after the implementers: build OK, 819 unit pass, browser 28 + 1 skipped, e2e 23 of 23 (and 24 of 24 with
`--webkit`). Fixed (details and tests in `docs/deviations/harden-verify.md`):
- Consent (C1, A4): drop-in mode had none of C1 (no same-layer refusal, `aud=` ignored, v0.2 bare-string choice):
  shared rules in the new `src/loader/consent.js`, a drop-in first-run card, the versioned per-origin record;
  `publish --aud` accepted only one of three words, so an owner could not declare the audiences that gate;
  shell decision buttons now ignore script clicks (`trustedOnly`); an undecided card settles a waiting
  `mw.consent.request()` with `pending` (`ConsentWaiters`); the drop-in panel gained identity Export/Import.
- Trackers (B1, B2): PEER-BLIP dropped nothing (`closeAllConnections()` does not reach upgraded sockets) and
  passed on rendezvous joins; under it, two shim bugs (an instance joining a pooled socket that is still
  connecting never re-announced; the regular announce interval never restarted after a reconnect) and a `kick()`
  that double-counted attached instances in bittorrent-tracker's socket pool. `tools/tracker.mjs` tracks live
  sockets (`dropConnections()`), PEER-BLIP drops for real and checks both swarms of both visitors, and
  `test/unit/loader-app-tracker-shim.test.mjs` runs the real client. `publish` still named the v0.2 anchor
  torrent for `tracker --allow`; it now writes `rendezvousBtih`.
- Tools: `tools/live.mjs` (pin, snapshot, check-site --headless) clicked "OK"/"Load", which the C1 card no longer
  has, so the pinned node never consented; it now clicks "Share and load" with a trusted click.
- Smaller: drop-in B7 offer timeout, display fallbacks for tagged keys, runtime and tools version 0.2.1, E5 egress
  note in `publish --dropin`, D3 runbook lines, F8 corrections, C3/C4 marks in ARCHITECTURE.

## State when integration-2 finished (2026-10-19 12:30 ET; superseded by the sections above)

- `node build.mjs`: OK. `npm test`: lint-floor clean (54 files), 675 unit tests pass, 0 fail, about 7 s.
- `npm run test:browser`: 28 pass, 1 skipped (`sw-browser.test.mjs`, v0.1 worker). `npm run test:example`: 29 pass.
- `node test/e2e/run.mjs --webkit`: 15 of 15 PASS (7, 1 to 6, 8, 14, 12, 10, 10B, 9, W7, 13) in 72.7 s, network
  policy PASS. Without `--webkit`: 14 of 14, three runs in a row (71.5 to 73.0 s).
- Every ARCHITECTURE section 12 E2E scenario is automated except 11 (unit-level coverage only).
- Docs: `docs/DEVIATIONS.md` (merged from `docs/deviations/*.md`, with a status table of every open item),
  `docs/RUNBOOK.md`, `docs/deviations/integration-2.md` (seven product fixes, reasons, known gaps).

## Next steps (updated by code review round 1)

1. Done by the network agent: scenario 11 runs in a browser as PEER-11 (`0x7FFFFFFF` prefix from a real peer).
2. Done in code review round 1 (F07, F27): limited mode reloads once with a "degraded" flag that boot.js honours.
3. `test/unit/sw-browser.test.mjs` (v0.1): rewrite against the v0.2 worker or delete.
4. Done in code review round 1 (F09): the pointer's `lo=` keeps the ledger id across a key rotation.
5. Release gate on real devices (`docs/DEMO-RESULTS.md`): iOS 18 and 16/17, Android Chrome on LTE, Samsung Internet,
   Firefox normal and private, Safari `resultingClientId`, the iOS `DataCloneError` path, 7-day persistence on iOS.
6. Suggested script for the tools owner: `"test:e2e:webkit": "node test/e2e/run.mjs --webkit"`.
7. v0.2.1 open items (harden-verify): Firefox D1 checks; the floor browsers' treatment of a simple `Range` header
   (the gate requires the range preflight until measured); the CI double-pack job (E4); documentation wave items
   (E5 in README and DEPLOY, F1 to F6, F4 owner duties in DEPLOY.md); identity files exported before v0.2.1 carry
   an untagged key and do not import (pre-release, not migrated); real-device checks of the shim, the probe classes
   and the lifecycle plan.
8. Code review round 1 leftovers (`docs/ROADMAP.md`, DESIGN-REVIEW section 7): retire `rot=` v1 with the next
   pointer revision; a non-extractable identity; the WebTorrent web-seed pad-file patch; filling a drop-in version
   from the previous one in IndexedDB; e2e variants (module worker with `sw-core.js`, Wi-Fi to mobile data during a
   drop-in copy, a post before a key rotation, an unsigned withdrawal on a shared hub); behavioural tests for the
   remaining guarded buttons; the consent write race; the documentation wave (README, CRITIQUE and the full DEPLOY,
   SECURITY-MODEL, PRIVACY, ROADMAP and CHANGELOG).

## integration-2 (started 2026-10-19 11:16 ET)

Brief: ARCHITECTURE section 12 E2E scenarios 8 to 14 in `test/e2e/run.mjs` (keep 1 to 7 green), then
`docs/DEVIATIONS.md` (merged, originals kept), `docs/RUNBOOK.md`, and this file after every milestone. Notes and
deviations: `docs/deviations/integration-2.md`.

Session-start baseline (11:16 ET): `node build.mjs` OK; `npm test` 669 pass, 0 fail; `node test/e2e/run.mjs`
scenarios 7, 1 to 6 PASS in 6.1 s, network policy PASS.

Scenario 11 (an oversized message declared by a peer) is not part of this session's E2E work; the length cap is
covered at unit level (see the integration-2 notes).

### I2-M4 (12:24 ET): the kill-switch reload loop fixed; EXPECTED.md checks 6 to 10 automated (scenario 10B)
- Found by a probe: in shell mode, deploying only the kill-switch worker while the host keeps serving the shell
  made the page reload about 80 times a second (958 navigations in 12 s): every activation reloaded every window,
  including the page that had just loaded from the host and registered the kill switch again. `src/sw/kill-switch.js`
  now reloads only pages an earlier worker controlled (taken before `clients.claim()`). Same probe after the fix:
  2 navigations, then none. Scenario 9 checks it (step "shell kept by mistake"); `sw-core` has a VM test of the
  real script. Side effect, verified in Chromium and written into `EXPECTED.md`: a drop-in visitor who never had
  our worker registers the kill switch once and is no longer reloaded (its page came from the host anyway).
- Scenario 10B (EXPECTED.md 6, 7, 8, 10 and the offline variant): 0 tracker announces and 0 WebSockets before
  consent; the notice sits in a closed shadow root and a real mouse click on OK (via `panel.rectOf`) starts the
  site and anchor announces; a metered visitor (`navigator.connection.type = 'cellular'`) logs "web seed off
  (metered)" and completes the copy from the first visitor (`source: 'peers'`); a page without the stamp runs with
  the engine off (`no-stamp`, one warning, `mw.db.set` rejects with E_IDENTITY); a stamp for another host gives
  `pointer:bad-sig`; with the host down, visited pages load (200, styled, script ran) and unvisited URLs get the
  worker's 503 offline page.
- Run order is now 7, 1 to 6, 8, 14, 12, 10, 10B, 9, (W7,) 13. `node test/e2e/run.mjs`: 14 of 14 PASS three runs in a
  row (71.5 to 73.0 s). `npm test`: 675 pass, 0 fail.

### I2-M3 (12:10 ET): stable; a drop-in registration race fixed
- A full run failed once in scenario 10 (integrated variant): our `/mw-sw.js` ended up controlling the page. Cause:
  the site's `register('/sw.js')` was not yet visible to `getRegistration('/')` when the drop-in runtime looked
  (after load, at idle), so it registered ours for the same scope and replaced the site's worker (3.4.4 says it
  must never). Fix: `src/dropin/swreg.js` looks at an empty scope twice, `EMPTY_SCOPE_RECHECK_MS` (1 s) apart,
  before registering; the engine passes `options.swRecheckMs` through (tests that pin the old timeline pass 0;
  `dropin-swreg` has a dedicated test).
- After the fix: 5 consecutive full runs PASS (56.8 to 57.5 s), and one `--webkit` run (14 of 14, 59.0 s) while
  `npm test` ran three times in parallel (674 pass each). `npm test` 674 pass; `npm run test:browser` 28 pass,
  1 skipped (v0.1 `sw-browser`, unchanged); `npm run test:example` 29 pass; lint-floor clean (54 files).

### I2-M2 (11:48 ET): scenarios 9, 10, 13 pass; the whole run is green
- `node test/e2e/run.mjs --webkit`: 7, 1 to 6, 8, 14, 12, 10, 9, W7, 13 PASS (14 of 14) in 54.5 s, network policy PASS.
  `npm test`: 673 pass, 0 fail (sw-core gained 2 tests, sw-sdk 1, loader-app-render 1).
- 9: shell: the host switches to the plain site plus `dist/mw-sw-kill.js` as `/mw-sw.js`; K reloads, the kill switch
  unregisters, clears `mw-*` caches and reloads K once from the plain host; 0 registrations, IndexedDB kept, no
  further reload in 3 s. Drop-in (EXPECTED.md check 5): 2 navigations while settling, none in the next 5 s,
  `inspect().sw` = `{ mode: 'none', reason: 'kill-switch' }`, one console warning, a later view asks for
  `/mw-sw.js` once and registers nothing.
- 10 (EXPECTED.md checks 1 to 4 and the variants): JS off identical to the plain host on 6 URLs (status,
  X-Fixture-Host, text, redirect chain, full-page screenshot bytes); the second view's assets come from IndexedDB;
  a v2 redeploy (seq + 1, same genesis, old files kept): the open v1 page keeps v1 (chunk, stylesheet), a new page
  is v2 and follows the v1 tab; closing the v1 tab promotes it, it refreshes 4 changed files, copies v2, and
  IndexedDB holds only v2; `location.pathname` on a deep page, the SPA deep link, pushState, reload, back; the
  hand-written worker keeps working (stats 0/0, 0/1, 1/1), our worker never requested, one recipe line per view;
  the integrated worker is classified `integrated`, carries the web seed and gets no recipe line.
- 13: V renders v1; publish a changed copy with `seq + 1` into the same web seed and switch the page tag; V reloads,
  sees "Update available: reload" and stops announcing v1; V reloads again: v2 renders (about.json version
  2.0.1-e2e), IndexedDB holds only v2, no announce of v1 from V or at the tracker.
- Bugs found and fixed: (4) the worker's web-seed blob cache was keyed by URL only, so a new version downloaded
  within 60 s got the old bytes for a changed file and stalled (the drop-in agent's open note; the v2 promotion in
  scenario 10 hung 30 s); now keyed by the requesting page's version. (5) A returning shell visitor never saw a
  new page-tag pointer: the shell document is served cache-first from the worker's precache, which kept the page
  tag of install day, and the only update channel was DNS (skipped for IP hosts and absent for meta-only sites).
  Now the worker re-fetches the shell in the background on navigations (at most every 10 s) and replaces the
  cached copy only with a shell of the same build (same SRI attributes), and the shell asks the worker for the
  host's current page tag after render and on focus (`mw-shell-check`), treating a newer signed record like a
  DNS update (banner, stop seeding the old version, keep the record for the next load).

### I2-M1 (11:37 ET): scenarios 8, 12, 14 pass; 1 to 7 still green
- `node test/e2e/run.mjs`: 7, 1 to 6, 8, 14, 12 PASS in 19.7 s, network policy PASS. `npm test`: 671 pass, 0 fail.
- 8: hub link (`#v=mw1;...` signed for `btih:<hex>`, no page tag on the dev host = shared-origin hub): gate with
  name, infohash, trackers, publisher key and "Load anyway: ..."; 2 s with the gate open: 0 WebSockets, 0
  `RTCPeerConnection`s, no frame; after the click the tracker socket opens and the site renders under `/_mw/s/<btih>/`.
- 14: WebKit 27.2 and Chromium with native `Uint8Array` hex/base64 and `AbortSignal.timeout` deleted complete a
  download (WebKit from the web seed, Chromium from a peer), `__mwBoot.polyfilled` lists all five; a context with
  `serviceWorkers: 'block'` renders in limited mode, styled, `mw.ready()` resolves.
- 12: Q turns sharing off in Settings before any download, then downloads from P; posts flow P to Q and Q to P;
  X, with only Q online and connected to it, gets 0 bytes in 6 s (choke lock); Q2 (sharing off) downloads from the
  web seed.
- Bugs found and fixed: (1) boot.js treated `register()` resolving with no registration as success, fixed the
  normal CSP, and the loader then waited 15 s and rendered limited mode under that CSP (blob: CSS and scripts
  blocked, `<base>` blocked); (2) the SDK compared `location.origin`, which is "null" in limited mode's
  `about:srcdoc` frame, so `mw.ready()` always failed with E_NO_HOST there; (3) Settings switches showed "Off"
  and accepted clicks before the loader loaded the stored settings, and changes made then were dropped.

## Session-start baseline (2026-10-19)

Baseline measured before any integration change:

- `node build.mjs`: OK (14 files, build id printed by the build).
- Non-browser unit files without `sw-sdk` and `loader-app-torrent`: 595 pass, 0 fail, about 6 s.
- `test/unit/sw-sdk.test.mjs`: 9 of 9 fail. The test targets the v0.1 SDK surface (`mw.embedded`,
  `mw.owner.isOwner`, `owner.policy` resolving, a bare `{ mw: 'hello' }` message); `src/sdk/sdk.js` is v0.2
  (INTERFACES "src/sdk/sdk.js", ARCHITECTURE section 9). Plan: rewrite the test against v0.2.
- `test/unit/loader-app-torrent.test.mjs`: 43 pass, 2 fail, two tests wait 60 s each on real timers, and the
  file never exits. Plan: fix per orchestrator-notes item 3.
- `test/e2e/run.mjs`: does not exist yet. Plan: write it (scenarios 1 to 7 of ARCHITECTURE section 12).

## Known bugs reported by builders (1 and 3 fixed by integration-1, 4 by integration-2; 2 is by design: publish with --cs)

1. tools: first load shows the SW 503 "This site isn't ready yet" until a reload (src/sw/core.js refresh throttle).
2. tools: a visitor cannot post to an open ledger without the genesis block; publish needs `--cs`.
3. chain-net: `src/loader/app.js openLedger` has no MemoryBlockStore fallback when IndexedDB is missing.
4. dropin: the worker's 60 s web-seed blob cache (`wsBlobs`) is not keyed by version.

## State when integration-1 finished (2026-10-19 11:15 ET; superseded by the sections above)

- `node build.mjs`: OK, 14 files.
- `npm test`: lint:floor clean (54 files), 669 unit tests pass, 0 fail, about 7 s, exits on its own.
- `npm run test:browser`: 28 pass, 1 skipped. `run-unit --browser` now sets MW_BROWSER=1, so
  `chain-core-browser` runs (Chromium and WebKit; Firefox is not installed and is reported, not failed).
  `sw-browser.test.mjs` is skipped with its reason: it targets the v0.1 worker (MW_SW_BROWSER_V01=1 runs it).
- `npm run test:example`: 29 pass.
- `node test/e2e/run.mjs` (= `npm run test:e2e`): scenarios 1 to 7 PASS (run order 7, 1, 2, 3, 4, 5, 6), about 6 s,
  network policy PASS (no request left 127.0.0.1). Stable: more than 15 full runs, one under parallel unit-test
  load. `--webkit` adds W7 (scenario 7 in WebKit 27.2): PASS, the worker controls the first visit.
- Deviations and the file list: `docs/deviations/integration-1.md`.

## Next steps left by integration-1 (done by integration-2: scenarios 8 to 14 except 11, the wsBlobs note; open: sw-browser, real devices)

1. Section 12 scenarios 8 to 14 are not in `test/e2e/run.mjs` yet; `test/e2e/lib.mjs` has the building blocks
   (gate for host down or refused paths, visitors, `stopServiceWorkers`, `dev.killSwitch()` on the dev server,
   `launchWebkit`). Drop-in (10) can reuse `examples/existing-site-dropin/.fixture/{stage,host}.mjs` and `EXPECTED.md`.
2. Port or delete `test/unit/sw-browser.test.mjs` (v0.1).
3. dropin's open note: the worker's 60 s web-seed blob cache (`wsBlobs`) is keyed by URL, not version.
4. DESIGN-REVIEW 6 open items: WebKit first-visit control is settled for Playwright WebKit 27.2 (W7); Firefox was
   not available here; Safari `resultingClientId` and the iOS `DataCloneError` path need real devices.

How to rerun one scenario: `node test/e2e/run.mjs --only 7,1` (scenarios 2 to 6 build on the visitors that 1 and 2
leave open, so run them with their predecessors). `--keep` leaves `.tools/e2e/run-*/` (keys, publish output).

## Milestones

### M5 (2026-10-19 ~11:10 ET): corrupt-copy recovery in an open page
- Scenario 3 now checks both paths: (a) flip a byte of the stored about.html while the page is open, stop the
  worker, follow the About link: the fresh worker deletes the copy and broadcasts `mw-site-invalid`, the page
  downloads again and remounts on /about.html (about 100 ms); (b) flip index.html, stop the worker, load the site:
  the worker deletes the copy before the page loads, the page downloads again.
- `renderSite` keeps the visitor's current path when it remounts (it used to go back to the load path).

### M4 (2026-10-19 ~11:06 ET): hardening
- Scenario 2 also posts from a second tab of visitor A (a follower of A's engine tab, 5.9): the post goes through
  A's engine and reaches B.
- `--webkit` W7: WebKit cold start against 127.0.0.1 with consent pending (HTTP only). Settles DESIGN-REVIEW 6
  "first-visit iframe control in WebKit" for Playwright WebKit 27.2 (controlled after `clients.claim()`).
- A follower tab that hears `mw-site-invalid` waits for the engine tab's new copy instead of downloading itself.
- `tools/demo.mjs` (the tools agent's repro of the first-load bug) now renders on the first load (checked in
  local-only Chromium: 239 ms, no placeholder page).

### M3 (2026-10-19 ~11:00 ET): scenarios 1 to 7 all pass
- 4: moderator key imported through Settings in a browser that never held owner.jwk; "Remove post" (two taps) hides
  the post in M, B and C, and all three hold the same ledger root (tombstone included).
- 5: host down (gate) plus `context.setOffline(true)`: reload renders shell and site from the worker and IndexedDB.
- 6: signed page tag (pointer source meta, signed, ledger id from publish) and an unsigned page tag (ledger
  `btih:<hex>`, unmoderated notice, renders from the web seed); scope 127.0.0.1 never asks DoH.
- Added unit tests: `sw-core.test.mjs` (9; the Wave A file had none), `loader-app-render.test.mjs` (9).
- `openLedger` falls back to an in-memory ledger store on `E_STORAGE` (chain-net note).

### M2 (2026-10-19 ~10:55 ET): E2E harness, scenarios 7, 1, 2, 3 pass
- `test/e2e/run.mjs` + `test/e2e/lib.mjs` written (plain Node + playwright). Local-only: `chromiumArgs({ allowRemote: false })`,
  an init script that empties RTCPeerConnection `iceServers`, and a request/WebSocket guard that fails the run on any
  non-loopback URL. A small proxy ("gate") in front of the dev server can refuse the web seed's file bytes (forces
  peer-only downloads) or play "host down".
- Fixed the first-load bug (tools report 1): root cause was the worker's 1 s "database does not exist yet" negative
  cache plus the 2 s refresh throttle. Fixes: `storage.retry()` on forced refreshes, navigations force one re-read,
  and the shell now waits for the worker's `mw-ack` to `mw-set-current` (new `requestServiceWorker` in render.js)
  before mounting the frame, re-sending `mw-site-saved` while the worker reports `complete: false`.
- The shell now handles the worker's `mw-site-invalid` (download again, remount) and exposes
  `window.__mwShell.inspect()`; the worker's `inspect()` lists recent `drops`.
- Scenario 3's flipped byte needs the worker stopped first (CDP `ServiceWorker.stopAllWorkers`), because verified
  piece indices are memoised per worker instance by design (ARCHITECTURE 7.3).

### M1 (2026-10-19 ~10:48 ET): unit suite green
- `npm test`: 652 pass, 0 fail, exits in about 7 s.
- `src/loader/torrent.js`: injected timers were copied with `Object.assign`, which drops prototype methods, so a fake
  clock silently fell back to real timers (60 s waits, the never-exiting file, the keepalive test). Now bound per method.
- `test/unit/loader-app-torrent.test.mjs`: rejection handlers attached before the fake clock fires; keepalive test
  uses a seeding torrent; the lazily created client is accepted after `stopSite`.
- `test/unit/sw-sdk.test.mjs`: rewritten for the v0.2 SDK, shell mode against the real Bridge (12 tests).
- `npm run test:browser`: 27 pass, 2 skipped (gated by MW_BROWSER=1). `sw-browser.test.mjs` targets the v0.1 worker
  (12 of 14 fail when forced); the E2E run covers the worker in a real browser.
