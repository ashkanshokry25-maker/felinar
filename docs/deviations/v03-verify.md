# v0.3 verify: independent check before the owner publishes 0.3.0 (2026-10-21)

Brief (workflow `v03-review.js`, the step after the Lightweb branding lane and the 0.3.0 checklist): check the tree
without trusting the fixer's or the branding lane's reports. (1) Forbidden words, `magnet-web` left where Lightweb
belongs, and durability or privacy claims the code does not keep, in README.md, docs/*.md, docs/recipes/*.md,
examples/**/*.html, src/loader/strings.js and tools/*.mjs; (2) what an owner publishing 0.3.0 would miss in
docs/PUBLISH-CHECKLIST.md; (3) `npm test`, `node test/e2e/run.mjs` and `--webkit`, `npm run test:browser`,
`npm run test:example` and `npm pack --dry-run`; (4) a clean tree apart from checkpoint commits; (5) `git grep -n`
for the build machine's username and for its home path (`/Users/<username>`) print nothing. This file is the only
change to the tree, and it quotes neither.

**Verdict: not ready.** Every suite passes. Item 5 fails: two tracked files still hold the build machine's username,
one of them with its home path. The documents 0.3.0 would publish still call 0.2.1 the release and v0.3 unreleased or
not built (PRIVACY.md says that where a v0.3 row and a 0.2.1 row disagree, "the 0.2.1 row describes what runs today"),
and three places promise privacy the code does not give. The checklist would leave the one public commit named
"lightweb 0.2.1" if section 10 is followed instead of the sequence, sends the owner to a key format the release tool
cannot use, names a provenance route for `@lightweb/verify` that does not exist, and ends the sequence with a draft
release.

## Runs (macOS 27.0.1, Apple M3, Node 24.22.0, loopback only, `ALLOW_REMOTE` unset)

Before the runs the launch sites were read: every Chromium launch passes `chromiumArgs()` (or `CHROMIUM_LOCAL_ONLY_ARGS`)
from `test/e2e/browser-args.mjs`, and every WebKit page is `http://127.0.0.1:<port>`; the calls tests empty `iceServers`
or use a STUN server on 127.0.0.1. Everything except `npm test` ran in a clone of `a764911` with `node_modules` linked
(`scratchpad/v03verify-copy`); `dist/` of the shared tree was not touched.

| Check | When (ET) | Result |
|---|---|---|
| `npm test` (in place, the tree that `a764911` then committed) | 02:54:32 to 02:54:59 | lint-floor clean (147 files); 2,074 of 2,074 pass, 0 fail |
| `node test/e2e/run.mjs` | 03:04:14 to 03:12:45 | 72 passed, 0 failed, 510.8 s; "PASS network policy: every request stayed on 127.0.0.1" (Chromium 156.0.8078.4) |
| `node test/e2e/run.mjs --webkit` | 03:12:45 to 03:20:57 | 77 passed, 0 failed, 491.3 s; network policy PASS (WebKit 27.2) |
| `npm run test:browser` | 03:20:57 | 42 tests: 40 pass, 2 skipped, 0 fail. The second skip was `tools-v03-pin-browser` ("dist/_mw/webtorrent.min.js is missing: run node build.mjs first") |
| `npm run build`, `node build.mjs --check-lock`, then `npm run test:browser` again | 03:22:09 to 03:22:30 | build and lock check pass; 42 tests: 41 pass, 1 skipped (the v0.1 `sw-browser`, by design), 0 fail |
| `npm run test:example` | about 03:21 | 177 of 177 pass |
| `npm pack --dry-run` | 03:21:40 | `lightweb@0.3.0`, 180 files, 1,253,514 bytes packed (4.3 MB unpacked); only `bin/`, `src/`, `tools/`, `build.mjs`, `build.lock.json`, `npm-shrinkwrap.json`, `test/e2e/browser-args.mjs`, `README.md`, `LICENSE`, `package.json`; no key, local state, `examples/`, `docs/` or dependency folder |
| beyond the brief: `npm run build:idp`; `npm run test:fuzz -- --iterations 3000 --seconds 90 --seed v03verify` | 03:23 | build id `750a08c26281`; fuzz PASS, 45,000 inputs, 0 violations, 5 notes (the known ones of `docs/deviations/tools.md`, among them `verifier-looser-than-parser:resources`: `@lightweb/verify` still accepts a `resources` entry that `parseProof` refuses) |
| beyond the brief: the local steps of "The whole sequence" on a throwaway clone (`OWNER=example-owner`, `TAG_DATE=2026-10-22`) | 03:22 to 03:23 | step 2 replaced every placeholder (12 files, the check printed nothing); step 3 printed `{"count":219,"head":"5fc03e2d..."}`, appended the FROZEN entry and dated the changelog; release.yml's notes extraction finds `## [0.3.0] - 2026-10-22` (331 lines); `npm test` 2,074 of 2,074 after both; step 4b printed nothing; step 5 left one commit and `git diff --stat main release` printed nothing |

`node bin/lightweb.mjs --version` prints `lightweb 0.3.0`, and `--help` lists the commands. The versions in
`package.json`, both lock files (identical bytes), `src/loader/config.js`, `src/sdk/sdk.js`, `src/sdk/sdk-static.js`,
`src/idp/idp.js`, `tools/lib.mjs` and `packages/verify/package.json` are 0.3.0, and `sha256(verify.js)` is the
`a579df9d...` that `packages/verify/README.md` prints.

## Tree and history (item 4)

- At 02:53 ET the branding lane's last edits (6 files) were not committed. The auto checkpoint of 03:01 ET (`a764911`)
  committed them; `git status --short` printed nothing at 03:02, 03:16 and 03:24 ET. The ignored paths are local state
  (`.orchestration/`, `.tools/`, `dist/`, lab logs under `docs/research/labs/`). One branch (`main`), no tags, no
  stash, no remote, 135 commits, all by `magnet-web checkpoint <checkpoint@localhost>`. The next auto checkpoint commits
  this file.
- The checkpoint loop still runs: pid 74059 (`.orchestration/checkpoint-loop.pid`), started 01:31 ET, so until about
  07:30 ET.

## Privacy greps (item 5): fail

- `git grep -n "$(id -un)"` (the username) prints two lines:
  - `docs/deviations/wire-ui.md:196`: a scratchpad path `/private/tmp/claude-501/-Users-<username>-...` with the username.
  - `docs/research/v03/R7-ease-of-use.md:5`: "Subject: magnet-web 0.2.1 at /Users/<username>/Documents/Projects/magnet-web".
- `git grep -n "/Users/$(id -un)"` (the home path) prints the second one.

Both files came after the privacy scrub (`9d5ab58` and `468f6eb`, 2026-10-20). The two replacement commands of
PUBLISH-CHECKLIST section 3 (home directory to `$HOME` in `docs/research`, username to `USER`) fix both lines.
Other forms: no personal e-mail address is tracked; the short hostname is only in the two lab outputs that
`post-wave-fix.md` lists; the hardware key model is in the 9 lines listed there.

## Claims (item 1)

Forbidden words: none outside rule statements. `serverless`, `unstoppable`, `censorship`, `fully decentralized`,
`sub-second`, `hack-proof` and `unlimited storage` appear only where a rule quotes them; `blockchain` only in the README
heading "Why not a blockchain?" and rule quotations; `production-ready` only in negations and as the name of the 1.0
bar; every `anonymous` is a negation or carries the IP-address qualification, except the guestbook placeholder below.
The remaining `magnet-web` hits are the alias `bin`, the changelog's compatibility list (`~/.config/magnet-web/`,
`magnet-web-identity-backup.json`, `Symbol.for('magnet-web.sdk.facade')`, `magnet-web-idp`), the checkpoint author and
the credit to KayleePop/magnet-web, except one (C below).

### A. Privacy claims the code does not keep

1. `examples/social/index.html:79`: "Private photos and videos: Encrypted on your device before they leave it. Only
   you, and the people you share them with, can open them." The site's own code can open them while the person is
   signed in, and on a hub that code is the hub's (`src/loader/strings.js:430`, PRIVACY.md 234, FAQ "Who can see my
   photos and videos?"). `examples/social/js/views/settings.js:241` also leaves out the site-code sentence.
2. `docs/PRIVACY.md:395` to 396 and 423, and `docs/DEPLOY.md:1141`, describe "Hide my IP from people I call" as a choice
   a person makes (THREAT-MODEL 65: "people who choose relay-only"). 0.3.0 has no switch and no strings for it: only a
   development build can set it, through `window.__mwShell.setCallPrefs` (`src/loader/app.js:941` to 950 and 4043).
3. "Private by default" as a benefit heading: `README.md:36`, `docs/WHY.md:88`, `examples/landing/index.html:133`. The
   condition column qualifies it, but PUBLISH-CHECKLIST 16.10 says nothing may describe Lightweb as "private by
   default", and DESIGN-REVIEW 4.5 says there is no private mode. Change the heading or the rule.
4. `docs/DEPLOY.md:1154`: "The project publishes one [identity origin] as a static host with no server code." None
   exists yet: the domain is owner decision N-2 (checklist 16.6), and nothing in the tree names one.
5. `docs/CRUD.md:678`: "A ban is permanent in this version and can't be lifted." 0.3.0 has `mw.mod.unban`,
   `ledger-admin unban` and `ban --until`.
6. `SECURITY.md:85` (and checklist 16.7) say the hash list is signed with minisign or sigstore;
   `tools/verify-release.mjs` signs and verifies ECDSA P-256 with a `tools/keygen.mjs` key, as release.yml's header says.
7. `examples/peer-guestbook/index.html:64`: the display-name placeholder is "anonymous" (low).

### B. Documents that describe 0.2.1 as the release or v0.3 as unreleased

0.3.0 is the first public release and carries v0.3, but these sentences say otherwise:

- `docs/PRIVACY.md:4` to 5 ("It describes the code of 0.2.1 ... v0.3 as built (not yet reviewed, not released)") and
  182 to 183 ("where a v0.3 row and a 0.2.1 row disagree, the 0.2.1 row describes what runs today").
- `docs/ROADMAP.md:3` ("What comes after 0.2.1"), 7 ("Version 0.2.1 is the first public release"), 34 and 81 (the tier
  "Next (0.3)").
- `docs/FAQ.md:35` ("Version 0.2.1 is a pre-release"), 82 to 83 ("The v0.3 design, which is proposed and not built"),
  370 ("it is not released").
- `docs/README.md:6`, `docs/ONBOARDING.md:8`, `docs/COMPATIBILITY.md:3`, `docs/MIGRATION.md:13`, `docs/DEPLOY.md:11`,
  `docs/RUNBOOK.md:1`: the documents, the pilot advice, the browser matrix, the migration status, the deploy recipes
  and the runbook are said to be for 0.2.1. `docs/DEPLOY.md:1136`: "Calls (v0.3 C2, proposed)".
- `docs/OPERATIONS.md:9` to 11 ("This page describes 0.2.1 ... a design that is not built") and 654 to 656 ("nothing of
  v0.3 is released ... 'there is no unban or undelete' and 'pruning old history behind a checkpoint is on the
  roadmap'"); both exist now.
- `docs/SECURITY-MODEL.md:3`, 174 to 175 ("none of it is released"), 306 to 311 (the release program "is not built ...
  the 0.2.1 text above applies"; release.yml now attests and the hash lists are signed); `docs/THREAT-MODEL.md:5`;
  `docs/WHY.md:307` to 308 ("Everything above describes 0.2.1").
- `docs/CRITIQUE.md:20` and 173 ("It is 0.2.1"; "938 unit tests and 25 of 25 end-to-end scenarios"); `docs/RUNBOOK.md:38`
  to 41 (31, 29, 25 and 26 where the suites now give 41 + 1, 177, 72 and 77).
- `docs/DEMO-RESULTS.md:51`: Settings shows "Loader 0.2.1" (it shows 0.3.0).
- `SECURITY.md:75` to 76 ("Today a 0.2.1 release carries an unsigned SHA256SUMS") and 99 to 101 ("For 0.2.1 ... (proposed)").
- `deploy/github-actions/publish-site.yml:68` to 69: site owners' workflows pin `LIGHTWEB_REF: v0.2.1`, a tag the
  checklist says never to make. `.github/ISSUE_TEMPLATE/bug_report.yml:7`: placeholder "0.2.1" (low).

### C. `magnet-web` where Lightweb belongs

- `deploy/github-actions/publish-site.yml:30`, 151 and 191: the site owner's repository keeps its first block at
  `magnet-web/genesis.json`. It is not in the changelog's compatibility list, and no site has used the template yet.

## Checklist gaps (item 2), most serious first

1. Section 10 (lines 584 and 588) still commits "Prepare lightweb 0.2.1" and "lightweb 0.2.1"; the sequence (step 5)
   says 0.3.0. An owner who follows section 10 makes "lightweb 0.2.1" the subject of the only public commit.
2. 16.7 (lines 900 and 907) says to generate the release key "(minisign or sigstore)" and to run
   `tools/verify-release.mjs` "(proposed)". The tool exists and section 14 already runs it; `sign` needs a P-256 JWK from
   `node tools/keygen.mjs --out <a file outside the clone>`. A minisign or sigstore key cannot sign the lists.
3. 16.5 (line 877): "Publish `@lightweb/verify` with provenance from the release workflow." No workflow publishes it
   (release.yml: "Nothing here publishes to npm"), `packages/verify/package.json` has no `repository` field, which npm
   provenance checks, and no command anywhere publishes it (step 5b publishes only `lightweb`). The recipe tells
   servers to copy the file until it is published.
4. The sequence tags (step 10) before any 16.7 setting exists: the `release` environment with a reviewer and a v* tag
   rule, the tag ruleset, immutable releases and the release key. It then stops at a comment, so the sign, upload,
   verify and `gh release edit v0.3.0 --prerelease --draft=false` commands of section 14 are not in it, and a release
   made by the sequence alone stays a draft. Those commands also name `hashes-dist.json` and `<unzipped dist>` relative
   to the clone, while step 10 downloads to `"${TMPDIR:-/tmp}/mw-release"`.
5. Stopping the loop checks only the pid file. `.orchestration/RESUME.md` section 4 tells agent sessions to restart the
   loop at every milestone. Say: end every agent session first, then `pgrep -fl checkpoint.sh` must print nothing,
   right before the squash and again before the push.
6. Section 13 requires `test (Node 22)`, `test (Node 24)`, `reproducible pack` and `deploy files`; ci.yml has a fifth
   job, `one-box files` (ci.yml 271 to 272), which the list neither names nor requires.
7. The changelog substitution (lines 88 and 539) replaces the "Not released yet" paragraph with a sentence that drops two
   facts it states: the review round of R 5.3 (the judges and the red team against the built code) has not run, and
   counsel has not reviewed the privacy texts. It also removes the `[0.2.1]` link and adds no `[0.3.0]` link, so the new
   heading shows its brackets. (Tested on a copy: the substitution itself works.)
8. The checklist does not tell the owner to bring the documents of Claims B up to 0.3.0, nor the ROADMAP tier: the
   labels (lines 173 and 703) still read "Roadmap tier: next (0.3)", and section 15 (line 817) files issues for "Next
   (0.3)" items, the tier named after the release being published.
9. Section 6 (lines 424 to 426) says the counts of the last run are in CHANGELOG.md under 0.3.0. The changelog's newest
   counts are those of C2 (1,967 unit, 40 browser, 170 example, 71 and 76 e2e); round 2's (2,074; 41 + 1 skipped; 177;
   72; 77, the same as this run) are only in INTEGRATION-STATUS. Steps 4 and section 6 also run `test:browser` before
   `npm run build`, so on a fresh clone `tools-v03-pin-browser` skips and the count reads 40 + 2.
10. The identity origin: nothing in the code defaults to one (`resolveIdp`: `--idp`, `<meta name="mw-idp">` or the
    pointer's `idp=`), and no document names an `--idp` value. After choosing the domain (16.6) the owner must also put
    it in QUICKSTART and DEPLOY as the `--idp` value and correct DEPLOY.md 1154; the checklist says neither.
11. Neither the 31 open design e2e rows of `docs/deviations/integration-v03.md` (R 4.2: 33 ran, 31 open) nor the owner
    decision on axe-core for E-ID-9 and E-SO-12 appear in the checklist, and the R 5.3 review round is not a go or no-go
    item before the tag (only a status line in section 16).
12. `deploy/github-actions/publish-site.yml` 68 to 69 (`v0.2.1`) and its `magnet-web/genesis.json` path: no step sets the
    template to `v0.3.0` and its commit after the tag.
13. Section 3's "last check" texts are stale: the JWK grep now also prints 16 `"d"` fields of deterministic test keys in
    `test/vectors/chat.json` (14) and `pin.json` (2), which the page does not mention; the path and `id -un` greps print
    the two lines of item 5; the first-name grep of section 3 prints 30 lines, not 27: `docs/review/V03-DESIGN-REVIEW.md:788` and
    1386 and `test/fuzz/targets/chain.mjs:530` are new, and post-wave-fix.md's "Owner decisions" line numbers moved
    (`dropin-binding.test.mjs` 113, 115, 159; `sw-sdk.test.mjs` 238).
14. Section 6 (line 452): 43 `uses:` lines and 8 actions now, not 34 and 7 (`actions/attest-build-provenance` v3.0.0
    came with release.yml), so the pin loop prints 8 lines.
15. Section 4: 12 files hold 33 lines of placeholders (34 matches), not 10 and 30; `SECURITY.md:9` and
    `tools/ship.mjs:728` and 730 are missing from the table (the command still replaces them).
16. The 16.9 hardware summary leaves out G-MD-4 (seek latency from a phone and a desktop seeder) and G-SO-5 (safe-area
    insets on phones with a notch or cutout).
17. 16.7's CODEOWNERS and 14-day Dependabot cooldown are tracked files (`.github/CODEOWNERS` does not exist,
    `.github/dependabot.yml` has no cooldown); the checklist does not say to add them before the squash or in a first
    pull request.
18. `gh repo rename lightweb --repo "$OWNER/magnet-web"` (line 17): after a rename, step 6's `gh repo create` fails
    because the repository exists, and the checklist gives no `git remote add origin` and `git push -u origin main`
    for that path (a renamed repository with history of its own would also need that history removed first).

Covered and correct: the checkpoint history is never pushed (sections 1 and 10, the orphan squash, the bundle under
`TMPDIR`); the names (`lightweb` repository, package and command, `@lightweb/verify`, the `magnet-web` alias); the npm
scope; the identity origin and hub domains as owner decisions (sections 1, 16.6, 16.11, never nip.io or sslip.io); the
nip.io and sslip.io route (section 17, G-ZS1 to G-ZS4, `--dry-run` first); the gate rows (16.9, every DEMO-RESULTS row
"not yet run"); the `gh` commands with `$OWNER/lightweb` and v0.3.0; the vector count 219 and head `5fc03e2d...`.

## Not checked

`npm ci` and `npm audit` (they need the registry; the "4 high severity vulnerabilities" line of section 2 is
unverified), the action pins against GitHub (`git ls-remote`), anything on GitHub, Firefox, real devices. The
simulated sequence left a bundle of the full history in this session's scratchpad (`verify/seq-tmp/`), outside the
tree; deleting it was not allowed from the session.

## Round 2 (2026-10-21, 05:02 to 05:30 ET)

Brief (workflow `v03-verify-fix.js`, after the round 2 fixer and its record `docs/deviations/v03-fix.md`): check every
claim and checklist gap of round 1 against the tree, with file and line; repeat the global checks: (1) wording and
claims, (2) the two privacy greps, (3) the suites and the pack, (4) a clean tree; and (5) read
`docs/PUBLISH-CHECKLIST.md` end to end as the owner who publishes 0.3.0 tomorrow. The fixer's report was not taken on
trust: each "closed" below was read in the tree. The tree is `0fbf1e9`, the 05:01 ET checkpoint, which committed the
fixer's last edits (11 files were still uncommitted at 04:58 ET). This section is the only change, and it quotes
neither the username nor the home path. Checklist lines are cited as `C:<line>`.

**Verdict: not ready.** Every finding of round 1 is closed, and every suite passes. What is left would mislead the
owner: the whole sequence publishes the real 0.3.0 to npm (step 5b) and makes the repository public (step 6) before
the go or no-go items of section 9, although PRIVACY.md and the checklist make counsel's review a condition of
publishing 0.3.0 (N1); SECURITY.md promises a security mailbox before 0.3.0 that no step of the sequence creates (N2);
four more sentences say the package is not on npm, and the checklist names only the changelog's (N3); and step 3b,
pasted with a key path that fails, replaces the pinned-key placeholder with nothing while its check still prints
nothing (N4, reproduced). Each is a short text change. Apart from the tree: nothing records counsel's review, so by the
documents' own rule 0.3.0 cannot be published tomorrow unless that review happens first.

### Runs (macOS 27, Apple M3, Node 24.22.0, loopback only, `ALLOW_REMOTE` unset)

The launch sites were read first: every Chromium launch passes `chromiumArgs()` or `CHROMIUM_LOCAL_ONLY_ARGS` (E-ZS-1
puts two MAP rules to 127.0.0.1 in front of the local-only rule), every WebKit page is `http://127.0.0.1:<port>`, and
the end-to-end pages run with no STUN server. `npm test` ran in place twice (the second time at 05:29 ET, after this
section was written: 2,074 of 2,074 again); everything else ran in clones of `0fbf1e9` in this session's scratchpad
with `node_modules` linked, so the shared tree's `dist/` was not touched.

| Check | When (ET) | Result |
|---|---|---|
| `npm test` in place | 05:03:37 to 05:04:02 | lint-floor clean (147 files); 2,074 of 2,074 pass, 0 fail |
| `npm test` in the clone | 05:04:27 to 05:04:52 | the same |
| `npm run test:browser` before a build | 05:04:52 to 05:05:03 | 42 tests: 40 pass, 2 skipped (`sw-browser`; `tools-v03-pin-browser`, "run node build.mjs first"), as section 6 now says |
| `npm run build`, `node build.mjs --check-lock`, `npm run test:browser` | 05:05:10 to 05:05:24 | build and lock check pass; 42 tests: 41 pass, 1 skipped (`sw-browser`, by design) |
| `npm run test:example` | 05:05:24 to 05:05:56 | 177 of 177 |
| `npm pack --dry-run`, in place and in the clone | 05:06 | `lightweb@0.3.0`, 180 files, 1,254,870 bytes packed (4,311,561 unpacked); the grep of section 7 prints nothing |
| `node test/e2e/run.mjs` | 05:06:12 to 05:14:40 | 72 passed, 0 failed, 507.2 s; "PASS network policy: every request stayed on 127.0.0.1" (Chromium 156.0.8078.4); E-MD-4, E-MD-3 and E-MD-5 passed |
| `node test/e2e/run.mjs --webkit` | 05:15:04 to 05:22:53 | 77 passed, 0 failed, 469.1 s; network policy PASS (Playwright WebKit build 2370); E-MD-4 passed |
| beyond the brief: the demo's guestbook (the defect round 2 found and fixed) | 05:23 | `runDemo` from `tools/demo.mjs` with `--seeder none` on ports 18080, 18000 and 18081, two Chromium contexts launched by the e2e helpers (`chromiumArgs()`, no STUN): the pointer carries `idp=http://localhost:18081`; one context posted through the identity page ("Create my identity", "For this visit only") and the other listed the entry, in two runs; every request went to `localhost:18080` or `localhost:18081` |
| beyond the brief: the local steps of the sequence on throwaway clones (`OWNER=example-owner`, `TAG_DATE=2026-10-22`, a throwaway key outside the clone) | 05:17 to 05:25 | step 2 changed 13 files and 38 lines and its check printed nothing; step 3 printed `{"count":219,"head":"5fc03e2d..."}`, appended the FROZEN entry, and its changelog edit gave `## [0.3.0] - 2026-10-22` with a `[0.3.0]` link; `release.yml`'s notes extraction found that section (358 lines, up to the 0.2.1 heading, relative links pointed at the tagged tree); step 3b pinned a `p256:` key and its check printed nothing; `npm test` after steps 2, 3 and 3b: 2,074 of 2,074; step 11b's perl line set `LIGHTWEB_COMMIT` in bash and in zsh; step 5's commands left one commit by the configured author, and `git diff --stat main release` printed nothing |

Also checked: the clone's build gives `loader.js` 1,130,707 bytes (364,180 with `gzip -9`), `mw.js` 859,284 (275,547)
and `webtorrent.min.js` 222,343 (64,297), the figures of WHY.md and the ROADMAP's size row; `packages/verify` packs 3
files (`README.md`, `package.json`, `verify.js`), and `sha256(verify.js)` is the `a579df9d...` its README prints; the
version is 0.3.0 in `package.json`, both lock files (identical bytes), `src/loader/config.js`, `src/sdk/sdk.js`,
`src/sdk/sdk-static.js`, `src/idp/idp.js` and `tools/lib.mjs`; `ledger-admin --help` lists `unban` and `ban --until`.

### Round 1, rechecked: every claim and every gap is closed

- **Item 5:** `docs/deviations/wire-ui.md:196` reads `-Users-owner` and `docs/research/v03/R7-ease-of-use.md:5` reads
  `$HOME`; both greps print nothing (global check 2).
- **A1:** `examples/social/index.html:79`, `examples/social/js/views/settings.js:141` and 241, and the media hint
  (`examples/social/js/views/media.js:97`) say that the site's own code on this origin can open private media while
  the member is signed in, and that on a hub that code is the hub's.
- **A2:** relay-only is "planned, not built" with no switch in 0.3.0 wherever it is named (`PRIVACY.md:401` to 402 and
  429, `THREAT-MODEL.md:66`, `ARCHITECTURE.md:1675` to 1676 and 1771 to 1772); `DEPLOY.md:1137` to 1140 describes only
  the relay a call falls back to.
- **A3:** "Nothing collected by default", with the host's view of the IP address as its condition: `README.md:36`,
  `WHY.md:88`, `examples/landing/index.html:133` to 139.
- **A4:** `DEPLOY.md:1155` to 1163 (no default exists; `--idp`, `mw-idp`, `E_IDP_UNREACHABLE`), which is what the code
  does: `resolveIdp` (`src/identity/client.js:332`) has no fallback, and `CONFIG.idp` is null (line 311).
- **A5:** `CRUD.md:679` to 682 (`mw.mod.unban`, `ledger-admin unban`, `ban --until`, `mw.mod.ban(pub, { until })`).
- **A6:** `SECURITY.md:85` and its "Checking a release" (97 to 119); C:1097 to 1103.
- **A7:** `examples/peer-guestbook/index.html:64` ("for example, Robin").
- **B:** each sentence of the round 1 list now names 0.3.0 as the release and the v0.3 and C2 code as what runs:
  `PRIVACY.md:4` and 180 to 188, `ROADMAP.md:3`, 7, 35 and 82, `FAQ.md:35`, 82 to 84 and 371 to 374,
  `docs/README.md:6`, `ONBOARDING.md:8`, `COMPATIBILITY.md:3`, `MIGRATION.md:13`, `DEPLOY.md:11` and 1137,
  `RUNBOOK.md:1` and 37 to 41, `OPERATIONS.md:9` and 655 to 660, `SECURITY-MODEL.md:3` to 6, 175 to 178 and 309 to 320,
  `THREAT-MODEL.md:5` and 12 to 16, `WHY.md:9` and 309 to 311, `CRITIQUE.md:20` and 176, `DEMO-RESULTS.md:51`,
  `SECURITY.md:71` to 79 and 97 to 119, `deploy/github-actions/publish-site.yml:68` (`v0.3.0`) and
  `.github/ISSUE_TEMPLATE/bug_report.yml:7` (`0.3.0`). The search of section 9 (C:654) prints 53 lines, each of them
  history of the kinds that C:650 to 651 allow.
- **C:** `deploy/github-actions/publish-site.yml:30`, 151 and 191 use `lightweb/genesis.json`.
- **Gaps 1 to 18:** 1: C:145, 152, 704 and 708. 2: C:1097 to 1103. 3: C:164 and 1044 to 1066. 4: steps 3b, 9b and 10b
  (C:102 to 111, 229 to 251, 262 to 275) and section 14 with `$RDIR` (C:924 to 944). 5: C:136 to 144, 170, 682 to 700
  and 726. 6: C:218 and 869 to 878 (`ci.yml:271` to 272). 7: C:99 and 631, run above. 8: C:648 to 658, 204, 850 and
  979. 9: C:113 to 118 and 499 to 516, `CHANGELOG.md:334` to 337. 10: C:305 and 1075 to 1085. 11: C:659 to 669.
  12: C:281 to 289 and 981 to 984. 13: C:344 to 351, 361 to 371 and 396 to 399, each count rerun (16 `"d"` lines, 14
  and 2; nothing for the path and username greps; 30 first-name lines, the 28 that `post-wave-fix.md` lists and the 2
  that quote the command; 9 key-model lines). 14: C:540 to 557 (43 `uses:` lines, 8 actions, none unpinned).
  15: C:416 to 433 (13 files, 38 lines, 39 matches, recounted). 16: C:1143 to 1144. 17: `.github/CODEOWNERS`, and
  `.github/dependabot.yml` with `cooldown: { default-days: 14 }` for all three ecosystems; C:1104 to 1110.
  18: C:738 to 762.

### Global checks

1. **Words and claims** in `README.md`, `docs/*.md`, `docs/recipes/*.md`, `examples/**/*.html`, `src/loader/strings.js`
   and `tools/*.mjs`: the banned words appear only in rule statements (ARCHITECTURE 13 to 15, ONBOARDING 293 to 294,
   the checklist's own greps and C:1177, the rule comment at the top of `strings.js`); `blockchain` only in the README
   heading "Why not a blockchain?" and rule statements; `production-ready` only in negations and as the name of the
   1.0 bar; "private by default" only in the rule of C:1177; every `anonymous` is a negation or carries the
   IP-address qualification (two other uses are unrelated: an anonymous-accessible export in MIGRATION 687, Astro's
   anonymous telemetry in `docs/recipes/astro.md:33`). No em dash, en dash or curly quote in the checklist's scope, in
   the example pages, `src/loader/strings.js`, `src/idp/strings.js` or `tools/*.mjs`; no TODO, FIXME or
   RESEARCH-PENDING. The `magnet-web` left are the alias `bin`, the compatibility names of `CHANGELOG.md:41` to 47
   (`~/.config/magnet-web/`, the backup file name, the facade symbol, `magnet-web-idp`), the credit to
   KayleePop/magnet-web, the checkpoint author and the checklist's notes on the rename. The privacy sentences of the
   examples and the loader carry the site-code and IP conditions. Release-state sentences that the release will not
   keep: N2, N3 and N7 below.
2. **Privacy:** `git grep -n "$(id -un)"` and `git grep -n "/Users/$(id -un)"` print nothing (05:03 ET, and again after
   this section was written); the home-path grep of section 3 prints only the example paths it names; no personal
   e-mail address is tracked; the configured git user name has no hit.
3. The runs above.
4. **Tree:** `git status --short` printed nothing at 05:02 and 05:25 ET (the 05:16 checkpoint had nothing to commit);
   the ignored paths are `.orchestration/`, `.tools/`, `dist/` and lab logs under `docs/research/labs/`. One branch, no
   tag, no stash, no remote, 141 commits, all by the checkpoint author. The checkpoint loop (pid 74059) still runs, and
   the next checkpoint commits this file.

### New findings, most serious first

**N1. The sequence publishes before the go or no-go (C:63, 158 to 174, 659 to 663).** The intro says "Settle the go or
no-go items of section 9 before step 10", but step 5b runs `npm publish` for `lightweb` 0.3.0 and `@lightweb/verify`
0.3.0, and step 6 makes the repository public. Section 9 calls counsel's review of the privacy texts "a condition of
publishing any v0.3 feature" (C:662 to 663), section 16.3 is headed "Counsel review, before any v0.3 feature ships"
(C:1024), `PRIVACY.md:183` to 184 says the v0.3 text is reviewed by counsel "before 0.3.0 is published", and
`SECURITY.md:33` to 34 says counsel reviews the safe harbour "before 0.3.0"; section 11 itself says "finish sections 1
to 10 first" (C:723). Following the sequence, the owner publishes 0.3.0 to npm, a version number npm never accepts
twice, and pushes the code before counsel has read it; and if the R 5.3 decision is "run it first and fix its
blockers", npm's 0.3.0 is the code before the fixes while the tag later names other code. Step 5b also comes before
the first CI run on GitHub, after which section 11 says to "expect to fix something" (C:769 to 770). Fix: settle
section 9 before step 5 (at least before 5b and 6), and say so in the intro and in sections 10 and 11. Under that rule
the status paragraph of step 3 ("counsel has not reviewed the privacy texts", C:99 and 631) can never be true at a tag
made by the checklist; C:637 and 663 do ask to change it, so it is a default the owner has to remember to edit.

**N2. A security mailbox "before 0.3.0" (`SECURITY.md:11` to 14).** The owner "sets one up with a published public key
before 0.3.0", and the file then names it. That is section 16.8 (C:1118 to 1122), which is neither a step of the
sequence nor a go or no-go item of section 9, so a release made by the sequence publishes a promise that is already
broken. Put 16.8 into section 9 or the sequence, or change the sentence.

**N3. "Not on npm" sentences the checklist does not list.** Step 4c (C:129 to 131), section 1 (C:304) and section 11
(C:777 to 778) name only the known gap at `CHANGELOG.md:385` to 388. After step 5b these are false in the one public
commit: the README badge "npm: not published yet" (`README.md:12`), "the package isn't on npm yet" (`README.md:100`,
`DEPLOY.md:17` to 18) and `@lightweb/verify` "not published to npm" (`CHANGELOG.md:84`). `README.md:23`, "Status:
0.3.0, pre-release (not published yet)", is false once the release is out, npm or not, and no step of section 15
changes it.

**N4. Step 3b can unpin the key without a trace (C:105 to 111), reproduced.** Pasted into an interactive zsh (with
`interactive_comments`) on a throwaway clone with the page's example path `/Volumes/YOUR-OFFLINE-DRIVE/...`, `keygen`
fails, `: "${RELEASE_PUB:?...}"` stops only its own line, the perl line replaces `RELEASE-KEY-NOT-PINNED-YET` with an
empty string (`README.md:277` and `SECURITY.md:102` then show two empty backticks), and the check of C:111 prints
nothing, as if the key were pinned. A second run with the right path finds no placeholder left to replace, so unless
the owner notices, `SECURITY.md` ships with no key. Fix: run perl only when `RELEASE_PUB` starts with `p256:`, and
check that both files now contain that key (for example `grep -c "$RELEASE_PUB" README.md SECURITY.md`).

**N5. Release-note sentences with no step.** The checklist wants the release notes to say that the one maintainer
approved the release environment (C:232, 916), that `@lightweb/verify` was published by hand (C:1056), that the
two-person rule is not met (C:1112), that without a hub the social example runs as personal sites (C:1186 to 1187),
and what the zero-setup route is not (C:1231 to 1233). `release.yml` takes the notes verbatim from the changelog's
`[0.3.0]` section (`release.yml:91` to 121), and the sequence's only changelog edit, step 3, writes a fixed paragraph
without them. Say where they go: into that section before the tag, or with `gh release edit v0.3.0 --notes-file`
before step 10b publishes the draft.

**N6. "If something goes wrong" (C:1235 to 1244) contradicts step 9b.** The tag ruleset of 9b forbids deleting `v*`
tags and names no bypass actor (C:234 to 242), so `gh release delete v0.3.0 --cleanup-tag` cannot remove the tag; a
published immutable release keeps its tag (`release.yml:27`); and the release job answers an existing release with
"Nothing is replaced: tag a new version instead" (`release.yml:227`). The section should say that after step 9b the
fix goes out as 0.3.1 (or the ruleset is turned off first, before anything is published).

**N7. "0.3.0 fixes them" (low).** The status paragraph of step 3 (C:99, 631) and `CHANGELOG.md:30` and 393 say that
0.3.0 fixes the seven 0.2.1 defects, but MF-30 is fixed except its signed `minSeq`, which is not built (C:42,
`THREAT-MODEL.md:150` to 151, `ROADMAP.md:65`). Add "(MF-30 in part)" as section 0 does.

**N8. Nits.** `.github/workflows/pages-demo.yml:32` and `examples/landing/README.md:76` to 77 send the reader to
"docs/PUBLISH-CHECKLIST.md, step 4" for the placeholders: that is section 4 (sequence step 2; sequence step 4 runs the
tests). C:913 to 914 say the environment "waits for a reviewer who is not the person who pushed the tag", while step 9b
sets `"prevent_self_review": false` (C:246); the next sentence explains the one-maintainer case.

### Not defects, for the owner tomorrow

- Counsel's review (N1) is the owner's step, and nothing in the tree says it happened (`CHANGELOG.md:28` says it has
  not). The R 5.3 decision, N-2 (the identity origin's domain), the release key, the npm organisation, the repository
  settings and the real-device gate are the owner's too.
- On this machine a second process restarts the checkpoint loop: a background shell of a Claude Code session started
  2026-10-20 at 09:11 ET checks every 300 s and starts `checkpoint.sh` again when it is gone, and its exit condition
  (18 results in a build journal that ended with 16) can no longer be met. Step 5 catches it: `pgrep -fl checkpoint.sh`
  lists it (its command line names `checkpoint.sh`) until that session ends or `pkill -f checkpoint.sh` runs, so expect
  two lines from `pgrep` the first time.

### Not checked

`npm ci` and `npm audit` (they need the registry; the line of C:329 and the E404 answers of C:304 and 775 are not
verified), the action pins against GitHub (`git ls-remote`), the GitHub API payloads of steps 7 to 10b, anything on
GitHub or npm, Firefox and real devices. The throwaway clones (with the full checkpoint history), a bundle of that
history and two throwaway P-256 keys were written under this session's scratchpad, outside the tree; deleting them was
not allowed from the session.

## Round 3 (2026-10-21, 06:37 to 07:05 ET)

Brief (the independent verifier of round 3, after the fixer's "Round 3" in `docs/deviations/v03-fix.md`): check N1 to N8
of round 2 against the documents, with file and line, without trusting the fixer's report; read
`docs/PUBLISH-CHECKLIST.md` end to end as the owner publishing 0.3.0 (nothing leaves the machine before every go or
no-go of section 9 is answered; step numbers and cross-references agree; the sequence block matches the sections; every
sentence that publication makes false is listed with its replacement; the rollback section matches immutable
releases); run `npm test` and `git status`. The code is unchanged, so the end-to-end suites did not run. This section is
the only change, and it quotes neither the username nor the home path. Checklist lines are cited as `C:<line>`.

**Verdict: not ready.** N1 to N8 are closed where round 2 found them, and every command of the main path (steps 1b, 2,
3, 3b and 3c, the gate line, the guard of step 10 and step 11c) was run as written on throwaway copies, in bash and in
zsh, with the same output in both and `npm test` passing after them. Four short text gaps remain, outside those
commands: the old-name route of section 11, where step 6 sends the owner, pushes without the gate, and the npm block of
16.5 has no gate (R3-1); the publish lines copied into sections 11 and 16.5 do not write the record that step 10 needs,
so publishing from them makes step 10 refuse the tag and point at 0.3.1 (R3-2); the not-on-npm route keeps a
release-notes line that says `lightweb` was published to npm (R3-3); and three sentences that the first CI run makes
false are in no table, one of them in the release notes (R3-4). Each is a change of a few lines.

### Runs (macOS 27, Apple M3, Node 24.22.0, loopback only)

`npm test` ran in place. Everything else ran on depth-1 clones of `3e1b671` (no checkpoint history; `5f8051a` differs
from it only in `docs/deviations/v03-fix.md`) in this session's scratchpad, with `node_modules` linked and excluded from
git. No command on this machine reached npm, GitHub or another host (`npm view` was skipped; the GitHub documentation
cited under N6 was read through a web search), and no tag was made: the guard of step 10 ran with `git tag` replaced by
an echo, and step 11c with `RELEASE_DATE` set by hand.

| Check | When (ET) | Result |
|---|---|---|
| `npm test` in place | 06:39:32 to 06:39:58 | lint-floor clean (147 files); 2,074 of 2,074 pass, 0 fail |
| The sequence, cut out of C:82 to 378 step by step and run in bash: step 1 (variables, `git config`), 1b as written, 2, 3 as written, 3b as written, the gate line; then 1b with answers, 3 twice, 3b with a real folder and once more, 3c, the gate line, simulated owner edits of the sentences the search lists, the gate line, `npm test`, a commit with the record of step 5b, the guard of step 10 four ways, 11c and `npm test` | 06:42 to 06:43:41 | 1b as written: STOP, `SECURITY.md:0`, `README.md:0`, 11 lines; 2: nothing; 3 as written: `{"count":219,"head":"5fc03e2d..."}`, STOP, no changelog edit; 3b as written: STOP, "NOT PINNED" twice; gate: STOP. With answers: 1 and 1, 10 lines; 3 wrote `## [0.3.0] - 2026-10-22`, the status with "Counsel reviewed the privacy texts (...) on 2026-10-20", "How this release was made" and the `[0.3.0]` link, and its second run changed nothing; 3b "pinned" twice, its rerun printed keygen's refusal, STOP and "pinned" twice; 3c's check printed only `CHANGELOG.md:580` (0.2.1 history); gate STOP, then "go" after the edits; `npm test` 2,074 of 2,074; the guard reached its tag line with nothing changed and after a change under `docs/`, printed the file and STOP after a change under `src/`, and printed STOP without the record; 11c changed 21 lines in 15 files and its check printed nothing; `npm test` 2,074 of 2,074 |
| The same driver in zsh (`zsh -f`) | 06:44 to 06:45:06 | the same output, line for line, apart from paths and the throwaway key |
| Step 3b with `./newdir/x.jwk`, `docs/x.jwk`, an absolute path inside the clone, a path through a symlink to the clone, an existing file outside it and the example path | 06:45 | STOP and "NOT PINNED" twice each; no file written inside the clone; both placeholders still there |
| Step 11c without step 3c (the not-on-npm route), bash and zsh | 06:45 to 06:46 | 23 lines in 16 files, the README's two status lines among them; its check printed nothing; `npm test` 2,074 of 2,074 |
| `release.yml`'s notes extraction (lines 91 to 121) on the dated copy | 06:46 | 373 lines, the "How this release was made" list among them, relative links pointed at the tagged tree |
| Step 3c alone, diffed | 06:49 | exactly the nine changes of the table at C:895 to 905 |
| The mailbox block of 1b with an http key address, an empty fingerprint, an empty address and a placeholder fingerprint, bash and zsh | 06:52 | STOP each time, nothing changed |

### Round 2, rechecked

- **N1: closed on the sequence.** C:60 to 63 say nothing leaves the machine before step 5b and nothing from it on is
  reversible. Step 1b (C:94 to 118), before step 3, takes the five answers; step 3 refuses to date the changelog
  without a `COUNSEL_DATE` of the form YYYY-MM-DD (C:141, 144); the gate line (C:222 to 224) prints "go" only with the
  counsel sentence of step 3, a pinned `p256:` line in `SECURITY.md` and an empty search; the publish lines (C:229,
  230) and `gh repo create` (C:241, 844) run only on "go". Section 9 (C:740 to 765) lists the five go or no-go items
  first; sections 10 (C:792 to 793) and 11 (C:836 to 838), the status box of 16 (C:1140 to 1142), 16.3 (C:1177, 1185
  to 1187) and 16.8 (C:1276) say when they are answered; the comment of step 10 (C:321 to 325) no longer carries them.
  Run above: STOP until the answers and the owner's edits were in the tree, then "go". Left: R3-1.
- **N2: closed.** A go or no-go item (C:763 to 765), the block of step 1b (C:106 to 114), 16.8 (C:1278 to 1285) and
  section 1 (C:394). The block refused every bad value tried and, with real ones, replaced `SECURITY.md:11` to 14 and
  extended the reporting sentence of `README.md:275`; the gate stops on "no security mailbox".
- **N3: closed for npm.** The table at C:895 to 905 gives the text now and after for each of the nine places, the perl
  lines of step 3c (C:168 to 173) make exactly those changes, and its check (C:174) printed only the 0.2.1 line. The
  table at C:1129 to 1134 and step 11c (C:363 to 373) change the 21 "release being prepared" lines (recounted:
  `SECURITY.md` and 14 documents of `docs/`; none is split over two lines), the release status of
  `docs/INTEGRATION-STATUS.md:5` and, when 3c did not run, the README's status lines (tested both ways). C:917 to 922
  say what changes when `lightweb` stays off npm. Left: R3-3 and R3-4.
- **N4: closed.** C:154 to 162. The paste of round 2 (the example path, then a real folder, then a rerun) and the bad
  paths above gave STOP and "NOT PINNED" with nothing changed, or "pinned" twice. `tools/keygen.mjs:32` to 33 refuse an
  existing file and `tools/lib.mjs:312` to 314 refuse a key file that group or others can read, so a drive that drops
  mode 600 stops at step 3b as 16.7 says (C:1258 to 1259; no FAT or exFAT drive was tried).
- **N5: closed.** The list written by C:142 and C:718 reaches the release notes (run above). Sections 8 (C:729 to 734),
  14 (C:1056 to 1057, and the line for a release built by hand at C:1094 to 1095), 16.5 (C:1211 to 1212), 16.7 (C:1269 to
  1270), 16.11 (C:1349 to 1350) and 17 (C:1395 to 1398) point at it.
- **N6: closed.** "If something goes wrong" (C:1400 to 1425) matches the ruleset of step 9b (C:302 to 310: deletion,
  update and non-fast-forward, no bypass actor), `release.yml:27` and 226 to 228, and GitHub's documentation, read for
  this round ([Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases),
  [Managing releases in a repository](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)):
  a published immutable release keeps its assets and its tag, and its title and notes stay editable, so
  `gh release edit --notes-file` (C:1417) can mark it as superseded. The record of step 5b (C:229 to 230) and the guard
  (C:326 to 328, the same lines at C:1043 to 1045) behaved as described above. Left: R3-2.
- **N7: closed.** `CHANGELOG.md:28` to 33 and 394 to 396, the status of step 3 (C:142, 718) and C:9 to 10 say that
  0.3.0 fixes MF-27, MF-28 and MF-73 to MF-76 and MF-30 in part; the changelog makes counsel's review a condition of
  publishing whose date the status gives, and the status cannot be written without that date. `docs/THREAT-MODEL.md:147`
  to 151 keep "0.3.0 fixes them" with the `minSeq` exception two sentences later, which reads correctly.
- **N8 (nits): closed.** `.github/workflows/pages-demo.yml:32` and `examples/landing/README.md:77` say "section 4";
  C:1052 to 1054 say the environment waits for the reviewer that step 9b names (you, with one maintainer, because
  `"prevent_self_review": false`).

### The checklist, read end to end as the owner

1. **Nothing leaves the machine before the go or no-go:** true of the sequence. Before step 5b its network calls are
   reads (`npm view`, `npm ci`, `npx playwright install`, `git ls-remote`), plus counsel's review and the mailbox's key,
   which step 1b itself asks for; the first publishing commands are gated (C:229, 230, 241). Exceptions: R3-1 and L1.
2. **Step numbers and cross-references:** the sequence has steps 1, 1b, 2, 3, 3b, 3c, 4, 4b, 5, 5b, 6, 7, 8, 8b, 8c, 9,
   9b, 10, 10b, 11, 11b, 11c and 12. Every "step N" of the page names one of them and every "section N" an existing
   heading, and each says what the target holds (read one by one). No "4c", "before step 10" or "before the tag" is left.
3. **The sequence block against the sections:** every command of the sections' blocks that is not a listed exception is
   in the sequence, as the same line or the same commands split over lines (the tests of section 6, the orphan commit of
   section 10), and the copies of step 3 (section 8), step 6 (section 11) and steps 10 and 10b (section 14) are the same
   lines. The exceptions are the publish lines of sections 11 and 16.5 (R3-1, R3-2) and three blocks the intro does not
   name (L4).
4. **Sentences that publication makes false:** the two tables match the tree and their perl lines, as run above.
   Missing: R3-3 and R3-4, and, only if the review round runs first, L2.
5. **The rollback section:** matches immutable releases (N6). The `--private` route is not covered (L5).

### New findings, most serious first

**R3-1. Two ways around the gate (C:853 to 877, C:1199 to 1207).** Step 6 sends an owner whose `$OWNER/magnet-web`
exists to section 11 (C:236 to 237), and the block there (C:864 to 867: `gh repo rename`, `git remote add`,
`git push -u origin main`, `gh repo edit --visibility public`) has no `[ "$GATE" = go ] &&`: on that route the code goes
public whatever the gate printed, or in a new shell where `GATE` is unset. The block of 16.5 (C:1202 to 1207), introduced
with "Sequence step 5b runs these commands", publishes `@lightweb/verify` with no gate. Fix: put the gate before the
rename and the push of C:864 to 866, and make the 16.5 block the line of C:230 (or a pointer to step 5b).

**R3-2. The copies of the publish lines leave out the record (C:914, C:1205).** Step 10 and section 14 tag only when
`.git/lightweb-npm-commit` exists (C:326 to 328, 1043 to 1045), and only the lines of step 5b write it (C:229 to 230).
Section 11's `[ "$GATE" = go ] && npm publish --access public` and the 16.5 block do not, so an owner who publishes from
either section gets "STOP: no tag; npm 0.3.0 is another commit, or step 5b did not run (release 0.3.1 instead)" although
npm holds this very commit (the guard without the record, run above). Fix: make C:914 the line of C:229 and the 16.5
block the line of C:230, or let the STOP line say how to write the record when npm's 0.3.0 is this commit.

**R3-3. The not-on-npm route keeps a release-notes line that is false there (C:917 to 922).** Step 3 writes
"`lightweb` and `@lightweb/verify` were published to npm by hand" into the 0.3.0 section (C:142, 718), which
`release.yml` copies into the release notes and the tag keeps. When `lightweb` stays off npm, section 11 asks for the
"Added" line, the recipe and the known gap, but not this line, and the comment of step 3 (C:129 to 130) and section 8
(C:732 to 733) name only a second maintainer and a hub as reasons to change a line. Fix: add the line to C:919 to 921
with its replacement (for example "`@lightweb/verify` was published to npm by hand, without npm provenance; `lightweb` is
not on npm").

**R3-4. Sentences that the first CI run makes false, in no table.** `deploy/pin/README.md:221` and
`deploy/tracker/README.md:150` say that CI "has not run on GitHub yet". `CHANGELOG.md:122` to 123 end the release
program's list with "CI, release (it stops at a draft) and rebuild workflows, never run.": that line is in the 0.3.0
section, so it reaches the notes of a release that `release.yml` made after CI ran. Steps 3c and 11c and their tables
(C:895 to 905, C:1129 to 1134) name none of them, and the search of 11c covers only `README.md`, `SECURITY.md` and
`docs/*.md` (C:368, 370). Fix: reword the changelog line before the squash so that it stays true (for example "none had
run on GitHub before 0.3.0 was pushed"), and add the two README sentences to the table and the perl line of step 11c.

Low:

- **L1.** Step 1 makes the npm organisation `lightweb` (C:83 to 85), a public and empty page, before step 1b, while
  C:60 says nothing of the project leaves the machine before step 5b. It holds no code; say so at C:60, or move it after
  step 1b.
- **L2.** If the review round runs first, step 1b points at `git grep -n 'not yet reviewed'` (C:117), which misses the
  sentences that say it has not run in other words: `README.md:250`, `docs/ONBOARDING.md:10`, `docs/WHY.md:154`,
  `docs/FAQ.md:38`, `docs/COMPATIBILITY.md:6`, `docs/CRITIQUE.md:177`, `docs/INTEGRATION-STATUS.md:7`,
  `docs/PRIVACY.md:7` and `CHANGELOG.md:355` (a search for `review round` finds them).
- **L3.** Step 11c reads `RELEASE_DATE` from the local tag (C:367) and writes "Release status ()" in a clone without
  the tag; nothing checks it.
- **L4.** The intro (C:65 to 69) says every command is in the sequence except the kinds it names, but the check of the
  published `verify.js` (C:1219 to 1221), the search of 16.6 (C:1240) and the real `ship` of section 17 (C:1381 to 1383)
  are in neither.
- **L5.** The `--private` route (C:923 to 926) pushes before step 5b, which "If something goes wrong" does not cover
  ("Before step 5b nothing has left this machine", C:1402).
- **L6.** The header of `release.yml` (lines 30 to 33) still assumes a tag ruleset that limits who creates `v*` tags
  and a reviewer who is not the pusher; step 9b sets neither (the reviewer case is explained at C:1052 to 1054).

### Global checks

1. **`npm test`:** in place at 06:39:32 to 06:39:58, at 06:59:22 to 06:59:47 after this section was written and at
   07:01:52 to 07:02:17 after its last edit: lint-floor clean (147 files) and 2,074 of 2,074 each time.
2. **Words and dashes:** the greps of section 5 print only rule statements (the pull request template, `CONTRIBUTING.md`
   194 to 197, ARCHITECTURE 13 to 15, ONBOARDING 293 to 294, the checklist's own greps, the rule comments of
   `src/loader/strings.js`); `blockchain` only in the README heading and rule statements; `production-ready` only in
   negations; "private by default" and "anonymous" in the checklist only in the rule of C:1340. No en or em dash or curly
   quote in the scope of C:566, in `docs/deviations/v03-fix.md`, in this file or in `pages-demo.yml`.
3. **Privacy:** `git grep -n "$(id -un)"` and `git grep -n "/Users/$(id -un)"` print nothing (06:50, and after this
   section was written). The counts of sections 3, 4 and 6 hold: 30 first-name lines; 16 `"d"` lines (`chat.json`,
   `pin.json`); the private-key and token patterns only in `test/unit/tools-publish-v021.test.mjs`; the home-path grep
   only the example paths and the lines that quote them; 38 placeholder lines in 13 files; 43 `uses:` lines, none
   unpinned.
4. **Tree:** when this round began, `git status --short` showed one modified file, `docs/deviations/v03-fix.md`
   (the fixer's record, 62 added lines); the 06:46 checkpoint `5f8051a` committed it, and at 06:50 `git status --short`
   printed nothing. One branch, no tag, no stash, no remote, 145 commits, all by the checkpoint author. The checkpoint
   loop (pid 74059) still runs, and the next checkpoint commits this file.

### Not checked

Anything on npm or GitHub: `npm view`, the gate before a real `npm publish` and the record after it, `gh repo create`,
the pull requests of steps 11b and 11c, `gh release edit` on a real immutable release (GitHub's documentation above is
the only source) and `npm deprecate`. The end-to-end, browser and example suites and the pack (the code is unchanged),
Firefox, real devices, and a FAT or exFAT drive. The throwaway copies (depth-1 clones without the checkpoint history)
stay in this session's scratchpad; the two throwaway release keys were deleted.

## Round 4 (2026-10-21, 07:57 to 08:28 ET)

Brief (the independent verifier of round 4, after the fixer's "Round 4" in `docs/deviations/v03-fix.md`): check R3-1 to
R3-4 and L1 to L4 of round 3 against the documents, with file and line, without trusting the fixer's report; read
`docs/PUBLISH-CHECKLIST.md` end to end as the owner publishing 0.3.0 (nothing leaves the machine before every go or
no-go of section 9 is answered; step numbers and cross-references agree; the sequence block matches the sections; every
sentence that publication makes false is listed with its replacement; the rollback section matches immutable
releases); run `npm test` and `git status`. Since round 3's base `3e1b671` only the checklist and the two records in
`docs/deviations/` changed (`git diff --stat 3e1b671 HEAD`), so the end-to-end, browser and example suites did not run.
This section is the only change, and it quotes neither the username nor the home path. Checklist lines are cited as
`C:<line>`.

**Verdict: not ready.** R3-1, R3-2, R3-3, L1, L3 and L4 are closed; R3-4 is closed for the three sentences it named, and
L2 for the nine lines it named. The changed commands ran as written on throwaway clones, in bash 3.2 and in zsh, with the
same output in both, and `npm test` passed on the edited trees. One gap of R3-4's kind is left, and it blocks because it
reaches the tag: the 0.3.0 section of the changelog says that the one-box CI job "has not run (nothing was pushed)"
(`CHANGELOG.md:276` to 278), `release.yml` copies that section into the release notes after the first CI run has run
that job on the commit being tagged, and no step or table of the checklist changes the sentence (R4-1). The fix is one
perl line in step 3, its copy in section 8 and one row in the table of section 15. Everything else found is low.

### Runs (macOS 27, Apple M3, Node 24.22.0, loopback only)

`npm test` ran in place. Everything else ran on depth-1 clones of `e12a823` (the 08:01 checkpoint: `cabd7e0` and the
fixer's record) in this session's scratchpad, each with its remote removed, `node_modules` linked and excluded from git,
`GIT_ALLOW_PROTOCOL=file`, and `https://github.com/` rewritten (`url.<base>.insteadOf`) to a local folder holding a bare
repository, so every push and pull of a run stayed on this machine. `npm` and `gh` were stubs that log each call and
reach nothing (`npm view` answers E404; `npm pack @lightweb/verify` packed the local `packages/verify`). The lines ran
as cut out of the checklist by line number, with only the owner's typed values put in (`OWNER`, the answers of step 1b,
the path of a throwaway release key in a folder outside the clone), except where the table says otherwise.

| Check | When (ET) | Result |
|---|---|---|
| `npm test` in place, before this section | 07:59:10 to 07:59:35 | lint-floor clean (147 files); 2,074 of 2,074 |
| The main path in bash 3.2 (`/bin/bash`), sourced in one shell: steps 1, 1b, 2, 3 and 3b as written and the gate line; the old-name and `--private` lines of section 11 with `GATE` unset and with STOP, step 6 with it unset and the line of 16.5 with STOP; 1b with answers (`REVIEW_ROUND` "ran on ..."); 3 twice; 3b twice; 3c; simulated owner edits of the lines the first search lists; the gate line; `npm test`; step 5 without its loop lines and without the fresh clone (its `npm ci` needs the registry); step 5b; the guard of step 10 with its tag line replaced by an echo, five ways; step 6 by the old-name route with `GATE` "go"; step 10 as written without its `sleep`; the notes as `release.yml` extracts them from the tag; step 11b; step 11c in a clone made with `--no-tags`, then in the clone that holds the tag | 08:10:07 to 08:10:35 | As written: E404 twice; STOP, `SECURITY.md:0`, `README.md:0` and 11 lines; nothing; `{"count":219,"head":"5fc03e2d..."}` and STOP; STOP and "NOT PINNED" twice; STOP. `GATE` unset or STOP: no `gh repo` call, no remote, no record (the three calls with `GATE` unset are `gh auth login`, `gh auth status` and `gh run watch` of step 6). With answers: 1 and 1, then 80 lines (10 from the first search, 70 from the second); step 3 wrote `## [0.3.0] - 2026-10-21`, the status, the `[0.3.0]` link and "none of which had run on GitHub before 0.3.0 was pushed", and its second run changed nothing; 3b "pinned" twice, then keygen's refusal, STOP and "NOT PINNED" twice; 3c printed only the 0.2.1 line (`CHANGELOG.md:580` after step 3); the gate "go"; `npm test` 2,074 of 2,074; one squashed commit with the configured author; 5b: "go", E404 twice, the four publish calls, the record equal to HEAD, and `a579df9d...` for the packed `verify.js` and in `packages/verify/README.md:16`. Guard: the tag line with the record of step 5b, after the npm block of section 11 and after the line of 16.5; STOP without the record and after round 3's line `[ "$GATE" = go ] && npm publish --access public`. Old-name route: `gh repo rename`, `main` on the stand-in, `gh repo edit`. Step 10: an annotated tag, pushed to the stand-in. Notes: 364 lines, with the reworded workflows line, and still with "it has not run (nothing was / pushed)" (R4-1). 11b: `LIGHTWEB_COMMIT` set to the tagged commit, one pull request call. 11c without the tag: STOP, 23 search lines, no file changed, "nothing to commit", no branch pushed, no pull request call; with it: 23 lines in 17 files, the deploy READMEs read "CI (`.github/workflows/ci.yml`, job `deploy`) builds", the status line reads "Release status (2026-10-21): 0.3.0 is released", the check printed nothing, the branch reached the stand-in, one pull request call |
| The same driver in zsh 5.9 (`zsh -f`) | 08:11:35 to 08:12:04 | The same output, line for line, apart from commit ids, paths and the throwaway key |
| `lightweb` kept off npm, in bash 3.2 and in zsh: steps 1, 1b with answers, 2 and 3; the two lines of step 3c for `@lightweb/verify` (C:179, C:181); C:967 to 969 twice; 3b; the owner edits; the gate line; `npm test`; step 5; the gate line, `npm view @lightweb/verify`, `npm login` and the line of 16.5; the guard as written; the notes from the tag; step 11c | 08:12:42 to 08:13:50 | The same output in both shells: the git grep printed nothing and the second run changed nothing; the known gap reads "`lightweb` is not published to npm (...) `@lightweb/verify` is on npm, published by hand, so it carries no npm provenance (...)" and the release-notes line "`@lightweb/verify` was published to npm by hand, so it carries no npm provenance: [...]. `lightweb` is not on npm: its package is the `.tgz` attached to this release."; the "Added" line says "on npm, published by hand" and the recipe "Install it with `npm install @lightweb/verify`, or copy"; the gate "go"; `npm test` 2,074 of 2,074; the record equal to HEAD and the tag made; the notes carry the new line and the reworded one, and no "were published to npm by hand"; 11c changed 25 lines in 18 files, the README's two status lines among them, and `README.md:12`, `README.md:100` and `docs/DEPLOY.md:17` (the badge and "isn't on npm yet") stayed |
| The second search of step 1b (C:124) given as input to `bash -i` (3.2 and 5.3) and `zsh -f -i`, followed by a double-quoted `!` | 08:14 to 08:16 | 70 lines in each shell; zsh refused the double-quoted `!` ("event not found"), so the single quotes of C:124 are needed, and they are enough |
| The copies, compared with `diff` | about 08:05 | C:943 to 951 = C:235 to 243; C:1268 = C:243; C:1282 to 1284 = C:244 to 246; C:707 to 716 and C:738 to 744 = C:138 to 154; C:1100 to 1106 = C:342 to 348; C:831 to 833, 844, 845 and 849 to 851 = step 5; C:869 to 872 = C:254 to 257; C:1122 to 1125 and C:1136 to 1142 = step 10b; C:549 to 551 = step 2; the blocks of sections 6, 12, 13 and 17 = steps 4, 4b, 5, 7, 8, 8b, 9 and 12 (the tests and the fuzzers are joined by `&&` there, and step 8 has comments between its lines) |
| Every "step N" and "section N" of the checklist against the 23 steps and the headings (script), then each one read for what it names | about 08:06 | No unknown number; the one other hit is "section 1.1 item 7" of the v0.3 design review (C:31). "Steps 1 to 6 of the `release.yml` header" (C:1129), "section 4 of the agents' resume notes" (C:203, C:823) and "RUNBOOK.md section 11" (C:1175) name their documents |
| Every code line of the sections that is not a line of the sequence (script) | about 08:19 | The checks of sections 2, 3, 5, 7 and 9; the replacements of section 3; the tests of sections 6 and 8 and the squash of section 10, which the sequence runs as joined lines; the old-name, off-npm and `--private` routes of section 11; the manual release of section 14; the search of 16.6; the real `ship` of section 17; "If something goes wrong". Each is of a kind that C:67 to 73 names |

### Round 3, rechecked

- **R3-1: closed.** The four lines of the old-name route (C:893 to 896), the `--private` route's visibility line (C:982)
  and the line of 16.5 (C:1268) start with `[ "$GATE" = go ] &&`, and C:63 to 65, C:863 to 866, C:889 to 890 and C:975
  to 979 say so. Every line of the page that publishes a package or puts the code on GitHub carries the guard (C:242,
  243, 257, 872, 893 to 896, 950, 951, 982, 1268); the unguarded ones are dry runs (C:241, C:949), act on a repository
  that step 6 already made public (steps 7 to 11c, sections 12 to 14), delete the old repository (C:905) or are the
  rollback (C:1480 to 1482). Run: with `GATE` unset or STOP, no `gh repo` call, no remote and no record.
- **R3-2: closed.** C:943 to 951 are C:235 to 243 and C:1268 is C:243, byte for byte; C:936 to 940 say so, and C:1096
  names both copies. Run: the guard reached its tag line after either copy and printed STOP after round 3's line.
- **R3-3: closed.** C:956 to 970 give the text and the two perl lines, run after step 3 and before the squash; the
  comment of step 3 (C:137), section 8 (C:755 to 756) and 16.5 (C:1274) point at them. Run: as in the table; the notes
  that `release.yml` extracts from the tag carry the new line.
- **R3-4: closed for the three sentences it named.** The table at C:1188 to 1195 has a Step column and both new rows;
  step 3's second perl line (C:150, the same at C:740) rewords `CHANGELOG.md:122` to 123 before the squash, and step
  11c's search and perl line cover `deploy/*/README.md` (C:388 to 389, the check at C:393). Run: the notes carry the
  reworded line, and 11c changed `deploy/pin/README.md:221` and `deploy/tracker/README.md:150`. A fourth sentence of
  the same kind is in no table: R4-1.
- **L1: closed.** Step 1 makes nothing on npm (C:87 to 96); step 5b makes the organisation after "go" and before its
  publish lines, and says what to do if the name is taken (C:225 to 228); C:63, section 1 (C:409) and 16.5 (C:1259)
  agree.
- **L2: closed for the nine lines; one sentence is still missed.** The second search (C:124) prints 70 lines, the nine
  of L2 among them (each one checked: `README.md:250`, `docs/ONBOARDING.md:10`, `docs/WHY.md:154`, `docs/FAQ.md:38`,
  `docs/COMPATIBILITY.md:6`, `docs/CRITIQUE.md:177`, `docs/INTEGRATION-STATUS.md:7`, `docs/PRIVACY.md:7`,
  `CHANGELOG.md:355`), and section 9 points at it (C:778). It misses `docs/ARCHITECTURE.md:1346` to 1347, "The review"
  at the end of one quoted line and "> round of R Part 5 (the judges, the red team and the conformance agent against
  the built code) has not run" on the next. The fixer's note that across line breaks the only splits are three "code
  review round 1" lines leaves this one out: the split lines are `docs/ARCHITECTURE.md:651` and 1346,
  `docs/DEPLOY.md:1020` and `docs/DEVIATIONS.md:421`, and only 1346 is about R 5. Low: it matters only if the review
  round runs first.
- **L3: closed.** C:385 to 394. Run: without the tag, STOP and nothing changed, committed, pushed or opened; with it,
  the changes, an empty check, the push and the pull request.
- **L4: closed.** The check is the last three lines of step 5b (C:244 to 246, the same as C:1282 to 1284, and C:1279
  says so), and C:67 to 73 name the third kind; the script above found no other command outside the sequence.
- **L5 and L6** (not in the brief of the round 4 fix) **stay open and low.** L5: the `--private` route now pushes after
  the gate line, inside step 5b (C:975 to 978), so "Before step 5b nothing has left this machine" (C:1465) holds, but
  "If something goes wrong" still does not say what to do with a private repository whose squash must be redone. L6:
  the header of `release.yml` (lines 32 to 35) still assumes a tag ruleset that limits who may create `v*` tags and a
  reviewer who is not the pusher; step 9b sets neither, and C:1109 to 1111 explain the reviewer.

### The checklist, read end to end as the owner

1. **Nothing leaves the machine before the go or no-go:** true. Before step 5b the network calls are reads (`npm view`,
   `npm ci`, `npx playwright install`, `git ls-remote`), plus counsel's review and the mailbox's key, which step 1b
   asks for. Every line that publishes a package or puts the code on GitHub is guarded by the gate (R3-1), the
   organisation is made after "go" (L1), and the gate prints "go" only with the status of step 3 (which takes the
   answers on the review round and on counsel), a pinned `p256:` line and an empty first search (counsel, the mailbox
   and axe-core). The 31 open end-to-end rows (C:783 to 785) stay a decision that no line checks.
2. **Step numbers and cross-references:** they agree (the script and the reading in the table). The sequence has steps
   1, 1b, 2, 3, 3b, 3c, 4, 4b, 5, 5b, 6, 7, 8, 8b, 8c, 9, 9b, 10, 10b, 11, 11b, 11c and 12.
3. **The sequence block against the sections:** every copy is the same text (the table), and every command outside the
   sequence is of a kind the intro names (L4).
4. **Sentences that publication makes false:** the tables at C:924 to 934 and C:1188 to 1195 match the tree and their
   perl lines (run above), and the step 1b searches cover the sentences that the answers make false. Missing: R4-1, and,
   only if the review round runs first, the L2 sentence above.
5. **The rollback section:** it matches immutable releases. GitHub's documentation (Immutable releases, read through a
   web search in this round) says that a published immutable release keeps its assets, that its tag cannot be moved or
   deleted while the release exists, and that its title and notes stay editable, so `gh release edit --notes-file`
   (C:1480) can mark 0.3.0 as superseded; `release.yml:226` to 228 refuse a tag that already has a release; the ruleset
   of step 9b (C:318 to 326) names no bypass actor; and C:1485 keeps a bad draft unpublished.

### New findings, most serious first

**R4-1. A release-notes sentence that the first CI run makes false, in no table (`CHANGELOG.md:276` to 278).** The
0.3.0 section's "Known gaps of phase C2" says of the job that validates the one-box Caddyfile: "the job prints the digest
it pulls, to be copied into `CADDY_IMAGE`, and it has not run (nothing was pushed)." `ci.yml` runs that job (`one-box`,
lines 271 to 298) on every push to `main` (lines 28 to 30); step 9 makes "one-box files" a required check (C:302); step
10 tags the commit that CI passed on (C:1090); and `release.yml` copies the whole 0.3.0 section, its `###` sections
included, into the notes. So the notes of the release, and the tagged `CHANGELOG.md`, which no later pull request can
change, say that a job has not run which has run on that very commit. Neither table (C:924 to 934, C:1188 to 1195) and
neither perl line of step 3 (C:149 to 150) touches it, and C:1184 to 1186 say that one row is changed before the
squash. The runs above extracted the notes from the tag with the sentence in them, in both shells and on both routes.
Fix: a third perl line in the if block of step 3 and of section 8, for example
`perl -0pi -e 's{, and it has not run \(nothing was\n  pushed\)\.}{, and it had not run on GitHub before 0.3.0 was\n  pushed.}' CHANGELOG.md`
(it matches the tree as it is; tried on a copy), and a row for it in the table of section 15, step "3, before the
squash".

Low:

- **L2, the rest** (above): one sentence of `docs/ARCHITECTURE.md` (1346 to 1347) that the second search of step 1b
  does not list.
- **L7.** The not-on-npm route allows "a scoped name you own, such as `@<you>/lightweb`" (C:957), but its perl lines
  write that `lightweb` is not on npm and that its package is the `.tgz` (C:967 to 968), which is incomplete when the
  owner publishes the scoped package, and nothing says how that package is published (step 5b only says to skip the
  `lightweb` lines).
- **L8.** The npm block of section 11 (C:943 to 951) stops at the second publish line, so an owner who publishes from
  section 11 instead of the sequence skips the check of the published `verify.js` (C:244 to 246) unless 16.5 is read;
  C:936 to 940 could name it.
- L5 and L6, as above.

### Global checks

1. **`npm test`:** in place at 07:59:10 to 07:59:35 and at 08:24:50 to 08:25:15 after this section was written:
   lint-floor clean (147 files) and 2,074 of 2,074 each time.
2. **Words and dashes:** the greps of section 5 print only rule statements (the pull request template, `CONTRIBUTING.md`
   194 to 197, ARCHITECTURE 13 to 15, ONBOARDING 293 to 294, the checklist's own greps, the rule comments of
   `src/loader/strings.js`); the word of the second grep appears only in the README heading and in rule
   statements, and the release label of C:12 only in negations. No en or em dash or curly quote in the scope of C:587,
   in `docs/deviations/v03-fix.md` or in this file.
3. **Privacy:** `git grep -n "$(id -un)"` and `git grep -n "/Users/$(id -un)"` print nothing, before and after this
   section was written, and the first-name grep of section 3 (C:496) prints 30 lines, as C:502 says.
4. **Tree:** when this round began, `git status --short` showed one modified file, `docs/deviations/v03-fix.md` (the
   fixer's record, 65 added lines); the 08:01 checkpoint `e12a823` committed it, and `git status --short` then printed
   nothing. One branch, no tag, no stash, no remote, 150 commits when this section was written, all by the checkpoint
   author. The checkpoint loop still runs, and the next checkpoint commits this file.

### Not checked

Anything on npm or GitHub: `npm view`, creating the organisation, `npm login`, both `npm publish` lines and the record
after a real one, `npm pack` of the published `@lightweb/verify`, `gh repo create`, `rename`, `edit` and `delete`, the
pushes, the pull requests of steps 11b and 11c, `git fetch origin tag v0.3.0`, `gh release edit` on a real immutable
release (GitHub's documentation is the only source) and `npm deprecate`. The end-to-end, browser and example suites and
the pack (the code is unchanged), Firefox, real devices and a FAT or exFAT drive. Pasting the steps into an
interactive terminal was not tried beyond the search of C:124. The throwaway clones, their stand-in repositories, the
cut-out lines and the drivers stay in this session's scratchpad; the throwaway release keys were deleted.
