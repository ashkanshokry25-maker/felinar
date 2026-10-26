# post-wave fix: notes and deviations (2026-10-19 and 2026-10-20)

Agent: the post-wave fixer. Brief: items A to Q of the post-wave fix (the observations of the productionize wave's
writers, the fresh-eyes check and the editor), then the rest of the writers' 54 observations (K). Every change was
checked against the tree before and after. Nothing was pushed, tagged, published or deployed, no DNS or GitHub
setting was touched, and no network call was made: every browser was Playwright Chromium started with
`chromiumArgs()` from `test/e2e/browser-args.mjs`, or Playwright WebKit (the WebKit end-to-end run), on
`http://127.0.0.1` pages only. Times are Eastern.

The run started at 23:35 ET on 2026-10-19 on checkpoint `c2132eb` (tree clean, `npm test` 929 of 929). The
checkpoint loop committed the work in progress every 15 minutes; this agent made no commit.

## Already resolved before this pass (left as they were)

| Item | Resolved by | What was already right |
|---|---|---|
| A, in part | fresh-eyes, fix 5 | `egressNote`, QUICKSTART, FAQ and ROADMAP no longer said "measured" (they said "a worked example, arithmetic, not a measurement"), and the "smaller `--max`" advice was replaced by `--ignore`. MIGRATION's table already said "arithmetic from the formula, not measurements". |
| B, in part | fresh-eyes, fix 7 | README item 9 and WHY no longer said the meta pointer "needs no lookup" without the DoH update checks. |
| C | fresh-eyes, fix 8 (WHY); editor (FAQ) | No README or `docs/*.md` claim of a per-file SHA-256 check was left; the remaining SHA-256 mentions describe `files.json`, `build.lock.json`, `build.json` and block hashes, which do use it. |
| D | fresh-eyes, fix 11 | RUNBOOK section 10 said `mw.consent.request()`, section 6 said a rotation keeps the ledger (`lo=`), section 3 had the 929 count. |
| F | fresh-eyes, fix 14 | SECURITY-MODEL said unsigned `SHA256SUMS` ship now and signed checksums and attestations are 1.0 work. |
| I, in part | editor | The checklist had the changelog rename, the squash, the `gh` commands, a pin-check loop, the npm name row and the KayleePop row. |
| J | restructure, editor | `deploy/github-actions/publish-site.yml` exists, MIGRATION (`../deploy/...`) and `recipes/github-pages.md` (`../../deploy/...`) link to it correctly, and `release.yml` rewrites relative links in the notes to the tagged tree (read in the workflow: the `node -e` step, the `](...)` replacement with `blob/<tag>/`). |
| Writers' items | earlier passes | `docs/CRITIQUE.md` exists and `docs-links` is green; the `-VERIFY.md` false positive; `bug_report.yml` 0.2.1; dashes in ARCHITECTURE and INTERFACES; the `.dev` and `.fixture` moves with `package.json` and `ci.yml` following; the CHANGELOG "Added" list and the `.tgz` known gap; the tracked TLS key; the social-preview and OWNER steps in the checklist; the vector freeze and the changelog date as one command each (checklist section 8); the local git identity (section 3); "identity at the first write" (ROADMAP 1.0, recoverable identity). |

## What changed

| Item | Change | Files |
|---|---|---|
| A | The 13.3x figure is "a model (arithmetic, not a measurement)" everywhere, with its arithmetic (a 20 MB copy completed after a 1.5 MB page view, no peer help), as research w2a-07 F21 labels it ("Confidence: Model for the multiplier"). DIGEST-AMENDMENTS E5 had kept "the measured example". The E5 unit test pins the wording and refuses "measured". `harden-verify.md` (a record) gained a one-line correction instead of an edit. | `tools/publish.mjs`, README, WHY, ROADMAP, OPERATIONS, DEPLOY, FAQ, CRITIQUE, QUICKSTART (sample output), `review/DIGEST-AMENDMENTS.md`, `deviations/harden-verify.md`, `test/unit/v021-integration.test.mjs` |
| B | See "B: who a page-tag site contacts" below. Code: the card and the gate name the DoH service on every page that will ask it. Docs: what happens and when, the same in README, WHY, PRIVACY, RUNBOOK, ARCHITECTURE sections 4 and 8 and INTERFACES. | `src/loader/strings.js`, `ui.js`, `app.js`, `test/unit/loader-app-consent.test.mjs`, the documents named |
| C | ONBOARDING's "checked against the version's hashes" now says SHA-1 piece hashes of the version's torrent. | `docs/ONBOARDING.md` |
| D | The rest of RUNBOOK: the "what it needs" paragraph said a DoH service is needed only "if the pointer is published in DNS"; section 6 gained when the lookups happen; section 2 listed no `sdk-static.js` and said every bundle targets the floor (`boot.js` is built at ES5); section 5 said `--exp` at most 400 (publish allows 399); section 4 says how the demo keeps ledgers apart; section 10 and the outputs list follow item M; section 3 has this pass's counts. INTERFACES had the same stale `--exp` default (400) for `--withdraw`. | `docs/RUNBOOK.md`, `docs/INTERFACES.md` |
| E | `snapshot` says every loader reads the gzip file, also Safari and iOS 15.4 to 16.3 without `DecompressionStream`, and that `--plain` writes plain JSON if you prefer; it warns when a gzip file is named `.json`. The test that pinned the old text pins the new one. DEVIATIONS.md and `deviations/tools.md` (the v0.2 note that repeated it) gained a "superseded" line. | `tools/snapshot.mjs`, `test/unit/tools-snapshot.test.mjs`, `docs/DEVIATIONS.md`, `docs/deviations/tools.md` |
| F | Nothing left (see above). | |
| G | Counts measured after the last change (section "Verification"), written into README, CHANGELOG, RUNBOOK, CRITIQUE, PUBLISH-CHECKLIST and INTEGRATION-STATUS ("post-wave" entry). `docs/README.md` holds no counts. | those files |
| H | See "H: the 178 bytes" below. `progress.uploaded` counts piece data sent on peer wires only; `inspect()` reports `uploaded`; one unit test, and checks in end-to-end scenarios 7 and 10B. | `src/loader/torrent.js`, `app.js`, `src/dropin/engine.js`, `test/unit/loader-app-torrent.test.mjs`, `test/e2e/run.mjs`, SDK, INTERFACES |
| I | The checklist: the pin check compares every pin with its tag's commit (`git ls-remote`) and says the pins were set offline; the sequence block gained it (4b), the npm name check (4c) and the npm claim (5b); section 11 says the first CI run is the first real run (Node 22, Playwright's system packages, the Docker images, the Caddyfile); the manual release builds the same zip (a `dist/` folder) and the same notes as `release.yml`. | `docs/PUBLISH-CHECKLIST.md` |
| J | A new `docs-links` test checks every relative link target of any kind (not only `*.md`) in README, `docs/*.md`, the recipes and the example READMEs; it found nothing broken. | `test/unit/docs-links.test.mjs` |
| K | Below, one row per observation. | |
| L | Each demo site folder gets its own ledger: a chain label `demo-<folder>-<6 random hex>` made up once and kept in `.tools/demo/sites.json` (the label never holds the path), and its own publish directory `.tools/demo/publish/<label>/`. One demo key still signs every site, so the browser never sees "publisher key changed". Tests: the guestbook and another folder get different ledger ids; running the guestbook again keeps its ledger id and genesis; labels are stable, distinct for two folders of the same name and within the 64 characters `--chain` allows. | `tools/demo.mjs`, `test/unit/tools-demo.test.mjs`, QUICKSTART, RUNBOOK, CRUD |
| M | `publish --dropin` writes no `webseed-layout.txt` and removes one an earlier shell publish left in the same `--out`; its `csp.txt` says drop-in pages never query DNS instead of listing the DoH resolvers. The shell `webseed-layout.txt` says the patched client sends only `Range` (B3) and, per research w1-10 F5, that the managed CloudFront policies send no `Access-Control-Allow-Headers`: a custom response headers policy, or S3 answering through `CORS-S3Origin` (untested), as DEPLOY.md says. | `tools/publish.mjs`, `test/unit/tools-publish.test.mjs`, RUNBOOK, QUICKSTART, MIGRATION, ARCHITECTURE section 10, DEPLOY |
| N | `src/dropin/mw.js`: the handle comment lists `{ version, started, inspect(), openSettings(), rectOf(label) }` without the engine; the tag in the header carries `data-cfasync="false"`; the bundle size is the measured 222,343 bytes. The snapshot test of item E is updated. | `src/dropin/mw.js` |
| O | Checklist: the npm name (section 1 row, section 11 step, sequence 4c and 5b): check it, claim it with the real package before the repository is public, or move the documents to `node bin/magnet-web.mjs` or a scoped name. | `docs/PUBLISH-CHECKLIST.md` |
| P | See "P: privacy scrub" below. | 105 files |
| Q | After a rotation (`lo=`) `publish` says to keep the snapshot with the owner hand-over at `cs=` and not to upload `genesis.json` there; without a rotation the old hint stays. `ledger-admin` writes a gzip ledger file back as gzip (and `genesis --out *.gz` writes gzip). A test for each. | `tools/publish.mjs`, `tools/ledger-admin.mjs`, `test/unit/tools-publish.test.mjs`, `test/unit/tools-ledger.test.mjs` |

## H: the 178 bytes

Measured with a probe on loopback (`setupStack` of `test/e2e/lib.mjs`, a fresh visitor, consent left pending for
8 s, then the same for the drop-in fixture):

| Before the fix | Shell | Drop-in |
|---|---|---|
| WebSockets opened | none | none |
| tracker announces | 0 | 0 |
| `RTCPeerConnection` created (the e2e wrapper counts them in every frame) | 0 | 0 |
| requests that left 127.0.0.1 | none | none |
| requests at all | the host: the loader, `/ws/peer-guestbook.torrent`, one ranged GET per file, `genesis.json` | the host: the pages, `/_mw/`, 8 `/_mw/ws/` requests |
| `progress.uploaded` | 178 | 178 |
| the guestbook's transfer line | "0 B from peers, 62.4 KB from the web seed, 178 B passed on to others" | (no transfer line) |

Nothing left the page before the first-run choice: no tracker, peer, STUN or DoH contact (on 127.0.0.1 the loader
never asks DoH; on a public hostname the code waits for the choice, `dnsAllowedBy` in `scheduleUpdateCheck` and
`dnsCandidate`). The only traffic was HTTP to the host and its web seed, which C1 allows before a choice. So C1 was
not broken; the metric was wrong.

What the bytes are: WebTorrent's `torrent.uploaded` adds every chunk a peer's write pipeline passes on
(`Peer.setThrottlePipes`, the `upload` Transform), and a web seed is a peer whose connection is an in-memory
`WebConn` that turns `request` messages into HTTP Range GETs. The page's own wire writes its handshake, extended
handshake, interested, request and have messages to it. A Node replica of a web-seed-only download (the same
`webtorrent` 3.0.21 and `bittorrent-protocol` 5.0.9 from `node_modules`, one piece, a loopback HTTP seed) counted
177 B in the chunks 68, 5, 62, 5, 5, 1, 17, 9 and 5, while the wire's own `uploaded` (piece payload only) stayed 0;
the browser's 178 B fits the same messages with a slightly larger extended handshake (more metadata). After
consent the same counter adds the protocol messages of every peer wire, which explains the 165 B with only a
complete seeder connected and the 421 to 651 B with a second complete visitor that the marketing writer saw: none
of them was file data passed on.

The fix: `TorrentManager` counts `uploadedBytes` from the `upload` events of peer wires (bittorrent-protocol emits
them only for piece payloads, `Wire.piece`), never from web-seed wires and never from `torrent.uploaded`, and resets
it with the other byte counters when a new version downloads. After the fix the probe saw `uploaded` 0 in both modes
and the transfer line "0 B from peers, 62.4 KB from the web seed". Tests: `loader-app-torrent` (a web-seed wire and
WebTorrent's 178 B give 0; a peer wire's 650 B of protocol messages give 0; a 16 KiB piece gives 16384; with the old
metric the test fails), end-to-end scenario 7 (shell, consent pending: no WebSocket, no `RTCPeerConnection`, no
announce, `inspect().uploaded` 0, no "passed on" in the transfer line) and 10B (drop-in, before consent: no
`RTCPeerConnection`, `inspect().uploaded` 0). `progress.uploadSpeed` is still WebTorrent's rate over every byte; SDK.md
says so and ROADMAP has a row.

## B: who a page-tag site contacts

What the code does (`src/loader/app.js`: `resolveSitePointer`, `dnsCandidate`, `afterRender`, `setConsent`,
`scheduleUpdateCheck`, `checkForUpdate`; `src/loader/consent.js` `dnsAllowedBy`; `config.pointer.minTtlMs` 300000,
`focusRecheckMinMs` 60000):

- Before any choice no DoH request is made. A cached DNS answer still counts (local data).
- "Share and load" (or the gate's "Load") stores `dns: true`. Then a shell or hub page whose host is not skipped
  (`shouldSkipDoh`: localhost, IP literals, single labels, `.local`, `.test`, `.example` and others) asks for
  `_magnet.<host>` right after the choice (on a later visit, after render, unless a cached answer is fresh), then
  every 5 minutes or the answer's TTL, and on focus or visibility at most once a minute, whether or not a record
  exists.
- "Load from host only" stores `dns: false` on a page-tag site: no lookup. On a site found only through DNS both
  buttons of the blocking card allow the lookup, and the checks continue on the same schedule.
- `<meta name="mw-doh">` replaces the three resolvers with one. Drop-in never queries DNS.

Before this pass the non-blocking card named the resolvers only on a DNS-only site; on a page-tag site it covered
them as "connection servers run by third parties", which the documents use for trackers and STUN servers. Now the
card adds `consentDnsUpdate` ("If you choose to share, your browser also asks a DNS-over-HTTPS service (Cloudflare,
dns.sb or Google) whether this site has a newer version, at most once a minute while this page is open. That service
sees your IP address and the name of this site.") and the gate `gateDnsUpdate` on every page that will ask; the DNS-only
card adds `consentDnsAgain`; an `mw-doh` host replaces the default names (`strings.dohNamed`). The consent record and
its version are unchanged: no 0.2.1 record exists outside this machine, and the recipients key still holds the
trackers and STUN servers only (PRIVACY.md says a new `mw-doh` does not ask again).

## P: privacy scrub

`git grep -l '<username>'` listed 105 tracked files, all text: 104 under `docs/research` and
`docs/review/code-review-security.md`. In all of them `/Users/<username>` became `$HOME` (873 places) and the other
forms of the username (the scratch path `-Users-<username>-...`, 19 places) became `owner`. No file name held it.
`.orchestration/` (ignored) and `node_modules/` were not touched. Afterwards `git grep` finds the username nowhere and
`/Users/` only in the two example paths that stay (`/Users/you/keys/...`, `/Users/me/...`). `npm test` passed right
after the scrub (929 of 929). The checkpoint history still holds the old text; the squash of checklist section 10
publishes one commit without it, and the bundle it keeps stays local.

### Owner decisions (not changed)

Every remaining tracked line that names the owner or a hardware security key, as of the end of this pass. No prose
was deleted.

**The owner's first name** (28 lines as of 2026-10-21, line numbers refreshed by the v0.3 verify fix round 2: the research notes and the v0.3 design review address the owner as the person who approves outbound steps and decisions, and three unit tests, a fuzz target and a lab script use it as a sample display name):

- `docs/research/PRODUCTION-DIGEST.md`: 29, 111, 143, 144, 152, 159, 172, 308, 380, 679
- `docs/research/labs/w2b-02-probes/blocksize.mjs`: 9
- `docs/research/labs/w2b-02-probes/relay-write-probe.mjs`: 8, 9, 17
- `docs/research/w2b-02-nostr-durability.md`: 629, 651
- `docs/research/w2b-05-security-hardening-prod.md`: 291, 309, 327, 425
- `docs/review/V03-DESIGN-REVIEW.md`: 788, 1386
- `test/fuzz/targets/chain.mjs`: 530
- `test/unit/dropin-binding.test.mjs`: 113, 115, 159
- `test/unit/dropin-leader.test.mjs`: 319
- `test/unit/sw-sdk.test.mjs`: 238

**The owner's hardware security key, by model** (Token2; 9 lines):

- `docs/research/PRODUCTION-DIGEST.md`: 143, 313
- `docs/research/w2b-05-security-hardening-prod.md`: 16, 115, 117, 311, 327, 493, 538

**Hardware security keys in general** (vendor research on WebAuthn, PRF and signing, plus this decision's own wording in the checklist, the ROADMAP's hardware-backed signing item and the editor's note; none names the owner's key):

- `docs/PUBLISH-CHECKLIST.md`: 302, 386 (the later rounds moved these lines; as of the v0.3 verify fix round 2)
- `docs/ROADMAP.md`: 215
- `docs/deviations/editor.md`: 113
- `docs/research/labs/w2a-06-lab/e2-external-signer.mjs`: 1
- `docs/research/w1-11-security-threats.md`: 307, 480
- `docs/research/w2a-03-dynamic-feature-replacements.md`: 200, 210, 212, 213, 409, 495
- `docs/research/w2b-05-security-hardening-prod.md`: 98, 100, 102, 106, 111, 113, 116, 120, 320, 531, 533, 570
- `docs/research/w2c-03-identity-ux-VERIFY.md`: 176, 182, 185, 189, 192, 255
- `docs/research/w2c-03-identity-ux.md`: 26, 121, 125, 128, 132, 140, 149, 150, 296, 337, 344

**Found on the way** (not in the brief's list, also left for the owner):

- The machine's short hostname in two lab outputs (uname lines): `docs/research/labs/w2c-05-testing-lab/results-2026-10-17.txt:2`, `docs/research/labs/w2c-05-testing-lab/results-firefox-2026-10-17.txt:1`.
- A public IP address, a STUN server's answer (an srflx candidate), in `docs/research/labs/w1-13-lab/results/a5-webrtc-interop.json:44`, `docs/research/labs/w1-13-lab/results/a5-webrtc-interop.json:48`. It shows the network the machine used on the day of the lab run.
- The research vantage point (the Cloudflare colo that answered, a city code) in `docs/research/05-doh-dns-txt.md:24`, `docs/research/05-doh-dns-txt.md:251`, `docs/research/05-doh-dns-txt.md:521`.
- The build machine's model and OS (MacBook Air, Apple M3, macOS 27) in research environment notes, for example `docs/research/06-browser-chain-vs-crdt.md:10`: hardware context of the measurements, low risk.

To replace the first name, run `git grep -n -w Ash` and edit each line (the three test files only use it as a display name, so any other name works there). The public IP address can be replaced with a documentation address such as `203.0.113.1` in that JSON file without changing any conclusion.

## K: the writers' 54 observations

| # | Writer | Observation | Status |
|---|---|---|---|
| 1 | marketing | CRITIQUE.md missing, docs-links red; CONTRIBUTING's VERIFY.md | resolved earlier |
| 2 | marketing | `progress.uploaded` above 0 before any peer | fixed (H) |
| 3 | marketing | egressNote and DIGEST-AMENDMENTS E5 say "measured example" | fixed (A) |
| 4 | marketing | npm name unchecked; KayleePop/magnet-web exists | checklist (I, O) |
| 5 | marketing | social preview PNG; OWNER in the landing page | resolved earlier (checklist sections 4 and 12) |
| 6 | migration-compat | `publish-site.yml` missing; docs-links checks only `.md` | resolved earlier; new link test (J) |
| 7 | migration-compat | docs-links red until CRITIQUE and VERIFY | resolved earlier |
| 8 | migration-compat | 13.3x "measured"; egressNote's smaller `--max`; drop-in `csp.txt` lists DoH | fixed (A, M); `--max` resolved earlier |
| 9 | migration-compat | RUNBOOK sections 10, 6, 3; CloudFront advice; silent `_redirects` skips | RUNBOOK resolved earlier and rescanned (D); fixed (M); fixed: publish names skipped lines (shell mode), MIGRATION updated, test |
| 10 | migration-compat | frameworks, hosts, Firefox, Safari, phones unverified | documented in each document; release gate (owner, DEMO-RESULTS) |
| 11 | onboarding-crud | CONTRIBUTING line 279 trips docs-links | resolved earlier |
| 12 | onboarding-crud | RUNBOOK `mw.consent.accept()` | resolved earlier |
| 13 | onboarding-crud | RUNBOOK rotation and counts | resolved earlier; counts re-measured (G) |
| 14 | onboarding-crud | `snapshot` Safari 16.4 message | fixed (E) |
| 15 | onboarding-crud | `ledger-admin` plain JSON under `.json.gz` | fixed (Q) |
| 16 | onboarding-crud | `mw.js` header lists `engine` | fixed (N) |
| 17 | onboarding-crud | ROADMAP: drop-in moderator import, unban, SDK read with author and `h` | moderator import already a row; ROADMAP row added for the other two |
| 18 | governance-roadmap | test counts moved | measured (G) |
| 19 | governance-roadmap | release notes copy relative links verbatim | resolved earlier (`release.yml` rewrites them); manual path made equal (I) |
| 20 | governance-roadmap | SECURITY-MODEL says checksums are future work | resolved earlier (F) |
| 21 | governance-roadmap | action pins unverifiable offline | checklist: tag comparison loop, owner step (I) |
| 22 | governance-roadmap | tracked key; paths, username, first name, hardware key; real git identity in the squash | key resolved earlier; scrub done and the rest listed (P); identity step resolved earlier |
| 23 | governance-roadmap | no statement that AI agents produced the work | checklist decision row (owner) |
| 24 | governance-roadmap | dashes in ARCHITECTURE and INTERFACES | resolved earlier |
| 25 | governance-roadmap | `FROZEN` ends at 28, LOCK has 33 | resolved earlier as an owner command (checklist section 8) |
| 26 | governance-roadmap | `bug_report.yml` says 0.2.0 | resolved earlier |
| 27 | governance-roadmap | `.dev` moves and the npm scripts | resolved earlier |
| 28 | governance-roadmap | no "no incentive layer" clause in ARCHITECTURE section 8 | fixed: the clause (ID P0-25, w2c-07 R2); INTERFACES has no reward or credit symbol |
| 29 | governance-roadmap | OWNER placeholders; pages-demo needs a custom domain | resolved earlier (checklist sections 1, 4, 12) |
| 30 | governance-roadmap | licensing line, commit prefixes, private-first: policy choices | checklist decision row (owner) |
| 31 | restructure | no workflow has run on GitHub | checklist section 11 and CHANGELOG known gaps (I) |
| 32 | restructure | Node 22 untested | same |
| 33 | restructure | no Docker image built; `stream_timeout 24h` | same |
| 34 | restructure | release.yml rewrites links; the zip holds a `dist/` folder | checklist section 14 fixed (it said "the contents of `dist/`") |
| 35 | restructure | CHANGELOG Added and known gaps | resolved earlier |
| 36 | restructure | landing README could mention `pages-demo.yml` | fixed |
| 37 | restructure | scripts and CI follow a `.dev` move | resolved earlier |
| 38 | restructure | Dependabot docker ecosystem | fixed for `deploy/pin`; the compose file is a ROADMAP row |
| 39 | deploy-ops-security | no host, DNS or CI recipe run against a real account | documented ("based on documentation"); owner (release gate) |
| 40 | deploy-ops-security | release gate not run | owner (DEMO-RESULTS, checklist section 9) |
| 41 | deploy-ops-security | meta pointer "needs no lookup"; the card names resolvers only for DNS-only sites | fixed (B) |
| 42 | deploy-ops-security | WHY "against its SHA-256" | resolved earlier (C) |
| 43 | deploy-ops-security | RUNBOOK sections 6 and 10 | resolved earlier (D) |
| 44 | deploy-ops-security | `webseed-layout.txt` predates B3; CloudFront advice | fixed (M) |
| 45 | deploy-ops-security | drop-in `csp.txt` lists DoH | fixed (M) |
| 46 | deploy-ops-security | `--prev-key` upload hint | fixed (Q) |
| 47 | deploy-ops-security | `snapshot` Safari 16.4 | fixed (E) |
| 48 | deploy-ops-security | `ledger-admin` gzip | fixed (Q) |
| 49 | deploy-ops-security | publish.mjs "measured example" | fixed (A) |
| 50 | deploy-ops-security | the posting identity is created before consent and before any post | ROADMAP (1.0, recoverable identity "created at the first write") already holds it |
| 51 | deploy-ops-security | no owner setting forces host-only for children's sites | ROADMAP row |
| 52 | deploy-ops-security | a production subdomain hub needs `mw-hub` by hand | ROADMAP row (`publish --hub`) |
| 53 | deploy-ops-security | `check-webseed` by hand misreads a same-origin seed | ROADMAP row |
| 54 | deploy-ops-security | "Forget this site" deletes stored versions only | ROADMAP row |

## Deviations from the brief

1. **Item B changed code, not only words.** The brief allowed either; making the card name the service the choice
   covers was the honest fix, since the alternative (documents that say the card covers DoH as "connection servers")
   would describe a gap. It adds three strings and two UI options; the consent version and the recipients key are
   unchanged (no 0.2.1 record exists in the wild).
2. **`inspect()` gained `uploaded`** in both modes, so the end-to-end checks are deterministic: the SDK's `progress`
   push arrives at a moment that depends on timing.
3. **`_redirects` warnings only in shell mode.** In drop-in mode the host keeps applying its own rules.
4. **The demo label is random, not derived from the path**, so the pointer of a LAN demo doesn't carry a hash of a
   home directory.
5. **The owner decisions were listed, not changed** (P): first name, hardware key, plus the hostname and the public IP
   address found on the way, which the brief did not name.

## Verification

Final runs, 2026-10-20 from 00:35 to 00:40 ET, after the last change to code and tests (macOS, Node 24.22, loopback
only):

- `npm test`: lint-floor clean (62 files), 937 of 937 pass, 0 fail (929 at the start, plus 8 new tests: H, B, two
  for Q, two for M including the `_redirects` names, L and the link test of J; existing tests gained assertions for
  A, E, L and M).
- `npm run test:e2e`: 25 of 25 PASS and network policy PASS ("every request stayed on 127.0.0.1"), 127.5 s.
- `npm run test:e2e:webkit`: 26 of 26 and network policy PASS, 129.5 s.
- `npm run test:browser`: 31 pass, 1 skipped (v0.1 `sw-browser`, unchanged). `npm run test:example`: 29 pass.
- `npm run build` and `node build.mjs --check-lock`: the vendored bundle matches `build.lock.json` and the five
  patches apply. Bundle sizes re-measured on this build (`gzip -9`): `loader.js` 357,499 bytes raw, 117,242 gzip;
  `mw.js` 323,225 raw, 105,072 gzip; `webtorrent.min.js` 222,343 raw, 64,297 gzip. WHY's "about 117 KB, 64 KB and
  105 KB" still hold; the ROADMAP size row now says 323 KB and 357 KB.
- `npm pack --dry-run`: 87 files, 482.0 kB packed (481,961 bytes), all of them `bin/magnet-web.mjs`, `src/`, `tools/`,
  `build.mjs`, `build.lock.json`, `test/e2e/browser-args.mjs`, README, LICENSE and `package.json`.
- Earlier in the pass: `npm test` 929 of 929 right after the privacy scrub; a first full round (00:22 to 00:30 ET)
  gave the same counts; `node test/e2e/run.mjs --only 7,10,10B` passed with the new checks before the full runs.
- Greps of PUBLISH-CHECKLIST sections 3 and 5 over the tree: the username nowhere, `/Users/` only in the two example
  paths, no dashes or curly quotes in the user-facing documents or in this file, banned words only where a rule
  quotes them.
- No process from these runs was left behind (no `hang.test.mjs`, tracker, dev server or headless browser).

Not verified here, because it needs the network or a real device: the pin check against GitHub, the npm name, every
workflow, the DoH sentences on a real public hostname (unit-tested; the end-to-end suite runs on 127.0.0.1, where no
lookup happens), and the drop-in and shell cards on phones.

## Round 2 (2026-10-20, after the independent verifier)

Brief: the not-ready findings of [post-wave-verify.md](post-wave-verify.md), seven fixes and nothing else. Same rules
as before: nothing pushed, no network call, every browser on `http://127.0.0.1` with the local-only Chromium flags.
Each change was checked against the file before and after.

| # | Change | Files |
|---|---|---|
| 1 | The checklist no longer offers to push the checkpoint history. Section 1's row "One squashed commit, or the history" became "The checkpoint history: not a choice"; section 3 says the history holds the w1-13 lab's private TLS key (every commit from `735f349` until `621455b` removed it; git shows the key in all 48 commits up to `095ed87`, its parent) and the home path and username (from `735f349` until the scrub, `3130928`, and the username once more in `2d1862f`), so it is never pushed; section 10 is required, says why, and lost its "keep the history" paragraph. Only the squashed orphan commit is pushed; the bundle is a local safety copy that stays on this machine or is deleted, never pushed, attached, uploaded or synced. | `docs/PUBLISH-CHECKLIST.md` |
| 2 | A step right before the squash, in section 10 and sequence step 5: `kill $(cat .orchestration/checkpoint-loop.pid)`, then `sleep 1; kill -0 ...`, which must fail. The text says why (`.orchestration/checkpoint.sh` runs `git add -A` and commits with the placeholder author every 15 minutes, 24 times) and that `.orchestration/` is ignored and never in the tree. | same |
| 3 | Section 3's name check: the short-name grep from "Owner decisions" above, the whole `git config user.name` instead of its first word, and the hostname grep, with a sentence that points at the list. | same |
| 4 | "The whole sequence" holds every command of the page except the checks of sections 2, 3, 5 and 7 and the commands for another route, an option or a repair, which its header now names. Added in order: the `OWNER` guard (step 2), the vector head print and `git diff CHANGELOG.md` (3), `npx playwright install`, `test:browser`, `test:example` and `test:e2e:webkit` (4), the unpinned-action grep (4b), the loop stop, the fresh-clone check and `git log` (5), `gh auth status` and `gh run watch` (6), the Pages certificate check (8), the label loop (8b, which creates `compatibility` for `site_compat_report.yml`), the social preview export (8c), the download and `SHA256SUMS` check (10) and the public fresh clone of section 15 (11). Section 11 runs `gh auth status` too. The new comment lines hold no apostrophe, backtick or redirection, so a zsh without `interactive_comments` cannot misread them. | same | [Round 3 correction: sequence lines 32, 39, 53, 73, 80, 95 and 121 hold a ";" inside a comment, which such a zsh splits into two commands; both halves are plain words that fail harmlessly. The checklist tells zsh users to set the option first.]
| 5 | The host-only sentence is qualified: no lookup on a site with a page tag; on a site found only through DNS either load button makes the lookup and the page keeps checking (`askBeforeDns` in `src/loader/app.js` resolves with both buttons, the pointer is then resolved with `dohAllowed: true`, and `readConsent` stores `dns: true`). | `README.md`, `docs/WHY.md`, `docs/SECURITY-MODEL.md` |
| 6 | Item 7 of the merged v0.2 drop-in note gained a superseded mark: A4 removed `mw.consent.accept()`, and `mw.consent.request()` opens the loader's card instead. | `docs/DEVIATIONS.md` |
| 7 | Section 7 says "about 482 kB, 87 files" instead of a byte count. | `docs/PUBLISH-CHECKLIST.md` |

Line numbers that moved: the two checklist lines that "Owner decisions" lists under hardware security keys in general
(118 and 194) are now 175 and 253, and the checklist now quotes the short-name grep at line 258, so that grep prints
27 lines: the 25 of the list, the command in this file and the one in the checklist.

Verification, 2026-10-20 (macOS, Node 24.22, loopback only, `ALLOW_REMOTE` unset):

- `npm test`, 01:40:32 to 01:40:39 ET: lint-floor clean (62 files), 937 of 937 pass, 0 fail; the four `docs-links`
  tests pass.
- `npm run test:e2e`, 01:40:51 to 01:42:58 ET: 25 of 25 PASS in 127.5 s, and "PASS network policy: every request
  stayed on 127.0.0.1".
- `npm pack --dry-run`: 87 files, 482,043 bytes packed (npm prints 482.0 kB); `README.md` is the only packed file
  this round changed. No key, local state or dependency folder in the list.
- No process from these runs was left behind.

Seen and not changed (outside the brief): `README.md` line 36 says that nothing connects to a DNS-over-HTTPS
service until the visitor chooses "Share and load", but on a site found only through DNS "Load from host only"
allows the lookup as well. FAQ and QUICKSTART say "before a choice", which holds.

## Round 3 (2026-10-20 06:55 ET; orchestrator, no agent: the Workflow launch was refused by the permission classifier)

The round-2 verifier closed all seven findings and found one new defect, N1 (`docs/deviations/post-wave-verify.md`,
Round 2): `saveConsentRecord` stored `dns: dns || dnsAllowedBy(previous record)`, so on a page-tag site a visitor who
had accepted before and was asked again (recipients changed) kept the DNS-over-HTTPS update checks after choosing
"Load from host only", against the card and gate strings and six documents.

| # | Change | Where |
|---|---|---|
| N1 | The earlier record's DNS permission carries over only when the site was found through DNS (`A.resolved.dnsNeedsConsent` false); on a page-tag site host-only stores `dns: false`. | `src/loader/app.js` `saveConsentRecord` (exported for tests) |
| N1 test | Accepted record, recipients change, re-ask, host-only: `dns: false` and `dnsAllowedBy` false on a page-tag site; `dns: true` on a DNS-only site. Fails on the old line (checked by toggling it). | `test/unit/loader-app-consent.test.mjs` |
| nit a | The loop stop checks that the stored pid runs `checkpoint.sh` before killing it and prints "loop stopped" or "loop STILL RUNNING". | `docs/PUBLISH-CHECKLIST.md` sequence step 5, section 10 |
| nit b | The bundle is written under `$TMPDIR` (does not sync), with the note that it may be cleared on reboot. | `docs/PUBLISH-CHECKLIST.md` sequence step 5, section 10 |
| remark | The round-2 remark about zsh comment lines corrected in place (line 278). | this file |

Runs after the change (2026-10-20 06:55 ET): `npm test` lint-floor clean (62 files), 938 of 938; `npm run test:e2e` 25 of 25,
network policy PASS, 127.1 s. Counts updated in README, CHANGELOG, RUNBOOK, CRITIQUE, PUBLISH-CHECKLIST and
INTEGRATION-STATUS. Not re-run: test:browser, test:example, test:e2e:webkit (the change is one condition in the
consent record path, covered by the unit test and PEER-CONSENT). The independent re-verification of N1 has not run.

