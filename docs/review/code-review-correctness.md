# Code review: correctness and distributed-systems lens (v0.2.1 code)

Date: 2026-10-19 (16:30 to 17:50 ET). Lens: CORRECTNESS & DISTRIBUTED SYSTEMS. Code reviewed: the working tree at
checkpoint `29733c0` (no file under `src/`, `tools/`, `test/`, `build.mjs` changed after the v0.2.1 verifier's
14:40 ET notes). Read first: `docs/INTEGRATION-STATUS.md`, `docs/DEVIATIONS.md` with
`docs/deviations/{formats,network,serving-publishing,harden-verify}.md`, `docs/review/DESIGN-REVIEW.md`,
`docs/review/DIGEST-AMENDMENTS.md` (Status column). The security and conformance reviews of the same code were read
so that nothing they report is reported again here (list at the end). This review changed nothing in the repository
except this file.

Severity: critical = exploitable or data loss; high = a documented behaviour is wrong in a mainstream browser or a
must-fix item is unimplemented; medium = edge-case bug; low = hygiene.

What was run (Node 24.22, everything on 127.0.0.1, browsers local-only through `chromiumArgs()`):
- `npm test` in the repository: 836 pass, 0 fail.
- Two Chromium experiments in an isolated clone of the tree (the e2e stack rebuilds `dist/`): one visitor, two tabs,
  a `seq + 1` publish (findings 1a to 1c). Built on `test/e2e/lib.mjs` (`setupStack`, `Visitor`, `acceptConsent`,
  `waitForSite`); network policy: no violation.
- Node probes against the real modules: the chain-net simulator (`test/unit/chain-net-helpers.mjs`, virtual clock) for
  findings 2 and 3, a concurrent `ensureIdentity` run for finding 4, `TorrentManager` with fake timers and fetch for
  finding 5, real webtorrent 3.0.21 against a 127.0.0.1 file server for finding 6, a `dist/` walk against concurrent
  `node build.mjs` for finding 7. The probe scripts are not in the repository (reviewer scratch copy).

## Summary

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | high | Shell, two tabs across a publish: the tab on the new version shows "Connecting..." until the engine tab closes, and the superseded version keeps being announced | `src/loader/app.js:1928`, `:2014`, `:2051`, `:1459-1476`, `:1776-1786` |
| 2 | high | At `maxChainBytes`, peers re-fetch each other's surplus forever (E_CAP is never remembered); the solicited allowance, reset only on equal roots, drains and then every answer from that peer is dropped, owner and moderator blocks included | `src/chain/node.js:868`, `src/chain/gossip.js:587-594`, `:771-772`, `:796-797`, `:932` |
| 3 | medium | A local write whose IndexedDB write fails rejects, but the block stays in the DAG and state and is relayed; the retry builds on it; after a reload both entries are gone | `src/chain/node.js:806-811`, `:882`, `:622` |
| 4 | medium | Shell identity creation is check-then-act across tabs: on a first visit with two tabs the engine tab can sign with a key that IndexedDB no longer holds | `src/loader/app.js:487-501`, `:468-484`, `:1870-1871` |
| 5 | medium | Cold start: xs fetches and web-seed probes (10 s each, sequential) run before any tracker or peer; with unresponsive web seeds peers wait 10 s per `ws=` entry | `src/loader/torrent.js:1381-1397`, `:1159-1173`, `:1411` |
| 6 | low | Torrents with BEP 47 pad files never complete from a web seed: the pad file is requested from the host (404) | `node_modules/webtorrent/lib/webconn.js:100` (vendored bundle), `src/sw/core.js:1575` |
| 7 | low | Test-harness flakiness: the e2e stack rebuilds the shared `dist/` non-atomically while a unit test walks it; wall-clock targets are asserted as failures | `test/e2e/lib.mjs:195-197`, `build.mjs:535`, `test/unit/loader-app-arrival.test.mjs:82`, `test/e2e/run.mjs:263`, `:361` |

## 1. high: shell mode, two tabs across a publish (deadlock and stale seeding)

**Where.**
- `src/loader/app.js:1459-1476` (`obtainSite`): a follower tab whose copy is not cached waits for a `site` broadcast
  for *its* btih or for the Web Lock. Nothing asks the engine tab to fetch that btih, and there is no timeout.
- `src/loader/app.js:512-538` (`electLeader`): the engine tab holds the lock until it unloads (`release()` is never
  called), and queued requests are granted first come, first served.
- `src/loader/app.js:1928-1931`: a `version` message from another tab only sets the "Update available" banner.
- `src/loader/app.js:2014`, `:2051` (`checkPageTagUpdate`, `checkForUpdate`): `if (A.tm) A.tm.stopSite()`; follower
  tabs have no TorrentManager, so when a follower finds the update nothing stops seeding.
- `src/loader/app.js:1776-1786` (`promoteToLeader`) and `:1762` (`startEngine`): a promoted follower seeds its own
  cached version with `seedFromCache`, whether or not it already knows that version is superseded.

**Defect.** ARCHITECTURE 5.8 says that when a newer valid record is found, seeding of the old btih stops at once.
5.9 says one engine per origin. In shell mode the two rules interact badly:
(a) a tab that resolves the new version while another tab of the origin runs the engine on the old one never
renders; (b) when a follower finds the update, the engine tab keeps announcing the old btih; (c) when the engine
tab finds the update and reloads, the lock passes to the oldest follower, which is still on the old version and
starts seeding it again. The same wait as (a) happens on a single version when the engine tab's download fails:
the follower is never told.

**Failure scenario (reproduced in Chromium 156, local stack, one visitor context).**
1. Tab P1 renders v1 and runs the engine. Tab P2 renders v1 as a follower.
2. Publish `seq + 1` (v2) into the same web seed and switch the page tag, as e2e scenario 13 does.
3. P2 reloads. The cached shell renders v1 and `checkPageTagUpdate` finds v2: P2 shows the banner and sends
   `version`, and P1 shows the banner. In the next 20 s, P1 still sent an `update` announce for v1, which the
   tracker received (finding 1b).
4. P2 reloads again. It resolves v2, becomes a follower (P1 holds the lock) and shows "Connecting..." with nothing
   mounted for the full 45 s observed (`mounted: false`, log ends at "follower tab"). When P1 is closed, P2 renders
   v2 in 105 ms (finding 1a).
5. Variant: P1 (the engine tab) finds the update itself and reloads. P2 is promoted ("this tab now runs the engine",
   "status seeding") and announced v1 `started` and then `update` every ~24 s: 3 announces in 70 s, all received by
   the tracker after the update was found (finding 1c).

E2E scenario 13 uses one tab only, so it passes.

**Fix.**
- Treat `version` as authoritative in every tab. On receipt (and in a follower's own update check), mark the tab's
  btih superseded. The engine tab calls `tm.stopSite()`, and `promoteToLeader` / `startEngine` never
  `seedFromCache` a superseded btih.
- Let the engine move to the newest version instead of blocking it. When the engine tab learns that a newer version
  exists (its own check, a `version` message, or a follower's `need-state` carrying a newer btih), it stops its site
  and releases the lock (wire `electLeader`'s `release()`), then follows: it keeps its frame, as drop-in followers do.
  A tab on the newer version then leads and downloads it. As a fallback, a follower that sees no `site` for its btih
  within a bounded time downloads it itself.
- `recordVersion` (`src/loader/app.js:1415-1427`) must then keep the previous version while a client maps to it
  (5.8: "deleteSite(old) when no client maps to it ... keep at most the current version and the previous one"), as
  drop-in's `planVersions` does with `mw-get-clients`. Today it deletes every other version at once, which is safe
  only because a newer-version tab can never lead while an older one is open.

**Test.** E2E "two tabs across a publish": one visitor, P1 and P2 on v1; publish `seq + 1`.
(a) Reload P2 twice: P2 renders v2 within 30 s while P1 stays open.
(b) After the update is found by either tab, no announce of v1 from the visitor or at the tracker (after a 1 s grace).
(c) Run the variant where P1 finds the update and reloads: the promoted P2 does not announce v1.
Unit (loader-app, fake TabLink and TorrentManager): a follower that received `version` and is then promoted does
not call `seedFromCache` for the old btih.

## 2. high: at the cap, peers re-fetch each other's surplus and then stop relaying owner blocks

**Where.**
- `src/chain/node.js:868`: `E_CAP` refusals are never remembered (by design: "rate and cap never are").
- `src/chain/gossip.js:932` (`_onInv`): every listed hash that is neither held nor in `skip` is wanted again.
- `src/chain/gossip.js:587-594` (`_charge`): solicited frames count toward `p.solTotal`, capped at
  `2 x maxChainBytes + 1 MiB` (`:583`).
- `src/chain/gossip.js:771-772` and `:796-797`: `solTotal` is reset only when the peer's root equals ours.
- `src/chain/gossip.js:799-801`: any change of the peer's root also resets the sync back-off to 2 s.

**Defect.** Past `maxChainBytes` each node stops ingesting non-privileged blocks, and which blocks got in depends on
arrival order. After a flood (the abuse case of DESIGN-REVIEW item 4), two peers therefore hold different subsets
that neither will ever accept from the other. Their roots never match again. Every sync session lists the other
side's surplus in INV; the requester WANTs all of it (E_CAP is not remembered), receives it, refuses it, and the
session backs off at most 60 s, or 2 s whenever the peer's root moves.

The bytes count toward the solicited allowance, which is reset only when the roots match, so it is never reset.
Once it is spent, `_charge` drops every solicited frame from that peer: the answers to WANTs for new owner,
moderator and allow-listed blocks too, although item 4 says they are still accepted after the cap. On every
long-lived wire, moderation stops propagating right after a flood, which is when it is needed. Until then each peer
pair re-downloads the surplus every cycle; for an 8 MiB ledger that can be MiBs a minute, on phones too.

**Failure scenario (reproduced with the chain-net simulator; ledger cap scaled to 64 KiB, so the solicited
allowance is 1.125 MiB).** Owner genesis `writers:'open'`, `maxChainBytes: 65536`; six writers append 40 posts each.
A is filled to its cap with branches in one order and B in the reverse order (110 blocks each, different sets).
After linking them:
- 15 simulated minutes: B has received 603 KB of solicited frames from A and refused 750 blocks (E_CAP).
- 30 minutes: 1,024 KB and 1,290 refusals.
- 45 minutes: the allowance is spent (1,178,994 bytes) and B starts dropping frames from A.

The owner then writes an entry on A (exempt from the cap). After 2 more minutes B still does not have it: 936
frames from A dropped, and the roots never matched. A second run with a ledger that has one persistently refused
block (a post concurrent with a `writers:'owner'` tightening) shows the same drain at about 200 bytes a minute,
which only matters with a reduced cap.

**Fix.** Any of the following, preferably the first two together:
- Remember E_CAP refusals by hash while the node is at its cap: clear them when the control state changes (a new
  `maxChainBytes`, allow or moderator list) or when the node is below the cap. A cap refusal is stable while the cap
  holds, unlike rate and budget refusals.
- Do not let refused bytes consume the allowance. Charge `solTotal` only for blocks that were added (or reset it at
  the start of every sync session), and exempt frames whose blocks are by the owner, a moderator or an allow-listed
  author: the author is known after decoding, before `_charge` is called per item in `_onBlocks`.
- Keep the back-off for sessions that added nothing even when the peer's root moved, unless its new heads are
  unknown to us.

**Test.** `chain-net-scale`: two nodes at a 64 KiB cap holding different subsets (as above). After 90 simulated
minutes, B's solicited bytes from A stay below 2 x the surplus size, and an owner block written on A reaches B within
10 s.

## 3. medium: a local write whose IndexedDB write fails is published anyway

**Where.** `src/chain/node.js:882` (`_place` inserts into the DAG first), `:806-811` (`_persist` runs after the
insert; in local mode a failure is rethrown, but nothing takes the block back out), `:622` (`_noteInserted` makes
the unpersisted block `_ownLast`, the first parent of the next write). HELLO heads and root, INV pages and WANT
answers all read the DAG (`src/chain/gossip.js:654-663`, `:838`), so the block is relayed even though `announce` is
skipped.

**Defect.** ARCHITECTURE 6.7 and DESIGN-REVIEW item 19 promise write-through: a block is in IndexedDB before `put()`
resolves and before it is relayed. When the transaction fails (QuotaExceededError, a connection closed by
`versionchange`, Safari's UnknownError), `put()` rejects, so the site tells the visitor the post failed. But the
entry is in this tab's state, peers fetch it on the next HELLO, and the visitor's retry builds on it. After a reload
the store has neither the failed entry nor, in practice, the retry: the retry waits as an orphan for the parent
that was never stored.

**Failure scenario (reproduced).** Store whose next `putMany` throws QuotaExceededError; `A.put('guestbook',
'first post')`:
- `put()` rejects with the quota error, yet `A.snapshot().kv` shows the entry.
- After linking A to B, B shows the entry too.
- The retry `A.put('guestbook2', 'retry')` has the unpersisted block in its `prev`.
- After reopening A from the same store with no peer: height 1, 1 orphan, `kv` empty.

**Fix.** For local writes, write the block to the store before `dag.add`: run `admit` and the throttle, then
`putMany([block])`, then place it. Or keep failed rows in a retry set, keep them out of HELLO, INV and WANT answers
until they are stored, and remove them from memory on a final failure. Remote blocks whose write failed should be
retried, or the meta should not claim them, rather than silently held in memory only.

**Test.** `chain-net-stores` or `chain-net-node`: with a store that fails the next `putMany`, a rejected `put()`
leaves `dag.size`, `snapshot()` and a linked peer unchanged; the next `put()` does not reference the failed block;
after a reopen no orphan is left.

## 4. medium: shell identity creation races between the engine tab and a follower tab

**Where.** `src/loader/app.js:487-501` (`ensureIdentity`: `getKey`, then generate and `saveKey`), `:468-484`
(`storeKey`: the round trip re-reads the key and falls back to the JWK form when it does not verify), `:1870-1871`
(`followLedger` calls `loadIdentity`, so follower tabs create identities too). Drop-in avoids this on purpose
(`src/dropin/ledger.js:127`: "A follower never creates an identity: two tabs creating one at once would overwrite
each other").

**Defect.** On a first visit with two tabs loading together (session restore, two links opened at once), the engine
tab (`openLedger`) and the follower (`followLedger`) both find no key and both generate one. The writes interleave:
the last `saveKey` wins, and a round-trip read can return the other tab's key, which fails the self-test and
triggers the JWK fallback.

The engine tab can end up signing this session's posts with key A while IndexedDB keeps key B. After a reload the
visitor is someone else: they can no longer tombstone their own posts (`state.js` requires the target's author), and
their profile name is gone. Settings > Export during that session exports B, not the key that signed. The stored
form can also become the `jwk` fallback on browsers where the CryptoKey path works.

**Failure scenario (reproduced at the logic level).** Two concurrent `ensureIdentity` calls against one async key
store (2 to 3 ms per IndexedDB operation, real WebCrypto). In 1 of 3 runs the engine tab's key differs from the
stored one (`engine identity === stored identity: false`). In all 3 runs the two tabs hold different keys, and the
stored record took the `jwk` path.

**Fix.** As in drop-in, a follower only reads the identity; the leader creates it, under the Web Lock it already
holds. Additionally make creation atomic: write with IndexedDB `add()` in its own readwrite transaction, and on
ConstraintError read and use the stored key; never treat another tab's key as a failed self-test.

**Test.** Unit (loader-app): two concurrent `ensureIdentity` calls on an interleaving fake cache return the same
`pub` and the stored record equals it. `followLedger` never calls `saveKey`.

## 5. medium: cold start waits for web-seed probes before any tracker or peer

**Where.** `src/loader/torrent.js:1381-1397` (`download`: each `xs=` URL is fetched in turn with a 10 s timeout,
then `await this._probeAll(record, parsed)`), `:1159-1173` (`_probeAll` probes the web seeds one after the other, up
to `timeouts.xsMs` = 10 s each), `:1411` (`_startDownload`, which creates the client and adds the torrent, runs only
after that).

**Defect.** ARCHITECTURE 5.4: "Trackers and web seed start together; peers only after consent". When a web seed does
not answer (a black-holed CDN, a captive or filtering network), the visitor gets no tracker socket and no peer for
10 s per `ws=` entry, even when peers are online. That is the case peer-to-peer delivery is meant to cover. The same
holds for slow `xs=` URLs. The magnet path already does this right: `_afterMagnetMetadata` probes after the torrent
is added and calls `addWebSeed` for each seed that passes.

**Failure scenario (reproduced with fake timers).** Pointer with one `xs` (answers at once) and two `ws` that never
answer. No WebTorrent client exists at 1, 5, 9, 10, 19 or 20 s; the client and the torrent appear at 21 s, after
both probe timeouts.

**Fix.** After the metadata step, call `_startDownload()` with `urlList: []` at once. Run the probes in parallel
(`Promise.all`, each with its own timeout) and `torrent.addWebSeed(url)` for each one that passes, cheapest first.
Fetch the `xs=` URLs in parallel and take the first that matches the btih.

**Test.** `loader-app-torrent`: with a hanging web-seed fetch, `client.add` happens before 1 s on the fake clock;
the web seed is added when its probe answers 206, and never when it answers 200.

## 6. low: torrents with BEP 47 pad files cannot complete from a web seed

**Where.** The vendored webtorrent `lib/webconn.js:100` (the request list for a range is every file that overlaps
it, pad files included); `src/sw/core.js:1575` (the drop-in rewrite fetches `/<path>` for `.pad/<n>` too); the
breaker in `src/loader/torrent.js:1197-1220` then counts the 404s as web-seed failures.

**Defect.** The loader's own piece math handles pad files (`verify.js`, `BlobChunkStore`, `torrent-file.js`
`sliceForPiece`), as DESIGN-REVIEW item 9 asks. But web-seed downloads ask the host for `<ws>/<name>/.pad/<n>`,
which no host serves (BEP 47: pad files are not on the seed). Every piece that touches a pad file fails, and after 3
failures the web seed backs off for 5 minutes. `publish.mjs` never writes pad files, so this affects pointers to
torrents made by other tools (libtorrent and qBittorrent align files with pad files) that carry `ws=`.

**Failure scenario (reproduced with webtorrent 3.0.21 in Node).** Files `a.txt` (100 B), `.pad/16284` (pad), `b.txt`
(100 B), 16 KiB pieces, a 127.0.0.1 web seed serving `/site/a.txt` and `/site/b.txt`. Requests seen: `/site/b.txt`,
`/site/a.txt` and `/site/.pad/16284` (404). After 6 s piece 0 is still unverified and `done` never fires.

**Fix.** Extend the B3 build patch so webconn leaves pad files out of the request list and zero-fills their part of
the range. In the SW rewrite, answer the mapped torrent's pad paths with zeros. Until then, drop `ws=` with a visible
warning when the parsed torrent has pad files.

**Test.** A Node test with the patched bundle: the torrent above completes from the web seed with no request for
`.pad/`. A `sw-core` test: `/_mw/ws/<name>/.pad/16284` with a `Range` answers zeros.

## 7. low: test-harness flakiness sources

**Where.** `test/e2e/lib.mjs:195-197` (`setupStack` builds into the shared `ROOT/dist`; `scenarios-serving.mjs`,
`peer-scenarios.mjs` and `tools/demo.mjs` serve or rebuild the same directory); `build.mjs:535` (`rmSync(outDir)` and
then file-by-file writes: not atomic); `test/unit/loader-app-arrival.test.mjs:82` (part of `npm test`: walks
`ROOT/dist`, and silently walks nothing when the directory is missing at that moment); `test/e2e/run.mjs:263` (cold
start at most 3,000 ms), `:361` (cached render at most 3,000 ms), `test/e2e/peer-scenarios.mjs:120` (wire dropped
within 1,000 ms), `:234` (re-announce within 6 s).

**Defect.** Running `npm test` while an e2e run starts, two e2e runs, or e2e with `tools/demo.mjs` or
`node build.mjs` on one tree races on `dist/`. The unit test can throw ENOENT, or pass without checking `dist/`; a
dev server can serve a half-written build mid-scenario (SRI mismatch, missing assets). This is what this review
round's shared-tree rule works around by hand. Performance targets asserted as pass/fail make the functional suite
fail on a loaded runner. The verifier saw PEER-BLIP fail once under load before its root cause was found, so a
timing failure is hard to tell from a real one.

**Failure scenario (measured).** The test's walk, repeated for 20 s while `node build.mjs` ran in a loop (60
builds), in a copy of the tree. Out of about 33,700 walks: 215 threw ENOENT, 3,240 found no `dist/` (the test would
have checked nothing), and 552 saw a partial build.

**Fix.** Build into a unique directory per run (`.tools/e2e/run-*/dist`) and serve that; make `build()` write to a
temporary directory and `rename` it into place. Have the C4 test build its own output (or read `build.json` and fail
when `dist/` is absent) instead of walking the shared one. Report timing targets as measurements (DEMO-RESULTS) and
assert only generous upper bounds in e2e.

**Test.** A harness self-test that runs two `setupStack()` calls at once and checks each serves its own build. The C4
test fails, not passes, when `dist/` disappears during the walk.

## Checked and found sound

- DAG (`src/chain/dag.js`): depth is computed once from parents that are present (a function of the causal past, so
  it is identical on every node); `order()` sorts by (depth, h); `root()` and window digests hash sorted raw hashes;
  `redact` keeps `root` and digests and only moves byte figures; orphans connect breadth-first without recursion;
  per-peer and total orphan caps evict oldest first and leave waiting children re-requestable through `missing()`.
- Blocks: `prev` must be sorted and unique (no duplicate parents), at most 8; `z` travels exactly with `v`;
  sizes count `z`; `attachValue` re-checks the salted `vh`.
- Reducer (`state.js`): the permission bitset pass walks children before parents (indices follow total order), the
  fold excludes descendants exactly, `admit()` at the heads matches `reduce()` for a fresh block (one control state:
  no descendant can exist), and incremental `_applyTombstone` agrees with it.
- Sync: equal window sets imply equal roots; `_maybeSync`'s "we hold all its heads" shortcut is correct because DAGs
  are downward closed; a lost last INV page is closed by the 10 s job timer; a session never idles out while a job
  is active; every want ends (answered, re-sourced after 10 s, or failed after 3 rounds).
- Ingest ordering: topological order within a frame, verification before placement, deferred blocks re-judged when
  their parents arrive, values restored only for non-redacted stubs, redactions persisted through `_pendingDrops`.
- IndexedDB discipline: `stores.js`, `cache.js` and the SW reader build every value before a readwrite transaction,
  issue requests only synchronously or from request callbacks, retry once on UnknownError/InvalidStateError and step
  aside on `versionchange`; `saveSite` writes the manifest and every file in one transaction (Blob puts first).
- Piece math: `sliceForPiece`, `readPieceRange` and `verifyFile` handle pad files (zeros, never served) and
  zero-length files (no piece); `checkPiece` checks the length first; `MemoryChunkStore` validates piece sizes;
  `_collect` aligns webtorrent files by index (parse-torrent keeps pad files too).
- Lifecycle rebuild keeps download progress (`RetainedStore` plus the captured bitfield, spot-checked by webtorrent);
  a rebuild cannot interleave with `_collect` (in-memory store reads complete in microtasks); the ledger re-attaches
  through the `torrent` event on every new torrent.
- Choke lock instead of `throttleUpload(0)`; the 32 KiB/s shaping floor; the wire cap prefers `mw_chain1` wires
  (score bonus) and counts unique peer ids.
- Determinism: the rendezvous infohash is `sha1hex("mw-ledger/1/" + ledgerId)` in loader, drop-in and publish alike;
  `buildTorrent` sorts paths by UTF-8 bytes, fixes the piece length and `createdBy`, strips or fixes `creation date`
  and asserts the infohash and file order.
- SW and page: the shell's reload-once guard and controller wait; `mw-set-current` acknowledged after a forced
  re-read; drop-in's double empty-scope check before registering; the drop-in Leadership generation counter and
  abortable queued lock request; `pow-client` abort and worker-failure fallbacks.

## Reported elsewhere, not repeated here

Security review: succession does not revoke the old owner key (1), `/_mw/ws/` as a header-less proxy (2), `rot=`
treated as untrusted in the shell (3), hub gate skipped after Cancel (4), peer-id keyed gossip links (6), unsigned
withdrawal by fragment (7), unbounded `xs=`/`cs=` buffering (8). Conformance review: drop-in engine exposed on
`window` (1), a key rotation starting a new ledger (2), first-visit DNS override (4), verifier pool always inline
(5), limited mode under the normal CSP after a `ready()` timeout (6), withdrawals refused under clock lag (9), PoW
without progress or cancel and SDK timeouts that still publish (10), drop-in phones destroying the client when
hidden (13). Accepted limits: verified pieces memoised per worker instance; blocks WANTed as parents of held orphans
skip PoW and policy at ingest (bounded by the cap).

## Not verified

- Finding 1 was run in Chromium only (WebKit is allowed here only with consent pending and without peers; Firefox
  does not launch on this machine).
- Finding 2 used a 64 KiB ledger cap to keep the run short. With the default 8 MiB cap the allowance is 17 MiB, and
  the time to drain it depends on how far the subsets differ after a flood. The mechanism and the drop of owner
  blocks are the same; the timing was not measured.
- Finding 4 was shown with an async fake key store (2 to 3 ms per operation), not with two real browser tabs; the
  race window in a browser is the key generation plus two IndexedDB round trips.
- Finding 6 used webtorrent's Node library code, whose `webconn.js` request logic is the one in the vendored browser
  bundle apart from the B3 header patch; the bundle itself was not run with a pad-file torrent.
