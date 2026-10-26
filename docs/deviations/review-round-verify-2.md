# Review round R 5.3: fixes after verifier round 2 (2026-10-24)

Written by the reconcile step on 2026-10-24 between 10:44 and 10:55 ET (times from `TZ=America/Toronto date`). Verifier round 2
checked the tree after the first fix wave, the extra wave and the orchestrator's by-hand items (checkpoint `185a035`; record in
[review-round-verify-1.md](review-round-verify-1.md)). Its checks part was not ready on three document lines and its spot part
was ready with four observations; the orchestrator closed all seven by hand before this wave (review-round-verify-1.md, "After
verifier round 2"). Its suites part (10:22 ET) was not ready on three end-to-end items: `npm run test:example` 185 of 186, E-SO-4
passing only with E-SO-3 in the selection, and E-SO-5 and E-SO-9B still failing. Three fixers then worked in parallel from about
10:16 to 10:43 ET: social (the three suites items), rename (the checklist's `lightweb` alias line) and docs (THREAT-MODEL STALK-3
and STALK-2 cells, stale counts, the checklist's repeated blocks). No `src/` or `examples/` code changed. The fixers made no
commits; the automatic checkpoints `5e2c547` (10:01), `6a08778` (10:16), `053d851` (10:31) and `489bb8d` (10:46, the last
E-SO-9B edit) carry their edits. This step's document edits are in the working tree, for the next checkpoint. Nothing was pushed, tagged or published, and every browser run stayed on 127.0.0.1.

## Social fixer

| Item | What changed (file:line) | Suites and results |
|---|---|---|
| `npm run test:example` 185 of 186: the composer test expected the textarea cleared before the own post showed | Test only. Since E-SO-9's fix the own post shows from the data layer's change (`examples/social/js/model.js:286` to `:296`, `timelineTop`, used at `examples/social/js/views/timeline.js:77`) before `addPost` resolves; the composer clears in its submit handler after the write resolves (`examples/social/js/views/composer.js:140`), and the mock holds the write for `writeDelay` (`test/example/mock-sdk.js:177`). The test now waits for the clear: `test/example/social-browser.test.mjs:105` to `:108` (`waitFor` at `:107`). No app change | `npm run test:example` 186 of 186 (10:42:34 to 10:43:06 ET) |
| E-SO-4 passed only with E-SO-3 in the selection | When E-SO-3's two follows are missing, E-SO-4 makes them by link: ADA follows BO (`test/e2e/scenarios-social-rows.mjs:241` to `:243`), CY follows only ADA and waits for "Hello from Ada" (`:244` to `:250`); the check uses `data.idOfLabel` and `isFollowing` (`:240`; `examples/social/js/data.js:40`, `:226`). With E-SO-3 selected both checks are true and the steps are skipped. The verifier missed that ADA's follow of BO, which E-SO-4's last step needs, also happens only in E-SO-3 | `--only E-SO-1,E-SO-2,E-SO-4` 3 passed, three runs (10:29:47, 10:31:39, 10:33:39 ET); both new steps ran in the first run (107.1 s and 107.7 s) |
| E-SO-9B failed: the post written offline never reached BO | Harness. The offline reload of E-SO-9 signs ADA out, because the plan's "Stay signed in" is off (`test/e2e/idp-driver.mjs:9`, `:72`) and the loader restores only a stay-signed-in key (`src/loader/app.js:3393` to `:3394`); since STALK-3 a signed-out page holds nothing on the hub lane (`holdOwnLedger`, `src/loader/app.js:3841`). ADA now signs in again once online, as a person would; the step asserts role `owner` and her ledger in `inspect().hubLane.held` (`test/e2e/scenarios-social-rows.mjs:606` to `:615`); holding after a sign-in already exists (`src/loader/app.js:3554`). Comments and title: `:16`, `:33`, `:597` to `:601`. Still runs only when named (`SOCIAL_ROWS_ORDER`, `:34`) | `--only E-SO-9,E-SO-9B` 2 passed, three runs (10:35:40, 10:38:15, 10:40:36 ET; 115.1 s, 140.2 s, 118.2 s); BO got the post within the step in which his page reopened |
| Required gate: the five social rows | No change beyond the rows above. The hub lane stays kind `'hub'` (`src/loader/app.js:3821`; the attach passes `kind: lane.kind` at `:3826`), so SCALE-6 is not downgraded | `--only E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-9` 5 passed, three runs in a row (10:21 to 10:24, 10:25:04 to 10:27:56, 10:27:56 to 10:29:47 ET; 133.1 s, 171.7 s, 111.3 s) |

Every end-to-end run of the social fixer (9 of 9) ended with "PASS network policy: every request stayed on 127.0.0.1" and exit
0. `npm test` (10:43:06 to 10:43:34 ET): exit 0, lint floor clean (147 files), 2,291 tests, 47 suites, 2,282 pass, 0 fail, 9
todo. Logs: the session scratchpad's `sofix2/` (five1-3, so4alone1-3, so9b1-3, example, npmtest). The first E-SO-9B run used the
old row title; only comments and the title changed between it and the other two.

## Rename fixer

| Item | What changed (file:line) | Suites and results |
|---|---|---|
| The checklist still listed `lightweb` as a `bin` alias | Nothing to change: `docs/PUBLISH-CHECKLIST.md:409` already reads "The old name `magnet-web` is only a `bin` alias (the `lightweb` alias went with the name)", from the orchestrator's by-hand edit (checkpoint `5e2c547`, found with `git log -S`); it agrees with `package.json:30` to `:33`, `docs/PUBLISH-CHECKLIST.md:17`, `CHANGELOG.md:54` and `test/unit/cli-bin.test.mjs:86` | `npm test` 10:22 ET exit 0: 2,291 tests, 2,282 pass, 0 fail, 9 todo |
| Passkey `RP_NAME` and `DEFAULT_NICKNAME` | Already 'felinar identity' (`src/idp/passkey.js:26`, `:27`, header `:4`); existing passkeys keep working: the name is sent only at create (`:120`), get asks by rpId alone (`:154`), the rpId is the host name (`:38`) | `npm run build` 10:23 ET exit 0: 21 files, 2,737 KiB, build a40b9601949c (esbuild 0.28.2) |
| Old name in `src/` and `test/` | `git grep -n -i lightweb -- src test` prints one line, the alias assertion at `test/unit/cli-bin.test.mjs:86` | as above |
| Record | Appended "Verifier round 2: the `lightweb` bin alias in the publish checklist" to the end of [rename-felinar.md](rename-felinar.md) | |

`npm run test:browser` was not run (the brief left it to the next verifier).

## Docs fixer

| Item | What changed (file:line) | Suites and results |
|---|---|---|
| `docs/THREAT-MODEL.md:62` (STALK-3) | Already right in the tree (checkpoint `5e2c547`): a private follow is never named in HAVE, because the loader passes the page's `{ private }` to `multi.follow` (`src/loader/personal-site.js:349`, `:424`; `:419` reads `params.opts.private`) | `node --test test/unit/docs-links.test.mjs` 5 of 5 (10:24 ET) |
| `docs/THREAT-MODEL.md:63` (STALK-2, PRIV-2) | The earlier by-hand edit had left the clause about the 90-day chat key twice; the repeat is removed. `src/loader/api.js:2156` passes `ckShare: 'reason'` | `node --test test/unit/docs-claims.test.mjs test/unit/docs-review-round.test.mjs` 25 of 25 (10:24 ET) |
| Stale counts | `docs/RUNBOOK.md:44` to `:45` named where the `npm test` count comes from; `docs/CRITIQUE.md:177` became 2,281 of 2,290 (this reconcile step then set both to 2,291 and 2,282, below) | `npm test` 10:24 ET exit 0: 2,291 tests, 2,282 pass, 0 fail, 9 todo |
| PUBLISH-CHECKLIST blocks against the sequence of `:86` | Not edited: 12 of 16 section blocks match their copies in the sequence byte for byte (`:661`, `:857`, `:970`, `:1021`, `:1034`, `:1047`, `:1064`, `:1097`, `:1130`, `:1152`, `:1166`, `:1326`); the four that differ were already so at checkpoint `185a035` | step 1b second search: 153 lines; THREAT-MODEL :62 and :63 no longer make the old claims; `:104` (PTR-10) is still true (deferred, review-round-integration.md:78) |

## Reconcile step (this note's author)

| Item | What changed (file:line) | Result |
|---|---|---|
| R 4.2 rows and totals | `docs/deviations/integration-v03.md`: the E-SO-4 cell says it no longer needs E-SO-3; the E-SO-9 row is "pass" with the cause of E-SO-9B's earlier failure and its 3 of 3; "In all: 64 rows, 60 that ran and passed (48 as written, 12 in part) and 4 open" with a note on the change (`:375`). The social fixer's request said the open-row count drops from 4 to 3; it does not, because E-SO-9B is a scenario inside row E-SO-9, not a row of its own. The 4 open rows stay E-FI-4, E-SO-5, E-SO-10 and E-SO-13 | `docs-claims` reads the line and INTEGRATION-STATUS |
| INTEGRATION-STATUS | New bullet "Verifier round 2 fixes" at the top of section "Review round R 5.3", with each fixer's suites and the counts the verifier disputed; the R 4.2 bullet (48 and 12, and why) | closed |
| Checklist counts | `docs/PUBLISH-CHECKLIST.md:800` (48 as written, 12 in part); `:628` to `:630`: E-SO-9's cause was found and fixed, and the current unit and example counts (the docs fixer's open item on `:622`) | closed |
| V03-DESIGN-REVIEW 5.4.5 to 5.4.7 | 5.4.5: a bullet "After verifier round 2"; 5.4.6: the counts after verifier round 2 and that no full suite or `npm run test:browser` has run since the fixes of either round; 5.4.7 item 3: E-SO-9B passes, E-SO-5 open. 5.4.1 to 5.4.4 need no change: no finding changed status in this round | closed |
| CHANGELOG | New bullet "Tests after verifier round 2"; known gaps: 12 rows in part, and the E-SO-9B sentence says the post reaches a follower once its author signs in again | closed |
| Index and integration notes | `docs/deviations/review-round.md` (last section) points here; `docs/deviations/review-round-integration.md`, new section "After verifier round 2" with the citations and the two requests below | closed |
| RUNBOOK and CRITIQUE counts (docs fixer's open item) | `docs/RUNBOOK.md:37` 2,291 tests, 2,282 pass (after verifier round 2); `:44` to `:45` names the 10:43 ET source of `npm test` and `npm run test:example`; `docs/CRITIQUE.md:177` 2,282 of 2,291 | closed |
| `CHANGELOG.md:538` (fresh clone 2,281 and 2,272) | Left: it is the count of one recorded run, the fresh clone of verifier round 1, and says so | no change |

## Open items the fixers left, with reasons

| Item | Fixer | Reason |
|---|---|---|
| E-SO-5 still fails at "SEED-A opens Synthetic NN: its ledger from its cs= window, held on the hub lane" (`test/e2e/scenarios-social-rows.mjs:445` to `:456`); not re-run this round | social | Not a harness ordering bug. The 20 pages are made by the tools with raw key pairs (`test/e2e/hub-stack.mjs:126` to `:168`) and the seeders open them signed out; since STALK-3, `holdOwnLedger` (`src/loader/app.js:3841`) holds only the signed-in owner's page. Closing it needs (a) a way to sign each seeder in with a synthetic owner's key (the identity origin issues passphrase identities; the e2e driver has no import path for tool-made keys) or (b) a product rule for holding pages one opens or follows, which reverses part of STALK-3's privacy choice. A decision for the integrator or the owner (PUBLISH-CHECKLIST step 1b) |
| Whether E-SO-9B joins the default `SOCIAL_ROWS_ORDER` (`test/e2e/scenarios-social-rows.mjs:34`) | social | An integrator decision; it would change the full suites' scenario counts in RUNBOOK, CRITIQUE, the checklist and INTEGRATION-STATUS. Until then the full suites do not run E-SO-9B, and row E-SO-9 counts as written on the strength of the `--only` runs |
| WebKit and Firefox lanes of E-SO-4 and E-SO-9B | social | Only the Chromium runner ran, as the brief's gate asked. The changes are harness steps (follow by link, sign in again) that use driver calls those rows already use in the other engines; `test:e2e:webkit` and `test:e2e:firefox` were not run |
| The documents for this round | social, rename | Not their files; done by this reconcile step |
| `docs/PUBLISH-CHECKLIST.md:870` to `:878` (section 11, the squash) differs from its copy in sequence step 6 (around `:207` to `:209`): the sequence first runs a fresh-clone check, section 11 lists the git lines one by one | docs | Older than this run (already so at `185a035`); making them match is a content decision for the orchestrator. The other three differences (`:546` sets OWNER again, `:713` adds `npm test`, `:743` sets TAG_DATE again) look intended |
| `npm run test:browser` and the three full end-to-end suites | all | Not run since the fixes of either verifier round; the briefs asked for `--only` runs. The per-browser totals in INTEGRATION-STATUS are still those of the second concurrent round (06:30 ET) |

## Suites run by the reconcile step

Times ET, 2026-10-24, after every edit above.

| Suite | Result |
|---|---|
| `node --test test/unit/docs-links.test.mjs` (10:49:30) | tests 5, pass 5, fail 0 |
| `node --test test/unit/docs-claims.test.mjs test/unit/docs-review-round.test.mjs` (the files `git grep -l INTEGRATION-STATUS test/unit` names; 10:49:30) | tests 25, pass 25, fail 0 (the R 4.2 check reads 48 and 12 in `integration-v03.md:375` and in INTEGRATION-STATUS) |
| `npm test` (10:49:36 to 10:50:04) | exit 0; "lint-floor: 147 files, no APIs or syntax past the browser floor."; tests 2,291, suites 47, pass 2,282, fail 0, cancelled 0, skipped 0, todo 9 |

The reconcile step ran no browser or end-to-end suite.

## Suites to re-run

The next verifier runs these, in this order, after `export PATH=$HOME/.local/share/node/current/bin:$PATH`, from the
project root:

1. `npm test` (expect 2,291 tests, 2,282 pass, 0 fail, 9 todo, and the lint floor clean)
2. `npm run build`, then `node build.mjs --check-lock`
3. `npm run test:browser` (after the build; expect 42 tests, 41 pass, 1 skipped)
4. `npm run test:example` (expect 186 of 186)
5. The social rows with `--only`, three times in a row each:
   `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-9`;
   `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-SO-4` (E-SO-4 without E-SO-3);
   `node test/e2e/run.mjs --only E-SO-9,E-SO-9B`;
   then once, expecting the failure recorded above until a decision lands: `node test/e2e/run.mjs --only E-SO-5`.
   The sets verifier round 2 ran in the other runners, not run again this round: `node test/e2e/run.mjs --webkit --only
   E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-9` and `node test/e2e/run.mjs --firefox --only E-SO-1,E-SO-2,F:E-SO-1` (the social rows
   scenarios themselves are Chromium only, `test/e2e/scenarios-social-rows.mjs:4`; F:E-SO-2 stays out of `--firefox`)
6. `node test/e2e/run.mjs --only E-CH-7` three times (fixed after verifier round 1; not touched in this round)
7. The fresh clone of [PUBLISH-CHECKLIST.md](../PUBLISH-CHECKLIST.md) section 6, in a new empty directory outside the tree:
   `git clone <this repository> <dir>`, then in `<dir>`: `npm ci --no-audit --no-fund` (the tracked `.npmrc` keeps install
   scripts off) and `npm test`, expecting 0 failures and no "Cannot find module" in the log. The fixers' test edits are
   committed (checkpoint `489bb8d`); this step's document edits reach a clone only after the next checkpoint
8. `npm pack --dry-run` (lists the package files, 182 at verifier round 2; nothing is published)
9. `npm run test:fuzz` and `npm run build:idp`
10. The three full end-to-end suites, not run since the fixes of either verifier round: `npm run test:e2e`,
    `npm run test:e2e:webkit`, `npm run test:e2e:firefox`
11. The documents: `node --test test/unit/docs-links.test.mjs` and
    `node --test test/unit/docs-claims.test.mjs test/unit/docs-review-round.test.mjs` (the files `git grep -l INTEGRATION-STATUS
    test/unit` names)

Every end-to-end run must end with "PASS network policy: every request stayed on 127.0.0.1".
