# governance-roadmap: notes and deviations (productionize wave, 2026-10-19)

Agent: `governance-roadmap`. Owned: `CONTRIBUTING.md`, `GOVERNANCE.md`, `CHANGELOG.md`, `docs/ROADMAP.md`, `docs/README.md`
(the documentation index) and `docs/PUBLISH-CHECKLIST.md` (a draft; the editor finalises it). This file is the only other
file written.

## Where this run started

The first run of the wave died at 20:42 ET (a DNS outage). Its work was in the checkpoints of 20:23 and 20:38 ET:
`CONTRIBUTING.md`, `GOVERNANCE.md`, `CHANGELOG.md`, `docs/ROADMAP.md` and `docs/PUBLISH-CHECKLIST.md` existed in full
drafts, and `docs/README.md` did not exist. Nothing was started over. Every statement in the drafts was re-checked
against the code, the tools' `--help` output and the digests, and the drafts were corrected and extended in place. The
baseline `npm test` was red for one reason that touched an owned file (`docs/README.md` missing); the other missing
documents belong to other writers of the wave.

## What changed, by file

| File | Change |
|---|---|
| `docs/README.md` | New: start-here paths for site owners (new and existing sites), developers, operators and reviewers; every document in a table with a one-line description; which documents are normative; a glossary of ten terms; conventions |
| `CONTRIBUTING.md` | Corrected four statements (below), added the tool shortcuts, the Discussions route, what CI runs, what reviewers look for, the vector freeze step, the recipes index and a release process written against the real `release.yml` |
| `GOVERNANCE.md` | Re-read against `SECURITY.md`, the issue forms and the label list; no change was needed |
| `CHANGELOG.md` | Kept `## [Unreleased] - 0.2.1` and the round-1 section. Added the `magnet-web` command, the examples, the project files, the deploy templates and the three workflows, a Deprecated section (`anchorBtih`), the identity, single-machine and not-on-npm known gaps; an explanation of the two kinds of item code; corrected the reconnect and size-cap wording; 0.2.0 heading without a dangling link |
| `docs/ROADMAP.md` | Kept the round-1 table (F13, F36, F39, F53). Added a pointer to the digests and to what 0.2.1 already took from them, rows for the web-seed list policy, the skipped v0.1 test, a moderator import in the drop-in panel, size budgets (measured sizes of the 0.2.1 build), migration acceptance (MD M01, M13, M17) and hardware-backed owner signing (PD P1-14, P1-15), a "Where help is most useful" table, the identity gap, and the real state of release provenance (an unsigned `SHA256SUMS` exists) |
| `docs/PUBLISH-CHECKLIST.md` | Named the known hits of the secret and path greps, tested scrub commands, a fresh-clone check, a tighter unfinished-marker grep, a check that every pinned action hash exists, the vector freeze status, a repository-local git identity (squash commit and tag), REST calls for repository settings, the Pages prerequisites, and step 12 rewritten around what `release.yml` does |

## Statements in the drafts that were wrong or unclear, and the correction

1. CONTRIBUTING said the `docs-links` test checks dashes in `README.md` and `docs/*.md`. It checks banned words there, and
   dashes and curly quotes in six named documents only. Said so, and pointed at the checklist greps.
2. CONTRIBUTING said probes run only from `check-site`, `check-webseed` and `pin` and run "in Node, never in a browser".
   `pin`, `check-site --headless` and `snapshot <url> --remote` drive Chromium, which loses the local-only flags only for a
   page that is not on loopback (`allowRemoteFor`, `tools/live.mjs`). Reworded.
3. CONTRIBUTING said `v021-integration.test.mjs` checks that the version constants agree with `package-lock.json`. It checks
   `package.json` and three constants and does not read the lock file. Said so.
4. CONTRIBUTING named the example's `.dev/` folder. The editor's brief moves or deletes `.dev` directories under
   `examples/`, so the text now points at the `test:example` script instead.
5. The checklist's path scrub rewrote every `/Users/<name>` in the tree, which would have changed the illustrative paths
   in `docs/QUICKSTART.md` and `test/unit/tools-demo.test.mjs`. It is now limited to `docs/research`, with a second pass
   for the remaining username forms.
6. The CHANGELOG said gossip at the size cap "no longer ... drops owner and moderator blocks", which reads two ways. The
   specification (section 6.3) says owner, moderator and allow-listed blocks are still ingested at the cap. Reworded to
   say that.
7. The checklist's `OWNER` searches used `git grep -E` with `\b`. On this macOS machine `-E` does not understand `\b`, so
   the search silently skipped `@OWNER` in `GOVERNANCE.md` (and two other files) and the "must print nothing" check
   would have passed with placeholders left. They use `-P` now, and leave the checklist itself out because it quotes the
   patterns. Tested on a throwaway repository.

## Checks run

- Every flag named in the six files exists: each tool's `--help` (publish, keygen, ledger, tracker, dev, demo,
  check-site, check-webseed, pin, seed, snapshot, build), `bin/magnet-web.mjs --help` and `--version`, `node build.mjs
  --check-lock`, `npm run publish:site -- --help`, `npm run check:example`, and the gh flags used by the checklist against
  `gh 2.102.0 --help` (not run against GitHub: `gh` is not authenticated).
- At the start `npm test` ran 913 tests, 912 passed; the one failure was `docs-links`, for documents that did not
  exist yet. `npm run test:example`: 29 passed. `npm run test:browser`: 31 passed, 1 skipped. These match
  `docs/INTEGRATION-STATUS.md`. At 21:40 ET, with the other writers' documents in place, `npm test` ran 921 tests and
  all passed (the restructure writer added `test/unit/cli-bin.test.mjs`, 8 tests). The end-to-end suite was not re-run (it takes
  about two minutes and other writers were running tests at the same time), so the 25 of 25 and 26 of 26 figures are
  INTEGRATION-STATUS's.
- The workflows were read once they landed. `ci.yml` runs the suites on Node 22 and 24, a reproducible-pack job and a
  `deploy/` job; `release.yml` refuses a tag that differs from `package.json` or a version without a changelog heading,
  runs the tests and attaches the built loader, the npm package and `SHA256SUMS` (a pre-release below 1.0);
  `pages-demo.yml` lists its own repository prerequisites. The pin grep prints nothing for `.github/workflows` and
  `deploy/`. Whether the pinned hashes are real commits could not be checked offline (the checklist has the command).
- Every "on the roadmap" or "ROADMAP" reference in `MIGRATION`, `SDK`, `DEPLOY`, `COMPATIBILITY`, `FAQ`, `OPERATIONS`,
  `CRITIQUE`, `PRIVACY`, `SECURITY-MODEL`, `ONBOARDING` and the README was matched to a row or a section of
  `docs/ROADMAP.md`. `MIGRATION.md` promised a `publish --check` report, which the roadmap did not list; it does now
  (migration acceptance).
- `npm pack --dry-run`: 88 files, 483,266 bytes, none of them a key, local state or dependency folder.
- The scrub, the `OWNER` replacement and the release-notes extraction commands were run on a throwaway repository in the
  scratchpad, not on this tree.
- Evidence ids in the roadmap (RD, MD, PD, ID rows, DA G, DR section 3) were looked up in the digests one by one.

## Decisions made (the owner can reverse any of them)

- **Node.** The text says "Node 22 or newer" (the `engines` field) and that Node 24 is what the project is developed and
  tested on. Nothing in this tree was run on Node 22.
- **Inbound equals outbound licensing.** CONTRIBUTING says a pull request is licensed under the repository's MIT License,
  with no contributor agreement and no sign-off. That is a policy choice, not a fact; it is the common default.
- **Commit subject prefixes** (`loader:`, `sw:`, `ledger:`, ...) are a convention proposed for new contributors. The
  history so far is automatic `checkpoint:` commits.
- **`Breaking` stays a CHANGELOG heading** although Keep a Changelog does not define it, because GOVERNANCE tells
  contributors to use it. `Deprecated` was added because the format defines it.
- **The roadmap keeps its four tiers** (Next 0.3, 1.0, Later, Not planned) and does not give dates. F13 stays in "Next" but
  now says it needs an RFC and a new pointer version.
- **The checklist makes the first repository private** and public last, unlike the editor's one-line `gh repo create
  --public --push` in the wave brief. A repository that has been public cannot be taken back.
- **The checklist uses `gh api` calls** for private vulnerability reporting, Dependabot alerts and the default workflow
  token. They are documented REST endpoints but were not run.

## For the editor and the owner (outside my files)

1. The two specification files still use long dashes: `docs/ARCHITECTURE.md` (11 lines) and `docs/INTERFACES.md` (1 line).
   The `docs-links` dash test does not cover them; the checklist grep does.
2. `.github/ISSUE_TEMPLATE/bug_report.yml` has `placeholder: "0.2.0"` for the version field. It should read 0.2.1.
3. `docs/research/labs/w1-13-lab/tls/{cert,key}.pem` is a tracked private key (a two-day self-signed `localhost`
   certificate). Remove it before publishing (checklist step 3).
4. 96 files under `docs/research` carry the build machine's home directory and 105 files carry the username. The
   checkpoint commits use a placeholder author, but the squash commit and the tag use whatever git identity is
   configured, unless the repository-local identity of checklist step 3 is set first.
5. `test/vectors/LOCK.json` has 33 entries and `FROZEN` in `test/unit/formats-vectors.test.mjs` ends at 28. Freezing the
   chain head for 0.2.1 is a one-line change to a test file I do not own (the checklist step 8 prints the entry).
6. ARCHITECTURE section 8 has no "no incentive layer" clause, which ID P0-25 asks for; the roadmap's "Not planned" table
   states it.
7. `release.yml` copies the changelog section into the release notes as it is. A relative link such as
   `docs/ROADMAP.md` does not resolve from a release page. Either rewrite the links in the workflow (point them at the
   tag) or use the command in checklist step 12 after the release.
8. `docs/SECURITY-MODEL.md` (the supply-chain list) says checksums are on the roadmap for 1.0. `release.yml` already
   attaches an unsigned `SHA256SUMS`; the roadmap now says "beyond today's `SHA256SUMS`". Reword the security model to
   say signed checksums and attestations.
9. The test count is now 921 (913 plus the tests added since, in `cli-bin.test.mjs`), and other writers may add more. The figures
   in `README.md`, `CHANGELOG.md` ("Verified on"), `docs/PUBLISH-CHECKLIST.md` (step 6) and `docs/INTEGRATION-STATUS.md`
   need the numbers of the last run. `CONTRIBUTING.md` no longer repeats them.
10. The pinned action hashes in `.github/workflows/*.yml` and `deploy/github-actions/publish-site.yml` could not be
   verified offline. A hash that is not a real commit fails the first CI run. Checklist step 6 has the command.
