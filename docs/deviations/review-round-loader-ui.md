# Review round R 5.3: loader-ui fixer (2026-10-24)

Fixer for the area "loader-ui" of the review round (V03-DESIGN-REVIEW 5.3, item 2). Findings come from
`.orchestration/reports/all-findings-2026-10-22.json`, and the verifiers' notes from `verdicts-2026-10-23.json`. Every
regression test is in `test/unit/review-round-loader-ui.test.mjs` (21 tests), unless the row names another file. Each test
fails on the code before the fix. Wire, storage and vector formats did not change, with one exception: the premoderation
acceptance key of MAL53-1. That key is a format defect, and 0.3.0 has not been released.

## Findings

| Id | Status | Files (file:line) | Test |
|---|---|---|---|
| MAL53-1 (blocker) | fixed | `src/loader/mod.js:251` `listedId`, `:259` `listingVisible`, `:274` `listedKeysOf`, `:554` accept writes `_listed/<b64url sha256(ih + "\n" + author)>` = `{ by, t, ih, author }` | "MAL53-1: an accepted infohash credits only its own author", "a legacy _listed/<hash(ih)> key credits only a sole lister", "on a real open ledger" (real reducer, real `appendControl`, ledger-admin's legacy `acceptListing`). The `test/unit/loader-review-v03.test.mjs:395` pin now expects the bound key. |
| SCALE-14 | fixed | `src/loader/mod.js:223` `allowRoomOf`, `:546` (a join accept checks the moderator's UTC-day room and the 1,000-key allow cap, then refuses with `E_LIMIT` and a sentence; nothing is written) | "SCALE-14 on a real node" (real `ChainNode`, `modAllowPerDay` 2, the third accept is refused and the height does not change), "an accept when the allow list holds 1,000 keys is refused" |
| UX-1 | fixed | `src/widget/redress.js:163` (`start()` re-arms), `:199` `rebase()`; `src/loader/ui.js:1162` `relayout()` after show, finish, status and resize (`:1166`, untrusted resize ignored); `:1187` a card guard closes only its own card; header guards only notify (`makeButton` `onCancel`) | "UX-1: the header drawn while a card is open still signs out", "a real overlay on the header cancels only the header click, re-arms it" |
| UX-2 | fixed | `src/loader/ui.js:1276` (status line reserves `min-height: 1.4em`), `setStatus` calls `relayout()`; `redress.js:199` (`rebase` restarts the 250 ms window only when the button really moved) | "UX-2: retrying the sign-in card after an error status is not cancelled" |
| UX-3 | fixed | `src/loader/ui.js:1194` `notifyRedress` (OK button, `NOTICE_MS` 6 s at `:1047`), `:1207` `dismissNotice` (unmounts the host) | "UX-3: the redress notice has OK, goes away by itself" |
| UX-10 | partial | `src/loader/strings.js` `UI_TEXT.signinOpenInBrowser` (English and French). The cooldown lives in `src/widget/signin.js:78-80`, which the identity area owns: see Request R1. | Request R1 names the test |
| UX-11 | fixed | `src/loader/strings.js:426` (E_BANNED neutral), `:429` onward (E_CAP, E_NOT_OWNER, E_NOT_MODERATOR, E_IDENTITY, E_TIMEOUT, E_INTERNAL, E_NO_HOST in English and French); the `test/unit/widget-chat-panel.test.mjs:141` pin now expects "You cannot post here." | "UX-11: every SDK error code has its own English and French sentence" |
| UX-13 | fixed (boot copies: Request R7) | `src/loader/strings.js:271` `STRINGS_FR`, `:352` `stringsFor`; `src/loader/ui.js:347` (createUI picks it from `uiOpts.lang`, sets `lang="fr"` on its root) | "UX-13: with a French browser the consent card, the notice and the settings are French" |
| SCALE-6 | partial | `src/loader/torrent.js:93` (`SWARM_KINDS` + `hub`), `joinLane` `:3823` (kind `hub`, `wanted()`, `syncing()`), `_caps('hub')` `:2511`, `_budgetConfig` `:1805`; `src/loader/policy.js:327` (`SWARM_PRIORITY`), `:349` `budgetPriority`, `:355` `withHub` (hub floor 1, first while syncing). The pin in `test/unit/harden-loader-wires.test.mjs:340-346` now includes `hub`. The hub lane still joins as `group` until Requests R2 and R3 land. | "SCALE-6: the hub follow lane is its own swarm kind" |
| SCALE-7 | partial (no code here) | Every line involved is in other areas' files: `src/loader/app.js:3375-3385` (memory store), `src/chain/multi.js:1041` (RECENT from depth -1), `src/loader/personal-site.js:289-293`. See Request R4. | Request R4 names the test |
| SCALE-12 | partial | `src/loader/strings.js:880`, `:916` (`seed.ask`) and the `seed.monthUsed` texts now say "on this site" / "sur ce site"; `test/unit/strings-c2.test.mjs:51-53` updated. The verbatim quotes in `docs/ARCHITECTURE.md:948-949` and `docs/PRIVACY.md:462` were updated with them, because `strings-c2` checks that they match. A hub-wide month counter needs a cross-origin meter (identity origin or apex), which is a design decision: Request R5. | "SCALE-12: the seeding cap texts say the month cap is per site" |
| MAL53-6 | fixed (lane wiring: Request R6) | `src/loader/torrent.js:513` `fileMetadataBound`, `:527` `guardMetadataSize`, `:1606` (every file wire), `:805` `FileTorrentHandle.expectedLength`, `addFileTorrent({ expectedLength })`. Without a length the bound is the 256 KiB `.torrent` limit, so the 10 MB bomb is refused today. | "MAL53-6: a file wire announcing 10 MB of metadata for a 1,000-byte listing gets no request and is destroyed" (real `ut_metadata`), "the vendored WebTorrent bundle calls onExtendedHandshake through the same extension object" |
| UX-17 (minor) | fixed | `src/loader/ui.js:1234` `restoreFocus`, `finish` passes focus to a queued card | "UX-17: focus goes back to the page element" |
| UX-18 (minor) | fixed | `src/loader/strings.js:101` `iosHomeScreenV03` (+ French), `src/loader/ui.js:873` | "UX-18: with a v0.3 identity the iOS hint points at the recovery kit" |
| MP-10 (minor) | fixed | `src/loader/torrent.js:2225` (have-all and have-none in O(1), at most one full bitfield count per wire per 250 ms) | "MP-10: a flood of have-none, have-all and bitfield messages" |
| MP-14 (minor) | fixed | `src/loader/seed-planner.js:82` (reported copies count as one at most; `pinned` and `copies.checked` in full); the `test/unit/seed-planner.test.mjs:29` order is updated | "MP-14: unchecked complete bitfields count as one copy at most" |
| MP-15 (minor) | fixed | `src/loader/superseed.js:34` `PIN_WAIT_MS`, `:239` `_pinWaiting` deadline, `:255` timer; `torrent.js:2457` passes the manager's clock | "MP-15: a pin wire that never reports a revealed piece stops blocking" |
| MAL53-10 (minor) | partial | `src/loader/ui.js:1530` (a full card queue declines its newest offer, never the next consent or sign-in card). The per-sender cap of offers is in `src/media/service.js:160-172` and `src/files/lane.js:545-565`: Request R8. | "MAL53-10: a flood of offers does not auto-decline the next consent card" |
| MP-9 (minor) | rejected: minor, deferred | `src/loader/pinwire.js:386-397` is outside this fixer's files. Its consequence for super-seeding is bounded by MP-15's deadline above. | none |

Ownership note: `src/loader/mod.js` belongs to the loader-pointer fixer. The brief assigned MAL53-1 (a blocker, "fix it first")
and SCALE-14 to this fixer, so the edits stay inside `listingVisible`, `listedKeysOf`, the new `allowRoomOf` and `listedId`, and
the two accept branches of `mod.decide`. That fixer's SYB-11 work in `addToQueue` and `receive` is not touched.

## Requests

- **R1 (identity, `src/widget/signin.js:78-80`, UX-10).** In `createSigninRunner().run`, add `const prevLast = last` before
  `last = now();`, and add `} catch (err) { if (err && (err.code === 'E_POPUP_BLOCKED' || err.code === 'E_USER_CANCELLED')) last = prevLast; throw err; }`
  in front of the existing `} finally {`. At `:184`, when `code === 'E_POPUP_BLOCKED'` and this is the second block in a
  row, or the client reports `opensInPlace`, say `uiText('signinOpenInBrowser', this.lang)` (the string now exists in
  English and French). Test: the client rejects E_POPUP_BLOCKED, and a second `run()` right away calls `client.signIn` again
  (no E_RATE).
- **R2 (loader-pointer, `src/loader/app.js:3773`, SCALE-6).** Replace `tm.joinLane({ kind: 'group', infoHash: ih, announce: [own], ledgerSync: true })`
  with `tm.joinLane({ kind: 'hub', infoHash: ih, announce: [own], ledgerSync: true, wanted: () => A.multi.wantedWires, syncing: () => A.multi.syncing === true })`,
  and change the comment at `:3772` to "the hub lane is a ledger swarm with its own swarm kind (SCALE-6)". A TorrentManager
  from before this round would throw on `kind: 'hub'`, but both ship in the same build.
- **R3 (chain, `src/chain/multi.js:361`, SCALE-6).** Add a public getter next to `wantedWires`:
  `get syncing() { return !this._hidden && !this._idle(); }`. Test: it is true after `follow()` and false once every follow
  is current.
- **R4 (loader-pointer and chain, SCALE-7).** In `src/loader/app.js:3380`, `openFollowedLedger` should use a persistent block
  store instead of `new chain.MemoryBlockStore()`: one IndexedDB store keyed by ledger, counted in the ledger storage line
  (`policy.js` `ledgerBudgetFor`, 64 MiB on phones and 256 MiB on desktop), with LRU over follows. In
  `src/chain/multi.js:1041`, `_startRecent` should ask RECENT from the stored head depth instead of -1. Test (multi): a reopened
  MultiGossip with a persisted window issues RECENT only above the stored head. E2E (an E-SO-2 variant): a reload fetches
  fewer than 10% of the blocks of the first load.
- **R5 (docs, SCALE-12).** `docs/PRIVACY.md:446` ("the loader's per-origin store") should add: "On a hub, every member page is
  its own site, so the month cap applies to each one separately." The quoted card texts at `docs/PRIVACY.md:462` and
  `docs/ARCHITECTURE.md:948-949` were already updated here (three table cells, so that `strings-c2` passes). A hub-wide
  counter, at the identity origin or through a meter at the hub apex, is a design item for ROADMAP.
- **R6 (media, `src/files/lane.js:217` and `src/media/lane.js:143`, MAL53-6).** Pass the listing's length so that each file
  wire gets the tight bound: in `files/lane.js` `_addTorrent`, use
  `Object.assign({ store, announce: this._announce(), retain: true, expectedLength: Number.isSafeInteger(rec.size) ? rec.size : null }, opts)`.
  In `media/lane.js`, add `opts.expectedLength = <the grant's chunk count x piece length>` before `addFileTorrent(opts)`.
  Test: a fake file wire that announces `metadata_size` 10,000,000 for a 1,000-byte listing is destroyed, and its handle
  reports `expectedLength` 1000.
- **R7 (loader, `src/loader/boot.js`, UX-13).** boot.js has the five boot texts in English only (strings.js:28-33). A French
  copy chosen by `navigator.language`, plus the boot-copy test extended to both languages, is left to the owner of boot.js,
  which neither loader fixer was given.
- **R8 (media, MAL53-10).** In `src/media/service.js:160-172`, cap open offers at 3 per sender and 20 in total, drop and count
  the rest, and offer to block the sender after the cap. In `src/files/lane.js:545-565`, cap received private-file grants and
  vault writes. Test (media-service): 50 grants from one sender leave at most 3 offers.
- **R9 (chain, `tools/ledger-admin.mjs:799-811` and `:1137-1141`, MAL53-1).** `listedKey(ih, author)` should return
  `'_listed/' + b64url(sha256(utf8(ih + '\n' + author)))` when an author is given. `acceptListing({ blocks, identity, ih, author })`
  should resolve the author from the ledger when it is not given: the single author of the listings with that infohash.
  With none, or with more than one, it throws a ToolError that asks for `--author`. The value becomes `{ by, t, ih, author }`.
  The CLI `listed` command takes `--author <pub>`. Until this lands, the tool's legacy key still works for a sole lister
  whose listing is older than the acceptance (`mod.js:274` documents the rule). The e2e scenarios members, c2 and
  media-rows list each file once, so they are unaffected. Test (`test/unit/tools-v03-ledger.test.mjs:505-539`): add a
  second key that lists the accepted infohash; `listingVisible` is false for its listings.
- **R10 (docs, MAL53-1).** `docs/OPERATIONS.md:717`, `docs/ARCHITECTURE.md:1931` and `:1943`, and `docs/INTERFACES.md:1704`
  and `:1773` should name the bound key `_listed/<b64url(sha256(utf8(ih + "\n" + author)))>` = `{ by, t, ih, author }`. They
  should say that acceptance covers that author's listing and that author's later ones, and never another key that lists
  the same infohash.
- **R11 (sdk, `src/loader/api.js:239-247`, UX-11).** `ERROR_STRING_KEYS` maps seven codes to "nearest" sentences. Each of
  them now has its own sentence, so the seven overrides can go and every code can map to itself. Nothing reads the map for
  display: `errorText(code)` is used directly.

- **R12 (examples, `examples/peer-guestbook/js/common.js:41-46` and `js/app.js:33`, UX-11).** The guestbook copies the loader's
  sentences. Set `E_BANNED: 'You cannot post here.'` (common.js:41). Copy the new `ERROR_TEXT.en` sentences for E_NOT_OWNER,
  E_NOT_MODERATOR, E_IDENTITY, E_CAP, E_INTERNAL and E_TIMEOUT into common.js:43-46, and those for E_INTERNAL and E_TIMEOUT
  into app.js:33. The alternative is to add these codes to the `OWN` set of `test/example/site.test.mjs:476`. Until then,
  `npm run test:example` fails "R 3.9 and the card copy" and "UX-15" in site.test.mjs.
- **R13 (integrator, `examples/social/js/strings.js:41` and `:51-57`, UX-11; a reserved file).** `test/example/social-lib.test.mjs:226`
  requires every `ERROR_TEXT.en` code to read the same in the social app. Set line 41 to `E_BANNED: 'You cannot post here.'`
  and lines 51-57 to the loader's new E_NOT_OWNER, E_NOT_MODERATOR, E_CAP, E_IDENTITY, E_NO_HOST, E_TIMEOUT and E_INTERNAL
  sentences. The other way is to let line 226 skip codes the app words for "this page". Until then, "strings: the error
  table is the SDK's" fails in social-lib.test.mjs.

## Runs

- Unit: `node --test test/unit/review-round-loader-ui.test.mjs` 21/21. The files these fixes touch, run on their own, pass:
  ui-v03-cards, ui-c2-cards, ui-v03-strings, widget-chat-panel, loader-review-v03, tools-v03-ledger, files-c2-handoff,
  harden-loader-wires, loader-review-v03-torrent, superseed, torrent-seed-lanes, sdk-c2-seeding, loader-app-torrent,
  pinwire, seed-planner, strings-c2 and hub-lane-multi.
- End to end (`node test/e2e/run.mjs --only ...`, Chromium, local-only, every request on 127.0.0.1): E-PS-1 to E-PS-4, E-ZS-1,
  DOOR-DOWN, DOOR-HASH, DOOR-GUEST, E-CH-1, E-FI-1 (premoderation and the owner's acceptance), E-FI-2, E-CL-1 and E-CL-2 all
  passed (13 of 14). E-CL-3 timed out in that run, at "calls.start: not reached within 45000 ms", and passed alone right
  after, in 15.0 s. The identity scenarios that use the cards and the header (E-ID-1, 2, 4, 5, 6, 7 and 10, and E-SI-1 to 3)
  passed 10 of 10.
- `npm test` (2026-10-24, about 05:10 ET): the lint floor is clean over 147 files. 2,266 tests ran: 2,246 passed, 1 failed
  and 19 are todo. The one failure is `test/unit/repo-layout.test.mjs:31`, because the tools area added the untracked
  top-level `SECURITY-KEY.asc`; it is not from this fixer. An earlier run in this round, made while several fixers were
  testing at once, also stalled in the chat and calls suites. The calls, chat and chat-lane failures listed below were seen
  in those loaded runs. The failures in `calls-service`, `call-ui` and `chat-lane-service`
  ("timed out waiting for chat keys exchanged", "Ana's chat key came back from the sealed store") come from the parallel
  edits to `src/chat/service.js`. The calls fixture (`test/fixtures/calls/peers.mjs`) imports only `src/chat/*`,
  `src/calls/*` and `src/chain/crypto.js`, none of which this fixer changed.
