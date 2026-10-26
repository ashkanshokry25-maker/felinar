# fresh-eyes: notes and deviations (productionize wave, 2026-10-19)

Agent: `fresh-eyes`. Brief: act as a developer who has never seen the project, follow README.md and
docs/QUICKSTART.md literally in a fresh clone with local-only browsers, follow the drop-in track against
`examples/existing-site-dropin/`, check every relative link, the wording rules and every documented CLI flag, fix
what is wrong (documents first, code only for small breakages) and list the rest. Nothing was deployed, no DNS was
touched and nothing was pushed.

## How it ran

- The working tree held the writers' last changes; they were committed first as `checkpoint: before fresh-eyes`
  (`095ed87`) and cloned with `git clone` into the session scratchpad (`fresh-clone`). Every command below ran in
  that clone, from its root, with Node 24.22 and npm 11.19.
- Every browser was Playwright Chromium launched with `chromiumArgs()` from `test/e2e/browser-args.mjs`, against
  `localhost` or `127.0.0.1` only. Each probe counted requests to any other host: there were none.
- Times are Eastern (2026-10-19, 21:51 to 22:30 ET).

## The literal walk-through

| Step (as the documents say it) | Result |
|---|---|
| README tour 1: `git clone`, `npm ci` | Works. `npm ci` ends with "4 high severity vulnerabilities", which no user document mentioned (fixed, see below). |
| README tour 2: `npx magnet-web keygen --out owner.jwk`, `npx magnet-web build`, `npx magnet-web publish examples/peer-guestbook ... --shell --out dist-publish` | Works. `npx` resolves the clone itself (a `file:` link in the npx cache), as README says. Publish prints the four warnings README describes (no `--cs`, no `--ct`, pointer size, unchecked web seed); the output tree is as described; `git status` stays clean (`*.jwk`, `dist-publish/` ignored). |
| README tour 3: `npx magnet-web demo`, QUICKSTART: `npm run demo` | Both work; the output matches QUICKSTART's abridged sample (same infohash `08254da8...`). Ctrl-C stops the tracker, the dev server and the seeder browser. |
| Two visitors (two contexts), "Share and load", sign the guestbook in one | The page renders (screenshots checked); the consent card has "Share and load" next to "Load from host only"; the entry reached a second tab of the same profile and a second profile in about 0.8 s; all three showed "Ledger: 2 entries, in sync with 1 peer". |
| `demo --tls` without mkcert | Stops with an error that says to install mkcert and run `mkcert -install`, as README and QUICKSTART say. |
| QUICKSTART A2 (the example as `~/my-site`), A3 (assemble the deploy tree) | Publish output matches the sample exactly (infohash `bdc1ee08...`, the 628-byte pointer warning). The assembled tree, served by `http-server` on 127.0.0.1, passes `check-webseed` (11 checks). |
| Drop-in: MIGRATION "Try it on this computer first" with `examples/existing-site-dropin` as the site | `publish --dropin`, `tracker.mjs`, `dev-server.mjs` and `check-site --headless --consent` work (OK, 0 failures). QUICKSTART B5's checks hold: with JavaScript off three pages show the same text as the plain site; the card appears at the bottom after about 3 s; the second page view's CSS, script, image and `data.json` are answered by the Service Worker; `window.__mwDropin.inspect()` shows `copy`, `source`, `consent` and `sw.mode`; two consenting visitors see 1 peer each. |
| README "Backend-free CRUD in 20 lines", run as a site with `npm run demo -- --site <dir>` | Works as written: create, a second visitor reads it, Delete only on your own entries, `set`/`get`/`del` of a key across visitors, the tombstone removes the entry for both, a `_` key from a visitor fails with `E_NOT_MODERATOR`. |

## Mismatches found and fixed

1. **`npm ci` reports 4 high severity vulnerabilities.** All four are GHSA-2p57-rm9w-gvfp (`isPublic` in `ip`, via
   `bittorrent-tracker`). Checked: `bittorrent-tracker` calls only `ip.toString`, in its UDP server, which
   `tools/tracker.mjs` turns off (`udp: false`); nothing in `dist/` contains the package. npm's offered fix installs
   `bittorrent-tracker` 0.7.3 ("a breaking change"). QUICKSTART step 0 now explains this; CONTRIBUTING links to it.
2. **README tour: "Open it in two browser windows".** Windows of one profile are one visitor: the second window
   shows no card (the choice is remembered) and has the same identity. Now "two different browsers (or two browser
   profiles)", as QUICKSTART already said.
3. **QUICKSTART demo step 2:** the "Posting: working out the spam fee" line is written to the loader's status bar,
   which folds into a small counter about 4 s after the site renders, so a visitor who types for longer never sees
   it (checked with a mutation observer: 33 updates in about 0.1 s, all while the bar was folded). The step now says
   to click the counter to open the bar.
4. **MIGRATION's sample output** said it was a run on `examples/existing-site-dropin/` (7 files, 13 KiB). That run
   used the folder as `.fixture/stage.mjs` stages it; the folder itself gives 12 files, 29 KiB (the two Service
   Worker variants and `EXPECTED.md` are packed) and a `data-cfasync` warning. Reworded.
5. **The egress note `publish --dropin` prints** (`tools/publish.mjs`, `egressNote`) called 13.3x "the measured
   example" (research w2a-07 F21 calls it arithmetic) and advised "a smaller --max", which `publish` refuses
   ("error: the site is 13558 bytes, more than --max 5000"). It now says "a worked example (arithmetic, not a
   measurement)" and recommends `--ignore <path>` (checked: `--ignore img` keeps `img/` on the host, out of the
   torrent, and the copy drops from 13 KiB to 6.2 KiB). The unit tests that pin the note still pass. QUICKSTART's
   sample output, FAQ and ROADMAP said "measured" too and were reworded.
6. **`npm test` left a process running every time.** `test/unit/tools-lint-floor.test.mjs` runs a deliberately
   hanging test file under `tools/run-unit.mjs --total 2500`; the watchdog SIGKILLed only the `node --test` runner,
   so the file's own process kept running forever (39 such processes were alive on this machine). `run-unit` now
   starts the runner in its own process group on POSIX, relays SIGINT, SIGTERM and SIGHUP to it, and kills the group
   on timeout and on exit. Checked: the hang case leaves nothing, pass and fail keep exit codes 0 and 1, Ctrl-C ends
   a slow run at once with no process left, and a full `npm test` added no orphan (39 before, 39 after).
7. **README "What it is not" item 9 and WHY.md** said the default `<meta>` pointer "needs no lookup". It needs none
   to load, but after "Share and load" a shell page on a public hostname polls DNS-over-HTTPS for `_magnet.<host>`
   whether or not a record exists (`src/loader/app.js`, `afterRender`, `scheduleUpdateCheck`, `dnsAllowedBy`), so
   the resolver sees the site's name and the visitor's IP address then. Drop-in never queries DNS (no resolver
   endpoint in `dist/_mw/mw.js`). Both now say so, as QUICKSTART A6, PRIVACY and DEPLOY already did.
8. **WHY.md** said every browser checks "every file against its SHA-256". Serving checks SHA-1 pieces against the
   infohash; `/.mw/files.json` is read only by the drop-in refresh (`src/dropin/refresh.js`). Removed.
9. **Wording rules.** Banned words outside rule statements: README "What it is not" item 1 (`Is it "serverless"?
   No.`), FAQ `### Is it "serverless"?` and FAQ `### Is the site ledger a "blockchain"?`. The `docs-links` test
   allows quoted words, but the brief allows "blockchain" only in README's "Why not a blockchain?" paragraph and
   "serverless" nowhere, so they became "It still needs a host.", "Do I need a server?" and "Is the site ledger a
   cryptocurrency chain?" (no link pointed at the old anchors). The remaining hits all state the rule (ARCHITECTURE's
   introduction, ONBOARDING's "don't promise" list, CONTRIBUTING's table, PUBLISH-CHECKLIST, DEVIATIONS, a source
   comment). No isolation claim for a shared-origin hub exists; every "isolat" hit is a negation.
10. **Em and en dashes** in `docs/ARCHITECTURE.md` (6 em, 5 en: title, five section headings, number ranges) and
    `docs/INTERFACES.md` (1 em, title) became colons and "to". No link targeted the changed anchors. The checklist's
    dash grep now prints nothing; PUBLISH-CHECKLIST says so.
11. **RUNBOOK** (QUICKSTART B1 sends readers to its section 10): v0.2 test counts (675 unit, 14 scenarios) replaced
    with today's; scenario 11 runs as `PEER-11`; section 6 said a key rotation starts a new ledger, which `lo=`
    changed (F09; `publish` refuses `--prev-key` without the genesis); section 10 gave the tag without
    `data-cfasync="false"`, told drop-in sites to allow DoH endpoints in their CSP, and said a site "calls
    `mw.consent.accept()`", which v0.2.1 removed (`mw.consent.request()` opens the loader's card). Title: v0.2.1.
12. **`examples/existing-site-dropin/`:** `EXPECTED.md` item 7 told tests to click through
    `window.__mwDropin.engine.panel.rectOf()`; the frozen handle has only `version`, `started`, `inspect()`,
    `openSettings()` and `rectOf()` (checked in a browser). Now `window.__mwDropin.rectOf()`. The README explains the
    `data-cfasync` warning its pages trigger and gains a "Try it by hand" section with the commands above (run as
    written: `check-site` OK).
13. **QUICKSTART track B** had no way to try drop-in locally; it now points at MIGRATION's local preview and the
    example's README.
14. **SECURITY-MODEL** said checksums are a 1.0 roadmap item; `release.yml` already attaches an unsigned
    `SHA256SUMS`. It now says so and keeps signed checksums and attestations on the roadmap.
15. **Test counts.** README, CHANGELOG, CRITIQUE, FAQ and PUBLISH-CHECKLIST said 913 unit tests; a run today gives
    929 (the wave added `cli-bin` and `repo-layout`). Updated, and INTEGRATION-STATUS has a new dated "Current state".
16. `.github/ISSUE_TEMPLATE/bug_report.yml` suggested version "0.2.0"; now "0.2.1".

## Checks over the whole tree

- **Links:** every relative link, image, HTML `href`/`src` and `#anchor` (GitHub heading slugs) in the 166 tracked
  Markdown files resolves, README.md and all of `docs/**` included. The checker's only hits were two
  `src="/_mw/mw.js"` lines inside indented code in `docs/research/w2a-04-dropin-embedded-mode.md`, which are not
  links. Repository paths named in backticks in the current documents exist, except roadmap items and paths of other
  projects in the research notes.
- **Flags:** every flag passed to a magnet-web command in README, CONTRIBUTING, GOVERNANCE, CHANGELOG, SECURITY,
  `docs/*.md`, `docs/recipes/*.md` and the example and deploy READMEs is in that tool's `parseCli` spec (and in its
  `--help`); the enumerated values used (`--policy`, `--writers`, `--mode`, `--pieces`, `--consent`, `--aud`,
  `--trailing-slash`) are valid. The only flags no tool has are `publish --check` and `--base`, both described as
  roadmap items. The end-to-end runner's `--only`, `--keep`, `--headed` and `--webkit` exist in `test/e2e/run.mjs`.

## Not fixed (open)

1. `tools/snapshot.mjs` prints "visitors need DecompressionStream, Safari 16.4 or later: use --plain for older iOS",
   untrue since F20 (`src/common/inflate.js`); `test/unit/tools-snapshot.test.mjs` line 144 pins the old text.
2. `publish --dropin` writes `csp.txt` with the DNS-over-HTTPS endpoints and a `webseed-layout.txt` for a cross-origin
   web seed; drop-in uses neither (seen in this run; MIGRATION and now RUNBOOK tell owners to skip them).
3. Flagged by other writers and not re-verified here: `webseed-layout.txt` recommends CloudFront's managed
   CORS-with-preflight policy (no `Access-Control-Allow-Headers`, research w1-10 F5); `publish --prev-key` still
   prints the "upload genesis.json to <cs URL>" hint, which would overwrite a snapshot holding the hand-over;
   `ledger-admin` writes plain JSON back under a `.json.gz` name; `parseRedirects` skips unsupported `_redirects`
   lines without a word.
4. `src/dropin/mw.js` line 17 still lists `engine` in `window.__mwDropin` (the runtime handle has none).
5. The npm name `magnet-web` is unclaimed (registry 404 at 22:15 ET). Inside a clone `npx magnet-web` runs the clone;
   anyone may register the name, after which the same command outside a clone would run their package. Reserve it
   or switch the documents to a scoped name before the first npm release.
6. 39 orphaned `hang.test.mjs` processes from runs before fix 6 are still alive on this machine (not started by this
   agent, so left alone). `pkill -f 'mw-rununit-test-.*/hang.test.mjs'` removes them.
7. Every site the demo publishes on `localhost` gets the same ledger id (one demo key, scope `localhost`, no
   `--chain`): the guestbook and a `--site` run both printed `mw1:Kn1yfzber2TUavNoUMrjLocp2p6`. A browser profile
   that used the guestbook demo therefore shows its entries in the next demo site, and CRUD.md's "Ledger: 2 entries"
   holds only for a fresh profile. Passing `--chain <name>` from the demo would separate them.
8. The "passed on to others" figure was 165 B right after "Share and load", with no file uploaded (the guestbook's
   transfer line); this corroborates the marketing writer's open issue 1.
9. Seen once in five drop-in probe runs (right after `check-site --headless` had used the same tracker): the next
   page view started with `consent: 'pending'`, and two consenting visitors stayed at 0 peers for 15 s. Four later
   runs were clean. It matches the ROADMAP row "The consent choice can be lost", so it is noted here, not filed anew.
10. The drop-in example's pages keep the bare tag, so publishing the official example prints a `data-cfasync`
    warning. Documented now; changing the pages would change the staged fixture the unit and end-to-end tests use.

## Verification (2026-10-19, after every change)

- `npm test`: lint-floor clean (62 files), 929 tests, 929 pass, 0 fail, about 8 s.
- `npm run test:e2e`: 25 of 25 PASS, network policy PASS, 128.0 s. `npm run test:e2e:webkit`: 26 of 26 PASS,
  network policy PASS, 129.4 s.
- `npm run test:browser`: 31 pass, 1 skipped. `npm run test:example`: 29 pass.
- Last runs, after the final document edits (22:33 ET): `npm test` 929 of 929, `npm run test:e2e` 25 of 25 and
  network policy PASS in 129.4 s, no new orphaned process.
- `git diff 095ed87` shows every change of this agent; nothing was committed after that checkpoint.
