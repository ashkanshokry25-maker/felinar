# Domain independence: integration (2026-10-25)

Written by the integrator of the independence round on 2026-10-25 between 09:55 and 10:40 ET (times from
`TZ=America/Toronto date`), after the three fixers: code (IND-10 to IND-12, [independence-code.md](independence-code.md)),
release documents (IND-2 to IND-6, [independence-release-docs.md](independence-release-docs.md)) and design documents (IND-1,
IND-7 to IND-9 and SZ-3, [independence-design-docs.md](independence-design-docs.md)). The plan is the independence design memo
(`.orchestration/reports/independence-design-2026-10-25.md`, not tracked), which answers the owner's request of 2026-10-25:
no bought domain, and the project made domain independent. Nothing was committed, pushed or published; the checkpoint loop
carries the edits. Every run stayed on 127.0.0.1. Every edit to a shared file was an exact-string replacement.

## 1. The fixers' requests, applied

Line numbers are those after the edit.

| From | Request | Applied (file:line) | Check |
|---|---|---|---|
| code, 1 | `check-site` gave "is not a public DNS name" for a hosting-platform name | `tools/check-site.mjs:38` imports `isNoTxtPlatformName`; `:515` to `:518`: a middle branch, "<name> is on a hosting platform where no user can publish a TXT record (github.io, netlify.app, pages.dev and others)" | `test/unit/tools-check.test.mjs:871` to `:872`: the IND-10 case now also matches `/hosting platform/` and refuses "is not a public DNS name" for alice.github.io, my-site.netlify.app, project.pages.dev and a ts.net name; the generic case (127.0.0.1, `:886`) keeps the old reason |
| code, 2 | one CHANGELOG heading for the round | `CHANGELOG.md`, "Changed for domain independence (2026-10-25)": the docs rows IND-1 to IND-9, SZ-3, the check-site change and the Tests bullet went under the code fixer's heading; no second heading | read |
| release docs, 1 | `tools/verify-release.mjs` still said "a place the repository owner does not control" | `:12` to `:13` (header comment), `:263` (the no-key-built-in warning) and `:460` (`sign` prints "pin this public key in PINNED_RELEASE_KEYS (tools/verify-release.mjs), README.md and SECURITY.md, and put it in the second places SECURITY.md names") | `tools-v03-release.test.mjs:335` still matches "no release key built in yet"; `verify-release-anchor.test.mjs` 9 of 9 |
| release docs, 2 | the same wording in the workflows | `.github/workflows/release.yml:28` to `:29` (header), `publish-site.yml:70` ("its second places"); the release notes template gains a line for `release-key.txt` and `release-key.txt.asc`, which step 10b uploads (`release.yml`, the `files` block). Also the same stale phrase in `SECURITY.md:135` (the release row of the security program) and `:141` ("announce it through the second places"), which no request named | `git grep` for "does not control", "second place you do not control" and "through the second place" finds no tracked line outside the review history |
| release docs, 3 | `pages-demo.yml:99` error string; an optional guard | The error string now names a repository named `<owner>.github.io` first (no domain needed), then a domain the owner holds, then `MW_DEMO_ORIGIN`. The guard is not applied: `if: vars.MW_DEMO_ORIGIN != '' \|\| <repository>.github.io` would also skip a repository that uses a domain of its own and lets the Pages API report the origin, a route the workflow's header still documents; step 8's `gh workflow disable pages-demo.yml` covers the felinar repository | `tools-review-requests.test.mjs:46` (pages-demo `npm ci` line) unchanged |
| release docs, 4 | the SUP-3 todo now passes | `test/unit/tools-review-requests.test.mjs:28` to `:30`: no `todo` option; the title says what it asserts ("signs only with --rebuilt and verifies with --expect-version"); the attestation flags of the checklist's `gh attestation verify` lines stay with the R-SUP-2b todo. Also the two `release.yml` header lines that R-SUP-3 names (`:24`, `:26`) now show `sign --rebuilt` and `verify --expect-version <v> --expect-tree dist`, and [review-round-tools.md](review-round-tools.md) records R-SUP-3 as applied | the file: 8 tests, 1 pass, 7 todo; `npm test` todo count 9 to 8 |
| release docs, 5 | a CHANGELOG known gap on the limits of the second places | `CHANGELOG.md`, Known gaps, "Domain independence": the second places protect against a takeover of the GitHub account, not against the owner; 0.3.0 has no earlier release that carries the key; the step 10b `gpg` lines have not run; private reports depend on GitHub alone (O2); the hosting-platform list is an inference until `dig`; `tools/seeder.html` keeps the bundle defaults (L-14) | read |
| release docs, 6 | `docs/PUBLISH-CHECKLIST.md:1263` "the security mailbox decision" | now "the security reporting decision" (the line moved to `:1293`) | `docs-domain-free`, `docs-review-round` pass |
| design docs, 1 | the DoH row of DEPLOY's "What you need" had four cells | `docs/DEPLOY.md:31`: fifth cell, "a resolver the site names with `<meta name="mw-doh">`; a site with no DNS pointer needs none, because its page tag is the pointer" | `docs-links` passes |
| design docs, 2 | 16.6's second item and its search should be conditional | `docs/PUBLISH-CHECKLIST.md:1398` to `:1407`: "Only if you later run a shared default"; the places to change are the "By design, the project hosts no identity page" sentences and the changelog's N-2 gap; the search now also finds `project hosts no identity page` (in 0.3.0 it finds only those sentences) | HON-4 (`docs-review-round.test.mjs:85`) passes; run by hand at 10:33 ET, the search lists the "by design" sentences of the README, CHANGELOG, DEPLOY, FAQ and QUICKSTART, the two recipes README cells, the README's `--idp https://<` line and the CHANGELOG's HON-4 history line; PRIVACY's sentence wraps over a line break and is not matched, but the item names PRIVACY's register row by hand |
| design docs, 3 | `docs/recipes/README.md:70` to `:71` said "no default identity origin exists yet (owner decision N-2)" | both cells: "the project hosts no identity page, by design (owner decision N-2)" | `git grep` for the old "yet" wording finds only the search line of 16.6 and HON-4's refusal |
| design docs, 4 | ARCHITECTURE section 8 said SZ-1 to SZ-6 are unsigned | `docs/ARCHITECTURE.md:853`: "SZ-1, SZ-2 and SZ-4 to SZ-6 (15.11) are unsigned (SZ-3, the record lifetime, was accepted on 2026-10-25)". `:916` to `:929` name SZ-1 and SZ-2 only, which stay unsigned: unchanged. The same sentence in `docs/ROADMAP.md:189` | read |
| design docs, 5 | `docs/WHY.md:425` "A site with no domain and no sign-up" | the row is now "A site with no domain", and its price cell says the name needs no sign-up but the server is rented under an account its provider can close (GitHub Pages is an account too) | read |
| design docs, 6 | `tools/ship.mjs:9` comment | `:9` to `:10`: the name costs nothing and needs no sign-up, but the server is rented under an account its provider can close (Z1) | lint floor clean |
| design docs, 7 | `docs/research/v03/S2-zero-setup-hosting.md:264` keeps the old Z1 | not changed: the research documents are history, and the test (`tools-ship.test.mjs:201`) pins the new Z1 | none |

## 2. Suites (2026-10-25)

Logs in `.orchestration/logs/independence/` (not tracked), one file per run, each ending with an `EXIT <code> <start>-<end>`
line. The fresh clone and the end-to-end runs used checkpoint `0507946` (10:01 ET), which holds every code and test change of
the round, including section 1's; only documents changed after it.

| Suite | Log | Result |
|---|---|---|
| `npm test`, 10:00:00 to 10:00:28 | `npm-test.log` | lint floor "147 files, no APIs or syntax past the browser floor"; 2,314 tests, 2,306 pass, 0 fail, 8 todo |
| `npm run build`, 10:00:40 | `build.log` | exit 0, build 976caba51866 |
| `node build.mjs --check-lock`, 10:00:40 | `check-lock.log` | exit 0: the vendored bundle and its five patches match `build.lock.json` |
| `npm run test:browser`, 10:00:49 to 10:01:00 | `test-browser.log` | 42 tests, 40 pass, 1 fail, 1 skipped: the door view in WebKit read `window.__module` as `undefined` where 42 was expected (`test/unit/loader-doors-browser.test.mjs:51`) |
| the door view alone, three times, 10:01 | `alone-doors-browser-1.log` to `-3.log` | 1 of 1 each time |
| `npm run test:browser` again, 10:01:57 to 10:02:08 | `test-browser-2.log` | 42 tests, 41 pass, 0 fail, 1 skipped (the v0.1 worker test) |
| `npm run test:example`, 10:01:00 to 10:01:32 | `test-example.log` | 186 tests, 186 pass |
| `npm run test:fuzz`, 10:02:18 to 10:02:25 | `test-fuzz.log` | "PASS: 30000 inputs in 6.4 s, 0 violation(s), 6 note(s), seed 936938904" |
| `npm run build:idp`, 10:02:25 | `build-idp.log` | exit 0, build id 9d6a24e3eb7f, bundle sha256 67a742cd3a0df06606fe7421421a540973aec8d1d7dc58a0186d8a16d364ea01 |
| `npm pack --dry-run`, 10:02:25 | `pack-dry-run.log` | exit 0: `felinar-0.3.0.tgz`, 182 files, 1.3 MB packed, 4.6 MB unpacked |
| Fresh clone (PUBLISH-CHECKLIST section 6), 10:02:59 to 10:03:31 | `fresh-clone.log`, `fresh-clone-extra.log` | `git clone` of `0507946` into an empty folder in the session's scratchpad: `npm ci --prefer-offline` 227 packages; `npm test` 2,314 tests, 2,306 pass, 0 fail, 8 todo; `npm run build` exit 0, build 976caba51866 (the same as the tree); the project-domain grep printed nothing (exit 1); `node tools/build-idp.mjs` build id 9d6a24e3eb7f. Removed afterwards |
| `npm run test:e2e`, 10:03:49 to 10:23:39 (concurrent) | `e2e-chromium.log` | "OK: 102 passed, 0 failed, total 1189.6s" |
| `npm run test:e2e:webkit`, 10:03:49 to 10:22:47 (concurrent) | `e2e-webkit.log` | "FAILED: 106 passed, 1 failed, total 1137.4s": E-MD-6 at 645.9 s, step "RA and RE, RA and RF: contacts, and a first message gets through", "RA reaches RF: not reached within 30000 ms" |
| `npm run test:e2e:firefox`, 10:03:49 to 10:27:55 (concurrent) | `e2e-firefox.log` | "OK: 140 passed, 0 failed, total 1445.9s" |
| `node test/e2e/run.mjs --webkit --only E-MD-6`, alone, 10:28:15 to 10:30:03 | `alone-webkit-E-MD-6.log` | "OK: 1 passed, 0 failed, total 108.4s" |
| `npm test` after the documents of section 3, 10:32:50 to 10:33:18 | `npm-test-final.log` | lint floor clean (147 files); 2,314 tests, 2,306 pass, 0 fail, 8 todo; exit 0 |

Every end-to-end run ended "PASS network policy: every request stayed on 127.0.0.1". Per-browser end-to-end totals after the
alone rerun: **Chromium 102 of 102, WebKit 107 of 107, Firefox 140 of 140.** The first-visit rows 7 and E-ZS-1 passed in all
three runs, W7 in the WebKit run and F7 in the Firefox run; no scenario opens a hosting-platform name.

No real failure was found, so no code changed after the runs. E-MD-6 missed the same wait at the same step under the same
load in the final full runs of 2026-10-24 and passes alone.

## 3. Documents updated with the counts

`docs/INTEGRATION-STATUS.md` (title line, release status, the new section "Independence round (2026-10-25)" at the top),
`CHANGELOG.md` (the round's bullets under "Changed for domain independence", its Tests bullet, the "Domain independence"
known gap, today's E-MD-6 miss in "Seen end to end"), `docs/RUNBOOK.md` (section 3 table and its note), `docs/CRITIQUE.md`
("Maturity") and the counts of `docs/PUBLISH-CHECKLIST.md` section 6.

## 4. Open, with reasons

- The WebKit door view (`test/unit/loader-doors-browser.test.mjs:51`) failed once in five runs: the test reads the module
  script's result as soon as the frame reports it rendered. It passed alone three times and in the full rerun. No file of
  the door view changed in this round (since the gate of 2026-10-24 only `src/loader/doh.js` changed under `src/`), so the
  read is not shown to be wrong code and was not changed; a fix would wait in the frame for the module's result.
- The `pages-demo.yml` guard (release docs, request 3): not applied, for the reason in section 1.
- The owner's `dig` check of each IND-10 zone (it leaves 127.0.0.1); until then the list is an inference, and the documents
  say so.
- The two `gpg` lines of step 10b have never run (no `gpg-agent` in the agents' sessions); never with the owner's key.
- Private security reports depend on GitHub alone until a second, project-only route exists (owner decision O2).
- The second places of the release key protect against an account takeover, not against the owner; 0.3.0 has no earlier
  release that carries the key.
- Every GitHub line the round added (the private-reporting check, `gh workflow disable`, the free demo route, the notes edit,
  the asset upload) has never run, like every GitHub step of the checklist.
- `tools/seeder.html:109` and `:162` build `new WebTorrent()` with the bundle's default STUN servers and trackers; it is an
  owner-side page, outside IND-11's `src/` guard; blanking the defaults is the memo's 0.3.x row L-14.
- Passkeys on `*.pages.dev`, `*.netlify.app` or `<user>.github.io`, and a browser's exact error for an IP RP ID, are not
  measured; the local door (`npx felinar dev`, then the link pasted into `/_mw/open.html`) was not run by hand.
- The open rows of the R 4.2 table are unchanged (E-SO-5, E-FI-4, E-SO-10, E-SO-13).

## 5. Pinned key: tests updated (2026-10-26)

Step 3b of [PUBLISH-CHECKLIST.md](../PUBLISH-CHECKLIST.md) pinned the release key on 2026-10-26 (`tools/verify-release.mjs:37`, not
changed here). With the key built in, 13 unit tests failed: each signs a fixture release list with a throwaway P-256 key and verifies
under that key, and the pinned key refuses a list signed by any other key, whatever `--pubkey` says (SUP-2, SUP-12;
`tools/verify-release.mjs:241`, `:254` to `:260`). The tests now pin their own fixture key. The pin, and what the command lines do,
are unchanged. Every edit was an exact-line edit; nothing was committed.

Two patterns:

- (a) In process, the fixture key is passed as the key to trust: the existing `pinnedKeys` option of `verifyRelease`, or
  `releasePinnedKeys`, a new internal option of `doorKit`, `checkLoaderRelease`, `publish` and `ship`, added because no existing
  option of theirs reached `verifyRelease`'s (`tools/publish.mjs:477` to `:478`, `:487`, `:502` to `:503`, `:531`, `:549`,
  `:554` to `:561`, `:1248`; `tools/ship.mjs:283`, `:313`, `:576`). No flag sets it: `--release-pinned-keys` is an unknown
  option to `publish.mjs` and `ship.mjs` (exit 2). A missing, empty or non-list value falls back to `PINNED_RELEASE_KEYS`, so the
  option can name the keys to trust but cannot turn the pin off.
- (b) On the command line, the test runs a copy of the tools in a temporary folder with its `PINNED_RELEASE_KEYS` line rewritten to
  the fixture key, or to `[]` where the test checks the message for a copy with no key built in, as
  `verify-release-anchor.test.mjs:45` to `:56` does. For `verify-release.mjs` the copy is its five-file module graph; for
  `publish.mjs` it is `tools/` and `src/`, with `node_modules` linked.

| Test | Where | Pattern |
|---|---|---|
| a good list passes | `tools-v03-release.test.mjs:62` | (a) |
| one changed byte fails | `:83` | (a) |
| the wrong key fails | `:102` | (a): the pinned key is the test's `releaseKey`, and the attacker's list still fails with reason `signature` ("another key than the pinned one", then "does not verify under the pinned key") |
| a changed list fails the signature | `:120` | (a) |
| extra and missing files fail | `:137` | (a) |
| the list is checked strictly | `:169` | (a) |
| command line: list, sign and verify work offline | `:235` | (b), helper `:213` to `:229`: verify runs from a copy pinned to the fixture key (`:249`); the wrong-key run from a copy pinned to the other key, so it still fails with `FAILED (signature)` (`:257` to `:258`); the no-key run from a copy with `[]` (`:268`). `list`, `sign`, the usage errors and `--help` still run the real tools |
| SEC-6: a genuine older signed release is refused | `:287` | (a), and (b) for its two command lines (`:308`) |
| SEC-5: a door kit with a changed `_redirects` | `:363` | (a), and (b) for its command line (`:389`) |
| doorKit: refuses unless every loader byte matches | `tools-publish-doors.test.mjs:210` | (a); the wrong-key case pins and gives the stranger's key, so it still fails with `(signature)` (`:231` to `:232`) |
| doorKit --door-site | `:239` | (a) |
| CLI: --door-kit runs without a site directory | `:253` | (b), helper `:177` to `:192`, run at `:257`; the usage-error run stays on the real tools |
| SUP-5: ship refuses a loader that is not this checkout's build | `tools-ship.test.mjs:1120` | (a), through `ship`, its loader check and the `publish` it runs (`:1126`, `:1129`, `:1133`) |

One more, not among the 13: `tools-ship.test.mjs:1138` ("SUP-5: publish --shell from the command line refuses ... a changed byte
with it") still passed with the key pinned, but its pattern `/does not match the signed release list/` matched the `(key)` refusal,
not the changed byte. Its tampered run now uses a copy pinned to the fixture key, (b) with the helper at `:1082` to `:1097`, and the
test asserts `(files)` (`:1149` to `:1153`).

Runs on 2026-10-26: `node --test` on the three files, 79 tests, 79 pass (66 pass and 13 fail before); `npm test`, 11:35:24 to
11:35:54 ET, lint floor clean (147 files), 2,314 tests, 2,305 pass, 0 fail, 1 skipped (the IND-6 release-notes test: "0.3.0 is
dated already"), 8 todo; `npm run test:example`, ended 11:36:51 ET, 186 tests, 186 pass.
