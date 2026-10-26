# felinar v0.2: deviations and notes from every builder

This file merges the per-agent notes in `docs/deviations/` (merged 2026-10-19 by integration-2). The originals stay
in that directory and remain the source: when an agent's note changes, edit the original and merge again. Each
agent's section below is its file verbatim, with headings moved down one level (one en dash in chain-base was
written out). Read ARCHITECTURE.md and INTERFACES.md first: these notes record where the build differs from them,
or how an ambiguous point was read, and why.

**v0.2.1 (2026-10-19, read in place, not merged here):** the hardening notes are in `docs/deviations/formats.md`,
`docs/deviations/network.md`, `docs/deviations/serving-publishing.md` and `docs/deviations/harden-verify.md` (the
verifier's integration fixes and the CHANGELOG 0.2.1 draft); code review round 1 is section 7 of
`docs/review/DESIGN-REVIEW.md`; the notes of the documentation and release wave are the other files in
`docs/deviations/` (`restructure.md`, `marketing.md`, `onboarding-crud.md`, `migration-compat.md`,
`deploy-ops-security.md`, `governance-roadmap.md`, `fresh-eyes.md` and `editor.md`).

**v0.3 (2026-10-20, read in place, not merged here):** the notes of the twelve build lanes of the v0.3 program are
`docs/deviations/freeze.md`, `harden-loader.md`, `idcore.md`, `chat.md`, `media.md`, `ui.md`, `docs.md`, `idp.md`,
`chain-net.md` (its v0.3 section), `tools.md` (its v0.3 section), `sdk.md` and `examples.md`; the integrators' notes (after
wave 1, findings I-1 to I-8; the reconciliation after the SDK lane, R-1 to R-17; and the final integration, F-1 to F-14
with the status of every end-to-end row of the design review's test plan) are in `docs/deviations/integration-v03.md`.
The contracts they changed are folded into ARCHITECTURE section 15 (15.13 lists the final integration's) and the v0.3 part
of INTERFACES. The deviations that change what a reader of the design review would expect, in one place:
- a personal site's pointer repeats the template's `tr=`, `ws=`, `xs=` and `idp=` (R 3.3 lists fewer fields; without them a
  new personal page cannot load the template) (final integration F-1);
- `<mw-chat-panel>` shows no consent card of its own: `mw.chat.enable()`'s loader card is the one consent (F-6);
- `mw.files.preview` returns text for a text file and a `blob:` URL of a re-drawn PNG for a picture, not a `/_mw/f/`
  address (F-13);
- the social template keeps "who may post on my wall" in the profile item, not in `_mw.cfg.wall`: the schema takes `wall`
  since code review v0.3, but a loader older than that hides a `_mw.cfg` with an unknown key as a whole (examples D-2); notices are direct messages that start with `mwn1:` (examples D-3); the
  Example Forum switches chat on with `_mw.cfg.chat = 'open'`, because its visitors read its ledger and never write to it
  (F-12);
- Argon2id is plain JavaScript (1.3 to 2.5 s at 64 MiB on an M3, measured by lane idcore), and the curve point of a derived
  key comes from `src/identity/p256.js` (not constant time, run at the identity origin only);
- grants travel only as sealed direct messages: durable grants (kind 4 items) have no reader yet (reconciliation R-9);
- the hub follow lane joins as the `'group'` wire-budget kind (no `'hub'` kind yet).

**v0.3 C2 (2026-10-20, read in place, not merged here):** the notes of the eight C2 lanes are `docs/deviations/seed-policy.md`,
`pin-node.md`, `calls.md`, `zero-setup.md`, `docs-strings.md`, `seed-engine.md`, `wire-ui.md` and `doors.md`; the integrator's notes
(findings C2-1 to C2-24, the e2e scenarios E-PS-1 to E-PS-4, E-ZS-1, E-CL-* and DOOR-*, and the open items) are in
`docs/deviations/integration-c2.md`. The contracts they changed are in ARCHITECTURE 8.1, 15.14, 15.15 and 15.16 and the "v0.3 C2" part of
INTERFACES. The deviations that change what a reader of [the C2 design](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) would expect:
- no path carries a pin request from a member's page to the pin node: `files.pinRequest` and `media.pinRequest` answer `E_POLICY`, and the
  owner's automatic request (SZ-6) requests nothing from a browser (integration O-1; proposed for v0.4). The node takes a request only
  with its author's signature since the v0.3 code review (`src/pin/frames.js` `makePinRequest`);
- `calls.hangup`, `calls.mute` and the reads are not host-only, so a call can always be ended (wire-ui 1; INTERFACES said every `calls.*`);
- the carry meter is in Settings, "Sharing", not in the loader bar, and shows its lines only when they report someone else (C2-10);
- the call panel sits at the top right on computers too, and takes its styles from the shell's loaded `ui.css` (C2-12, C2-13);
- "same local network" and "Hide my IP from people I call" have no switch or strings in C2; in a development build
  `window.__mwShell.setCallPrefs` sets them for a page (C2-9);
- the session figure of the budgets table applies to each lane, and dock mode counts as the opt-in for K and E (seed-policy readings,
  ARCHITECTURE 8.1.3);
- calls are mounted in shell and hub mode only; drop-in mode answers `E_UNSUPPORTED` for every `mw.calls` method.

**Paths since 0.2.1:** the notes below keep the paths of their time. `examples/peer-guestbook/.dev/` is now
`test/example/` (run with `npm run test:example`), `examples/existing-site-dropin/.fixture/` is
`test/fixtures/existing-site-dropin/`, `example-site/` is `examples/peer-guestbook/` and `test/fixtures/existing-site/`
is `examples/existing-site-dropin/`.

| Section | Agent | Scope |
|---|---|---|
| 1 | orchestrator-notes | Facts observed on this machine before the finishing build |
| 2 | chain-base | `src/chain/canonical.js`, `src/chain/crypto.js` |
| 3 | chain-net | `src/chain/{gossip,wire-ext,stores,node}.js` |
| 4 | tools | `tools/*`, `build.mjs`, `.npmrc`, `build.lock.json`, `package.json` scripts |
| 5 | dropin | `src/dropin/*`, `examples/existing-site-dropin/**` |
| 6 | example | `examples/peer-guestbook/` |
| 7 | integration-1 | E2E scenarios 1 to 7, unit suite green |
| 8 | integration-2 | E2E scenarios 8 to 14 (10B added), seven product fixes |

## Status of the open items raised across the notes (as of 2026-10-19 12:30 ET)

Items an agent handed to someone else, and what became of them. "Fixed" means fixed in code with a test.

| Item | Raised by | Status |
|---|---|---|
| Two unit files never exit, two tests fail (`loader-app-torrent`, `sw-sdk`) | orchestrator-notes 2 and 3, tools 7, chain-net, dropin | Fixed by integration-1 (M1): injected timers bound per method; `sw-sdk` rewritten for the v0.2 SDK |
| First load shows "This site isn't ready yet" until a reload | tools 1 | Fixed by integration-1 (M2): forced re-reads, shell waits for the worker's ack |
| `openLedger` has no in-memory fallback without IndexedDB | chain-net | Fixed by integration-1 (M3): `MemoryBlockStore` on `E_STORAGE` |
| A visitor cannot post to an open ledger without the genesis block | tools 2 | By design; publish with `--cs` (warned by `publish`, done by `demo.mjs`, in RUNBOOK) |
| The ledger id contains the current owner key, so a rotation changes it | tools 5 | Open design question (review phase) |
| Worker's 60 s web-seed blob cache not keyed by version | dropin (known limits) | Fixed by integration-2 (fix 4) |
| Kill switch: a visitor who never had our worker is reloaded once | dropin 11 | Changed by integration-2 (fix 7): no reload for never-controlled pages; also ends a shell reload loop |
| Publish default `notFound` to `404.html`; skip dot-directories | example | Done by tools (publish.mjs) |
| `test/unit/sw-browser.test.mjs` targets the v0.1 worker | integration-1 | Open: skipped with its reason; rewrite or delete in review |
| Back/forward cache behaviour | dropin | Unit-tested only (headless Chromium disables bfcache); manual release gate |
| Follower tab on another version gets no copy until promoted | dropin | Known limit, documented |
| Integrated foreign worker: earliest subresources still from the host | dropin | Known limit, documented |
| No identity or moderator screens in the drop-in panel | dropin | Open (sites can use `window.mw.identity.*`) |
| `/_mw/mw.js` is 265 KB (86 KB gzip) | dropin | Open: esbuild `splitting` in `build.mjs` |
| MP4 playback on Linux Chromium and iOS | example | E2E asserts the Range path; playback is a manual gate item |
| Scenario 11 (a peer declaring an oversized message) not in the E2E run | integration-2 | Open; the length cap is covered at unit level |
| Limited mode after a 15 s `ready` timeout runs under the normal CSP | integration-2 | Open (blocked registration itself is fixed) |
| Shell host that keeps serving the shell after a kill-switch deploy shows no site | integration-2 | Documented in RUNBOOK (deploy the plain site with the kill switch); the reload loop is fixed |
| Drop-in sites that register their own worker long after `load` | integration-2 | Documented; the 1 s empty-scope re-check covers registrations during page load |
| Release gate on real devices (iOS, Android, Firefox, Safari `resultingClientId`, iOS `DataCloneError`) | DESIGN-REVIEW 6, 25 | Open: `docs/DEMO-RESULTS.md`, manual |

---

<!-- section 1: merged from docs/deviations/orchestrator-notes.md -->

## Orchestrator notes for the finishing build (2026-10-18)

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

---

<!-- section 2: merged from docs/deviations/chain-base.md -->

## chain-base notes (src/chain/canonical.js, src/chain/crypto.js)

Status: implemented per INTERFACES.md, no signature or name deviations. Everything below is
either an addition or a behaviour decision the other chain agents should know about.

### Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test test/unit/chain-core-canonical.test.mjs test/unit/chain-core-crypto.test.mjs

### canonical.js

- `canonicalize` is full RFC 8785: all finite doubles are supported (the RFC vector needs
  them). The "safe integers only" rule of ARCHITECTURE §6.1 is a block-shape rule and belongs
  in `block.js`, not here.
- The RFC test vector lives in RFC 8785 §3.2.2 to 3.2.4 (Appendix B is the IEEE 754 number
  table); both the byte-exact vector and the whole Appendix B table are unit tests.
- Rejections (all `TypeError`): NaN/±Infinity, `undefined` anywhere (object values, array
  elements, array holes), functions, symbols, BigInt, non-plain objects (Date, Map, Set, typed
  arrays, class instances, boxed primitives; only `Object.prototype` / null prototypes pass),
  symbol-keyed properties, circular references, and lone surrogates in strings or keys. The
  last one is an RFC 8785 §3.2.2.2 MUST ("terminate with an appropriate error") and was not in
  the ARCHITECTURE list; a peer can only trigger it by sending a `\uD800`-style escape inside a
  JSON frame, in which case `block.js` should map the `TypeError` from `canonicalize` to the
  `'shape'` rejection reason. `toJSON` is never called.
- `utf8.decode(bytes, { fatal })`: lenient by default (invalid bytes become U+FFFD, like every
  browser); pass `{ fatal: true }` to throw. `encode` of a lone surrogate yields EF BF BD, the
  same as browsers.
- `b64url.decode` is strict: URL-safe alphabet only (`+` and `/` rejected), optional trailing
  `=` tolerated, non-zero trailing bits rejected, so `encode(decode(s)) === s` for every
  accepted `s`. `hex.decode` accepts either case, `hex.encode` emits lowercase.
- Extra export `asBytes(x)` normalises Uint8Array | ArrayBuffer | any ArrayBufferView to a
  zero-copy Uint8Array view; every byte-taking helper accepts those three forms.

### crypto.js

- `sha256`, `sign`, `verify` accept data as bytes (Uint8Array / ArrayBuffer / view) or as a
  string, which is UTF-8 encoded. `verify` additionally accepts the public key as an already
  imported CryptoKey and the signature as bytes or as a b64url string, and it never throws.
- `importPublicKey` keeps an in-memory cache of up to 256 imported keys (same CryptoKey object
  returned for the same string; failed imports are evicted). Verifying a few thousand blocks by
  a handful of authors therefore costs one import per author.
- `exportPrivateJwk` returns exactly `{ kty, crv, x, y, d }` (no `key_ops`/`ext`) so the
  `owner.jwk` written by `tools/keygen.mjs` is stable across engines; `importPrivateJwk` and
  `publicFromPrivateJwk` ignore any extra members.
- Extra exports: `publicKeyBytes(pubB64url)` (sync, decodes + checks 65 bytes / 0x04 prefix,
  TypeError otherwise), `isPublicKeyString(value)` (sync boolean shape check for `block.js`
  structural validation of `author`; it does not prove the point is on the curve, only
  `importPublicKey`/`verify` do), `RAW_PUBLIC_KEY_BYTES = 65`, `SIGNATURE_BYTES = 64`,
  `PUBLIC_KEY_B64URL_LENGTH = 87`.
- The signature is WebCrypto's raw r||s (IEEE P1363), verified against node:crypto in the
  tests. ECDSA signatures are malleable (for one key and message there are several valid
  `s` values), so block identity and deduplication must use `h` only and `s` must never be
  part of anything hashed; that matches ARCHITECTURE §6.1 as written.
- `block.js` decides what "bytes(h)" means for the signature input (hex-decoded 32 bytes or the
  UTF-8 of the hex string); `sign`/`verify` are agnostic, just use the same choice in
  `createBlock` and `validateBlock`.
- Browser requirements: `crypto.subtle` exists only in secure contexts (https:// or
  localhost), which `boot.js` should say explicitly in its feature-detect message; everything
  else used is ES2017 (`padStart`, typed arrays, `TextDecoder` with `fatal`/`ignoreBOM`
  options, supported since Safari 10.1 / iOS 10.3). No top-level await, no node: imports.

### Tooling note for other agents

Writing source through the agent tool layer decoded `\uXXXX` escapes for printable characters
before the bytes reached disk (a scratch script's `€` arrived as a literal euro sign).
The modules on disk were verified byte-for-byte; the unit tests build all non-ASCII and control
characters with `String.fromCharCode` and compare against the RFC's hex dump for that reason.
If you embed such escapes in fixtures, check the file bytes afterwards.

---

<!-- section 3: merged from docs/deviations/chain-net.md -->

## chain-net notes (src/chain/{gossip,wire-ext,stores,node}.js)

Status: the four modules were interrupted drafts (2026-10-18). They were reviewed against
ARCHITECTURE 6.3 and 6.6 to 6.8, INTERFACES and DESIGN-REVIEW items 1 to 5, S1, S2, S9, fixed in
place, and covered by `test/unit/chain-net-*.test.mjs` (pure Node, a virtual clock, in-memory links,
fake wires, a strict fake IndexedDB; no sockets, no browsers). Exported names and signatures follow
INTERFACES; additions are listed at the end. No chain-core file was changed.

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test --test-timeout=180000 test/unit/chain-net-*.test.mjs

47 tests in 7 files, about 5 s; every file exits on its own (no open handles). The helper
`test/unit/chain-net-helpers.mjs` (virtual clock, links, block builders) is not a test file and the
glob above does not match it.

### Behaviour decisions (deviations or readings of the spec, with reasons)

1. Solicited budget cap. ARCHITECTURE 6.6 says solicited answers are limited to 1 MiB/s "and
   maxChainBytes". The cap is counted in frame bytes (JSON with h and s), which exceed the ledger's
   canonical(e) + canonical(v) bytes, so it is 2 x maxChainBytes + 1 MiB of frame bytes per peer
   until we are in sync with it again (reset on equal root). A full 8 MiB ledger bootstraps from one
   peer without reaching it (tested).
2. Egress is paced below the receiver's budgets: answers 768 KiB/s and requests/notices 48 KiB/s per
   peer, at most 512 hashes asked of one peer at a time, an answer queue of at most 4 MiB per peer.
   Honest peers never trip each other's limits (the 8 MiB bootstrap asserts zero drops and strikes).
   With small blocks WANTs therefore leave as partial frames (a 5 000-block chain: 182 WANT frames
   for 79 windows); still O(blocks / 64) frames.
3. INV pages list a window in (depth, h) order (captured when the first page goes out), and BLOCKS
   answers go lowest depth first, so a requester gets parents before children. The spec fixes no
   order; hash order made most bootstrapped blocks orphans.
4. A v-less payload block and the tombstones or bans that justify it travel as one unit in one
   BLOCKS frame. A requester waits 2 s (valueGraceMs) before sending WANT { h, v: true } for an
   unexplained stub and re-checks first: the justification may sit in the next frame or wait as an
   orphan for its own parents. The value request goes to the other peers first, then to any peer
   including ones that attach later, the sender last.
5. HELLO fast path: when a peer's unknown heads are at most two levels above our depth we WANT them
   directly. If such a head, or a parent we asked for, arrives as an orphan, a sync session starts at
   once instead of walking the gap one round trip per level (the slow bootstrap item 5 removed). The
   fallback deadline is set once per divergence, so a peer that keeps writing cannot postpone it.
6. Sync backoff (2 s doubling to 60 s) applies only to sessions that brought nothing in (typically a
   peer holding blocks we refuse); a session that added blocks but did not reach the peer's root
   retries after 2 s. Hashes an INV lists that are already wanted (say from an ANN whose sender went
   quiet) get the session's peers as further sources. Missing parents of held orphans are asked again
   every 5 s.
7. Blocks with missing parents that fail the control-state check at the local heads are not refused:
   they are set aside (verified, at most 512, 120 s) and judged again once their parents are in.
   Reason: the control state of their causal past is unknown here (frames arriving out of order; a
   fresh node that has not received the genesis policy would otherwise refuse every non-owner block
   of a bootstrap). Their parents do not become exempt. The gossip counts them as held (`pending`
   hook) so it does not fetch them again.
8. Policy refusals of blocks judged with all their parents present are remembered (bounded 4 096,
   cleared on any control-state change) so an INV does not make us fetch them again; rate (E_RATE),
   cap (E_CAP) and budget drops never are (6.3).
9. The cap also bounds parents WANTed for held orphans (exempt from the control-state check), with
   the bytes of held orphans counted, unless the parent's author is the owner, a moderator or
   allow-listed, or a privileged orphan waits on it. Without this, a chain of zero-PoW blocks hanging
   below one admitted orphan could grow the ledger past maxChainBytes (tested: it stops at the cap).
   Below the cap such parents need no PoW (they are exempt by the spec); the cap is what bounds them.
10. Ingress throttle: counts blocks whose claimed ts lies inside the window; older claimed history
    passes (otherwise bootstrapping a ledger with prolific authors would take hours). A writer can
    backdate ts to skip it; PoW, the cap, bans and the per-peer budgets still bound that. It never
    applies to the owner and moderators in effect or to a snapshot import, and it applies to local
    writes too (an early E_RATE instead of peers refusing the block).
11. Malformed frames count as invalid toward the > 50 limit, like invalid blocks. A verifier-pool
    failure is reported as E_VERIFY and is not the peer's fault.
12. One wire, one gossip peer (code review round 1 replaced "one remote visitor, one gossip peer"):
    a visitor usually reaches us over two wires (site swarm and rendezvous swarm). wire-ext used to
    group wires by the remote peer id, but that id is self-declared and never checked against the
    tracker-level one, so a swarm member claiming a visitor's id could receive that visitor's frames
    and get the shared link dropped. Every wire is now its own gossip peer (frames, strikes and detach
    per wire); the remote peer id is only the `group` that `peers` and `inSyncPeers` count, so "in sync
    with N peers" still counts visitors. HELLO and ANN may reach a visitor once per wire.
13. A wire found in `torrent.wires` that already sent its extended handshake gets it again (BEP 10
    handshakes are additive). Side effect: a remote still fetching metadata through ut_metadata
    restarts that fetch once.
14. HELLO.owner is the ledger's genesis owner (the author of the block named by gen= once known,
    else the pointer's owner), not the owner in effect after a succession, so visitors on pointers
    from before and after a key rotation still talk. `ownerMismatch` compares the pointer's owner with
    the owner in effect at the heads. A fresh node whose pointer names a rotated owner and which has
    never seen the genesis will be detached by peers until a snapshot (cs=) brings the genesis; the
    publish tooling always stamps gen=.
15. `IdbBlockStore.open()` without IndexedDB rejects with code `E_STORAGE` (the draft used
    E_IDENTITY). Not an SDK code; callers may fall back to `MemoryBlockStore`.
16. `importSnapshot` returns counts `{ added, rejected, duplicates, orphans }`; entries that are not
    blocks count as rejected, repeated hashes as duplicates.

### Additions to the INTERFACES surface (all optional)

- gossip.js: `PROTOCOL_VERSION`, `EMPTY_DIGEST`, `INVALID_REASONS`, `DEFAULT_LIMITS`; Gossip options
  `justify`, `needsValue`, `skip`, `pending`, `maxChainBytes`, `onChange`; methods `peerInfo(id)`,
  `hasPeer(id)`, `wantValues(hashes)`, `setOwner(owner)`, `destroy()`; `announce(hashes, { except })`;
  `stats` has more counters than `{ in, out, invalid, dropped, ignored }`.
- wire-ext.js: `handlerFor(wire)`; `attachToTorrent(torrent, gossip, { name, resendHandshake })`.
  The extension's `onMessage` returns a promise that settles when the gossip has processed the frame
  and never rejects (bittorrent-protocol ignores it; virtual-clock tests await it).
- stores.js: `dbNameFor(siteId)`; `MemoryBlockStore.size`; constructor options
  `IdbBlockStore({ indexedDB, metaDelayMs = 3000, doc })` for tests.
- node.js: `topoSort(blocks)`, `DEFAULT_CONFIG`; `ChainNode.open` also takes `clearTimeoutFn` and
  `gossipLimits`; config keys `tickMs` (1000, 0 = call `tick()` yourself), `notifyMs` (250), `metaMs`,
  `verifyChunk`, `snapshotChunk`, `rejectMemory`, `deferMax`, `deferTtlMs`; properties `bytes`,
  `inSyncPeers`, `genesisOwner`, `owner`, `closed`, `stats`, `gossip`, `dag`; methods `tick()`,
  `choosePrev()`, `ChainNode.roleRank(role)`. Writes resolve to the stored block (callers read `.h`).
  `ingest()` also returns `duplicates`, `orphans`, `deferred`, `needValue`.

### Notes for the integrator

- The loader (`src/loader/app.js openLedger`) creates `IdbBlockStore` with no fallback; when
  IndexedDB is missing `ChainNode.open` now rejects with `E_STORAGE` and the ledger is reported
  unavailable. A `MemoryBlockStore` fallback would keep the ledger for the page view.
- Not chain-net, observed while running the whole unit suite: `test/unit/sw-sdk.test.mjs` fails 9/9
  here ("window.mw is assigned": `src/sdk/sdk.js` installs `globalThis.mw` while the test expects
  the fake `window.mw`); neither file changed since the wave-A checkpoint and neither imports chain
  code. Every other non-browser unit file passes (360 tests besides sw-sdk and loader-app-torrent).

---

<!-- section 4: merged from docs/deviations/tools.md -->

## tools agent: notes and deviations (tools/*, build.mjs, .npmrc, build.lock.json, package.json scripts)

Agent: `tools`. Date: 2026-10-19. Owned paths: `tools/*`, `build.mjs`, `.npmrc`, `build.lock.json`, `package.json`
(scripts, plus the one field named in deviation 1), `test/unit/tools*.test.mjs`.

### Files

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

### Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test --test-timeout=180000 test/unit/tools-*.test.mjs        # 154 pass, 0 fail, about 2 s
    npm run lint:floor                                                     # 41 files, clean
    npm test                                                               # lint:floor + every non-browser unit file

All 409 tests of the non-browser unit files pass together on this machine (about 6 s) except the two files that never
exit (`loader-app-torrent`, `sw-sdk`, see orchestrator-notes.md; they belong to other agents, I did not touch
them). Every tools test file exits on its own: servers are closed in `after()`, child processes are waited for.

### Deviations, with reasons

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

### Facts checked

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

### For the integrator

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
   stdout lines are parsable: tracker `felinar tracker listening: ws://...` (or `--json`), dev server
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

<!-- section 5: merged from docs/deviations/dropin.md -->

## dropin agent: notes and deviations (src/dropin/*, examples/existing-site-dropin/**, test/unit/dropin*.test.mjs)

Agent: `dropin`. Date: 2026-10-19. Owned paths: `src/dropin/*`, `examples/existing-site-dropin/**`,
`test/unit/dropin*.test.mjs` (nothing existed before). Brief: ARCHITECTURE section 3.4 (3.4.1 to 3.4.9),
INTERFACES "src/dropin/mw.js", DESIGN-REVIEW item 23 and section 5. Two files I do not own were changed in place
(deviations 1 and 2).

### Files

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

### Tests

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

### Browser checks (ad hoc, not committed)

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

### Deviations, with reasons

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
   flash of two notices. [Superseded: v0.2.1 A4 removed `mw.consent.accept()`; with the tag attribute a site calls
   `mw.consent.request()`, which opens the loader's own card, and the visitor decides there.]
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

### Known limits (all documented in README / EXPECTED.md or the code)

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

### Notes for the integrator

- `run-unit` picks up `dropin*.test.mjs` automatically; no script or `package.json` change is needed.
- `test/e2e` can reuse `examples/existing-site-dropin/.fixture/{stage,host}.mjs`; `EXPECTED.md` is the checklist
  (it also records the numbers observed by hand). Diagnostics: `await page.evaluate(() => window.__mwDropin.inspect())`.
- Prefs written by the drop-in engine in the loader cache: `consent:<ledgerId>`, `uploads`, `hostOnly`,
  `shareOnNetwork:<origin>`, `versions:<ledgerId>`, `keyRefused:<scope>:<owner>`, `sw:registered`; plus the owner
  pin (`savePin`), the saved sites and the identity keys the shell already uses.
- Network policy: nothing in `src/dropin` or the fixture contacts a non-local address on its own; the fixture host
  binds `127.0.0.1` only, and no test launches a browser.

---

<!-- section 6: merged from docs/deviations/example.md -->

## example agent: notes and deviations (examples/peer-guestbook/, v0.2)

Agent: `example`. Owned paths: `examples/peer-guestbook/*`. Date: 2026-10-17. Supersedes the v0.1 notes that were in
this file (the v0.1 site used relative URLs, the `notice` key and a 404 page that parsed `/_mw/s/` paths).

### Files

| File | State |
|---|---|
| `examples/peer-guestbook/index.html` | Rewritten: Live card (peers, posts, ledger line, sharing line, how the page arrived), You card (id, role badge, display name), owner notice (`_notice`), guestbook, moderation panel, files card with the MP4 |
| `examples/peer-guestbook/about.html` | Rewritten: second page, v0.2 explanation using DESIGN-REVIEW section 4 strings |
| `examples/peer-guestbook/404.html` | Rewritten: plain static page, no script, root-relative stylesheet and links |
| `examples/peer-guestbook/css/app.css` | Updated: badges, facts list, media, bidi isolation of visitor text, touch-screen toast and footer rules |
| `examples/peer-guestbook/js/app.js` | Rewritten for the section 9 SDK: 347 lines, `textContent` only |
| `examples/peer-guestbook/data/about.json` | Updated (v2.0.0, section 4 wording) |
| `examples/peer-guestbook/media/clip.mp4` | New: 18,833 bytes, sha256 `81045124d22c374964a3746d88e7c15231391378e1587ccbda29ffb0f3245b92` |
| `examples/peer-guestbook/img/peer.png` | Unchanged from v0.1 (validated by the tests) |
| `examples/peer-guestbook/README.md` | Rewritten, with the publish note |
| `examples/peer-guestbook/.dev/check-html.mjs` | New: dependency-free HTML checker (CLI and library) |
| `examples/peer-guestbook/.dev/site.test.mjs` | New: static test suite (14 tests) |
| `examples/peer-guestbook/.dev/browser.test.mjs` | New: Playwright smoke suite (14 tests, Chromium and WebKit) |
| `examples/peer-guestbook/.dev/mock-sdk.js` | New: in-memory section 9 SDK used only by the browser suite |
| `examples/peer-guestbook/.dev/make-media.mjs` | New: regenerates or checks `media/clip.mp4` with a locally installed ffmpeg |

### Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test "examples/peer-guestbook/.dev/*.test.mjs"        # 29 pass, 0 fail, 0 skipped (about 4 s):
                                                       # 14 static + 14 browser + the browser suite node
    node examples/peer-guestbook/.dev/check-html.mjs              # 3 pages, 209 elements, 0 errors

HTML checker counts: `index.html` 113 elements, 36 distinct tags, 41 ids, 8 URLs; `about.html` 78 elements,
28 tags, 10 ids, 7 URLs; `404.html` 18 elements, 11 tags, 0 ids, 4 URLs; no inline scripts or styles. The
checker's own negative cases (24 broken documents: misnesting, block in `<p>`, duplicate id, missing alt,
inline handler, `&mdash;`, non-ASCII, single quotes, dangling `for`, stray tags, unclosed elements,
`target=_blank` without noopener, untyped button, bare `<` and `&`, style attribute, `javascript:` URL,
two `<h1>`, unlabelled input, button inside a link, `<div/>`, missing doctype) are part of the suite.

Two browser assertions were mutation-checked against a scratch copy: removing the render de-duplication
makes "an unrelated snapshot must not reset a half-confirmed button" fail, and removing the malformed-item
filter makes the list freeze in the writer test. The tests also pass when copied to `test/unit/` next to
`examples/peer-guestbook/` (they locate the site from either place; `MW_EXAMPLE_DIR` overrides).

### Deviations, with reasons

1. **Tests and tools live in `examples/peer-guestbook/.dev/`, not `test/unit/`.** My ownership is `examples/peer-guestbook/*`
   only. A dot-directory keeps them out of the torrent under ARCHITECTURE section 10's ignore list
   ("dotfiles"), provided `publish.mjs` treats dot-directories as dotfiles (see notes). The integrator can
   leave them there or copy them to `test/unit/`; both layouts work unchanged.
2. **The MP4 was made with a locally installed ffmpeg (Homebrew 9.0.2, libx264), not by a Node script.**
   The brief allowed a WAV substitute only if no valid MP4 could be produced; none was needed. Nothing was
   installed into the repository, and the clip is committed. `.dev/make-media.mjs` records the exact
   arguments and regenerates it bit for bit on the same ffmpeg (verified twice: identical sha256);
   `--check` probes and fully decodes it. Validation: ffprobe and a full ffmpeg decode (48 of 48 frames),
   Apple AVFoundation, the media stack Safari uses (scratch Swift tool: playable, 4.0 s, 320x180, 48 frames
   decoded), and Playwright Chromium 156 and WebKit 27.2 (metadata, then a seek to 2.5 s, every request a
   206). Clip: H.264 Constrained Baseline level 3.0, 320x180, 12 fps, 4 s, a keyframe every second, `moov`
   before `mdat`, no audio track, SEI removed so no encoder banner or URL is inside the file.
3. **Role is refreshed after `ready()`.** The notice editor shows for `owner` and `moderator` as the brief
   says, but the role is re-evaluated on every snapshot: `snap.role` if the SDK ever adds it, otherwise
   `ready().role` adjusted by `snap.policy` (this identity in `moderators` makes it a moderator, in `banned`
   a reader; `writers: 'owner'` turns a writer into a reader and `'open'` a reader into a writer). A missing
   `role` (an older SDK) counts as `writer`, because the ledger enforces the policy anyway and the
   alternative locks the forms. Reason: a policy block can arrive while the page is open.
4. **Ledger line format.** `Ledger: 1,204 entries, in sync with 3 peers` with en-US thousands separators and
   singular forms (`1 entry`, `1 peer`). `inSync` is read as a count; a boolean means all connected peers
   (true) or none (false); when the snapshot has no `inSync` the "in sync" part is left out instead of
   claiming zero. A `sync` push event with `height`, `peers` or `inSync` updates the line too.
5. **Notice limit** is 1,000 characters and 2,000 bytes of JSON (v0.1 allowed 2,000 characters, which can
   exceed v0.2's `maxValueBytes` of 2,048 bytes with non-ASCII text). The key moved from `notice` to
   `_notice` as specified; old `notice` values are not read.
6. **Re-render only on visible change.** The list is rebuilt only when posts, names, role or moderators
   change, so an unrelated snapshot (peer count, ledger height) does not reset a half-confirmed
   Remove/Ban button or steal focus. Destructive actions keep the v0.1 two-tap confirm instead of
   `confirm()` (no `allow-modals` in the shell sandbox).
7. **No drop-in script tag.** The pages do not include `/_mw/mw.js`: the example is a shell-mode site, and
   that script inside the shell's frame would start a second engine. Drop-in is covered by the dropin
   agent's fixture.

### Notes for the integrator and the other agents

- **Imports and URLs.** The only loader path the site uses is `import('/_mw/sdk.js')` (dynamic; takes
  `default`, falls back to `globalThis.mw`). Site URLs: `/`, `/about.html`, `/css/app.css`, `/js/app.js`,
  `/img/peer.png`, `/media/clip.mp4`, `fetch('/data/about.json')`. Nothing under `/_mw/`, `/mw-sw.js`,
  `/ws/` or `/.mw/` exists in the site (tested).
- **SDK surface used** (section 9): `ready()` fields `identity.{pub,short,name}`, `role`, `peers`, `height`,
  `owner`, `unmoderated`, `siteId`, `btih`, `mode`; `db.subscribe`, `db.list('guestbook', { limit: 200,
  newestFirst: true })` and `db.get('_notice')` once at start (first paint when no snapshot is replayed),
  `db.append('guestbook', { msg })`, `db.set/del('_notice')`, `db.tombstone(h)`, `mod.ban(pub)`,
  `identity.setName`, `site.info()`, `consent.state()` (sync or async), `net.on('peers'|'progress'|'status'|'sync')`.
  Tolerated: `mw.consent` or `mw.mod` absent, `net.on` throwing for unknown events, `peers` pushed as a number
  or `{ count }`, kv entries as plain values or `{ v, author, h, ts }` records, `kv`/`lists`/`profiles` as
  objects or Maps, list items oldest first (the page reverses them). `consent.state()` is called at most once
  per 500 ms (after `status` events and on becoming visible).
- **Publish** (README): `node tools/publish.mjs examples/peer-guestbook --name peer-guestbook --scope <host> --key owner.jwk
  --policy open --bits 16 ...`. Tools agent: (a) the ignore list must skip dot-directories such as
  `examples/peer-guestbook/.dev/` as well as `README.md`; the expected torrent content is exactly `404.html`,
  `about.html`, `css/app.css`, `data/about.json`, `img/peer.png`, `index.html`, `js/app.js`, `media/clip.mp4`
  (plus `/.mw/*`); (b) please default the routing manifest's `notFound` to `404.html` when that file exists
  (GitHub Pages / Netlify convention); the page has no script and works at any depth.
- **E2E hooks.** Index ids: `peers`, `posts`, `ledger`, `sharing`, `source`, `transfer`, `site-meta`,
  `role-badge`, `me-short`, `name-form`/`name`, `notice`, `notice-form`/`notice-input`/`notice-btn`,
  `post-form`/`msg`/`count`/`post-btn`/`post-note`, `entries`, `entries-empty`, `mod-card`, `role-line`,
  `role-help`, `mod-howto`, `unmoderated`, `unmoderated-note`, `pol-writers`/`pol-fee`/`pol-mods`/`pol-banned`,
  `clip`, `standalone`/`standalone-why`, `toasts`. Each post is `#entries li` with `data-h` (block hash) and
  `data-author` (pub); buttons `.act-delete` (own), `.act-remove` and `.act-ban` (moderators; no Ban on the
  owner's or moderators' posts); the first click shows "Tap again to confirm", the second acts. Newest post
  first. `h1` is exactly "Peer Guestbook" (the unmoderated badge sits outside it).
- **Exact strings** a test may match: the ledger line above; sharing line "Sharing only while this page is open
  and on screen." on touch devices, "Host only: no peer connections. Slower, and shared data won't sync.",
  and for desktop "While this tab is open your browser connects to other visitors and, unless sharing is off,
  passes on files and posts."; `#source` "The files of "<name>" arrived <how>. Each one is checked against
  infohash <12 hex>... before it is used."; standalone `#standalone-why` "The loader SDK at /_mw/sdk.js is not
  served here." or the `E_NO_HOST` sentence "This page is not running inside the felinar loader.".
- **MP4 in E2E (1).** Playwright's Chromium 156 on macOS reports `canPlayType('video/mp4; codecs="avc1.42E01E"')`
  as "probably" and plays the clip; Linux builds may lack H.264, so assert the Range path directly
  (`fetch('/media/clip.mp4', { headers: { Range: 'bytes=0-1' } })` gives 206 and `Content-Range: bytes
  0-1/18833`) or use WebKit for playback. iOS playback and seeking remain a manual release-gate item.
- **Node 24 and directories.** `node --test test/unit` (a directory argument) fails on Node 24.22 with "Cannot
  find module .../test/unit" (checked on this repo). Use a glob in package.json, for example
  `node --test "test/unit/*.test.mjs"`.
- If the clip is ever regenerated, update `CLIP_SHA256` in `.dev/site.test.mjs` (the test says so).

### package.json scripts requested (tools agent owns package.json)

    "test:example": "node --test \"examples/peer-guestbook/.dev/*.test.mjs\"",
    "check:example": "node examples/peer-guestbook/.dev/check-html.mjs"

`test:example` launches Chromium and WebKit for about 4 s; if `test` must stay browser-free, run only
`examples/peer-guestbook/.dev/site.test.mjs` there and the browser file under `test:e2e`.

---

<!-- section 7: merged from docs/deviations/integration-1.md -->

## integration-1: notes and deviations (v0.2 finishing build, 2026-10-19)

Agent: `integration-1`. Brief: make ARCHITECTURE section 12 E2E scenarios 1 to 7 work end to end and prove it;
`npm test` green; `npm run test:browser` green or skipped with a reason. Any file could be edited. Status and
resume notes: `docs/INTEGRATION-STATUS.md`.

### Result

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    npm test                     # lint:floor (54 files) + 669 unit tests, 0 failures, about 7 s
    npm run test:browser         # 28 pass, 1 skipped (the stale v0.1 sw-browser test, reason stated)
    node test/e2e/run.mjs        # scenarios 7, 1, 2, 3, 4, 5, 6: all PASS, about 6 s, network policy PASS
    node test/e2e/run.mjs --webkit   # adds W7, scenario 7 in WebKit (127.0.0.1 only): PASS

### Files

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

### Deviations, with reasons

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

### Known gaps and notes for the next integrator

- `test/unit/sw-browser.test.mjs` (gated by `MW_BROWSER=1`) targets the v0.1 worker (mw-shell naming, `/_mw/s/`
  default, export-free SDK form): 12 of 14 fail when forced. It is skipped by default; the E2E run exercises the
  v0.2 worker in Chromium. Rewrite or delete it in the review phase. `chain-core-browser.test.mjs` passes when
  forced (Chromium and WebKit; Firefox is not installed here).
- Scenarios 8 to 14 of section 12 are not in `run.mjs`; `test/e2e/lib.mjs` has what they need (gate, visitors,
  `dev.killSwitch()`, `stopServiceWorkers`). Drop-in (10) can reuse `examples/existing-site-dropin/.fixture/host.mjs`
  and `EXPECTED.md`.
- dropin's note stands: the worker's 60 s web-seed blob cache (`wsBlobs`) is keyed by URL, not by version.
- The `--headed` flag is for local debugging only; CI should run headless.

---

<!-- section 8: merged from docs/deviations/integration-2.md -->

## integration-2: notes and deviations (v0.2 finishing build, 2026-10-19)

Agent: `integration-2`. Brief: ARCHITECTURE section 12 E2E scenarios 8 to 14 in `test/e2e/run.mjs` with 1 to 7 kept
green, every browser launch local-only; fix bugs anywhere; merge `docs/deviations/*.md` into `docs/DEVIATIONS.md`
(originals kept); write `docs/RUNBOOK.md`; keep `docs/INTEGRATION-STATUS.md` current. Any file could be edited.

### Result

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node build.mjs                    # OK
    npm test                          # lint:floor clean (54 files) + 675 unit tests, 0 failures, about 6 s
    npm run test:browser              # 28 pass, 1 skipped (v0.1 sw-browser, unchanged reason)
    npm run test:example              # 29 pass
    node test/e2e/run.mjs             # 14 of 14 PASS (7, 1-6, 8, 14, 12, 10, 10B, 9, 13), about 72 s, network policy PASS
    node test/e2e/run.mjs --webkit    # adds W7 (WebKit cold start)

Stability: after the last fix, three full runs in a row passed (71.5 to 73.0 s); before scenario 10B and the kill
switch change, five full runs in a row and one `--webkit` run under three parallel `npm test` runs passed.

Scenario 11 (a peer that declares an oversized message) is not part of this run. The 256 KiB length cap is covered
at unit level: `test/unit/loader-app-torrent.test.mjs` ("message length cap on real bittorrent-protocol wires"),
the patch-point check on the vendored bundle in the same file, and the build-marker checks in `tools-build`.

### What each new scenario checks

| # | Checks |
|---|---|
| 8 | Shared-origin hub link (`#v=mw1;...`, signed for `btih:<hex>`, no page tag on the dev host): the gate shows name, infohash, trackers, publisher key, "Load anyway: ..." and the shared-origin sentence; for 2 s with the gate open there is no WebSocket, no `RTCPeerConnection` and no site frame; after the click the tracker socket opens and the site renders under `/_mw/s/<btih>/` with the banner. |
| 9 | Kill switch. Shell: the host switches to the plain site plus `dist/mw-sw-kill.js` as `/mw-sw.js`; one reload brings the plain host page, 0 registrations, 0 `mw-*` caches, IndexedDB kept, no further reload. Shell kept by mistake (only the worker swapped): at most one reload, no loop. Drop-in (EXPECTED.md 5): 2 navigations while settling, none in 5 s, `sw` = `{ mode: 'none', reason: 'kill-switch' }`, one warning, one `GET /mw-sw.js` per later view. |
| 10 | Drop-in fixture (EXPECTED.md 1 to 4 and the worker variants): JS off identical to the plain host on 6 URLs (status, `X-Fixture-Host`, text, redirect chain, full-page screenshot bytes); second view's assets from IndexedDB; a v2 redeploy (seq + 1, same genesis, old files kept) never mixes versions (open v1 page: v1 chunk and stylesheet; new page: v2 chunk, data and stylesheet, follower of the v1 tab; promoted when the v1 tab closes, 4 changed files refreshed, only v2 left in IndexedDB); `location.pathname` on a deep page, an SPA deep link, pushState, reload and back; a hand-written worker kept (stats 0/0, 0/1, 1/1, one recipe line per view, no `/mw-sw.js` request); the integrated worker is `integrated`, carries the web seed, gets no recipe line. |
| 10B | EXPECTED.md 6, 7, 8, 10 and the offline variant: 0 announces and 0 WebSockets before consent; the notice in a closed shadow root, clicked with the mouse via `panel.rectOf`; site and anchor announced after OK; a metered visitor (`navigator.connection.type = 'cellular'`) gets no web seed and completes from peers; no stamp: engine off (`no-stamp`), one warning, page works, `mw.db.set` rejects E_IDENTITY; a stamp for another host: `pointer:bad-sig`; host down: visited pages load styled with their script, unvisited URLs get the worker's 503 offline page. |
| 12 | Uploads off: Q turns sharing off in Settings before any download and downloads from P (web seed bytes refused); posts flow P to Q and Q to P; X, with only Q online and connected to it, gets 0 bytes in 6 s (choke lock); Q2 (sharing off) downloads from the web seed. |
| 13 | Publish `seq + 1` (a changed copy into the same web seed, page tag switched): the first reload shows "Update available: reload" and the old version is no longer announced; the second reload renders the new version, IndexedDB holds only it, and neither V's sockets nor the tracker see the old infohash again. Verified to fail without fix 5 below. |
| 14 | WebKit 27.2 and Chromium with native `Uint8Array` hex/base64 (and `AbortSignal.timeout`) deleted complete a download (WebKit from the web seed, Chromium from a peer), `__mwBoot.polyfilled` lists all five; a context with `serviceWorkers: 'block'` renders in limited mode, styled, `mw.ready()` resolves. |

### Bugs found and fixed (all with tests)

1. **Blocked registration fixed the wrong CSP** (`src/loader/boot.js`, `src/loader/render.js`). Playwright's
   `serviceWorkers: 'block'` makes `register()` resolve with nothing. boot.js counted that as success, inserted the
   normal CSP (a meta CSP cannot be relaxed later); render.js then waited 15 s for `ready` and rendered limited mode
   under that CSP: blob: stylesheets and scripts and `<base>` were blocked, the site rendered unstyled. Now a missing
   registration is a failed registration in both files: the degraded CSP goes in and limited mode renders in about
   120 ms. Test: `loader-app-render` "register() resolving with nothing". E2E: 14.
2. **`mw.ready()` never worked in limited mode** (`src/sdk/sdk.js`). Limited mode renders the site as an
   `about:srcdoc` document; its `location.origin` is "null" although it inherits the shell's origin, so the SDK
   decided it was not framed by felinar and rejected with E_NO_HOST (and would have posted to origin "null").
   The SDK now uses the document origin (`window.origin`, within the floor). Test: `sw-sdk` "limited mode". E2E: 14.
3. **Settings switches before the loader was ready** (`src/loader/ui.js`). Settings exist from the first paint; until
   the loader filled in the model the Share switch showed Off while sharing was on, and changes made then were
   dropped (no listener yet). Switches are now disabled until `setModel`, and events fired before the loader listens
   are queued and delivered to the first listener. E2E: 12 (Q2 opens Settings at once).
4. **Web-seed blob cache mixed versions** (`src/sw/core.js`, the drop-in agent's open note). The drop-in rewrite
   `/_mw/ws/<name>/<path>` kept whole host files for 60 s keyed by URL; a new version downloaded within that window
   got the old bytes for a changed file (same URL), pieces failed verification and the download stalled (scenario 10's
   v2 promotion hung for 30 s). The cache and the in-flight jobs are now keyed by the requesting page's version
   (its client mapping). Test: `sw-core` "web-seed rewrite: a new version within the 60 s blob cache". E2E: 10.
5. **A returning shell visitor never saw a new page-tag pointer** (`src/sw/core.js`, `src/loader/app.js`). Shell
   navigations are cache-first from the precache, and the precached shell kept the `<meta name="mw-pointer">` of the
   day the worker installed; the worker script does not change on a publish, so it never reinstalls, and DNS (the
   only update channel) is skipped for IP hosts and absent for meta-only sites. A publish therefore reached returning
   visitors only with a new loader build. Now: (a) on shell navigations the worker re-fetches `/index.html` in the
   background (no-cache, at most every 10 s, `limits.shellRevalidateMs`) and replaces its cached copy only with a
   shell of the same build (identical `integrity` attributes, so the cached shell always matches the precached
   assets; a new build arrives with its own worker); (b) a new message `mw-shell-check` does the same on request and
   answers the host's current page tag; (c) after render and on focus/visible (throttled like the DNS re-check) the
   shell asks for it and treats a newer record signed by the pinned owner like a DNS update: "Update available:
   reload", `tm.stopSite()` at once, `version` broadcast to other tabs, and the record is saved for the scope, so the
   next load uses it even if the cached shell was not replaced (the stale tag is then refused as a `seq` rollback).
   Tests: `sw-core` "shell revalidation". E2E: 13 (fails without the fix: no update banner).
6. **The drop-in runtime could replace a site's own worker on the first view** (`src/dropin/swreg.js`,
   `src/dropin/engine.js`). Found as a flake in scenario 10 (integrated variant; it failed in 2 of 4 full runs, never
   in 6 runs of scenario 10 alone): the site called
   `register('/sw.js')` during parsing, but its registration was not yet visible to `getRegistration('/')` when the
   runtime looked (after load, at idle), so the runtime registered `/mw-sw.js` for the same scope and replaced the
   site's worker, which ARCHITECTURE 3.4.4 forbids. An empty scope is now looked at twice,
   `EMPTY_SCOPE_RECHECK_MS` (1000 ms) apart, before ours registers. `setupServiceWorker({ recheckMs })` and the
   engine option `swRecheckMs` exist so the engine tests that pin the old timeline pass 0 (`dropin-engine`,
   `dropin-engine-tabs`, `dropin-refresh`); `dropin-swreg` has a dedicated test and its fresh-visitor test advances
   the clock. Cost: the first registration on a drop-in site without its own worker happens 1 s later.
7. **Kill switch reload loop** (`src/sw/kill-switch.js`). Found by a probe: in shell mode, deploying only the
   kill-switch worker while the host still served the shell made the page reload about 80 times a second (958
   navigations in 12 s): each activation reloaded every window, including the page that had just loaded from the host
   and registered the kill switch again. It now reloads only pages an earlier worker controlled (`matchAll` before
   `claim()`). After the fix: 2 navigations, then none. A drop-in visitor who never had our worker is no longer
   reloaded (its page came from the host anyway); `examples/existing-site-dropin/EXPECTED.md` check 5 says so now.
   Tests: `sw-core` "kill switch" (the real script in a VM). E2E: 9.

### Other deviations, with reasons

- **Diagnostics:** `window.__mwShell.inspect()` gained `uploads` and `hostOnly` (read-only), used by scenario 12.
- **Hub scenario (8) uses the shared-origin demo hub on 127.0.0.1.** A subdomain hub needs wildcard DNS, which the
  local-only resolver rules forbid. The hub link is the published record signed again by the test for the scope
  `btih:<hex>` (`test/e2e/lib.mjs hubPointer`; `publish.mjs` signs hostnames only): an unsigned magnet would add the
  public default trackers, which this run must never contact.
- **Kill switch (9) models the full deploy** (plain site plus kill-switch worker) with a gate route that serves the
  published site files and forwards `/mw-sw.js` and `/_mw/*` to the dev server; the incomplete deploy is a separate
  step. Not tested: "an old page with a new SW shows Reload instead of breaking" (item 20, second half).
- **Scenario 10B goes beyond the section 12 text** (it covers the rest of `EXPECTED.md`) and runs as its own entry so a
  failure points at the right half.
- **Uploads-off check (12) includes a negative**: X connected only to the uploads-off visitor must not receive the
  site. Scenario 3 is the positive control (C completes from B alone with sharing on).
- **WebKit runs only with consent pending** (14, W7): HTTP to 127.0.0.1 only, so no tracker or WebRTC traffic leaves
  WebKit (docs/DEV-NETWORK.md). A WebKit peer download was not attempted.
- **E2E harness additions** (`test/e2e/lib.mjs`): the tracker records every announce (`tracker.announces`), each
  visitor records its WebSockets and the announces it sends (`visitor.sockets`, `visitor.announces`), the ICE wrapper
  counts `RTCPeerConnection`s (`window.__mwE2EPc`), the gate can answer requests itself (`setRoute`) and keeps a
  request log, `Visitor.open` takes `javaScriptEnabled` and extra init scripts, failure reports include the drop-in
  engine state.
- **Timestamps in INTEGRATION-STATUS milestones** were corrected from scratch-file times after first being estimated.

### Known gaps and notes for the review phase

- **Scenario 11 is not in the E2E run** (unit-level coverage only, see above).
- **Limited mode after a 15 s `ready` timeout still runs under the normal CSP.** Fix 1 covers registration that is
  blocked outright. A worker that registers but never activates (a broken `/mw-sw.js`, a browser that kills it) still
  ends in limited mode under the CSP boot.js fixed at start, so limited mode's blob: assets are blocked. A reload with a
  one-time "degraded" flag that boot.js honours would fix it.
- **Shell host that keeps the shell after a kill switch:** no loop any more, but the page shows no site (and falls into
  the case above after 15 s). The runbook says to deploy the plain site together with the kill switch.
- **Drop-in sites with their own worker should register it before `load`** (or set `data-mw-sw="off"`, or integrate):
  the 1 s re-check covers registrations made during page load, not ones made much later.
- **The drop-in fixture shares the example site's ledger** in E2E (same owner key, same scope `127.0.0.1`, so the same
  ledger id and anchor torrent). Harmless here; 10B filters announces by time for that reason.
- **`inspect().sw.mode` reads `ours` for one view** when a brand-new drop-in visitor registers the kill switch (it
  unregisters itself at once); the next view reports `kill-switch`.
- `test/unit/sw-browser.test.mjs` still targets the v0.1 worker and stays skipped.
- Suggested `package.json` script (tools agent owns the file): `"test:e2e:webkit": "node test/e2e/run.mjs --webkit"`.

### Files changed by integration-2

| File | Change |
|---|---|
| `test/e2e/run.mjs` | Scenarios 8, 9, 10, 10B, 12, 13, 14; fixture helpers (`dropinSite`, `dropinState`, `swFootprint`, `readPref`, `setShare`); `closeAll`, end-of-run closers; header and order. |
| `test/e2e/lib.mjs` | Gate routes and log, tracker announce log, per-visitor sockets/announces, peer-connection counter, `hubPointer`, `staticRoute`, `gateState`, `clickGateButton`, `storedSites`, `deleteNativeEncodings`, drop-in state in reports. |
| `src/loader/boot.js`, `src/loader/render.js` | Fix 1. |
| `src/sdk/sdk.js` | Fix 2. |
| `src/loader/ui.js` | Fix 3. |
| `src/sw/core.js` | Fixes 4 and 5 (worker side). |
| `src/loader/app.js` | Fix 5 (page side), `inspect()` fields. |
| `src/dropin/swreg.js`, `src/dropin/engine.js` | Fix 6. |
| `src/sw/kill-switch.js` | Fix 7. |
| `test/unit/sw-core.test.mjs` | 3 tests (web-seed versions, shell revalidation, kill switch in a VM). |
| `test/unit/sw-sdk.test.mjs`, `test/unit/loader-app-render.test.mjs`, `test/unit/dropin-swreg.test.mjs` | 1 test each; swreg's fresh-visitor test advances the clock past the re-check. |
| `test/unit/dropin-engine.test.mjs`, `dropin-engine-tabs.test.mjs`, `dropin-refresh.test.mjs` | `swRecheckMs: 0` in their engine fixtures. |
| `examples/existing-site-dropin/EXPECTED.md` | Check 5: a never-controlled visitor is not reloaded by the kill switch. |
| `docs/INTERFACES.md` | Additive notes (messages, options, diagnostics). |
| `docs/INTEGRATION-STATUS.md`, `docs/DEVIATIONS.md`, `docs/RUNBOOK.md`, this file | Docs. |
