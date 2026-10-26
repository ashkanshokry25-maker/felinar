# post-wave verify: independent check before the owner publishes (2026-10-20)

Brief: after the post-wave fixer, check the tree without trusting the fixer's report: (1) overstated claims in
README.md, docs/*.md, docs/recipes/*.md, src/loader/strings.js and tools/*.mjs; (2) docs/PUBLISH-CHECKLIST.md against
what an owner needs; (3) `npm test`, `npm run test:e2e` and `npm pack --dry-run`; (4) a clean tree apart from
checkpoint commits; (5) the privacy greps; (6) what the checklist says about the checkpoint history and its bundle.
This file is the only change.

**Verdict: not ready.** The checklist still offers to push the checkpoint history and never says that the history
and its bundle hold a research lab's private TLS key and the personal paths (gap 1). Everything else passes. Three
sentences drop a qualifier for sites found only through DNS, one historical note lacks a "superseded" mark, and one
number is stale (see "Claims").

## Runs (macOS, Node 24.22, loopback only)

| Check | When (ET) | Result |
|---|---|---|
| `npm test` | 00:44:49 to 00:44:56 | lint-floor clean (62 files); 937 of 937 pass, 0 fail |
| `npm run test:e2e` | 00:45:18 to 00:47:25 | 25 of 25 PASS in 127.5 s; "PASS network policy: every request stayed on 127.0.0.1" |
| `npm pack --dry-run` | about 00:51, run twice | 87 files, 481,972 bytes packed both times; nothing outside `bin/`, `src/`, `tools/`, `build.mjs`, `build.lock.json`, `test/e2e/browser-args.mjs`, `README.md`, `LICENSE`, `package.json`; no key, local state or dependency folder |
| `node build.mjs --out <scratch dir>` and `--check-lock` | about 00:58 | lock check passes; `loader.js` 357,499 bytes (117,242 with `gzip -9`), `mw.js` 323,225 (105,072), `webtorrent.min.js` 222,343 (64,297), the fixer's figures to the byte |
| `npm run test:e2e:webkit` | 01:05:02 to 01:07:09 | 26 of 26 PASS in 127.5 s (W7: WebKit 27.2 cold start, 127.0.0.1 only); network policy PASS |
| `npm run test:browser` | about 01:07 | 31 pass, 1 skipped (the v0.1 `sw-browser`); Firefox fails to launch on this machine, as before, so `chain-core-browser` ran in Chromium and WebKit, on 127.0.0.1 only |
| `npm run test:example` | about 01:07 | 29 of 29 pass (Chromium and WebKit) |

The last three suites are beyond the brief; they ran while waiting for the checkpoint, to check the counts the
documents quote. Before the runs the launch sites were read: every Chromium launch passes the local-only flags of
`test/e2e/browser-args.mjs`, WebKit loads only `http://127.0.0.1` URLs, and `ALLOW_REMOTE` was unset.

## Tree and history (item 4)

- At 00:43 ET the fixer's last edits (12 files, written from 00:31 to 00:42 ET) were not yet committed. The
  auto checkpoint of 00:45 ET (`2b9b27c`) committed them, and `git status --short` printed nothing after it until
  this file was written: no untracked files, and the ignored paths are local state (`dist/`, `.tools/`,
  `.orchestration/`, lab logs). One branch (`main`), no tags, no stash. The next auto checkpoint commits this file.
- The checkpoint loop is still running (its pid is in `.orchestration/checkpoint-loop.pid`; every 15 minutes until
  about 05:00 ET).
- The history had 55 checkpoint commits at 00:45 ET. The private key of the w1-13 lab's `localhost`
  certificate (`tls/key.pem`, first under `docs/research/w1-13-lab/`, later under `docs/research/labs/w1-13-lab/`)
  is in every commit from `735f349` until `621455b` removed it. The build machine's home path and username are in
  every commit from `735f349` until `3130928` replaced them, and the username once more in `2d1862f` (00:30 ET),
  where post-wave-fix.md quoted it in a grep command until `2b9b27c` removed it. HEAD holds neither: `PRIVATE KEY`
  appears only in the checklist's grep pattern and in the fake keys of `test/unit/tools-publish-v021.test.mjs`.

## Claims (item 1)

Fixed, checked in the tree:

- The 13.3x drop-in egress figure is called a model (arithmetic, not a measurement) everywhere it appears in the
  README and the docs, in `egressNote` of `tools/publish.mjs` and in DIGEST-AMENDMENTS E5.
- ONBOARDING names the SHA-1 piece hashes. SHA-256 appears for the `/.mw/files.json` listing, ledger blocks, key
  fingerprints, build pins and release sums, never for piece or file verification.
- The banned terms of DESIGN-REVIEW section 4.2 appear only where a rule quotes them; the word that 4.1 allows once
  appears only in README's "Why not ..." heading and in rule quotations; every hit on isolation for a shared-origin
  hub is a negation; "production-ready" appears only in negations and as the name of the 1.0 bar.
- The snapshot text says every loader reads gzip, Safari and iOS 15.4 to 16.3 included (`tools/snapshot.mjs`, CRUD,
  DEMO-RESULTS); the old "--plain for Safari before 16.4" survives only in DEVIATIONS.md with its superseded note.
- No document says a key rotation starts a new ledger (RUNBOOK says the ledger survives a rotation; the remaining
  phrases are about `--new-genesis` and a lost key, both true).
- The page tag is said to load the site without a lookup, and "Share and load" then to let a shell page ask the
  DoH service on the schedule the code has: right after the choice, every 5 minutes or the record's TTL, and on
  focus at most once a minute. `shouldSkipDoh` skips IP literals, single labels, localhost, .local, .test and the
  other reserved names, as RUNBOOK says. The drop-in sources contain no DoH code; the one resolver string in the
  built `mw.js` comes from the shared config.

Still wrong (small):

1. `README.md:75-76`: '"Load from host only" makes no lookup' holds only on a site with a page tag. On a site found
   only through DNS, both buttons of the blocking card allow the lookup (`src/loader/ui.js:221`;
   `src/loader/app.js:904` then calls `resolveSitePointer` with `dohAllowed: true`), the stored record carries `dns`
   (`src/loader/consent.js:74`), and the page keeps checking. The card itself says so (`consentDnsAgain`: "whichever
   you choose"). PRIVACY.md line 36 and RUNBOOK.md line 122 already limit it to a site with a page tag,
   and ARCHITECTURE.md section 4 states the DNS-only exception. Suggested: '"Load from host only" makes no
   lookup on a site with a page tag; a site found only through DNS asks with either button.'
2. `docs/WHY.md:106`: the same sentence.
3. `docs/SECURITY-MODEL.md:72`: '"Load from host only" uses only the web seed', with the same exception (a DNS-only
   site also asks the DoH service).
4. `docs/DEVIATIONS.md:573`: the merged v0.2 drop-in note still says a site can "call `mw.consent.accept()`", with no
   superseded mark. v0.2.1 A4 removed that call (RUNBOOK.md line 202, ARCHITECTURE.md line 275). Add a note like the
   one at line 383.
5. `docs/PUBLISH-CHECKLIST.md:360`: "481,961 bytes packed" predates the last edits to `README.md`, `src/loader/app.js`
   and `tools/publish.mjs`, which landed between the 00:30 and 00:45 checkpoints. The final tree packs to 481,972 bytes
   (the same over two runs, still 87 files).

## Privacy (item 5)

`git grep -n` for the username and for the home-directory path prints nothing, and so does a case-insensitive grep
for any part of the owner's name. A home-directory path appears only in the two example paths that stay (QUICKSTART
and `test/unit/tools-demo.test.mjs`) and where the checklist and post-wave-fix.md quote them. The scratch paths in lab
files now carry a placeholder. Left for the owner by design (post-wave-fix.md, "Owner decisions"): the short form of
the first name on 26 tracked lines, the security key's model, the short hostname, one public IP address (a STUN
answer) and the research vantage point. This file names none of them.

## PUBLISH-CHECKLIST (items 2 and 6)

Present and checked:

- `gh auth login`; `gh repo create "$OWNER/magnet-web" --public --source . --remote origin --push`.
- Pages: workflow build, CNAME, certificate, `https_enforced`, and `gh workflow run pages-demo.yml`, which has
  `workflow_dispatch`.
- Discussions, description and topics (`gh repo edit`); secret scanning, private vulnerability reporting,
  Dependabot alerts and a read-only workflow token.
- Branch protection with the contexts `test (Node 22)`, `test (Node 24)`, `reproducible pack` and `deploy files`,
  which match the job names in `ci.yml`.
- The CHANGELOG heading rename before the tag; `release.yml` refuses a tag without a `## [0.2.1]` heading.
- The squash command, the pin check (34 `uses:` lines, 7 actions, each with a tag comment), the npm name check and
  publishing before the repository is public, the first-CI-run warning, and "Agents never push".

On a throwaway local clone outside the repository: step 2 replaced the placeholders in 10 files and its check printed
nothing. Step 3 applied both edits, the vector head printed was the one the checklist freezes (33 entries,
`58b24c0f...`), and `formats-vectors` passed 5 of 5. Step 5 gave one commit with the author set in step 1, an empty
`git diff --stat main release`, and a squashed tree with neither the key nor the username. The bundle still holds both.

Gaps:

1. Item 6 is not met. The checklist never says that the checkpoint history and the bundle made from it hold the w1-13
   lab's private TLS key and the personal paths, and therefore that only the squashed orphan commit may be pushed and
   the bundle never leaves this machine. Instead it still offers to push the history: section 1 (line 119, "One
   squashed commit, or the history"), section 3 (line 162, "squash (section 10) or accept it") and section 10
   (line 440, "If you would rather keep the history, skip this section"). Section 10 (lines 437 and 438) says only
   "Don't push the bundle". Keeping the history would publish the key, and the home path and username in about 105
   files. Suggested: make section 10 mandatory, say why in one sentence with the commit range, drop the alternatives
   in sections 1, 3 and 10, and say that the bundle is not pushed, attached to a release or copied to anything that
   syncs.
2. No step stops the auto-checkpoint loop before the squash. While it runs, it does `git add -A` and commits with the
   placeholder author every 15 minutes. That commit can land on the orphan branch between `git checkout --orphan
   release` and the owner's commit, or after the squash. Add `kill "$(cat .orchestration/checkpoint-loop.pid)"`
   before section 10, with a check that the process is gone. A running loop would also commit the files that the
   manual release of section 14 writes at the root (`magnet-web-0.2.1-dist.zip`, `SHA256SUMS`), which .gitignore
   does not cover.
3. Section 3's name check (line 199) greps the first word of `git config user.name`. On this machine that finds 0
   lines, while the short form that the notes use appears on 26. Point the owner at the command in post-wave-fix.md
   ("Owner decisions") instead.
4. "The whole sequence" (line 13) says it holds every command of the page, but it leaves out the label loop of
   section 12 (`site_compat_report.yml` applies `compatibility`, a label that only that loop creates), the browser,
   example, WebKit and fresh-clone checks of section 6, the Pages certificate check, and the download and
   `SHA256SUMS` check of section 14.
5. Minor: nothing runs `gh auth status` before `gh repo create` to show which account is logged in.

## The fixer's report, checked

A, C, E, G, H, I, J, L and M hold as described. For H, the new assertions are in E2E scenarios 7 and 10B, and
`uploadedBytes` counts the `upload` events of peer wires only. B holds in the code and in PRIVACY, RUNBOOK and
ARCHITECTURE, but README and WHY drop the page-tag qualifier (claims 1 and 2). D holds for RUNBOOK sections 2 to 6
and 10. K: the triage table has 54 rows. The counts in G match this pass in all five suites (the WebKit run took
127.5 s here against 129.5 s there); only the packed size in the checklist is out of date (claim 5).

## Round 2 (2026-10-20, after the fixer's second pass)

Brief: check the seven findings of the second fix pass without trusting its report, repeat the global checks (a) to
(d), and append this section, which is the only change. HEAD was `c9804f1`: the fixer's edits landed in the 01:45 ET
checkpoint `c2c8c6d`, and the orchestrator's `c9804f1` (06:19 ET) changed README.md line 36 and one line of
post-wave-fix.md.

**Verdict: not ready.** All seven findings are closed and every global check passes. One new mismatch remains (N1
below): on a site with a page tag, a visitor who chose "Share and load" before and is asked again because the
recipients changed keeps the DNS-over-HTTPS checks after choosing "Load from host only", which the card, the gate and
six documents say does not happen.

### The seven findings

| # | Status | Evidence |
|---|---|---|
| 1 | closed | PUBLISH-CHECKLIST.md: the section 1 row (line 176, "Not a choice: it is never pushed"); section 3 (lines 218-220 and 236-238); section 10 (lines 486-491, "This section is not optional", and 522-524 on the bundle); sequence step 5 (lines 71-73, and 80-81, where the bundle command stays as a local copy). No line offers to push the history; lines 174 and 182 only say that what is pushed is public and how the project was made. A scan of all 58 commits confirms the ranges: `735f349` is the root; the w1-13 lab key is in commits 1 to 48 (`735f349` to `095ed87`) and in none from `621455b` on; the home path and the username are in commits 1 to 51 (up to `c2132eb`), in neither `3130928` nor `66e6070`, the username in one file of `2d1862f`, and neither from `2b9b27c` on. |
| 2 | closed | Sequence lines 74-75 and section 10 lines 500-501 (kill, then kill -0, which must fail). The reason (lines 493-495) matches `.orchestration/checkpoint.sh`: 24 runs 900 s apart, each `git add -A` and a commit with the placeholder author. `.orchestration/` is ignored and never in the tree (lines 496-497; `.gitignore:8`; `git ls-files .orchestration` prints nothing). Lines 504-505 cover a loop that already ended. In both places the stop comes before the "Prepare" commit, the bundle and the orphan branch. |
| 3 | closed | Lines 258-260: the short-name grep (258), the whole `git config user.name` (259), the hostname (260); lines 254-255 and 263-266 point at "Owner decisions". The short-name grep prints 27 lines: exactly the 25 that post-wave-fix.md lines 131-138 list, plus post-wave-fix.md:164 and checklist:258, as line 264 says. The orchestrator's new numbers for the checklist lines that post-wave-fix.md:147 lists (175 and 253) are right. |
| 4 | closed | Header lines 13-19 name what stays in the sections. A script matched every command line of the page's 32 other code blocks against the sequence: all of them are in it except the excepted kinds (the checks at lines 191-192, 209-212, 225-227, 258-260, 276, 325-351 and 419-435; the replacements at 245-248; the manual release at 700-717; "If something goes wrong" at 738-740). The inline commands (the playwright install, `gh run watch`, `rsvg-convert`, `shasum`) are in it too. The new entries sit in order: the tests (54-55), `gh auth status` (97, and section 11 line 532) and the label loop (121-132). `site_compat_report.yml:3` applies `compatibility`, which only the loop creates; GitHub's default labels plus the loop cover every label of CONTRIBUTING.md lines 247-258. |
| 5 | closed as briefed | README.md:75-77, WHY.md:106-107 and SECURITY-MODEL.md:72 match the code: both buttons of the DNS-only card resolve (`askBeforeDns`, src/loader/app.js:1133-1151), the pointer is then resolved with `dohAllowed: true` (app.js:904-908), `readConsent` stores `dns: true` for either choice (app.js:1099-1101), and the update checks run while `dnsAllowedBy` holds (app.js:2349-2358). The orchestrator's README line 36 matches too (the DNS-only card says "whichever you choose", src/loader/strings.js:69). N1 is a case the qualifier still misses. |
| 6 | closed | DEVIATIONS.md:574-575, in the style of line 383; it matches src/dropin/binding.js:20-21, src/sdk/sdk.js:25, src/dropin/stamp.js:79 and RUNBOOK.md:202. |
| 7 | closed | PUBLISH-CHECKLIST.md:424-425 says "about 482 kB, 87 files". This pass measured 87 files and 482,066 bytes (npm prints 482.1 kB) after the orchestrator's README edit; the fixer's 482,043 predates that edit, which is why the rounded figure is the right form. |

### Global checks

(a) Over README.md, docs/*.md, docs/recipes/*.md, src/loader/strings.js and tools/*.mjs (64 files): every 13.3 figure
is called a model or arithmetic, and every form of "measur" next to one is a negation. Every "no lookup" sentence
carries the page-tag condition or the DNS-only exception (README.md:71 and 76, WHY.md:102 and 106, ARCHITECTURE.md:370
and 808, PRIVACY.md:36, RUNBOOK.md:122). SHA-256 appears only for `/.mw/files.json`, ledger blocks and ids, labels, key
fingerprints, mining, build pins, release sums and a notice log, never for piece or file verification (pieces are
SHA-1: SECURITY-MODEL.md:63, CRITIQUE.md:128). The banned and retired phrases of the brief appear only in rule
quotations, negations, the checklist's own grep patterns and the name of the 1.0 bar; the one allowed heading is
README.md:87. `mw.consent.accept` appears only as removed (ARCHITECTURE.md:275, DEVIATIONS.md:573-574, RUNBOOK.md:202).
"Safari 16.4" next to gzip appears only in DEMO-RESULTS.md:144-146 (before 16.4 the loader's own gzip code inflates the
snapshot, which is true) and under the superseded note of DEVIATIONS.md:383. "Starts a new ledger" appears only for
`--new-genesis` (RUNBOOK.md:132). README.md, docs/*.md and docs/recipes/*.md hold no em dash, en dash or curly quote;
the checklist's section 5 greps print only rule quotations, and its dash, TODO/FIXME and RESEARCH-PENDING greps print
nothing. One en dash sits in docs/deviations/chain-base.md:16, a record outside both checks.

(b) `git grep -n` for the username and for the home-directory prefix prints nothing. The section 3 path grep prints
only the two example paths and the two files that quote them; no personal e-mail address is tracked; the key greps
find only the fakes of `test/unit/tools-publish-v021.test.mjs`.

(c) Runs on macOS with Node 24.22 and `ALLOW_REMOTE` unset. Before them the launch sites were read: Chromium starts
only with `chromiumArgs({ allowRemote: false })` (test/e2e/lib.mjs:251), and every URL is on `http://127.0.0.1`.

| Check | When (ET) | Result |
|---|---|---|
| `npm test` | 06:31:22 to 06:31:30 | lint-floor clean (62 files); 937 of 937 pass, 0 fail |
| `npm run test:e2e` | 06:31:37 to 06:33:46 | 25 of 25 PASS in 128.3 s; "PASS network policy: every request stayed on 127.0.0.1" |
| `npm pack --dry-run` | about 06:34 | 87 files, 482,066 bytes; nothing outside `bin/`, `src/`, `tools/`, `build.mjs`, `build.lock.json`, `test/e2e/browser-args.mjs`, `README.md`, `LICENSE` and `package.json` (no `CHANGELOG.md` either); no key, local state or dependency folder |

No process from these runs was left behind.

(d) `git status --short` printed nothing before this section was written, and the ignored paths are local state
(`dist/`, `.tools/`, `.orchestration/`, lab logs, the w1-08 lab's own `t262/`). One branch (`main`), no tag, stash or
remote; all 58 commits carry the placeholder author. The checkpoint loop (pid 80991, started 23:00 ET for 24 runs of 15
minutes) is no longer running and made its last commit at 01:45 ET, so this section stays uncommitted until someone
commits it.

### New finding (outside the brief)

**N1. "Load from host only", chosen when the card asks again, keeps an earlier DNS permission.** `saveConsentRecord`
stores `dns: dns || dnsAllowedBy(A.consentRecord)` (src/loader/app.js:1111), so a new choice inherits the DNS
permission of the record it replaces. An accepted record whose recipients changed reads as pending
(src/loader/consent.js:68), so the card or the gate asks again (app.js:946 and 963-966). If the visitor now picks "Load
from host only" (app.js:1312, or the gate at 1341), the new record is `{ choice: 'host-only', dns: true }`,
`dnsAllowedBy` stays true (consent.js:73-74), and the update checks keep asking the DNS-over-HTTPS service on this visit
and on later ones (app.js:2308 and 2349-2358). Replayed with the real exported functions: a first-time "Load from host
only" stores `dns: false`, the re-asked visitor's stores `dns: true`. On a page-tag site on a public hostname this
contradicts the card's `consentDnsUpdate` ("If you choose to share, your browser also asks ...", strings.js:70, shown at
src/loader/ui.js:240-241) and the gate's `gateDnsUpdate` (strings.js:71, ui.js:179); README.md:75-77, WHY.md:106-107,
SECURITY-MODEL.md:72, PRIVACY.md:22-23, RUNBOOK.md:122 and ARCHITECTURE.md:370-371; and post-wave-fix.md:101 ("stores
`dns: false` on a page-tag site"). No unit test covers the inheritance (`loader-app-consent` tests `makeConsentRecord`
alone), and the end-to-end suite cannot see it: on 127.0.0.1 no lookup happens. Suggested: a host-only choice on a site
with a page tag stores `dns: false` (keep the inheritance only for a site found through DNS alone), with a unit test; or,
if the inheritance is intended, say so in the two strings and the six documents.

### Smaller observations (no change needed to pass)

- The loop stop kills whatever process holds the stored pid. The loop has already ended, and after a restart of the
  machine that pid can belong to another program of the same user. Checking first that
  `ps -p "$(cat .orchestration/checkpoint-loop.pid)" -o command=` names `checkpoint.sh` would avoid that.
- `git bundle create ../magnet-web-checkpoints.bundle --all` writes next to the clone; if that folder syncs, the
  command as written breaks the warning of lines 522-524. A path the owner picks, or deleting the bundle after the
  push, avoids it.
- post-wave-fix.md:278 says a zsh without `interactive_comments` cannot misread the new comment lines. Several of them
  hold a `;` (checklist lines 32, 39, 53, 73, 80, 95 and 121), after which such a zsh can run the rest as a command
  (line 95 would run `gh run watch asks which run to follow`). Each such fragment fails without changing anything, and
  line 21 tells zsh users to set the option first, so the page is fine; only the note overstates.
