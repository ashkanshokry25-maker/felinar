# integration-1: notes and deviations (v0.2 finishing build, 2026-10-19)

Agent: `integration-1`. Brief: make ARCHITECTURE section 12 E2E scenarios 1 to 7 work end to end and prove it;
`npm test` green; `npm run test:browser` green or skipped with a reason. Any file could be edited. Status and
resume notes: `docs/INTEGRATION-STATUS.md`.

## Result

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    npm test                     # lint:floor (54 files) + 669 unit tests, 0 failures, about 7 s
    npm run test:browser         # 28 pass, 1 skipped (the stale v0.1 sw-browser test, reason stated)
    node test/e2e/run.mjs        # scenarios 7, 1, 2, 3, 4, 5, 6: all PASS, about 6 s, network policy PASS
    node test/e2e/run.mjs --webkit   # adds W7, scenario 7 in WebKit (127.0.0.1 only): PASS

## Files

| File | Change |
|---|---|
| `test/e2e/run.mjs` | New. Plain Node + playwright. Scenarios 1 to 7, PASS/FAIL per scenario, per-step timeouts (at most 60 s), a 20 min watchdog, console/pageerror/loader-log/worker-state dump on failure, exit 1 on any failure or any non-loopback request. `--only 1,2`, `--headed`, `--keep`. |
| `test/e2e/lib.mjs` | New. Stack (build, keygen owner + moderator, open tracker, dev server, publish), the "gate" proxy, `Visitor` (one browser context each), helpers (`waitForSite`, `acceptConsent`, `siteInfo`, `guestbookEntries`, `postMessage`, `shellState`, `stopServiceWorkers`). |
| `src/sw/core.js` | First-load race fixed (`storage.retry()`, forced re-read on navigations); `withTimeout` clears its timer; `inspect().drops`. |
| `src/loader/render.js` | `requestServiceWorker()` (request/ack over a MessageChannel); timers cleared when the promises settle; unused `delay()` removed. |
| `src/loader/app.js` | `setCurrent` waits for the worker's ack; handles `mw-site-invalid`; `window.__mwShell.inspect()`; `openLedger` falls back to `MemoryBlockStore` on `E_STORAGE`; `handleCorruptCache` logs and re-arms. |
| `src/loader/config.js` | `timeoutsExtra.swAckMs: 5000` (additive key). |
| `src/loader/torrent.js` | Injected timers are bound per method (they were lost with `Object.assign` on a class instance). |
| `test/unit/sw-sdk.test.mjs` | Rewritten for the v0.2 SDK; shell mode runs against the real Bridge. |
| `test/unit/sw-core.test.mjs` | The Wave A file had helpers and no tests; 9 tests added (install/activate, owns, shell and frame headers, Range, verification failure, the two race fixes, messages, hub redirect). |
| `test/unit/loader-app-render.test.mjs` | New: render.js helpers, CSP strings, `requestServiceWorker`, ping, register/reload-once guard. |
| `test/unit/loader-app-torrent.test.mjs` | Rejections handled before the fake clock fires; keepalive test on a seeding torrent; lazily created client accepted after `stopSite`. |
| `docs/INTERFACES.md` | Additive notes under `src/loader/render.js` (request/ack handshake, `__mwShell`, worker `drops`). |
| `docs/INTEGRATION-STATUS.md` | New: living status for the next integrator. |
| `tools/run-unit.mjs` | `--browser` sets `MW_BROWSER=1` for its child, so the explicitly requested browser files run. |
| `test/unit/sw-browser.test.mjs` | Skipped with its real reason (v0.1 worker); `MW_SW_BROWSER_V01=1` runs it. |

## Deviations, with reasons

1. **Shell and worker handshake before mounting (ARCHITECTURE 5.4/7.1, additive).** The spec has `mw-set-current`
   as a fire-and-forget message followed by a ping. The worker handles messages asynchronously, so the ping's pong
   could come back before the worker had re-read IndexedDB, and on a first visit the worker's short "database does
   not exist yet" negative cache (1 s) plus the refresh throttle (2 s) made the frame's first request answer the 503
   "This site isn't ready yet" page with nothing to retry it (the tools agent's report 1, reproduced by E2E scenario 7
   on loopback every time). Now the shell sends `mw-set-current` with a port and waits for the ack (sent after a forced
   re-read that clears the negative cache), re-sending `mw-site-saved` while the ack says `complete: false`; and a
   navigation into the site forces one re-read when its entry is missing. Each of the three fixes alone hides the
   bug; all three are kept (defence in depth, each covered by a unit test that fails without it).
2. **The shell listens for `mw-site-invalid`.** ARCHITECTURE 7.3 says a mismatch deletes the site and the shell
   re-downloads; the worker broadcast the message but the shell had no listener, so a frame could stay on
   "Saved files were removed". `handleCorruptCache` now runs on it (engine tab), and re-arms after a good remount.
3. **Diagnostics handles.** `window.__mwShell.inspect()` (shell, read-only, mirrors drop-in's `window.__mwDropin`)
   and the worker's `inspect().drops`. Used by the E2E run to assert equal ledger roots, the pointer source and
   that the worker deleted a mismatching copy; also useful in support. No user-facing strings were added.
4. **`openLedger` falls back to `MemoryBlockStore` when `IdbBlockStore.open` rejects with `E_STORAGE`** (chain-net
   note). The ledger then lives for the page view only; this is logged in the diagnostics panel, not bannered,
   because DESIGN-REVIEW section 4 has no approved string for it.
5. **Scenario 3's flipped bytes stop the Service Worker first** (Chromium DevTools `ServiceWorker.stopAllWorkers`).
   Verified piece indices are memoised per worker instance by design (7.3: "Memoise verified piece indices in memory
   only"); a browser stops idle workers after about 30 s, the test does it at once. Without the stop the same worker
   keeps serving the flipped bytes until it is stopped: a known limit of the design, written down here. Two paths
   are checked: (a) in an open page, a link inside the site reaches a fresh worker, which deletes the copy and sends
   `mw-site-invalid`; the page downloads again and remounts on the requested page; (b) before a page load: in the
   example (one 256 KiB piece) the mismatch is found when the worker checks `/.mw/site.json` for the shell's
   isolation headers, so the copy is deleted before the page runs and the page simply downloads again.
6. **E2E environment, not product behaviour:** every page gets an init script that empties `RTCPeerConnection`
   `iceServers`, so the loader's STUN servers are never contacted even if a resolver rule were missing (host
   candidates connect on one machine). Every request and WebSocket of every context is checked against loopback.
7. **E2E order 7, 1, 2, 3, 4, 5, 6.** The cold start (7) needs a swarm nobody has joined, so it runs first. Results
   print per scenario number. Scenario 1 refuses the web seed's file bytes at the gate (the `.torrent` and
   `genesis.json` stay reachable) so the copy demonstrably comes from the seeder (`source === 'peers'`); scenario 3
   does the same for "downloads from the second alone" (A and the seeder closed, only B online).
8. **Consent in scenarios 6 and 7 stays pending.** 7: the web seed alone must render within 3 s. 6 (unsigned
   pointer): an unsigned pointer adds the public default trackers, which this run must never try to reach.
9. **Scenario 2 adds a follower-tab post** (a second tab of visitor A posts through A's engine tab, 5.9), and
   `--webkit` adds W7 (scenario 7 in WebKit). Both go beyond the section 12 text; W7 is opt-in because section 12
   does not mark scenario 7 for WebKit.
10. **A follower tab does not download a corrupt copy again itself**: it waits for the engine tab's `site`
    broadcast and remounts from the new stored copy (one engine per origin, 5.9).
11. **A remount keeps the visitor's page.** `renderSite` mounts the new frame at `mount.currentPath()` instead of
    the path the page was loaded with, so a re-download (or a version switch) does not throw the visitor back
    to the first page they opened. Checked by scenario 3 (a).

## Known gaps and notes for the next integrator

- `test/unit/sw-browser.test.mjs` (gated by `MW_BROWSER=1`) targets the v0.1 worker (mw-shell naming, `/_mw/s/`
  default, export-free SDK form): 12 of 14 fail when forced. It is skipped by default; the E2E run exercises the
  v0.2 worker in Chromium. Rewrite or delete it in the review phase. `chain-core-browser.test.mjs` passes when
  forced (Chromium and WebKit; Firefox is not installed here).
- Scenarios 8 to 14 of section 12 are not in `run.mjs`; `test/e2e/lib.mjs` has what they need (gate, visitors,
  `dev.killSwitch()`, `stopServiceWorkers`). Drop-in (10) can reuse `examples/existing-site-dropin/.fixture/host.mjs`
  and `EXPECTED.md`.
- dropin's note stands: the worker's 60 s web-seed blob cache (`wsBlobs`) is keyed by URL, not by version.
- The `--headed` flag is for local debugging only; CI should run headless.
