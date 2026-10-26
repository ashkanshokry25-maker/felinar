# editor: notes and deviations (productionize wave, 2026-10-19)

Agent: `editor`. Brief: the final pass before the first public release. (1) The same names, flags, numbers and claims
across `README.md` and every `docs/*.md`, with the README tightened to a landing page. (2) Repository hygiene: no
scratch files, no test tooling inside `examples/`, a complete `.gitignore`, a package that holds only what the command
needs, the `OWNER` placeholders listed, a secrets grep, and the exact squash command (no squash). (3) The final
`docs/PUBLISH-CHECKLIST.md` with the owner's exact commands. (4) The last `npm test` and `npm run test:e2e`, with the
counts in `CHANGELOG.md`. Nothing was pushed, tagged or published, and no GitHub setting was touched (`gh` is not
authenticated here). Times are Eastern.

The run started at 22:34 ET on the tree that fresh-eyes had just finished (its changes uncommitted on top of
`095ed87`). The checkpoint loop committed the tree at 23:00 and 23:15 ET (`621455b`, `b60e4fd`) while this pass was
under way; the later edits are in the working tree for the next checkpoint. This agent made no commit.

## What changed

| File | Change |
|---|---|
| `examples/peer-guestbook/.dev/` to `test/example/` | moved with `git mv` (the brief: no `.dev` directories in examples); the five files find the site at `../../examples/peer-guestbook` and the launch flags at `../e2e/browser-args.mjs`; `site.test.mjs` checks the folder's scripts for ASCII only, as before, and now also that the site has no `.dev/` |
| `examples/existing-site-dropin/.fixture/` to `test/fixtures/existing-site-dropin/` | moved for the same reason (a dot-directory of test tooling inside an example); `stage.mjs` points `FIXTURE_DIR` at the example; `test/e2e/run.mjs` and `test/unit/dropin-fixture.test.mjs` import from the new place |
| `test/unit/repo-layout.test.mjs` | checks that no tracked file under `examples/` sits in a dot-directory, that the moved files exist, and that `run.mjs` imports the fixture from `test/fixtures/` |
| `package.json` | `test:example` and `check:example` run `test/example/`; `CHANGELOG.md` left the `files` list (npm doesn't add it by itself, checked with `npm pack --dry-run`) |
| `.github/workflows/ci.yml` | the pack check no longer allows `CHANGELOG.md` |
| `.gitignore` | regrouped; adds `*.pem`, `*.key`, `*.p12`, `*.pfx`, `.env.*`, `*.bak`, `*.orig`, `*.rej`, `*.swp`, `playwright-report/`, `deploy-root/` (QUICKSTART A3), `release-notes.md` and `pack-list.txt` (the checklist) |
| `docs/research/labs/w1-13-lab/tls/{cert,key}.pem` | deleted: the only tracked private key (a two-day self-signed `localhost` pair) |
| `docs/research/labs/w2a-08-lab/dbg4.mjs.bak` | deleted: the one scratch file a search for backup, temporary and editor files found (a backup of `dbg4.mjs`, named nowhere) |
| `README.md` | rewritten as a landing page: 3,381 to about 2,500 words of prose (code excluded), "Why" as one table of benefits with their conditions, the twelve statements kept (CRITIQUE links them as twelve), the 4.5 sentences on removing files and posts added to item 7, "How it compares" moved to WHY, compatibility folded into the status paragraph, the migration section cut to one command block |
| `docs/WHY.md` | gains "How it compares" (the README's table) |
| `docs/PUBLISH-CHECKLIST.md` | final: the whole sequence in one block, then the sections (details below) |
| `CHANGELOG.md` | the last test counts; the C1 sentence on DNS-over-HTTPS (it read as if a page tag allowed a lookup before the choice); the "Known gaps" line on the package (the release `.tgz` installs the command) |
| `docs/ARCHITECTURE.md` section 8 | the same DoH sentence, reworded to say what the code does (`dnsAllowedBy` in `src/loader/consent.js`, `askBeforeDns` in `src/loader/app.js`): no lookup before a choice; a page tag or a cached pointer renders without one; a DNS-only site asks first. No rule changed |
| `docs/FAQ.md` | "Who can see a visitor's IP address?" now says a shell page asks DoH after "Share and load" whether or not a record exists (as README, WHY and PRIVACY already did); "Can another visitor tamper with my files?" no longer claims a per-file SHA-256 check (serving checks SHA-1 pieces, `src/loader/verify.js`); the test counts point at INTEGRATION-STATUS instead of repeating them |
| `docs/ONBOARDING.md` | the privacy-notice paragraph names the DoH resolvers for every shell site, not only those with a DNS record |
| `docs/OPERATIONS.md` | the two economics tables copied from WHY became two sentences with the same figures and a link: one source for the model numbers; the canary workflow example passes its ping secret through `env:` instead of a `${{ }}` expression inside `run:`, the rule the repository's own workflows follow (DEPLOY, CI/CD; `repo-layout` enforces it for `.github/` and `deploy/` only) |
| `docs/README.md` | the convention line said "the guides use the `node tools/...` form", but DEPLOY, OPERATIONS and DEMO-RESULTS use `npx magnet-web`; it now says which document uses which |
| `docs/QUICKSTART.md` | the A2 sample output (re-run: same infohash `bdc1ee08...`, `Left out of the torrent (1)` now that `.dev/` is gone); A4 clones the Pages repository next to the clone (`../pages`), not inside it, so `git add -A` in the clone can't pick up a nested repository; the A5 sample shows `/mw-sw.js` at 69 KiB (70,721 bytes in today's build) |
| `docs/recipes/github-pages.md` | the same `../pages` change |
| `docs/CRUD.md`, `docs/SDK.md`, `docs/MIGRATION.md`, `CONTRIBUTING.md` | the moved paths; CONTRIBUTING's layout and test tables list `test/example` and `test/fixtures` |
| `docs/DEVIATIONS.md` | a note on the 0.2.1 paths, and where the v0.2.1 and release-wave notes are read in place |
| `docs/ROADMAP.md` | one "Next" row for the tool output that fresh-eyes found wrong and nobody fixed (see "Open" below) |
| `examples/peer-guestbook/README.md`, `examples/existing-site-dropin/README.md` | the moved paths; the guestbook demo says "two different browsers (or two browser profiles)" like the README |
| `examples/landing/README.md`, `examples/landing/index.html` | the same two-browser wording (two windows of one profile are one visitor, so "the box counts the other window" was wrong); the README's placeholder command became a fork command that doesn't name `OWNER`, so the checklist's "must print nothing" grep can pass |
| `docs/INTEGRATION-STATUS.md` | a dated "Current state" for this pass |

## The checklist

- The brief's commands are there in this order: the placeholders, the vector freeze, the changelog heading
  (`[Unreleased] - 0.2.1` to `[0.2.1] - <tag date>`, with a new empty `[Unreleased]` and the compare link), the tests,
  the squash, `gh auth login`, `gh repo create "$OWNER/magnet-web" --public --source . --remote origin --push`, the
  description and topics, Discussions, the security settings, GitHub Pages with a custom domain (the demo needs the
  root of an origin), the branch protection of `main` with the check names CI produces, and the tag `v0.2.1`.
- `OWNER` is a shell variable in every command, so the block runs as written after one `export`.
- Tested on throwaway copies on 2026-10-19: the placeholder replacement (a clone: 10 files, nothing left), the
  changelog command (the heading, the new section and the link), the vector freeze command (one line after the
  entry for 28, head `58b24c0f...` of all 33 lock entries), and the squash (a clone: one commit, an empty
  `git diff --stat main release`, a bundle that verifies). Every `gh` flag used was checked against
  `gh <command> --help` (gh 2.102.0). The REST calls (Pages, branch protection, private vulnerability reporting,
  workflow permissions) could not be run without an account.
- The placeholder replacement now leaves out `docs/research`, `docs/review` and `docs/deviations`. The draft's
  command rewrote every file, which would have changed GitHub's `repo:OWNER@OWNER-ID/...` claim format quoted in
  `docs/research/w2a-06-cicd-automation.md` and the history in `docs/deviations/governance-roadmap.md`.

## Deviations from the brief

1. **The package holds two files beyond src, tools, bin, build.mjs, README and LICENSE:** `build.lock.json`, which
   `build.mjs` reads to check the vendored bundle, and `test/e2e/browser-args.mjs`, which `tools/live.mjs` imports
   for `pin`, `snapshot` and `check-site --headless`. Without the second, `magnet-web pin` fails from the package.
   Moving it into `tools/` would break the binding "tools/ (unchanged)", and `test/unit/cli-bin.test.mjs` requires
   both in `files`. `CHANGELOG.md` was dropped. The package: 87 files.
2. **`.fixture/` moved as well as `.dev/`.** The brief names `.dev`; the drop-in example had the same kind of
   dot-directory of test tooling, and the layout's `test/fixtures` was empty.
3. **`test/example/` is a fifth folder under `test/`,** next to `unit`, `e2e`, `fixtures` and `vectors` (the layout
   lists three). The checks keep their own script and count (29), so CI, RUNBOOK and the changelog stay as they were.
4. **Not done here, on purpose:** the vector freeze and the changelog date. Both are one command in the checklist
   (section 8); the freeze edits a test file outside this brief, and the date is the day the owner tags.
5. **Files outside README and `docs/` were edited** where a move or a wrong claim required it: the three example
   READMEs, one sentence of the homepage (`examples/landing/index.html`), CONTRIBUTING, CHANGELOG, the CI workflow,
   `package.json`, `.gitignore`, the moved test files and three tests that import or check them.

## Checks run (2026-10-19)

- After the last change to code or tests (23:12 to 23:18 ET): `npm test` 929 of 929 after a clean lint-floor of 62
  files; `npm run test:e2e` 25 of 25 and network policy PASS in 128.1 s; `npm run test:e2e:webkit` 26 of 26 and
  network policy PASS in 128.8 s; `npm run test:browser` 31 pass and 1 skipped; `npm run test:example` 29 pass. The
  counts are in `CHANGELOG.md` and INTEGRATION-STATUS; they equal the counts before this pass.
- An early `npm run test:e2e` right after the moves (finished 22:55 ET): 25 of 25, network policy PASS, 127.6 s.
- Every `--flag` on a command line of a tool in README, CONTRIBUTING, GOVERNANCE, SECURITY, CHANGELOG, `docs/*.md`,
  `docs/recipes/*.md`, the example READMEs and the deploy READMEs is in that tool's `--help` (545 flags; the hits
  left are `--help` itself and an error message that `publish` prints).
- Every quoted section reference (`[X.md](X.md), "Heading"`) and every `#anchor` in those files resolves, and every
  relative link points at a tracked file.
- The wording rules (`docs-links`), the dash and curly-quote grep over README, the top-level documents, `docs/*.md`,
  the recipes, the example and deploy READMEs: clean.
- Secrets: no `.jwk`, `.pem`, `.key` or `.env` file is tracked; the only private-key and token hits are the fakes in
  `test/unit/tools-publish-v021.test.mjs`. No personal e-mail address is tracked.
- `npm pack --dry-run`: 87 files, about 478 KB packed.
- The bundle sizes WHY quotes, re-measured on today's build with `gzip -9`: `loader.js` 116,768 bytes,
  `webtorrent.min.js` 64,297, `mw.js` 104,880 (322,368 raw), as written.
- No `hang.test.mjs` process from earlier runs was left (fresh-eyes counted 39 at 22:30 ET; none at 23:15 ET).

## The squash command (for the owner; not run on this repository)

    git add -A && git commit -m "Prepare magnet-web 0.2.1"
    git bundle create ../magnet-web-checkpoints.bundle --all
    git checkout --orphan release && git add -A && git commit -m "magnet-web 0.2.1"
    git diff --stat main release      # must print nothing
    git branch -M release main

## Open

1. **Personal data in the research folder.** 96 files under `docs/research` hold the build machine's home directory
   and 105 files hold the macOS username (one more in `docs/review/code-review-security.md`); the notes also address
   the owner by first name and mention a hardware security key. The checklist (section 3) has tested scrub commands;
   whether to run them is the owner's call.
2. **The npm name `magnet-web` is unclaimed.** `npx magnet-web` in the README, DEPLOY, OPERATIONS and DEMO-RESULTS
   runs the clone only inside a clone. The checklist (section 1) lists the choices.
3. **Tool output found wrong by fresh-eyes and still open** (now one ROADMAP row): `snapshot`'s
   `DecompressionStream` warning, `csp.txt` and `webseed-layout.txt` written for drop-in, the `--prev-key` upload
   hint, `ledger-admin` writing plain JSON under `.json.gz`, silently skipped `_redirects` lines, one ledger id for
   every `localhost` demo site, and `src/dropin/mw.js` line 17 still naming `engine` in `window.__mwDropin`.
4. **The research lab `w1-13-lab` needs a new TLS pair** to re-run test T5 of `d1-tracker-semantics.mjs`:
   `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=localhost -keyout tls/key.pem -out tls/cert.pem`
   inside the lab folder (`.gitignore` keeps the pair out of git now).
5. **Nothing of GitHub was exercised:** the workflows, Pages, the branch protection and the release run for the first
   time when the owner pushes.
