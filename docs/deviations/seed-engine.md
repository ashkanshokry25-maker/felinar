# Deviations and notes: seed-engine (v0.3 C2)

Lane: seeding engine: lane budgets in `torrent.js`, availability evidence, the browser side of `mw_pin1`, the
super-seeded hand-off, file and media labels (docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md, "SZ", 3.1.2 to 3.1.7;
S1-smart-phone-seeding.md D1, D4, D5, D6, F7, F8; V03-DESIGN-REVIEW 2.8.4, 2.8.6, 2.9.8, 2.9.11; ARCHITECTURE 8). The
computed task text carried `BRIEF: undefined`; the brief was read from `.orchestration/args/c2/seed-engine.md`.

Built contract-first: seed-policy's `seed-budget.js`, `seed-meters.js`, `seed-planner.js`, `localwire.js` and pin-node's
`src/pin/frames.js`, `src/pin/heartbeat.js`, `test/vectors/pin.json` landed while this lane ran; the code below uses
them as landed (their notes: `docs/deviations/seed-policy.md`, `docs/deviations/pin-node.md`) and the tests mock them
only at the deps boundary where a test has to steer them.

## Files

- `src/loader/torrent.js` (lane-owned, shared loader file): every insertion is marked `// C2 seed-engine`; eight v0.3
  lines were replaced, nothing was removed. List of insertion points at the end of this file.
- New: `src/loader/availability.js`, `src/loader/superseed.js`, `src/loader/pinwire.js`.
- `src/files/lane.js`, `src/files/service.js`, `src/media/lane.js`, `src/media/service.js`: lanes, evidence, labels,
  the owner's automatic pin request.
- New tests: `test/unit/availability.test.mjs` (16), `superseed.test.mjs` (13), `pinwire.test.mjs` (16),
  `torrent-seed-lanes.test.mjs` (21), `files-c2-handoff.test.mjs` (12).
- Kept green without any change: `loader-app-torrent`, `harden-loader-wires`, `harden-loader-hooks`, `media-service`
  (118). No contract they test changed.

Tests run (`node --test` on the nine files above): 196 pass, 0 fail. Also run read-only because they import these
modules: `integration-v03`, `integration-v03-reconcile`, `loader-app-policy`, `loader-app-tracker-shim`,
`v021-integration`, `lint-contrib` (44 pass). `node tools/lint-floor.mjs` on the eight source files: clean. An
in-memory esbuild bundle of `torrent.js`, `pinwire.js` and both services at the floor targets (es2020, Safari 15.4,
Chrome 110, Firefox 115): no warnings (dist/ untouched). The e2e suite and the full unit suite were not run.

## Exported signatures (the contract wire-ui, docs-strings and the integrator build against)

```
// src/loader/torrent.js (additive)
export const SEED_LANE_IDS = ['H', 'K', 'E']
export function createBucket(rate, now, burstMs = 1000) -> { rate, cap, tokens, at, drained, timer }  // cap = max(32 KiB, 1 s of rate)
export function bucketLevel(b, now) -> tokens; bucketTake(b, bytes, now) -> drained now; bucketRefillMs(b, now) -> ms
export function peerPiecesHeld(wire, pieces) -> pieces the remote reports
TorrentManager({ ..., deps: { ..., planSeeding?, isLocalPair?, seedMeters? } })   // defaults: the seed-policy modules
  setSeedBudget(budget | null) -> boolean          // a seedBudget() result; null = the v0.3 rules again
  setSeedMeters(meters)                            // createSeedMeters() on the per-origin pref store (memory by default)
  meters                                           // the meters in use
  seeding -> { active, row, lanes: { H, K, E: { rate, session, used, local, open } }, month: { used, cap }, local }
  evidenceInputs(ih, { now }) -> { local, wires, webseed, pin, now, capped, pinPct }   // availability.evidence() input
  evidenceFor(ih, { now }) -> availability.evidence(...) + { infoHash, pinPct }
  localState(ih) -> { kind: 'site' | 'file', complete, length, pieces } | null
  setPinSource(pinWire | null); notePin(ih | null)  // PinWire.attach() calls both
  addFileTorrent({ ..., lane: 'H' | 'K' | 'E' })    // default H with uploadException, else E; re-adding promotes E -> K -> H
  event 'evidence' { infoHash, kind: 'site' | 'file', evidence }   // when what a label shows changes
  status 'handoff-done' { infoHash, reason: 'receipt' | 'peers' }, 'superseed-stopped' { infoHash, reason }
  warning 'seed-plan-error' { message }
  registerWireExtension handlers: onWire(wire, kind, { late, infoHash })   // infoHash added
FileTorrentHandle
  lane (getter), setLane(lane) -> lane, handedOff, addedAt, uploaded (piece bytes sent for this item, cumulative)
  evidence({ now }), evidenceInputs({ now }); events 'lane' { lane, reason: 'set' | 'receipt' | 'peers' }, 'evidence' { evidence }

// src/loader/availability.js (pure)
export const TIERS = ['E0', 'E1', 'E2', 'E3', 'E4']
export const WINDOWS = { bitfieldMs: 60000, webseedMs: 600000, heartbeatMs: 900000 }
export const LABELS = { onlyHere: 'avail.onlyHere', heldBy: 'avail.heldBy', keptBySite: 'avail.keptBySite',
                        nobody: 'avail.nobody', noPin: 'avail.noPin' }
export const HANDOFF_LABELS = { waiting: 'handoff.waiting', sending: 'handoff.sending' }
export const HANDOFF_STATES = ['onlyHere', 'waiting', 'sending', 'kept', 'sent', 'nobody']
export function evidence({ local, wires, webseed, pin, now, cap, capped }) ->
  { tier, count, atLeast, reported, checkedAt, label, params, local, sources, notes }
  // wires: [{ id, complete, at, checked? }]; webseed: { ok, at } | [..]; pin: { configured, receipt: { at } | null,
  // heartbeat: { at, has } | null }; params { n } (heldBy, noPin) or { age } ms (keptBySite)
export function availableOf(ev) -> 'kept' | 'online' | 'unknown'
export function publicEvidence(ev) -> { tier, count, atLeast, reported, checkedAt }   // the SDK object
export function handoffState({ ev, requested, pinPct }) -> { state, label, params }    // params { pct } for sending
export function sameEvidence(a, b) -> boolean; isLabel(key) -> boolean

// src/loader/superseed.js
export function emptyBitfield(pieces) -> Uint8Array
export class SuperSeed({ pieces, has(i), isPin(wire), onStop({ reason }), onReveal({ wire, index }) })
  addWire(wire) -> boolean (synchronously from 'wire'), removeWire(wire), pinChanged(), noteReceipt(), stop(reason),
  stats() -> { active, reason, wires, reveals, distinct, duplicates, inflight }, active, reason

// src/loader/pinwire.js
export const EXT_NAME = 'mw_pin1', FRAME_MAX = 1024, NONCE_BYTES = 16, SKEW_MS = 300000, HEARTBEAT_MAX_AGE_MS = 900000,
  HEARTBEAT_EVERY_MS = 600000, HEARTBEAT_MAX_BYTES = 262144, HEARTBEAT_MAX_ITEMS = 4096, MAX_FRAMES_PER_WIRE = 16, STRIKES = 3
export function helloBytes(ih, n, at), receiptBytes(ih, total, at), statusBytes(obj), statusItem(ih),
  encodeFrame(obj) -> bytes | null, decodeFrame(bytes) -> frame | null
export async function verifyHelloSZ, verifyReceiptSZ, verifyStatusSZ; export const SZ_CODEC
export function loadPinCodec() -> Promise<codec>   // src/pin/frames.js + heartbeat.js when they load, else SZ_CODEC per function
export function createPinWire({ tm, pinKey, win, fetch, now, random, codec, site, log }) -> PinWire
  attach(tm?) -> this, detach(), refresh() -> Promise, key, responder, ready
  evidence(ih, now) -> { configured, receipt, heartbeat: { at, has } | null, checkedAt }
  receipt(ih), isPinWire(wire), pinWires(ih?), pinProgress(ih, pieces?) -> 0..100 | null
  fetchHeartbeat(wsBase, { force }) -> Promise<{ at, key, has(ih), monthBytes, monthCap, checkedAt } | null>, heartbeat()
  on('receipt' | 'pin-wire' | 'heartbeat' | 'warning', fn) -> off
export async function fetchHeartbeat(wsBase, { pinKey, fetch, now, site, codec }) -> { ok, reason, heartbeat }
  // one read of <ws base>/pin-status.json, verified, no cache (INTERFACES names this module-level function; the
  // PinWire method adds the 10 minute interval and the cache)
export function createPinPageHost({ tm, storeClass(ih), announce() }) -> { start({ ih, name, size, state }), stop(ih), status() }

// src/files/service.js, src/media/service.js: optional deps { owner, pinEvidence(ih, now), evidenceInputs(ih) }
// files.list / files.received / media.list entries, added:
//   available: 'kept' | 'online' | 'unknown'      (files: new field; media: kept, now from evidence)
//   evidence: { tier, count, atLeast, reported, checkedAt }, label: <LABELS or HANDOFF_LABELS key>, labelParams: {...}
//   handoff: { state, pct? | n? | age? }            (the uploader's own items only)
// prompt { kind: 'phone-upload', name? } before an own upload seeds on a phone (the MF-45 card of ui.js)
```

## Readings and deviations

1. **The vendored webtorrent sends its first message after the 'wire' event** (brief item 4, checked first). In
   `node_modules/webtorrent/lib/torrent.js` 3.0.21 `_onWire` emits `'wire'` and only then, in a `queueMicrotask` (or
   from `_onStore` once the store is verified), calls `_onWireWithMetadata`, which sends `wire.haveAll()` (Fast
   Extension and every piece), `wire.haveNone()` or `wire.bitfield(this.bitfield)`. The minified dist bundle that
   build.mjs vendors has the same order (`this.emit("wire",e,t),this.ready&&ue(()=>{this._onWireWithMetadata(e)})`).
   So own-property wrappers installed synchronously from TorrentManager's `'wire'` listener mask that first message;
   `superseed.test.mjs` asserts both sources, and a real bittorrent-protocol 5.0.9 wire shows the bytes going out
   (bitfield of zeros, then one have). The library sends `have(i)` only when a downloaded piece verifies (never for a
   complete own upload); the wrapper drops it while super-seeding.
2. **Super-seeding, simulated.** With fake wires (P pieces, N peers that pipeline 4 requests at this device and fetch
   rarest first from a random holder, this device serving one piece per tick), the bytes this device uploads before
   the first complete copy elsewhere: super-seeding 100.0% worst and mean over 120 swarms (P 32 to 128, N 3 to 6); a
   plain seed 151.9% mean in the same swarms. With an authenticated pin wire, exactly 100% before the pin's complete
   copy. These are simulation results, not measurements (gate row G-PS-8 measures). Off by default
   (`CONFIG.seed.superSeed`), and only for H torrents on phones. Reveals are rarest first counting in-flight reveals;
   while an authenticated pin wire is connected and incomplete only pin wires get reveals (the phone's budget goes to
   the durable holder). It stops at a receipt or a complete peer bitfield (a liar's `have-all` ends it early: the
   seed then behaves as a plain seed, no harm beyond efficiency); requests for unrevealed pieces are not refused (a
   choke-locked lane still bounds them).
3. **Session and month caps are enforced from the meters' counters directly** (`sessionUsed(lane, { local })`,
   `monthUsed()`) against the budget's per-lane session (seed-policy reading 1), `local.session` per lane, and
   `month.cap` for `month.lanes` (K and E). Equivalent to seed-policy's request "stop a lane when remaining() is 0".
   Once a cap is reached the lane stays locked until the budget changes or a new UTC month starts (checked every
   `wireLimits.checkMs`). `budget.local.on === false` counts every wire as not local (seed-policy request).
4. **Buckets.** One per lane, one per local lane, and one per planned item whose planner share is below 1 (not local
   wires: a local wire draws only on its local lane). A bucket holds 1 s of its rate (at least 32 KiB) and a drained
   one unlocks when full again, so a lane that spends its second waits about 1 s. A budget recomputation keeps every
   bucket whose rate did not change.
5. **The client throttle with a budget** is the sum of the rates of the lanes (and local lanes) that have an unlocked
   wire, plus the 32 KiB/s shaping floor when other swarms (ledger rendezvous, chat, group) have wires, at least the
   floor; -1 (unshaped) when no lane wire may upload: they are choke-locked, never `throttleUpload(0)`. The throttle
   sits on every outbound byte of every wire, so the extra floor keeps ledger gossip outside the lanes. A desktop
   with all three lanes busy may send more than v0.3's single 1 MiB/s (seed-policy notes 2.25 MiB/s, arithmetic).
6. **Without a budget nothing changes**: `uploadsEnabled`, the per-upload exception, the hidden lock and the v0.3
   throttle are untouched (`setSeedBudget(null)` returns there). With a budget, site and file wires follow the lanes
   and other swarms keep the v0.3 rules. Two changes apply in both modes: an H handle ends its hand-off (lane K,
   `uploadException` cleared, so phones in the v0.3 mode stop sending it too) at a receipt or two complete peer copies
   (SZ 3.1.2), and file wires feed the meters by lane.
7. **Two complete peer copies can be claimed by liars.** A bitfield can lie; two lying wires end H early. The label
   then reads "Kept by you and at least 2 others online now (reported)", which says it is reported; the receipt path
   is authenticated. A spot-check (E2, v0.4) would close this; `availability.evidence` already takes `checked`.
8. **Evidence.** E0 = this page holds every piece (site seeding, file torrent done, an own upload, a fetched and
   verified copy). E1 = distinct complete holders (by peer id, else by wire) on wires open now or closed less than
   60 s ago (an open wire counts as seen now); `atLeast` when the swarm has reached its soft cap or the tab its wire
   budget. E3 = the site torrent's web seed passed a probe within 10 minutes (no probe exists for file `ws` fields
   yet: a lane may pass its own probe result into `evidence()`). E4 = a receipt (verified on an authenticated wire,
   in memory for the page session) or a heartbeat at most 15 minutes old that lists the item. Precedence: E3/E4
   ("Kept by the site", with its age) over E0+E1 ("Kept by you and at least {n} others", reported) over E0 ("Only on
   this device") over E1 alone, over nothing ("Nobody who has this is online right now").
9. **E1 without E0 is labelled `avail.noPin`** ("No always-on copy exists for this site. This file is available only
   while someone who has it is online."): the SZ table has no sentence for "others hold it, this device does not", and
   heldBy would say "Kept by you". The noPin sentence is true of that item even where a pin exists but does not hold
   it. Without `_mw.cfg.pin`, other labels carry `notes: ['avail.noPin']` for the extra line D4 asks for.
10. **'available' is now derived from evidence.** 'kept' needs E3 or E4: a manifest `ws` field or a pinned flag
    alone no longer reads 'kept' (S1 F8 named this as the defect). 'online' = E0 or a live holder; 'unknown'
    otherwise. A torrent seam whose handles report no evidence (an older TorrentManager) keeps the v0.3 'online'
    rule in the media lane. Files list entries gain the field (they had none).
11. **Hand-off states** for the uploader's own items: onlyHere -> waiting (a pin request was made, by SZ-6 or a
    click) -> sending (an authenticated pin wire reports part of the item, `pct` from its bitfield) -> kept. A peer
    with every piece and no pin reads `sent` with the heldBy label (`n`); the MF-45 text "Sent: one full copy reached
    {name}" (CARD_TEXT `sentOnPhone`) stays the loader's to show when it knows the recipient. An own item this device
    does not hold (restored from the ledger elsewhere) reads `nobody`, never "Only on this device".
12. **SZ-6 (owner decision, not signed)** is implemented as written in the brief: with `_mw.cfg.pin` set, an own
    upload whose author key equals the site owner's key (`deps.owner`, else `node.owner`) goes through
    `d.pin.request({ ..., auto: true })` right after it seeds; members' items stay UI-driven (`pinRequest`). pin-node's
    `--auto-accept owner` is the other half. Without a `d.pin` seam nothing is requested.
13. **The MF-45 card on phones.** H is the per-upload exception, so on a phone the lanes ask `{ kind: 'phone-upload' }`
    (the existing ui.js card "Sending this file uses your mobile data...") after the upload card. Declined, the item
    is seeded in lane K: on a phone that sends nothing unless "Share on this network" is on, and it stays "Only on this
    device". Desktops get no extra card.
14. **Lanes in the lanes.** Own uploads H; "Help share this file" and "Keep available" K (a live handle is re-laned,
    otherwise the swarm is joined in K); a fetch, an opened or accepted item E (the default). Nothing joins a swarm
    for a label: `list()` and `received()` only read. With seed-policy's planner an incomplete E item is idle, so
    once wire-ui sets a budget a file being fetched no longer uploads while it downloads (see request 4 below).
15. **mw_pin1 frames.** The browser builds and parses frames itself (JSON, at most 1 KiB) and verifies with lane
    pin-node's `verifyHello` / `verifyReceipt` / `verifyStatus` (loaded with a dynamic import; the SZ 3.1.6 codec in
    `pinwire.js` is the fallback per function and is checked against `test/vectors/pin.json` too: 11 vectors, both
    codecs, and the two interoperate both ways on fake wires). One chal per wire, only when `_mw.cfg.pin` is known
    (a key that arrives later challenges ready wires on `refresh()`); a receipt counts only on a wire whose hello
    verified, and only with the item's length (`total`); frames are queued per wire so a receipt sent right after
    hello waits for its verification; 3 bad frames close the wire (`ignoreWire`), more than 16 frames are ignored.
    Heartbeat membership is computed here from the signed items (`statusItem`), whatever `has()` the codec returns.
16. **Responder** only in the top frame, only when `window.__mwPinCall('pin.key')` equals `_mw.cfg.pin` (pin-node
    answers `null` without a key or under its owner-key guard). Each wire's first chal gets one hello; the receipt
    goes out once the item is complete here, with its length; a refusal by the node (`E_NOT_KEPT` and the like) is
    retried on the next evidence change. The key never enters the page.
17. **`createPinPageHost`** (pin-node's request "seed-engine or the integrator"): `window.__mwPinHost` for the pin's
    own page, `start` joins and keeps a pinned file in lane K with a retained store, `stop` leaves it, `status()`
    returns `{ files: [{ ih, uploaded, complete }] }` from the handle's new `uploaded` counter. The page never opens
    or renders a pinned file.

## Requests to other lanes

1. **wire-ui (`src/loader/app.js`, `api.js`, `bridge.js`, `sdk.js`).**
   - Call `A.tm.setSeedBudget(policy.seedBudget)` on every policy recomputation, and `A.tm.setSeedMeters(createSeedMeters({
     storage: <per-origin pref store>, key: 'seedMeters:' + origin }))` once; `mw.net.seeding()` reads `A.tm.seeding`
     (plus the dock and keeper state); call `meters.flush()` on pagehide (the manager flushes on hidden).
   - Create the pin wire once the manager exists: `createPinWire({ tm: A.tm, pinKey: () => (api.cfg() || {}).pin || null,
     win: window, site: ledgerId }).attach()`; call `refresh()` when `_mw.cfg` changes; call
     `fetchHeartbeat(<first ws= base of the pointer>)` after load and on the 10 minute rhythm (it rate-limits itself).
   - In the pin's own page (`pinWire.responder` true): `window.__mwPinHost = createPinPageHost({ tm: A.tm, storeClass:
     (ih) => IdbChunkStore.factory({ name: 'pin-' + ih, backend }), announce: () => [ownTracker] })`, and no seed budget
     there (`setSeedBudget(null)`): the node is infrastructure and `tools/pin.mjs` keeps its own month cap.
   - `mountV03Services` `common` deps: `owner: () => pointer owner key` (else the lanes read `node.owner`), `pin: {
     request(item) }` (the R 2.8.6 queue: today no seam is passed, so `files.pinRequest` and `media.pinRequest` answer
     E_POLICY and SZ-6 requests nothing), `pinEvidence: (ih, now) => pinWire.evidence(ih, now)`, `evidenceInputs: (ih)
     => A.tm ? A.tm.evidenceInputs(ih) : null`.
   - `mw.files.list` / `received` and `mw.media.list` entries now carry `evidence`, `label`, `labelParams` and, for own
     items, `handoff`; pass them through. The new prompt kind `phone-upload` already maps to the ui.js card.
2. **docs-strings.** Mirror the signatures above into INTERFACES 'v0.3 C2 (proposed)' (torrent.js additions,
   availability.js, superseed.js, pinwire.js, the list fields); ARCHITECTURE 8.1 can take readings 3 to 6 (lane
   enforcement), 8 and 9 (evidence and the noPin use) and 15 and 16 (mw_pin1 roles). Strings: `avail.noPin` also
   labels "others hold it, this device does not"; `handoff.sending` takes `{pct}` from 0 to 100.
3. **integrator.** E-PS-1 needs the pin wire attached in app.js and the pin fixture (pin-node); E-PS-2 is
   `availability.evidence` (liars stay reported, never kept); E-PS-3 needs wires that are not local (seed-policy's
   note: two tabs on one machine pair over host candidates); the build bundles `src/pin/frames.js` and
   `heartbeat.js` through `pinwire.js`'s dynamic imports and `seed-planner.js`, `localwire.js`, `seed-meters.js`
   through torrent.js's static imports. CHANGELOG items: readings 6, 10, 13 and 14, and the extension `onWire`
   third argument gaining `infoHash`.
4. **seed-policy and docs-strings (a wording question for the owner).** With a budget, seed-policy's planner keeps
   an incomplete E item idle, so fetching a public file no longer shares it while the fetch runs. The consent card
   `fetchPublic` ("Fetching also shares it with others while this page is open, and they see your IP address next
   to it.") and the lane's `FETCH_NOTE` then overstate what happens (peers still see the address and the pieces
   held). Either let an incomplete E item that the person is fetching run, or qualify the sentence.

## Open items

1. SZ-1, SZ-2 and SZ-6 are owner decisions not yet signed; SZ-2 rides `budget.hiddenH` (default off), SZ-6 is built
   as briefed (owner uploads queue themselves) and needs the `d.pin` seam wired to do anything.
2. Super-seeding stays off until G-PS-8; whether it breaks the Fast Extension (S1 Q4) is unmeasured: a Fast wire
   gets have-none instead of have-all and then haves, which BEP 6 allows.
3. No probe exists for a file or media `ws` web seed, so E3 applies to the site torrent only; S1 D6 allows it for
   files once a probe is wired (`evidence({ webseed })` takes it).
4. Receipts live in memory for the page session; a reload asks again (the pin answers hello and rcpt at once).
5. Every rate, window and cap is chosen (SZ 3.1.3, 3.1.5), not measured; G-PS-1 to G-PS-14 confirm or tune them.
6. A bitfield can lie (reading 7); spot-checks (E2) are v0.4.

## Insertion points in src/loader/torrent.js (all marked `// C2 seed-engine`)

Header paragraph; imports (seed-planner, localwire, seed-meters, availability, superseed); token-bucket helpers and
`normalizeSeedBudget` after `unlockWire`; `FileTorrentHandle` constructor (`lane`), `setUploadException`, and the lane
and evidence methods; the TorrentManager constructor (seed state); `_ensureClient` (initial throttle);
`_onVisibility` (meters flush); `setHiddenLock` (lanes decide); `_onWire` (upload accounting, close re-throttle,
`info.handle`, reqq for the lane rate, the simple-peer capture, `_shouldLock`, holders, super-seeding, the local-wire
test, the throttle); `_callExtension` (`infoHash`); `_housekeep` (`_seedTick`); `_applyFileLock`; the lane engine block
(`setSeedBudget` to `_seedTick`); `_applyUploadThrottle`; `_probeAll` (E3); `_startDownload`, `_finishDownload` and
`_startSeed` (plan and evidence of the site torrent); `setUploadsEnabled`; `destroy`; `addFileTorrent` (`lane`, promotion,
re-plan); the file torrent `'done'` handler; `_finishLeaveFile`.

## Mocks at the contract boundary (unit tests)

- `torrent-seed-lanes.test.mjs`: `deps.planSeeding` (a planner that serves every item, or fixed idle and shares),
  `deps.isLocalPair` (always local), `deps.seedMeters` (counting meters with a settable month figure); fake
  WebTorrent, torrents and wires (BEP 10 for mw_pin1). One test uses seed-policy's real `seedBudget()` and planner;
  the mw_pin1 test runs two real TorrentManagers with real PinWires and WebCrypto keys.
- `pinwire.test.mjs`: a fake manager (registerWireExtension, anchorWire, ignoreWire, localState, 'evidence'), fake
  BEP 10 wires, the `__mwPinCall` bridge of tools/pin.mjs (refusing all but the two signable forms), a fake fetch.
- `files-c2-handoff.test.mjs`: the torrent seam (handles with lane, setLane, evidenceInputs), a fake ledger node and
  chat; the real services, lanes, stores and sessions.
