# Code review round 1: spec conformance and honesty

Lens: SPEC CONFORMANCE & HONESTY (`.orchestration/scripts/review-only.js`, label `review:conformance`).
Date: 2026-10-19. First pass 15:40 to 16:15 ET (the run died while finishing this file); second pass, which
re-verified every first-pass finding and extended the review, 16:20 to 16:50 ET. Code reviewed: the working tree
at `29733c0` (auto checkpoint 16:08 ET). `git diff --stat 4b9178b HEAD` lists only the two review files, so `src/`,
`tools/`, `test/`, `build.mjs`, `build.lock.json` and `package.json` are byte-identical to checkpoint `4b9178b`
("v0.2.1 hardening applied"), the code the INTEGRATION-STATUS runs describe. References: ARCHITECTURE.md (v0.2
amended to v0.2.1), INTERFACES.md (read against the code on the second pass), DESIGN-REVIEW.md (items 1 to 25,
S1 to S13, section 4), DIGEST-AMENDMENTS.md (Status column). This review changed nothing in the repository except
this file. Findings are in section 5: IDs are stable across passes (1 to 18 from the first pass, 19 to 22 added on
the second) and are listed most severe first.

What was run (Node 24.22, everything on 127.0.0.1, `ALLOW_REMOTE` unset):
- `npm test` in the repository: lint-floor clean (59 files), 836 pass, 0 fail, 6.7 s (the same on both passes).
- `node test/e2e/run.mjs --webkit` in an isolated clone under the session scratchpad (`node_modules` symlinked; the
  e2e stack rebuilds and deletes `dist/`, which the other reviewers share): 24 of 24 PASS (the 23 default scenarios
  plus W7), network policy PASS, 100.0 s, exit 0. First pass: 23 of 23 in 101.7 s, then `--only W7` PASS.
- In the clone: `npm run test:example` 29 pass; `MW_BROWSER=1` `chain-core-browser` pass (Chromium 156 mines 16 bits
  in 61 ms, WebKit 27.2 in 69 ms; Firefox not launchable, reported as a diagnostic, not a failure);
  `loader-common-browser`, the Chromium test only (`--test-name-pattern=^Chromium`): 9 pass. Its two WebKit tests
  were not run: they load `http://localhost` (finding 18), outside the binding "WebKit only http://127.0.0.1" rule.
- Probes against the real modules, no browser (scripts kept in the session scratchpad): first-visit pointer
  resolution with a DNS record signed by an unrelated key (finding 4); a default withdrawal checked by a visitor
  clock 2 s behind (finding 9); `resolvePointer` with the exact context `runHubRoot` builds for
  `https://hub.example/#host:example.com` on a first visit (finding 19: three attempts, all `E_NEEDS_CONSENT`, zero
  DoH requests) and, as the control, for a `#magnet:` link (resolves, label computed); MW-PTR/1 edges (duplicate
  single-valued keys and control characters refused, unknown `st` read as withdrawn, `st=` with an empty value read
  as active: finding 21).
- Second pass: every file:line cited in the section 1 matrix was re-read (about 90 citations); each still points at
  the code it names.

## 0. Progress at a glance

Code status per review item: implemented = the item's change list is in the code; partial = a named part is
missing; missing = not started. Acceptance checks that are manual or not automated are listed per row and do not
lower the code status.

| Set | Implemented | Partial | Missing | Progress (partial counts half) |
|---|---|---|---|---|
| Must-fix 1 to 25 | 17 | 7 (items 3, 4, 5, 15, 17, 22, 24) | 1 (25, release gate) | 82 % |
| Should-fix S1 to S13 | 12 | 1 (S13: no CI job) | 0 | 96 % |
| All 38 review items | 29 | 8 | 1 | 87 % |
| DIGEST-AMENDMENTS v0.2.1, 33 rows as recorded | 24 done | 3 partial | 6 skipped (docs, roadmap) | 77 % |

Acceptance checks: 8 of 25 must-fix items (1, 2, 3, 5, 10, 11, 16, 21) have every acceptance check automated and
passing; 16 are partly covered (unit level only, or one variant untested); item 25 is manual and not started.
Three DIGEST-AMENDMENTS rows marked done are contradicted by the code: A4 in drop-in mode (finding 1), C2 in
drop-in mode (finding 13) and C1 at the root of a subdomain hub (finding 19). A3 has a fail-open path (finding 9)
and an empty-`st=` edge the golden vectors do not pin yet (finding 21).

What blocks calling v0.2.1 complete: findings 1 and 2 (high, code), finding 3 (high, the item 24 documents), and
the release gate (item 25).

## 1. Item-by-item matrix

### Must-fix 1 to 25

| # | Item | Status | Code evidence | Acceptance evidence | Gap |
|---|---|---|---|---|---|
| 1 | Redactable blocks | implemented | `src/chain/block.js:316-355` (v and z travel together, control ops never carry v), `:381-399` validateBlock, `:430` redact; salted vh (A1) `:121-129`; WANT `{h, v:true}` `src/chain/gossip.js` (valueGraceMs `:99`) | `chain-core-block` "redaction keeps h and s valid; stubs cannot lie about prev"; `chain-net-sync` "a tombstoned (v-less) block reaches a newcomer", "an unexplained stub makes the node ask WANT { h, v: true }"; `test/vectors/block.json` | none |
| 2 | Causal policy at ingest | implemented | `src/chain/state.js:98` reduce (pass 1 control validity, pass 2 controlFor), `:456` admit; `src/chain/node.js` control-state check at the heads | `chain-core-state` "owner switches writers to 'owner' ... no-op on 1 000 shuffles", "a bits increase governs concurrent and later writes", "reduce stays within budget for 5 000 blocks (target 50 ms; asserted < 200 ms)" | the 50 ms target is asserted as 200 ms (measured 1.9 ms in Chromium, 2 ms in WebKit by `chain-core-browser`) |
| 3 | Owner identity, roots, succession | partial | (a) ledger id `src/common/pointer.js:629-638`; (b) owner-only roots `block.js:307`, genesis minted by `tools/publish.mjs:828`, `gen=`; (c) succession op in `state.js`, `rot=` `pointer.js:537-553`; (d) no owner key in browsers `src/loader/bridge.js:491-492`, `src/sdk/sdk.js:587-588`; (e) HELLO owner and detach `gossip.js:64`, `:137` | `chain-core-state` "succession: earlier tombstones still apply", "a non-owner root is rejected"; e2e 4 (moderator tombstone without owner.jwk) PASS | (c) cannot work end to end: the ledger id hashes the CURRENT owner key, so a rotation starts a new, empty ledger (finding 2) |
| 4 | Abuse defaults, byte caps, PoW as a fee | partial | `block.js:32-50` LIMITS and DEFAULT_POLICY; cap and exemptions `node.js` (`:19`, `:579`, `:845`); ban/allow ops; PoW in a classic worker `src/chain/pow-worker.js` | `chain-net-scale` "a flood of 10 000 valid blocks leaves every node at or under maxChainBytes; owner blocks still get in"; `chain-core-browser` mines 16 bits in 61 ms (Chromium) and 69 ms (WebKit) on this Mac | "show progress and cancel" is not implemented (finding 10); PoW median and p95 on a mid-range Android not recorded |
| 5 | Bounded sync that scales with depth and relays | partial | HELLO/SYNC/INV/budgets/orphans `gossip.js`, `src/chain/dag.js:25-26`; node relays on first acceptance | `chain-net-protocol` "bootstrap: a fresh node takes an ~8 MiB ledger ... from one honest peer without banning it"; `chain-net-sync` "line topology A-B-C ... within 2 s"; `chain-net-scale` "a 5 000-block chain syncs ... in O(blocks / 64) frames" | "signatures are verified in a worker pool": the product pool is always inline (finding 5); INTERFACES says "worker-backed in browsers", and `chain-core-browser` shows the worker mode works once a URL is passed |
| 6 | Hub mode without isolation claims | implemented | gate with name, btih, size, trackers, publisher `src/loader/app.js:1173-1207`, `src/loader/ui.js:173-194`; banner `strings.js:70`; labels `pointer.js:644-653`; hub-root redirect `app.js:933-952`; no `allow-modals` `render.js:10-13`; C4 assertion test | e2e 8 PASS (0 sockets, 0 peer connections for 2 s, then renders under `/_mw/s/`) | "two subdomain sites cannot see each other's IndexedDB" not tested (needs wildcard DNS); the DEPLOY.md and PSL text does not exist (finding 3); ARCHITECTURE §3.2's `#host:` link never resolves on a subdomain hub root, and no test runs hub-root mode at all (finding 19); the hub root redirects before any gate (the label origin shows it, so no connection precedes a click) |
| 7 | Same-URL iframe, `/_mw/` namespace, routing manifest | implemented | `src/loader/render.js:584-684` (src = top URL, history mirroring), `src/sw/core.js:1815-1845` routing, `src/sw/lib.js:606` applyRouting, `/.mw/site.json` from publish | e2e 1 (root-relative assets, `fetch('/data/about.json')`, `location.pathname === '/'`); e2e 10 checks the History router, deep links, pushState, reload and back in DROP-IN mode; `sw-lib` applyRouting units | shell mode is not E2E-tested with a History-API router, an SPA fallback route, deep-link reload or back/forward |
| 8 | Framing and navigation safety | implemented | headers `core.js:308-319`, `:1282-1288`; manifest CSP keeps the worker's `frame-ancestors` (`core.js:321-339`); framed shell stops `src/loader/boot.js:116-121`; frame guards `render.js:468-546`; both bridge checks with the comment `bridge.js:298-302` | `sw-core` "shell: a top-level navigation gets the precached shell with framing headers" | no test for any of the three item 8 E2E checks (foreign page framing the site, external link opens a new tab, key-change Confirm through a frame); `installFrameGuards` has no unit test |
| 9 | Never serve or upload unverified bytes | implemented | SW per-piece checks `core.js:1028-1075`, `:1115-1144`; `src/loader/blob-chunk-store.js:76-110`; infohash from the resolved pointer `app.js:1357-1369`; degraded mode verifies per file `app.js:1678-1693`; `deleteSite` also removes stamped offline documents (`core.js:563`, `cache.js:441`) | e2e 3 PASS (flipped byte in an open page and before load); `sw-core` "a stored file that fails its piece check"; `loader-common-chunk-stores` | "verifying a 2 MB page is measured in the debug panel" not implemented (no timing anywhere in the UI) |
| 10 | Transport message length cap | implemented | `src/loader/torrent.js:327-353` (unsigned prefix, destroy above 256 KiB before buffering, buffer watchdog), `:848-849` setTimeout/keep-alive, fail closed `:839-846`; marker in `build.lock.json` | e2e PEER-11 PASS (`0x7FFFFFFF` dropped 66 ms after it was sent); `tools-build` marker test | none (the upstream `maxMessageLength` request is outside the code) |
| 11 | Pointer record v1 | implemented | `pointer.js:323-350` parse (duplicate single-valued keys and control characters refused, probe), `:484-486` signing input, `:572-612` verify (required exp and seq, 400-day bound, seq rollback before the owner check), `:768-777` pickRecord; expired cached record still renders `app.js:149-151` | `common-pointer` vectors, `test/vectors/pointer.json` with `LOCK.json` | publish leaves `=` unencoded (harmless: the parser splits at the first `=`; the code comment says so, the item text does not) |
| 12 | Third parties and consent | implemented | exact signed `tr` `torrent.js:77-81`, `private: true` `:704`; DoH order, `Accept`-only GETs and ECS `src/loader/doh.js:17-21`; C1 card before trackers, STUN and DoH `app.js:1162-1171`, `:1104-1127`, `:221-222`; `tracker.mjs` refuses without `--allow` `tools/tracker.mjs:229-233` | e2e PEER-CONSENT, 8 and 10B PASS; the e2e network guard fails any non-loopback request, so CONFIG.trackers are never contacted | "a 30-minute session makes one DoH request per TTL" is unit-level only (TTL cache); first-visit DNS override (finding 4); a DNS-only hub link can never get the C1 choice on the hub root (finding 19) |
| 13 | Cold start from the web seed (`xs=`) | implemented | default `xs` `tools/publish.mjs:847-848`; `.torrent` first `torrent.js:1380-1396`; E_NO_PEERS only without xs and ws `:1519-1526`; message `strings.js:148` | e2e 7 PASS (0.2 s, source webseed), W7 PASS (WebKit 231 ms) | the hub variant renders (e2e 8) but its source is not asserted |
| 14 | Web-seed HTTP contract | implemented (with B3, B4) | probe `torrent.js:1133-1157`; breaker `:1259-1303`; `tools/check-webseed.mjs` three modes; SW passes web-seed requests through except `/_mw/ws/` `core.js:1802-1804` | e2e PUBLISH-WS (0 preflights) and PEER-WS PASS; `tools-check` | Firefox web-seed download unverified (Firefox not launchable here) |
| 15 | Discovery plane | partial | trackers `src/loader/config.js:19`, STUN `:22`; keepalive announce (B1) `torrent.js:1092-1116`; fast reconnect shim `:246-304`; kick `:776-807` | e2e PEER-BLIP PASS (both swarms of both visitors re-announced 1.6 s after a real drop); `loader-app-tracker-shim` | no 30-minute idle test; no evidence of the EasyList, EasyPrivacy and Brave list check; "running a tracker" DEPLOY text and DEMO-RESULTS connect times missing |
| 16 | Browser floor and polyfills | implemented | `boot.js:191-418` (alphabet, omitPadding, SyntaxError, AbortSignal.timeout, self-test); floor `config.js:16`; build targets; `tools/lint-floor.mjs` (59 files = every `src/` script plus CSS and HTML) | e2e 14 PASS (WebKit and Chromium with native methods deleted); `tools-lint-floor` fails on `Promise.withResolvers` | the floor is not recorded in a README (there is none) |
| 17 | SW registration timing and degraded mode | partial | `render.js:314-350` (degrade only on missing API or rejection, 15 s ready cap, reload once); CSP variants `boot.js:433-461`; degraded renderer `render.js:722-936`; precache = `/_mw/` shell files without `webtorrent.min.js` (`dist/build.json`) | e2e 14 PASS (`serviceWorkers: 'block'` renders styled, `mw.ready()` resolves) | a ready() timeout renders limited mode under the normal CSP (finding 6); no slow-3G first-visit E2E |
| 18 | Storage correctness | implemented | MemoryChunkStore and Blob per file on done `torrent.js:1426-1432`, `:1486-1498`; one readwrite transaction, Blobs built first `src/loader/cache.js:393-415`; versionchange/blocked/UnknownError `cache.js:241-280`; identity round trip and JWK fallback `app.js:468-484` | `loader-common-browser` (Chromium run here; WebKit per INTEGRATION-STATUS); `loader-common-cache` | "two tabs downloading different sites on one origin", "identity survives a reload in WebKit" and "forced self-test failure can still post" are not E2E |
| 19 | Upload and visibility policy | implemented (with C2) | `src/loader/policy.js:110-197`; choke lock `torrent.js:368-384`; lifecycle `app.js:2113-2187` | e2e 12 PASS (uploads off: peer download, web-seed download, two-way gossip, choke lock holds) | drop-in phones still destroy the client when hidden, and rebuild only after the desktop 60 s threshold (finding 13); WebKit mobile-UA default is unit-level only |
| 20 | SW update safety, kill switch, trust root | implemented | fixed SW URL and `updateViaCache: 'none'` `boot.js:556`; proto on every message `core.js:877`; mismatch banner `render.js:432-442`; every navigation answered `core.js:1891-1912`; kill switch `src/sw/kill-switch.js` | e2e 9 PASS (shell and drop-in, no reload loop) | "an old page with a new SW shows Reload instead of breaking" is not tested (integration-2 says so); DEPLOY text missing |
| 21 | Takedown of superseded versions | implemented | stop seeding at once `app.js:2014`, `:2051`; delete old versions `app.js:1415-1427`; drop-in keeps current plus one live previous `src/dropin/rules.js:100-125`; A3 withdrawal `src/common/withdrawal.js` | e2e 13 PASS; e2e FMT-WITHDRAW PASS (shell); drop-in withdrawal unit-level (`dropin-engine`, `sw-core`) | none in code (A3 fail-open under clock lag, finding 9) |
| 22 | HTTPS, root path, deploy order | partial | insecure-context text `boot.js:23`, `:111-114`; demo tiers `tools/demo.mjs:71`; dev CSP `wss://<lan-ip>:*` `boot.js:437-440`; `--verify-ws` gate `tools/publish.mjs:921-951` | `tools-demo`, `tools-publish` | the non-root message can never appear (finding 7); DEPLOY.md missing; the LAN phone check is manual and not done |
| 23 | Drop-in mode specified | implemented | `src/dropin/*`; SW rules (a) to (d) `core.js:1367-1505`; `owns()` synchronous `core.js:1789-1813`; `publish --dropin` `tools/publish.mjs:978-1008` | e2e 10 and 10B PASS (JS-off parity, IndexedDB second view, no version mixing, foreign and integrated SW, offline); e2e 9 drop-in part | Lighthouse LCP and CLS within 5 % not measured; 3.4.5 prefill from the previous IndexedDB version not implemented (dropin deviation 5; ARCHITECTURE still claims it, finding 15) |
| 24 | Honesty layer | partial | UI strings follow section 4 (`src/loader/strings.js`, grep clean, section 3 below); `package.json` description is the approved one-liner; ARCHITECTURE section 0, 1 and 13 sentences fixed | examples/peer-guestbook `.dev/site.test.mjs` banned-word test | README.md, docs/CRITIQUE.md and docs/DEPLOY.md do not exist; the approved tagline, "Visitors keep it alive" and SDK-docs strings appear nowhere user-facing (finding 3); the approved "Share ... Off" Settings line does not say that ledger posts are still relayed (finding 20) |
| 25 | Release gate | missing | none (manual by design) | none; `docs/DEMO-RESULTS.md` does not exist | not started; nothing in the repository claims production readiness (grep clean) |

### Should-fix S1 to S13

| # | Item | Status | Code evidence | Acceptance evidence | Gap |
|---|---|---|---|---|---|
| S1 | Ledger gossip across versions | implemented (as B2 rendezvous) | `torrent.js:1705-1823`; leave the version swarm `policy.js:195`, `torrent.js:1686-1693` | e2e PEER-RV PASS (post across versions in 271 ms) | none |
| S2 | Ledger durability floor (`cs=`) | implemented | `app.js:1949-1972`, `tools/snapshot.mjs` | `tools-snapshot` "the snapshot is what the loader reads" | "a fresh visitor with no peers sees every entry up to the snapshot" is unit-level only |
| S3 | Identity and storage durability | implemented | persist from the consent click `app.js:1000-1005`; export/import `app.js:429-460`; first-time banner `app.js:1299`; LRU budget `cache.js` enforceBudget; iOS hint `app.js:2212` | `loader-common-browser` enforceBudget subtest | WebKit cleared-data first-time notice not E2E; drop-in asks `persist()` inside `ConsentState.set`, so follower tabs ask on a broadcast, not from a click (finding 22) |
| S4 | Caps on WebRTC wires | implemented (as B6) | `torrent.js:885-937` | `loader-app-torrent` wire-cap tests | the "five short-lived connections per announce" disclosure belongs in README (missing) |
| S5 | Diagnose within 5 s | implemented | `torrent.js:168-184`, `app.js:2067-2100`, `strings.js:178-189` | units; PEER-WS shows the back-off row | the per-row E2E fault-injection run does not exist |
| S6 | One swarm node per origin | implemented | `app.js:512-538`, `:594-646`, `:848`; `src/dropin/leader.js:18`, `:61` | e2e 2 (a follower tab posts through the engine tab) | the "one set of tracker sockets" count is not asserted |
| S7 | Supply chain | implemented | `.npmrc` ignore-scripts, `build.lock.json` stock and patched sha256 | `tools-build` "one changed byte in the vendored bundle fails the build" | none |
| S8 | No WebRTC: load from the host | implemented | `boot.js:176-185`, `app.js:740-744` (badge, Lockdown banner) | none | "RTCPeerConnection deleted renders through xs and ws" not tested |
| S9 | Ledger hygiene | implemented | `node.js:1068` choosePrev, `block.js:149-153` ts, `src/chain/wire-ext.js:8-9`, `:25` | `chain-net-node` "prev selection (S9)", `chain-net-wire` | none |
| S10 | Mobile viewport | implemented | `src/loader/index.html:5`, `src/loader/ui.css:57-83`, `:337-354` | none automated | real-device screenshots (manual) not done |
| S11 | Media Range from the SW | implemented | `src/sw/lib.js:145-176` | `sw-lib` parseRange vectors; e2e 1 MP4 Range and suffix | iOS playback (manual) not done |
| S12 | Tools hygiene | implemented | `tools/keygen.mjs:41-47`, `tools/lib.mjs:303-316` | `tools-lib`, `tools-publish` | none |
| S13 | Owner health probe | partial | `tools/check-site.mjs:230` (warns 14 days before `exp`) | `tools-check` | no CI job (`.github/workflows/` is empty), so "a CI job turns red when the web seed is removed" cannot happen |

## 2. DIGEST-AMENDMENTS rows the code contradicts

| Row | Recorded | What the code does |
|---|---|---|
| A4 site-callable SDK surface | done | True for `window.mw` in both modes and for the shell's frozen `window.__mwShell`. In drop-in mode `window.__mwDropin.engine` gives any page script `consent.set('accepted')`, `identityApi().export/import` and `changeSetting('exportIdentity', ...)` (finding 1). |
| C1 consent before any third party | done | Shell and drop-in follow it. On the root of a subdomain hub, `runHubRoot` (`app.js:761`) runs before the consent record is read (`:794`) and shows no card, so a DNS-only `#host:` link stops at `E_NEEDS_CONSENT` with only a Retry that reloads into the same state (finding 19). |
| C2 mobile defaults | done | The shell follows the lifecycle plan; the drop-in engine still pauses (destroys) the client when a phone page is hidden and uses the desktop 60 s rebuild threshold (finding 13). |
| A3 st= fail-closed | done | A default withdrawal (400 days) is refused as `exp-too-far` by a visitor whose clock lags, and the cached active record keeps rendering (finding 9). `st=` with an empty value is read as active, although only "absent or `ok`" is active (finding 21). |
| E4, E5, F4 | partial | Confirmed partial: no CI job; README and DEPLOY text missing; `publish` tells owners to read DEPLOY.md, which does not exist (finding 3). |
| G roadmap | skipped | "Deferred to `docs/ROADMAP.md`" (also ARCHITECTURE §1 "ROADMAP"), but that file does not exist, so the deferred items are recorded only in DIGEST-AMENDMENTS G (finding 3). |

## 3. Wording rules (DESIGN-REVIEW section 4)

`grep -rniE "blockchain|serverless|isolation|isolated|sub-second|censorship|unstoppable|decentrali[sz]ed|no servers|spam protection|rate limit|production.ready"`, re-run on the second pass with the same result:
- `src/`: no user-facing hit. Code comments and identifiers only: `src/loader/strings.js:3-4` (the rule itself),
  `src/sw/core.js:1242-1244` and `:1289` ("cross-origin isolation" = COOP/COEP headers, not a hub isolation
  claim), `src/dropin/engine.js:860` ("private mode" in a comment).
- `tools/`, `build.mjs`, `package.json`, `test/e2e/`: no hit. The first pass also found none in `dist/`,
  `examples/existing-site-dropin/` (then `test/fixtures/`), `examples/peer-guestbook/` pages and `.github/`, apart from the rules themselves
  (`examples/peer-guestbook/.dev/site.test.mjs:195-196`, `.github/PULL_REQUEST_TEMPLATE.md:11`). `dist/_mw/manifest.webmanifest`
  carries the approved tagline.
- Em dashes, en dashes, curly quotes and the ellipsis character: none in any `src/` string, `tools/` output, the
  built shell or the manifest; two em dashes sit in code comments (`src/loader/cache.js:484`, `:535`).
- Overclaiming phrases ("guarantee", "always online", "tamper-proof", "cannot be taken down", "anonymous"): none
  user-facing.
- Section 4 strings present verbatim in `src/loader/strings.js`: the one-liner, info panel, consent notice, gate,
  both Settings lines, mobile status lines, pointer badges, hub button and banner, ledger status line. Used by the
  UI: `ledgerOneLiner`, `ledgerInfo`, `mobileSharing`, `iosHomeScreen`, `unmoderated`, `ledgerCap`, `ownerMismatch`,
  `hostOnlyBadge`, `firstTime`. Defined but shown nowhere: `ledgerAlive`, `sdkPublic`, `tagline` (their documents
  do not exist, finding 3).
- Approved strings shown nowhere because their documents do not exist: the tagline paragraph, "Visitors keep it
  alive", the SDK-docs paragraph, README "What it is not", "There's no private mode" (present only in
  `examples/peer-guestbook/about.html`).
- An approved string that is accurate but incomplete against the code: "Share with other visitors: On / Off. Off
  still connects to peers to download, so your IP stays visible." With sharing off the browser still relays every
  ledger post it accepts (finding 20).
- No "production-ready" claim anywhere in the repository.

## 4. INTEGRATION-STATUS claims against tests

| Claim (INTEGRATION-STATUS) | Backed by | Re-checked by this review |
|---|---|---|
| `node build.mjs` OK, 15 files, B3 patched | `tools-build` tests; the e2e stack builds first | yes (e2e build in the clone: 15 files plus `build.json`; precache and integrity map as §7.1 says) |
| `npm test`: lint 59 files, 836 pass | the suite | yes: 836 pass, 59 files, on both passes |
| `test:browser`: 28 pass, 1 skipped | the browser files | partly: `chain-core-browser` (Chromium, WebKit) and the Chromium test of `loader-common-browser` pass; its WebKit tests not run (finding 18). The Firefox case of `chain-core-browser` passes without Firefox (a diagnostic), which INTEGRATION-STATUS discloses |
| `test:example`: 29 pass | examples/peer-guestbook `.dev` | yes: 29 pass |
| e2e 23 of 23, network policy PASS, about 100 s | `test/e2e/run.mjs` | yes: 23 of 23 plus W7, 100.0 s |
| `--webkit` 24 of 24 | W7 | yes: 24 of 24 |
| PEER-BLIP re-announced 1.0 to 1.5 s after a real drop | PEER-BLIP (passes when both swarms of both visitors are back within 6 s) | partly: 1.5 s on the first pass, 1.6 s (1608 ms) on the second; harden-verify's own log says 1.3 to 1.6 s. ARCHITECTURE §12 says "within a second", which neither the design (500 ms plus up to 1 s jitter) nor the test promises (finding 15) |
| DIGEST-AMENDMENTS 24 done, 3 partial, 6 skipped | the table | counted correctly; A4, C1, C2 and A3 contradicted (section 2) |
| shell decision buttons ignore script clicks | `v021-integration` (a source regex over ui.js) and the PEER-CONSENT step | behaviourally backed by PEER-CONSENT only |
| an undecided card settles `mw.consent.request()` with `pending` | `v021-integration`: the class is tested, the app.js wiring is a source regex | partly (finding 16) |
| `tools/live.mjs` (pin, snapshot, check-site --headless) clicks "Share and load" with a trusted click | `v021-integration`: label constants and the absence of `hit.click()` in the source | not backed: live.mjs never runs in a test, and it cannot reach the drop-in card at all (finding 8) |
| E5 egress note in `publish --dropin` | `v021-integration`: `egressNote()` is called; "printed in drop-in mode" is a source-slice regex | partly |
| tools/demo.mjs renders on the first load (integration-1 M4) | a manual run (239 ms) | not a test; e2e 7 covers the same first-load path |
| every ARCHITECTURE section 12 scenario is automated (11 as PEER-11) | run.mjs | yes for the section 12 list; several DESIGN-REVIEW acceptance checks outside that list are not automated (matrix); hub-root mode has no test at all (finding 19) |

## 5. Findings (most severe first; IDs stable across passes)

Every first-pass finding (1 to 18) was re-checked against the code on the second pass and holds as written; second
pass additions inside them are marked "Second pass". Findings 19 to 22 are new.

### 1. HIGH. Drop-in publishes the whole engine on `window`: any page script can accept consent and export the visitor's identity
- Where: `src/dropin/mw.js:97-107` (`window.__mwDropin = { version, engine, started, inspect, openSettings }`);
  `src/dropin/engine.js:107-136` (`ConsentState.set`, no trust check), `:318-333` (`identityApi().export/import`).
- Problem: ARCHITECTURE section 3.4.9 and section 9 (v0.2.1 A4) say a site can never accept for the visitor and
  that the panel is the only way an identity leaves or enters a drop-in origin; INTERFACES `src/dropin/mw.js` says
  `engine.identityApi()` is "for loader-owned UI only". The handle undoes all of it with one property. The shell
  does it right (`app.js:737`: a frozen `{ version, inspect }`). FMT-SDK checks only `window.mw`.
- Scenario: a drop-in site, or any third-party script it includes, runs
  `window.__mwDropin.engine.consent.set('accepted')` at load. The versioned consent record is stored, and after 3 s
  visible the page announces to the trackers and opens WebRTC connections; every later visit starts without a card.
  `await window.__mwDropin.engine.identityApi().export('chosen-pass')` returns the identity wrapped under a
  passphrase the script picked, which PBKDF2 plus AES-GCM in the same page decrypts to the private key.
  Second pass: `engine.changeSetting('exportIdentity', { passphrase })` (`engine.js:1409-1420`) does the same
  through the panel's own action handler, around the panel's trusted-click guard.
- Fix: expose a frozen `{ version, started, inspect(), openSettings(), rectOf(label) }` (rectOf returns button
  geometry only, enough for trusted mouse clicks in e2e and tools); keep the engine reachable only through
  `start()`'s return value for unit tests (`__mwNoAutostart`); move `test/e2e/run.mjs:1185`, `:1188`, `:1213` to
  `__mwDropin.rectOf`.
- Test: `dropin-mw` unit: after `start()`, `win.__mwDropin.engine === undefined`, the handle is frozen and no
  reachable property has `consent`, `identityApi` or `changeSetting`; e2e 10B step: a page script that tries to
  accept leaves `inspect().consent === 'pending'`.

### 2. HIGH. An owner key rotation silently starts a new, empty ledger (DESIGN-REVIEW item 3(c) cannot work)
- Where: `src/common/pointer.js:629-633` (ledger id = sha256 of the pointer's current `owner`);
  `tools/publish.mjs:792` (ledger id from `--key` even with `--prev-key`), `:806-828` (the old genesis fails
  checkGenesis, publish prints only a note, `:825`, and mints a new genesis); `src/chain/block.js:296` and
  `src/chain/node.js:342` (blocks of another `site` are refused).
- Problem: item 3(c) designs succession (`{t:'owner', next}` plus `rot=`) so that "a key rotation never
  re-interprets history". Because the ledger id binds the current key, the rotated pointer names a different
  ledger: a new IndexedDB database, a new rendezvous infohash, a new genesis. The succession op is never used by
  visitors, and chain-net's deviation 14 (HELLO carries the genesis owner "so visitors on pointers from before and
  after a key rotation still talk") cannot help, because their HELLOs already differ in `site`. RUNBOOK section 6
  and INTEGRATION-STATUS call it an open design question; publish does it without stopping.
- Scenario: the owner runs `ledger-admin owner --next new.jwk`, then `publish --key new.jwk --prev-key old.jwk`.
  summary.json shows another ledgerId and gen=; every visitor's guestbook is empty after the next load; the old
  posts stay in orphaned `mw-chain-*` databases.
- Fix: bind the ledger id to the genesis owner: a signed pointer key for the ledger owner (or the genesis author
  named by `gen=`), used by `ledgerIdFor`, publish (`--prev-key` keeps the ledger id and reuses genesis.json), the
  drop-in stamp check and the loader; the current owner is checked through `rot=` and the ledger's owner chain.
  Until then publish must refuse `--prev-key` unless `--new-genesis` is given and say that the ledger restarts.
- Test: `tools-publish`: publish with key A, append a post, `ledger-admin owner` A to B, `publish --key B
  --prev-key A` gives the same ledgerId and `genesisReused: true`; a `loader-app` unit: resolvePointer on the
  rotated record yields the old ledgerId; an e2e step: a post written before the rotation is visible after the
  rotated pointer loads.

### 3. HIGH. Item 24's documents do not exist, and user-facing output points at them
- Where: `tools/publish.mjs:839` ("DEPLOY.md, owner duties"); `SECURITY.md:29` (`docs/SECURITY-MODEL.md`),
  `SECURITY.md:39` (`CHANGELOG.md`); `.github/ISSUE_TEMPLATE/feature_request.yml:15`;
  `.github/PULL_REQUEST_TEMPLATE.md:12` (`CHANGELOG.md`); repository root (no README.md).
- Problem: must-fix item 24 requires README.md, docs/CRITIQUE.md, docs/DEPLOY.md (also the destination of items 6,
  14, 15, 20 and 22: PSL entry, S3 and CloudFront CORS, kill switch, S3 HTTP-only note, deploy order, running a
  tracker) and item 25 docs/DEMO-RESULTS.md. Only docs/research/RESEARCH-DIGEST.md exists. Second pass: also missing
  are `docs/ROADMAP.md` (DIGEST-AMENDMENTS G and ARCHITECTURE §1 "ROADMAP" defer the own-bundle, TURN, hub and
  real-device items to it), `CHANGELOG.md` (the 0.2.1 draft lives only in `docs/deviations/harden-verify.md`) and
  `docs/PRIVACY.md` (F2, skipped by design). Scheduled for `productionize.js` (RESUME.md); until then item 24 is
  unmet and the references above are dead links.
- Scenario: an owner publishing an open ledger is told to read DEPLOY.md owner duties; a security reporter is told
  to read docs/SECURITY-MODEL.md before reporting; neither file exists, and no document tells an owner that a shared
  hub is not isolated or that S3 website endpoints are HTTP-only.
- Fix: write the documents with the section 4 strings verbatim (the documentation wave), or until then remove or
  repoint the references (SECURITY.md to RUNBOOK.md and ARCHITECTURE section 13; G to a ROADMAP stub).
- Test: a unit test that resolves every repository-relative `*.md` path named in `tools/*.mjs` output strings,
  SECURITY.md, `.github/` templates and `docs/review/DIGEST-AMENDMENTS.md`; the item 24 grep over README.md and
  `docs/*.md`.

### 4. MEDIUM. First visit: a DNS record signed by an unrelated key overrides the page tag and gets pinned
- Where: `src/loader/app.js:165` (with no pin every signed candidate is `trusted`), `:180-182` (DNS wins on signed,
  trusted and a higher seq), `:339-345` (the winner's key is pinned).
- Problem: ARCHITECTURE section 4: "With both meta and DNS valid: DNS wins only if signed by the pinned owner (or
  with valid rot) and seq is higher; otherwise meta." With no pin the code accepts any key. Probe with the real
  resolvePointer: page tag signed by A (seq 1), `_magnet` TXT signed by B (seq 2), empty cache: source `dns`, owner
  B, pin B. Later loads treat A's page tag as "publisher key changed" while B keeps winning. With a `<meta>` pointer
  the C1 rule lets the lookup run before any choice, so this happens on the very first load.
- Scenario: whoever controls only the `_magnet.<host>` TXT record (a separate DNS provider, a phished DNS account)
  sends every first-time visitor to their own infohash and trackers and pins their key, although the host's page
  tag says otherwise.
- Fix: with no pin, compare DNS against the page tag's owner: DNS wins over a valid meta only when
  `dns.record.owner === meta.record.owner`, or `rot=` verifies against meta's owner, and its seq is higher; same
  rule in `checkForUpdate`.
- Test: `loader-app` unit for resolvePointer with no pin: meta(A, 1) plus dns(B, 2) picks meta and pins A;
  dns(A, 2) picks dns; dns(B, 2, rot signed by A) picks dns with `rotated`.

### 5. MEDIUM. Ledger signatures never verify in a worker pool
- Where: `src/loader/app.js:1823` and `src/dropin/ledger.js:87` call `createVerifierPool({ size })` without
  `workerUrl`; `src/chain/verify-pool.js:27` then verifies inline.
- Problem: ARCHITECTURE section 5.5 and item 5: "signatures verify in a worker pool"; INTERFACES `verify-pool.js`:
  "worker-backed in browsers, inline in Node". `pow-worker.js` already answers `{ verify }` messages, and
  `chain-core-browser` asserts `poolMode === 'worker'` for a pool built with the worker URL (Chromium and WebKit
  pass); the product simply never passes it.
- Scenario: a phone bootstrapping an 8 MiB ledger (thousands of blocks) canonicalizes, hashes and verifies every
  block on the page's main thread while the site renders.
- Fix: pass `workerUrl: config.assets.powWorker` in both places (the inline fallback stays).
- Test: `loader-app` and `dropin` units with an injected Worker: `verifierPool.mode === 'worker'`; add the mode to
  `__mwShell.inspect()` and assert it in e2e 2.

### 6. MEDIUM. A `ready()` timeout renders limited mode under the normal CSP: unstyled, scripts blocked
- Where: `src/loader/boot.js:545-576` (the normal CSP is fixed once `register()` resolves); `src/loader/render.js:337`
  (ready timeout returns degraded); `src/loader/app.js:1658`, `:1694` (mountDegraded).
- Problem: when the install fails after `register()` resolved, `navigator.serviceWorker.ready` never settles; after
  15 s the degraded renderer's blob: scripts, blob: stylesheets and `<base>` are blocked by `script-src 'self'` and
  `base-uri 'none'`. The D2 atomic install (`src/sw/core.js:1684-1711`) makes this the expected outcome of a mixed
  deploy for every first-time visitor. Listed as open in INTEGRATION-STATUS next step 2; SW-INSTALL covers only
  the update case.
- Scenario: a deploy uploads mw-sw.js before the CDN serves the new `/_mw/loader.js`; a first-time visitor waits
  15 s on "Preparing offline engine..." and then sees the site without CSS or JavaScript.
- Fix: on the ready timeout, or as soon as the installing worker turns `redundant`, set a sessionStorage flag and
  reload once; boot.js honours the flag (no register(), the degraded CSP) and the limited-mode banner shows.
- Test: e2e in `scenarios-serving.mjs`: a fresh context whose `/mw-sw.js` carries a wrong loader.js integrity
  renders the example styled in limited mode, `mw.ready()` resolving, after at most one reload.

### 7. MEDIUM. The non-root deployment message can never appear (item 22)
- Where: `src/loader/boot.js:123-131` (the check at `:127`); `src/loader/index.html:38`
  (`<script src="/_mw/boot.js">`, absolute).
- Problem: boot.js either loads from the root (the check passes) or does not load at all (404). Nothing tells the
  visitor or the owner what happened; no tool checks it.
- Scenario: the shell deployed at `https://user.github.io/repo/`: `/_mw/boot.js` answers 404 and the page shows
  "Starting..." forever.
- Fix: make the static `#mw-boot` text carry the explanation when boot.js never runs (boot.js replaces it at once),
  for example "If this text stays, the loader could not start: it must be served from the root of its domain
  (/_mw/boot.js, /mw-sw.js)."; have `check-site` report a site URL with a non-root path whose `/_mw/boot.js` fails.
- Test: `tools-build`: `dist/index.html` carries the hint; `tools-check`: check-site against a dev server that
  serves the shell under `/repo/` reports the non-root deployment.

### 8. MEDIUM. `tools/pin.mjs` cannot give consent on drop-in pages, so a pinned drop-in node never shares
- Where: `tools/live.mjs:53-64` (looks for `.mw-notice button, .mw-gate button` in the light DOM, `:55`);
  `tools/pin.mjs:15` (still says it presses "OK" or "Load").
- Problem: the drop-in card lives in a closed shadow root (`src/dropin/panel.js`), which Playwright locators cannot
  reach, so `acceptConsent` returns false after 20 s. ARCHITECTURE section 3.4.6 names pin.mjs as the way to seed a
  drop-in site continuously. INTEGRATION-STATUS reports the trusted-click fix as done; its only test is a source
  regex (`test/unit/v021-integration.test.mjs:122-128`). Second pass: the shell card does match (`ui.js:105`,
  `:216`), so the gap is drop-in only; `waitForSiteRendered` already handles drop-in pages through `mw.ready()`.
- Scenario: `node tools/pin.mjs https://shop.example/ --headless` on a drop-in site logs a healthy page, but consent
  stays `pending`: no announce, no seeding, no ledger relay.
- Fix: when `window.__mwDropin` exists, take the button geometry from `__mwDropin.rectOf(STRINGS.consentShare)`
  (finding 1) and click it with `page.mouse`; fail loudly when no card is found; update the pin.mjs header.
- Test: an e2e step on the drop-in fixture (local host): `acceptConsent(page)` from `tools/live.mjs` returns true
  and `__mwDropin.inspect().consent === 'accepted'`.

### 9. MEDIUM. A default withdrawal is refused by a visitor whose clock lags, and the withdrawn site keeps rendering
- Where: `tools/withdraw.mjs:37` (`WITHDRAW_EXP_DAYS = MAX_EXP_DAYS`, 400); `src/common/pointer.js:600-601`
  (`exp - now > 400 days` is `exp-too-far`).
- Problem: the withdrawal is signed with exactly 400 days left, so any visitor clock behind the publisher's at
  fetch time refuses it until the lag has elapsed. Probe: `withdraw()` at T, verifyPointer at T: ok; at T - 2 s and
  T - 60 s: `REFUSED: exp-too-far`. The loader then falls back to the cached active record (A3 fails open). Same for
  `publish --exp 400`, where a lagging first-time visitor gets "No usable pointer".
- Scenario: an owner withdraws a site after a legal notice; a returning visitor whose phone clock is 10 minutes slow
  loads within those 10 minutes: the withdrawal is refused and the old version renders and seeds.
- Fix: default withdrawals to 399 days and cap `--exp` at 399, and/or allow a clock-skew margin (for example one
  day) in the `exp-too-far` check.
- Test: `tools-withdraw`: the default withdrawal verifies with `now = publishNow - 1 hour`; `common-pointer`: a
  record 400 days plus 30 minutes ahead passes with the margin.

### 10. MEDIUM. Proof-of-work has no progress or cancel (item 4), and a write the SDK reports as failed is published later
- Where: `src/chain/node.js:1115-1126` (createBlock without `onProgress`, only the node-wide abort signal);
  `src/sdk/sdk.js:400-404` (E_TIMEOUT after 30 s, no cancel message).
- Problem: item 4 asks for mining "with progress and cancel"; nothing reports progress to the UI or the SDK and no
  write can be cancelled. When a write takes longer than the SDK's 30 s, the SDK rejects while the Bridge keeps
  mining and then ingests and gossips the block. Second pass: `E_TIMEOUT` is not among the error codes ARCHITECTURE
  section 9 documents for site code.
- Scenario: the owner raises `bits` to 22 against spam; on a slow phone mining takes about a minute; `mw.db.append`
  rejects with E_TIMEOUT, the visitor taps Post again, and both posts appear.
- Fix: forward miner progress to a status line and an SDK event; give writes an AbortSignal and a Bridge cancel
  message that the SDK sends on its timeout (or extend the timeout while progress arrives); document E_TIMEOUT.
- Test: `sw-sdk`/`bridge` unit with a slow fake miner: progress events reach the site; an SDK timeout cancels the
  write and no block is ingested.

### 19. MEDIUM. Subdomain hub: a `#host:` link never resolves on the hub root (C1 gating with no card) [new]
- Where: `src/loader/app.js:761` (`hub-root` returns into `runHubRoot` before the consent record is read at `:794`),
  `:933-952` (`runHubRoot`: any error goes to `presentPointerError`), `:1211-1250` (`dohAllowed` =
  `dnsAllowedBy(A.consentRecord)`, always false there), `:222` (`dnsCandidate` returns `consentNeeded`),
  `:322-328` (`E_NEEDS_CONSENT`); `presentPointerError` offers only Retry, which reloads.
- Problem: ARCHITECTURE section 3.2: "`https://hub.example/#magnet:...` or `#host:example.com` shows the §8 gate,
  then redirects to `https://<label>.hub.example/#<pointer>`". C1 rightly forbids the DoH lookup before a choice,
  but the hub root has no card to make one (the shell path has `askBeforeDns`, `app.js:801-810`). The label of a
  signed site depends on its ledger id, which needs the record, so there is no other way in. Probe with the real
  `resolvePointer` and the context `runHubRoot` builds: three attempts, all `E_NEEDS_CONSENT`, zero DoH requests;
  the `#magnet:` control resolves and yields its label. No test runs hub-root mode (`grep` finds no `hub-root`,
  `runHubRoot` or `#host:` case outside `parseFragment`).
- Scenario: a hub operator deploys `<meta name="mw-hub" content="subdomain">` and shares
  `https://hub.example/#host:shop.example`. Every first-time visitor sees "Could not find this site's address ...
  needs a DNS-over-HTTPS lookup, which waits for your choice" and a Retry button that shows the same card forever.
- Fix: in `runHubRoot`, read the consent record and on `E_NEEDS_CONSENT` show the blocking card (`askBeforeDns`, the
  card names the DoH service), then resolve with `dohAllowed: true` and redirect; or redirect `#host:` links to a
  hub-root interstitial that does the same.
- Test: `loader-app` unit driving `start()` (or `runHubRoot`) with `mw-hub=subdomain` and `#host:example.com`: the
  card appears, no DoH before the click, one DoH request after it, then `location.replace` to `<label>.<hub>`;
  e2e cannot use wildcard DNS here, so the unit test is the regression test.

### 11. LOW. The manifest ships a `magnet:` protocol handler that DESIGN-REVIEW keeps out of v1
- Where: `build.mjs:342` (`protocol_handlers: [{ protocol: 'magnet', url: '/?mw=%s' }]`), checked as wanted by
  `test/unit/tools-build.test.mjs:135-141`.
- Problem: DESIGN-REVIEW section 3 lists the protocol handler as LATER, "not advertised in v1". In the default
  per-domain mode `?mw=` is ignored (`resolveMode` returns shell), so an installed shop PWA would ask to open every
  magnet link and then show the shop.
- Fix: emit `protocol_handlers` only for hub deployments (a build or publish option), or drop it for v1.
- Test: `tools-build`: the default manifest has no `protocol_handlers`.

### 12. LOW. Which `aud=` tokens force the gate is stated three different ways
- Where: `src/loader/config.js:114` (`gateAudiences` includes `sensitive` and `kids`, as does INTERFACES and
  `src/loader/consent.js:26`); ARCHITECTURE section 4, 8 and 10 (only `personal`, `eea`, `eu`, `uk`, `qc`, `quebec`
  gate; `kids` and `sensitive` are content classes); `src/common/pointer.js:198` (comment: "kids forces
  host-only", implemented nowhere).
- Scenario: an owner sets `aud=kids` expecting host-only (pointer.js) or the notice (ARCHITECTURE); visitors get the
  blocking gate.
- Fix: decide the token table, then align ARCHITECTURE, config and the comment.
- Test: `loader-app-consent` unit pinning `consentModeFor` for each token.

### 13. LOW. Drop-in phones still destroy the client when hidden (v0.2), not C2's "lock uploads at once"
- Where: `src/dropin/engine.js:1243-1251` (`:1247` pauses), `:1258` (rebuild threshold).
- Problem: ARCHITECTURE section 8 (C2): a phone locks uploads when hidden and rebuilds on return; the shell does
  (`src/loader/torrent.js:746-768`), the drop-in engine pauses the TorrentManager. C2 is marked done. Second pass:
  the TorrentManager's own lifecycle hook (`torrent.js:727-756`) locks first, then the engine's handler destroys the
  client anyway; and the engine compares `hiddenFor` with `config.policy.rebuildAfterHiddenMs` (60 s, the desktop
  value) instead of the policy's 10 s phone value (`policy.js:187`).
- Fix: use `policy.hiddenAction` and `policy.rebuildAfterHiddenMs` as the shell does (lock on hidden, rebuild after
  more than 10 s on phones).
- Test: `dropin-engine` with a mobile environment: hidden keeps the client with every wire choke-locked; visible
  after 11 s rebuilds.

### 14. LOW. A4's wording promises more than any same-origin design can deliver
- Where: `docs/ARCHITECTURE.md:243-247`; key generation `src/loader/app.js:497` and `src/dropin/identity.js:125`
  (extractable pairs, stored as CryptoKeys in IndexedDB).
- Problem: even with finding 1 fixed, site code shares the origin: it can read the extractable identity key from
  IndexedDB `mw-sites` (store `keys`, `identity:<ledgerId>`) and export it, and it can write the `consent` record.
  "The only way an identity leaves or enters a drop-in origin" and "A site can never accept for the visitor" are
  true of the SDK surface only.
- Fix: scope both sentences to the SDK and say that site code is trusted with the visitor's per-site identity and
  storage (as section 3.4.9 already says of signing).
- Test: none (documentation).

### 15. LOW. ARCHITECTURE states behaviour the code does not have
- Where: `docs/ARCHITECTURE.md:202-204` (3.4.5: a new version is filled "from the previous version in IndexedDB";
  dropin deviation 5 says it is not); `docs/ARCHITECTURE.md:900-902` (section 14: Safari `resultingClientId`,
  first-visit control in Firefox and the iOS `DataCloneError` path "are settled by the integration tests";
  INTEGRATION-STATUS says real devices are needed and Firefox does not launch here). Second pass:
  `docs/ARCHITECTURE.md:859` (section 12: PEER-BLIP visitors "re-announce within a second"; the shim waits 500 ms
  plus up to 1 s of jitter, `test/e2e/peer-scenarios.mjs:240` passes anything under 6 s, and the runs measured
  1.5 s and 1.6 s).
- Fix: amend the three paragraphs to the code, the test bound and the open items.
- Test: none (documentation).

### 16. LOW. Several fixes reported as tested are asserted by matching source text
- Where: `test/unit/v021-integration.test.mjs:111-120` (ui.js guarded decisions by regex), `:122-128` (live.mjs by
  the absence of `hit.click()`), `:165-166` (app.js ConsentWaiters wiring by regex; the first pass cited `:157-159`, which are behavioural), `:177-178`
  (the E5 note is "printed" by a source slice).
- Problem: a refactor that keeps the strings but breaks the behaviour passes; INTEGRATION-STATUS presents these
  fixes as covered.
- Fix: behavioural tests (the PEER-CONSENT step covers the shell card already; add the live.mjs e2e of finding 8 and
  an app-level consent-request test with the real UI module).
- Test: the replacement tests themselves.

### 17. LOW. `package.json` still says 0.1.0
- Where: `package.json:3`; the "all say 0.2.1" test (`test/unit/v021-integration.test.mjs:99-103`) skips it.
- Fix: bump to 0.2.1 (or derive the runtime versions from package.json) and include it in the test.
- Test: the version test reads package.json too.

### 18. LOW. A browser unit test loads `http://localhost` in WebKit, against DEV-NETWORK.md
- Where: `test/unit/loader-common-browser.test.mjs:485` (DoH override template on `http://localhost`, used by the
  WebKit runs at `:506-509`).
- Problem: DEV-NETWORK.md: WebKit only for tests whose every URL is `http://127.0.0.1:<port>`. Localhost resolves
  locally, but the rule is binding for every agent, so `npm run test:browser` cannot be run under it as is.
- Fix: serve the DoH stub from a second listener on 127.0.0.1 (another port is another origin, so the request stays
  cross-origin).
- Test: the same subtest, with the template on `http://127.0.0.1:<port2>`.

### 20. LOW. "Share with other visitors: Off" still relays strangers' posts, and the approved text does not say so [new]
- Where: `src/loader/strings.js:50` (`settingsShare`, DESIGN-REVIEW section 4.5 verbatim); ARCHITECTURE section 8
  (`docs/ARCHITECTURE.md:670`); relaying is not gated on the setting anywhere (`src/chain/gossip.js` ANN on first
  acceptance, `src/chain/wire-ext.js`; the choke lock in `src/loader/torrent.js:368-384` stops piece uploads only).
- Problem: the switch reads as "this browser stops sharing", and its note mentions only the IP exposure. By design
  (item 19, e2e 12 "two-way gossip") an uploads-off visitor keeps relaying every ledger block it accepts to its
  other peers. With `writers: 'open'` those are posts by strangers, which section 4.5's owner-facing text calls
  content "you make visitors redistribute".
- Scenario: a visitor switches sharing off because the guestbook carries posts they do not want to pass on; their
  browser keeps forwarding new posts to every connected peer while the page is open.
- Fix: amend the approved line (DESIGN-REVIEW section 4.5, then `strings.js`, the drop-in panel), for example "Off
  stops sharing this site's files. Posts are still passed between connected visitors, and your IP stays visible.
  Choose Host only to stop all peer connections."
- Test: the examples/peer-guestbook wording test (`.dev/site.test.mjs`) or a `loader-app` strings test pinning the new text;
  e2e 12 already shows the behaviour the text must describe.

### 21. LOW. `st=` with an empty value is read as active; the fail-closed rule says only absent or `ok` are [new]
- Where: `src/common/pointer.js:184-188` (`pointerStatus`: `''` is treated like absent).
- Problem: ARCHITECTURE section 4 (A3): "absent or `ok` is active; any other value, an unknown one included, means
  withdrawn". A present but empty `st=` is another value. Probe: `parsePointer('v=mw1; st=; btih=...')` gives
  `status=active`, while `st=paused` gives `withdrawn`. The append-only golden vectors (`test/vectors/pointer.json`)
  do not pin the empty case yet, so the choice is still cheap to fix.
- Scenario: an owner's withdrawal pipeline emits `st=${STATUS}` with an empty variable; the record signs and
  verifies as active and visitors keep loading and seeding the site.
- Fix: treat a present empty `st` as withdrawn (or refuse the record as malformed), and append a vector for it.
- Test: a new `test/vectors/pointer.json` entry ("st= with an empty value is withdrawn"), locked in `LOCK.json`;
  `common-pointer` status table gains the empty value.

### 22. LOW. Drop-in asks for persistent storage outside the consent click (follower tabs) [new]
- Where: `src/dropin/engine.js:129-131` (`requestPersist()` inside `ConsentState.set`), reached from
  `src/dropin/ledger.js:171-173` when another tab broadcasts its choice.
- Problem: ARCHITECTURE section 8: "`navigator.storage.persist()` is requested only from the consent click itself
  (never at load: Firefox prompts)". The shell does it only in the click handlers (`persistFromGesture`,
  `app.js:1000-1005`, called from `onShare`/`onLoad`). In drop-in every tab that receives the `consent` broadcast
  calls it with no gesture of its own; the only test (`dropin-engine.test.mjs:245`) checks that it is called after
  consent.
- Scenario: a Firefox visitor with two pages of a drop-in site open clicks "Share and load" in one; the other tab
  asks for persistent storage on its own, and Firefox shows its permission prompt in a tab the visitor did not act
  in.
- Fix: move `requestPersist()` into the panel's Share and Load click handlers (as the shell does) and never call it
  from `set()`.
- Test: `dropin-engine-tabs`: a follower receiving `{ t: 'consent', state: 'accepted' }` makes no `requestPersist`
  call; the leader's click makes one.

## 6. Not verified by this review
- WebKit parts of `npm run test:browser` (finding 18) and anything in Firefox (not launchable here).
- Real devices: every item 25 row, S10, S11, iOS lifecycle, Android PoW timing.
- Findings 1, 2, 5, 6, 7, 8, 10 to 16, 20 and 22 come from reading the code at the cited lines; findings 4, 9, 19
  and 21 were reproduced with probes against the real modules; no product code was run in a browser for them.
- Subdomain-hub behaviour beyond finding 19 (label check, gate, consent per label origin) was read, not run:
  wildcard DNS is outside the local-only network policy.
- INTERFACES.md was read against the code for config, doh, cache, torrent, policy, connectivity, consent, render,
  bridge, api, ui, app, dropin, sw and sdk; the chain and tools sections only where cited.
