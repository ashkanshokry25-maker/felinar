# v0.3 fix: the verifier's findings on the 0.3.0 tree

The v0.3 code review (four lenses, 84 findings) was fixed in round 1; its record is section 8 of
`docs/review/DESIGN-REVIEW.md` and "v0.3 code review round 2 integrated" in `docs/INTEGRATION-STATUS.md`. The
independent verifier then checked the tree (`docs/deviations/v03-verify.md`, 2026-10-21) and said not ready. This file
records how each of its findings was closed. Nothing was pushed, tagged or published, and no browser reached a
non-local address.

## Round 2 (2026-10-21, 03:45 to 05:00 ET)

Brief (workflow `v03-verify-fix.js`): read `docs/deviations/v03-verify.md` in full and fix every finding, each checked
before and after: the privacy greps, the release framing of every published document, the claims the code does not
keep, and every checklist gap; then `npm test` and one run of `node test/e2e/run.mjs`. One more defect was found on the
way and fixed (the demo's guestbook, below).

### Item 5: the privacy greps

| Before | Change | After |
|---|---|---|
| `git grep` for the build machine's username printed `docs/deviations/wire-ui.md:196` (a scratchpad path) and `docs/research/v03/R7-ease-of-use.md:5`; the home path grep printed the second | as the post-wave scrub did: the scratch path's username became `owner` (`-Users-owner`), the home path became `$HOME` | both greps print nothing; the home-directory grep of checklist section 3 prints only the two example paths that stay and the lines that quote them |

### Release framing (Claims B, and the brief's list)

Every document 0.3.0 publishes now calls 0.3.0 the release being prepared and the v0.3 and C2 code what runs; the
0.2.1 history is labelled as never published.

| Where | Before | After |
|---|---|---|
| `docs/PRIVACY.md` 4, 182 | "describes the code of 0.2.1"; "the 0.2.1 row describes what runs today" | describes 0.3.0; the v0.3 row describes what 0.3.0 runs; "not yet reviewed" defined as the review round of R 5.3. Also 43, 53, 171, 249, 259 and the notice template (467, item 4: no posting key before a sign-in) |
| `README.md` status | 0.3.0 named, v0.3 not mentioned; "for 0.3 and for 1.0" | 0.3.0 runs the v0.3 and C2 code (listed), peers see IP addresses, the review round has not run; "for 0.4 and for 1.0" |
| `CHANGELOG.md` headings | `## [Unreleased] - 0.2.1`, "Not released yet", a `[0.2.1]` tag link | `## 0.2.1 - never published; superseded by 0.3.0` with a paragraph naming the seven defects, no tag link, the stale "Re-run before tagging" sentence gone; the 0.3.0 heading stays `## [Unreleased] - 0.3.0` until the tag (section 8 dates it) |
| `docs/INTEGRATION-STATUS.md` | no summary line | a "Release status" line under the header |
| `docs/DEPLOY.md` 11, 28, 914, 1091, 1136 | 0.2.1; "no relay (TURN) servers in 0.2.1"; "0.2.1 has no denylist"; "Calls (v0.3 C2, proposed)" | 0.3.0; only a call can use a relay the owner sets up; "0.3.0 has no hub denylist" (checked: no denylist in `src/`); "Calls (v0.3 C2)" |
| `docs/ROADMAP.md` 3, 7, 12, 34, 42, 46, 81, 96, 211, 218, 222, 248 | "after 0.2.1", "0.2.1 is the first public release", "Next (0.3)", F13 "not yet released", the identity row "not yet released", "A 0.2.1 release carries an unsigned SHA256SUMS", an unban row | 0.3.0 throughout; "Next (0.4)"; F13 done in 0.3.0; the identity row carried by 0.3.0; release provenance as 0.3.0 has it (attestation, signed hash lists, npm by hand); the unban row reduced to the SDK read that is still missing; the size row re-measured (below) |
| `docs/FAQ.md` 35, 82, 262, 308, 336, 344, 353 to 358, 369, 467 | "Version 0.2.1 is a pre-release", "proposed and not built", "it is not released", an identity answer for 0.2.1 (export and import in Settings, which a build with the identity service no longer has) | 0.3.0; the identity answer says the identity page links devices and restores, and that neither the device link nor a restore from the 12 words has run end to end (CHANGELOG, known gaps) |
| `docs/README.md` 6, 9 to 13, 95; `docs/ONBOARDING.md` 8; `docs/COMPATIBILITY.md` 3 to 7, 234; `docs/MIGRATION.md` 13; `docs/RUNBOOK.md` 1, 3, 38 to 44 | 0.2.1, "it is not released", "written ahead of the code"; RUNBOOK counts 938, 31 + 1, 29, 25, 26 | 0.3.0; RUNBOOK counts 2,074, 41 + 1 (after `npm run build`), 177, 72, 77 with their times |
| `docs/OPERATIONS.md` 9, 135, 398, 417, 438, 457, 525, 644, 651 to 656, 661 to 666, 717 to 719, 862, 877 | "describes 0.2.1", "a design that is not built", "nothing of v0.3 is released", "there's no unban or undelete" (three runbooks), "pruning ... is on the roadmap", the canary's `ref: v0.2.1`, a TURN row for "people who chose a relay", a pin mailbox row as if built | 0.3.0; the runbooks use `unban`, `voided` and the owner `checkpoint`, which 0.3.0 has; `ref: v0.3.0`; the TURN row is about calls; the mailbox row is marked (proposed) |
| `docs/SECURITY-MODEL.md` 3, 163, 171 to 176, 306 to 312, 318 | "threat model for 0.2.1", "none of it is released", "the program ... is not built ... the 0.2.1 text above applies", an unsigned `SHA256SUMS` "today" | 0.3.0; what of R 2.19 is code and in use (attestation, signed hash lists, the lock, the rebuild job, the fuzzers) and what is the owner's (settings, people, the audit); `@lightweb/verify` has no provenance |
| `docs/THREAT-MODEL.md` 5, 11 to 16, 144 to 148 | "describes 0.2.1", "Nothing here is a claim about what a shipped release does", "The v0.2.1 hardening that ships first ... the 0.2.1 code that exists today" | 0.3.0 runs the rows' "after" columns; "The v0.2.1 hardening, carried by 0.3.0", naming the seven defects by MF number and saying what of MF-30 and MF-77 is open |
| `docs/WHY.md` 9 to 13, 88, 141, 150, 306 to 308 | "describes 0.2.1", "a design that is not built", 0.2.1 sizes, "0.2.1 passes" | 0.3.0; the loader sizes of the 0.3.0 build (below) |
| `docs/CRITIQUE.md` 20, 169, 173, 192 | "It is 0.2.1", 938 unit tests and 25 scenarios | 0.3.0 with 2,074, 72 and 77, and a pointer to where the v0.3 additions are argued against (the design review, THREAT-MODEL) |
| `docs/DEMO-RESULTS.md` 51, 220 | Settings shows "Loader 0.2.1"; "a relay that 0.2.1 doesn't have" | "Loader 0.3.0" (`settingsVersion` and `CONFIG.version`); the site's swarms use no relay, only a call can |
| `SECURITY.md` 11, 33, 71 to 79, 97 to 103 | "Today a 0.2.1 release carries an unsigned SHA256SUMS"; "For 0.2.1 ... (proposed)" | 0.3.0 is the first release cut with the program; "Checking a release" gives the three checks and the pinned key line |
| `deploy/github-actions/publish-site.yml` 68 to 69; `.github/ISSUE_TEMPLATE/bug_report.yml` 7 | `LIGHTWEB_REF: v0.2.1`, placeholder "0.2.1" | `v0.3.0` (the commit stays a placeholder: see checklist gap 12) |
| `CONTRIBUTING.md` release steps 4 to 7 | a release published by the workflow with three files | the draft, the six files, signing and verifying offline, then publishing (checklist section 14); `[x.y.z]` link; build before `test:browser` |
| also | `deploy/pin/README.md`, `deploy/tracker/README.md` ("For 0.2.1, CI ..."), `docs/recipes/README.md` (statuses "the identity origin is not built", "the mailbox, file pin and quarantine do not" exist), `docs/recipes/hub-pin.md` ("the 0.2.1 image", "the proposed flags"), `docs/CRUD.md` 537, `docs/ARCHITECTURE.md` 15.14 | 0.3.0; the statuses checked against `tools/pin.mjs --help` and the e2e scenarios |

The roadmap tier "Next (0.3)" became "Next (0.4)" in the README ("for 0.4 and for 1.0"), the ROADMAP (the tier table and
the heading) and the label text of checklist step 8b and section 12; the landing page names no tier (searched), so only its
A3 heading and its demo sentence changed.

Checklist section 9 now has the search that lists every remaining `0.2.1` mention of the published documents; every
hit it prints is history (a line labelling 0.2.1 as never published, a "v0.2.1" mark of the specification, a
measurement of the 0.2.1 build, or how a 0.2.1 key or peer is handled).

### Claims A1 to A7 and C

| # | Before | After |
|---|---|---|
| A1 | `examples/social/index.html:79`: "Only you, and the people you share them with, can open them"; `settings.js:241` without the site-code sentence | both say, with the loader's `privateUpload` text, that the site's own code on this origin can open them while you are signed in, and that on a hub that code is the hub's; the same hub clause in `settings.js:141` and the media hint (whose test still matches its start) |
| A2 | "Hide my IP from people I call" as a choice in `PRIVACY.md` 395, 423, the template rows, `DEPLOY.md` 1141, `THREAT-MODEL.md` 65, `OPERATIONS.md` 666, ARCHITECTURE 15.14 | removed as a choice; where it is named, it is "planned, not built: 0.3.0 has no switch for it" (only `window.__mwShell.setCallPrefs` in a development build sets it, `src/loader/app.js` 941 and 4043) |
| A3 | the heading "Private by default" in `README.md:36`, `docs/WHY.md:88`, `examples/landing/index.html:133` | "Nothing collected by default"; the body names analytics, telemetry and third-party scripts, and the condition now says the host still sees each visitor's IP address, as any web host does |
| A4 | `DEPLOY.md:1154`: "The project publishes one" | no default exists: the domain and whether the project runs one are owner decision N-2, not made; how a site names one (`publish --idp`, `<meta name="mw-idp">`) and what happens without one (`E_IDP_UNREACHABLE`, checked in `src/identity/client.js` `resolveIdp`). The same in PRIVACY's v0.3 register row and a changelog known gap |
| A5 | `CRUD.md:678`: "A ban is permanent in this version and can't be lifted" | lifted with `mw.mod.unban`, `ledger-admin unban`, or from the start with `ban --until` / `mw.mod.ban(pub, { until })`; an unban does not bring back dropped values |
| A6 | `SECURITY.md:85` and checklist 16.7: "minisign or sigstore" | ECDSA P-256 over each per-file hash list, `tools/verify-release.mjs sign` with a key from `tools/keygen.mjs` kept outside the clone; rehearsed on a scratch build (below) |
| A7 | guestbook name placeholder "anonymous" | "for example, Robin" |
| C | `deploy/github-actions/publish-site.yml` 30, 151, 191: `magnet-web/genesis.json` | `lightweb/genesis.json` (no site has used the template, so nothing to migrate) |

The seven 0.2.1 defects are now named the same way everywhere they appear: "MF-27, MF-28, MF-30 and MF-73 to MF-76" in
the changelog (0.3.0 entry, 0.2.1 heading, the status paragraph that section 8 writes), the checklist (intro, section
0's table, which is the one full list) and THREAT-MODEL. Section 0 now says why seven: the three must-fix rows marked
"(works today)" and the four transport rows of section H; MF-77 concerns the v0.3 social features (author-scoped keys
built, its rendezvous part open); the verdict's other three (MF-24, MF-04, MF-78) are answered by the reserved pool,
the `org=` check and the release program (checked in `src/chain/block.js`, `src/idp/idp.js`, `src/common/pointer.js`).
MF-30's row says its signed `minSeq` is (proposed).

### Checklist gaps 1 to 18

| # | Change |
|---|---|
| 1 | Section 10 commits "Prepare lightweb 0.3.0" and "lightweb 0.3.0", as the sequence does |
| 2 | 16.7: the key from `tools/keygen.mjs` outside the clone, `tools/verify-release.mjs` without "(proposed)" |
| 3 | 16.5: a manual publish of `@lightweb/verify` with the exact commands (in the sequence too, step 5b), no provenance claim: a hand publish has none and no workflow publishes to npm; the ROADMAP's provenance row asks for a publishing workflow; a check that the published `verify.js` has the README's sha256 |
| 4 | Sequence step 3b makes the release key and pins it (placeholder `RELEASE-KEY` line in README and SECURITY.md, replaced by a perl line; a check that none is left); step 9b creates immutable releases (UI), the tag ruleset and the `release` environment with its reviewer and `v*` tag rule (REST calls) before the tag; step 10b downloads, checks, signs, verifies, uploads and publishes the pre-release, all with paths in the download folder (`$RDIR`); section 14 uses the same paths |
| 5 | Sequence step 5 and section 10: end every agent session first, then `pgrep -fl checkpoint.sh` must print nothing but "loop stopped"; the same check before the push (step 6, section 11) |
| 6 | Section 13 and sequence step 9 require `one-box files` too, and say why the jobs of `pages-demo.yml` and `rebuild.yml` must not be required |
| 7 | The changelog substitution keeps every fact of the paragraph it replaces (the review round, the gate, Firefox, the outside review, counsel, why 0.2.1 was never published, loopback only) and adds a `[0.3.0]` link; it no longer touches the 0.2.1 block, which the tree already labels. Run from the checklist's own text on a copy with `OWNER` replaced, then `release.yml`'s notes extraction: heading `## [0.3.0] - 2026-10-22`, 343 lines, ending at the 0.2.1 heading |
| 8 | Section 9: the search for 0.2.1 framing in the published documents, and the ROADMAP tier; step 8b and section 12 label "Roadmap tier: next (0.4)"; section 15 files issues for "Next (0.4)" |
| 9 | Sequence step 4 and section 6 build before `test:browser` and say why (40 + 2 skipped before a build); the changelog's 0.3.0 entry now has round 2's counts |
| 10 | Section 1's identity origin row and a new 16.6 item: the `--idp` value goes into the README, QUICKSTART and DEPLOY once the domain serves, with the search that lists the places; DEPLOY.md 1154 corrected now |
| 11 | Section 9: a go or no-go decision before the tag for the R 5.3 review round, counsel's review of the privacy texts as a condition of the tag (as PRIVACY.md and 16.3 already make it), the 31 open rows of R 4.2 one by one, and the axe-core decision for E-ID-9 and E-SO-12 |
| 12 | The template names `v0.3.0` now; sequence step 11b and a section 15 item set `LIGHTWEB_COMMIT` after the tag in a pull request (a file cannot name its own commit); the perl line was run in bash and zsh on a copy |
| 13 | Section 3's last-check texts: the JWK grep's 16 `"d"` lines of throwaway vector keys (`chat.json` 14, `pin.json` 2), the path and username greps (nothing now), the first-name grep's 30 lines; `post-wave-fix.md` "Owner decisions" refreshed (28 lines listed, new `V03-DESIGN-REVIEW.md` 788 and 1386, `chain.mjs` 530, moved `dropin-binding` and `sw-sdk` lines, and the moved hardware-key lines of the checklist and ROADMAP) |
| 14 | Section 6: 43 `uses:` lines and 8 actions, `actions/attest-build-provenance` added |
| 15 | Section 4: 13 files, 38 lines, 39 matches (recounted after this round), with rows for `SECURITY.md`, `tools/ship.mjs` and the new `.github/CODEOWNERS`, and a note for an organisation account |
| 16 | 16.9 hardware rows for G-MD-4 and G-SO-5 |
| 17 | `.github/CODEOWNERS` (the lock files and `.github/`, `@OWNER` so step 2 fills it) and a 14-day `cooldown` on each Dependabot ecosystem are in the tree; 16.7 and sections 12 and 13 say so, and that neither has run on GitHub |
| 18 | Section 11, "A repository under the old name": how to tell an empty repository from one with commits, rename and push (`git remote add`, `git push -u`) or delete it, in place of the `gh repo create` line |

Also corrected in the checklist: section 0 claimed the changelog says that data from the 0.2.1 build does not carry
over (the "Breaking" block says a 0.2.1 posting key moves into the identity origin); the npm steps pointed at the "not
published to npm" line of the 0.2.1 block (0.3.0's known gaps now have one, with `@lightweb/verify`); the checkpoint
count and the history ranges that hold the username.

### Found on the way: the demo's guestbook could not be signed

A loopback browser run of `lightweb demo` (Chromium with `chromiumArgs()`, the demo with `--seeder none`) answered a
guestbook post with "The identity page could not be reached. Check your connection and try again.": writing needs a
sign-in in 0.3.0, and the demo published without `idp=` and served no identity page, so `resolveIdp` found none
(`E_IDP_UNREACHABLE`). The README, QUICKSTART and the landing page all said to sign the guestbook. `tools/demo.mjs`
now builds the identity page next to `dist/` on the desktop tier, serves it with `createIdpServer` on its own loopback
port (`--idp-port`, default 8081) and publishes with `idp=http://localhost:<port>`; the LAN tier has none and says
so. After the change the same run posted from one browser (the identity popup: "Create my identity", then "For this
visit only") and a second browser listed the entry; every request stayed on loopback. `test/unit/tools-demo.test.mjs`
checks the pointer's `idp=`, the identity page answering and the new text. The README, QUICKSTART, the landing page,
ARCHITECTURE section 10 and the changelog describe it, and QUICKSTART and the README now say that a site on your own
domain needs `--idp` and an identity origin you run, because none is published.

### Measured on the way

- The 0.3.0 build (commit `4c9b971`, `node build.mjs` in a scratch clone, Apple M3, 2026-10-21): `loader.js` 1,130,707
  bytes (364,180 with `gzip -9`), `mw.js` 859,284 (275,547), `webtorrent.min.js` 222,343 (64,297). WHY and the ROADMAP's
  size row use these; the 0.2.1 figures stay as history.
- The release signing steps on that build with a throwaway key (deleted after): `list`, a zip made as `release.yml`
  makes it, `sign`, `unzip`, `verify --pubkey` printed "OK: 22 files match the list".

### Runs (macOS 27, Apple M3, Node 24, loopback only, `ALLOW_REMOTE` unset)

| Check | Result |
|---|---|
| `npm test` before any edit (03:47 ET) | lint-floor clean, 2,074 of 2,074 |
| `npm test` after the bulk of the edits (04:39 ET), on the final code (04:54 to 04:55 ET) and after the last text edits (04:57 ET) | lint-floor clean (147 files), 2,074 of 2,074 each time (about 25 s) |
| `npm pack --dry-run` | `lightweb@0.3.0`, 180 files, 1,254,870 bytes (the demo change added 1,356 bytes) |
| `npm run test:example`, `npm run check:example` | 177 of 177; 2 sites, 7 pages, 0 errors |
| `node test/e2e/run.mjs` (04:42 to 04:51 ET, Chromium 156) | 69 passed, 3 failed of 72 in 502.0 s; "PASS network policy: every request stayed on 127.0.0.1". E-MD-4 failed with "no loadeddata" (its 20 s wait for the video's first frame), the intermittent failure that INTEGRATION-STATUS already records once; a unit test that builds the loader and the identity page ran in parallel during that part of the run. E-MD-3 and E-MD-5 failed because they need E-MD-4. Nothing this round changed is on that path: the e2e stack builds the loader from `src/`, which this round did not touch, and publishes the guestbook, whose only change is a placeholder |
| the members group again, alone (`--only E-CH-1,E-CH-8,E-CH-6,E-FI-1,E-FI-2,E-MD-4,E-MD-3,E-MD-5`, 04:51 to 04:52 ET) | 8 passed, 0 failed in 39.4 s, network policy PASS (E-MD-4 on its own cannot run: its share needs the contacts E-CH-1 makes, and alone it answered `E_POLICY`) |
| the doc tests (`docs-links`, `docs-claims`, `ui-v03-strings`, `strings-c2`, `repo-layout`, `tools-v03-release`, `tools-demo`) | all pass |
| the section 5 wording greps of the checklist | only rule quotations; no em or en dash, no curly quote |

### Not done, and why

- `node test/e2e/run.mjs --webkit` and `npm run test:browser` were not run (the brief asks for one Chromium run); the
  demo change is covered by its unit test and the two loopback probes.
- The GitHub side of the new steps (the ruleset and environment payloads of step 9b, the Dependabot `cooldown` key,
  CODEOWNERS) could not be tried: nothing here reaches GitHub. They follow GitHub's documented forms and are marked as
  not run.
- The demo's LAN tier (`--tls`) still has no identity page: it would need a certificate of its own. It is a known gap.
- Everything that is the owner's stays the owner's: the identity origin's domain (N-2), the release key, the npm
  publishes, the repository settings, counsel, the review round of R 5.3 and the real-device gate.

## Round 3 (2026-10-21, 05:55 to 06:35 ET)

Brief (workflow `v03-checklist-fix.js`): read "Round 2" of `docs/deviations/v03-verify.md` and fix its findings N1 to
N7 and its nits in `docs/PUBLISH-CHECKLIST.md` and the documents it names; read the whole checklist once after the
edits; run `npm test`. Only documents changed: the checklist, `CHANGELOG.md`, `.github/workflows/pages-demo.yml` and
`examples/landing/README.md`. Every new or changed command was run before it went in, pasted into bash and into zsh, on
throwaway copies of the tree in this session's scratchpad (with throwaway keys there, deleted after). Nothing was
pushed, tagged or published, no account was used, and nothing reached a public network.

### The findings

| # | Before | Change | After |
|---|---|---|---|
| N1 | Step 5b ran `npm publish` and step 6 made the repository public before the go or no-go of section 9, which the sequence settled only "before step 10"; section 9 asked for its answers "before the tag" | One sentence at the top of the sequence: nothing of the project leaves the machine before step 5b, and nothing from step 5b on is reversible. A new step 1b, before step 3 freezes the vectors and dates the changelog, takes every go or no-go: the review round of R 5.3, counsel's review, the 31 open rows, axe-core and the security mailbox (N2). It records two answers for step 3 (`REVIEW_ROUND`, `COUNSEL_DATE`) and runs a search that lists the sentences the answers make false (11 lines today). Step 5b starts with a gate line that sets `GATE`: "go" only when the changelog states counsel's review, `SECURITY.md` pins a `p256:` key and that search prints nothing. The publish lines of step 5b and the `gh repo create` line of step 6 and section 11 run only on "go". Section 9 is now "The go or no-go, the release gate and the claims", with the five go or no-go items first; sections 10, 11, 16 (its status box), 16.3 and 16.8 say when they are answered; step 10 no longer mentions them | Nothing leaves the machine before every answer is in the tree, and the first publishing command fails closed |
| N2 | `SECURITY.md` promised a security mailbox before 0.3.0; section 16.8 was in no step and no go or no-go | 16.8 is a go or no-go item of section 9 and part of step 1b: a block that refuses the placeholders and an address that is not https, then replaces the "There is no security mailbox yet" bullet of `SECURITY.md` and adds the address and the key's fingerprint to the README's reporting sentence; 16.8 quotes the new text; section 1's row on security reports names it | The release cannot leave the machine with the promise unkept: the gate stops on "no security mailbox" |
| N3 | Only the changelog's known gap was named; the README badge, "the package isn't on npm yet" (README, DEPLOY), the `@lightweb/verify` line and the status line were not | Section 11 has a table of every sentence that publishing to npm makes false, with the text now and the exact text that replaces it: `package.json`'s `"private": true`, the README badge, the README status line, "Try it", "Status and roadmap", DEPLOY's note, the changelog's "Added" line and known gap, and the recipe `signin-server-node.md`, which had one more. A new step 3c (replacing 4c, whose `npm view` lines moved to step 1) makes the changes with perl lines before the squash, and its check prints only the 0.2.1 history line. Section 15 has the same for the release: a table and a new step 11c, a pull request after the release that changes "0.3.0, the release being prepared" (21 lines in `SECURITY.md` and 14 documents of `docs/`), the "Release status" line of INTEGRATION-STATUS, and the README status lines when step 3c did not run (no npm package); its check prints nothing. Section 11 says which rows apply when `lightweb` is not published | Each sentence has its replacement and its step |
| N4 | Step 3b ran the perl line after a failed keygen and blanked the placeholder; its check printed nothing | One `if` block: the key's folder must exist outside the clone (resolved with `pwd -P`, so a relative path inside it is caught), `tools/keygen.mjs` must make a new key, and `loadOwnerKey` (the loader `verify-release.mjs sign` uses) must parse it as a P-256 private key; only then the perl line runs. Otherwise it prints STOP and changes nothing. The check is a loop that prints "pinned" or "NOT PINNED" for README.md and SECURITY.md, and "NOT PINNED" whenever `RELEASE_PUB` is empty, blank or not the key in the file | Reproduced the verifier's paste: wrong path, STOP and "NOT PINNED" twice, nothing changed; the right path next, "pinned" twice; a third paste, keygen refuses the existing file, nothing changes and the loop still says "pinned" |
| N5 | The release notes had to say five things the owner had to remember; step 3 wrote none of them | The status that step 3 writes is followed by "How this release was made": one maintainer pushed the tag and approved the environment `release`, so the two-person rule of R 2.19 is not met; `lightweb` and `@lightweb/verify` were published to npm by hand, without provenance; no hub runs, so `examples/social` runs as personal sites with a hub-less follow lane; what the zero-setup route is not, and that G-ZS1 to G-ZS4 have not run. Sections 8, 14, 16.5, 16.7, 16.11 and 17 point at those lines and say which to change for a second maintainer or a hub; section 14 gives the line a hand-made release adds | `release.yml`'s notes extraction, run on the dated copy, carries the lines |
| N6 | "If something goes wrong" deleted the release and its tag and tagged again | Rewritten: before step 5b, fix and squash again; from step 5b on nothing is deleted or tagged again (npm keeps 0.3.0, the ruleset of step 9b forbids deleting or moving `v*` and names no bypass, a published release is immutable, and the release job refuses a tag that has a release), so a bad 0.3.0 is superseded by 0.3.1 and marked in its notes (`gh release edit --notes-file`) and on npm (`npm deprecate`), and a fix that the first CI run needs in a file of the package is 0.3.1 too. To make that hold, step 5b writes the commit it published into `.git`, and step 10 (and section 14) tag only when no file of the two packages changed since that commit; otherwise they print STOP and the files | A bad release is never deleted or tagged again |
| N7 | `CHANGELOG.md` 30 and 393 and the status of step 3 said that 0.3.0 fixes the seven defects; the status asserted "counsel has not reviewed the privacy texts" | The three say that 0.3.0 fixes MF-27, MF-28 and MF-73 to MF-76 and fixes MF-30 in part (its signed `minSeq` is proposed), and so does the checklist's opening. The changelog's unreleased paragraph says counsel's review is a condition of publishing whose date the status gives; the status of step 3 writes "Counsel reviewed the privacy texts (...) on `COUNSEL_DATE`" and refuses to run without a date, and the review round's sentence takes `REVIEW_ROUND` | No status the checklist writes can say counsel has not reviewed |
| nits | `pages-demo.yml:32` and `examples/landing/README.md:77` said "step 4"; C:913 to 914 said the environment waits for a reviewer who is not the pusher, against `"prevent_self_review": false` | "section 4" in both; section 14 says the environment waits for the reviewer that step 9b names, the other maintainer when there are two and you when there is one, and that the release notes of step 3 say so | |

Also changed in the checklist: the vector line of step 3 and section 8 skips the append when the 0.3.0 entry is there
(a second run changed nothing); section 0 reads the rows "before you publish"; section 6 writes differing counts
into the changelog "before the squash"; section 16.7 says the key's drive must keep file modes; step 1 asks `npm view`
and makes the npm organisation (an organisation holds no code).

### Runs (macOS 27, Apple M3, Node 24.22.0, loopback only)

| Check | Result |
|---|---|
| `npm test` before any edit (05:58 ET) | 2,074 of 2,074 |
| step 3b in bash and zsh: the example path, a missing folder, a folder inside the clone (absolute and relative), an existing file that is no key, a real folder, then the verifier's three pastes in one shell | STOP and "NOT PINNED" twice with nothing changed in every bad case, no key written inside the clone; "pinned" twice for the real folder; the three pastes as in N4 |
| step 3 in bash and zsh: no answers, a placeholder date, the answers, a second run | STOP and no changelog edit for the first two; then `## [0.3.0] - 2026-10-22`, the status with the list, the `[0.3.0]` link; the second run changed nothing; the notes extraction of `release.yml` found 367 lines up to the 0.2.1 heading, with the list and links pointed at the tagged tree; `npm test` on that copy 2,074 of 2,074 |
| the mailbox block of step 1b in bash and zsh | placeholders: STOP, 0 matches, nothing changed; real values: one match in each file |
| the gate line in bash and zsh | STOP on the tree as it is, after step 3 alone and after steps 1b to 3b; "go" once the counsel and axe-core sentences were changed too |
| steps 3c and 11c in bash and zsh | 3c: five files, its check prints only the 0.2.1 line; 11c: 21 lines in 15 files, its check prints nothing; `npm test` 2,074 of 2,074 after each |
| the step 10 guard in a scratch repository with an orphan commit, bash and zsh | no record: STOP, no tag; a change under `docs/` only: the tag is made; a change under `src/`: STOP and the file |
| end to end from the edited checklist: steps 1b, 2, 3, 3b, 3c, the gate, the step 10 guard and 11c, extracted from the sequence block and run as written on a fresh one-commit copy of the tree, in bash and in zsh; the copies of step 3 in section 8 and of step 10 in section 14 compared line by line | every step as above; `npm test` on the result 2,074 of 2,074 in both shells (a first bash run said 2,073 and 1: the harness had committed its own `node_modules` link, which `repo-layout` reported; excluded, the rerun passed); the copies are the same lines |
| every "step N" and "section N" of the checklist against the sequence and the headings; the search for "4c", "before step 10" and "before the tag" | no unknown reference, no leftover |
| the section 5 wording greps; the dash grep over the checklist's scope, `v03-fix.md` and `pages-demo.yml`; the two privacy greps | only rule quotations; nothing; nothing |
| `npm test` after the last edit (06:29 ET) | lint-floor clean (147 files), 2,074 of 2,074 |

### Not done, and why

- Nothing on GitHub or npm ran: the gate before a real `npm publish`, the commit that 5b writes into `.git`, the
  guarded `gh repo create`, the pull request of step 11c, `gh release edit --notes-file` on an immutable release and
  `npm deprecate` follow the tools' documented forms and were not run. That the notes of an immutable release stay
  editable is GitHub's documented behaviour as the fixer knows it, not something tried here.
- The sentences that wait for counsel (`docs/PRIVACY.md` 7, 50, 183 to 185, 386, 524, 574; `SECURITY.md` 33 to 34)
  and the axe-core known gap stay: they are true until the owner's answers, which step 1b lists and the gate requires.
  The security mailbox does not exist; it is the owner's.
- The sentences in the tables of steps 3c and 11c stay as they are in the tree: they are true until the owner
  publishes, and those steps change them then.
- How a FAT or exFAT drive keeps file modes was not tried (no such drive here), hence "may not keep" in 16.7.
- `docs/THREAT-MODEL.md` 146 to 147 ("0.3.0 fixes them") is unchanged: its next sentence states the `minSeq`
  exception, and the brief named the changelog and the status of step 3.
- The end-to-end suites were not run (the brief: the code is unchanged).
- The throwaway copies of the tree stay in this session's scratchpad (a depth-1 clone and two one-commit copies of the
  tracked files, none with the checkpoint history): the session's permissions refused deleting them. The throwaway
  release keys were deleted by the test scripts themselves.

## Round 4 (2026-10-21, 07:10 to 07:55 ET)

Brief (workflow, the fixer of round 4): read "Round 3" of `docs/deviations/v03-verify.md` and fix R3-1 to R3-4 and L1
to L4 in `docs/PUBLISH-CHECKLIST.md`; read the whole checklist once more for step numbers and cross-references; run
the main-path commands that changed on throwaway one-commit copies in bash and zsh; run `npm test`. Only the checklist
and this file changed. The sentences that R3-4 names stay as they are in the tree, because they are true until the first
CI run, and steps 3 and 11c change them. Nothing was pushed to GitHub, published, tagged on GitHub or sent to npm: on the
throwaway copies `npm` and `gh` were stubs that log each call and reach nothing, and the only tags and pushes were inside
those copies and their local bare repositories. Checklist lines are cited as `C:<line>` of the edited file.

### The findings

| # | Before | Change | After |
|---|---|---|---|
| R3-1 | The old-name route of section 11 (`gh repo rename`, `git remote add`, `git push -u origin main`, `gh repo edit --visibility public`) and the block of 16.5 (`npm publish --access public`) ran whatever the gate printed; the `--private` route made the repository public with an unguarded command in its prose | Each of the four old-name lines starts with `[ "$GATE" = go ] &&` (C:889 to 897). The `--private` route's `gh repo edit --visibility public` is a guarded line in a code block, and its text says that the private `gh repo create` needs the gate line of step 5b first (C:975 to 983). The block of 16.5 is the second publish line of step 5b, copied (C:1262 to 1269). Section 11 opens by saying that every line of it that publishes a package or puts the code on GitHub runs only on "go" (C:863 to 866), and the intro says that the copies and these routes carry the same guard (C:63 to 65) | With `GATE` unset (a new shell) or STOP, none of these lines runs: no stub call, no remote added |
| R3-2 | Section 11's `[ "$GATE" = go ] && npm publish --access public` and the block of 16.5 wrote no `.git/lightweb-npm-commit`, so step 10 and section 14 refused the tag | Section 11's npm block is the lines of step 5b from its gate line to its second publish line, copied as they are and introduced as such (C:936 to 952); 16.5 holds step 5b's second publish line (C:1262 to 1269); section 14 names both copies (C:1096) | Both copies write the record, and the guard of step 10 then reaches its tag line; round 3's line of section 11, run for comparison, left no record and the guard printed STOP |
| R3-3 | The route that keeps `lightweb` off npm kept the release-notes line "`lightweb` and `@lightweb/verify` were published to npm by hand" and asked for the known gap "by hand" | Section 11 (C:956 to 970) gives the exact text and two perl lines, run after step 3 and before the squash. The known gap becomes "`lightweb` is not published to npm (`package.json` has `"private": true`). [...] `@lightweb/verify` is on npm, published by hand, so it carries no npm provenance (no workflow publishes to npm), and a server can copy `packages/verify/verify.js` [...]"; the release-notes line becomes "`@lightweb/verify` was published to npm by hand, so it carries no npm provenance: no workflow publishes to npm ([...], release provenance). `lightweb` is not on npm: its package is the `.tgz` attached to this release." A git grep after them must print nothing. The comment of step 3 (C:137), section 8 (C:755 to 756) and 16.5 (C:1274) name this route as a reason to change a line | The notes that `release.yml` extracts carry the new line |
| R3-4 | `deploy/pin/README.md:221`, `deploy/tracker/README.md:150` ("it has not run on GitHub yet") and `CHANGELOG.md:122` to 123 ("CI, release (it stops at a draft) and rebuild workflows, never run.") were in no table | The table of section 15 (C:1183 to 1198) has a column for the step and two more rows, each false from the first CI run (step 6) on. The two deploy READMEs: step 11c writes "CI (`.github/workflows/ci.yml`, job `deploy`)"; its search and perl line now cover `deploy/*/README.md` and the phrase (C:388 to 393). The changelog line: the release notes copy it from the tagged tree, so step 3 rewords it before the squash, to "none of which had run on GitHub before 0.3.0 was pushed", which stays true after the first CI run (the perl line at C:150 and its copy in section 8, C:740). The comments of steps 3 and 11c and the text of section 8 (C:757 to 763) say so | 11c changes 23 lines in 17 files after step 3c (25 in 18 without it), and its check prints nothing; the dated changelog carries the reworded line |
| L1 | Step 1 made the npm organisation `lightweb`, a public page, before step 1b | Step 1 makes nothing on npm (C:87 to 96). Step 5b makes the organisation after "go" and before its publish lines, and says what to do if the name is taken (C:225 to 228); section 1 (C:409) and 16.5 (C:1259) point at step 5b, and the intro says that you make no npm organisation until the gate prints "go" (C:63) | "Nothing of the project leaves this machine before step 5b" (C:60) is true of every step before 5b |
| L2 | Step 1b pointed at `git grep -n 'not yet reviewed'`, which missed nine lines | A second search in step 1b (C:124), which runs only when `REVIEW_ROUND` starts with "ran", lists every line that calls v0.3 "not yet reviewed" or names the review round of R 5.3, and leaves out "code review round 1" and "2" (a PCRE lookbehind, single-quoted); the comment says to change each line that says the round has not run (C:119 to 122), and section 9 points at it (C:778) | 70 lines on the tree as it is, the nine lines of L2 among them. Across line breaks, "review" and "round" are split only in three "code review round 1" lines |
| L3 | Step 11c read `RELEASE_DATE` from the local tag and wrote "Release status ()" in a clone without it | The perl lines run inside an if block that first checks for the annotated tag (`git rev-parse -q --verify 'refs/tags/v0.3.0^{tag}'`) and prints STOP otherwise; the commit, the push and the pull request are one `&&` line, so nothing is pushed when nothing changed; the comment says how to fetch the tag and run the block again (C:379 to 394) | In a clone without the tag: STOP, no file changed, "nothing to commit", no branch pushed, no pull request |
| L4 | The check of the published `verify.js` (16.5), the search of 16.6 and the real `ship` of section 17 were in neither the sequence nor the intro's list | The check is the last three lines of step 5b (C:244 to 246), and 16.5 says so (C:1279). The intro names a third kind that stays in its sections, the commands that wait for something outside the sequence: the search of 16.6 and the real `ship` of section 17 (C:67 to 73) | Every command of a section block that is not in the sequence is a kind the intro names (listed by script, below) |

Also changed: the intro's list of other routes names `lightweb` kept off npm (C:70), and the comment of step 6 says
that section 11 replaces its `gh repo create` line with lines that carry the same guard (C:252 to 253).

### Runs (macOS 27, Apple M3, Node 24.22.0, loopback only)

The copies were one-commit copies of the tracked files of the working tree (no checkpoint history), with
`node_modules` linked and excluded from git, in this session's scratchpad. A script cut each step out of the sequence
block and each section block out of the edited checklist, and drivers ran them as written, by sourcing them in one
shell: bash 3.2 (`/bin/bash`), zsh 5.9 (`zsh -f`) and bash 5.3. Where the owner types a value (the answers of step 1b,
the path of the release key), the driver put a value into the line. The release key was a throwaway key in a folder
next to the copy, deleted at the end of each run.

| Check | When (ET) | Result |
|---|---|---|
| `npm test` in place before any edit | 07:14:11 to 07:14:36 | lint-floor clean (147 files); 2,074 of 2,074 |
| `!` in an interactive bash 3.2 and zsh | 07:18 | inside single quotes `(?<!code )` stays as it is in both; inside double quotes both expand it, so the search of step 1b is single-quoted |
| The copies of the edited checklist compared line by line | 07:25 | section 11's npm block is step 5b from its gate line to its second publish line; 16.5's line is step 5b's second publish line; 16.5's check is the last three lines of step 5b; section 8 is step 3 from its if line to `git diff`; section 14 is step 10; section 11's first block is the first four lines of step 6 |
| The main path, in bash 3.2, zsh and bash 5.3: steps 1, 1b, 2, 3 and 3b and the gate line with the placeholders; step 1b with answers, the review-round search with `REVIEW_ROUND` "ran ...", step 3 twice, 3b twice, 3c, the gate, simulated owner edits of the sentences the search lists, the gate, `npm test`, a commit; the old-name and private routes with `GATE` unset and STOP; step 5b; the guard of step 10 (its tag line replaced by an echo) with the record, without it, after section 11's block, after 16.5's line and after round 3's line; the two routes with `GATE` "go" (`git remote add` and `git push` replaced by an echo); 16.5's line and the guard as written, which made the tag in the copy; step 11c in a clone without the tag, then in the copy with it; `npm test` | 07:29:04 to 07:32:16 | The same output in the three shells, line for line, apart from paths, commit ids and the key. Placeholders: E404 twice (stub); STOP, 0 and 0, 11 lines; step 3 STOP and no changelog edit; 3b STOP and "NOT PINNED" twice; gate STOP. Answers: 1 and 1, 10 lines; 70 lines with the nine of L2; step 3 wrote the status and the reworded line, and its second run changed nothing; 3b "pinned" twice, then keygen's refusal, STOP and "pinned" twice; 3c printed only the 0.2.1 line; gate STOP, then "go"; `npm test` 2,074 of 2,074. Routes with `GATE` unset or STOP: no stub call, no remote. Step 5b: "go", the record equal to HEAD, and the check printed `a579df9d...` for the packed `verify.js` and for the README's line. Guard: the tag line with the record, STOP without it, the tag line after section 11's block and after 16.5's line, STOP after round 3's line. `GATE` "go": `gh repo rename`, the two echoes, `gh repo edit`. 11c without the tag: STOP, no file changed, no commit, no branch on the bare origin, no `gh pr create`; with it: 23 lines in 17 files, the deploy READMEs read "CI (`.github/workflows/ci.yml`, job `deploy`) builds", the "Release status" line has the date of the tag, the check printed nothing, the branch reached the bare origin and the stub got `gh pr create`; `npm test` 2,074 of 2,074 |
| `release.yml`'s notes extraction (lines 98 to 119) on the tag of the main path | 07:36 | 373 lines (the section is 367 lines from its heading to the 0.2.1 heading), with the reworded line and the four lines of "How this release was made" |
| `lightweb` kept off npm, in bash 3.2 and zsh: steps 1, 1b with answers, 2 and 3, the two lines of step 3c for `@lightweb/verify`, section 11's lines as written and once more, 3b, the owner edits, the gate, `npm test`, a commit, the notes extraction, the gate, 16.5's line, the guard as written, step 11c as written, `npm test` | 07:32:52 to 07:49:38 | The same output in both shells: the known gap and the release-notes line as in R3-3, the check printed nothing and the second run changed nothing; the notes, 375 lines, carry the new line and the reworded one; the guard made the tag; 11c changed 25 lines in 18 files, the README's two status lines among them, and the npm badge and "isn't on npm yet" stayed. `npm test` printed 2,074 of 2,074 every time but once: in one zsh run the first `npm test` printed no summary, and its output was not kept; four more zsh runs, three of them keeping the whole output, passed at that point |
| Every "step N" and "section N" of the checklist against the sequence and the headings, and every command of a section block against the sequence (scripts) | 07:24 and 07:46 | No unknown reference (the one miss is "section 1.1 item 7" of the design review). The commands outside the sequence are the checks of sections 2, 3, 5, 7 and 9, the replacements of section 3, the commands of sections 6, 8 and 10 that the sequence runs in other lines, the routes of section 11, the manual release of section 14, the search of 16.6, the real `ship` of section 17 and "If something goes wrong": each one a kind the intro names. No "4c", "before step 10", "before the tag", "these commands" or "the last line publishes" is left |
| The section 5 word greps, the dash grep over its scope (and this file), the two privacy greps | 07:46 | only rule quotations; nothing; nothing |
| `npm test` in place after the checklist edits | 07:47:10 to 07:47:36 | lint-floor clean (147 files); 2,074 of 2,074 |
| `npm test` in place after this section was written | 07:53:06 to 07:53:31 | lint-floor clean (147 files); 2,074 of 2,074 |

### Not done, and why

- Nothing on npm or GitHub ran: the organisation, `npm login`, both `npm publish` lines, `npm pack` of the published
  `@lightweb/verify` (the stub packed `packages/verify` of the copy instead), `gh repo create`, `rename` and `edit`, the
  pushes to GitHub, `gh pr create` and `git fetch origin tag v0.3.0`. Whether npm's form for a new organisation shows a
  taken name before anything is created was not looked at; step 5b treats a taken name as a stop before any publish.
- No document besides the checklist was edited: `CHANGELOG.md:122` to 123 and the two deploy READMEs are true until the
  first CI run, and steps 3 and 11c change them.
- L5 and L6 were not in this brief. The `--private` route now runs its `gh repo create` after the gate line of step 5b
  (R3-1), so its first push no longer comes before step 5b; "If something goes wrong" and the header of `release.yml`
  are unchanged.
- The zsh run whose first `npm test` printed no summary is not explained: its output was not kept, and the reruns
  passed.
- The end-to-end, browser and example suites and the pack were not run (the code is unchanged).
- The throwaway copies, their bare origins, the extracted steps and the drivers stay in this session's scratchpad; the
  tags made there exist only in those copies, and the throwaway keys were deleted.
