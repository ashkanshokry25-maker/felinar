# Deviations and notes: Firefox lane (v0.3 finish run)

Lane: Firefox ([review/V03-DESIGN-REVIEW.md](../review/V03-DESIGN-REVIEW.md), section 5.3). Goal: Playwright Firefox as a
first-class harness browser, with the local-only policy of [DEV-NETWORK.md](../DEV-NETWORK.md) kept absolute. Written
2026-10-22 between 15:41 and 16:56 ET. The browser is Playwright's Firefox build `firefox-1555`, which reports
`Firefox 157.0` from `browser.version()` (every Firefox result below names it). Headless, on loopback only.

## Files

| File | What changed |
|---|---|
| `test/e2e/browser-args.mjs` | `localOnlyProxy()` (line 43): `{ server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost,*.localhost' }`; `MW_LOCAL_PROXY` may swap the closed port for a local recorder (only an `http://127.0.0.1:<port>` value is taken). `firefoxUserPrefs()` (line 52): one comment per pref. `firefoxLaunchOptions()` (line 124): headless, the proxy, the prefs and a throwaway home |
| `test/e2e/lib.mjs` | `launchWebkit` (line 277) launches with `proxy: localOnlyProxy()` (line 282); `launchFirefox` (line 292) mirrors it; `withEngine('firefox', fn)` (line 321) makes `launchWebkit()` start Firefox for the F-* variants; the camera and microphone permissions, which Playwright's Firefox does not know, are dropped from `newContext` because the prefs grant them (line 289) |
| `test/e2e/scenarios-firefox.mjs` (new) | the Firefox scenarios: F-* (the five `--webkit` scenarios run unchanged inside `withEngine('firefox')`) and F:<id> (a Chromium scenario run against a second scenario context whose browser is Firefox). `FIREFOX_HELD` (line 25), `FIREFOX_CONTEXT_SOURCES` (line 33), `MW_E2E_FIREFOX_TRY` (line 40); the Firefox browser and its visitors close after the last F:<id> of the run (`fctx.close`, line 89; `closeAfterLast`, line 104) |
| `test/e2e/run.mjs` | the `--firefox` flag (header comment, lines 8 to 13); the import (line 85); the watchdog is 10 minutes longer with `--firefox` (line 106); registration after every other group, with `selected` so the Firefox block knows where it ends (line 1874); the order line (line 1894) |
| `package.json` | `"test:e2e:firefox": "node test/e2e/run.mjs --firefox"` (scripts block only) |
| `docs/DEV-NETWORK.md` | the policy for all three browsers, how it was checked, and a firewall line for Playwright's Firefox |
| `docs/DEMO-RESULTS.md` | the desktop Firefox rows G6, G7, G-ID-4 and G-MD-1: harness facts in Date, Versions and Measured; Result stays "not yet run" |
| `.github/workflows/ci.yml` | `firefox` on the Playwright install line (and the step name), and an "End-to-end, Firefox cold start (F7)" step beside the WebKit W7 step |

## Deviations from the brief

1. The scenarios live in a new file, `test/e2e/scenarios-firefox.mjs`, not in `run.mjs`. `run.mjs` keeps only the flag,
   the import, the registration and the order line, like every other scenario group. The F-* variants reuse the WebKit
   scenarios through `withEngine` instead of copying them, so a fix to a W scenario reaches its F twin.
2. `E-CL-1F` is registered but held out of `--firefox` (`FIREFOX_HELD`); `--only E-CL-1F` still runs it. Reason under
   "Defects found" (a harness defect in a file this lane may not edit).
3. The watchdog of `run.mjs` (20 minutes) stopped the first full `--firefox` run at 1200 s, during the chat rows that run
   after the Firefox scenarios. The Firefox scenarios took 130 s of that run (F7 started at 593.5 s, the last F:<id>
   passed at 725.8 s). With `--firefox` the watchdog is now 30 minutes; `MW_E2E_TOTAL_MS` still overrides it.
4. `release.yml` does not run Firefox, so its install line was not changed (installing a browser no step uses costs CI
   time). Only `ci.yml` was changed.
5. CI runs `--firefox --only F7`, as CI runs `--webkit --only W7`. The full Firefox lane is `npm run test:e2e:firefox`.

## Network check (before the first full run)

Every check ran on this machine with the outbound firewall on; no remote connection was attempted.

| Check | How | Result |
|---|---|---|
| one small scenario | `MW_LOCAL_PROXY=http://127.0.0.1:47920 node test/e2e/run.mjs --only F7`, with a recording proxy on that port | PASS F7; the recorder saw 0 requests; the run's guard printed "PASS network policy: every request stayed on 127.0.0.1" |
| background services | `launchFirefox()`, one loopback page, 30 s idle, under the recorder | 0 requests in 30 s |
| positive control | the same browser opens `http://control.invalid/probe` | the recorder saw exactly that one request (`GET http://control.invalid/probe`), so the recorder works and a non-loopback request goes to the loopback proxy, not to DNS |
| sockets | `lsof -nP -a -c firefox -i` twice a second through every run in this note (11,433 socket lines recorded in the first full run) | no endpoint other than 127.0.0.1 |

## Results

| Run | Command | Result |
|---|---|---|
| Firefox scenarios only | `node test/e2e/run.mjs --only <the 31 ids of --firefox>` | OK: 31 passed, 0 failed, 154.4 s; PASS network policy |
| full, three engines | `npm run test:e2e:firefox -- --webkit` | see "Final run" below |
| E-MD-6 again | `node test/e2e/run.mjs --only F:E-CH-1,F:DOOR-GUEST,E-MD-6` | OK: 3 passed, 0 failed, 194.6 s |
| social rows without Firefox | `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-HD-1,E-SO-3` | 3 passed, E-SO-3 failed (see "Defects found") |

What passes in Firefox 157.0 (31 scenarios): F7, F-SI, F-MD, DOOR-GUEST-F; F:E-SI-1 to F:E-SI-5, F:E-CH-6M, F:E-MD-10,
F:E-MD-8, F:E-FI-3, F:E-SI-1W, F:E-SI-5W, F:E-CH-R, F:E-ID-5, F:E-ID-6, F:E-ID-10, F:E-ID-7, F:E-CH-1, F:E-CH-8, F:E-CH-6,
F:E-FI-1, F:E-FI-2, F:E-MD-4, F:E-MD-3, F:E-MD-5, F:DOOR-DOWN, F:DOOR-HASH, F:DOOR-GUEST. Measured in the Firefox-only run:
F7 rendered in 719 ms with the Service Worker in control; F-MD first frame 40 ms, seeks to 8.5 s, 3 s and 6 s in 25, 92
and 96 ms, answered 206 by the worker route.

## Final run

`npm run test:e2e:firefox -- --webkit` (Chromium, WebKit with the loopback proxy, and Firefox in one run, 16:33 to 16:51
ET): 138 scenarios, 132 passed, 6 failed, 1093.4 s, "PASS network policy: every request stayed on 127.0.0.1"; the
socket sampler saw no endpoint other than 127.0.0.1.

- Firefox: all 31 passed. WebKit: all 5 passed (W7, W-SI, W-MD, DOOR-GUEST-W, E-CL-1W), so the proxy on WebKit's
  launch changed nothing. Scenario 13 passed (it failed in the run before the fix described under "Defects found").
- E-SO-3, E-SO-4, E-SO-7, E-SO-8, E-SO-9: the social rows defect under "Defects found", reproduced without Firefox.
- E-MD-6 ("RA reaches RF: not reached within 30000 ms"): passed in the earlier three-engine run and in the rerun above,
  after two Firefox scenarios. A timing failure while other runs shared the machine, not a Firefox effect.
- A separate plain `npm run test:e2e` was not run: every one of its scenarios is part of this run.

## Scenarios that do not run in Firefox

| Scenario | Why | Kind |
|---|---|---|
| E-CL-1F | the hang-up step reads `pc.remoteDescription` of a closed connection (`test/e2e/scenarios-calls.mjs:394`); Firefox throws "Peer connection is closed" there, while the Chromium and WebKit runs pass this step. Every step before it passed in Firefox: connected 3.9 s after the accept, audio and video both ways, certificate equal to the sealed answer, a screen shared, mute and camera off | harness defect (below) |
| F:E-ID-2, F:E-ID-2B, F:E-ID-4, F:E-SO-1 (and F:E-SO-2, F:E-SO-11, which need E-SO-1) | `pressCard` clicks with a 3000 ms timeout (`test/e2e/idp-driver.mjs:56`); in Firefox the passphrase card's "Continue" takes 3.7 to 4.1 s to become clickable. With a 30 s timeout (a copy of the driver loaded through a module hook, nothing in the tree changed) F:E-ID-2 passed in Firefox | harness defect (below) |
| F:E-MD-1 | "no poster: plen 0" (`test/e2e/scenarios-v03.mjs:456`): the upload, the ciphertext chunks and the sealed own-index item pass, but no poster is made in Firefox 157.0. Root cause not established; the poster code is `videoPoster` in `src/media/poster.js:110` | possible product gap, open |
| F:E-MD-2 | the seeks play, but the scenario asserts that the worker read a chunk for every seek (`test/e2e/scenarios-v03.mjs:486`); Firefox answers the seek to 6 s from its own media buffer. F-MD covers playback with seeks through the worker route in Firefox | Chromium-specific assertion |
| F:E-MD-9 | needs the media E-MD-2 opened ("E-MD-2 did not open the media") | depends on F:E-MD-2 |
| F:E-MD-7, F:E-ID-1 | the Chrome DevTools protocol (`newCDPSession`, `test/e2e/scenarios-v03.mjs:540`; the virtual authenticator, `test/e2e/scenarios-identity.mjs:130`) | Chromium only |
| E-CL-3, E-CL-1, E-CL-2, E-PS-*, E-ZS-1 | they launch a Chromium of their own (`test/e2e/scenarios-calls.mjs:179`, `test/e2e/scenarios-c2.mjs:540`), so a Firefox context does not reach them; E-CL-1F is the Firefox call test | not applicable |
| identity, chat, media and social rows (E-ID-3 to E-ID-15, E-CH-2 to E-CH-12, E-FI-5, E-FI-6, E-MD-3B, E-MD-5R, E-MD-6, E-SO-3 to E-SO-9), a11y | registered after the Firefox wrapper and marked Chromium only by their lanes; not tried | open |
| scenarios 1 to 14, serving, peer, format, E-HD-1 | outside this brief (identity sign-in, chat, media, doors); not tried | open |

`MW_E2E_FIREFOX_TRY=<ids>` adds F:<id> for any registered scenario, which is how each row above was tried.

## Defects found

In this lane's own code, fixed: the first three-engine run failed scenario 13 ("the tracker received announces for the
old version after the reload: 5"). The Firefox visitors stayed open until the end of the run and kept announcing the
guestbook on the run's tracker, and scenario 13 counts every announce of the old version (`test/e2e/run.mjs`, the
`tracked` check of `SCENARIOS[13]`). The Firefox browser now closes after the last F:<id>. Check:
`node test/e2e/run.mjs --only F:E-ID-5,F:E-ID-10,F:E-CH-1,13` passed (4 of 4, 59.0 s).

Seen in the same run and not caused by Firefox: E-SO-3, E-SO-4, E-SO-7, E-SO-8 and E-SO-9 (the social rows lane) fail with
"Target page, context or browser has been closed". They reuse the pages E-SO-1 and E-SO-2 left in `ctx.shared`
(`test/e2e/scenarios-social-rows.mjs:47` to 51), and E-HD-1, which runs between them, calls `ctx.closeAll()`
(`test/e2e/scenarios-hardening.mjs:58`). Without any Firefox or WebKit scenario,
`node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-HD-1,E-SO-3` gives PASS, PASS, PASS, FAIL. This belongs to the social rows
lane and the integrator (row below).

For the integrator:

| file | line | scenario | fix | test |
|---|---|---|---|---|
| test/e2e/scenarios-calls.mjs | 394 | E-CL-1F hang-up step: `callPcs` reads `pc.remoteDescription` and `pc.localDescription` after `close()`; Firefox 157.0 throws "Peer connection is closed" | wrap the description reads (lines 394 to 399) in the same `try { } catch (_) { /* closed */ }` as `getStats` | `node test/e2e/run.mjs --only E-CL-1F`, then remove `E-CL-1F` from `FIREFOX_HELD` in `test/e2e/scenarios-firefox.mjs` |
| test/e2e/idp-driver.mjs | 56 | F:E-ID-2, F:E-ID-2B, F:E-ID-4, F:E-SO-1: `button.click({ timeout: 3000 })` times out in Firefox, where "Continue" on the passphrase card takes 3.7 to 4.1 s | raise the timeout to 15000 ms | `MW_E2E_FIREFOX_TRY=E-ID-2,E-ID-2B,E-ID-4,E-SO-1,E-SO-2,E-SO-11 node test/e2e/run.mjs --only F:E-ID-2,F:E-ID-2B,F:E-ID-4,F:E-SO-1,F:E-SO-2,F:E-SO-11`, then add the ids that pass to `FIREFOX_CONTEXT_SOURCES` |
| src/media/poster.js | 110 | F:E-MD-1: no poster for the reference MP4 in Firefox 157.0 (`plen 0`), no console error | find why `videoPoster` returns nothing in Firefox (cause not established by this lane) | `MW_E2E_FIREFOX_TRY=E-MD-1 node test/e2e/run.mjs --only F:E-MD-1` |
| test/e2e/scenarios-social-rows.mjs | 47 | E-SO-3, E-SO-4, E-SO-7, E-SO-8 and E-SO-9 after E-HD-1: `adaBo` reuses `ctx.shared.ada` and `ctx.shared.bo`, whose pages E-HD-1's `ctx.closeAll()` (test/e2e/scenarios-hardening.mjs:58) closed | in `adaBo`, run E-SO-1 and E-SO-2 again when `ctx.shared.ada.page` or `ctx.shared.bo.page` is closed (`page.isClosed()`), or order the social rows before E-HD-1 | `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-HD-1,E-SO-3` |

## Requests

- docs/DEMO-RESULTS.md says above the v0.3 table: "Firefox cells stay "not run", never "pass", until Firefox launches in
  the automated harness." Firefox now launches in the harness. The sentence is outside the Firefox rows, so this lane
  left it; the integrator may change it to say the harness runs Firefox on loopback and that a real-device row still
  never passes from the harness.
- docs/INTEGRATION-STATUS.md and docs/deviations/integration-v03.md (line 397) say Firefox is not launchable in the
  harness. That is no longer true.
