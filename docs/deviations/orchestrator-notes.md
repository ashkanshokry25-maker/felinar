# Orchestrator notes for the finishing build (2026-10-18)

Facts observed on this machine before the finishing build started. Read them before running tests.

1. `node --test <directory>` fails on Node 24.22 here; always use the glob `'test/unit/*.test.mjs'`
   (quote it) or explicit file lists. Exclude `*-browser.test.mjs` from the default `npm test`; they
   launch Playwright and belong in `npm run test:browser`.
2. Two Wave A test files never exit after their tests pass: `test/unit/loader-app-torrent.test.mjs`
   and `test/unit/sw-sdk.test.mjs`. Cause: open handles (intervals such as the 90 s scrape keepalive /
   30 s HELLO tick, or fake servers/ports) created during tests and not cleared in `after()` hooks.
   Fix the leak (clear/unref timers in `destroy()`, close fake servers), do not just add `--test-force-exit`.
3. Two tests in `test/unit/loader-app-torrent.test.mjs` fail: "keepalive scrapes every 90 s; a tracker
   that closes on scrape gets a zero-offer announce" and "pause destroys the client; resume and rebuild
   re-add the torrents; stopSite stops the seed". Decide against ARCHITECTURE §8 (pause semantics:
   choke lock + destroy/rebuild per lifecycle table) whether the code or the test is wrong.
4. Every other Wave A unit test passed in the last partial run (197 passed, 0 other failures).
5. Browser launches: `test/e2e/browser-args.mjs` is mandatory (`docs/DEV-NETWORK.md`). The three
   `*-browser.test.mjs` files and `examples/peer-guestbook/.dev/browser.test.mjs` were already patched to use it.
6. `gh` is not authenticated on this machine; do not try to push or create releases.
