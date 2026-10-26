# Deviations and notes: harden-loader (H1b, v0.3 wave 1)

Lane: v0.2.1 loader hardening, pointer freeze fields, the wire budget and the torrent hooks (V03-DESIGN-REVIEW, "R",
2.5.3, 2.7.1, 2.8.8, 2.16.4, 2.17.5; MF-04, MF-28, MF-30, MF-31, MF-39, MF-44, MF-45, MF-74, MF-75, MF-76, SC-6, U-HD-1;
ARCHITECTURE 15.4, 15.10).

Files written: `src/loader/torrent.js`, `src/common/pointer.js`, `src/common/magnet.js`, `src/loader/doh.js`,
`src/loader/config.js`, `src/loader/policy.js`, `src/loader/harden.js` (new), `test/vectors/pointer.json` (appended
ptr-019 to ptr-026), `test/unit/harden-loader-{wires,pointer,state,hooks}.test.mjs` (new), and the owned tests
`common-pointer`, `loader-common-doh`, `loader-app-torrent` (changes listed below). `src/loader/app.js` is not touched:
everything it needs is in `harden.js` and the modules above.

Tests: the four new files plus the six owned existing files: 191 pass, 0 fail (`node --test` on each). `node
tools/lint-floor.mjs`: clean. Every tool that imports `pointer.js` loads (publish, withdraw, check-site, dev-server,
ledger-admin, pin, snapshot, tracker).

## Contract changes (say so here, as the brief asks)

1. **rot= v1 deleted (MF-28, PTR A5).** `ROTATION_PREFIX` is no longer exported. `rotationInput(owner, seq)` and
   `signRotation({ owner, seq })` without a scope throw `TypeError`; `verifyRotation(record, prev)` without a scope
   returns false and never accepts the v1 input. Consequence: the frozen vector **ptr-010-rotation** (a v1 rot=) now
   verifies as `{ ok: false, reason: 'owner-changed' }`. It is not edited (append-only); the new vector
   **ptr-023-rot-v1-refused** carries `"supersedes": "ptr-010-rotation"`.
2. **nx= is sticky under one owner (closing a gap in R 2.5.3).** R says a later owner key is accepted only if it hashes
   to the previous record's nx. That alone is bypassed in two steps by a thief holding the current key (re-commit nx= to
   their own key, then rotate). So `verifyPointer` also refuses a record of the *same* owner whose nx differs from the
   previous record's (`'nx-changed'`, dropping nx= included). An owner changes the commitment only by rotating to the
   committed key. Withdrawals must carry nx= forward: `withdrawalRecord({ ..., nx })` takes it.
3. **nx= match needs no rot=.** When the previous record's nx= matches the new owner, the change is silent
   (`rotated: true`) without any rot= (pre-rotation: the committed key may be all the owner has left). With a pin and a
   matching nx the pin is satisfied when `previousRecord.owner === pinnedOwner`.
4. **verifyPointer results carry `nx`** (`'none' | 'match' | 'mismatch' | 'changed'`); new reasons `'nx-mismatch'`,
   `'nx-changed'`, judged after the clock checks and before the pin.
5. **Caps count wires, not peer ids.** `tm.peers` (display) still counts unique peer ids. Eviction among equal scores is
   random (`this._random`), not newest first.
6. **`resolveTxt` results carry `adWording`** (`'resolver says validated'` or null).
7. **`addFileTorrent` returns a Promise** (it parses the .torrent): `Promise<FileTorrentHandle>`, not a bare handle as
   the INTERFACES line suggests.
8. **ignoreWire never bans a peer id.** Only the wire closes: a swarm member could claim an honest visitor's
   self-declared id to get it banned (the eclipse wire-ext.js already describes).

## Exact signatures (for INTERFACES "src/loader/torrent.js (hook added by the hardening wave)", to be marked v0.3)

I do not own `docs/INTERFACES.md`; the integrator (or Q1) should replace that subsection with this block:

```
TorrentManager.addFileTorrent({ torrentFile?: Uint8Array | ArrayBuffer, infoHash?: hex40, store: StoreClass | storeInstance,
    announce: string[] /* own trackers; public defaults dropped, warning 'file-public-tracker-dropped' */,
    retain = true, uploadException = false }) -> Promise<FileTorrentHandle>
  // StoreClass: new Store(chunkLength, { name: infoHash, length, ...webtorrent opts }) (abstract-chunk-store; IdbChunkStore).
  // Private torrent added from the info dictionary only (the .torrent's announce and url-list ignored); .torrent <= 256 KiB;
  // E_BAD_TORRENT for a bad .torrent or an infohash mismatch; TypeError for a missing store or infohash.
  // Waits for peer consent; store and bitfield survive rebuild() when retain (RetainedStore). Same infohash -> the live handle.
FileTorrentHandle extends EventTarget  events 'torrent' { torrent }, 'done', 'error' { error }, 'left'
  fields infoHash, kind = 'file', announce, retain, uploadException, done, left; getters torrent, store
  leave({ now = false }) -> Promise<true>     // leaves once saved (torrent 'done'), or at once; destroyStore: false; never rejoined
  setUploadException(on)                      // MF-45: this infohash uploads while uploads are off (shaped at mobileOptInUploadLimit); hidden still locks
TorrentManager.joinLane({ kind: 'chat' | 'group', infoHash: hex40, announce: string[] }) -> LaneHandle   // bare infohash, left 1, own trackers only, rejoined on rebuild
LaneHandle extends EventTarget  event 'torrent'; fields kind, infoHash, announce, left; getter torrent; leave() -> boolean
TorrentManager.registerWireExtension(name, { onWire(wire, swarmKind, { late }) }, { swarms = ['rendezvous'] }) -> unregister()
  // name /^[a-z][a-z0-9_]{0,31}$/, not ut_metadata, ut_pex, lt_donthave, mw_chain1, mw_chain2 (TypeError); E_EXISTS if taken.
  // Called synchronously from 'wire' for peer wires of the listed kinds, after the 262,144-byte guard, before the extended
  // handshake; existing wires get one call with late: true. Swarm kinds: site, rendezvous, chat, group, file.
TorrentManager.budget -> { total, used, pending, free, priority, bySwarm: { [kind]: { wires, counted, floor, cap, allot } } }
TorrentManager.anchorWire(wire) -> boolean      // a wire that delivered a valid ledger block (verified pieces anchor by themselves)
TorrentManager.ignoreWire(wire, reason) -> boolean   // or set wire.__mwIgnored = true; the periodic check closes it
TorrentManager.noteProgress(kind)               // e.g. the ledger is in sync: no 'no-progress' due
event 'no-progress' { kind: 'site' | 'rendezvous' | 'file', wires, sinceMs }   // after 60 s, then 2x up to 15 min, while it lasts
exports SWARM_KINDS, throttleUtMetadata(wire, { perMinute, now, onDrop }), evictionOrder(entries, { keep, anchorSlots, random })
```

Other new exports:

- `src/common/pointer.js`: `ORG_MAX = 4`, `isOriginString(v)`, `isLoaderVersion(v)`, `nextKeyCommitment(ownerKey) -> Promise<43 chars>`;
  records gain `org: string[]`, `nx`, `ml`, `idp`; `verifyPointer(record, scope, { ..., previousRecord })`.
- `src/common/magnet.js`: `WEBSEED_MAX_WS = 4`, `WEBSEED_MAX_XS = 2`, `isPublicWebHost(hostname)`,
  `filterWebseeds({ ws, xs }, { origin, signed, base }) -> { ws, xs, dropped }` (applied by `xsUrls` and `webseedBases`).
- `src/loader/doh.js`: `MAX_TIMER_MS`, `AD_WORDING`, `clampTimerMs(ms, { min })`, `clampTtlSeconds(ttl, { min, max })`.
- `src/loader/policy.js`: `SWARM_PRIORITY`, `deviceClassOf(env)`, `wireBudgetFor(cls|env)`, `allocateWireBudget(total, demands)`,
  `budgetVictim(counts, total)`, `ledgerBudgetFor(cls|env)`, `storageLines({ deviceClass, total, siteBytes, ledgerBytes })`;
  `computePolicy()` adds `deviceClass`, `wireBudget`, `ledgerBudget`.
- `src/loader/harden.js`: `createDeviceKey`, `signPin`, `verifyPin`, `signRefusal`, `verifyRefusal`, `withdrawalState`,
  `isReadOnlyHubLedger`, `rotationDecision`, `compareVersions`, `loaderFloorOk`, `parseHostFingerprintLink`,
  `ownerFingerprint`, `fingerprintMatches`, `publicSuffixOf`, `pslHubCheck`, plus the clamps re-exported from doh.js.
- `src/loader/config.js` (additive keys): `pointer.maxTtlMs`, `wireBudget`, `wireLimits`, `storageBudget`, `webseedFilter`,
  `fileTorrent`, `harden`.

Chosen values (no measurement behind them; gate rows confirm or tune): wire budget 40 desktop and 8 phones (from R);
floors site 2, rendezvous 2, chat, group and file 1; swarm caps chat 4/6, group 3/4, file 4/6; idle close 120 s (from R);
no-progress 60 s doubling to 15 min; anchor share 50 percent of a swarm's hard cap; ledger lines 64 and 256 MiB (from R);
rotation delay for first-time visitors 24 h; withdrawal re-sign margin 7 days.

## Changes to existing tests I own

- `test/unit/common-pointer.test.mjs`: rotations signed with a scope (v2) in the two "vector: rotation" tests; the
  v1 assertions now expect refusal (`rotationInput` without scope throws, a v1 rot= gives owner-changed); the
  round-trip `deepEqual` includes `nx: 'none'`; imports `sign`, `b64url`, `utf8`.
- `test/unit/loader-common-doh.test.mjs`: two `deepEqual` results include `adWording: null`.
- `test/unit/loader-app-torrent.test.mjs`: the B6 cap test no longer expects "the newest zero-score wire goes first";
  it expects two of the five zero-score wires to go (random among equal scores).

## Requests to other lanes and the integrator

1. **LOCK.json** (integrator): append these lines to `test/vectors/LOCK.json` entries, in this order:

```
{"file":"pointer.json","id":"ptr-019-freeze-fields","sha256":"b86ecf3ea3a32e25c8825a7685a320b3f2c55229662cd887dd7dc6d1d2cb8e92"},
{"file":"pointer.json","id":"ptr-020-four-org-budget","sha256":"cee8dbdd70828f808a3e9c9db0ed79d2d4183eac963f2e2c465841d0cd131a91"},
{"file":"pointer.json","id":"ptr-021-nx-match","sha256":"5b02dd2072d3707ba87f3382215adfa65e6f8153c674ef838394fcb73d6f6a7b"},
{"file":"pointer.json","id":"ptr-022-nx-mismatch","sha256":"3c865576344b9753df7611f1ed368cfb162e7dc45d5b122d007a90858c116352"},
{"file":"pointer.json","id":"ptr-023-rot-v1-refused","sha256":"57c3b772271975c3d9c700c8ea345305857e984338cfe02230a39c31e27fb9e4"},
{"file":"pointer.json","id":"ptr-024-nx-changed","sha256":"c6fed07e6264614f6e546350d52831a2fe7a041e322ff8f48a6eceb1b957b891"},
{"file":"pointer.json","id":"ptr-025-five-org","sha256":"a2c4eb83d7ca914542eb018ece58e38cd052ea812d942e903e0233d058cd8001"},
{"file":"pointer.json","id":"ptr-026-org-not-origin","sha256":"3a0b068297793ad463e74513f06ada3575b26ada0a3238b5c48aefb441a9c1a2"}
```

2. **`test/unit/formats-vectors.test.mjs`** (integrator): its pointer loop checks `ptr-010-rotation`'s frozen verify
   expectation (ok, rotated), which the rot v1 removal ends. Proposed rule: skip `expect.verify` of any vector named in
   another vector's `supersedes` (ptr-023 supersedes ptr-010); parse, format, signing input, ledger id and size still hold
   for ptr-010. Until then that test fails on `ptr-010-rotation: verify.ok` and on the missing LOCK lines.
3. **`test/unit/dropin-stamp.test.mjs` line 118** (drop-in owner): `signRotation({ owner: b.pub, seq: 6 }, a.privateKey)`
   now throws (no scope). Use `signRotation({ owner: b.pub, seq: 6, scope: 'site.test' }, a.privateKey)`; the later test
   at line 173 already does.
4. **T1 tools** (`tools/publish.mjs`, `tools/withdraw.mjs`): carry the previous record's `nx=` into every record of the
   same owner, withdrawals included (`withdrawalRecord({ ..., nx })`), or loaders that pass `previousRecord` refuse it as
   `nx-changed`; add `--org`, `--nx`, `--ml`, `--idp`; sign withdrawals with `exp <= seq + 30 days`
   (`withdrawalState().tooLong`). Their own rotations already pass a scope, so they keep working.
5. **Lane sdk / I3 (app.js wiring)**: pass `previousRecord` (the last accepted record of the scope) to `verifyPointer`;
   store pins and refusals with `signPin` / `signRefusal` and drop ones that fail `verifyPin` / `verifyRefusal`; treat a
   withdrawal as binding only while `withdrawalState(r).binding`; `loaderFloorOk(record.ml)` before mounting;
   `rotationDecision` for the "owner changed N minutes ago" card; `isReadOnlyHubLedger` on hubs; `pslHubCheck` before
   persistent identity on subdomain hubs; `clampTimerMs` on every timer armed from a record (`exp`, TTL);
   `adWording` instead of the "(DNSSEC)" badge text (`strings.js` `pointerBadge`, lane U1); poll `cs=` on the
   TorrentManager 'no-progress' event with kind 'rendezvous'; pass `computePolicy()`'s `wireBudget` / `deviceClass` to
   the manager (it falls back to the policy class).
6. **H1a chain-net**: call `torrentManager.anchorWire(wire)` when a wire delivers a valid block, and
   `torrentManager.ignoreWire(wire)` (or set `wire.__mwIgnored = true`) when the gossip ignores that wire's peer; call
   `noteProgress('rendezvous')` when in sync.
7. **E2E (integrator, E-HD-1)**: the many-wire cap and the `ut_metadata` flood are covered in units here; the e2e rows
   remain. Watch: unsigned magnets whose `ws=` / `xs=` point at another loopback origin than the page (another port, a
   hub label) are now dropped by design (MF-76); the current e2e stacks publish signed records with same-origin `/ws/`.

## Not done

- No e2e spec (`test/e2e/harden-*.spec.mjs` belongs to E-HD-1 at the integrator).
- `docs/INTERFACES.md` and `docs/ARCHITECTURE.md` are not mine to edit; the signatures above are the text for them.
