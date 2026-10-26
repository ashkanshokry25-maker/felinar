# tools agent: notes and deviations (tools/*, build.mjs, .npmrc, build.lock.json, package.json scripts)

> v0.3: the notes for the v0.3 build (freeze-group tools, release and fuzz work, pin and publish changes) are at the end of this file, under "v0.3 (agent `tools`".

Agent: `tools`. Date: 2026-10-19. Owned paths: `tools/*`, `build.mjs`, `.npmrc`, `build.lock.json`, `package.json`
(scripts, plus the one field named in deviation 1), `test/unit/tools*.test.mjs`.

## Files

| File | State |
|---|---|
| `tools/lib.mjs` | Draft finished and tested: CLI parser, `injectMeta`/`readMeta`/`scanTags`, `walkFiles`, key-permission check, loopback helpers, `devCerts` (mkcert) |
| `tools/keygen.mjs` | Draft finished: JWK file mode 0600, prints `fingerprint` and `owner=` only, no overwrite without `--force` |
| `tools/ledger-admin.mjs` | Draft finished: `genesis`, `policy`, `owner`, `allow`, `ban`, `tombstone`, `show`; exports `createGenesis`, `policyOp`, `appendControl`, `loadLedger`, `readBlocksFile`, and the ops as functions `policy`, `owner`, `allow` (INTERFACES) |
| `tools/publish.mjs` | Draft finished (changes below); exports `publish`, `stampHtml`, `dnsTxt`, `ignoreReason`, `collectSite`, `siteManifest`, `buildTorrent`, `anchorInfoHash` |
| `tools/dev-server.mjs` | Draft finished (changes below); exports `createDevServer` (handle: `setPointer`, `override`, `killSwitch`, `close`), `contentTypeFor` |
| `tools/check-webseed.mjs` | Draft kept as it was; exports `checkWebseed`, `webseedUrl`, `webseedTargets` |
| `tools/tracker.mjs` | New: `createTracker`, `createAllowList`, `hashesFromText`, `readAllowFile`, `messageProblem` |
| `tools/check-site.mjs` | New: `checkSite`, `probeTracker`, `describeReason` |
| `tools/snapshot.mjs` | New: `buildSnapshot`, `encodeSnapshot`, `parseExport` |
| `tools/seed.mjs` | New: `verifyDirectory`, `resolveSeedDir`, `createDirStoreClass`, `rewriteAnnounce`, `loadWebRtc`, `seedInstructions` |
| `tools/pin.mjs` | New: `runPin`, `backoffMs`, `statusLine`, `wantsReload`, `isBroken` |
| `tools/demo.mjs` | New: `runDemo`, `planDemo`, `tierText`, `freePort` |
| `tools/live.mjs` | New (not in the brief): the one place that launches Playwright Chromium for pin, snapshot, check-site and demo |
| `tools/seeder.html` | New: served by the dev server at `/_dev/seeder.html` (needs `--dev`) |
| `tools/lint-floor.mjs`, `tools/run-unit.mjs` | New (`lint-floor` per the brief; `run-unit` is the explicit file list the brief asks for) |
| `build.mjs`, `build.lock.json`, `.npmrc` | New |
| `test/unit/tools-{lib,lint-floor,tracker,build,ledger,publish,dev-server,check,snapshot,seed,demo}.test.mjs` | New: 154 tests, no browser, loopback only |

## Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test --test-timeout=180000 test/unit/tools-*.test.mjs        # 154 pass, 0 fail, about 2 s
    npm run lint:floor                                                     # 41 files, clean
    npm test                                                               # lint:floor + every non-browser unit file

All 409 tests of the non-browser unit files pass together on this machine (about 6 s) except the two files that never
exit (`loader-app-torrent`, `sw-sdk`, see orchestrator-notes.md; they belong to other agents, I did not touch
them). Every tools test file exits on its own: servers are closed in `after()`, child processes are waited for.

## Deviations, with reasons

1. **`package.json` `description` changed.** The brief says "scripts only", but DESIGN-REVIEW 4.1 names the
   `package.json` description and forbids "blockchain" in it; the old text had it. It now holds the approved
   one-liner. Nothing else but `scripts` changed (version, dependencies and `allowScripts` are as they were).
   Extra scripts beyond the brief: `ledger`, `test:example`, `check:example` (the example agent asked for the
   last two).
2. **`--verify-ws` runs in process, and stale pointers are removed.** The draft spawned `check-webseed.mjs`
   with `spawnSync`, which blocks the event loop and deadlocks against a dev server in the same process.
   `publish()` now calls `checkWebseed()` and prints its targets before connecting. publish deletes the
   pointer-bearing outputs of an earlier run (`pointer.txt`, `magnet.txt`, `meta.html`, `dns.txt`,
   `summary.json`, and `site/` or `shell/` when it rebuilds them) before the gate, so a failed gate never
   leaves a stale pointer behind. Reading of "will not print the pointer until `--verify-ws` passes when
   `--ws` is given": the gate applies when `--verify-ws` is passed (it needs `--ws`); without it publish
   prints a warning that the web seed is unverified. Flow: publish once, upload the tree, publish again with
   `--verify-ws` (same files, same infohash, genesis reused).
3. **`publish --prev-key <old.jwk>` added.** Writes `rot=` (the previous owner's signature over the new
   owner and `seq`), so a key change is silent for returning visitors (ARCHITECTURE section 4). The spec's flag
   list had no way to produce `rot=`.
4. **The stamp is the first child of `<head>` except that a leading `<meta charset>` stays first.** Browsers
   only honour a charset declaration in the first 1024 bytes, and a long pointer would push it out.
   `stampedPointerFromHtml` finds the stamp either way. Pages without `<head>` get the meta at the top.
   `--inject-script` also works for pages without `</head>`.
5. **S3 CORS JSON lists `GET, HEAD`, not `OPTIONS`.** S3 rejects `OPTIONS` in `AllowedMethods` and answers the
   preflight itself from the rules; the layout file says so. The CloudFront note asks for OPTIONS to be allowed.
6. **dev-server:** SPA fallback is automatic when the root `index.html` is the loader shell (`isShellHtml`),
   because a drop-in deploy copy must keep the host's own 404 page; `--spa` / `--no-spa` force it. Dotfiles
   under `--root` (`.git`, `.env`) are not served except `.well-known` and `.mw`; symbolic links out of the
   root are not followed; the `/ws/` web seed serves everything under `--webseed` including `/.mw/`. A missing
   `--webseed` directory is created when its parent exists (start the server first, publish against its URL,
   then `server.setPointer(pointer)`). `--json` prints one line `{ url, urls, port, spa }`. `/_dev/seeder.html`
   serves `tools/seeder.html` with `--dev`. `Cache-Control: no-cache` is sent on every response, not only on
   `/mw-sw.js` and HTML (ETag revalidation, which is what a production host should do for `/_mw/*` too).
7. **tracker:** built on bittorrent-tracker's server with its own HTTP server so that `--tls` works. Two
   upstream bugs are guarded because they let a remote client kill the process or list every torrent:
   an announce with `offers: [null]` (or any offer without an `offer` object) throws from a timer callback in
   bittorrent-tracker 11 once another peer is in the swarm, and a scrape without `info_hash` returns every
   torrent. `messageProblem()` refuses the first (`failure reason`), a bare scrape gets an empty answer.
   Extras: `--host` (default 127.0.0.1), `--json`, `/healthz`, `/stats.json` (counts only), a 128 KiB frame
   cap, a 10 000 swarm cap with `--open`, `--allow` files re-read when they change. `--allow` accepts an
   infohash, a magnet link, a `.torrent`, publish's `summary.json` (it lists `btih` and `anchorBtih`, the
   ledger anchor torrent of section 5.5 that needs to be allowed too), or a text file.
8. **build.mjs:** `boot.js` is built for `es2017` (not the full target list) because it must parse in old
   browsers to tell them so; every other bundle uses `['es2020','safari15.4','chrome110','firefox115']`. The
   vendored bundle gate is stricter than "parses": at the three engine targets esbuild must change nothing
   (the file is copied byte for byte, so a webtorrent upgrade that introduces, say, class static blocks,
   which Safari 15.4 lacks, fails the build). The current bundle passes at all targets; it only needs
   lowering at plain `es2020` (class fields), which is irrelevant for a file that is copied. `build.lock.json`
   pins sha256 and version; `node build.mjs --update-lock` re-pins after review, `--check-lock` only checks.
   Builds are reproducible (no timestamp; `build.json` records the build id, hashes and SRI values; two builds
   are byte-identical). The BUILD_ID is derived from the hashes of every file except the two that contain it.
   Placeholders are replaced textually after bundling (`applyPlaceholders`), and the build fails if a worker
   bundle lacks them. The lock entry also lists `markers` (strings the bundle must still contain; today
   `_onMessageLength(`, the method `src/loader/torrent.js` wraps for the 256 KiB message cap), so pinning a bundle that
   renamed it fails the build instead of silently dropping the cap. `dist/_mw/mw.js` is skipped with a warning while `src/dropin/mw.js` is missing; it is
   added to the precache list automatically once it builds. A non-empty output directory without `build.json`
   is never wiped.
9. **check-site:** the tracker probe sends an announce with `event: stopped` (the tracker's allow list answers
   it, and a `stopped` announce registers no peer) and then a scrape, so "this tracker does not allow your
   torrent" is detected; a scrape alone cannot tell. Extras beyond the brief: the SRI hashes in the page are
   compared with the files the host serves now (stale CDN), `/mw-sw.js` content type and cache headers, drop-in
   host files (each file of the torrent at its own URL with the right length), the `cs=` snapshot (must hold
   the genesis block), `--tolerate-trackers <n>`, `--json`. DNS is skipped for localhost and IP addresses, as
   the loader does.
10. **snapshot:** values the ledger has redacted (tombstoned, banned author) are removed from the file, so the
    host never republishes what a moderator took down; output is gzip by default, `--plain` for Safari before
    16.4 (the loader needs `DecompressionStream` for gzip, app.js `fetchSnapshot`). [Superseded: since code review
    round 1 (F20, `src/common/inflate.js`) every loader reads gzip; `--plain` is an option, not a requirement.] `<url>` that is not
    loopback needs `--remote` (this tool then reaches the internet and is not one of the three allowed by
    docs/DEV-NETWORK.md without an explicit flag); a URL of a live site is opened in Playwright Chromium and the
    ledger is read from its IndexedDB.
11. **Tools that reach the internet by nature:** `pin.mjs`, `seed.mjs` (trackers and browsers), `snapshot.mjs
    <url> --remote`, `check-site.mjs`, `check-webseed.mjs`, and `publish.mjs --verify-ws` (calls check-webseed).
    Each prints what it will contact first. The unit tests only call the library functions, against servers
    on 127.0.0.1, and never start a browser; `demo.mjs` launches Chromium with `chromiumArgs()` (local-only) and
    only `localhost` names (it opens the seeder via `https://localhost:...` even in the LAN tier). `pin`,
    `snapshot <url>` and `check-site --headless` use `chromiumArgs({ allowRemote: true })`, always through
    `tools/live.mjs`.
12. **lint-floor** also covers regex lookbehind (Safari 16.4), `toSorted`/`toReversed`/`toSpliced` (Safari 16),
    class static blocks, `Uint8Array` hex/base64 (exempt in `boot.js`, which defines the polyfills), unguarded
    `structuredClone`, `ArrayBuffer.transfer`, `Promise.try`, import maps and a few CSS features (`:has`,
    `@container`, `color-mix`, `light-dark`, `subgrid`). Top-level await in classic scripts is caught by the
    build (the iife bundles refuse it). A line with the comment `lint-floor-ignore` is skipped.
13. **`ws` is imported by `check-site.mjs` (optional, falls back to the global `WebSocket`) and by two tests.**
    It is a dependency of bittorrent-tracker and hoisted, but not listed in `package.json`; I did not touch
    `dependencies` (no installs, and `npm ci` would complain about a lock mismatch). `webrtc-polyfill` and
    `node-datachannel` (for `seed.mjs`) are also only transitive; `seed.mjs` degrades to instructions (exit 3).

## Facts checked

- `src/loader/boot.js` already honours `<meta name="mw-dev" content="1">`: `boot.dev` (line 469) feeds
  `cspFor()`, which adds `ws://127.0.0.1:*`, `ws://localhost:*` and `wss://<lan-ip>:*` (lines 433-440). Nothing
  was added there. A unit test pins these strings.
- `tools/seeder.html` run in Playwright Chromium (local-only flags) produced the **same infohash** as
  `publish.mjs` for `examples/peer-guestbook` (`12d3309c...`): same name, 256 KiB pieces, files passed with `fullPath`, no
  `private` option (it would change the info dictionary).
- `seed.mjs` with node-datachannel (installed here) served all 10 files of the example to a second Node client
  through the local tracker (about 12 s, dominated by announce and ICE timing).
- `mkcert` is not installed on this machine, so the TLS paths were tested with a self-signed certificate made
  by `openssl` inside the tests (they skip when openssl is missing). The mkcert generation path is only
  exercised for its error message.
- `node build.mjs`: 13 files, 656 KiB (loader.js 276 KiB, webtorrent 223 KiB), about 0.3 s.
- Vendored webtorrent 3.0.21: sha256 `db4dca98cd135c732eeffdede3cf5f8febd0585a0eba4dc4d1effa1b901f4c3d`.

## For the integrator

1. **A fresh visitor sees "This site isn't ready yet" in the frame until a reload.** Repro:
   `node tools/demo.mjs --port 18080 --tracker-port 18000`, open `http://localhost:18080/` in a clean Chromium
   profile (or `node tools/check-site.mjs http://localhost:18080/ --headless`). Timeline from a Playwright trace:
   at 0.1 s the whole copy has come from the web seed (loopback), IndexedDB is complete, and the shell navigates
   the frame; `GET /` answers 503 (src/sw/core.js `serveSite` -> `notReady`). `self.mw.inspect()` in the worker, 3 to
   15 s later, shows `current` = the btih but `sites: []`: the worker's index of the stored site is empty and nothing
   asks it again. `siteEntry` calls `refreshSite(btih, false)`, which is throttled to one IndexedDB read per 2 s per
   btih (`limits.refreshThrottleMs`); the forced read that `mw-set-current` triggers evidently ran before the site
   record was readable, so the frame's request lands inside the throttle window and the frame is never navigated
   again. A reload renders "Peer Guestbook". On a real network the copy takes longer than 2 s, which hides it; on
   loopback it is deterministic. Likely fixes: post `mw-site-saved` after the IndexedDB transaction has committed and
   wait for the ack before mounting the frame, and/or let `serveSite` force one refresh when `state.current.btih ===
   ctx.btih` and the entry is missing. `tools/live.mjs` treats the worker's placeholder titles as "not rendered",
   and `pin.mjs` and `snapshot.mjs <url>` reload once or twice to recover.
2. **A visitor cannot post to an open ledger unless the genesis block reaches them** (`ChainNode` refuses a
   non-owner root, node.js line 1078). Publish with `--cs <URL of genesis.json>`: for local runs
   `--cs http://127.0.0.1:<dev port>/ws/genesis.json` (the dev server's `--webseed <out dir>` serves it).
   `publish` warns when `writers` is not `owner` and `--cs` is missing; `tools/demo.mjs` does this already.
3. **Starting things for e2e from code** (all return `{ url, port, close() }`-style handles; none prints anything
   unless asked):

       const tracker = await createTracker({ port: 0, open: true });            // tracker.url = ws://127.0.0.1:<port>
       const dev = await createDevServer({ root: 'dist', webseed: outDir, port: 0, dev: true, quiet: true });
       const pub = await publish({ dir: 'examples/peer-guestbook', name: 'peer-guestbook', scope: '127.0.0.1', key, out: outDir,
         policy: 'open', bits: 4, tr: [tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', quiet: true });
       dev.setPointer(pub.pointer);
       // seeder page: dev.url + '_dev/seeder.html?tr=' + encodeURIComponent(tracker.url); window.__seeder.ok === true

   `publish` options are the CLI flags in camelCase (`tr`, `ws`, `xs` are arrays). `runDemo({ port: 0, trackerPort: 0,
   seeder: 'none' })` does all of this with a persistent key under `.tools/demo/`. On the command line the first
   stdout lines are parsable: tracker `magnet-web tracker listening: ws://...` (or `--json`), dev server
   `--json` gives `{"url":...}`.
4. **`publish --out` is where the dev server's `--webseed` must point**: it holds `<name>/<files>`,
   `<name>.torrent` (the default `xs=`), `summary.json` (read by `seeder.html`) and `genesis.json`. `--shell`
   adds a `shell/` copy of the loader with the pointer stamped (the host directory for shell mode).
5. **The ledger id contains the pointer's current owner key** (`ledgerIdFor`), so a key rotation (`rot=`,
   `ledger-admin owner`) changes the id and the IndexedDB name; the earlier ledger would not carry over.
   `publish --prev-key` only makes the pointer change silent. Whether the id should use the genesis owner is a
   design question, not a tools one.
6. `tools/dev-server.mjs --tls` and `tracker.mjs --tls` need mkcert (`brew install mkcert nss && mkcert -install`)
   or `--cert/--key`; certificates are generated into `.mw-dev-certs/` (git-ignored). `demo.mjs --tls` prints the
   iOS and Android trust steps.
7. `npm test` runs `lint:floor` and every non-browser unit file with `--test-timeout=180000` and a 5 minute
   watchdog (`MW_UNIT_TOTAL_MS`, then it kills the run and exits 1); the two files that leak handles
   (`loader-app-torrent`, `sw-sdk`) trip it until they are fixed (checked again at the end of this build: both
   still hang after their tests pass).
8. `demo.mjs --tls` also takes `--cert <file> --key <file>` (your own certificate instead of mkcert) and
   `--bind <address>` (default 0.0.0.0 for the LAN tier, 127.0.0.1 for the desktop tier). `createDevServer` and
   `createTracker` accept `tlsHosts` (extra names the generated certificate must cover; the demo passes the LAN
   host). The LAN tier's code path is covered by a unit test with an openssl certificate on 127.0.0.1.

---

# v0.3 (agent `tools`: T1 and P1 code, 2026-10-20)

Scope: V03-DESIGN-REVIEW 2.3.6, 2.5.3, 2.5.5, 2.7.5 item 7, 2.8.5, 2.8.6, 2.10.1, 2.19, 3.8; MF-04, MF-20, MF-22, MF-27 to MF-29, MF-43, MF-44,
MF-46, MF-50, MF-73, MF-78; SC-6, SC-7. Owned paths this wave: `tools/*`, `build.mjs`, `build.lock.json`, `package.json` (scripts), `npm-shrinkwrap.json`,
`.github/workflows/{ci,release,rebuild}.yml`, `test/fuzz/**`, `test/unit/tools*.test.mjs`, and the two assertions of `test/unit/repo-layout.test.mjs` named below.
Nothing was pushed, tagged, published or run in CI; `dist/` was served by the opt-in browser test and never rebuilt; no browser was started except
`launchBrowser` (local-only flags, 127.0.0.1) in that test and in an earlier smoke run of the same page; no package was added.

## v0.3 files

| File | State |
|---|---|
| `tools/ledger-admin.mjs` | Rewritten around the freeze group: `unban`, `ban --until`, `keyinfo` (rc = b64url sha256 of the recover key), `rotate --by self\|recover` (rsig over `mw-rotate-v1` + ledger id + from + next), `checkpoint` (writes the canonical state file and prints `snap`), `tombstone --authors --before` (bulk, at most 64), policy fields `--mod-allow-per-day`, `--mod-actions-per-hour`, `--reserved-pool`, `--void`, `cfg` for every R 2.5.5 row, `deny` (`_deny/<b64url sha256(utf8(ih or sha256))>` with a reason code), `capacity` (members x items x 1,877 bytes, labelled arithmetic). All offline. Exports of v0.2.1 kept; new exports listed under "Proposed spec text" |
| `tools/publish.mjs` | `--org` (repeatable, at most 4), `--next-key`/`--nx` (automatic `nx=` and its continuity), `--ml`, `--idp`, `--prev-pointer`, `--signin-widget`, `--chat-panel` (copy from `dist/_mw/`, print the tag with its sha384 SRI hash and `<mw-signin>` or `<mw-chat-panel>`), `--chat --files --media` with `--tracker` and `--stun` required, `--turn`, `--cfg-from`; `loader-headers.txt` (COOP `same-origin-allow-popups`, `Referrer-Policy: no-referrer`) and `shell/_headers`; CSP lines with `connect-src` for the site's tracker and `worker-src 'self'`; no rotation output other than `rot=` v2 |
| `tools/verify-release.mjs` | New: `list`, `sign`, `verify`. The per-file SHA-256 list is `{ v, kind: 'mw-release-files', version, tree, name, files: [{ path, bytes, sha256 }] }` in JCS order; the signature is ECDSA P-256 (P1363) over `mw-release-v1\n` + the JCS list, in a file `{ v: 1, alg: 'ES256-P1363', key, sig }`. `verify` takes the PINNED key (a file with `p256:...`, a public JWK or the key file) and decides on it alone. Offline |
| `tools/pin.mjs` | The stores are plain files under `<profile>/pin/` (0600, directories 0700): `--mailbox` (flagged ENV frames with the chat holder quotas, stranger mail only after INBOX-CHAL/RESP), `--files` (moderator queue: name, size, author key, declared hash; never opens or renders a file; `--approve`, `--decline` (asked again after 7 days), `--queue`, `--pinned`), `--quarantine <ih>` (isolated folder, no execute bit, seeding stopped, logged in `log.jsonl`). Exports `PinStore`, `Mailbox`, `FilePins`, `createPinHost`, `attachPinBridge`, `pageSeeder`, `PIN_LIMITS` |
| `tools/seeder.html` | `?persist=1` keeps the pieces in the browser profile with the loader's `IdbChunkStore` (served at `/_dev/store-idb.js` by `dev-server --dev`); a restart that finds every piece verifies the torrent against the store and fetches no file |
| `tools/webseed-file.mjs` | New: copies a file (the ciphertext for a private file) to `<dir>/ws-files/<sha256>`, writes the R 2.8.5 headers into `<dir>/_headers`, prints the `ws=` value; caps 25 MiB (public) and 100 MiB (private) with the exact byte count in the error; `--torrent` checks the bytes against the torrent first |
| `tools/init.mjs` | New: the R 2.5.5 wizard in one pass. It asks the owner-settings questions (or reads `--answers <file>`) and PRINTS the commands in order (key, next-key, publish, ledger-file, cfg, capacity, snapshot, tracker, pin, check); it runs nothing and refuses what the tools refuse |
| `tools/dev-server.mjs` | `--idp-port` (with `--idp-root`) serves `dist-idp/` with its own `_headers` on a second port, 127.0.0.1 only; `createIdpServer` and the `idp` handle of `createDevServer` |
| `build.mjs`, `build.lock.json` | Optional entries `src/widget/signin.js` -> `_mw/signin.js` and `src/widget/chat-panel.js` -> `_mw/chat-panel.js`; the lock pins every bundled package (name, version, sha256 of its directory in `node_modules`) and the build fails on drift; the lock header carries the two-person review note |
| `package.json`, `npm-shrinkwrap.json` | Scripts `test:fuzz`, `build:idp`, `init`, `verify:release`; `files` gains `npm-shrinkwrap.json` and nothing else (see deviation 13); `version` unchanged; `npm-shrinkwrap.json` is `package-lock.json` byte for byte |
| `.github/workflows/ci.yml`, `release.yml`, `rebuild.yml` | CI: `npm ci --ignore-scripts`, the fuzzers with a short budget and the run number as the seed, `node build.mjs --strict` and `--check-lock`, the pack job allows the shrinkwrap. `release.yml`: build, attest, release (a DRAFT). `rebuild.yml`: the build on three operating systems and a byte comparison of the file lists |
| `test/fuzz/run.mjs`, `targets.mjs`, `kit.mjs`, `targets/{chain,chat,identity,pointer,files}.mjs` | New: the seeded fuzzers (below) |
| `test/unit/tools-v03-{ledger,publish,pin,init,release,fuzz}.test.mjs`, `tools-v03-pin-browser.test.mjs` | New (the last is opt-in: `MW_BROWSER=1`) |

## v0.3 tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test test/unit/tools-v03-*.test.mjs        # 100 pass, 0 fail, 1 skipped (the opt-in browser test)
    MW_BROWSER=1 node --test test/unit/tools-v03-pin-browser.test.mjs    # 1 pass (needs dist/_mw/webtorrent.min.js; never rebuilds dist/)
    node tools/run-unit.mjs test/unit/tools-*.test.mjs test/unit/repo-layout.test.mjs    # 317 pass, 0 fail, 1 skipped

By file: ledger 22, publish 24, pin 14, init 8, release 21 (hash lists, package pins, optional widgets, the workflows and shrinkwrap read as files, and `npm pack`), fuzz harness 11
(registry, replay, the sweep, every target for 60 inputs, the runner's verdicts, a hang, the CLI, and a bug put back). `cli-bin.test.mjs` (8) passes too.
The fuzz campaign itself is not part of `npm test`; `npm run lint:floor` is clean.

## v0.3 deviations, with reasons

1. **The release workflow stops at a draft; the signing key never enters CI.** SC-1 and SC-8 ask for a signed per-file hash list, immutable releases and
   provenance. A key that signs in CI is a key the CI provider holds, so the workflow builds, tests, packs, attests (`actions/attest-build-provenance`) and creates a DRAFT
   release; the owner signs `hashes-dist.json` and `hashes-idp.json` offline (`verify-release.mjs sign`), uploads the `.sig` files (no `--clobber`: the draft has none),
   checks them with the pinned key and publishes the draft, which is what makes the release immutable. The steps are at the top of `release.yml`. The settings a workflow
   cannot make (release immutability, a tag ruleset on `v*`, reviewers on the `release` environment, a Dependabot cooldown, CODEOWNERS on the lock files) are listed there too.
2. **The pin of `actions/attest-build-provenance` (v3.0.0) is unverified.** No network was available. `release.yml` says so beside the line; check the commit hash against
   the tag with the `ls-remote` loop of docs/PUBLISH-CHECKLIST.md before the first release. The other pins are the ones the repository already used.
3. **`nx=` is kept automatically.** A record of the same owner must carry the same `nx=` as the one before it, or loaders that hold the earlier record refuse it (nx-changed).
   `publish` reads the previous pointer (`<out>/pointer.txt`, or `--prev-pointer <file>`; `none` starts afresh) and carries `nx=` over; it refuses a different `--next-key` for the
   same owner (nx-changed), refuses a new owner key that is not the committed one even with `--prev-key` (nx-mismatch), and notes a rotation to the committed key. `--withdraw` warns
   when the previous pointer has `nx=` and the withdrawal does not carry it (`tools/withdraw.mjs` does not take `nx` yet: request below).
4. **A site with chat, files or media names its OWN tracker and STUN, or publish refuses.** The own tracker goes into `tr=` (the shared defaults do not count), the STUN list into
   `/.mw/site.json` (R: "the STUN list in the site config"), TURN into the same file and off by default. `--cfg-from <ledger.json>` reads the features from `_mw.cfg`, so the
   check cannot be skipped by leaving the flags out.
5. **The widgets are not precached; the worker hash-checks them when it serves them.** They are optional per site, so they stay out of the precache (the first visit
   would otherwise fetch them for every site), and `build.json` `integrity` lists them so the worker checks the bytes against the build.
6. **The build skips an optional entry while its file or one of its relative imports is missing, and says so; `--strict` makes that an error.** CI and the release use
   `--strict`. A real error (a syntax error, a missing package) is never skipped. This lets the tools lane build before the widget lane has written its files.
7. **A bundled package is pinned by the hash of its directory plus the lockfile's integrity string, not by a tarball hash.** The tarball's sha256 cannot be computed
   offline; the directory hash (every file, path and byte, without the nested `node_modules`) changes with any edit under `node_modules`. Today the lock holds no
   package besides the vendored WebTorrent: `0 bundled package(s) match build.lock.json`.
8. **The fuzzers are seeded mutation fuzzers, not coverage-guided.** No new package (Jazzer.js was the research's suggestion and is not installed). The cost is
   depth: the oracles are models written from the spec, and a bug only the guidance of coverage would reach is not found. The benefit is that they run offline in
   seconds, replay by seed, and a model that disagrees with the code names the field.
9. **Each fuzz target runs in a worker thread.** A synchronous infinite loop (the A1 freeze was one) cannot be interrupted from its own thread, so the runner watches a
   shared progress counter and kills a target that makes no progress for `--hang-ms` (20 s by default), reporting the input number; a memory cap (1.5 GB) turns an
   out-of-memory blow-up into a report. `--no-worker` runs in the main thread for debugging.
10. **`test/fuzz/targets/<lane>.mjs` is the extension point.** Any module there that exports `TARGETS` is picked up (`--list` shows them); the review asks every
    module's lane to add its own parsers (media chunk format, sealed boxes, MP4 and WebM box rewriting, image headers, the Noise handshake), and none of them needs a
    change to `run.mjs`. `--module <file>` loads one from elsewhere.
11. **`tools-v03-pin-browser.test.mjs` follows the `*-browser` convention** (opt-in, left out of `npm test`) instead of an `MW_BROWSER` branch inside `tools-v03-pin.test.mjs`.
12. **`pin.mjs` trusts the pinned site's own code in drop-in mode.** `window.__mwPinCall` (top frame only) lets the page ask the Node side to store a file chunk or a held
    envelope; in drop-in mode the page is the site, so a site can fill its own pin quota (caps: 100 MiB a file, 2 GiB in all, 200 pending requests, 20 per author). The quarantine
    and the moderator queue still apply, and nothing the node holds is ever opened or rendered.
13. **`npm-shrinkwrap.json` is named in `package.json` `files`.** With a `files` list npm leaves the shrinkwrap out of the tarball unless it is named (checked with `npm pack --dry-run` on npm 11.19.1,
    with and without the entry); the brief said to leave `files` unchanged except for what the new tools need, and the published package needs its shrinkwrap to install what CI tested. The
    `release` workflow and the `ci` pack job both fail if the tarball lacks it, and `tools-v03-release.test.mjs` checks the pack list, that nothing from `test/`, `docs/` or `packages/` ships, and that
    every relative import of a packaged file stays inside the package.
14. **A replay has the same mutation but fresh keys.** The targets that sign (`block-validate`, `gossip-handle`, `signin-parse`, `verify-package`) make new P-256 keys (and, for payload blocks,
    value salts) in each process, so `--seed S --replay N` rebuilds the same logical input with other key, salt and signature bytes. A failure that depends on those bytes (a bad signature accepted)
    does reproduce, because a signature is made valid or invalid by the same rule; nothing else in an input depends on the clock or on `Math.random`.

## What the fuzzers do

`npm run test:fuzz -- [--target <name>]... [--iterations 2000] [--seconds <s>] [--seed <text>] [--replay <n>] [--max-ms 500] [--hang-ms 20000] [--module <file>] [--list] [--json] [--verbose] [--no-worker]`

Fifteen targets: `gossip-decode`, `gossip-handle` (mw_chain1 frames: HELLO, WANT, BLOCKS, ANN, SYNC, INV, and `Gossip.handle()` with a fake peer), `block-validate` (every op,
the freeze-group fields), `jcs-diff`, `chat-frames`, `chat-point`, `signin-parse`, `verify-package`, `pointer-parse`, `pointer-txt`, `magnet-parse`, `files-validate`, `bencode`,
`torrent-file`, `inflate`. Every input is a function of (seed, target, iteration): the seed is printed first, `--seed S --replay N` reruns input N alone, and a longer run extends a
shorter one. The first inputs of each required target are a fixed sweep that drives every numeric field to 0, -1 and 2^53-1 (and every byte-wide field to 0 and 255), so the
A1 class is covered whatever the seed and the budget (`tools-v03-fuzz.test.mjs` checks the coverage); random inputs follow (edge values, the stated maximum and its
neighbours, lengths from 0 to twice the maximum, byte mutations, spellings of a number JSON must refuse).

Each target asserts: no undocumented throw (a fileError, E_BENCODE, E_INFLATE and E_BAD_TORRENT are documented), each input within `--max-ms` (run a second time before it counts), a hang
killed and reported, an input that is malformed by construction refused (never accepted), and the invariants of what is accepted. Where the spec gives arithmetic the targets
write it out rather than import it (n and c at most 64 MiB over the smallest block, `-1 <= d < n + c`, window and list maxima, the chat table of R 2.7.3, the sign-in window
of 300 s and skew of 120 s), so a drift in an exported constant is a failure too. A difference between two implementations that is known and harmless is a note, not a failure.

The harness is itself tested: removing the HELLO bounds from a scratch copy of `src/` is reported by `gossip-decode` within the first inputs, and (checked by hand, not in the
unit test, because the target allocates until it is killed) putting the whole A1 bug back, no codec bound and no clamp in `_startSync`, makes `gossip-handle` report a hang in
input 20 after 4 s with `--hang-ms 4000`.

## Findings of the fuzzers about other lanes' code (nothing here was fixed by me)

1. **`packages/verify/verify.js` accepts what `src/identity/signin.js` `parseProof` refuses** (note `verifier-looser-than-parser`): a `resources` entry that is not a URL
   (`https://`) or is longer than 1,024 characters, and an `idp` origin longer than 300 characters. The verifier does check the rest of the proof, and the identity page builds the
   fields with the stricter rules, so only a hostile or buggy identity origin can produce such a proof; but the server-side verifier is the one place the rules should be enforced, so it
   should apply the same three checks (identity lane). Both are exercised by `signin-parse` and `verify-package`; the notes disappear when the two agree.
2. **`src/common/inflate.js`: a cap below 1,024 bytes is not exact** (note `inflate-cap-below-1024`). `Output` starts with a 1,024-byte buffer and checks `maxOutput` only when it must
   grow, so `inflateRaw(<10 literal bytes>, { maxOutput: 9 })` returns 10 bytes. Every caller in the repository passes a large cap. Also: `gunzip(new Uint8Array(0))` returns an empty array
   (node:zlib reports an unexpected end of input) and a gzip header with reserved flag bits set is read (zlib refuses). Both are notes (`gunzip-accepts-empty-input`,
   `inflate-looser-than-zlib`), and `inflate-stricter-than-zlib` (trailing bytes after a member) is the safer direction.
3. `validateFileTorrent(torrent, { infoHash: '' })` skips the infohash comparison (`opts.infoHash &&`). By design; the caller (`src/files/lane.js`) passes the listing's `ih`. Noted so that
   a listing without `ih` is read as "unchecked", not "checked".

Everything else held in the campaigns listed under "Measured": no undocumented throw, no input over the time bound, no hang, no accepted value outside its range, no frame
the gossip engine sent that its own decoder refuses, no swallowed internal error (`stats.errors`). The only failures the campaigns found were in my own models and were fixed
(a change of an ENV or SIG length can land on another valid bucket, a negative zero in a round trip, an empty bencode input, an invalid number spelling in a CK body).

## Existing tests I changed (intended changes only)

- `tools-build.test.mjs` D2: the integrity map now lists the built widgets (not precached, hash-checked). F7: `ready()` of the static SDK stub also has `auth: 'guest'` and `features`
  (SDK lane); the test asserts the v0.2.1 members exactly and the two new ones loosely.
- `repo-layout.test.mjs`: `TOP_LEVEL` gains `packages` and `npm-shrinkwrap.json` (the brief); the OIDC rule allows the `release` workflow's attest job
  (`actions/attest-build-provenance`, the only job that may hold `id-token: write`); the examples list accepts `social` and `docs/research` accepts `v03`, because other lanes
  added those directories this wave. Every other assertion is unchanged.
- `ledger-admin capacity --file <ledger>` without `--members` now reports only the file's position (it used to print a "0 members x ..." line).

## Requests

To the integrator:
1. `bin/magnet-web.mjs` `COMMANDS` and `test/unit/cli-bin.test.mjs`: add `init`, `verify-release` and `webseed-file` (the three new tools).
2. E-SI-1 owner-step wiring, E-FI-1 (the deny flow in a browser) and the full `npm test` are yours; so is any real release.
3. `.github/CODEOWNERS` (`build.lock.json`, `package-lock.json`, `npm-shrinkwrap.json`, `.github/`, `tools/verify-release.mjs`) and Dependabot with a 14-day cooldown are repository files I do
   not own; `release.yml` assumes them.
4. Add `mw-release-v1\n` (the release list), and the webseed `_headers` CORS block, to the R 2.10.3 list of signing and domain-separation prefixes.
5. `src/widget/{signin,chat-panel}.js` and `tools/build-idp.mjs` exist now. Checked in scratch directories (not `dist/`, not `dist-idp/`): `node build.mjs --strict` builds 18 files
   (2,189,705 bytes) and `node tools/build-idp.mjs` 7 files (184,717 bytes); building each twice gives byte-identical `verify-release.mjs list` output; a list signed with a throwaway key verifies, and a
   byte appended to `index.html` fails with the file named. `ci.yml` and `release.yml` use `--strict`, so they fail if a lane's optional entry stops building: that is the intent. `rebuild.yml`
   needs `dist-idp/` to build the same on Windows and macOS; that run is the first time it is tried.
6. Spec text: the proposals below for ARCHITECTURE section 10 and INTERFACES "tools and build" (spec files are not mine to edit). ARCHITECTURE section 12 (Tests) and CONTRIBUTING.md should name
   `npm run test:fuzz` and the opt-in `tools-v03-pin-browser.test.mjs`.
7. `test/unit/docs-links.test.mjs` fails today for a reason outside this lane: `examples/social/README.md` links to `../../docs/deviations/examples.md`, which does not exist yet (examples lane).

To other lanes:
- `tools/withdraw.mjs` (serving-publishing lane): `withdrawalRecord` takes `nx`; pass the previous record's `nx=` (`publish --withdraw` warns today when it is missing). MF-30 says a withdrawal
  expires at most 30 days after it is signed and is re-signed, while `withdraw.mjs` signs for 399 days by default (`WITHDRAW_EXP_DAYS`); the default and the `--exp` limit need the lane's decision.
- SDK lane: the pin node's page-side contract is `window.__mwPinHost = { start(options), stop() }` (set by `pageSeeder`) and calls to `window.__mwPinCall(op, args)` with the ops `file.request`, `file.write`,
  `file.finish`, `file.read`, `file.pinned`, `mailbox.offer`, `mailbox.want`, `mailbox.challenge`, `mailbox.respond`, `mailbox.collected`, `stats` (`createPinHost` in `tools/pin.mjs`).
  The deploy template needs `PIN_MAILBOX` and `PIN_FILES` in its environment if it runs `pin.mjs`.
- Media lane: `_mw.cfg.blockTiers` is read by the media lane but is not in the `cfgOk` schema of the freeze lane, so `ledger-admin cfg` cannot write it (and a node that validates `_mw.cfg` against the
  schema will ignore it).
- Identity lane and formats lane: the findings above.
- Anyone who owns a parser: add `test/fuzz/targets/<lane>.mjs` (see deviation 10).

## Measured on this machine

- Fuzz throughput: 15 targets x 8,000 inputs = 120,000 inputs in 22.1 s (verbose run, seed 9); 90,000 inputs (6,000 each) in 16.7 to 23.0 s; `--iterations 3000` (the CI setting) is 45,000 inputs
  in 9.2 s. The slowest single input of the verbose run was 14.6 ms (signin-parse, an object nested 100,000 deep); one earlier run saw 50.9 ms once in gossip-handle. The bound is 500 ms.
- Seeded campaigns run for this build, all with 0 violations in the code under test: 6 seeds x 120,000 inputs (101 to 106; seed 106 found a false alarm in the chat model, fixed), 10 seeds x 90,000
  (201 to 210; seed 204 found one in the bencode target, fixed), 8 seeds x 90,000 with the final targets (301 to 308), and the 120,000-input verbose run above: about 2.5 million inputs in all.
- `seeder.html?persist=1` in Chromium with a profile directory: the first run read 6 files from the web seed and stored every piece; the second run on the same profile resumed
  (`resumed: true`) and read 0 files (`tools-v03-pin-browser.test.mjs`, 0.6 s for both).
- `node build.mjs --check-lock`: the vendored bundle matches, 0 bundled packages (nothing is bundled from `node_modules` besides it); `npm-shrinkwrap.json` equals `package-lock.json`.

## Proposed spec text (to the integrator; marked v0.3)

### ARCHITECTURE section 10, additions

> **v0.3** (tools lane; DESIGN-REVIEW 2.3.6, 2.5.3, 2.5.5, 2.8.5, 2.10.1, 2.19).
> - `ledger-admin.mjs` adds `unban`, `ban --until`, `keyinfo`, `rotate --by self|recover`, `checkpoint [--out <state file>]`, `tombstone --authors --before`, the policy fields
>   `modAllowPerDay`, `modActionsPerHour`, `reservedPool` and `voided`, `cfg` (the `_mw.cfg` put: chat, files, media, records with `--max-items` at most 32, requests with `--chat-bits`, pin, turn,
>   age), `deny` (a `_deny/<b64url sha256(utf8(ih or sha256))>` put with a reason code) and `capacity` (members x items x 1,877 bytes). Offline.
> - `publish.mjs` adds `--org` (at most 4 exact origins), `--next-key`/`--nx` (the commitment to the next owner key, carried into every later record of the owner), `--ml`, `--idp`, `--prev-pointer`,
>   `--signin-widget`, `--chat-panel`, `--chat --files --media` (each needs the site's own `--tracker` and `--stun`), `--turn`, `--cfg-from`. It writes `loader-headers.txt` (COOP `same-origin-allow-popups`,
>   `Referrer-Policy: no-referrer`) and prints the CSP lines for the tracker. Only `rot=` v2 is written.
> - `pin.mjs` adds `--mailbox` and `--files` (a moderator queue; the node never opens a file) and `--queue`, `--pinned`, `--approve`, `--decline`, `--quarantine`. `webseed-file.mjs` puts a file (ciphertext for a
>   private file) in a static folder with the R 2.8.5 headers. `init.mjs` asks the owner-settings questions and prints the commands. `dev-server.mjs --idp-port` serves the identity page on a second loopback port.
> - `verify-release.mjs list|sign|verify`: the per-file SHA-256 list of a tree, signed offline with the release key (ECDSA P-256 over `mw-release-v1\n` + the JCS list) and checked against a pinned key.
> - `build.mjs` builds `signin.js` and `chat-panel.js` when their sources exist (`--strict` makes a missing one an error), pins every bundled package in `build.lock.json` (directory hash plus the lockfile
>   integrity), and fails on drift. `npm-shrinkwrap.json` is the lockfile and ships in the package. `test/fuzz/` holds the seeded fuzzers (`npm run test:fuzz`), not part of `npm test`.
> - CI: `ci.yml` installs without scripts, fuzzes with the run number as the seed and builds strict; `release.yml` builds, attests and leaves a DRAFT for the owner to sign offline; `rebuild.yml` builds on three
>   operating systems and compares the file lists byte for byte.

### INTERFACES "tools and build", additions

```
// tools/ledger-admin.mjs (v0.3; the v0.2.1 exports stay)
export const SEALED_ITEM_BYTES = 1877, CFG_ENUMS, CFG_KEYS, CFG_MAX_ITEMS = 32, CFG_MAX_CHAT_BITS = 32, CFG_TURN_URLS_MAX = 8, DENY_REASONS = ['P0', 'illegal', 'malware', 'spam', 'other']
export function parseUntil(value) -> ms since 1970 (ms, or an ISO 8601 date)          parseVoid('<author>@<h>') -> { author, after }
export function banOp({ author, until? }) / unbanOp({ author }) / bulkTombstoneOp({ authors, before }) -> op        (authors sorted, unique, at most 64)
export async function recoveryCommitment(recoverPub) -> rc (b64url sha256 of utf8(recoverPub))      keyinfoOp({ recoverPub }) -> { t: 'keyinfo', rc }
export async function rotateOp({ by: 'self'|'recover', from, next, ledgerId, recover?: { privateKey, pub } }) -> rotate op (recover: rp and rsig over rotateSigningInput)
export async function checkpointBlock({ blocks, identity, heads?, now?, genesisOwner?, gen?, expectedOwner? }) -> { block, blocks, S, snap, n, bytes, heads, file }   // file: S as canonical JSON text
export function cfgFromFlags(flags) -> { set, clear }     mergeCfg(current, { set, clear }) -> the whole _mw.cfg      currentCfg(state) -> object
export async function setCfg({ set, clear, blocks, identity, now?, ... }) -> { block, blocks, cfg }               // one put of _mw.cfg
export async function denyKey(identifier) -> '_deny/' + b64url(sha256(utf8(ih or sha256)))      denyValue({ by, t, reason, ref? })
export async function denyIdentifier({ blocks, identity, id, reason, ref?, now? }) -> { block, blocks, key, value }
export function capacityMeter({ members, items, maxChainBytes, usedBytes }) -> { members, items, perItemBytes, bytes, maxChainBytes, share, fits, usedBytes, lines }   // members null: position of a file only
appendControl({ ..., value?, ensureInPast?, bits? })   // value: payload puts (cfg, deny); bits: mined for an author who is not owner or moderator

// tools/publish.mjs (v0.3)
export const LOADER_HEADER_VALUES, LOADER_PAGES;  export function loaderHeadersText()
export function orgList(list) -> origins (at most 4)   stunList(list) -> stun:/stuns: URLs (at most 4)   turnConfig(urls, mode) -> { urls, mode } | null (at most 8)   ownTrackers(tr) -> the entries that are not the shared defaults   featureProblems({ features, tr, stun }) -> [why]
export async function readNextKey(file) -> { pub, privateFile }     featuresFromLedger(file) -> { chat, files, media }
export function readPreviousPointer({ prevPointer, outDir, scope }) -> record | null          widgetTags({ name: 'signin'|'chat-panel', integrity, statement, challengeUrl, proofUrl, tracker, stun }) -> { script, element }
export function cspText({ dropin, tr, ws, xs, cs, scope, widgets = [], features = [] })   // connect-src for the site's own tracker, worker-src 'self'
publish() options: org, nextKey, nx, ml, idp, prevPointer, signinWidget, signinStatement, challengeUrl, proofUrl, chatPanel, tracker, stun, turn, turnMode, chat, files, media, cfgFrom
summary.json adds: org, nx, nextOwner, ml, idp, features, stun, turn, widgets: [{ name, path, integrity, script, element }], loaderHeaders;  outputs add loader-headers.txt, widget/_mw/*.js, widget/tags.html, shell/_headers (--shell)

// tools/verify-release.mjs
export const RELEASE_PREFIX = 'mw-release-v1\n', LIST_KIND = 'mw-release-files', SIG_ALG = 'ES256-P1363'
export function buildHashList({ dir, version?, tree = 'dist', name = 'magnet-web' }) -> list     signedText(list) -> RELEASE_PREFIX + JCS(list)     listHash(list)     checkList(list) -> [problem]     listPathProblem(path)
export async function signList(list, { privateKey, pub }) -> { v: 1, alg, key, sig }      readPublicKey(file) -> 'p256:...'
export async function verifyRelease({ dir, list, sig, publicKey, allowExtra }) -> { ok, reason: 'key'|'list'|'signature'|'files'|null, problems, checked, signer, listHash }

// tools/pin.mjs
export const PIN_LIMITS;  class PinStore({ profileDir, now });  class Mailbox({ store, quotas, now });  class FilePins({ store, seeder, limits, now });  normalizeRequest(entry, limits)
export function createPinHost({ profileDir, mailbox, files, seeder, now, limits, quotas }) -> { store, mailbox, files, call(op, arg), start(), tick(), stats(), setSeeder() }
export async function attachPinBridge(context, host, { page })   // window.__mwPinCall(op, arg), top frame only        pageSeeder(getPage, log) -> { start(meta), stop(ih) }   // asks window.__mwPinHost
export async function runPin(options)     runModeration(flags, { log })     pinStatsLine(stats)
// tools/webseed-file.mjs
export const LANE_CAPS = { public: 25 MiB, private: 100 MiB }, DEFAULT_PREFIX = 'ws-files', WEBSEED_CORS;  commonHeaders();  headersText({ prefixPath, entries });  readEntries(text, prefixPath);  wsUrl(base, prefix, sha256)
export async function webseedFile({ file, dir, base, lane, name, torrent, prefix }) -> { ws, path, sha256, bytes, headersFile, infoHash, disposition, lane, files }
// tools/init.mjs
export const DEFAULT_ANSWERS;  normalizeAnswers(raw) -> answers;  planInit(raw) -> { steps: [{ id, title, command, notes }], warnings };  renderPlan(plan) -> text;  interview(io) -> answers;  shellQuote(arg)
// tools/dev-server.mjs
export async function createIdpServer({ root = 'dist-idp', port, quiet, log }) -> { server, url, urls, port, root, headers, close() };  createDevServer({ ..., idpPort, idpRoot }) -> { ..., idp }
// build.mjs
export const WIDGET_FILES = ['_mw/signin.js', '_mw/chat-panel.js'], CHECKED_ON_FETCH, LOCK_REVIEW
export function packageOfInput(path) -> { name, dir } | null     hashPackageDir(dir) -> { sha256, files }     collectBundledPackages({ root, inputs, packageLock }) -> { packages, duplicates }
export function lockEntriesFor(found) / orderedLock(lock) / checkPackages(lock, found, { duplicates }) -> { ok, problems, warnings, message }     unresolvedLocalImports(errors, root) -> '<spec> (from <file>)' | null
build({ ..., entries, strict }) -> { ..., packages, skipped, warnings }       build.lock.json: { v, note, review, vendored, packages: { '<name>': { version, files, sha256, integrity, resolved } } }
build.json adds packages; ENTRIES adds the two optional widget entries; precacheList() leaves the widgets out; integrity covers them;  node build.mjs --strict | --check-lock (checks the vendored bundle and every bundled package, writes nothing)

// test/fuzz (not part of npm test)
run.mjs:     export async function fuzz({ seed, iterations, seconds, targets, modules, maxMs, hangMs, replay, verbose, worker, log }) -> { seed, results, violations, notes, inputs, elapsedMs, ok }
             export async function runTarget(target, { seed, from, to, deadline, maxMs, progress, maxViolations, onViolation, onCase }) -> { name, inputs, violations, notes, maxMs, slowest, totalMs, stopped }
             export function selectTargets(all, names)       CLI: npm run test:fuzz -- [--target n]... [--iterations n] [--seconds s] [--seed text] [--replay n] [--max-ms n] [--hang-ms n] [--module f]... [--list] [--json] [--verbose] [--no-worker]
targets.mjs: export async function loadTargets({ modules }) / validateTarget(t, source) / targetFiles(extra);   targets/<lane>.mjs exports TARGETS
a target:    { name, about, maxMs?, setup?({ seed }) -> state, gen(rng, state, i) -> { label, ... }, run(c, state), check(c, { result } | { error }, state, note(id, message)) -> [violation], allowedError?(err, c, state), show?(c) }
kit.mjs:     Rng, hash32, EDGE_MUST = [0, -1, 2^53-1], edgeNumber, lengthNear, Raw, stringify, spellings, numberPaths, setAt, mutateBytes, describe, ecdsaIdentity, ecdhPoints, fakePub
```
