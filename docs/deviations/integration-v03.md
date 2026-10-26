# v0.3 integration notes (integrator after build wave 1)

Integrator after wave 1 of the v0.3 build (lanes freeze, harden-loader, idcore, chat, media, ui), 2026-10-20 10:48 to
about 11:50 ET. Source of truth: [review/V03-DESIGN-REVIEW.md](../review/V03-DESIGN-REVIEW.md) ("R"), the v0.3 sections of
[ARCHITECTURE.md](../ARCHITECTURE.md) (section 15) and [INTERFACES.md](../INTERFACES.md). Later integrators (reconciliation,
final) append their own sections below.

## How this pass was run

The wave 2 lanes (chain-net, idp, tools, docs, sdk and examples, the last two contract-first) were writing their files during
the whole pass, so the live tree mixed landed wave 1 code with half-written wave 2 code. To test wave 1 as it landed, the
checkpoint commit of 10:16 ET (`0d13fda`: every wave 1 file final, no wave 2 file touched yet; checked with `git diff`) was
extracted to a scratch directory and the integration changes below were copied onto it; the unit, browser, example and e2e
suites ran there. The same changes are in the live tree. Files of running lanes were not edited; what they need is under
"Requests". Network policy held in every browser run (Chromium with `chromiumArgs()`, WebKit on `http://127.0.0.1` only).
One snapshot-only emulation: `SDK_VERSION` and package.json were set to 0.3.0 in the scratch copy (in the live tree the sdk lane
already set `SDK_VERSION`; package.json waits for lane tools, I-6), so the version test could pass there.

## Results

| Suite | Wave 1 state (`0d13fda` plus the integration changes) | Live tree (wave 2 writing) |
|---|---|---|
| lint-floor | clean, 108 files | clean, 127 files (11:44 ET) |
| unit (`tools/run-unit.mjs`) | 1,253 tests: 1,252 pass, 0 fail, 1 skipped | 1,517 tests: 1,513 pass, 4 fail (11:44 ET): docs-links (the examples lane's deviations file is not written yet), sdk-v03-tables and sw-sdk (lane sdk mid-edit), v021-integration (package.json, I-6) |
| `test:browser` | 35: 34 pass, 1 skipped | 37: 36 pass, 1 skipped |
| `test:example` | 29 of 29 | not run (lane examples rewriting `test/example/`) |
| `node test/e2e/run.mjs --webkit` | 41 of 41, network policy PASS, 137.2 s (11:36 to 11:38 ET) | 35 of 41, network policy PASS (11:38 to 11:41 ET): 2, 4, 12, PEER-RV ("no identity page is configured for this site"), PEER-WS (48 web-seed requests before the breaker tripped), FMT-SDK (the v0.3 SDK did not get ready in the site frame); every new v0.3 scenario passed |

Before the integration changes the wave 1 state had 3 unit failures (formats-vectors twice, dropin-stamp) and e2e 24 of 26
(10B and OPFS: I-1). The live tree had 28 unit failures at 10:48 ET, all but those 3 in files of the running lanes.

## Findings and fixes (I-1 to I-8)

| Id | Seam | What broke | Fix |
|---|---|---|---|
| I-1 | ui `src/widget/redress.js` in a real browser | The ancestor walk of `checkElement` handed a real `ShadowRoot` (nodeType 11, no tagName) to `getComputedStyle`, which throws a TypeError in Chromium. Every drop-in panel button, "Share and load" included, did nothing: e2e 10B and OPFS failed (25 of 25 before wave 1, 23 of 25 after). The unit tests passed because the fake DOM names a shadow root by tagName. | The walk skips nodeType 9 and 11 as well as the fake names. Regression test with a Chromium-shaped DOM in `test/unit/integration-v03.test.mjs` (fails on the old code). 10B and OPFS pass again. |
| I-2 | ui `<mw-signin>` and idcore's verifier and fixture server | The widget posted `{ proof }`; [specs/mw-signin-v1.md](../specs/mw-signin-v1.md) section 1 says the page posts the proof text, the fixture server passes the body to `verify()` as text, so every widget sign-in was refused (`parse`). The new e2e E-SI-1 caught it (and fails again with the old widget). | The widget posts the proof's JSON text (also lets the verifier refuse duplicate keys). `widget-signin.test.mjs` expectation updated. The docs lane's recipe server unwraps both forms, so it keeps working; its prose still says `{ "proof": ... }` (request below). |
| I-3 | harden-loader `FileTorrentHandle` and the media and files lanes | The lanes call `handle.on('verified')`, `once('done')`, `metadata()`, `prioritize()`, `downloaded`, `numPeers`, `stopSeeding()` and `destroy()`; the handle is an EventTarget with `leave()`. Every call was a guarded no-op: deleted, revoked (`reencrypt`) and unshared items kept seeding, a received item never stopped seeding, and the MF-55 metadata check of a fetched torrent was skipped (E-FI-6, E-MD-5 would fail once wired). | `src/loader/torrent.js`: the handle gets that surface on top of its events (`verified` and `metadata` forwarded from the live torrent; `metadata({ timeoutMs = 60000 })` rejects `E_FILE_UNAVAILABLE` on a timeout or when the handle leaves first; `stopSeeding()` and `destroy()` leave at once and never destroy the store, which the lanes own). Four unit tests. INTERFACES updated. |
| I-4 | idcore sealed items, freeze schema, chat box | R 2.6.2 and the freeze schema accept exactly 1,040 bytes of ciphertext for every `mw.s` kind. For grants and joins (kinds 4 and 5) `sealed.js` takes the chat lane's box, and the natural adapter packs a fresh ephemeral key in front (1,105 bytes): `sealed.js` accepts it, every v0.3 reducer hides it, so no grant would ever be seen. | No code change (the adapter belongs to the SDK wiring): the contract is written in INTERFACES and ARCHITECTURE 15.5, and a unit test proves the working adapter (`sealTo` with `ephemeral` = the sender's chat key, `openFrom` with `epk` = the sender's key: 1,040 bytes, passes `schemaOk`, opens only for the recipient) and that the packed one is hidden. |
| I-5 | idcore `hintFor(kPair, ms)` and chat `hint(kPair, day)` | Two implementations of the grant hint. | They agree (unit test); no change. |
| I-6 | sdk `SDK_VERSION = '0.3.0'` (INTERFACES v0.3) and the runtime | `v021-integration` requires the runtime, SDK, tools and package.json to agree; the SDK moved to 0.3.0. | `CONFIG.version` and `TOOLS_VERSION` are 0.3.0; the test asserts 0.3.0. package.json still says 0.2.1 (lane tools owns it and is running): the one assertion left failing in the live tree, until that line is bumped. |
| I-7 | chat `registerChatWire` and harden-loader `registerWireExtension` / `joinLane` | Each lane tested against a fake of the other. | They fit (unit test on the real TorrentManager); no change. |
| I-8 | the SVC deps of chat, media and files | Media and files read `deps.hostOnly` as a function (live); chat tested it as a value, so a function looked "on" for ever, and the boolean snapshot the SDK wiring passes misses a host-only choice made after the services mount (E-CH-6 would then let chat reach peers). | `src/chat/service.js` takes a boolean or a function, read at each call (unit test fails on the old code). The SDK wiring can pass the same function to all three. |

Also: the golden vectors. The 136 LOCK lines the lanes listed (freeze 34, harden-loader 8, idcore 71, chat 8, media 15) were
checked against the vector files (every hash matched, no vector unlisted) and appended to `test/vectors/LOCK.json` in that
order (169 entries; the frozen v0.2.1 chain head over the first 28 is unchanged). `formats-vectors.test.mjs` lists the five
new files and applies the supersedes rule the harden-loader lane proposed: a vector named in another vector's `supersedes`
keeps its locked bytes, parse, signing input, format, ledger id and size, but not its verify expectation; a new test pins
ptr-010's v0.3 result (`owner-changed`). `chain-core-browser.test.mjs` applies the same rule. `dropin-stamp.test.mjs` signs
its rotation with a scope (rot= v1 is deleted). No new FROZEN entry: nothing was released.

## Spec folds (status marks kept "proposed")

- INTERFACES v0.3: the identity core (derive, p256, argon2, wrap, vault, check, the new `sealed.js` entry, signin, verify),
  the freeze group, the torrent hooks with the exact signatures and I-3, the hardening helpers and pointer fields, and a new
  ui cards and widgets entry, each marked "built by lane X" with a link to its deviations file. The part's status line says
  "Proposed; partly built". The chat and media lanes had already written theirs.
- ARCHITECTURE 15: a "Wave 1 build" item in 15.1, 15.2, 15.4, 15.5, 15.7 and 15.10 with the lanes' recorded decisions and
  measurements, and 15.12, the prefixes added by the build for the R 2.10.3 list (`mw-vault-v2`, `mw-identity-v3`,
  `mw-nonce-v1`, `mw-selftest-v1`, `mw-local-v1`, `mw-rotate-v1`, `mw-grp-admin-v1`, `mw-grp-commit-v1`, `mw-pres-v1`,
  `mw-file-v1`). R itself is not edited.

## New e2e scenarios (test/e2e/scenarios-v03.mjs, wired into test/e2e/run.mjs before 13)

Wave 1 has no identity origin, no SDK wiring and no swarm wiring for files and media, so the scenarios drive the landed
modules directly from lab pages (`test/e2e/v03/`): the server sign-in page is served by the idcore fixture server; the media
lab runs on the e2e stack origin under the product worker (`/mw-sw.js` from the run's own build), served from `/ws/e2e-lab/`
(which the worker passes through) with the unbundled `src/` modules, and calls `createMediaService` (the SVC contract the SDK
lane mounts) with stand-in keys, ledger node and cards. Rows marked PARTIAL say which half waits.

| Id | Result | Notes |
|---|---|---|
| E-SI-1 | PASS (partial) | a real mouse click on `<mw-signin>` in its closed root, challenge, proof text, 200, an HttpOnly session cookie; a stand-in signs for the identity origin |
| E-SI-2 | PASS | replay, foreign origin (burns no nonce), expired |
| E-SI-3 | PASS | a local proof is `version` |
| E-SI-4 | PASS | two instances, one nonce directory: replay at the other in both directions |
| E-SI-5 | PASS (partial) | a rewriting reverse proxy: `origin`; the IdO's event.origin binding waits for lane idp |
| E-CH-6M | PASS | the media part of E-CH-6: E_HOST_ONLY before any card or socket, then E_POLICY, E_NEEDS_GESTURE, E_NOT_SIGNED_IN |
| E-MD-1 | PASS (partial) | 88 pieces of 256 KiB = 23,068,672 bytes; no ftyp at any chunk start; poster; own-index item kind 3, 1,040 bytes, passes `schemaOk`; no swarm, so the wire half waits |
| E-MD-2 | PASS (partial) | three seeks, each answered 206 by the worker, HAVE_CURRENT_DATA after each; same profile (device link: lane idp) |
| E-MD-10 | PASS | moov at the end rewritten (ftyp, free, moov, mdat); the first frame read chunks 0 to 9 of 79 |
| E-MD-7 | PASS | worker stopped through the DevTools protocol; `mw-session-lost`, re-registration, the seek completes |
| E-MD-8 | PASS | Blob fallback plays with "Played from memory on this browser."; a 16 KiB cap gives E_LIMIT |
| E-MD-9 | PASS | a cross-origin page in the same profile gets 404 from the host |
| E-FI-3, 3b, 3c | PASS (partial) | HTML and an SVG with a script download as attachments (octet-stream, nosniff, sandbox CSP) and never render; the no-worker Blob is octet-stream; the SDK half waits for lane sdk |
| W-SI | PASS | E-SI-1 and the replay in WebKit 27.2 |
| W-MD | PASS | E-MD-2 in WebKit 27.2 with `preload="auto"` (WebKit with `preload="metadata"` stops at HAVE_METADATA and fires no `loadeddata`; examples should not wait for it) |

Not added yet, with the lane each needs: E-HD-1 (chain-net), E-ID-* (idp), E-CH-1 to E-CH-12 except the media gate (sdk
wiring of the chat service and the chat wire), E-FI-1, 2, 4, 5, 6 and E-MD-3 to E-MD-6 (the swarm wiring of the file and
media services), E-SO-* (examples). E-ID-9 and E-SO-12 need axe-core, which is not installed: owner decision to add it as a
dev dependency, or they stay not run. (Since 2026-10-22 axe-core 4.14.0 is a dev dependency and both rows ran:
docs/deviations/a11y.md.)

## Measured (loopback only, Apple M3, 2026-10-20)

- Upload of the 20 MiB reference MP4 through `media.upload` (strip, faststart, poster, encryption, IndexedDB store, own-index
  item): 252 to 334 ms in four Chromium 156 runs, 326 to 463 ms in three WebKit 27.2 runs.
- Through the worker route: first frame 3 to 44 ms; seeks 10 to 148 ms in Chromium (210 ms when the seek restarted the worker),
  14 to 41 ms in WebKit.
- One Chromium seek made the worker read 353 chunks of a 79-chunk item: no worker-side chunk cache, overlapping Range
  requests. A candidate optimisation; phones decide whether it matters (G-MD-1, G-MD-4).

## Requests to the lanes that were running

- **tools:** bump `package.json` `"version"` to `"0.3.0"` (I-6; the last failing assertion of `v021-integration`).
  `tools-build.test.mjs` F7 expects the v0.2.1 `ready()` of the static `/_mw/sdk.js` stub; the sdk lane's stub now adds
  `auth: 'guest'` and `features` (R 2.11.2), so the expectation needs those two fields.
- **sdk (wiring):** the media lane calls `sealed.open(value, opts)`; `src/identity/sealed.js` is `open({ value, ...opts })`
  (the in-flight `sealedAdapter` must keep doing this). The kinds 4 and 5 adapter must give 1,040-byte ciphertext (I-4).
  `deps.torrents.addFileTorrent` may now return the manager's handle as is (I-3). Pass `previousRecord` to `verifyPointer`
  and use the `harden.js` helpers in `app.js` (MF-28, MF-30 are not fixed end to end until then). The chat service reads
  `keys.chat = { pub, ecdh }`. `mountV03Services` passes chat `hostOnly: hostOnly()` (a value at mount time): pass the
  function, as for media and files (I-8), so a later host-only choice stops chat at once.
- **docs:** `docs/recipes/signin-widget.md` and `signin-server-node.md` still say the widget posts `{ "proof": ... }`; it posts
  the proof text now (I-2). The server code there accepts both.
- **chain-net:** prune only to `state.checkpoint` and serve S by snap (freeze lane's request); call `tm.anchorWire`,
  `tm.ignoreWire` and `tm.noteProgress('rendezvous')` (harden-loader lane's request). E-HD-1 is added once this lands.
- **examples:** `examples/social/README.md` links the lane's own deviations file, which does not exist yet
  (`docs-links` fails until the lane writes it). Wait for `loadedmetadata`, not `loadeddata`, before showing a WebKit video
  with `preload="metadata"`.

## Open after this pass

- The owner sign-off of R 1.5 (N-1 to N-7, the D-, D-C and PR rows) is still not recorded in the repository; the planner
  asked for it before wave 1 and `docs/PUBLISH-CHECKLIST.md` carries it as an owner step. Wave 1 was built on the resolved
  decisions as written.
- With I-3, `MediaLane.accept()` and `FileLane.fetch()` wait for `handle.metadata()`, at most 60 s; a timeout surfaces as
  `E_FILE_UNAVAILABLE` with the message "the swarm does not match the grant" in the media lane, which fits a lying swarm
  better than an absent one (wording for lane media's owner). `FileLane._waitDone` adds one `once('done')` per 250 ms poll;
  they are released when the file completes.
- COLLECTED cannot be verified by a holder (chat O-1): a design item for the review round.
- The constant-time scalar multiply and a WebAssembly Argon2id (idcore), the outside review of the Noise and sealed-box code
  (R 2.19): before 1.0.
- `src/sw/kill-switch.js` purge mode (SC-6, SC-8) has no lane.
- Firefox rows are not run. Real-device G rows are not run (owner steps). (Since 2026-10-22 Firefox runs in the harness:
  docs/deviations/firefox.md.)

## Reconciliation (integrator after lane sdk, 2026-10-20 12:02 to 13:05 ET)

Lanes landed: freeze, harden-loader, idcore, chat, media, ui, docs, idp, chain-net, tools, sdk. Lane sdk was built contract-first
against the written contracts while idp, chat, media and chain-net were still building; this pass wired its adapters
([deviations/sdk.md](sdk.md), "Contract-first adapters") to the landed modules, replaced contract mocks by the real modules in the
tests, and fixed the implementation wherever it and INTERFACES v0.3 disagreed. The examples lane was still running: nothing under
`examples/` (nor its `test/example/`) was touched; the e2e stack publishes the live `examples/peer-guestbook`, so its runs use
whatever that lane had written at the time.

### Results (live tree; the before column at 12:03 and 12:08 ET, the after column 12:47 to 12:55 ET)

| Suite | Before (12:02 ET) | After |
|---|---|---|
| `npm test` (lint-floor + unit) | lint-floor clean (127 files); 1,519 tests, 1,517 pass, 2 fail (docs-links: the examples lane's deviations file not written yet; v021-integration: package.json 0.2.1) | lint-floor clean (127 files); 1,529 tests, 1,529 pass, 0 fail (12:52 and 13:00 ET) |
| `npm run test:browser` | not run | 37 tests: 36 pass, 1 skipped (the v0.1 worker test) |
| `node test/e2e/run.mjs` (Chromium) | 32 of 38 PASS; FAIL 2, 4, 12, PEER-RV (posting: "The identity page could not be reached"), PEER-WS (48 web-seed requests), FMT-SDK (ready() never resolved for the v0.2.1 expectation) | 38 of 38 PASS, network policy PASS, 140.9 s (12:48 to 12:50 ET; before R-4) |
| `node test/e2e/run.mjs --webkit` | not run | 41 of 41 PASS (the 38 Chromium scenarios, W7, W-SI and W-MD in WebKit 27.2), network policy PASS, 145.5 s (12:53 to 12:55 ET, the final code) |

The identity, chat and media scenarios that exist (E-SI-1 to E-SI-5, E-CH-6M, E-MD-1, E-MD-2, E-MD-10, E-MD-7, E-MD-8, E-MD-9,
E-FI-3; W-SI and W-MD with `--webkit`) pass. The regression scenarios that post (2, 4, 12, PEER-RV) now sign in at a real identity
origin: `tools/build-idp.mjs` builds it into the run directory, `test/fixtures/idp/serve.mjs` serves it on a second loopback port with
its `_headers`, the published pointer names it (`idp=`), and `test/e2e/lib.mjs` `signInPopup` answers its cards ("Create my identity",
then "For this visit only"). So the popup, the IdO's own cards, the sealed bundle, WorkingKeys and the binding to the ledger run in
Chromium for every post; the passkey and passphrase paths and the rest of E-ID-* stay with the final integration. Measured in these
runs (Chromium 156, loopback, the 12:48 and 12:53 ET runs): a guestbook post that signs in first took 1,807 to 2,022 ms from the click to
the step's end (the popup, two cards with their 400 ms press guard, the bundle and a 4-bit fee; some steps also wait for the other
visitor to show the entry); a follower tab's post through the engine tab's sign-in 284 and 307 ms.

### Findings and fixes (R-1 to R-17)

| Id | Seam | What broke | Fix |
|---|---|---|---|
| R-1 | idp `WorkingKeys.ecdh` and chat's ChatKey | The chat lane's Noise XX handshake passes raw 65-byte points to `ecdh` (its own ChatKeys accept them, `rawPoint`); WorkingKeys took `p256:` strings only, so with real working keys no `mw_chat1` wire ever completed its handshake: no DM, room or grant could travel. Hidden by the SDK tests' fake `keys.chat` and the chat tests' own keys. | `src/identity/store.js`: `ecdh` takes a key string or a raw uncompressed point (shape checked; WebCrypto refuses a point off the curve). INTERFACES' ChatKey says so. Test: two visitors over real chat (fails with "timed out: wires" on the old code). |
| R-2 | sdk `app.js` `signedPinCache` and the built loader | The cache is `import * as cache`; in the esbuild bundle its exports are getter-only accessors, so `Object.create(cache).getPin = ...` throws ("has only a getter"): every built loader logged "device key unavailable" and kept pins unsigned (MF-30 not live). Unit tests ran unbundled, where namespace objects behave differently. | Own data properties via `Object.defineProperty`. Test with a getter-only namespace shape (the old code throws). A built loader in local-only Chromium no longer logs the line (checked at 13:01 ET on the e2e stack). |
| R-3 | sdk `bindKeys` (`app.js`, `engine.js`) and idp's `onKeys` | `bindKeys` awaited the 0.2.1 key lookup before `setNodeIdentity`, so the site's first write after `auth.signIn()` resolved could reach a node without a key: E_IDENTITY ("Your signing key is not available in this browser"), seen in a full e2e run (scenario 2). | Bind at once (the service calls `onKeys` inside the sign-in, before `auth.signIn` resolves); the HON M9 switch to the 0.2.1 key on an `allow` site follows, only while the same sign-in stands. |
| R-4 | sdk hub wiring and chain-net `recent.js` | `stateOf` passed `viewOf(node).state()` (`{ state, snapshot, unchecked, ... }`) where a reduced State was expected, so every followed-ledger read (`db.get`, `db.list`, `db.snapshot` with `{ ledger }`) missed the recent window and returned what the member's node held itself (nothing, for a ledger only followed). | `personal-site.js` `viewAdapters(recent)` -> `{ stateOf, snapshotOf }` (the view's `.state` and `.snapshot`), used by `app.js`; the hub service takes `snapshotOf`. Test with a real ChainNode, `recentWindow`, `applyWindow` and MultiGossip (the old adapter returns `[]`). |
| R-5 | ui `<mw-chat-panel>` and chat's events | The panel listened to `'message'` only and expected `from` objects; the service (INTERFACES) emits room messages on `'room'` and `from` as the sender's key string: the Lobby stayed empty, direct messages were dropped, and a grant (no text) would have shown "null". | `src/widget/chat-panel.js` listens to both, reads either `from` form, skips messages without text. Test with the service's shapes. |
| R-6 | chain-net ChainNode and sdk `setNodeIdentity` | The adapter wrote the private `_identity` and reset the own-chain hints to nothing, so a returning author's next block neither continued their `seq` nor linked their own last entry. | `ChainNode.setIdentity(identity | null)` (node.js): recomputes the hints from the DAG and notifies `'identity'`; `setNodeIdentity` calls it (false for a follower's RemoteNode). Test: seq and prev continue after sign-out and sign-in. |
| R-7 | chain-net ChainNode and sdk `mod.js` `writeControl` | Control ops from the browser went through the private `_write`. | `ChainNode.writeControl(op, opts)` (any CONTROL_OPS op, payload ops E_INVALID, admit decides who); `mod.js` keeps only the RemoteNode forwards (ban, one tombstone). Test: unban and ban as moderator, a writer refused. |
| R-8 | idp identity service and sdk owner actions | `ownerConfirm` called `client.signIn` around the service (no escrow, scope, idp or cryptoApi) and kept the whole answer bundle, secret scalars included, in `A.ownerBundle` (R 2.3.3: the JSON is dropped once the keys exist); the shell never set `api.ownerConfirm`, so `owner.policy` was E_UNSUPPORTED there for a personal site's owner. | `createIdentityService().ownerAction(card)` (the sdk lane's request): owner: { what } or create: true on the IdO card, true only when `K.owner.confirmed` names the action, the answer installed as the working keys (a create answer brings `nextPubHash`); `app.js` and `engine.js` call it, the shell sets `api.ownerConfirm`, `createPage` reads the live keys. Test: "Create my page" and `owner.policy` with real keys and the in-process IdO. |
| R-9 | sdk `sealedAdapter` and media's durable grants | `sealTo` threw E_UNSUPPORTED after the grant DM had gone out, so `media.share({ durable: true })` rejected although the recipient got the grant. No module reads kind-4 items back (no `findByHint` or `openFrom` caller). | The adapter has no `sealTo`; the media lane's own check then skips the ledger copy and the grant travels over chat only (SDK.md says so). The 1,040-byte box adapter of I-4 stays ready for when a reader lands. |
| R-10 | chat service and media's `share({ to: groupId })` | The media lane asks `chat.groupMembers(id)`; neither the service nor the seam had it, so a share to a group was E_POLICY. | `createChatService().groupMembers(groupId)` (members without this tab's key; E_NOT_MEMBER), passed through the chat seam. Test with a real group. |
| R-11 | sdk identity binding and the moderator key (MF-27) | A tab holding an imported moderator key reported `auth: 'guest'`, `identity: null` with `role: 'moderator'` (the v0.3 guestbook then showed "guest" and a write would have asked for a sign-in). | `IdentityBinding.setLoaderKey(info)`: while a loader-held key signs, the site sees it (`'signed-in'`, `mode: 'legacy'`); set by `app.js` and `dropin/ledger.js` when they load a moderator key. e2e 4. |
| R-12 | sdk identity deps and idp's client | Neither the shell nor drop-in passed `scope` (the scope the pointer was verified under), which the identity origin checks first. | `scope` in both (`identityExtra`; `createDropinIdentity` forwards it). Drop-in test checks the request carries it. |
| R-13 | sdk `personal-site.js` genesis | A second minting path (`signedControlBlock`) next to `ChainNode.genesis` could drift from it. | `genesisBlocks` needs `ChainNode.genesis` (E_UNSUPPORTED without) and refuses blocks for another ledger; the duplicate is gone. Tests updated. |
| R-14 | tools `package.json` and the runtime | `v021-integration` (I-6). | `version` 0.3.0 in package.json, npm-shrinkwrap.json and package-lock.json (root entries). |
| R-15 | the e2e regression suite and v0.3 | Six scenarios still asserted v0.2.1 behaviour. | Posting signs in at the real identity origin (above); scenario 2's follower posts after the engine tab signed in (R 2.4.1, E-ID-2b: follower tabs never hold keys); scenario 4 confirms the loader's MF-27 card; PEER-WS bounds requests by (failureLimit + 1) x files per piece (the v0.3 guestbook has 16 files in its one piece, so 3 failed attempts are 48 requests; the old fixed 30 assumed 9 files); FMT-SDK checks the v0.3 surface (`identity` has current, setName, backupStatus, openIdentity; a guest's `identity` is null) and refuses every LOADER_ONLY method over a raw port. `window.__mwShell.rectOf(label)` (as `__mwDropin.rectOf`) lets a test click a loader card in its closed root. |
| R-16 | the sdk lane's unit tests | Contract mocks of landed modules. | `dropin-v03`: lane idp's real WorkingKeys (instances recorded) and a real identity origin in process (`createIdp` behind `client.signIn`, as lane idp's tests do) replace the fake keys and client, only the window-bound client calls stay stand-ins; the `ChainNode.prototype.setIdentity` patch is gone (`dropin-fakes.mjs` FakeChainNode mirrors `setIdentity` and `writeControl`); `sdk-v03-wiring`: expectations follow the real shapes (no sealTo, `keys()` only, sign-only keys are a guest); `sdk-v03-personal`: genesis through `ChainNode.genesis`. New `test/unit/integration-v03-reconcile.test.mjs` (9 tests) mounts the real identity (with an in-process identity origin, `createIdp`, as lane idp's own tests do), chat, files, media and sealed modules through `mountV03Services`, in the shell's MwApi and in drop-in mode, over real ChainNodes. |
| R-17 | idp `idp-protocol.test.mjs` | The tampered-bundle check flipped the second-to-last ciphertext character to a letter chosen by the last one, so when it already was that letter nothing changed and the expected E_DECRYPT never came (about 1 run in 64; it failed once in this pass). | The flip always changes the character. |

### The contract-first adapters, one by one

| Adapter (deviations/sdk.md) | Now |
|---|---|
| `setNodeIdentity` | `ChainNode.setIdentity` (R-6) |
| `mod.js writeControl` | `ChainNode.writeControl` (R-7) |
| `nodeIdentityOf`, `workingKeysOf` | WorkingKeys `identity` and the service's `keys()` only (the guessed shapes are gone) |
| `ownerConfirm` | the identity service's `ownerAction` (R-8) |
| genesis | `ChainNode.genesis` only (R-13); `keys.rc` and `keys.nextPubHash` from WorkingKeys (no `recoverCommitment` or `nx` aliases) |
| hub follow lane | MultiGossip, `recent.js` and `wire-ext.js attachToTorrent` checked against chain-net's surface (they fit); reads fixed (R-4); still joined as kind `'group'` (open below) |
| `sealedAdapter` | seal and open over sealed.js (fit); no sealTo (R-9) |
| drop-in identity | `createDropinIdentity` checked against lane idp's signature (fits; `scope` added, R-12) |
| 0.2.1 key migration | `legacy` deps and `migrate.legacyAuthorFor` fit; the bind order fixed (R-3) |
| PSL check | `pslHubCheck(host, PSL_RULES)` fits (string rules, the same algorithm) |
| redirect answer | `applyPendingSignIn` calls the service's `adopt` only |

### Contract changes (folded into INTERFACES v0.3, status kept "proposed")

`ChainNode.setIdentity` and `writeControl`; the identity service's `ownerAction(card)` and `OWNER_ACTIONS`; WorkingKeys `ecdh` and the
ChatKey with raw points; the chat service's `groupMembers`; the sdk lane's hub amendment, `mountV03Services`, the chat seam,
`sealedAdapter` without sealTo, `IdentityBinding.setLoaderKey`, `api.ownerConfirm`, `viewAdapters` and `__mwShell.rectOf`; the
built MultiGossip and recent.js surface (chain-net's own record); the chat panel's events.

### Open after this pass

- **The hub follow lane's wire budget kind.** It joins as `'group'` (R 2.7.1's priority list names no hub kind). A `'hub'` kind with
  its own floor, and MultiGossip's `wantedWires` driving it, is a review-round decision (the sdk lane's request to harden-loader).
- **Durable grants (kind 4 in `mw.s`).** No reader exists (scan `mw.s` by `hintFor`, open with the chat box); until one lands,
  `durable: true` sends over chat only (R-9).
- **The sdk lane's ui requests** stay open: own sentences for E_NOT_OWNER, E_NOT_MODERATOR, E_IDENTITY, E_NO_HOST, E_CAP, E_INTERNAL
  and E_TIMEOUT (they borrow nearby sentences, `ERROR_STRING_KEYS`); a card kind for one tombstone (today the `confirm` card in danger
  style); `PROMPT_TEXT` and app.js's two inline English texts moved to strings.js.
- **E-ID-*, E-CH-* beyond the media gate, E-FI-1, 2, 4, 5, 6, E-MD-3 to 6, E-SO-*, E-HD-1** are not written yet (final integration).
  The real identity origin now runs in the e2e stack, which they can build on. E-ID-9 and E-SO-12 still need axe-core.
  (The rows lanes of 2026-10-22 wrote them; the table below has their status.)
- **The drop-in bundle size**: `_mw/mw.js` was 738,816 bytes in the sdk lane's scratch build (esbuild inlines the dynamic imports of
  the services); code splitting would be a build change, not made here.
- A follower tab cannot start a sign-in (identity methods there are E_POLICY, R 2.4.1): the v0.3 guestbook calls `mw.auth.signIn()`
  for a guest, so in a second tab it shows its E_POLICY sentence ("The site owner does not allow that on this site."), which misleads,
  until the first tab signs in (seen in this pass's first e2e run of scenario 2). A code or sentence of its own for "sign in from the
  first tab" is a decision for the ui and examples lanes.

## Final integration (integrator after every lane, 2026-10-20 13:28 to 15:54 ET)

Lanes landed: freeze, harden-loader, idcore, chat, media, ui, docs, idp, chain-net, tools, sdk, examples (twelve of twelve;
none unbuilt). The examples lane was built contract-first against a mock of the SDK (`test/example/mock-sdk.js`), so its
browser tests never met the loader; the drop-in widgets' checks 11 to 20 of `examples/existing-site-dropin/EXPECTED.md` had not
run in a browser either. This pass ran the social template, the Example Forum's widgets, the guestbook's members features and
the identity origin through the real loader, SDK and identity origin end to end, fixed what broke (F-1 to F-14 below, each in
the code with a test), added 22 end-to-end scenarios in five new scenario files and two helpers, and recorded the status of
every end-to-end row of the review's test plan. The mock-based tests of `test/example/` stay: they check the pages' own logic
and layout fast, and the new scenarios check the same template against the real code. Network policy held in every browser run
(Chromium with `chromiumArgs()`, WebKit on `http://127.0.0.1` only; one policy change, F-10). Nothing was pushed, tagged or
published.

### Results (live tree)

| Suite | Before (13:28 to 13:40 ET) | After |
|---|---|---|
| `npm test` (lint-floor + unit) | lint-floor clean (127 files); 1,529 tests, 1,529 pass | lint-floor clean (127 files); 1,533 tests, 1,533 pass, 0 fail (15:52 ET) |
| `npm run test:browser` | 37 tests: 36 pass, 1 skipped | 37 tests: 36 pass, 1 skipped (the v0.1 worker test; 15:52 ET) |
| `npm run test:example` | 170 tests, 170 pass | 170 tests, 170 pass (15:53 ET; 169 of 170 at 15:29 ET, see below) |
| `node test/e2e/run.mjs` | 38 of 38 PASS, network policy PASS, 139.7 s | 60 of 60 PASS, network policy PASS, 378.2 s (15:42 to 15:49 ET; also 60 of 60 in 375.2 s, 15:29 to 15:35 ET) |
| `node test/e2e/run.mjs --webkit` | 41 of 41 PASS, network policy PASS, 143.2 s | 63 of 63 PASS (the 60 Chromium scenarios, then W7, W-SI and W-MD in WebKit 27.2), network policy PASS, 368.6 s (15:35 to 15:42 ET) |

The first full run of the final code (15:28 ET) had one failure: `test:example`'s lint-floor check over the social template
flagged the `navigator.userActivation` read of F-11 (b) (Safari 16.4, above the floor). The read is optional and guarded, so it
carries `lint-floor-ignore` as the loader's own read in `src/loader/api.js` does, and a browser without the API now gets the
link as well; every suite ran again after that change (the two e2e runs at 15:35 and 15:42 ET, the other three at 15:52 ET, after the documents
below were edited).

### Findings and fixes (F-1 to F-14)

| Id | Seam | What broke (and how it was seen) | Fix |
|---|---|---|---|
| F-1 | sdk `createPersonalSite` and the loader's source lists | A personal pointer carried only `v, btih, owner, chain, gen, nx, seq, exp` (R 3.3). A signed record is announced only on its own `tr=` and fetched only from its own `ws=` and `xs=` (`announceListFor`, `filteredLists`), so a page created with "Create my page" had no tracker and no web seed on its new origin and could never load the template (E-SO-1). | `transportOf(record)` in `src/loader/personal-site.js`: the new pointer repeats the template's `tr=`, `ws=`, `xs=` and `idp=` (never `cs=`, `gen=`, `chain=`, `lo=`, `rot=`, `nx=`, `org=`), signed by the person; `app.js` passes the page's record. Unit test in `sdk-v03-personal.test.mjs`. Contract change: ARCHITECTURE 15.13, INTERFACES. |
| F-2 | sdk `mw.ready()` in shell and hub mode | The first answer was kept for ever (a `readyPromise` memo; the drop-in path asked every time), so a page that signed in still read `auth: 'guest'` and `identity: null`; the social app never showed its signed-in screens (E-SO-1). SDK.md already says `auth` and `identity` follow the sign-in. | `src/sdk/sdk.js`: calls made while the first is pending share it; later calls ask the loader again. `sw-sdk.test.mjs`: the memo assertion became an equality, plus a regression test (guest, signed in, signed out) that fails on the old code. |
| F-3 | chain-net `MultiGossip` and the loader | Nothing called `multi.tick()`, which the chain-net lane's contract asks for once a second (request timeouts, the ANN of new heads of held ledgers, window refreshes, the phone wire trim), nor `setHidden()`. A member who followed a page saw its first window and never a later post (E-SO-2). | `startHubLaneClock(A)` in `src/loader/app.js` (an interval of 1,000 ms and a `visibilitychange` listener), and a read-only `hubLane` object in `window.__mwShell.inspect()` (joined, clock, stats, held, followed, peers). |
| F-4 | harden-loader `FileTorrentHandle.metadata()` (integration I-3) and the files and media lanes | WebTorrent builds a `torrentFile` the moment a magnet is added, without an info dictionary; `metadata()` resolved at once with it, so every file fetched by infohash failed `validateFileTorrent` ("file metadata: missing info dictionary", `E_FILE_HASH`; E-FI-1, E-FI-2) and every accepted media offer was forgotten as "the swarm does not match the grant" (E-MD-4). The unit test's fake torrent had no early `torrentFile`. | `_metadataBytes()` returns null until `torrent.info` exists. The unit test now models WebTorrent's early `torrentFile` (it fails on the old code). |
| F-5 | idp `resolveIdp` and the `<mw-signin>` widget | The widget calls `client.signIn` without a pointer, and nothing on a drop-in page set `<meta name="mw-idp">` or called `configure()`: a forum published with `--idp` answered `E_IDP_UNREACHABLE` (E-SI-1W). | `resolveIdp` reads `idp=` from the page's stamped pointer (`<meta name="mw-pointer">`) when no pointer is passed. Three unit cases in `identity-client.test.mjs`. |
| F-6 | ui `<mw-chat-panel>` and the chat service | The panel showed its own "Turn on chat" consent card, then `mw.chat.enable()` showed the chat service's card with the same text, so a visitor answered it twice; the second card was also out of reach of `window.__mwDropin.rectOf` (E-CH-R). | The panel calls `mw.chat.enable()` inside the click and shows no card of its own (no import of `src/loader/ui.js`); `src/dropin/panel.js` `rectOf` falls back to the v0.3 cards' own root. Read-only test hooks on the panel: `lobby` and `rectOf(label)`. Unit tests rewritten for the one card (decline, refusal, hooks). |
| F-7 | ui shell Settings and R MF-03 | The 0.2.1 export and import fields (two password fields, a file field) were in the shell's DOM from the start, hidden only once a v0.3 model arrived: the DOM scan of E-ID-10 found them on every page. | `src/loader/ui.js`: the rows are added only for a model without `identity.v03` (a build without the identity service), as the drop-in panel always did. |
| F-8 | the loader's and the identity origin's Public Suffix List | A loopback subdomain hub cannot get persistent identity unless both sides list its suffix: the identity origin had `--test-psl`, the loader had nothing, and it read only `PSL_RULES`. | `build({ testPsl })` in `build.mjs` defines `MW_TEST_PSL` like `tools/build-idp.mjs`; `app.js` reads `PSL_RULES` plus `PSL_TEST_RULES` (empty outside a test build). |
| F-9 | boot.js / render.js development CSP | On a loopback subdomain hub the web seed is the hub root (`http://localhost:<port>/ws/`), another origin than `<label>.localhost`: `connect-src 'self' https: wss: ws://...` refused it (E-SO-1). | Development only (`mw-dev`, loopback): `connect-src` also allows `http://127.0.0.1:*` and `http://localhost:*`, in both copies of the policy (the test that they agree passes). |
| F-10 | test network policy | Labels of the hub are hostnames, `<label>.localhost`; `chromiumArgs()` mapped every name but `localhost` to NOTFOUND and the guard counted them as remote. | `EXCLUDE *.localhost` in the resolver rule and `*.localhost` in `isLocalUrl`. Chromium answers `*.localhost` itself, without DNS (checked: such a name loads from a 127.0.0.1 server, `example.com` does not resolve). WebKit stays on `http://127.0.0.1`. docs/DEV-NETWORK.md says so. |
| F-11 | examples/social | (a) `findPointer` took a copied address that escapes only the spaces (`v=mw1;%20btih=...`) as a pointer whose fields have names like `%20btih`, so "Follow by link" said the link had no pointer (E-SO-2); (b) after the identity origin's cards the tap no longer counts, and the sandboxed frame may move the top window only during one, so "Create my page" could not open the new page; (c) the README's publish command had no `--spa`, so a reload of `/@<label>/p/<h>` showed the 404 page (E-SO-11). | (a) a candidate counts only when its fields parse, and anything after a second `#` is dropped (asserted in `social-lib.test.mjs`); (b) `openTop(url, label)`: move the top window while the tap is active, else show a link to tap (`navigator.userActivation` is read only where the browser has it; without it the page tries and shows the link as well); (c) `--spa` in the README command and in the e2e publish. |
| F-12 | examples/existing-site-dropin | EXPECTED.md and the README switched chat on with `ledger-admin cfg --chat members`; the forum's visitors are readers of its ledger (its posts live on its own server), and `members` lets only writers chat, so every visitor got `E_POLICY` (E-CH-R). | `--chat open` in the README, EXPECTED.md, `dropin-widgets.test.mjs` and the e2e. |
| F-13 | docs/SDK.md `mw.files.preview` | The documented `{ kind, url }` with a `/_mw/f/` address does not exist: the files lane returns `{ kind: 'text', text }`, `{ kind: 'image', url, w, h }` with a `blob:` URL of the PNG it drew, or `{ kind: 'none' }` (E-FI-1). | SDK.md now describes the landed shapes; `/_mw/f/` is named as the address of `files.save`. |
| F-14 | `.gitignore` | `dist-idp/` and `dist-idp-test/` (outputs of `tools/build-idp.mjs`) were not ignored, and the auto-checkpoint runs `git add -A` (the idp lane's request). | Both are ignored. |

### New end-to-end scenarios (five scenario files and two helpers, wired into `test/e2e/run.mjs` before 13)

| File | Scenarios | What they need |
|---|---|---|
| `test/e2e/hub-stack.mjs` (helper), `test/e2e/scenarios-social.mjs` | E-SO-1, E-SO-2, E-SO-11 | a loopback subdomain hub: the loader and the identity origin built with the PSL addition `localhost`, the template published with `--spa` and a web seed on the hub root, labels at `http://<label>.localhost:<port>` (Chromium only) |
| `test/e2e/scenarios-dropin-v03.mjs` | E-SI-1W, E-CH-R | the Example Forum staged with its widgets, published with `--dropin --chain forum-chat --signin-widget --chat-panel --idp`, chat switched on at `cs=`, served by the sign-in fixture server |
| `test/e2e/scenarios-identity.mjs` | E-ID-1, E-ID-2, E-ID-2B (the review's E-ID-2b), E-ID-4, E-ID-5, E-ID-6, E-ID-10, E-ID-7 | the e2e stack's identity origin; E-ID-1 a second one at `http://localhost:<port>` with Chromium's virtual authenticator (PRF), attached to the popup's own DevTools target |
| `test/e2e/scenarios-members.mjs` | E-CH-1, E-CH-8, E-CH-6, E-FI-1, E-FI-2, E-MD-4, E-MD-3, E-MD-5 | a guestbook with `_mw.cfg` `{ chat, files, media: 'members' }` at `cs=`, its own tracker and STUN, two or three signed-in members in their own contexts |
| `test/e2e/scenarios-hardening.mjs` | E-HD-1 (the HELLO half) | a hostile page with the vendored WebTorrent in the ledger's rendezvous swarm, served by the e2e gate |
| `test/e2e/idp-driver.mjs` (helper) | | answers the identity origin's cards the way a person does: a real mouse click after each card's press guard |

Two things learned on the way that bind the next scenario authors: Playwright runs every `page.evaluate` with a user gesture,
which the loader counts as the click a UI method needs (E-ID-5 makes its "no gesture" calls from a timer 5.6 s later and
evaluates nothing meanwhile); and block times are rounded down to the minute (`TS_ROUND_MS`), so "newest first" inside one
minute is by hash and a "new posts" indicator needs a later minute (E-SO-2 waits for it, in two steps under the step cap).

Measured in the three final e2e runs (loopback, Apple M3, Chromium 156 and WebKit 27.2): the owner's first post on a new
personal page took 438 to 443 ms from the click on Post to the post on the wall (E-SO-1); during 60 hostile HELLO frames the
longest event-loop stall in the visitor's tab was 1 to 2 ms over 65 ticks of a 50 ms timer (E-HD-1); in WebKit the reference
MP4's first frame took 30 ms and its three seeks 13 to 34 ms (W-MD). The suites took 21.0 s (unit), 7.7 s (browser) and
31.8 s (example) in the 15:52 ET run.

### The test plan's end-to-end rows (R 4.2), one by one

"pass" means the row as the review writes it ran in a browser and passed in this pass's final runs; "pass, partial" names the
half that did not run; "open" says why and where the row's logic is unit-tested instead. Scenario names are those of
`node test/e2e/run.mjs` unless a row says otherwise.

| Row | Status | Where | What ran, or why it is open |
|---|---|---|---|
| E-ID-1 | pass | E-ID-1 | a passkey through Chromium's virtual authenticator with PRF, attached to the popup's own DevTools target: one ceremony (a create with PRF), working keys installed, a post |
| E-ID-2 | pass, partial | E-ID-2 | "Stay signed in" keeps the key across a reload, a guest without it, and a sign-in brings the same key back; that sign-in is a passphrase unlock, not one tap: a virtual authenticator belongs to one DevTools target (one popup), so the next popup has none (the passkey path is E-ID-1's) |
| E-ID-2b | pass | E-ID-2B | one stored key record before sign-out, none after (IndexedDB inspected); the follower tab went to guest |
| E-ID-3 | pass | E-ID-3 | restore at the identity origin in a browser: the 12 words from the kit give the same key, the same check code and "Found 1 post", and the old private record reads null; the backup file (made at #backup) gives the same key and the record back |
| E-ID-3b | pass | E-ID-3B | a mistyped phrase that passes the checksum: another check code and "No posts found for these words on <site>", then another key |
| E-ID-4 | pass, partial | E-ID-4 | two sites get different keys; "Same as on <the other site>" with its second press gives one key; revoking that for the future (`stopSame` at the identity origin) is unit-tested only (identity-core-vault) |
| E-ID-5 | pass | E-ID-5 | from the guestbook's site frame (where any site code runs), 5.6 s after the last input: `mw.me.get` is `E_NEEDS_GESTURE` and no identity window opens; `identity.export`, `identity.import` and `identity.root` are not in the SDK |
| E-ID-6 | pass | E-ID-6 | host-only: signed in with 0 tracker sockets and 0 peer connections |
| E-ID-7 | pass | E-ID-7 | a shared-origin hub: "this visit only" offered, a visit-only key |
| E-ID-8 | pass | E-ID-8 | a look-alike origin on another loopback port serving the victim's signed pointer (the same ledger id): "not one of this site's addresses", naming the browser-reported origin, and its own pairwise key (o\|origin) while the victim keeps its ledger key (l\|ledger id); a second identity origin's forged ready and answer are ignored (0 messages reach it) |
| E-ID-9 | pass | E-ID-9, E-ID-9B | 32 screens, 0 violations (wcag2a, wcag2aa, best-practice); keyboard-only sign-in; docs/deviations/a11y.md |
| E-ID-10 | pass | E-ID-10 | the guestbook's three pages, the drop-in forum and five social screens: no such field; the first run found the shell's 0.2.1 fields (F-7) |
| E-ID-11 | pass | E-ID-11 | window.open stubbed to null in every frame: the loader's Sign in card, blocked again, "Continue in this tab", the redirect round trip through /_mw/idp-return signs in and clears the address |
| E-ID-12 | pass | `npm run test:browser` (idp-browser) | Argon2id under the identity origin's CSP in Chromium and WebKit; PBKDF2, named on the card, without `'wasm-unsafe-eval'` and with WebAssembly removed |
| E-ID-13 | pass | E-ID-13 | init scripts and a virtual authenticator: no PublicKeyCredential (no passkey button, noPrf line, passphrase); PRF off (1 create, no PRF output, noPrf and clean-up lines, passphrase); no getClientCapabilities (passkey offered, 1 create with PRF) |
| E-ID-14 | pass | E-ID-14 | two identity-origin contexts with typed QR payloads: matching numbers, the identity moves (same key on the site); a substituted key in QR 2 gives different numbers and "They differ" sends nothing; a substituted reveal is refused (linkCommitBad) |
| E-ID-15 | pass | E-ID-15 | the loader's in-page card (popups blocked): no field and no high-risk control in its closed root; an overlay and a host restyle each cancel it with the redress notice and a click there does nothing; the untouched card acts |
| E-SI-1 | pass | E-SI-1 (identity origin stand-in), E-SI-1W (the real identity origin, the Example Forum's widget) | success and a session cookie; E-SI-1W also checks the widget files' hashes, the cooldown and the cross-origin URLs refused (EXPECTED.md checks 11, 13 to 15, 17) |
| E-SI-2 | pass | E-SI-2; W-SI with `--webkit` | replayed, foreign-origin and expired proofs refused |
| E-SI-3 | pass | E-SI-3 | a local proof refused by the server library |
| E-SI-4 | pass | E-SI-4 | two server instances with one nonce directory |
| E-SI-5 | pass | E-SI-5W; E-SI-5 (identity origin stand-in) | E-SI-5W (`scenarios-dropin-v03.mjs`, written in the v0.3 code review, passing since round 2) drives the real identity origin through the rewriting proxy and reads the proof off the wire: the proof names the proxy origin and the forum's server refuses it with `origin`. E-SI-5 does the same with the stand-in `lab.proofFor`, which signs the proxy origin by construction |
| E-CH-1 | pass | E-CH-1; E-CH-R | direct messages over the chat lane, sent then delivered; E-CH-R: two signed-in visitors in one Lobby through `<mw-chat-panel>` (EXPECTED.md checks 18, 19) |
| E-CH-2 | pass | E-CH-2 | recipient offline: the ACK timeout (30 s) sets the hold flag, a holder holds the frame ("handed" at the sender), the sender leaves, the recipient returns and collects it with WANT-TAGS and HELD, and COLLECTED empties the holder (`scenarios-chat-rows.mjs`) |
| E-CH-3 | pass | E-CH-3 | 5 stranger frames with stamps below 20 bits: struck by the relay, 0 relayed, 0 at the recipient; a stranger message with a stamp minted at 20 bits (147 ms and 502 ms in two runs, Chromium, this machine) lands in requests and is accepted |
| E-CH-4 | pass | E-CH-4 | after the ban, the relay reads the banned member's room frame and relays none, and the reader shows nothing; the banned member's own send is `E_BANNED` |
| E-CH-5 | pass, partial | E-CH-5; unit: chat-lane-groups (U-CH-6) | a removal and an invite started at the same moment converge on one epoch (A, B, D); the removed member reads nothing after removal; the newcomer has no earlier message or epoch secret; two admins rekeying at once is unit-tested only (the API has one admin) |
| E-CH-6 | pass | E-CH-6; E-CH-6M | `chat.enable`, `files.share` and `media.upload` refused with `E_HOST_ONLY`, no card, no socket |
| E-CH-7 | pass, partial | E-CH-7 | an Android context under Chromium device emulation is classed "android" by the loader's `detectEnvironment` and `chatDeviceClass`; holder `E_POLICY`; a line through the phone relays 0 bytes, and a desktop relay delivers; "Share on this network" and the iOS class are not driven. Verifier round 1 (2026-10-24): the control step depended on the order of earlier scenarios (B's WANT-TAGS goes to a neighbour other than its largest byte source, `src/chat/lane.js:951` to `:962`); it now waits for R's route and for A to hold R (`test/e2e/scenarios-chat-rows.mjs:787` to `:803`), 3 of 3 alone (deviations/review-round-verify-1.md) |
| E-CH-8 | pass | E-CH-8 | every block of every `mw-chain-*` store of both members scanned: no message text, id or chat key |
| E-CH-9 | pass | E-CH-9 | a DM delivered live across a holder (ACKed after 20.8 s): no frame with the hold flag reaches the holder, which holds 0 |
| E-CH-10 | pass | E-CH-10 | a neighbour floods the relay with 16 KiB frames at 24 a second (6,043 KiB in 16 s; 218 dropped at the queue caps); six contact DMs over two runs took 1.41 s to 2.90 s (bound 5 s, met), measured once the relay holds the recipient's WANT-TAGS route |
| E-CH-11 | pass | E-CH-11 | frames captured at a relay after Noise: no plaintext, no site key, no publicly computable inbox tag; WANT-TAGS entries are 1-byte prefixes (168 entries in 14 frames), and sealed wire bytes carry no key text |
| E-CH-12 | pass | E-CH-12 | a relay that swaps peer ids: forwarding unchanged gives sessions with the real keys and nothing readable, and injected messages fail AEAD; swapping the XX ephemeral fails the handshake; answering as itself, it is seen under its own chat key |
| E-FI-1 | pass, partial | E-FI-1 | upload card; premoderation (code review round 2): pending for its new author, neither listed nor fetchable for the other member until the owner accepts it offline (`ledger-admin listed`, served at `cs=`); then listed, fetched by another member after the offer card, previewed, removed by its owner and gone from the list; the `_deny/` half (the host's deny list stops fetch and seed) is unit-tested only (sdk-v03-wiring, tools-v03-ledger) |
| E-FI-2 | pass, partial | E-FI-2 | only the recipient fetches, decrypts and previews it; not listed for the site; a third context fetching the infohash for ciphertext is not written |
| E-FI-3, 3b, 3c | pass, partial | E-FI-3 | HTML and SVG with a script download as attachments through the route and never render; without a worker the Blob is octet-stream. The scenario opens file sessions in the media lab: an upload through `mw.files.share` with the SDK's Blob (3b) and limited mode (3c) are not driven (the scenario says so in its result) |
| E-FI-4 | open | real-device row G-MD-5 | the memory bound on a phone-class file is not measurable in the harness: Chromium here has no phone memory ceiling to emulate, and its heap measures leave out Blob storage, IndexedDB and the media pipeline, where a file's bytes live (docs/deviations/rows-media.md) |
| E-FI-5 | pass | E-FI-5 | a JPEG with Exif GPS, a camera make and an ICC profile, and an MP4 with ©xyz, loci and a QuickTime location key, shared publicly and fetched by another member: the fetched bytes hold none of them (asserted on the bytes; ftyp and moov kept; length and SHA-256 match the listing) |
| E-FI-6 | pass | E-FI-6 | refused before any card: a public file over 25 MiB and private media over the desktop cap (E_LIMIT), HTML named .mp4 (E_MEDIA_TYPE); a JPEG/HTML polyglot comes out as a JPEG without the HTML or the COM segment; a listing whose len lies is aborted (E_FILE_HASH) and hidden; one whose sha256 lies is dropped after the download and hidden |
| E-MD-1 | pass, partial | E-MD-1 | 20 MiB reference MP4: only ciphertext in the chunk store, no chunk starts with `ftyp`, the padded total 23,068,672 bytes, a poster, a sealed own-index item; the wire half is not checked (no second peer in that scenario) |
| E-MD-2 | pass, partial | E-MD-2; W-MD with `--webkit` | three seeks, each answered 206, `HAVE_CURRENT_DATA` after each; on the uploader's own profile, not on a second profile linked by device link |
| E-MD-3 | pass | E-MD-3, E-MD-3B | a third member who was not given the item has no route and open() is refused; from that member's own browser context, the ciphertext fetched by infohash matches the piece table, holds no plaintext, opens with a recipient's key and with no key held in that context |
| E-MD-4 | pass | E-MD-4 | the grant in a sealed direct message; the recipient plays through `/_mw/media/<sid>` (206, `readyState` 4 after a seek to 1.0 s) |
| E-MD-5 | pass | E-MD-5, E-MD-5R | revoke: the recipient's loader drops the key, open() is E_REVOKED, the item leaves its list; with reencrypt the remaining recipient plays the new item, the uploader's old chunks are gone, and the revoked recipient's old key opens no chunk of the new ciphertext |
| E-MD-6 | pass | E-MD-6 | a pin node run as a child process (node tools/pin.mjs, loopback, temporary profile; --queue and --approve as their own processes) fetches and keeps the item; with the uploader offline a fresh member plays it from the pin (206 after a seek); with no holder online the accept ends in "unavailable" and the grant is kept; a restarted pin plays the kept grant with nobody else online, and an --approve on a running node is started within one status tick (rows-media D-1 and D-2 fixed by the R 5.3 integrator: deviations/review-round-integration.md section 1; passed alone in 108.4 s on 2026-10-24) |
| E-MD-7 | pass | E-MD-7 | the worker stopped over the DevTools protocol; the next seek plays after the session is registered again |
| E-MD-8 | pass | E-MD-8 | the Blob fallback up to the cap; `E_LIMIT` over it |
| E-MD-9 | pass | E-MD-9 | a cross-origin page embedding the media URL gets a 404 |
| E-MD-10 | pass | E-MD-10 | `moov` at the end rewritten at upload; the first frame needs no tail chunk |
| E-SO-1 | pass | E-SO-1 | sign-up creates the personal site in the browser (genesis, pointer, keyinfo; policy writers `owner`, bits 16), and the owner posts on their own wall without a fee. The harness ticks the identity page's hub box; the default for the template (N-6) is not checked (deviations/examples.md, request R-1) |
| E-SO-2 | pass | E-SO-2 | follow by link; the timeline merges both ledgers over the hub follow lane; "new posts" shown for a later minute. Its intermittent miss (R 5.3) was a consent race: a hub lane that joined while the consent card was open never started (`src/loader/torrent.js:3628` to `:3637`, fixed in verifier round 1); 5 of 5 since, and the step asserts each tab's lane has kind 'hub', a torrent and one torrent manager (`test/e2e/scenarios-social.mjs:238` to `:243`) |
| E-SO-3 | pass | E-SO-3 | BO's comment on ADA's post is an `mw.c` item on BO's own ledger aimed at ADA's post; ADA's wall setting accepts it and her `mw.ok` lists it (3,458 to 6,506 ms in three runs); CY, who follows only ADA, sees "Comments (1)", accepted (docs/deviations/rows-social.md) |
| E-SO-4 | pass | E-SO-4 | BO reacts "heart", then "laugh": one key `re/<ADA's ledger>/<h>` on BO's ledger with `{ r: 'laugh' }`; CY counts 0 before following BO and "1 from people you follow" after; ADA counts 1. Verifier round 2 (2026-10-24): it no longer needs E-SO-3 in the selection; when E-SO-3's two follows are missing it makes them by link (ADA follows BO, CY follows only ADA; `test/e2e/scenarios-social-rows.mjs:238` to `:250`), and `--only E-SO-1,E-SO-2,E-SO-4` passed 3 of 3 (deviations/review-round-verify-2.md) |
| E-SO-5 | open | E-SO-5 (runs only with `--only E-SO-5`); unit: hub-lane-multi, hub-lane-recent | the 20 tool-made ledgers are made and served as `cs=` windows, but no browser holds them on the hub lane. rows-social D-1 is fixed (`holdOwnLedger`, `src/loader/app.js:3841`), but since STALK-3 a page holds only the signed-in key's own ledger, and the scenario's seeder contexts open the tool-made pages as readers: rerun alone on 2026-10-24 09:23 to 09:26 ET, it failed at "SEED-A opens Synthetic 01 ... held on the hub lane" (role reader, lane held [] after 40 s; network policy PASS). The scenario's premise needs the owners' keys in the seeders, or a rule for holding pages one follows (rows lane) |
| E-SO-6 | pass, partial | E-SO-6 | a reader's first visit to a tool-made page nobody holds: the first screen comes from the page's own loopback `cs=` recent window (`recent-v1`, 16 blocks), newest first, 12 posts in 1,068 to 1,100 ms; open: the member's merged first screen from the hub's per-ledger windows (rows-social C-1, a missing clause) |
| E-SO-7 | pass | E-SO-7 | a group made with the tools (writers `allow`, ADA moderator): BO's "Ask to join" reaches ADA's `mw.mod.queue` in about 2,017 ms, ADA confirms, BO becomes a writer ("You're in."), posts, and ADA's ban removes the post for both; the request travels as `mw.chat.dm.send` grants, not `mw.mod.requestJoin` (C-2), and ADA and BO are contacts first (rows-social D-2) |
| E-SO-8 | pass | E-SO-8 | ADA's Alerts list a reply, a follow and a mention from BO (from BO's window), and the group page shows "New messages" after BO's direct message |
| E-SO-9 | pass | E-SO-9; E-SO-9B (runs only when named) | offline: ADA posts with every other page closed and the post shows at once (526 ms) with "Showing what this device has"; an offline reload shows the shell, the app and her posts. Verifier round 1: the R 5.3 failures ("1 new post" in place of the post) came from the social app's timeline keeping its old top (`examples/social/js/model.js:286` to `:296` `timelineTop`); 6 of 6 since. The queued write (E-SO-9B): once ADA is back online the post reaches BO over the hub lane. It failed on 2026-10-24 09:26 to 09:29 ET because the offline reload signs ADA out (the plan's "Stay signed in" is off, `test/e2e/idp-driver.mjs:9`, `:72`) and since STALK-3 a signed-out page holds nothing on the lane (`holdOwnLedger`, `src/loader/app.js:3841`); after verifier round 2 ADA signs in again once online, as a person would, and the step asserts role `owner` and her ledger in `inspect().hubLane.held` (`test/e2e/scenarios-social-rows.mjs:597` to `:615`); `--only E-SO-9,E-SO-9B` passed 3 of 3 (10:35 to 10:42 ET; network policy PASS). E-SO-9B still runs only when named, so the full suites do not run it (deviations/review-round-verify-2.md) |
| E-SO-10 | open | none | examples GAP 2: `mw.hub.withdrawPage()` does not exist |
| E-SO-11 | pass | E-SO-11 | a reload of `/@<label>/p/<h>` shows the same post (needs `--spa`, F-11) |
| E-SO-12 | pass, partial | E-SO-12 | 28 screens, 0 violations; keyboard-only post and follow; the keyboard-only DM is not scripted |
| E-SO-13 | open | `npm run test:example` (mock SDK) | the directory stays off pending counsel; not driven against the real loader |
| E-HD-1 | pass, partial | E-HD-1 | 60 HELLO frames with `d` = 2^53 - 1 on the rendezvous wire: refused, the tab never stalled, `mw.ready()` still answers; one peer id on many wires and the `ut_metadata` flood are unit-tested (harden-loader-wires, harden-chain-hello) |

In all: 64 rows, 60 that ran and passed (48 as written, 12 in part) and 4 open. The open rows are E-FI-4, E-SO-5, E-SO-10 and E-SO-13. (Verifier round 2 of R 5.3, 2026-10-24: E-SO-9 counts as written now that its second half, E-SO-9B, passes, so 47 and 13 became 48 and 12; E-SO-9B is a scenario, not a row, so the 4 open rows are unchanged. Verifier round 1 of R 5.3, 2026-10-24: E-MD-6 counts as written now that rows-media D-1 and D-2 are fixed, so 46 and 14 became 47 and 13. Code review of v0.3, 2026-10-20: E-SI-5 and
E-FI-3 were counted as written; each runs only part of its row, so the counts went from 24 and 9 to 22 and 11. Round 2, 2026-10-21:
E-SI-5W ran and passed with the real identity origin, so E-SI-5 counts as written again: 23 and 10.
`test/unit/docs-claims.test.mjs` now checks that a row marked "pass" names at least one scenario whose own header does not
call it PARTIAL. Finish run, 2026-10-22: the a11y lane and the identity, chat, files and media, and social rows lanes ran 27 of
the 31 open rows, 21 as written and 6 in part, and finished the open halves of E-MD-3 and E-MD-5, so the counts went from 23,
10 and 31 to 46, 14 and 4; the cell texts are the lanes' own, from docs/deviations/a11y.md, rows-identity.md, rows-chat.md,
rows-media.md and rows-social.md.)

### Spec and document status

ARCHITECTURE section 15 and the v0.3 part of INTERFACES are marked **v0.3** (built) from this pass, with the parts that are not
built marked **(proposed)**: the durable-grant reader (15.5), the hub's recent-window first screen, shards above 1 and a
wire-budget kind of its own (15.8), the kill switch's purge mode (15.11), and the examples' GAP 2 to 4. ARCHITECTURE 15.13 and
the last INTERFACES subsection list this pass's contract changes. The user documents' status line went from "Status: v0.3
(proposed), not yet built." to "Status: v0.3, built, not yet reviewed." in sixteen places (docs/README.md describes the
convention; the recipes' status rows say what ran end to end); SECURITY.md's security program reads "v0.3, partly built, not
yet reviewed" (its code parts exist, its people parts have not happened). The other "v0.3 (proposed)" phrases in COMPATIBILITY,
DEPLOY, OPERATIONS, DEMO-RESULTS, PRIVACY, SECURITY-MODEL, ROADMAP, docs/README.md and PUBLISH-CHECKLIST were read one by one
and now say "v0.3" where the part is built. The changelog's `## [Unreleased: v0.3 (proposed)]` block became
`## [Unreleased] - 0.3.0`, drafted from the lanes' notes. The design review itself is not edited.

### Open after the final integration

- **The review round of R Part 5** (the six judges, the eight red-team attackers and the conformance agent against the built
  code) has not run (it ran from 2026-10-22 to 2026-10-24: docs/review/V03-DESIGN-REVIEW.md, section 5.4, and
  docs/deviations/review-round-*.md); nor the outside review of the new cryptographic code (Noise XX, the sealed box, `p256.js`, the plain
  JavaScript Argon2id) that R 2.19 asks for before 1.0.
- **Real devices:** every row of `docs/DEMO-RESULTS.md` is "not yet run" (62 result rows, 0.2.1 and v0.3): iOS Safari and Home
  Screen apps, Android Chrome, passkey PRF across synced devices, Firefox (not launchable in the harness then: its rows are "not
  run"; since 2026-10-22 it runs in the harness on loopback, docs/deviations/firefox.md), media playback on iPhone, the device link by camera, the comprehension test G-ID-9. (On 2026-10-22 and 2026-10-23 the
  desktop parts of G11, G12, G13, G14, G19 and G-CH-8 ran in a Brave browser on loopback: docs/DEMO-RESULTS.md.)
- **The 31 open end-to-end rows** in the table above, each with its reason; E-ID-9 and E-SO-12 wait for the owner's decision to
  add axe-core as a dev dependency. (2026-10-22: axe-core was added and the rows lanes ran 27 of the 31 rows; 4 are open.)
- **SDK gaps the social template names** (examples GAP 2 to 5): `mw.hub.withdrawPage()`, `mw.mod.requestJoin(group)`,
  `mw.site.info().pointer`, and a way for a followed snapshot to say "withdrawn" or "removed by the hub"; `files.fetch`,
  `preview` and `save` with `{ ledger }` (examples request 4: a picture listed on a followed ledger cannot be fetched from the
  follower's own page); `cfgOk` has no `wall` key (examples D-2 keeps it in the profile item); notices are direct messages
  (D-3), not an ENV kind.
- **UX seen end to end, for the ui, idp and examples lanes:** on a hub label the identity origin's sign-in card says "This
  address is not one of this site's addresses." (a btih-scoped pointer has no host, so only `org=` could list a label), on
  every sign-in; "Create my page" right after signing in is refused for 10 s (`E_RATE`, the card cooldown) and the template
  shows the code's sentence; "Follow by link" is offered on the timeline only while it is empty; the hub root's redirect logs
  one CSP error in the console (the root page's own loader import is torn down by `location.replace`; nothing fails).
- **From the earlier passes, still open:** the hub lane's wire-budget kind, the durable-grant reader, the sdk lane's ui requests
  (own sentences for seven codes, a card kind for one tombstone), the drop-in bundle size (738,816 bytes for `_mw/mw.js` in the
  sdk lane's build), a follower tab's sign-in sentence, COLLECTED that a holder cannot verify (chat O-1), the kill switch's
  purge mode, the owner sign-off of R 1.5 (an owner step in `docs/PUBLISH-CHECKLIST.md`).
