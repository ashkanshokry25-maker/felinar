# Review round, tools fixer

Written 2026-10-24 04:30 EDT (America/Toronto). Brief: the "tools" area of the review round (V03-DESIGN-REVIEW 5.3, fix wave).
Findings from `.orchestration/reports/all-findings-2026-10-22.json`, verifier notes from `.orchestration/reports/verdicts-2026-10-23.json`.
Files edited: `tools/tracker.mjs`, `tools/verify-release.mjs`, `tools/door-kit-files.mjs` (new; `doorKitFiles` moved out of
`tools/publish.mjs`, which re-exports it), `tools/publish.mjs`, `tools/withdraw.mjs`, `tools/ship.mjs`, `tools/seed.mjs`,
`tools/install-scripts.json` (new), `build.mjs`, `deploy/github-actions/publish-site.yml`, `deploy/one-box/docker-compose.yml`,
`deploy/one-box/README.md`, `deploy/tracker/docker-compose.yml`, `deploy/tracker/README.md`, `deploy/pin/Dockerfile`, `SECURITY.md`,
`docs/THREAT-MODEL.md`, `docs/DEPLOY.md`, `docs/OPERATIONS.md`, the `test/unit/tools-*` files named below and this note. No wire,
storage or vector format changed: `summary.json`, the pointer, the release list and its signature keep their shapes (the
`/stats.json` counts of the tracker gained `uploads` and `unlisted`).

## Results

- `npm test` at 04:25 EDT: 2,201 tests, 2,148 pass, 11 todo, 42 fail. None of the 42 is in this area: `calls-service` (14),
  `chat-lane-service` (19), `calls-mesh` (2), `call-ui` (1), `chat-lane-holder` (1), `integration-v03-reconcile` (1, `E_NO_CHAT_KEY`)
  and `strings-c2` (2) fail in code other lanes are editing now (`git status` shows `src/chat/*` modified), `repo-layout` (1) fails on
  the tracked `SECURITY-KEY.asc` (request R-LAYOUT), and `docs-links` (1) failed only because this note did not exist yet.
- Area units: `node --test test/unit/tools-*.test.mjs test/unit/cli-bin.test.mjs test/unit/deploy-one-box.test.mjs` all pass
  (tracker 17, release 26 plus the template case, ship 43, build 28, publish v0.3 and withdraw 29, demo 14, install scripts 2 and
  1 todo, review requests 8 todo).
- End to end, 04:27 to 04:28 EDT: `node test/e2e/run.mjs --only FMT-WITHDRAW,PEER-RV,DOOR-DOWN,E-CH-1,E-FI-1,E-FI-2,E-MD-4,E-PS-1`:
  8 passed, 0 failed, 62.2 s, every request on 127.0.0.1.

## Findings

| Finding | Status | Files | Test |
| --- | --- | --- | --- |
| SCALE-2 (major) allow-list tracker refuses every lane, file and media swarm | fixed | `tools/tracker.mjs:72`, `:93`, `:119`, `:302`-`:320`; `tools/ship.mjs:418`; `docs/DEPLOY.md` "Your own tracker"; `deploy/tracker/README.md` "The allow list" | `test/unit/tools-tracker.test.mjs` "SCALE-2: ..." (2 cases); `tools-ship.test.mjs` "SCALE-2: the one-box allow list ..."; `tools-demo.test.mjs` allow size 3 |
| SCALE-10 (major) one socket fills the 10,000-swarm pool | fixed | `tools/tracker.mjs:310`-`:357` (per-connection cap 256, listed never refused, close stops every peer id), `:455`-`:465` (prune in every mode) | `tools-tracker.test.mjs` "SCALE-10: ..." (3 cases) |
| SEC-5 (major) door kit `--allow-extra` accepts host settings | fixed | `tools/verify-release.mjs:45`, `:328`-`:353`; `tools/door-kit-files.mjs` (README step 1 uses `--door-kit --expect-version`); `tools/publish.mjs:527` | `tools-v03-release.test.mjs` "SEC-5: ..." and the updated extras case |
| SEC-6 (major) rollback to an older signed release | fixed (R-SEC-6 for the checklist) | `tools/verify-release.mjs:202`, `:288`-`:306`, `:462`-`:495` (`--expect-version`, `--min-version`, `--any-version`, `--expect-tree`, `--expect-name`; required on the command line; OK line and `--json` name the release) | `tools-v03-release.test.mjs` "SEC-6: ..." |
| PTR-7 (major) withdrawal drops `nx=` | fixed | `tools/withdraw.mjs:117`-`:138` (reads the previous record before `pointer.txt` is overwritten, carries `nx`, checks as a returning visitor and refuses what it would ignore); `tools/publish.mjs` withdraw branch; `docs/DEPLOY.md` "Takedown", `docs/OPERATIONS.md` | `tools-v03-publish.test.mjs` "PTR-7: ..." |
| SUP-1 (blocker) install scripts run on documented installs | partial | `SECURITY.md` "Installing the command-line package"; `tools/seed.mjs:208`-`:211`; `tools/install-scripts.json`; the template and compose files pass `--ignore-scripts` | `tools-install-scripts.test.mjs` (2 pass, 1 todo for R-SUP-1); `tools-seed.test.mjs` |
| SUP-2 (blocker) release checks pass for any workflow; key pinned only in the same repository | partial | `tools/verify-release.mjs:37`-`:39` (`PINNED_RELEASE_KEYS`, `RETIRED_RELEASE_KEYS`), `:262`-`:283`; `SECURITY.md` "Checking a release" (bound attestation flags, the second pin named) | `tools-v03-release.test.mjs` "SUP-2, SUP-12: ..."; todos R-SUP-2a, R-SUP-2b in `tools-review-requests.test.mjs` |
| SUP-3 (major) the owner signs the draft's lists unauthenticated | partial | `tools/verify-release.mjs:433`-`:456` (`sign --rebuilt`, required; `--skip-rebuild-check` is explicit), `:360` `compareLists` | `tools-v03-release.test.mjs` "SUP-3: ..."; todo R-SUP-3 |
| SUP-4 (major) unpinned downloads between the build and the pack step | partial | none of mine: the job is `.github/workflows/release.yml` | todo R-SUP-4 |
| SUP-5 (major) publish, ship and the CI template never verify the loader | fixed | `tools/publish.mjs:545` `checkLoaderRelease`, `:1250` (before the key), `:2013` (command line requires it for another `--dist`); `tools/ship.mjs:574`; `deploy/github-actions/publish-site.yml` "Check the loader against the signed release list" | `tools-ship.test.mjs` "SUP-5: ..." (2 cases); `tools-v03-release.test.mjs` "SUP-5, SUP-8: ..." |
| SUP-9 (major) the server builds from an unpinned clone | partial | `tools/ship.mjs:339`, `:580`, `:614`-`:624`, `:475`; `deploy/one-box/README.md` (tag clone); `deploy/*/docker-compose.yml` and `deploy/pin/Dockerfile` (`LW_NODE_IMAGE` digest pin) | `tools-ship.test.mjs` "SUP-9: ..." and the updated sequence |
| SUP-10 (major) the npm package is not in the signed set | partial | `docs/THREAT-MODEL.md` SC-4 now "mitigated"; `verify-release.mjs list` already takes any tree (`--tree pkg`) | todo R-SUP-10 |
| SUP-11 (major) no gate for a dependency release that lost provenance | partial | `build.mjs:477`-`:533`, `:737`, `:827` (`--update-lock` refuses a new release of a provenance package without an attestation; `--accept-no-provenance`) | `tools-build.test.mjs` "SUP-11: ..." and the update-lock case; todo R-SUP-11 |
| SUP-8 (minor after verification) CODEOWNERS misses the enforcing code | partial | the template's `npm ci` lines carry `--ignore-scripts` | `tools-v03-release.test.mjs` "SUP-5, SUP-8: ..."; todo R-SUP-8 |
| SUP-12 (minor) no rotation, revocation or freshness for the release key | partial | `--min-version`, `RETIRED_RELEASE_KEYS`, `docs/OPERATIONS.md` "A lost or leaked release key" | `tools-v03-release.test.mjs` "SUP-2, SUP-12: ..." |
| SUP-14 (minor) demo deploys on every push; no reviewer | partial | `docs/THREAT-MODEL.md` SC-9 now "open" | todo R-SUP-14 |
| SCALE-15 (minor) the pin mailbox uses the per-desktop quota | partial | none: `tools/pin.mjs` belongs to another workflow | R-SCALE-15 |
| MAL53-8 (minor) the pin's file store is never used | rejected: minor, deferred | none | `tools/pin.mjs` belongs to another workflow, and the fix (validating torrent metadata against the approved size in `createPinPageHost`, hashing at completion, deleting the IndexedDB store on quarantine) is not a small change; outline in R-MAL53-8 |
| SUP-13 (minor) publish imports create-torrent in the process that reads the key | rejected: minor, deferred | none | Splitting torrent creation into a keyless child process changes how `publish()` (an API that tests, `ship` and the e2e harness call in-process) runs; not cheap or safe in this round |

### Notes on the fixes

- SCALE-2: `summary.json` already carries `ledgerId` and `features` (`tools/publish.mjs` summary), so the documented
  `--allow summary.json` now serves the chat lane and, when files or media are on, turns on uploads mode by itself; no command
  in DEPLOY, `init` or the compose files had to change. Per-upload infohashes cannot be listed in advance, so uploads mode is the
  design: unlisted swarms are served under caps, and DEPLOY states the cost. A hub's follow lane needs `--hub <host>` (the host
  is not in `summary.json`).
- SCALE-10: the per-IP cap the finding asks for is not built: behind Caddy every socket has the proxy's address, and trusting
  `X-Forwarded-For` without a proxy lets anyone spoof it. DEPLOY and THREAT-MODEL SYB A15 say so. The phantom-peer problem the
  verifiers found (a fresh `peer_id` per announce outlived the socket) is fixed: the close handler stops every peer id the socket
  announced, and a socket may use at most 4 peer ids per swarm.
  The per-connection cap defaults to 256, not the finding's example of 64: a page shares one WebSocket per tracker URL across
  all its torrents (bittorrent-tracker's client socket pool), and a pin node announces every file it holds on it
  (`src/loader/pinwire.js`), so 64 would refuse a pin's 65th file. One socket now fills at most 256 of the 10,000, so filling
  the pool takes about 40 connections, and the listed site, ledger and chat lane are never refused.
- SEC-5: the verifier's warning holds: a door kit legitimately holds `_mw/t/<btih>.torrent` and `ws/<name>/` outside the list, so
  those stay accepted (and are listed in the output); host settings must equal what `doorKitFiles(version)` makes, and code at
  the root or under `_mw/` outside the list fails.
- SEC-6: the command line now refuses `verify` without `--expect-version`, `--min-version` or an explicit `--any-version`, so the
  checklist lines in R-SEC-6 exit 2 until they carry the version (fail closed). `publish --door-kit` and `checkLoaderRelease` check
  the tree (`dist`) and `minVersion` = the tools' version.
- SUP-5: the publish API called in-process (tests, the e2e harness, which passes its own build as `--dist`) warns instead of
  refusing; the `publish` and `ship` command lines refuse. The pinned key never comes from beside `--dist`.
- SUP-9: `ship` compares `git -C <remote dir> rev-parse HEAD` with this checkout's commit (or `--expect-commit`) before anything is
  sent. Not done: a committed digest for `node:24-bookworm-slim` (finding it needs a registry lookup, which this machine's policy
  bars; `LW_NODE_IMAGE` takes one), and a hash check of the Playwright browser download in `deploy/pin/Dockerfile`.
- SUP-2: the second pin is named as a DNS TXT record under a project domain (never bought; the domain of the security key
  file in the repository at the time). The owner creates it when the release key exists (R-SUP-2c). `PINNED_RELEASE_KEYS`
  is empty until then; `verify` says so in a warning. Superseded on 2026-10-25: the project holds no domain, step 3b of the
  checklist pins the key in `PINNED_RELEASE_KEYS`, and the second places are the ones SECURITY.md names (independence
  design, IND-3).
- The brief says SECURITY.md names a security mailbox at a project domain (never bought); the file as read at 04:20 EDT does not (it says "There is no
  security mailbox yet"). Nothing about the mailbox was changed here.

## Requests

Each request names the file, the line as read at 04:20 to 04:30 EDT, the old text and the new text. The todo cases in
`test/unit/tools-review-requests.test.mjs` and `test/unit/tools-install-scripts.test.mjs` turn into passing tests when they land:
remove their `todo` option then.

- **R-SEC-6 and R-SUP-3** `docs/PUBLISH-CHECKLIST.md:359`-`:363` and `:1143`-`:1147`, and the `.github/workflows/release.yml:24`
  and `:26` header lines. Every `sign` line gains `--rebuilt "$RDIR/rebuilt/dist"` (or `.../dist-idp` for the idp list), after a
  block that checks out the tag and builds it on the signing machine:
  `git -C "$RDIR" clone --branch v0.3.0 --depth 1 <repo> src && (cd "$RDIR/src" && npm ci --ignore-scripts && node build.mjs --strict --out "$RDIR/rebuilt/dist" && npm run build:idp -- --out "$RDIR/rebuilt/dist-idp")`
  (check `build:idp` for its output flag). Every `verify` line gains `--expect-version 0.3.0 --expect-tree dist` (or `dist-idp`).
  Line `:358` and `:1132` become one `gh attestation verify` per downloaded file with the R-SUP-2b flags. Test: todo R-SUP-3.
  Applied on 2026-10-25 by the independence round (step 10b and section 14 sign with `--rebuilt` and verify with
  `--expect-version`, [independence-release-docs.md](independence-release-docs.md); the release.yml header lines by the
  integrator, [independence-integration.md](independence-integration.md)); the todo is removed. The attestation flags stay with R-SUP-2b.
- **R-SUP-2a** `docs/PUBLISH-CHECKLIST.md:326`: old `"rules": [{ "type": "deletion" }, { "type": "update" }, { "type": "non_fast_forward" }]`,
  new `"rules": [{ "type": "creation" }, { "type": "deletion" }, { "type": "update" }, { "type": "non_fast_forward" }]`, with the owner
  as the only bypass actor. `.github/workflows/release.yml`, a first step of the build job after checkout:
  `git fetch --no-tags origin main && git merge-base --is-ancestor "$GITHUB_SHA" origin/main || { echo "::error::the tag is not on main"; exit 1; }`
  (the checkout needs `fetch-depth: 0`). Test: todo R-SUP-2a.
- **R-SUP-2b** `.github/workflows/release.yml:119` (notes template), `docs/PUBLISH-CHECKLIST.md:358` and `:1132`,
  `docs/SECURITY-MODEL.md:166`: every `gh attestation verify <file> --repo OWNER/lightweb` gains
  `--signer-workflow OWNER/lightweb/.github/workflows/release.yml --source-ref refs/tags/v<version> --source-digest <tag commit>`.
  SECURITY.md already has it. Test: todo R-SUP-2b.
- **R-SUP-2c** `docs/PUBLISH-CHECKLIST.md`, "Release key" (near `:1308`-`:1331`): after `keygen`, publish the public key as the TXT
  record of a project domain (never bought), put it in `PINNED_RELEASE_KEYS` in `tools/verify-release.mjs:37`, in SECURITY.md
  and in the README (`README.md:277`), and check the record with `dig` from another network. Applied on 2026-10-25 without
  the DNS part: step 3b pins the key in `PINNED_RELEASE_KEYS` (independence design, IND-3).
- **R-SUP-4** `.github/workflows/release.yml:134`-`:161`: right after the step "Build the loader and the identity page, strict, and
  check the lock" add a step
  `mkdir -p "$RUNNER_TEMP/pinned" && node tools/verify-release.mjs list dist --out "$RUNNER_TEMP/pinned/hashes-dist.json" --tree dist --version "$VERSION" && node tools/verify-release.mjs list dist-idp --out "$RUNNER_TEMP/pinned/hashes-idp.json" --tree dist-idp --version "$VERSION"`
  (with `VERSION` in its env), and after `:159` add
  `cmp "$RUNNER_TEMP/pinned/hashes-dist.json" release/hashes-dist.json && cmp "$RUNNER_TEMP/pinned/hashes-idp.json" release/hashes-idp.json`
  (the paths are relative to the repository root before `cd release`). Better still, run the e2e step in a job of its own.
  Test: todo R-SUP-4.
- **R-SUP-1** install lines: `.github/workflows/release.yml:116` `npm install -g ./lightweb-" + v + ".tgz` becomes
  `npm install -g --ignore-scripts ./lightweb-" + v + ".tgz`; the same at `CHANGELOG.md:401` and `:599` and
  `docs/PUBLISH-CHECKLIST.md:693`; the `perl` replacements at `docs/PUBLISH-CHECKLIST.md:182`, `:183`, `:937` and `:974` carry
  the flag in their replacement text (`npm install --ignore-scripts @lightweb/verify`). `docs/QUICKSTART.md:155`: old
  `` `npm install node-datachannel` ``, new `` `npm rebuild node-datachannel --ignore-scripts=false` `` (it is already installed
  with the tools, pinned by the lockfile; only its own script runs), and `test/unit/docs-review-round.test.mjs:258` then expects
  that text. `README.md` npx lines that run outside a clone (after the package is on npm) gain `npm_config_ignore_scripts=true`.
  Structural (owner decision): move `webtorrent` (and with it `ip-set` and `node-datachannel`) out of `dependencies` in
  `package.json` (only `tools/seed.mjs` imports it; the loader bundle is vendored). Test: todo in `tools-install-scripts.test.mjs`.
- **R-SUP-8** `.github/CODEOWNERS:5`-`:8`: add `/.npmrc`, `/package.json`, `/build.mjs`, `/tools/build-idp.mjs`,
  `/tools/verify-release.mjs`, `/tools/install-scripts.json`, `/tools/lib.mjs`, `/SECURITY.md`, `/README.md`, `/packages/verify/`,
  `/src/idp/`, `/src/identity/`, `/src/sw/`, `/deploy/`, `/bin/`, each with the same owner. `.github/workflows/pages-demo.yml:74`
  and `:200`: `npm ci` gains `--ignore-scripts`. Test: todo R-SUP-8.
- **R-SUP-10** `.github/workflows/release.yml:155`-`:161`: after `npm pack`, unpack the tarball into `$RUNNER_TEMP/pkg` and run
  `node tools/verify-release.mjs list "$RUNNER_TEMP/pkg/package" --out release/hashes-pkg.json --tree pkg --version "$VERSION"`; add
  `hashes-pkg.json` to SHA256SUMS (`:161`) and the release files (`:231`); the checklist signs it like the other two, publishes the
  npm package from the verified release tarball (`npm publish ./lightweb-<v>.tgz`), compares `npm view lightweb@<v> dist.integrity`
  with it, and requires organisation-wide 2FA for writes. Test: todo R-SUP-10.
- **R-SUP-11** `.npmrc:4`: add `min-release-age=7` (and `save-exact=true`); `package.json:43`-`:45`: `"engines": { "node": ..., "npm": ">=11.19" }`;
  `package.json:87`: `allowScripts` gains `"bufferutil": false, "utf-8-validate": false, "utp-native": false, "ip-set": false, "node-datachannel": false`;
  `.github/workflows/ci.yml` (after `:64`) and `release.yml` (after `:124`): a step `npm audit signatures` (it needs the registry,
  which CI has). Test: todo R-SUP-11.
- **R-SUP-14** `docs/PUBLISH-CHECKLIST.md:1032`: add
  `gh api -X PUT repos/$OWNER/lightweb/environments/github-pages -f 'reviewers[][type]=User' -F "reviewers[][id]=$(gh api users/$OWNER -q .id)" -F 'deployment_branch_policy[protected_branches]=true' -F 'deployment_branch_policy[custom_branch_policies]=false'`;
  then `docs/THREAT-MODEL.md` SC-9 goes back to "mitigated | branch ruleset, environment reviewer". Test: todo R-SUP-14.
- **R-SCALE-2-E2E** `test/e2e/lib.mjs:215`: an option (for example `MW_E2E_TRACKER=uploads`) that starts
  `createTracker({ port: 0, allow: [allowFile], quiet: true })` with `allowFile` a fresh file in `runDir` holding the line `uploads`,
  and, after `publish` (`:240`), appends `pub.btih`, `pub.rendezvousBtih` and `chatLaneHash(pub.ledgerId)` to it; then run
  E-FI-1, E-MD-4 and E-SO-2 with it. The unit cases cover the tracker side today.
- **R-SCALE-15** `tools/pin.mjs:1566` (flags) and `:1323`-`:1325` (`createPinHost` call): add `'mailbox-bytes': { type: 'string' }`
  and `'mailbox-source-fraction': { type: 'int' }`, parsed like `--month-cap` (`500MiB`), and pass
  `quotas: { bytes, sourceFraction }` to `createPinHost` (`:905` already takes `quotas`, and `src/chat/holder.js:86`-`:92` reads
  `bytes` and `sourceFraction`); say the per-member capacity in `docs/recipes/hub-pin.md`. Test: a `tools-v03-pin` case where
  `createPinHost({ mailbox: true, quotas: { bytes: 64 << 20 } })` holds more than 4 MiB.
- **R-MAL53-8** (deferred, outline) `tools/pin.mjs` `createPinPageHost.start`: validate the torrent metadata against the approved
  request (one file, length equal to the declared size) before selecting pieces; hash at completion against the declared sha256 and
  delete the `pin-<ih>` IndexedDB store on a mismatch and on `--quarantine`; until then `docs/recipes/hub-pin.md:51`, `:76` and
  `docs/OPERATIONS.md:786` should not say the bytes move to a 0600 folder.
- **R-LAYOUT** `test/unit/repo-layout.test.mjs:21`: the tracked `SECURITY-KEY.asc` is not in `TOP_LEVEL`; add it (or move the key
  file under `docs/`) so the layout test passes.
- **R-BIN** `bin/lightweb.mjs:117`: old `'A release build of the loader is the dist zip on the GitHub release page (lightweb-<version>-dist.zip).'`,
  new `'A release build of the loader is the dist zip on the GitHub release page (lightweb-<version>-dist.zip); pass its signed list too: --release-list hashes-dist.json --release-sig hashes-dist.json.sig --release-key <pinned key>.'`
