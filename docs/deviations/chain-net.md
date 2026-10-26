# chain-net notes (src/chain/{gossip,wire-ext,stores,node,multi,recent}.js, tools/snapshot.mjs)

## v0.3: chain-net hardening, local admit rules, checkpoint storage, the hub follow lane (H1a + N1)

Status: built. Sources: V03-DESIGN-REVIEW ("R") 1.1 item 7, 1.5 N-3, 2.5.3, 2.16.4, 3.1, 3.2.2, 3.2.3, 3.3;
MF-24, MF-29, MF-64, MF-65, MF-73, MF-74 (gossip part), MF-75; U-HD-1, U-LG-3; ARCHITECTURE 6.6 to 6.8, 15.4,
15.8; INTERFACES gossip.js, node.js, wire-ext.js, stores.js and v0.3 multi.js, recent.js. The freeze lane's
block.js, state.js and dag.js are used as landed (not edited). No new package.

Files written: `src/chain/gossip.js`, `src/chain/node.js`, `src/chain/wire-ext.js`, `src/chain/stores.js`,
`src/chain/multi.js` (new), `src/chain/recent.js` (new), `tools/snapshot.mjs`, the new tests
`test/unit/harden-chain-{hello,admit,prune}.test.mjs`, `test/unit/hub-lane-{multi,recent}.test.mjs`, the owned
tests `chain-net-{node,protocol,scale,sync}.test.mjs` (changes listed below), `chain-net-helpers.mjs`
(helpers added) and `tools-snapshot.test.mjs` (tests appended), and this file.

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test --test-timeout=180000 test/unit/chain-net-*.test.mjs test/unit/harden-chain-*.test.mjs \
      test/unit/hub-lane-*.test.mjs test/unit/tools-snapshot.test.mjs
    node tools/lint-floor.mjs

113 tests in 13 files, 113 pass, about 8 s (chain-net 56, harden-chain-hello 12, -admit 10, -prune 6, hub-lane-multi
13, -recent 7, tools-snapshot 9); lint-floor clean over src/. Also run unchanged and passing: freeze-*,
chain-core-* (131), dropin-engine, dropin-engine-tabs, dropin-mw, formats-vectors, tools-ledger, tools-v03-pin,
tools-publish-v021. Failing outside this lane, untouched by it: sw-sdk (3, the SDK lane's identity namespace work
in progress) and v021-integration "all say 0.2.1" (the 0.3.0 version bump).

### 1. Works-today blockers in the transport (R 1.1 item 7, 2.16.4, MF-73, MF-74, MF-75, U-HD-1)

- **HELLO bounds (MF-73).** `decode` refuses a HELLO unless n and the new optional c (blocks a checkpoint pruned)
  are at most `MAX_LEDGER_BLOCKS` together and `-1 <= d < n + c` (`helloBoundsOk`). `MAX_LEDGER_BLOCKS` =
  floor(64 MiB / `MIN_BLOCK_BYTES`) = 358,870, with `MIN_BLOCK_BYTES` = 187, the smallest valid block (an empty
  policy root of a one-character site id, measured). A frame outside the bounds is malformed: a strike, no
  session. SYNC window indexes and INV k are bounded by `MAX_WINDOWS` (5,608) instead of 1e9, and a SYNC
  window's n by `MAX_LEDGER_BLOCKS`.
- **`_startSync` clamp.** The session lists windows up to the bound and at most `syncLookahead` (256, chosen)
  windows beyond our own depth; a deeper honest peer is reached over later sessions as we grow (tested with a
  lookahead of 4 and 1,500 blocks). Measured on this Mac (Node 24, median of 5): a HELLO with d =
  Number.MAX_SAFE_INTEGER returns in 0.01 ms and sends nothing (PEER A1 measured 34 s and 290 MB for d = 2e10 on
  v0.2.1); the largest legal HELLO costs 0.15 ms and 3 SYNC frames (22,530 bytes) from a node holding the genesis.
- **The 2^53-1 sweep.** Every numeric field of every mw_chain1 frame (HELLO v, n, d, c; SYNC k and n; INV k; the
  block fields e.v, e.seq, e.ts, e.bits inside BLOCKS) at 0, -1 and 2^53-1: never a throw, under 200 ms each,
  a strike exactly when the value is out of bounds (harden-chain-hello).
- **Caps by wire (MF-74 gossip part).** At most `maxPeersPerGroup` (4, chosen) gossip peers share one `group` (the
  remote's self-declared peer id): a further wire is refused (`attach` returns false) and its transport hook
  `ignored('group-cap')` fires. wire-ext keeps one gossip peer per wire and counts by wire (`wireCounts`). An
  ignored peer (more than 50 strikes) is handed back: `ignored('invalid')`; a peer that sends no HELLO within
  `helloWaitMs` (120 s) of attach is refused as `'silent'` and detached. wire-ext turns these into the loader's
  `ignoreWire(wire, reason)` when given, else `wire.__mwIgnored = true` (the loader's periodic check closes it). The
  first valid block from a wire calls `anchorWire(wire)` (else `wire.__mwAnchored = true`), and a HELLO with our
  root calls `noteProgress(kind)` (at most every 30 s).
- **2.16.4 extras.** Frames are charged (unsolicited types) or checked against the buckets (INV, BLOCKS) before
  they are parsed (PEER A8); wants created from one peer's ANN or INV are capped at 256, oldest out first (PEER
  A6); a session that brought no block ends after 3 s idle (8 s once it has added blocks), and a peer that has
  delivered valid blocks pre-empts a session with one that never did when all four slots are taken (PEER A7); the
  deferred pool, when full, evicts the oldest entry of the peer holding the most entries (PEER A8: a flood evicts
  itself; one honest peer bootstrapping alone keeps the whole pool).
- **Policy before signature (MF-75).** node.js now runs, before ECDSA: the structural checks (`quickShape`), h
  recomputed, the claimed PoW, the root rule, `admit` at the heads (writers, allow list, bans, the fee, owner-only
  ops), the reserved pool, the cap and the throttle. Only blocks that pass reach `validateBlock` (in the verifier
  pool). A block whose control op may open the policy (policy, allow, owner, unban, rotate, keyinfo) ends the
  batch's wave, so later blocks of the batch are judged under the state it makes (`_place` repeats every check
  after the signature). Tested with a counter on verify calls: 40 well-signed blocks by throwaway keys on an
  owner-only site cost no signature check.
- **Per-wire signature-check budget (MF-75).** Blocks off a wire (the gossip passes `{ wire: true }`) are checked
  within `verifyRate` (512 per second per peer, burst 2,048, chosen, not measured); blocks over it wait in that
  peer's queue (`verifyQueueMax` 1,024; beyond it `E_BUSY`, not a strike, not remembered), the gossip asks that
  peer for nothing more while the queue holds `verifyBusyAt` (256) or more, and `tick()` checks the queue as the
  budget refills and hands the result to the gossip (`gossip.ingested`). Direct `ingest()` calls by tools are not
  budgeted.
- **Arrival-time throttle (MF-75).** The per-author throttle (30 per 10 minutes) counts live blocks by their
  arrival time here; the claimed ts no longer exempts a block. Live = pushed, announced, the HELLO fast path, local
  writes; history (answers to a sync session, parents of held orphans, value restores, snapshots, direct ingest
  calls without `{ live: true }`) is not counted. The gossip tells the node which blocks are history
  (`ingest(blocks, peerId, { history, wire: true })`).

### 2. Local admit and node rules of the freeze group (R 2.5.3, MF-24, MF-29, U-LG-3)

- **Reserved pool.** Authors who are not vetted (the owner in effect, moderators, allow-listed keys and keys an
  allow-listed key rotated to) share at most `policy.reservedPool` percent (default 25) of maxChainBytes, counted
  in DAG bytes; a block that would pass it is refused with `E_CAP` (local writes before the fee is mined, from an
  estimate, then exactly), and vetted authors still write. Pool refusals are remembered (not fetched again) while
  the pool stays too full for that block; any control change judges them again. Ownerless ledgers have no vetted
  authors and no pool (the pool would only waste three quarters of them). `importSnapshot` applies the pool too.
- **E_LEDGER_FULL at 80 percent (MF-24).** A report, never a refusal: a local write that leaves the ledger, or for
  a writer who is not vetted its pool, at or above `fullRatio` (0.8) calls `opts.onWarning({ code: 'E_LEDGER_FULL',
  message, capacity })`; the write itself resolves to the stored block as before. Refusals stay E_CAP (pool, cap).
  `node.capacity()` -> `{ bytes, max, ratio, full, capReached, pool: { bytes, max, ratio, full }, code }` (code
  'E_LEDGER_FULL' when full or the pool is full). The brief's `pool` is this object.
- **Moderator tombstone grace (MF-29).** A value tombstoned by a moderator alone is hidden at once (state, gossip:
  plain WANT answers carry the stub with the tombstone through the new `hidden` hook, `exportBlocks`, recent
  windows) and deleted from memory and the store `graceMs` (24 h, chosen) after this node first saw it hidden, by
  local time (a moderator who backdates ts gets no shortcut). The start times are kept in the store's meta under
  `'grace'` and survive a reopen. A revocation within the grace (the owner's `voided`) shows the value again. No
  grace when: the target is on the P0 path (a `_deny/<id>` entry with reason 'P0' whose ref is the block hash, or
  whose id is `denyIdOf(v.ih)` or `denyIdOf(v.sha256)`, where `denyIdOf(x)` = b64url(sha256(utf8(x))), R 2.8.7);
  its author or the owner also tombstoned it; its author is banned. A `_deny/` entry arriving after the tombstone
  ends a running grace. Values in grace count in bytes and toward the cap until deleted; a value whose hiding a
  control change lifts, and which this copy no longer holds, is asked for again (`WANT { v: true }`).
- **Checkpoint storage.** `stores.applyCheckpoint({ h, snap, S }, covered)` keeps S in meta ('checkpoint') and
  deletes every covered row, stubs included, in one transaction (IndexedDB: one readwrite transaction over
  'blocks' and 'meta'); `getCheckpoint()`, `deleteMany(hashes)`. `node.applyCheckpoint(S)` prunes to the
  checkpoint in effect (`state.checkpoint`) whose snap S matches (dag.pruneTo), memory first, then the store
  (retried by `tick()` if the store refuses); a reopened node prunes to the stored S before it loads the rows;
  later blocks naming covered parents are accepted; covered hashes are never WANTed or stored again; HELLO carries
  c. A copy without the covered history passes the checkpoint block: `node.applyCheckpoint(S, { block })` takes it
  only when the block is valid, names S's snap, and is signed by the last owner key in S, which must be the
  pointer's owner (expectedOwner, else the genesis owner) with S's first key the genesis owner. Without that anchor
  rule anyone could sign a checkpoint and claim to be the successor. `node.checkpointBase()` serves S.

### 3. Browser genesis for the personal-site class (R 3.3 first row, MF-64, N-3)

`ChainNode.genesis({ signer, policy, keyinfo, chain, ledgerId, now })` -> `{ blocks, ledgerId, gen, chain }`.
signer = `{ pub, sign(bytes) -> Promise<Uint8Array(64) P1363 | b64url> }`, never a key; each signature is checked
against signer.pub. policy defaults to `PERSONAL_POLICY` (writers 'owner', bits 16, maxChainBytes 8 MiB) over
DEFAULT_POLICY (every v1 field written, as ledger-admin's genesis); `keyinfo: { rc }` adds the keyinfo block (prev
the genesis). ledgerId defaults to the chain= form of src/common/pointer.js `ledgerIdFor` with a fresh random
chain (16 bytes, b64url) unless given. The pointer itself is the caller's (owner=, chain=, gen=, nx=).

### 4. The hub follow lane (R 3.1, 3.2.2, 3.2.3; MF-65)

- **multi.js.** `EXT_NAME_2 = 'mw_chain2'`; `laneInfoHash(hubSuffix, shard)` = sha1(utf8("mw-hub-lane1|" +
  hubSuffix + "|" + shard)) (the suffix lowercased, trailing dot dropped); `shardOf(ledgerId, shards)` (a power of
  two; the first 4 bytes of sha256(utf8(ledgerId)) modulo shards). Frames: the six mw_chain1 frames with
  `ledger` on each and the same validators; `RECENT { ledger, fromDepth, posts?, rid }` and its answer `RECENT {
  ledger, rid, b, more, cp? }` (cp = `{ h, snap, parts, bytes }` on the first page); `HAVE { ledgers <= 256,
  more?, full? }`; `SNAP { ledger, rid, snap, part, parts <= 512, data <= 12,000 characters }` for S (each part
  sized so its frame fits 15 KiB after JSON escaping). Budgets per wire as mw_chain1 (64 KiB/s unsolicited, 1 MiB/s
  solicited, checked before parsing, answers paced at 768 KiB/s, 50 strikes); RECENT answered at most 2 per second
  per wire, bursts of 8, 8 more queued (chosen), a window computed at most once per 2 s per ledger; lane BLOCKS
  for a followed ledger are taken only when asked for.
- **Modes.** `follow(ledgerId)` keeps a recent window in the view of that ledger's ChainNode; the scheduler pulls
  RECENT from a peer that HAVEs it (a peer that delivered before first), at most `maxActive` (4) ledgers at a time,
  retries another peer after 15 s, refreshes every 5 minutes; ANN of a new head brings it into the view (WANT,
  BLOCKS). `hold(ledgerId)` (the member's own ledger, a ledger opened in full) keeps mw_chain1 for it through one
  virtual peer per wire on the node's Gossip (at most 8 per wire, closed after 60 s idle), started when both sides
  list it in a HAVE with `full: true`, and announces new heads on the lane. Desktops relay their windows to other
  followers (values the view's state hides travel as stubs); phones serve only what they hold in full.
- **Caps.** `follow` beyond 250 on phones or 1,000 on desktops (chosen) throws E_LIMIT, reason 'follow-cap', message
  "You follow 250 of 250 on this phone." ("on this computer" on desktops). Phones pull, then disconnect: once
  nothing is due or syncing the lane keeps 2 wires (the rest get `ignored('phone-idle')`), none while hidden
  (`setHidden(true)`: `ignored('hidden')`), and new wires beyond `wantedWires` are refused (`'lane-wires'`,
  `'hidden'`). `wantedWires`: 0 hidden; phones 2 when current, 8 while syncing; desktops 40.
- **recent.js.** `recentWindow(node, { posts = 200, fromDepth = -1 })` and `windowFromDag(...)`: the depth suffix
  holding the newest `posts` payload blocks (every block at depth >= F), every control block below it, newest
  first, at most 4,096 blocks (`truncated`), the checkpoint S when the node pruned to one; hidden values as stubs.
  `RecentView` (one per node, `viewOf(node)`) checks each block in full and computes the display state: exact
  (`reduce` of an ordinary Dag) when nothing is missing; with gaps, the missing parents count as settled history on
  top of S or the genesis policy (`reduceFromCheckpoint` with a synthetic base). `orderChecked(h)` is false for a
  block with a parent this copy neither holds nor has covered ("Order not yet checked": the window's lower edge and
  the control blocks below it); `state().controlExact` is false when more than one order-sensitive control block
  (policy, allow, owner, rotate, keyinfo, unban, checkpoint) has a missing parent, or the answer was truncated.
  `syncRecent(node, peer, { posts = 200, fromDepth })` with `peer.recent()` (MultiGossip `peerFor(id)`,
  `localPeer(node)`); the blocks that connect to what the node holds are also given to the node (as history).
  Snapshot first: `encodeRecentSnapshot`, `parseRecentSnapshot`, `loadRecentSnapshot(node, array)`.
- **Display equals the full ledger (tested).** For a personal ledger of 300 posts with a keyinfo, a profile, a kv
  entry, a policy change and two tombstones, a follower's display shows the full ledger's policy, owner, key
  changes, keyinfo and exactly the full ledger's items for every post the window holds; with a checkpoint the
  whole state is equal (S stands for the covered history); with two policy changes below the window
  `controlExact` is false until the history arrives.

### 5. tools/snapshot.mjs

`--recent-out <file>` (with or without `--out`) and `--posts <n>` (1 to 200, default 200) write the recent window
as `[header, ...blocks]` (gzip by default, `--plain`); `buildRecentSnapshot({ blocks, posts, genesisOwner, gen,
maxBytes })`. Redacted values travel as stubs; with a checkpoint in effect, S is computed over the causal past of
the checkpoint's heads (on the whole DAG the checkpoint already covers them) and stands for the covered blocks.
The loader's snapshot reader accepts the file (it reads arrays; `importSnapshot` skips the header).

## Contract changes, and the existing tests I changed for them

1. HELLO `d < n + c`, the n and c bound, the window index and SYNC n bounds (MF-73). chain-net-protocol "SYNC lists
   every window": its HELLO said n: 400 with d: 19,250 (not honest under the rule); it now says n = d + 1.
2. Frames over the budget are dropped before parsing, as a whole (PEER A8): `stats.dropped` counts such frames once.
   chain-net-protocol "budgets": `dropped >= ceil(missing / 3)` (three blocks per frame) instead of `>= missing`.
3. The throttle counts live blocks by arrival (MF-75). chain-net-node "ingress throttle" now passes `{ live: true }`
   and checks that a backdated live block is counted while history is not; chain-net-protocol "budgets" uses four
   authors so the 40 pushed and announced blocks stay about the byte budgets.
4. The reserved pool (U-LG-3). chain-net-protocol "bootstrap 8 MiB" allow-lists its six writers (8 MiB of unvetted
   blocks would stop at 2 MiB); chain-net-scale "a flood of 10 000" asserts the pool bound instead of the cap
   (`capReached` stays false: the cap is left to vetted authors); chain-net-scale "two nodes at a 64 KiB cap" sets
   reservedPool 50 and asserts that both pools are full; chain-net-node "cap" fills the ledger with an allow-listed
   writer (a stranger's local write now stops at the pool first).
5. The moderator tombstone grace (MF-29). chain-net-sync "a tombstoned (v-less) block reaches a newcomer": the source
   keeps the value for 24 h but sends only the stub with its tombstone, then deletes it; chain-net-node "cap" (moderation
   frees space after the grace; an owner tombstone at once) and "export/import" (the virtual clock passes the grace
   before the export is compared).
6. New and changed exports (all additive except where noted): gossip.js `MIN_BLOCK_BYTES`, `MAX_LEDGER_BLOCKS`,
   `MAX_WINDOWS`, `MAX_SITE_LENGTH`, `helloBoundsOk`, `validFrame`, `Bucket`; limits `maxWantsPerSource`,
   `syncNoBlockMs`, `syncLookahead`, `maxPeersPerGroup`, `helloWaitMs`, `syncedNoticeMs`; Gossip options `hidden`,
   `busy`; attach peers may carry `ignored(reason)`, `delivered()`, `synced()`; `attach` returns false when refused;
   methods `strike`, `ingested`; getter `lastProgressAt`; `peerInfo` adds group, delivered, origins, lastFrameAt;
   `ingest` gets a third argument. node.js `quickShape`, `denyIdOf`, `PERSONAL_POLICY`, `ChainNode.genesis`,
   `capacity()`, `applyCheckpoint`, `checkpointBase`, `graceList`; `ingest(blocks, peerId, { history, live, wire })`
   (result adds `queued`, reasons add `E_BUSY`); writes take `onWarning`; `attachTorrent(torrent, { anchorWire,
   ignoreWire, noteProgress, kind })`; config `verifyRate`, `verifyBurst`, `verifyQueueMax`, `verifyBusyAt`,
   `fullRatio`, `graceMs` (`deferPerPeer` was tried and dropped for the largest-holder eviction); `tick()` returns a
   promise of the work it started (a virtual-clock harness awaits it; the timer callback returns it); a refused block
   whose policy fails is now reported with the policy code even when its signature is also bad (by design: no
   signature check is spent on it). stores.js `applyCheckpoint`, `getCheckpoint`, `deleteMany`. wire-ext.js
   `wireCounts`, `handlerFor(wire, name)`, `makeWireExtension(gossip, { name, hooks })`, `attachToTorrent(...,
   { ignoreWire, anchorWire, noteProgress, kind })`; a wire carries one handler per extension name (mw_chain1 and
   mw_chain2 on one wire no longer overwrite each other).
7. A fix found on the way: node.js handed `admit()` a reduced control view (owner, policy, tombstones, succession)
   without keyinfo, rotations, modTombstoned, ownerWritten or effective, so a recover rotation was refused at the
   heads and a second keyinfo was stored. The control view is now the whole reduced state (harden-chain-admit
   "admit at the heads sees the whole state"; it fails with the old view).

## Proposed spec text (I do not own docs/INTERFACES.md or docs/ARCHITECTURE.md; integrator or docs owner to paste)

INTERFACES, replacing the v0.3 (proposed) "src/chain/multi.js, recent.js" subsection, marked v0.3:

```
### src/chain/multi.js, recent.js (mw_chain2, hub lane)  [v0.3]
multi.js
  EXT_NAME_2 = 'mw_chain2'; LANE_MSG = { HELLO 1 .. INV 6, RECENT 7, HAVE 8, SNAP 9 }; FOLLOW_CAPS = { phone: 250, desktop: 1000 }
  laneInfoHash(hubSuffix, shard = 0) -> Promise<40 hex>      // sha1(utf8("mw-hub-lane1|" + hubSuffix + "|" + shard))
  shardOf(ledgerId, shards = 1) -> 0 .. shards - 1            // shards a power of two
  encodeLane(type, obj) -> Uint8Array    decodeLane(u8) -> { type, obj } | null
    // frames 1-6: mw_chain1 + ledger; RECENT { ledger, fromDepth: -1 .. MAX_LEDGER_BLOCKS - 1, posts?: 1..200, rid }
    // answer RECENT { ledger, rid, b, more, cp?: { h, snap, parts <= 512, bytes } }; HAVE { ledgers <= 256, more?, full? }
    // SNAP { ledger, rid, snap, part < parts, parts <= 512, data <= 12000 chars }
  class MultiGossip {
    constructor({ hubSuffix, shard = 0, ledgers: Map<ledgerId, ChainNode>, limits, deviceClass = 'desktop',
                  now, setTimeoutFn, clearTimeoutFn, onChange, onView(ledgerId, view) })
    follow(ledgerId) -> true      // E_LIMIT { reason: 'follow-cap', cap, count } beyond the class cap; TypeError without a node
    unfollow(ledgerId) -> boolean   hold(ledgerId) -> true (full mw_chain1 via virtual peers)   release(ledgerId)
    attach({ id, send, close?, group?, ignored?(reason) }) -> boolean   detach(id)   handle(id, u8) -> Promise   tick()
    setHidden(bool)   wantedWires   followed   holdings()   view(ledgerId)   peerFor(id) -> { id, recent(req) }
    infoHash() -> Promise   peerInfo(id)   stats   destroy()
  }
recent.js
  RECENT_POSTS = 200; MAX_WINDOW_BLOCKS = 4096
  recentWindow(node, { posts = 200, fromDepth = -1 }) -> { blocks (newest first), fromDepth, posts, truncated, checkpoint }
  windowFromDag(dag, { posts, fromDepth, hidden, checkpoint, maxBlocks })
  class RecentView { constructor({ siteId, genesisOwner, expectedOwner, minBits, verifierPool, maxBlocks })
    add(blocks, { checkpoint, truncated }) -> Promise<{ added, rejected, duplicates }>   state() -> { state, snapshot,
    unchecked, missing, controlExact, complete, checkpoint }   orderChecked(h)   has(h)   get(h)   blocks()   size   checkpoint }
  viewOf(node) -> RecentView   applyWindow(node, window, { from })
  syncRecent(node, peer, { posts = 200, fromDepth = -1 }) -> Promise<{ added, rejected, view, state }>   localPeer(node, id)
  encodeRecentSnapshot(window, ledger) -> [header, ...blocks]   parseRecentSnapshot(array)   loadRecentSnapshot(node, array)
```

INTERFACES, additions to the gossip.js, wire-ext.js, stores.js and node.js sections (as in "Contract changes" 6 above),
marked v0.3: HELLO `{ v, site, owner, n, d, root, heads, c? }` with `n + c <= MAX_LEDGER_BLOCKS` and `-1 <= d < n + c`;
`Gossip.attach` returns false when refused; `ingest(blocks, peerId, { history, wire })`; `ChainNode.genesis`,
`capacity()`, `applyCheckpoint(S, { block })`, `checkpointBase()`, `graceList()`; `stores.applyCheckpoint(meta, covered)`,
`getCheckpoint()`, `deleteMany()`; `wireCounts(gossip)`, `handlerFor(wire, name)`.

ARCHITECTURE 6.3: "Ingest order (v0.3, MF-75): shape and limits, h, the claimed PoW, the root rule, the control-state
check, the reserved pool, the cap and the throttle, and only then the signature and the value hash, within the
peer's signature-check budget; the throttle counts live blocks by arrival time." 6.6: the HELLO bounds and c, the
group cap, the transport hooks, the 3 s idle end, pre-emption, the 256 wants per source, the lookahead clamp. 6.7: the
checkpoint row and meta. 15.4: "Admit and node rules (v0.3, chain-net): the reserved pool is counted in DAG bytes of
authors who are not vetted (a key rotated from an allow-listed one is vetted), ownerless ledgers have none;
E_LEDGER_FULL is a report at 80 percent, refusals stay E_CAP; the grace is 24 h by local time with the P0, author,
owner and ban exceptions." 15.8: mark "v0.3" and add the frame list above, HAVE full, SNAP, the request rate, and
"display flags blocks whose own parents are missing; controlExact".

## Requests to other lanes and the integrator

1. **Loader (H1b torrent.js, I3 app.js):** pass the TorrentManager hooks when attaching the ledger:
   `node.attachTorrent(torrent, { anchorWire: (w) => tm.anchorWire(w), ignoreWire: (w, r) => tm.ignoreWire(w, r),
   noteProgress: (k) => tm.noteProgress(k), kind: 'rendezvous' })` (kind 'site' for the content torrent). Without
   them the wire is flagged `__mwIgnored` (already honoured) and `__mwAnchored` (H1b: please honour it in
   `_housekeep` as `anchorWire` does, or ignore it).
2. **Lane sdk (A1) and the hub (X1):** hub mode creates one ChainNode per followed ledger (a MemoryBlockStore is
   enough: the window lives in the view) plus the member's own, a `MultiGossip({ hubSuffix, shard: shardOf(own,
   shards), ledgers, deviceClass })`, joins the lane torrent `await multi.infoHash()` with its own tracker, attaches
   `attachToTorrent(laneTorrent, multi, { name: EXT_NAME_2, ignoreWire, anchorWire })`, calls `multi.tick()` every
   second, `multi.setHidden(document.hidden)` on visibilitychange, keeps lane wires at `multi.wantedWires`, and
   `multi.hold(ownLedger)`. The timeline reads `viewOf(node).state()` (`orderChecked(h)` for the "Order not yet
   checked" label, `controlExact`). The first screen: `loadRecentSnapshot(node, await readSnapshot(...))` on the
   hub's recent-window cs= file. `harden-loader`'s `joinLane` knows kinds chat and group only: a 'hub' kind (or the
   site kind) is needed for the lane torrent; `registerWireExtension` reserves mw_chain2, which is right (the chain
   attaches through attachToTorrent).
3. **Lane sdk (A1):** map `onWarning({ code: 'E_LEDGER_FULL' })` (or `node.capacity().code`) to the write result
   (for example `{ h, warning: 'E_LEDGER_FULL' }`) and to the owner's "raise the cap or checkpoint" prompt; the
   existing string ("This site cannot take more entries right now.") reads as a refusal, so E_CAP may use it and
   E_LEDGER_FULL a "nearly full" string (lane U1). "Create my page": `ChainNode.genesis({ signer, keyinfo: { rc } })`
   with the IdO card as signer, then the pointer with owner=, chain=, gen=, nx=.
4. **T1 tools (pin.mjs, ledger-admin):** a pin node can serve S with `node.checkpointBase()` and prune with
   `node.applyCheckpoint(S)`; `tools/snapshot.mjs --recent-out` writes the hub's recent-window cs= file.
5. **Integrator (Q1):** E-HD-1 (the HELLO and many-wire parts in a real browser), E-SO-5 (three contexts, 20
   synthetic personal ledgers, RECENT sync, the follow cap) and E-SO-6 (the first screen from loopback recent
   cs= snapshots) remain e2e work; the units here cover the logic.

## Chosen values (no measurement behind them; gate rows confirm or tune)

verifyRate 512/s per peer (burst 2,048, queue 1,024, busy at 256); maxPeersPerGroup 4; helloWaitMs 120 s;
syncNoBlockMs 3 s; syncLookahead 256 windows; maxWantsPerSource 256 (from R); graceMs 24 h (from R); fullRatio
0.8 (from R); reservedPool default 25 (from R); maxActive 4, posts 200, follow caps 250 and 1,000, phone idle
wires 2 (from R); RECENT 2/s per wire (burst 8, queue 8), window cache 2 s, request timeout 15 s, refresh 5 min,
8 virtual peers per wire, virtual idle 60 s, 16 held ledgers, MAX_WINDOW_BLOCKS 4,096, SNAP parts of 12,000
characters, at most 512.

Measured (Node 24, this Mac, a single run unless stated): the smallest valid block is 187 bytes; a hostile HELLO
with d = 2^53-1 returns in 0.01 ms (median of 5) with no frame sent; the largest legal HELLO costs 0.15 ms
(median of 5) and 3 SYNC frames of 22,530 bytes in total; the 8 MiB bootstrap from one peer completes in about 10.5 s
of simulated time (the protocol test's limit is 30 s).

---

## v0.2 notes (2026-10-19)

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
