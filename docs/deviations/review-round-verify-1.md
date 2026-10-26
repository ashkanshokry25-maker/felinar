# Review round R 5.3: fixes after verifier round 1 (2026-10-24)

Written by the reconcile step on 2026-10-24 between 09:21 and 09:45 ET (times from `TZ=America/Toronto date`). Verifier round 1
checked the tree that the integrator of the review round left (checkpoint `abd416b`, 07:39 ET;
[review-round-integration.md](review-round-integration.md)). Four fixers then worked in parallel from 08:28 to 09:20 ET: social
(E-SO-2, E-SO-4, E-SO-9, E-CH-7, SCALE-6), binding (the fresh-clone unit run), rename (the last brand strings) and docs (counsel
clause, checklist mailbox, stale rows and counts). This note records each item with its change and its suites, the items the
fixers left open, and the suites the next verifier must run. The fixers made no commits; the harness's automatic checkpoints
(`fd3dfda` 08:31, `edbf552` 08:46, `39d27c1` 09:01, `b19fd2a` 09:16, `657a39c` 09:31) carry their edits. Nothing was pushed,
tagged or published, and every browser run stayed on 127.0.0.1.

## Social fixer

| Item | What changed (file:line) | Suites and results |
|---|---|---|
| E-SO-2: follow by link over the hub follow lane missed now and then | Cause: a hub lane that joins while the consent card is open finds no peers and returns (`src/loader/torrent.js` `_startLane`); the loader's `setConsent` stores the record before it calls the listeners, so a client built in that window already allows peers, and `_onConsentChange` rebuilt nothing. It now starts lanes and file torrents still waiting when peers are allowed: `src/loader/torrent.js:3628` to `:3637`. The step asserts each tab's lane has kind `'hub'`, a torrent, the same manager and `tmCount` 1: `test/e2e/scenarios-social.mjs:238` to `:243`. Unit: `test/unit/social-fixer-hub-lane.test.mjs` (fails on the old `_onConsentChange` in a scratch copy: 3 pass, 1 fail) | E-SO-2 5 of 5 (three runs of the five social rows, two of `--only E-SO-1,E-SO-2`), 09:08 to 09:20 ET |
| SCALE-6: the hub lane's swarm kind | Kept as `'hub'`: `src/loader/app.js:3821` joins with kind `'hub'`; the attach call passes `lane.kind`; the doc comment above `joinHubLane` (`src/loader/app.js:3807`) says `'hub'`. Pinned by `test/unit/social-fixer-hub-lane.test.mjs`. The verifier's spot copy with `'group'` passed 2 of 3 only because the race depends on timing | as E-SO-2 |
| `ensureTorrentManager` race (latent, found on the way) | Single-flight like the drop-in's `tmPromise` (`src/dropin/engine.js:1152` to `:1156`): `src/loader/app.js:2184` (`ensureTorrentManager`), `:2193` (`createTorrentManager`), `:2202` (`A.tmCount`). Not shown to be E-SO-2's cause | unit `social-fixer-hub-lane.test.mjs` (single-flight case) |
| Read-only lane diagnostics | `inspect().hubLane` gains kind, torrent, hidden, wanted, wires, sameTm, tmCount and the manager's failures for the lane's swarm (`hubLaneInfo`, `src/loader/app.js:1376` to `:1393`) | used by E-SO-2's assertion |
| E-SO-4: one reaction per member per target | No change: it failed on the same lane defect (CY's lane joined with consent pending, `torrent: false`) | 3 of 3 in the five-row runs after the fix |
| E-SO-9: the post written offline shows at once | Cause in the social app: offline, `db.append` resolves in 2 to 3 ms, before the data layer's change adds the post, so the composer's redraw kept the old top and the own post sat behind "1 new post". New `timelineTop` (`examples/social/js/model.js:286` to `:296`): a newer item from the reader's own ledger moves the top; others' new posts still wait. Used at `examples/social/js/views/timeline.js:77`. Unit: `test/unit/social-rows.test.mjs:101` to `:116` | 6 of 6 since its fix (3 of 3 on the final tree) |
| E-CH-7: the phone class relays nothing (failed depending on order) | Harness control step: B sends each WANT-TAGS to a neighbour other than its largest byte source (`src/chat/lane.js:951` to `:962`), and A floods only to session neighbours (`:919` to `:923`), so R got a route only when earlier scenarios had left it behind P. The step now waits for R's route and for A to hold R: `test/e2e/scenarios-chat-rows.mjs:787` to `:803` | `--only E-CH-7` 3 of 3 alone (09:15:02, 09:15:22, 09:15:41 ET) |

Suites (social fixer, each e2e run ending "PASS network policy: every request stayed on 127.0.0.1"):

| Suite | Result |
|---|---|
| `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-9`, three runs, 09:08:55 to 09:14:50 ET | 5 PASS each run, exit 0 |
| `node test/e2e/run.mjs --only E-CH-7`, three runs alone | PASS each (19.4 s the first), exit 0 |
| `node test/e2e/run.mjs --only E-SO-1,E-SO-2`, two runs, 09:16:01 and 09:18:04 ET | 2 PASS each, exit 0 |
| `npm test`, 09:20 ET, after all code changes | 2,286 tests, 2,277 pass, 0 fail, 0 cancelled, 0 skipped, 9 todo |
| Before the final fix (diagnosis; logs in the session scratchpad `sofix/`) | with only the E-SO-9 and single-flight fixes the five-row set passed 1 of 3 (E-SO-3 and E-SO-4 failed on CY's lane, `torrent: false`); E-SO-1, 2 (and 3) failed in run4, run5, run10, run12 and run13, and the instrumented failures showed the consent-pending join |

## Binding fixer

| Item | What changed (file:line) | Suites and results |
|---|---|---|
| Fresh clone (checklist section 6): 3 unit files failed because `npm ci` with the tracked `.npmrc` `ignore-scripts=true` builds no `node-datachannel` binding | New helper `test/unit/no-native-webrtc.mjs:13` to `:37`: redirects the bare specifier `webrtc-polyfill` to a stub in a `data:` URL whose `RTCPeerConnection`, `RTCSessionDescription` and `RTCIceCandidate` throw when constructed (`module.registerHooks` on Node 22.15+ and 23.5+, `module.register` otherwise). Named `*.mjs`, not `*.test.mjs`, so the runner does not take it as a test (`tools/run-unit.mjs:37`) | fresh clone of `abd416b` plus the patch: `npm test` 2,281 tests, 2,272 pass, 0 fail, 9 todo (verifier round 1: 2,267, 2,255 pass, 3 fail, 9 todo) |
| `test/unit/loader-app-tracker-shim.test.mjs` | imports the helper, then `bittorrent-tracker/client` by dynamic import (`:12` to `:14`, `:19`); still runs | clean clone 2 of 2 |
| `test/unit/loader-common-chunk-stores.test.mjs` | the same for `webtorrent` (`:3` to `:5`, `:11`); real WebTorrent clients over loopback TCP | clean clone 10 of 10 |
| `test/unit/loader-review-v03-torrent.test.mjs` | the same (`:7` to `:9`, `:20`) | clean clone 5 of 5 |
| Control | in the clone without the stub, `import('webtorrent')` still fails with `MODULE_NOT_FOUND` for `node_datachannel.node`; `package.json`, the lock file, `.npmrc` and production code are unchanged | `module.register` fallback forced: 7 of 7 |

Suites: project tree `npm test` 08:31 ET, 2,281 tests, 2,272 pass, 0 fail, 9 todo. The helper and the edited tests are tracked
since the automatic checkpoints `fd3dfda` and `edbf552`, so the fixer's open item about a commit is closed.

## Rename fixer

| Item | What changed (file:line) | Suites and results |
|---|---|---|
| Passkey labels | `RP_NAME` and `DEFAULT_NICKNAME` are 'felinar identity': `src/idp/passkey.js:26`, `:27`, header `:4`. Existing passkeys keep working: `get()` asks by rpId only (`:154`), rpId is the host name (`:38`), `rp.name` is sent only at `create()` (`:120`) | in `npm test` |
| Risk warning | `src/files/preview.js:21`; its test `test/unit/media-service.test.mjs:697` | in `npm test` |
| Identity page noscript | `src/idp/index.html:13` | in `npm test` |
| Loader "newer version" title | `src/loader/app.js` (about `:3862` when the fixer wrote it; it moves with the social fixer's lines) | in `npm test` |
| SDK errors and comments | `src/sdk/sdk.js:509`, `:534`, `:1009`, comments `:31`, `:335`, `:1007`; `src/sdk/sdk-static.js:20`, comment `:3` | in `npm test` |
| Service worker and drop-in | `src/sw/core.js:1828`; comments `src/sw/kill-switch.js:2`, `src/sw/lib.js:732`; 20 console lines in `src/dropin/engine.js` (`felinar: ` prefix, `E_NO_HOST` at `:99`) and `src/dropin/ledger.js:135`, `:136`, `:147`, `src/dropin/mw.js:156`, `src/dropin/swreg.js:72`, `:360` | in `npm test` |
| Default door name | 'felinar': `src/loader/doors.js:232`, matching `build.mjs:648` | in `npm test` |
| Record | section "Request 2 applied (verifier round 1)" appended to [rename-felinar.md](rename-felinar.md) | |

Suites: `npm test` 08:29 ET 2,281 tests, 2,271 pass, 1 fail (`test/unit/tools-build.test.mjs:235`, a build id that changed
because other fixers were editing `src/` during the run; the file alone 28 of 28), then 08:30 ET 2,281, 2,272 pass, 0 fail,
9 todo; `npm run build` 08:30 ET ok, 21 files, 2,736 KiB, build 3329978977d3. `git grep -n -i lightweb -- src test` prints only
the compatibility names (the `web+lightweb:` scheme and its constants, the `lightweb-door` and `lightweb-doors` kinds, the alias
commands).

## Docs fixer

| Item | What changed (file:line) | Suites and results |
|---|---|---|
| Hub kind in INTERFACES | `docs/INTERFACES.md:922` to `:923`: the loader joins with `joinLane({ kind: 'hub' })`; the reconcile step re-took the line (`src/loader/app.js:3812`, the call at `:3821`) | docs-links 5 of 5 |
| ARCHITECTURE (proposed) items | ckShare default `docs/ARCHITECTURE.md:2068` to `:2071`; pin page host deny check and hand-off `:2083` to `:2087` (the reconcile step re-took `src/loader/app.js:4525`, `denyChecker`) | |
| Stale threat row MAL A3 | `docs/THREAT-MODEL.md:249` (page host refuses a denied item; open: leaving a held item after a later deny, and `tools/pin.mjs`); the reconcile step re-took `app.js:4525` | |
| Counsel honesty clause | 15 lines: `CHANGELOG.md:136`, `:540`; `docs/ARCHITECTURE.md:1232`, `:1591` to `:1592`, `:1605`; `docs/CRITIQUE.md:255`; `docs/ROADMAP.md:74`, `:154`, `:200`, `:277`; `examples/social/README.md:25`, `:101` to `:102`; `docs/PUBLISH-CHECKLIST.md:411`; `docs/OPERATIONS.md:902` to `:903` (line numbers as the fixer wrote them) | |
| Checklist mailbox | `docs/PUBLISH-CHECKLIST.md:415`: GitHub private reporting and a security mailbox at a project domain (never bought) with `SECURITY-KEY.asc` (SECURITY.md:7 to :14); the mailbox's delivery is the owner's step | |
| Stale counts | `docs/RUNBOOK.md:37` to `:44` and `docs/CRITIQUE.md:177` to `:181`; the reconcile step then set `npm test` to 2,286 / 2,277 and said that E-SO-9 was fixed after the full runs | |

Suites: `node --test test/unit/docs-links.test.mjs` 08:32 ET 5 of 5; `npm test` 08:32 ET 2,281 tests, 2,272 pass, 0 fail, 9 todo.

## Reconcile step (this note's author)

| Item from verifier round 1 | What changed (file:line) | Result |
|---|---|---|
| V03-DESIGN-REVIEW 5.4.3 to 5.4.7 stale against the integration | 5.4.1: a second outcome table after the integration (140 fixed, 45 partial, 13 rejected, 1 refuted) with the 19 ids that moved; 5.4.2: "Finished by the integrator" with file:line for each; 5.4.3: rows of finished ids removed, STALK-2, PRIV-2, HON-2, HON-7, HUB-5, MAL53-3 and SCALE-9 rewritten to what is left; 5.4.4: DS-10 and SYB-18 marked applied; 5.4.5: a bullet after the integration and verifier round 1; 5.4.6: gate with the counts at the fix wave, after the integration and after verifier round 1; 5.4.7: items 1 to 3 rewritten, item 5 says the `'hub'` kind is built (docs/review/V03-DESIGN-REVIEW.md, section 5.4) | closed |
| E-SO-5 not re-run | `node test/e2e/run.mjs --only E-SO-5`, 09:23:02 to 09:26:15 ET: FAIL at "SEED-A opens Synthetic 01: its ledger from its cs= window, held on the hub lane" (40 s; role reader, lane held [], kind 'hub', torrent true); "PASS network policy: every request stayed on 127.0.0.1"; exit 1. D-1 is fixed, but since STALK-3 a page holds only the signed-in key's own ledger and the seeders are readers. Row text: `docs/deviations/integration-v03.md:364` | run; still open, new reason |
| E-SO-9B (the open half of E-SO-9), run because D-1 is fixed | `node test/e2e/run.mjs --only E-SO-9,E-SO-9B`, 09:26 to 09:29:25 ET: E-SO-9 PASS (108.9 s); E-SO-9B FAIL at "the post written offline reaches BO over the hub lane" (58 s; ADA's page after the offline reload is a reader and holds [] on the lane, BO follows and waits); network policy PASS; exit 1. Row text: `docs/deviations/integration-v03.md:368` | run; still open |
| INTEGRATION-STATUS finding counts | `docs/INTEGRATION-STATUS.md`, section "Review round R 5.3", bullet "The round": 203 finding records (199 distinct ids); the notes' status columns 126 fixed, 59 in part, 18 rejected (203 records); per id 121/62/15/1 at the fix wave and 140/45/13/1 after the integration | closed |
| Broken line citations | `docs/deviations/review-round.md` index table: identity :64 to :115, loader-ui :37 to :100, tests :64 to :89, tools :81 to :153, docs :65 to :147, firefox :114 to :121 (defects :90 to :112); V03-DESIGN-REVIEW 5.4.1 loader-ui :5 to :7 (was :121 to :123, also past the end), 5.4.6 loader-ui :112 to :113 (was :228), 5.4.7 tools :83 to :85 (was :227 to :229); `review-round-integration.md` section 1 and 2 lines into `src/loader/app.js` (`:4523`, `:3841`, `:3821`) | closed |
| Integration note requests not listed | `docs/deviations/review-round-integration.md` section 3: rows for tools R-SCALE-2-E2E (not applied: no `MW_E2E_TRACKER` in `test/e2e/lib.mjs`), tools R-MAL53-8 (deferred outline) and docs 15 (optional); "media R10" removed (the media note has R1 to R5; loader-ui R10 was already listed); a closing section "After verifier round 1" | closed |
| R 4.2 table | `docs/deviations/integration-v03.md`: E-MD-6 pass (integration Request 1; rows-media D-1 and D-2 fixed); E-SO-2, E-SO-9 and E-CH-7 cells name the fixes; E-SO-5 and E-SO-9 cells name the 09:23 and 09:26 runs; "In all: 64 rows, 60 that ran and passed (47 as written, 13 in part) and 4 open" (`:375`), repeated in INTEGRATION-STATUS and `docs/PUBLISH-CHECKLIST.md:800` | the `docs-claims` test reads both |
| INTEGRATION-STATUS top section | new bullet "Verifier round 1 fixes" with each fixer's suites and results; the R 4.2 bullet; the open bullet points at the fixes | closed |
| CHANGELOG | the counts sentence of the 0.3.0 entry and of "Changed in the review round" (140, 45, 13 after the integration); new bullet "Finished by the integrator of the round" (19 ids); the "Fixed in part" (45) and "Rejected" (13) lists; new bullet "Tests after verifier round 1"; known gaps: 13 rows in part, E-SO-5's new reason, E-SO-9B, the hub lane's `'hub'` kind, `pin --max-total` | closed |
| Line citations moved by the social fixer | `docs/INTERFACES.md:923` (`src/loader/app.js:3812`, `:3821`), `docs/ARCHITECTURE.md:2084` and `docs/THREAT-MODEL.md:249` (`src/loader/app.js:4525`) | closed |

Suites run by the reconcile step are in the last table below.

## Open items the fixers left, with reasons

| Item | Fixer | Reason |
|---|---|---|
| E-SO-1 "Create my page" step failed once (`sofix/run1.log`, 08:29 ET, "ADA: the new page opens: not reached within 20000 ms") | social | seen once in 17 runs of E-SO-1; that run's log shows two "engine rebuilt (online)" events from real `online` window events during the step; not reproduced, not investigated |
| WebKit and Firefox lanes of E-SO-2, E-SO-4 and E-CH-7 | social | only the Chromium runner ran; the fix is engine-independent (TorrentManager and example code), but `test:e2e:webkit` and `test:e2e:firefox` were not run again |
| The documents for the social rows | social | not its files; done by this reconcile step (rows-social.md is the lane's own record of 2026-10-22 and was left as written) |
| A commit containing the binding fix | binding | the brief said never commit; closed: the automatic checkpoints `fd3dfda` and `edbf552` track `test/unit/no-native-webrtc.mjs` and the three tests |
| Node 22 CI leg not run | binding | only Node v24.22.0 is installed; the `module.register` branch was forced on Node 24 (7 of 7), not run on a real Node 22 |
| The `web+lightweb:` scheme, the `LIGHTWEB_*` constants and the `lightweb-door(s)` kinds | rename | compatibility names by the brief; the owner or the integrator decides (rename-felinar.md:97 to :101, CHANGELOG.md:59). Closed in the extra wave: now `web+felinar:`, `FELINAR_*`, `felinar-door(s)` (section "Extra items" below; rename-felinar.md, "Request 1 applied") |
| Passkeys made before the change still show "Lightweb identity" | rename | the authenticator stores the label at creation; sign-in is unaffected (rpId unchanged); the person can rename it |
| MAL53-3 for the pin node | docs | code, not docs: the page host does not leave a held item after a later `_deny/`, and `tools/pin.mjs` `decide()` and `restore()` do not check `_deny/` (review-round-media.md:146 to :150). Built in the extra wave, except the node's own process check and the heartbeat lag (section "Extra items" below) |
| Line citations into `src/loader/app.js` may move | docs | re-taken by this reconcile step at 09:30 ET; they move whenever `app.js` changes above them |
| RUNBOOK and CRITIQUE counts after the social fixer | docs | adjusted by this reconcile step |
| E-SO-5 and E-SO-9B | reconcile | both fail on the rule that a page holds only its signed-in owner's ledger (STALK-3): E-SO-5's seeders are readers, and ADA's page is a reader after the offline reload. A request for the rows lane or the integrator: give the seeders the owners' keys or decide a rule for holding pages one follows (E-SO-5), and find why ADA is not signed in after the offline reload (E-SO-9B) |
| No full end-to-end suite and no `npm run test:browser` after the fixes | all | the fixers' briefs asked for `--only` runs; the per-browser totals in INTEGRATION-STATUS are still those of the second concurrent round (06:30 ET) |

## Suites run by the reconcile step

Times ET, 2026-10-24.

| Suite | Result |
|---|---|
| `node test/e2e/run.mjs --only E-SO-5` (09:23:02 to 09:26:15) | 0 passed, 1 failed (192.1 s); "PASS network policy: every request stayed on 127.0.0.1" |
| `node test/e2e/run.mjs --only E-SO-9,E-SO-9B` (09:26:15 to 09:29:25) | 1 passed (E-SO-9), 1 failed (E-SO-9B), 190.8 s; "PASS network policy: every request stayed on 127.0.0.1" |
| `node --test test/unit/docs-links.test.mjs` (09:35, after the edits and this note) | tests 5, pass 5, fail 0 |
| `node --test test/unit/docs-claims.test.mjs test/unit/docs-review-round.test.mjs` (the files `git grep -l INTEGRATION-STATUS test/unit` names; 09:35) | tests 25, pass 25, fail 0 |
| `npm test` (09:35:29 to 09:35:57) | exit 0; "lint-floor: 147 files, no APIs or syntax past the browser floor."; tests 2,286, suites 46, pass 2,277, fail 0, cancelled 0, skipped 0, todo 9 (the "failing tests" list after the summary holds only the 9 todo cases) |

## Suites to re-run

The next verifier runs these, in this order, after `export PATH=$HOME/.local/share/node/current/bin:$PATH`, from the
project root:

1. `npm test`
2. `npm run build`, then `node build.mjs --check-lock`
3. `npm run test:browser` (after the build)
4. The social and chat rows with `--only`, three times in a row:
   `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-9` and `node test/e2e/run.mjs --only E-CH-7`; then the open
   rows once each, expecting the failures recorded above until their request lands: `node test/e2e/run.mjs --only E-SO-5` and
   `node test/e2e/run.mjs --only E-SO-9,E-SO-9B`
5. The fresh clone of [PUBLISH-CHECKLIST.md](../PUBLISH-CHECKLIST.md) section 6, in a new empty directory outside the tree:
   `git clone <this repository> <dir>`, then in `<dir>`: `npm ci --no-audit --no-fund` (the tracked `.npmrc` keeps install
   scripts off) and `npm test`, expecting 0 failures and no "Cannot find module" in the log
6. `npm pack --dry-run` (lists the package files; nothing is published)
7. `npm run test:example`, `npm run test:fuzz`, `npm run build:idp`
8. The three full end-to-end suites, not run since these fixes: `npm run test:e2e`, `npm run test:e2e:webkit`,
   `npm run test:e2e:firefox`
9. After the extra wave (section "Extra items" below), if the full suites of item 8 have not already covered them: the door
   rows in Chromium, `node test/e2e/run.mjs --only DOOR-DOWN,DOOR-HASH,DOOR-GUEST` (with `--webkit` and `DOOR-GUEST-W`
   for WebKit too), and in Firefox, `node test/e2e/run.mjs --firefox --only F:DOOR-DOWN,F:DOOR-HASH,F:DOOR-GUEST,DOOR-GUEST-F`
10. The pin and pinwire unit files: `node --test test/unit/pinwire.test.mjs test/unit/tools-v03-pin.test.mjs
    test/unit/torrent-seed-lanes.test.mjs` (57 tests at 09:49 ET, all passing)
11. The full old-name grep: `git grep -n -i lightweb -- . ':!node_modules' ':!dist' ':!dist-idp' ':!.orchestration'
    ':!docs/research'`, expecting only history records (the "Renamed to felinar" section of CHANGELOG.md, `docs/deviations/`,
    `docs/INTEGRATION-STATUS.md`, `docs/PUBLISH-CHECKLIST.md:14`, `:17`, `:409`, `:412`) and the assertion message at
    `test/unit/cli-bin.test.mjs:86`; after `npm run build`, `grep -c -i lightweb dist/_mw/loader.js dist/_mw/door.json
    dist/_mw/door.webmanifest` prints 0 for each

Every end-to-end run must end with "PASS network policy: every request stayed on 127.0.0.1".

## By hand, before verifier round 2 (orchestrator, 2026-10-24 09:44 to 09:45 ET)

Two small changes made in the tree after the fix wave and before verifier round 2, so that round 2 measures them with the rest:

| Change | Files | Why | Checked |
|---|---|---|---|
| The `lightweb` alias command is dropped; `magnet-web` stays for one release | `package.json` (bin), `package-lock.json` and `npm-shrinkwrap.json` (root bin), `test/unit/cli-bin.test.mjs:86`, the command regexes in `test/unit/deploy-one-box.test.mjs:218`, `test/unit/repo-layout.test.mjs:173` and `test/unit/tools-install-scripts.test.mjs:25`, `docs/PUBLISH-CHECKLIST.md:17` and `:685`, `CHANGELOG.md:53-54`, `docs/deviations/rename-felinar.md` (table row) | Nothing was published under the old name, so the alias protects nobody, and it carries the name the project dropped for the pending class-42 mark | `node --test` on those unit files plus docs-links, docs-claims, tools-publish-doors and docs-review-round: 75 tests, 74 pass, 0 fail, 1 todo; `npm pkg get bin` lists `felinar` and `magnet-web`; `npm pack --dry-run`: 182 files, `bin/felinar.mjs` present; `npm ls` clean |
| Door-kit card text: the `web+felinar:` link opens where a door app is installed on desktop Chrome or Edge; Firefox, phones and Safari ignore it | `tools/publish.mjs:450` | It said "or Firefox", but Firefox desktop has no manifest handler (`docs/DEPLOY.md:1051`); found by the scheme fixer | `test/unit/tools-publish-doors.test.mjs` in the run above |
| The pin page host passes `discard` (request R4-a of `docs/deviations/review-round-media.md`): after a later deny makes the host leave a held item, its `pin-<ih>` and `pin-torrent-<ih>` stores are deleted | `src/loader/app.js` (`setupPinPage`, two lines after `isDenied`) | Closes O-3 of the pin fixer's note; `be().deleteName` exists (`src/files/store-idb.js:119`) | `node --test` pinwire, torrent-seed-lanes, tools-v03-pin and the full `npm test` (results in RUNS.log, 09:45 ET) |

The next verifier's `npm test`, `npm pack --dry-run` and the fresh clone (`npm ci` reads both lock files) cover these.

### After verifier round 2 (orchestrator, 2026-10-24 09:57 to 10:08 ET)

Round 2's checks part was NOT READY on three one-line document items, its spot part READY with four observations, and its suites part
NOT READY on three end-to-end items (those went to the second fix wave, `review-round-verify-2.md`). The document items and the
observations were closed by hand before the wave:

| Item | What changed | Checked |
|---|---|---|
| `docs/THREAT-MODEL.md:62` said the loader does not pass private follows yet (STALK-3) | the cell says a private follow is never named in HAVE because the loader passes the page's `{ private }` to `multi.follow` (`src/loader/personal-site.js:349`, `:424`) | docs-links, docs-claims and docs-review-round tests 30 of 30; the old phrase no longer occurs |
| `docs/THREAT-MODEL.md:63` said the "reason" CK policy is built but not the default (STALK-2, PRIV-2) | the cell says a neighbour gets this tab's signed CK only when there is a reason, the loader's default since the integration (`src/loader/api.js:2156`), and names the 90-day chat key as what remains | same |
| `docs/PUBLISH-CHECKLIST.md:409` still listed `lightweb` as a `bin` alias | "The old name `magnet-web` is only a `bin` alias (the `lightweb` alias went with the name)" | same |
| the R4-a `discard` wiring in `src/loader/app.js` had no test of its own (spot observation) | new `test/unit/pin-page-discard-wiring.test.mjs` pins the wiring in `setupPinPage` | passes on the tree, fails on a scratch copy with the `discard` line removed; `npm test` 2,291 tests, 2,282 pass, 0 fail, 9 todo |
| `docs/deviations/review-round-integration.md:64` cited `pinwire.js:614` (spot observation) | cites `:652` and the sweep at `:626-:637` | docs tests above |
| `docs/RUNBOOK.md:37` carried the round-1 unit count (spot observation) | 2,290 tests, 2,281 pass, 0 fail, 9 todo (after the extra wave) | docs tests above |

The spot part's last observation, that the E-CH-7 control step steers B's route choice by zeroing the bytes it counts for R's wire
(`test/e2e/scenarios-chat-rows.mjs:795-797`), is a harness device and was left as is.

## Extra items

Two fixers worked after this note's first reconcile step (the extra wave after verifier round 1, 2026-10-24, about 09:37
to 09:44 ET), and a second reconcile step brought the documents in line at 09:45 to 09:50 ET (times from
`TZ=America/Toronto date`). No commit was made.

| Item | Fixer | What changed (file:line) | Suites and results |
|---|---|---|---|
| Rename Request 1: the never-published `web+lightweb:` scheme and the `lightweb-door` and `lightweb-doors` kinds (the open row "The `web+lightweb:` scheme..." above) | scheme | Scheme `web+felinar:`: `src/common/pointer.js:70` (`FELINAR_SCHEME`), `:1179` and `:1180` (`FELINAR_PREFIX_RE`, `FELINAR_ENCODED_PREFIX_RE`, encoded form `web%2bfelinar%3a`); the door manifest's handler `build.mjs:621`; the door kit card `tools/publish.mjs:450`; the loader's paste and import uses in `src/loader/app.js` (import `:52`) and `src/loader/ui.js:511`. Kinds: `felinar-door` at `src/loader/doors.js:47` (`DOOR_JSON_KIND`) and `build.mjs:648`, `tools/check-site.mjs:28`; `felinar-doors` at `tools/publish.mjs:1680`. No old form is read. Tests `common-pointer`, `loader-doors`, `tools-publish-doors`; the documents DEPLOY, FAQ, ARCHITECTURE, INTERFACES, ROADMAP, DEMO-RESULTS and `deviations/doors.md`; `CHANGELOG.md:62` to `:63` ("Renamed with the project"); `rename-felinar.md`, section "Request 1 applied" | the three unit files 84 of 84 (09:39); `npm test` 2,286 tests, 2,277 pass, 0 fail, 9 todo (09:39; a first run a minute earlier failed once on `docs/PUBLISH-CHECKLIST.md`, which another fixer was editing); `npm run build` exit 0, build `b33f182a92d1`, `dist/_mw/door.json` kind `felinar-door`; `node test/e2e/run.mjs --webkit --only DOOR-DOWN,DOOR-HASH,DOOR-GUEST,DOOR-GUEST-W` 4 passed, 0 failed (DOOR-DOWN, DOOR-HASH, DOOR-GUEST in Chromium, DOOR-GUEST-W in WebKit); `node test/e2e/run.mjs --firefox --only F:DOOR-DOWN,F:DOOR-HASH,F:DOOR-GUEST,DOOR-GUEST-F` 4 passed, 0 failed (all four in Firefox); both 09:40 and each ending "PASS network policy: every request stayed on 127.0.0.1" |
| MAL53-3, pin page host: leave an item already held when a later `_deny/` entry names it (the open row "MAL53-3 for the pin node" above) | pin | `src/loader/pinwire.js:607` (`createPinPageHost`): each held item's infohash and declared SHA-256 (`:610` to `:611`); `start()` checks a held item again and leaves it (`:648` to `:653`, answers `'denied'`); `sweep()` leaves every held item the ledger now denies (`:626` to `:637`); `status()` starts one background sweep at a time (`:687` to `:691`), and `tools/pin.mjs` reads `status()` every 2 s, so the page leaves within about 2 s; a check that throws is not a deny (`:615`); the optional `discard(ih)` runs after a deny leave (`:604`, `:624`) | `node --test test/unit/tools-v03-pin.test.mjs test/unit/pinwire.test.mjs` 35 of 35; new tests `test/unit/pinwire.test.mjs:480`, `:490`, `:516`; `npm test` 2,290 tests, 2,281 pass, 0 fail, 9 todo (09:44); no end-to-end run |
| MAL53-3, pin node: `decide()` and `restore()` check `_deny/` | pin | `tools/pin.mjs:349` (`FilePins` takes `isDenied`), `:369` to `:379` (`_denied`: the infohash, the declared and the measured SHA-256), `:382` to `:385` (`_quarantineDenied`, log line `ledger-denied`); `decide('accept')` quarantines a denied item and never pins or seeds it, and the size cap does not hide the deny (`:465` to `:476`); a seeder `start()` answering `'denied'` quarantines too (`:483` to `:486`); `restore()` quarantines every pinned item the ledger now denies before it seeds anything, also while the month cap holds (`:504` to `:508`, `:512` to `:515`) | new test `test/unit/tools-v03-pin.test.mjs:559`; suites as the row above |
| Records | pin, reconcile | `docs/deviations/review-round-media.md`, "R4 outcome", "Still open after R4" and "Requests" (pin fixer). This reconcile step: `docs/THREAT-MODEL.md:249` (MAL A3), `docs/ARCHITECTURE.md:2083` to `:2094`, `docs/SECURITY-MODEL.md:257`, `docs/review/V03-DESIGN-REVIEW.md:1896` and `:1998` to `:1999` (5.4.3 and 5.4.7), `CHANGELOG.md` (the "Fixed in part" list and the bullet "Extra wave after verifier round 1"), `docs/INTEGRATION-STATUS.md` (bullet "Extra wave after verifier round 1" in the top section, and the rename fixer's grep line), `docs/deviations/rename-felinar.md` (the kept-names rows for the scheme and the kinds, Request 1 marked closed, the "still open" sentence of "Request 2 applied"), and the two open rows above | `node --test test/unit/docs-links.test.mjs` 5 of 5 (09:48); `node --test test/unit/docs-claims.test.mjs test/unit/docs-review-round.test.mjs` 25 of 25 (09:48); `npm test` (09:49:01 to 09:49:29) exit 0, lint floor clean (147 files), 2,290 tests, 47 suites, 2,281 pass, 0 fail, 0 cancelled, 0 skipped, 9 todo; `node --test` pinwire, tools-v03-pin and torrent-seed-lanes 57 of 57 (09:49) |

Open after the extra wave, with reasons:

| Item | Fixer | Reason |
|---|---|---|
| O-1: the pin node's Node process has no deny check of its own; it learns of a deny only from the page host's `'denied'` answer. An offline `--approve` of a denied item pins it on disk until the running node's next status tick (`startMissing`, once per `--interval`, 60 s by default), and while the month cap holds a denied item stays pinned on disk (not seeded, not in the heartbeat) until the month ends | pin | `window.__mwPinHost` exposes only `start`, `stop` and `status` (`src/loader/app.js:4537` to `:4545`), which is not the pin lane's file; request R4-b (review-round-media.md, "Requests") asks for a read-only `denied(id)` there and `isDenied` in `runPin` through `page.evaluate`; not applied |
| O-2: the signed heartbeat can list a denied item for up to one `--interval` after the page has left it | pin | `createPinHost` `observe()` does not drop an item from its complete set when the page stops listing it; the brief limited the change to `decide()`, `restore()` and the page host |
| O-3: a left item's bytes stayed in the pin's browser profile | pin | closed by hand by the orchestrator (request R4-a): `src/loader/app.js:4527` passes `discard`, which deletes `pin-<ih>` and `pin-torrent-<ih>` (the row above this section) |
| The door-kit card said the `web+felinar:` link opens in Firefox | scheme | closed by hand by the orchestrator: `tools/publish.mjs:450` now names desktop Chrome or Edge only (section "By hand, before verifier round 2") |
| No full end-to-end suite, no `npm run test:browser` and no end-to-end run of the pin change | all | the briefs asked for `--only` door rows (scheme) and unit tests (pin); items 8 to 11 of "Suites to re-run" cover them |
