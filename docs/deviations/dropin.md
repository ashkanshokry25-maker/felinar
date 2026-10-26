# dropin agent: notes and deviations (src/dropin/*, examples/existing-site-dropin/**, test/unit/dropin*.test.mjs)

Agent: `dropin`. Date: 2026-10-19. Owned paths: `src/dropin/*`, `examples/existing-site-dropin/**`,
`test/unit/dropin*.test.mjs` (nothing existed before). Brief: ARCHITECTURE section 3.4 (3.4.1 to 3.4.9),
INTERFACES "src/dropin/mw.js", DESIGN-REVIEW item 23 and section 5. Two files I do not own were changed in place
(deviations 1 and 2).

## Files

| File | What it is |
|---|---|
| `src/dropin/mw.js` | The entry of `/_mw/mw.js`: lazy module loaders (`createDeps`), `start()`, binds `window.mw` (through the SDK facade's setter when `/_mw/sdk.js` ran first), `window.__mwDropin = { version, engine, started, inspect(), openSettings() }`, never throws into the page |
| `src/dropin/engine.js` | `DropinEngine`: stamp evaluation, key-change prompt, Service Worker setup, idle start, visible timer, consent gate, leader election, ledger, copy lookup / web-seed download / save, version pruning, seeding, bfcache lifecycle, settings, `inspect()`, deduplicated diagnostics log |
| `src/dropin/stamp.js` | Reads `<meta name="mw-pointer">`, finds the module's own `<script>` tag and its `data-mw-*` options, `evaluateStamp()` (pointer.js verification + scope = `location.hostname` + TOFU pin + `seq` rollback) returning one verdict |
| `src/dropin/swreg.js` | `getRegistration('/')` inspection, `decideRegistration`, the foreign-worker recipe line, `setupServiceWorker()` (modes `ours`, `integrated`, `foreign`, `off`, `uncontrolled`, `none`), ping / `mw-map-client` / `mw-site-saved` / `mw-get-clients`, pushed `mw-site-invalid`, `mw-reload`, `looksLikeKillSwitch` |
| `src/dropin/schedule.js` | `onWindowLoad`, `runWhenIdle` (requestIdleCallback with a 200 ms timer fallback), the 3 s cumulative visible timer |
| `src/dropin/leader.js` | `Leadership` (Web Locks `mw-swarm-<ledgerId>`), `TabLink` (BroadcastChannel `mw-<ledgerId>` call / result), `RemoteNode` (a follower tab's view of the leader's ledger) |
| `src/dropin/ledger.js` | Opening and following the site ledger from the engine: `openLedger`, `followLedger`, snapshot fetch (`cs=`), change fan-out to followers |
| `src/dropin/binding.js` | `window.mw` bound directly to a `MwApi` (the Bridge method table in `src/loader/api.js` is reused, not copied): frozen surface, SDK-identical client-side validation and error codes, throttled `db.subscribe` snapshots, net events |
| `src/dropin/panel.js` | Notice, gate, key-change prompt, messages and settings in a closed shadow root, styled only through CSSOM (no `<style>`, no `style` attribute, so a strict CSP is fine); strings from `src/loader/strings.js`; `rectOf(label)` for tests |
| `src/dropin/rules.js` | Pure decisions: web-seed allowed or not (`webseedDecision`), the record handed to the TorrentManager (`dropinRecord`), announce gate, which prompt to show, version retention (`planVersions`), missing-feature check |
| `src/dropin/identity.js` | Writer identity (create, wrap, export, import) in the same `mw-identity` v1 format as the shell (`src/loader/app.js`) |
| `src/dropin/refresh.js` | Replaces stale HTTP-cache entries of changed files before a new version's web-seed download |
| `src/dropin/polyfills.js` | Guarded `Uint8Array` hex / base64 and `AbortSignal.timeout` polyfills with a self-test (the webtorrent bundle needs them; drop-in does not run `boot.js`) |
| `test/unit/dropin-*.test.mjs` (15 files) | 186 tests, no browser, no network: fakes for DOM, timers, Service Worker container, Web Locks, BroadcastChannel, Cache, TorrentManager, ChainNode; real torrents (bencode + SHA-1), real signed pointers and ECDSA keys |
| `test/unit/dropin-{fakes,fake-dom,fake-timers}.mjs` | The shared fakes (not tests: `run-unit` only takes `*.test.mjs`) |
| `examples/existing-site-dropin/` | The multi-page site, `with-own-sw/`, `with-own-sw-integrated/`, `_redirects`, `_headers`, `README.md` (what each file proves), `EXPECTED.md` (the end-to-end assertions), `.fixture/stage.mjs` and `.fixture/host.mjs` (staging helper and a loopback static host that honours `_redirects` / `_headers` / 404 / Range, keeps a request log, can go down and redeploy) |

Per test file: binding 13, engine-tabs 13, engine 34, fixture 16, identity 6, leader 14, mw 10, panel 15, polyfills 7,
refresh 8, rules 7, schedule 9, stamp 11, sw-arraybuffer 3, swreg 20.

## Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test --test-timeout=180000 test/unit/dropin-*.test.mjs       # 186 pass, 0 fail, about 5 s
    node tools/lint-floor.mjs                                            # 54 files, clean
    # the whole non-browser suite without the two files that never exit (not mine, see below):
    files=(${(f)"$(node tools/run-unit.mjs --list | grep -v sw-sdk.test.mjs | grep -v loader-app-torrent.test.mjs)"})
    node --test --test-timeout=180000 "${files[@]}"                     # 595 pass, 0 fail (three runs in a row)

Every dropin test file exits on its own (engines are `destroy()`ed, no open handles). I ran all 15 files five times
at once (75 node processes) to shake out timing assumptions; the one flake that showed up (deviation 12) is fixed.
The fixture test (`dropin-fixture`) also runs the whole chain stage, `publish --dropin`, stamped pages,
`src/dropin/stamp.js` in process.

Two files outside my paths still fail, as they did before I started: `test/unit/sw-sdk.test.mjs` (9 of 9; the SDK
test expects a 250-line classic script, the file is 624 lines, and the window fake never sees the default
instance's accessor) and `test/unit/loader-app-torrent.test.mjs` (2 tests wait 60 s for a swarm that the fake
never provides). Neither exits by itself without `--test-force-exit`; `npm test` runs both through `run-unit`.

## Browser checks (ad hoc, not committed)

Playwright Chromium 156.0.8078.4 launched with `chromiumArgs()` and Playwright WebKit 27.2 against
`http://127.0.0.1` only, with a local tracker and `.fixture/host.mjs`. The scripts live in the session scratchpad,
not in the repository; `EXPECTED.md` lists every assertion so `test/e2e` can implement them. Observed: first view
completes the copy through the web seed and our worker; second view is served from IndexedDB (the host sees the
page and `/mw-sw.js` only); consent and announce gating against the tracker (0 torrents before consent and 3 s
visible, 2 after); a second context completes the copy from the first (`source: 'peers'`, metered network, no
web seed); JavaScript off is byte-identical to the host; History-API router, deep links, back / forward;
foreign worker untouched with one console line; integrated foreign worker gets the web seed; `data-mw-sw="off"`
(unit-tested only); redeploy with a leader and a follower tab and old-version pruning; offline reload of visited
pages (unvisited URLs get the worker's 503 page); the closed-shadow-root notice clicked with a real mouse through
`panel.rectOf()`; kill switch deployed over `/mw-sw.js` for a returning and for a brand-new visitor (one reload,
then stable). Not testable in headless Chromium: the back/forward cache (it disables it); `pagehide` / `pageshow` is
covered by unit tests and listed as a manual release-gate check.

## Deviations, with reasons

1. **`src/loader/api.js` (not mine): `ready()` reads the site info after the ledger wait.** In drop-in the
   engine resolves the pointer and opens the ledger after the page has rendered, so a site calling
   `mw.ready()` early got `siteId` and `btih` as `null`. `case 'ready'` now does `await this.waitForNode()` first
   and then `this.infoNow()`. Shell mode is unaffected (the info is already complete there). Covered by
   `dropin-engine` ("window.mw behaviour before the engine is ready") and `dropin-binding`.
2. **`src/sw/core.js` (not mine): stored `ArrayBuffer`s are wrapped in a `Blob` on the way out (`asBlobValue`).**
   Where Blob storage in IndexedDB is unavailable (WebKit private browsing, Playwright's default WebKit context)
   `src/loader/cache.js` stores each file as an `ArrayBuffer`; the worker only knew Blobs, so `blob.size` failed,
   the site counted as unusable and every second view went back to the host. Found by the WebKit run; regression
   test `dropin-sw-arraybuffer` (fails without the fix, passes with it). `sw-core` and `sw-lib` tests still pass.
3. **Leader election and identity are ported, not imported from `src/loader/app.js`.** `app.js` interleaves them
   with shell logic (boot UI, Bridge). `leader.js` and `identity.js` re-implement the same behaviour with the same
   lock / channel naming and the same `mw-identity` v1 format (AES-GCM + PBKDF2, key name `identity:<ledgerId>`);
   `dropin-identity` cross-checks an export made by one with the other's import. If `app.js` is ever split, both
   should move to `src/common/`.
4. **No DNS TXT / DoH update channel in drop-in.** ARCHITECTURE section 4 lists DNS as the update channel for
   pointers; in drop-in the host serves a freshly stamped page on every navigation, so the meta is always current
   and the extra network path would only add a reason to fail. Pointers cached for rollback protection (`seq`) are
   still honoured.
5. **No reuse of the previous version's files from IndexedDB (3.4.5).** The TorrentManager interface has no
   "prefill from stored file" hook and `src/loader/torrent.js` is not mine. Instead `refresh.js` replaces only the
   changed files in the HTTP cache (`cache: 'reload'`, from `/.mw/files.json`) and the worker's web-seed rewrite
   reads everything else with `cache: 'force-cache'`; hashed assets stay in the HTTP cache across deploys, so the
   result is the same for the common case. Peers fill the rest.
6. **First-time banner is an extra line in the notice.** "First time on this device" (section 4) needs a place in
   drop-in; it is a line of the consent notice (and of the gate) when `evaluateStamp()` reports `firstTime`.
7. **`data-mw-consent="site"` on the script tag.** Additive. DESIGN-REVIEW item 23 lets a site render its own
   notice and call `mw.consent.accept()`; the tag attribute tells the engine not to show ours, so there is no
   flash of two notices.
8. **Framed pages skip the engine quietly.** `window.top !== window` sets the engine off with reason `framed` and
   no message (shell mode shows "Open this page directly"; a drop-in page already works from the host).
9. **`window.__mwDropin` handle and `panel.rectOf(label)`.** Diagnostics for tests and for a site that wants a
   "peer-to-peer settings" link (`openSettings()`). `rectOf` exists because the shadow root is closed and a test
   has to click inside it with the mouse.
10. **`polyfills.js` duplicates the `boot.js` polyfills as an ES module.** Drop-in does not run `boot.js` (a
    classic script with no imports), and the vendored webtorrent bundle needs `Uint8Array.prototype.toHex` etc.
    `lint-floor` is told the self-test lines are guarded (`// lint-floor-ignore`). A build step could inline one
    source into both.
11. **Kill-switch guard (found in a browser run, not in the brief).** Deploying `dist/mw-sw-kill.js` as
    `/mw-sw.js` made every page that still carries the `/_mw/mw.js` tag register it again on each view; the
    kill switch unregisters itself and reloads the page, so visitors were stuck in a reload loop. Now: the
    engine stores the pref `sw:registered` before its first registration (and when it finds a registration of
    ours), and when that pref exists but no registration does, it fetches `/mw-sw.js` with `cache: 'no-cache'`
    and does not register it if `looksLikeKillSwitch()` (script unregisters itself, has no `fetch` listener,
    under 20 kB). One `console.warn` tells the owner to remove the tag. A visitor who never had ours registers
    the kill switch once and is reloaded once. Cost: one extra `GET /mw-sw.js` per page view on sites in that
    state. The worker's `mw-reload` message (sent when `WindowClient.navigate` is missing) now reloads the page
    once. Unit-tested in `dropin-swreg` and `dropin-engine`; checked in Chromium for both visitor types.
12. **`binding.js`: a push with no ledger node yet no longer uses up the leading edge of the 250 ms throttle.**
    Found because a follower-tab test failed about one run in three: the follower pushed once while its
    `RemoteNode` had no snapshot, which consumed the interval, so the first real snapshot waited 250 ms (no
    visible bug with real timers, a hang with the tests' fake clock). Test `dropin-binding` covers it; the tabs
    test also moves the follower's fake clock while it waits.
13. **`obtainCopy({ force: true })` chains after a running download.** A corrupt-cache message or a
    `mw-site-invalid` push during a download used to be ignored; now the re-fetch runs after it.
14. **The diagnostics log counts repeated lines ("x5") and is capped at 300.** The webtorrent client logs one
    "Piece 0 failed verification" per attempt; during a redeploy that was hundreds of identical lines.

15. **The foreign-worker recipe is logged after the verdict, and not at all for an integrated worker.**
    ARCHITECTURE 3.4.4 says one console line with the recipe whenever a site has its own worker. A site whose
    worker already imports `/_mw/sw-core.js` (it answers `mw-ping`, mode `integrated`) would be told to do what it
    has done, so the line now waits for the ping verdict (at most 4.5 s after the page loads) and is skipped
    in that case. A hand-written worker still gets exactly one line per page load.

## Known limits (all documented in README / EXPECTED.md or the code)

- **A follower tab on another version gets no copy until promoted.** With the v1 tab open it leads; the v2 tab is
  a follower, works from the host, and downloads v2 only when it is promoted (the v1 tab closes).
- **Integrated foreign worker (site worker + `importScripts('/_mw/sw-core.js')`):** the first view classifies as
  `integrated` and the web seed works through it, but a site worker never sees the navigation response, so the
  page's earliest subresources (requested before `mw-map-client` arrives) still come from the host. `earlyMap()`
  posts the mapping from the stamp as soon as the script runs; later requests (lazy chunks, `fetch` after load)
  come from IndexedDB.
- **The worker's 60 s in-memory web-seed blob cache (`wsBlobs` in `src/sw/core.js`, not mine) is not versioned.**
  A new version downloaded within 60 s of the old one, by the same worker instance, can receive the old bytes for
  a path whose content changed; pieces fail verification and the download retries until the entry expires. Real
  traffic rarely hits it (idle workers are stopped after about 30 s, which empties the cache), `refresh.js` and the
  log deduplication keep it quiet, and a version-keyed or shorter TTL would remove it.
- **WebKit private browsing:** `src/loader/cache.js` probes Blob storage and the probe surfaces one window error
  in Playwright's WebKit; the copy still works (deviation 2).
- **No identity / moderator-key screens in the drop-in panel.** The panel offers sharing settings only; identity
  import / export are reachable through `window.mw.identity.*` for sites that build their own screen.
- **Back / forward cache:** unit-tested only (headless Chromium disables it).
- **Size:** the built `_mw/mw.js` is 265 KB (86 KB gzip) because the engine, ledger, crypto and TorrentManager are
  one bundle; webtorrent (223 KB) loads on demand. Splitting the engine into its own lazily imported chunk
  (esbuild `splitting`) would let the entry stay small; that is a `build.mjs` change.

## Notes for the integrator

- `run-unit` picks up `dropin*.test.mjs` automatically; no script or `package.json` change is needed.
- `test/e2e` can reuse `examples/existing-site-dropin/.fixture/{stage,host}.mjs`; `EXPECTED.md` is the checklist
  (it also records the numbers observed by hand). Diagnostics: `await page.evaluate(() => window.__mwDropin.inspect())`.
- Prefs written by the drop-in engine in the loader cache: `consent:<ledgerId>`, `uploads`, `hostOnly`,
  `shareOnNetwork:<origin>`, `versions:<ledgerId>`, `keyRefused:<scope>:<owner>`, `sw:registered`; plus the owner
  pin (`savePin`), the saved sites and the identity keys the shell already uses.
- Network policy: nothing in `src/dropin` or the fixture contacts a non-local address on its own; the fixture host
  binds `127.0.0.1` only, and no test launches a browser.
