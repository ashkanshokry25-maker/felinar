# serving-publishing (hardening v0.2 -> v0.2.1)

Agent: serving-publishing. Brief: DIGEST-AMENDMENTS B3, B4 (tools side), D1, D2, D4, E1, E2, E3, E4, F7,
A3 (tool side), F4. Owned: src/sw/*, build.mjs, tools/{publish,check-webseed,check-site,dev-server}.mjs,
tools/lib.mjs, src/dropin/* (D4 rules), their tests, e2e scenarios named sw-* and publish-*.

## Progress log (newest last; the session can be cut off, so this is written as work lands)

- 12:40 ET baseline: `node build.mjs` OK; owned unit files (sw-core, sw-lib, tools-build, tools-check,
  tools-publish, tools-dev-server, tools-lib, dropin-rules, dropin-swreg, dropin-engine, dropin-panel,
  dropin-mw): 212 pass, 0 fail.
- ~12:45 ET B3 done in build.mjs (WEBTORRENT_PATCHES, applyVendorPatches, checkPatchedLock; lock pins
  patched.sha256; build.json vendored.webtorrent.min.js gets patched:true, patchedSha256, patches).
  Test changed with the amendment: tools-build "the vendored bundle is copied byte for byte" now asserts
  dist gets the PATCHED bytes (B3 replaces the byte-for-byte copy).
- ~12:55 ET B4 tools side: tools/check-webseed.mjs rewritten as the three-mode gate (seed / origin / host);
  check-site uses seed mode for ws= and host mode for drop-in host files; publish gains --verify-host
  (drop-in) and --allow-no-preflight. Tests changed with the amendment (tools-check): the result list
  now includes piece checks; Allow-Headers "range" passes (PASS-needs-patched-client) because the patched
  client sends only Range; a missing Access-Control-Expose-Headers is a warning (WebTorrent never reads
  Content-Range).
- A3 tool side: the formats agent wrote tools/withdraw.mjs and wired `publish --withdraw` (flags withdraw,
  why, ct merged into the publish CLI) on top of pointer.js withdrawalRecord(); serving-publishing does not
  duplicate it and only documents it (ARCHITECTURE §10, INTERFACES). publish() also reads --ct (and gains
  --lg, --aud) for the active pointer, so F4's open-ledger warning can be satisfied.
- ~13:10 ET E1-E4, F4 in publish: new module tools/publish-policy.mjs (lintPaths, dotPathReason,
  budgetReport, lintSecrets, importWxr) wired into tools/publish.mjs (--include-dot, --allow-secret,
  --max-files, --from-wxr/--wxr-dir, --date, --double-pack, --ct/--lg/--aud); buildTorrent takes
  creationDate; resolveCreationDate (--date, SOURCE_DATE_EPOCH, git commit time). New test file
  test/unit/tools-publish-v021.test.mjs (16 tests). Tests changed with an amendment:
  tools-publish "--dropin --inject-script" (the injected tag now has data-cfasync="false" before src,
  D4) and "dns.txt" (7 instead of 8 long trackers: the formats agent's MW-PTR/1 900-byte MUST, A3).
  Full unit run at ~13:10: 747 tests, 746 pass, 1 fail (dns.txt, fixed right after).
- Decisions: Windows-reserved characters (: * " < > |) only warn (they do not break URLs; MD M02 lists
  them as errors); /ws/ is refused in both modes as the amendment says; /.mw/ in a site directory is now
  an error (it was a note); a site above the desktop cap fails in shell mode (nobody could load it) and
  warns in drop-in (the host still serves it). The range preflight is required by default
  (--allow-no-preflight accepts GitHub Pages style hosts with a PASS-no-preflight verdict).
- D1/D2/D4 worker side landed in src/sw/core.js (+ src/sw/protocol.js, the versioned protocol module;
  src/sw/sw.js passes self.__INTEGRITY__): navigation deadline 25 s with a self-retrying interstitial and
  a per-URL reload-loop guard (3 retries per 60 s), mw-keepalive + GET /_mw/keepalive, atomic install of
  the JS/CSS critical set with Request.integrity (half-filled cache deleted, install rejected), fail-open
  navigations (frames of shell mode excepted), 40 ms bounded cold-start wait for drop-in subresources,
  no-store documents never kept and reported in mw-ack doc.noStore, web-seed rewrite: no-store answers
  never kept, Range forwarded for files above 32 MiB. peekPointer no longer awaits the tee-branch cancel
  (it resolved only when the page finished reading the document, which kept waitUntil open).
  build.mjs: integrityMap() and applyPlaceholders({ integrity }); build.json gains "integrity".
  Drop-in page side: rules.announceAllowed({ noStore }), swreg.keepAlive(), engine uses both
  (keep-alive while the copy downloads through /_mw/ws/; host-only when the ack says no-store).
  F7: data-nosnippet on the drop-in panel host (at creation) and on the shell's #mw-bar and noscript
  block; src/sdk/sdk-static.js emitted as dist/_mw/sdk-static.js (not precached), copied by publish to
  <out>/sdk-static.js, served by dev-server at /_mw/sdk.js when the root has none.
  New tests: sw-core (9 v0.2.1 tests), sw-protocol.test.mjs (3), dropin-v021.test.mjs (6),
  tools-build (D2 integrity map, F7 stub), tools-dev-server (F7 stub).
- ~13:30 ET e2e: new module test/e2e/scenarios-serving.mjs registered in run.mjs (SERVING_ORDER after
  scenario 9, before PEER_ORDER): SW-INSTALL (a new /mw-sw.js with a wrong loader.js hash goes
  installing > redundant in Chromium 156, no mw-shell-<new> cache is left, the old build keeps control;
  a consistent update activates and the site renders) and PUBLISH-WS (cold start from a cross-origin
  https web seed that answers OPTIONS with 405: rendered from the web seed with 11 ranged GETs and 0
  preflights; the gate says FAIL-cors strict and PASS-no-preflight with --allow-no-preflight). Both PASS.
  Findings on the way: (1) tools/dev-server.mjs ETags were size + mtime only, so two override files of
  equal size written in the same millisecond answered a revalidation with 304 and the browser kept the
  old /mw-sw.js; the ETag now includes the inode. (2) Browsers add "Cache-Control: no-cache" themselves
  to a fetch with cache: 'no-store' (network layer, never preflighted): a seed sees it even with the
  patched bundle; only the stock author header "no-store" matters. (3) The shell's connect-src allows
  https: and ws://127.0.0.1:* but not http://<other port>, so a cross-origin dev web seed must be https.
- npm test after the batch: lint-floor clean (58 files), 814 tests, 814 pass, 0 fail.
- check-site gained --full (origin mode of the gate over each web seed: every byte, every piece); the
  drop-in engine's keep-alive interval runs on the engine's own timers (keepAliveIntervals()).

## Final state (2026-10-19 13:36 ET)

| Item | Status | Where |
|---|---|---|
| B3 header patch | done | build.mjs WEBTORRENT_PATCHES/applyVendorPatches/checkPatchedLock; build.lock.json patched.sha256; build.json patched:true; check-webseed probes both header sets; e2e PUBLISH-WS |
| B4 tools gate | done | tools/check-webseed.mjs (seed/origin/host, verdicts), publish --verify-ws/--verify-host/--allow-no-preflight, check-site (seed, host, --full origin) |
| D1 navigation and streaming safety | done | src/sw/core.js (deadline, interstitial, guard), src/sw/protocol.js, swreg.keepAlive, engine keep-alive |
| D2 atomic install, fail open | done | core precacheCritical/install/failOpen, build integrityMap + self.__INTEGRITY__, e2e SW-INSTALL |
| D4 drop-in rule edits | done | core (40 ms, no-store, web seed), rules.announceAllowed noStore, engine, publish tag/CSP output |
| E1 path policy | done | tools/publish-policy.mjs lintPaths/dotPathReason, publish |
| E2 budget gates | done | budgetReport + printed size report, --max-files |
| E3 secrets/PII lint, --from-wxr | done | lintSecrets, importWxr, --allow-secret |
| E4 deterministic pack | done | --date, SOURCE_DATE_EPOCH, git time, --double-pack, double-pack test |
| F7 crawler-inert loader | done | data-nosnippet (panel host, shell #mw-bar), src/sdk/sdk-static.js -> dist/_mw/sdk-static.js, dev-server fallback |
| A3 tool side | done (docs) | the formats agent wrote tools/withdraw.mjs and the CLI; documented in ARCHITECTURE §10 |
| F4 open ledger contact | done | publish warns on writers=open without --ct; --ct/--lg/--aud in the pointer |

Test runs at the end: `node build.mjs` OK; `npm test` lint-floor clean (58 files), 817 pass, 0 fail;
`npm run test:browser` 28 pass, 1 skipped (v0.1 sw-browser); `npm run test:example` 29 pass;
`node test/e2e/run.mjs` 21 pass, 2 fail: PEER-BLIP and PEER-WS, the network agent's scenarios still in
progress (its PEER-WS has debug output; the circuit breaker does not trip yet). Every v0.2 scenario and
SW-INSTALL, PUBLISH-WS pass; network policy PASS.

Open points for the verifier and the review:
1. Whether the floor browsers (Chromium 110, Safari 15.4, Firefox 115) treat a simple Range header as
   CORS-safelisted is not measured here (Chromium 156 and WebKit 27.2 do). The gate therefore requires
   the range preflight by default; --allow-no-preflight accepts a GitHub Pages style host.
2. Firefox never launched on this machine (Playwright Firefox 157 "Could not find profile folder"), so
   the navigation deadline and keep-alive were checked in unit tests and Chromium only.
3. A CI step that runs publish --double-pack belongs to the CI/docs wave (.github is not owned here).
4. src/sdk/sdk-static.js is a new file next to the formats agent's src/sdk/sdk.js; if the SDK surface
   changes again, the stub's surface should follow (it mirrors the v0.2.1 site-callable list).
5. --verify-host removes the previous site/ deploy copy before the gate (like --verify-ws does with the
   stamped trees); the error message says to publish without it first to get the non-HTML files.
