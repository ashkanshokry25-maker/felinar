# Code review v0.3: correctness and distributed systems

Lens: CORRECTNESS AND DISTRIBUTED SYSTEMS (`.orchestration/scripts/v03-review.js`, label `review:correctness`).
Date: 2026-10-20, 21:55 to 22:45 ET. Tree reviewed: checkpoint `470f7ea` (21:46 ET); `99d7a7c` (22:01 ET) changes only
three documents, so the code is the same. Code in scope: `src/`, `tools/`, `bin/`, `build.mjs`, `test/e2e/`,
`examples/social`, `examples/existing-site-dropin` written since `709feff`, read together with the wave 1 modules that code
wires and the focus list names (`src/chat/*`, `src/media/*`, `src/sw/media-route.js`, `src/chain/state.js`, `dag.js`).
Normative inputs read first: [V03-DESIGN-REVIEW.md](V03-DESIGN-REVIEW.md) ("R"; 1.3, 2.4 to 2.11, Part 3),
[SEEDING-AND-ZERO-SETUP-DESIGN.md](../research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) ("SZ"), ARCHITECTURE 8.1 and 15,
INTERFACES (v0.3 and C2), [INTEGRATION-STATUS.md](../INTEGRATION-STATUS.md), [deviations/integration-v03.md](../deviations/integration-v03.md),
[deviations/integration-c2.md](../deviations/integration-c2.md), and the wording rules of [DESIGN-REVIEW.md](DESIGN-REVIEW.md)
section 4. IP visibility to peers is the premise of the light web and is not reported. Known open items those files
already list (COLLECTED that a holder cannot verify, the hub lane's wire-budget kind, the durable-grant reader, the pin
request path O-1, the snapshot-first screen) are not reported again. This review changed nothing in the repository
except this file.

Severity: critical = exploitable, key or data loss, or a privacy promise broken; high = a documented behaviour is wrong in
a floor browser or a must-fix item is unimplemented; medium = edge case; low = hygiene.

## What was run

Node 24.22. Every browser local-only: Chromium through `chromiumArgs()`, WebKit on `http://127.0.0.1` only.

| Run | Where | Result |
|---|---|---|
| `npm test` | own clone `scratchpad/correctness-v03-copy` (`node_modules` symlinked) | lint-floor clean; 1,967 tests, 1,967 pass, 0 fail (23.7 s) |
| `node test/e2e/run.mjs` | own clone | 71 of 71 PASS, network policy PASS ("every request stayed on 127.0.0.1"), 472.4 s |
| `node test/e2e/run.mjs --webkit` | own clone | 76 of 76 PASS (the 71, then W7, W-SI, W-MD, E-CL-1W, DOOR-GUEST-W in WebKit 27.2), network policy PASS, 496.7 s |
| Probes against the real modules (no browser; the WebTorrent probe uses two Node clients on 127.0.0.1 with DHT, trackers, LSD, UPnP, NAT-PMP and uTP off) | `scratchpad/correctness-v03-probes/` | p1, p1b (CR-5), p2 (drop-in route ownership: sound), p3, p3b (CR-9), p4 (CR-8), p5 (CR-14, CR-15), p6 (CR-4), p7 (CR-7), p8 (CR-11), p9 (CR-12) |

The suites are green. Most findings below are paths no test drives: a page reload between two steps, a second identity
origin window, a peer that lies inside the protocol's bounds, a clock that crosses UTC midnight, a slow seeder.

## Summary

| Id | Sev | Finding | Where |
|---|---|---|---|
| CR-1 | critical | The identity origin's vault is read once per window and written back whole: two windows (Settings left open, a sign-in in another tab) overwrite each other's per-site random keys, and the next sign-in mints new ones | `src/idp/idp.js:284-343`, `:755`, `:817-845`, `:860-875` |
| CR-2 | critical | Private media keys with no persistent home: the vault seam is never wired, so an upload by someone who may not write to the ledger, and every accepted grant, lose `fk` on reload | `src/loader/api.js:1970`, `src/media/lane.js:376-390`, `:700-704` |
| CR-3 | high | `media.restore()` has no caller: after any reload or sign-in every own private photo and video is gone from `mw.media.list()` and stops seeding | `src/loader/app.js:3062-3067`, `src/dropin/engine.js:1750-1764`, `src/media/lane.js:392` |
| CR-4 | high | A seek does not move its piece to the front: `prioritize()` only calls `torrent.critical()`, which in WebTorrent 3.0.21 changes no order, so a seek waits for every earlier piece and fails after 60 s | `src/loader/torrent.js:885-889`, `src/media/lane.js:450-476` |
| CR-5 | high | A followed ledger's recent view keeps any validly signed block from any key and trims by claimed `ts`: one lane peer wipes every post of a followed page and grows the view without bound | `src/chain/recent.js:257-360`, `src/chain/multi.js:794-798`, `:882-887`, `:1008` |
| CR-6 | high | No copy ever applies a checkpoint: `ChainNode.applyCheckpoint` has no caller in the loader, the drop-in engine or the pin node, so MF-24, MF-25 and MF-26 (bloat recovery, pruning, erasure of stubs) do nothing | `src/chain/node.js:1936-2001` (no caller), `src/chain/dag.js:434-519` |
| CR-7 | high | Contacts' chat-key records live only in memory: after a reload the recipient cannot compute any contact's tags, so held mail is never collected and contacts are E_NO_CHAT_KEY | `src/chat/service.js:279-300`, `:803`, `:384-397` |
| CR-8 | high | Held mail is collectable only on its UTC day and the next: holders keep it 7 days, but `_onHeld` applies the relay day rule and recipients listen on day - 1 to day + 1 only | `src/chat/lane.js:511-521`, `src/chat/tags.js:57-59`, `src/chat/limits.js:100` |
| CR-9 | high | A lost ACK is never sent again: a re-sent copy of a delivered message is dropped by the replay guard before the ACK is queued, so the sender reads "outbox" forever and keeps re-sending | `src/chat/service.js:576-598` |
| CR-10 | high | Personal-site pointers are signed for 90 days and nothing re-signs them; at the next load after that every follower drops the follow silently and nobody new can follow | `src/loader/personal-site.js:122`, `:306-322`, `src/loader/app.js:3354-3359` |
| CR-11 | medium | Chat interest tags are never refreshed on a UTC day change: two contacts who stay connected stop receiving each other's messages after the second midnight | `src/chat/service.js:384-387`, `:724-732` |
| CR-12 | medium | `ban.until` is bypassed by a forward-dated `ts`, and `modActionsPerHour` by spreading claimed hours | `src/chain/state.js:916`, `:1019`, `:1770-1776` |
| CR-13 | medium | An expired temporary ban still counts as a ban for `roleOf`, the snapshot and the chat service | `src/chain/state.js:1143-1152`, `:1969-1977`, `src/chat/service.js:197` |
| CR-14 | medium | Groups after a reload keep only the current epoch: a member whose saved epoch lost a concurrent rekey refuses the winner and every later epoch ('unknown-parent'), and the 7-day grace is gone | `src/chat/service.js:288-318`, `src/chat/groups.js:241` |
| CR-15 | medium | The union of removals of concurrent rekeys is never applied: `effectiveMembers()` has no caller | `src/chat/groups.js:327`, `src/chat/service.js:539-553` |
| CR-16 | medium | The replay guard is saved only after a direct message is delivered and at `chat.disable`: group, SIG and request frames accepted before a page close can be replayed after the reload | `src/chat/service.js:546`, `:598`, `:862` |
| CR-17 | medium | The outbox re-seals and re-holds every undelivered message every 5 minutes: holders fill their 64-per-tag and 512 KiB-per-source quotas with copies of the same messages | `src/chat/outbox.js:98`, `src/chat/service.js:453-458` |
| CR-18 | medium | `media.revoke({ reencrypt: true })` keeps the old id while the manifest gets a new `fid`: a later revoke or delete names an id no recipient has | `src/media/lane.js:571-596`, `:552`, `:619`, `:675-704` |
| CR-19 | low | RECENT answers never carry `truncated`; the requester always passes `truncated: false`, so `controlExact` is wrong for ledgers with more than 4,096 control blocks | `src/chain/multi.js:682-711`, `:794` |
| CR-20 | low | Hub lane budget bypass: the bucket is chosen from the first `"ledger"` in the raw text, the handler uses the last one after `JSON.parse` | `src/chain/multi.js:626-634`, `:653-658` |
| CR-21 | low | Every follow opens a full ChainNode, an IndexedDB database and a 1 s tick timer that never receive a block, one after another at load | `src/loader/app.js:3305-3322`, `src/loader/personal-site.js:306-322`, `src/chain/recent.js:457` |
| CR-22 | low | IndexedDB hygiene: an unobserved rejected transaction promise, meta entries dropped before their commit, the grace flag cleared before its write | `src/files/store-idb.js:90-101`, `src/chain/stores.js:300-312`, `src/chain/node.js:1916-1917` |
| CR-23 | low | Test flakiness: wall-clock and heap bounds under the parallel unit runner; the e2e media lab copies a hand-picked file list | `test/unit/harden-chain-hello.test.mjs:74`, `:105`, `:165`; `test/e2e/scenarios-v03.mjs:59-66` |

---

## CR-1 critical: lost updates of the identity origin's vault (per-site keys lost)

**Where.** `src/idp/idp.js:284-343` (`unlock`, `saveSession`), `:755` (end of a sign-in), `:817-845` (`replaceAllKeys`,
`stopSame`), `:860-875` (`makeBackup`); `src/idp/store.js` keeps one `'vault'` record.

**What happens.** `unlock()` reads the vault blob once per identity-origin window (`if (session.secrets) return session;`),
the window keeps that `Vault` in memory, and `saveSession()` writes the whole in-memory vault back. A sign-in creates the
per-label random keys there (`vault.label(label)`, `rotateChat`, `newRecordKey`, `entry.own`, `entry.local`, lines 635 to
648). There is no re-read, no merge, no version check and no cross-window lock (no `navigator.locks`, no
BroadcastChannel in `src/idp/`). The `'state'` record (origins, hub choices, `seqFloors`) is read at the start of a request (`:530`) and written back whole at its end (`:754`), so a slow card in one window rolls back what another window wrote meanwhile, including the pointer `seq` floors of MF-30.

**Failure scenario.** (1) The person opens the identity origin's Settings (`mw.identity.openIdentity()`) and unlocks it,
for example to see the recovery kit; that window caches vault V0. (2) In another tab they sign in on site S for the first
time; that popup reads V0, adds S's label with fresh random `own`, `local`, `rec` and chat keys, saves V1, and S starts
writing its own-index media items (`K_own`), its local record and chat state (`local`) and receives messages for that
chat key. (3) Back in Settings they press "Stop using the same identity" for another site, or "Replace my keys on all
sites": the window saves V0 plus that change, and S's entry is gone. (4) The next sign-in on S finds no entry and mints new
random keys: S's sealed items, local caches and record no longer open, and S's contacts see a key change. "Make a backup
file" in that window after step 2 writes a backup without S. Two sign-in popups opened from two tabs at the same time
lose one site's keys the same way.

**Fix.** Make every vault mutation a read-modify-write under a cross-window lock: `navigator.locks.request('mw-idp-vault',
...)` (Safari 15.4 has it), re-reading and re-opening the blob inside the lock before applying the change; add a version
counter to the vault blob and refuse to save over a newer one; Settings re-reads before backup, link and export.

**Test.** Unit with two `createIdp` instances over one fake IndexedDB: A unlocks; B signs in to a new origin and saves; A
runs `stopSame`; a third sign-in to B's origin returns the same `own`, `local`, `rec` and chat keys as B's first sign-in.
A second test: a backup file made by A after B's sign-in contains B's label.

## CR-2 critical: private media keys with no persistent home

**Where.** `src/loader/api.js:1970-1980` (`common` deps of files and media: no `vault`), `src/media/service.js:139`
(`vault: deps.vault`, always undefined), `src/media/lane.js:376-390` (`_writeOwn`), `:700-704` (`onGrant` keeps grants in
`this.items` only), `src/files/lane.js` (received private files, memory only).

**What happens.** R 2.9.4: "Where the person may not write to the ledger or chose not to, `M` and `fk` stay in the vault
only"; MF-72: "contacts and file keys also live in the identity vault". No caller passes a vault, so `_writeOwn` skips its
vault copy, and when `canWrite()` is false (a signed-in visitor on a `writers: 'owner'` site with `_mw.cfg.media` on, which
R 2.5.4 allows) it writes no ledger copy either. Accepted grants (`onGrant`, `accept`) exist only in memory; the grant DM is
acknowledged, so it is not sent again, and nothing feeds chat history back to `onGrant`.

**Failure scenario.** A forum reader uploads a private video and shares it with Bo. Either of them reloads (or signs out:
`MediaLane.signOut()` clears `items`): the uploader's `fk` existed only in memory and is gone for good (the ciphertext stays
orphaned in the `mw-files` database, `'m-' + id`); Bo's `mw.media.list({ from: 'received' })` is empty and the uploader
must share again, which they no longer can.

**Fix.** Give the media and files lanes a persistent sealed store: the identity origin vault as R and MF-72 say, or until
then the per-origin sealed cache the chat store already uses (`keys.saveLocal` / `loadLocal`, `chatStore` in
`src/loader/api.js:1821`); write own items without a ledger copy and every accepted grant there; `restore()` reads it.

**Test.** Unit through `mountV03Services`: a reader on an owner-only site uploads, the services are destroyed and mounted
again on the same stores, `media.list({ from: 'mine' })` returns the item and `open()` decrypts; a recipient accepts a
grant, remounts, and still lists and opens it.

## CR-3 high: own private media never come back after a reload

**Where.** `src/media/lane.js:392` (`restore()`), `src/media/service.js:239` (exposed); callers: none
(`src/loader/app.js:3062-3067` restores only the identity service; `src/dropin/engine.js:1750-1764` the same).

**What happens.** `restore()` reads the person's own-index items (`mw.s`, kind 3) back from the ledger, but nothing calls
it: not after the services mount, not after a sign-in, not after "Stay signed in" keys come back. `list()`, `open()` and
`share()` read the in-memory `items` only.

**Failure scenario.** In `examples/social` Ada uploads three photos to her own page (she owns the ledger, so the sealed
own-index items are written) and reloads: `views/media.js:72` shows an empty gallery, `open(id)` answers
E_FILE_UNAVAILABLE, and her items are no longer seeded, so the people she shared them with cannot fetch them either.

**Fix.** Call `media.restore()` whenever working keys are installed (sign-in, restore of kept keys) in shell, hub and
drop-in modes, then re-add own items to the swarm (`_seed` with lane K) so grants keep working.

**Test.** e2e (members scenarios): upload, reload, sign in, `mw.media.list({ from: 'mine' })` has the item and the worker
route plays it; unit: an `auth` change in `mountV03Services` triggers `media.restore()`.

## CR-4 high: seeks in private media do not reprioritize pieces

**Where.** `src/loader/torrent.js:885-889` (`FileTorrentHandle.prioritize` calls only `t.critical(i0, i1)`),
`src/media/lane.js:450-476` (`_chunk`: prioritize, then wait at most `CHUNK_WAIT_MS` = 60 s), `src/sw/media-route.js`.

**What happens.** In WebTorrent 3.0.21 `critical()` only sets `_critical[i]`, which enables hot-swapping a slow peer's
request; piece order still follows `_selections`, and a file torrent has one whole-file selection with the default
`'sequential'` strategy. Even `select(i, i, 1)` does not help: `Selections.concatenate` merges a range inside an existing
selection into it. WebTorrent's own file streams use a stream selection: `torrent._select(start, end, 1, null, true)`.
R 2.9.6 says the loader moves the piece to the front and a seek costs one or two pieces.

**Failure scenario (probe p6, measured).** Two Node clients on 127.0.0.1, 64 pieces of 64 KiB, the seeder at 256 KiB/s, a
seek to piece 60 at metadata time: with `critical(60, 60)` piece 60 arrived after 15,052 ms, 59 pieces before it; with
`select(60, 60, 1)` after 15,316 ms; with `_select(60, 60, 1, null, true)` plus `critical` after 303 ms, first. For a
20 MiB video from a phone uploader at 128 KiB/s (R 2.9.6), a seek to the middle waits for about 40 pieces of 256 KiB
(80 s): `_chunk` gives up at 60 s, emits `unavailable`, and the page says "Nobody who has this video is online right now."
while the uploader is online.

**Fix.** `prioritize(i0, i1)` adds a stream selection at high priority plus `critical`, and removes it
(`_deselect(i0, i1, true)`) when the pieces verify or the request is abandoned; the worker tells the page when a stream is
cancelled (a `mw-chunk-cancel` message) so selections of abandoned seeks do not pile up.

**Test.** Probe p6 as a unit test of `FileTorrentHandle` over two Node clients on loopback: after `prioritize(60, 60)` the
first verified piece is 60; e2e: E-MD-4 with a throttled uploader seeking to 90 percent of the item plays within the
chunk wait.

## CR-5 high: any lane peer can wipe a followed page's posts (recent view without admission)

**Where.** `src/chain/recent.js:257-322` (`RecentView.add`: `validateBlock` with `minBits: 0` and the root rule only),
`:347-355` (`_trim`), `src/chain/multi.js:794-798` (RECENT answers applied, `p.delivered += added`), `:882-887` (BLOCKS
after ANN), `:1008` (`_pickPeer` prefers the peer with the most `delivered`).

**What happens.** The view keeps every validly signed block of the ledger id, whatever its author: there is no admission
against the ledger's policy (writers, allow, bans, PoW floor). Blocks without standing have no effect on the reduced
state, but they occupy the view, and `_trim` evicts the oldest payload blocks by claimed `ts` and never evicts control
blocks. Junk is also counted as `delivered`, so the attacker becomes the preferred source, and a desktop follower relays its
view to others (`_viewWindow`).

**Failure scenario (probes p1, p1b, measured, default limits).** A personal ledger with 200 posts (writers 'owner'); one
RECENT answer of `MAX_WINDOW_BLOCKS` (4,096) `append` blocks signed by a fresh key, `ts` = now, `prev` = the owner's head:
"honest window: 201 blocks, 200 posts shown"; "after one junk answer: 4096 blocks, 0 posts shown"; "after the next honest
refresh: 4096 blocks, 0 posts shown" (the honest blocks are older by `ts`, so they are trimmed again). 400 junk `tombstone`
blocks on a view capped at 200 left 401 blocks: control blocks are never trimmed. Any visitor who joins the hub's lane swarm
can do this to every page every follower follows.

**Fix.** In `RecentView.add`, admit each block against the view's control state before keeping it (author standing under
writers, allow and bans; the PoW floor; the `_`, `@` and schema rules can stay state rules); count only admitted blocks as
`delivered` and strike the peer for the others; `_trim` drops blocks without effect first and bounds control blocks to
those with standing; cap blocks per author.

**Test.** Unit: a view of a 200-post owner-only ledger takes 4,096 blocks signed by another key: 200 posts stay, the view
stays at or below `maxBlocks`, the lane peer is struck and not chosen by `_pickPeer`.

## CR-6 high: checkpoints are never applied by any copy

**Where.** `src/chain/node.js:1936-2001` (`applyCheckpoint`, `_applyCheckpoint`): no caller in `src/loader/`, `src/dropin/`,
`src/sdk/` or `tools/pin.mjs` (grep); the only checkpoint writer is `tools/ledger-admin.mjs checkpoint`. `src/chain/dag.js:434-519`.

**What happens.** A checkpoint in effect changes the reduced state (state.js settles the covered history), but no node
prunes: covered blocks and stubs stay in memory, in IndexedDB and in every export, `dag.bytes` never drops, and the
store's `'checkpoint'` row is never written, so the prune-on-load path at `node.js:645-657` never runs either. R 2.5.3
("A copy that holds S may delete every block in the checkpoint's causal past"), MF-24 (bloat recovery), MF-25 and MF-26
(erasure) and PRIVACY.md lines 279, 320, 321 ("honest copies that apply it drop every earlier block and stub") describe
behaviour no shipped copy has.

**Failure scenario.** A group site reaches `E_LEDGER_FULL`; the owner writes a checkpoint with `ledger-admin`; every
visitor's copy and the pin keep every byte and stay full. A person who deleted their personal page keeps every stub of it
in every follower's and pin's copy after their own checkpoint.

**Fix.** When `_recomputeControl` finds `st.checkpoint` not equal to `dag.checkpointBase()`, compute S
(`checkpointFor(dag, heads)`) and run `_applyCheckpoint(S)`; `tools/pin.mjs` does the same. While wiring it: `pruneTo`
connects orphans whose missing parents are covered and returns them in `dag.lastAdded`, which `_applyCheckpoint` neither
notes (`_noteInserted`) nor persists, and the anchored `dag.add(cp)` overwrites `lastAdded`; and a copy that prunes on load
(`node.js:653`, empty DAG, `_coveredMaxDepth` = -1) numbers the uncovered blocks from depth 0 while a copy that pruned live
keeps the original depths, so their depth windows differ: persist the covered depth with S.

**Test.** Unit: an owner checkpoint arrives over gossip at a node holding the history: after a tick the store has the
`'checkpoint'` row, covered rows are gone, `dag.bytes` and `capacity()` drop; reopening the store gives the same root and
the same `windows()` as a peer that pruned live; an orphan waiting on a covered parent is in the store after the prune.

## CR-7 high: contacts' chat keys are not persisted, so offline delivery fails after a reload

**Where.** `src/chat/service.js:279-300` (`persist`: contacts, counters, history, groups; no CK records), `:803`
(`S.ckCache = new CkCache(...)` empty at every enable), `:384-397` (`refreshInterest` skips contacts without a CK),
`:1020` (`dm.send`: E_NO_CHAT_KEY).

**What happens.** A contact's CK is learned only from a CK frame of a direct neighbour or from an opt-in `mw.ck` ledger
copy, and it lives in memory. R 2.7.2 says CKs are "cached by every chat peer and by the pin mailbox until `exp` (90
days)".

**Failure scenario (probe p7, measured).** Ana and Bo meet once and add each other; Bo leaves; Ana sends with "Deliver
later" through holder Carol ("Handed to 1 peer"). Bo reloads the page (a new service on the same sealed store) and meets
only Carol: "after the reload Bo still lists contacts: Ana | Ana's chat key known: false"; "Carol holds: 1 | Bo received
after the reload: 0". A recipient coming back online is almost always a fresh page load, so held mail from contacts is
practically never collected, and Bo cannot message Ana either until they are direct neighbours again.

**Fix.** Persist accepted contacts' CK records (sealed, with `exp`) in `persist()`, load them into the cache at enable before
`refreshInterest`, and drop them at `exp`.

**Test.** Probe p7 as a unit test: after Bo's reload he collects Ana's held message from Carol, and `dm.send` to Ana does not
answer E_NO_CHAT_KEY.

## CR-8 high: held mail older than one UTC day can never be collected

**Where.** `src/chat/lane.js:511-521` (`_onHeld` runs `_admit`, whose day rule is "today or yesterday"),
`src/chat/tags.js:57-59` (`listenDays`: day - 1, day, day + 1), `src/chat/holder.js` and `src/chat/limits.js:100`
(`HOLD_TTL_MS` 7 days), `src/loader/strings.js:424` ("for up to 7 days").

**What happens.** Holders store a frame with its original header day and its tag for that day. The recipient drops a held
frame whose day is older than yesterday, and its WANT-TAGS prefixes and interest cover only the tags of day - 1 to day + 1.
The relay day rule of R 2.7.3 is meant for live relaying; R 2.7.5 keeps held mail for 7 days and the replay window accepts
`t` back to 7 days.

**Failure scenario (probe p4, measured).** Ana sends Bo a message with the hold flag at 12:00 UTC; Carol holds it; Bo
connects to Carol after a gap: 2 h and 30 h, received (Carol deletes it on COLLECTED); 72 h, "Carol still holds: 1 | Bo
received: 0". Depending on the hour, mail older than 24 to 48 hours is lost although the holder's card says 7 days. Group
rekey invites travel the same way (hold flag), so a member offline for two days misses the new key.

**Fix.** Exempt held frames from the relay day rule (accept a held frame whose day is within the hold TTL) and, when
asking holders, compute interest and WANT-TAGS prefixes for the contact and inbox tags of the last 7 days; keep the live
relay rule as it is.

**Test.** Probe p4 as a unit test: with a 72 h gap Bo receives the message; with an 8-day gap the holder has expired it.

## CR-9 high: a lost ACK is never sent again

**Where.** `src/chat/service.js:576-598` (`deliver`: `if (!r.ok) return;` before `S.acks.queue`), `src/chat/outbox.js:76-99`.

**What happens.** The receiver ACKs a contact's message once, 2 to 20 s after the first copy. If that ACK does not reach the
sender (the wire dropped, the sender's phone hid the page), the sender's outbox re-sends (30 s, then every 5 minutes); each
copy opens, the replay guard refuses it as a replay, and `deliver` returns before queueing an ACK.

**Failure scenario (probes p3, p3b, measured).** Ana sends; Bo shows the message; the wire drops during the ACK delay; they
reconnect: 10 minutes later Ana's state for the message is still `["outbox"]` ("Will send when Bo is online while this page
is open"), 12 frames went from Ana to Bo, Bo shows the message once. R 2.7.5 item 6 "Delivered" is never reached, and the
outbox keeps re-sending and re-holding (CR-17) for the page's lifetime.

**Fix.** When the replay guard refuses a direct message from an accepted contact as a replay of an id this tab delivered,
queue the ACK again (rate-limited per id), without emitting a second `message`.

**Test.** Probe p3 as a unit test: after the reconnect the next re-send is ACKed and the state becomes `delivered`, and Bo's
`message` events stay at one.

## CR-10 high: personal-site pointers expire after 90 days and follows vanish

**Where.** `src/loader/personal-site.js:118-123` (`personalPointer`: `exp = seq + 90 days`, signed once at "Create my
page"), `:306-322` (`load()`: a stored follow is re-verified with `verifyPointer`; `catch (_) { /* a follow that no longer
verifies is dropped */ }`), `src/loader/app.js:3354-3359` (`verifyPointer` with `now`, no `allowExpired`). No code
re-signs a personal pointer (grep); the only related string, `pointerExpiresSoon` ("The publisher must re-sign this site's pointer"), asks for something a personal-site owner has no way to do.

**Failure scenario.** Ada creates her page on day 0. On day 91 every follower who reloads the hub app loses Ada from the
timeline without a message (the follow stays in `hub:follows` but is skipped), "Follow by link" with Ada's link answers
E_BAD_REQUEST ("the pointer signature does not verify"), and a fresh visitor to her label cannot load the page. Every
member of a social hub disappears this way 90 days after joining.

**Fix.** The owner's page re-signs its pointer (new `seq` and `exp`, through the identity origin card or the working key
that owns the personal ledger) when less than 30 days remain, and publishes it where followers find it (the hub, a pin, the
ledger); `load()` keeps stored follows whose pointer only expired (verify with `allowExpired`, show "not refreshed since")
instead of dropping them.

**Test.** Unit: `createHubService` with a stored follow whose pointer expired yesterday: `load()` keeps it, flagged; unit: the
owner's loader re-signs a personal pointer with `exp - now` under 30 days.

## CR-11 medium: chat interest is never refreshed when the UTC day changes

**Where.** `src/chat/service.js:384-387` (`refreshInterest` recomputes on a day change only when called), `:724-732`
(`wantTick` uses `S.interest` as it is). Callers pass `force` on events (contact added, CK frame, invite); no timer calls it.

**Failure scenario (probe p8, measured).** Ana and Bo stay connected (no new neighbour, so no CK frame triggers a refresh);
messages after 0 h and 20 h arrive, messages after 44 h and 68 h do not ("Bo received: day 0 | after 20 h"). Holders and
keeper tabs, the long-lived desktops of R 2.7.5 and SZ 3.1, are exactly the tabs that stay open across midnights.

**Fix.** Call `refreshInterest()` (not forced) at the start of `wantTick`, and before opening a frame whose tag is unknown.

**Test.** Probe p8 as a unit test: all four messages arrive.

## CR-12 medium: claimed timestamps defeat `ban.until` and the moderator hourly cap

**Where.** `src/chain/state.js:1770-1776` (`bannedNow`: `ts < until`), `:1019` (`bannedAt`), `:916` (`capOk` keys by
`floor(e.ts / 3600000)`). Neither block.js nor node.js bounds `ts` against local time.

**Failure scenario (probe p9, measured).** The owner bans a spammer until next week; the spammer writes a post now with
`ts` = `until`: "post claiming now: refused E_BANNED; post claiming ts = until: added; posts in effect during the ban:
["written now, claims next week"]". The same claimed-time key lets a hostile or compromised moderator spread tombstones
and bans over many claimed hours, so `modActionsPerHour` (MF-27, HUB H2) does not bound what one session can erase.

**Fix.** A local admission rule: live blocks with `ts` more than 5 minutes ahead of this node's clock are deferred until
then (never stored or relayed early), which makes `until` hold for honest copies; for the cap, refuse live moderator
control blocks whose `ts` is far from the arrival time, and key the state rule by the hour of max(`e.ts`, the newest `ts`
in the block's causal past).

**Test.** Probe p9 as a unit test: the forward-dated post is deferred while the clock is before `until`; 200 moderator
tombstones claiming 24 different past hours, arriving live within one hour, have at most `modActionsPerHour` effects.

## CR-13 medium: an expired temporary ban still counts as a ban

**Where.** `src/chain/state.js:1143-1152` (every unlifted ban goes into `banned`, whatever its `until`), `:1969-1977`
(`roleOf`: `p.banned.has(pub)` gives 'reader'), `:1953` (the snapshot lists it), `src/chat/service.js:197` (chat's
`banned()` reads `policy.banned`).

**Failure scenario.** A writer banned until yesterday posts today: `admit` accepts the post (it uses `banUntil`), but
`mw.ready().role` and `roleOf` say 'reader', a members-only chat refuses them (E_POLICY), `chat.room.send` answers
E_BANNED and other members drop their ROOM frames, forever.

**Fix.** Keep permanent bans in `banned` and temporary ones only in `banUntil`, and pass `now` to `roleOf` and to the chat
service's check (in force while `now < until`); the snapshot lists temporary bans with their `until`.

**Test.** Unit: ban `{ until: T0 + 1 h }` on an open site; at T0 + 2 h `roleOf` is 'writer', the snapshot does not list the
key as banned, and `chat.room.send` succeeds.

## CR-14 medium: group state does not survive a reload

**Where.** `src/chat/service.js:288-294` (`persist` keeps `{ record, secret }` of the current epoch only), `:307-318`
(`restore` calls `GroupState.adopt`, which makes `record.prev` the new root with that one child), `src/chat/groups.js:241`
(`verifyRecord`: a record whose parent is not held is 'unknown-parent'), `src/chat/service.js:617` (onInvite ignores it).

**Failure scenario (probe p5, measured).** Admins A and B rekey epoch E1 at the same time; member C saved the losing child
and reloads: "reloaded member: receive(winner) -> {"ok":false,"reason":"unknown-parent"}; still on the losing epoch: true";
"next epoch -> unknown-parent". C is forked off the group for good (a live member resolves it: "receive(winner) ok = true").
After any reload the previous epoch's secret is also gone, so the 7-day grace of R 2.7.7 ends at the reload.

**Fix.** Persist every epoch record the member holds within the grace window together with the parent records it needs
(at least the adopted root's parent), and rebuild with `receive()`; accept a sibling of the adopted epoch by checking it
against the stored parent's admin list.

**Test.** Probe p5 as a unit test: after the reload C accepts the winner and the next epoch, and still opens a message sent
under the previous epoch inside the grace window.

## CR-15 medium: the union of removals of concurrent rekeys is never applied

**Where.** `src/chat/groups.js:327` (`effectiveMembers()`, no caller), `src/chat/service.js:539-553` (group frames checked
against the winning record's `members`), `:1303` (`heldGroupMembers` uses `members()`).

**Failure scenario (probe p5).** A removes X while B concurrently adds Y; B's child wins: "removed-by-loser key still a member
of the winner: true". Every member keeps accepting X's messages and naming X in shares and calls to the group until A, if
online, re-applies the removal. R 2.7.7: "members accept the union of removals".

**Fix.** Use `effectiveMembers()` wherever membership decides something (incoming group frames, `groupMembers`, calls
rosters), and let any admin (not only the losing one) rekey the union away.

**Test.** Probe p5 extended: after the resolution a group message signed by X is not delivered, and `groupMembers` omits X.

## CR-16 medium: the replay guard is saved too rarely

**Where.** `src/chat/service.js:598` (the only save after an accept, in `deliver`), `:862` (`turnOff`); `:546` (group frames),
`:568` (SIG, `deliverSig`), `:529` (requests) accept without saving; neither `app.js` `onPageHide` nor the drop-in engine's
`suspend()` saves it.

**Failure scenario.** A member reads group messages in a room and closes the tab; a relay that captured the frames replays
them the next day (still "yesterday" under the day rule): the reloaded tab accepts and shows them again. R MF-36: "Ordering
and replay must survive a reload".

**Fix.** Save after every accept, debounced (for example 2 s), and on `pagehide` and on `visibilitychange` to hidden.

**Test.** Unit: accept a group message, recreate the service on the same store, deliver the same frame: it is refused as a
replay.

## CR-17 medium: every re-send deposits a new held copy

**Where.** `src/chat/outbox.js:98` (with the hold flag, a new attempt every `OUTBOX_RETRY_MS * 5` = 5 minutes while it reached a
neighbour), `src/chat/service.js:453-458` (`outboxSend` re-seals: a new `epk` and so a new frameId each time),
`src/chat/holder.js` (deduplication by frameId).

**Failure scenario.** Ana writes Bo 30 messages while Bo is away for an afternoon; each is re-sealed and re-held every 5
minutes (12 an hour): Carol's 64 slots for Bo's tag and her 512 KiB share per neighbour (about 460 frames of 1,139 bytes) fill
with copies, and the work-based replacement then drops distinct messages while copies of others stay. CR-9 makes this last
for the whole page lifetime.

**Fix.** Keep one sealed envelope per message per UTC day (same `epk` and frameId) for re-holds, and re-hold only when no
HOLDING came back for it.

**Test.** Unit: Ana sends with "Deliver later" to an offline Bo through Carol; after 1 h Carol holds one frame for that
message, not 12.

## CR-18 medium: re-encryption keeps the old id

**Where.** `src/media/lane.js:571-596` (`_reencrypt` sets `rec.M` to a manifest with a new `fid` but keeps `rec.id` and the
`items` key), `:552` and `:619` (revoke and delete send `{ t: 'revoke', id }` with that old id), `:675-704` (recipients key
items by `idOf(M)`, the new `fid`), `:410` (`restore()` keys by `idOf(M)` too).

**Failure scenario.** Ada shares a video with Bo and Cy, revokes Cy with `reencrypt: true` (Bo gets the new grant, keyed by
the new id), then revokes Bo: Bo's lane looks up the old id, finds nothing, and keeps the key. After Ada's next reload her
item has the new id, so the id the site code held stops working.

**Fix.** Move the record to `idOf(newM)` after re-encryption (items, sessions, an `id` change event to the site), and make
revoke name what recipients key by.

**Test.** Unit: share with A and B, `revoke(A, { reencrypt: true })`, `revoke(B)`: B's `open()` answers E_REVOKED.

## CR-19 low: RECENT answers drop `truncated`

**Where.** `src/chain/multi.js:682-711` (`_serveRecent` pages carry `ledger, rid, b, more, cp?`), `:794` (`applyWindow(...,
{ truncated: false })`).

**Failure scenario.** A group site with more than 4,096 control blocks (bans, tombstones, allow changes): the responder's
window drops the oldest control blocks and sets `truncated`, the requester never learns it, and `controlExact` reads true
while old bans or policy blocks are missing from the view.

**Fix.** Carry `truncated` on the first page and pass it through.

**Test.** Unit: a lane answer for a ledger over the block cap gives `view.state().controlExact === false`.

## CR-20 low: hub lane budget bypass with a duplicate ledger key

**Where.** `src/chain/multi.js:653-658` (`_heldMode` reads the first `"ledger":"..."` in the raw text), `:626-634`
(`bucket = null` for a held ledger with a virtual peer), then `JSON.parse` keeps the last duplicate key.

**Failure scenario.** A peer sends WANT frames `{"ledger":"<held>", ..., "ledger":"<followed>"}`: they are charged to no
bucket, and the desktop answers each from the followed view (bounded only by the egress queue).

**Fix.** Decide the bucket from the parsed frame (charge the unsolicited bucket before parsing, then refund for a held
ledger), or refuse raw text with more than one `"ledger"` key.

**Test.** Unit: such a frame is charged to the unsolicited bucket.

## CR-21 low: an empty ChainNode and database per follow

**Where.** `src/loader/app.js:3305-3322` (`openFollowedLedger`: `IdbBlockStore`, `ChainNode.open` with a 1 s tick),
`src/loader/personal-site.js:306-322` (`load()` opens follows one after another), `src/chain/recent.js:457` (`applyWindow`
gives blocks to the node only when it already holds some, so a followed node stays empty).

**Failure scenario.** A desktop at the follow cap (1,000) opens 1,000 IndexedDB databases and runs 1,000 tick timers that
never see a block; a phone at 250 awaits 250 sequential opens before the timeline's follows are known, against the 5 s
first-screen target of R 3.2.3.

**Fix.** A followed ledger gets a view only (or a memory store and no tick) until it is opened in full; open follows in
parallel or lazily.

**Test.** Unit: 250 stored follows load without an IndexedDB open per follow and with one await per batch.

## CR-22 low: IndexedDB hygiene

**Where and what.** `src/files/store-idb.js:90-101`: `tx()` creates `done` and awaits `fn(s)` first; when the request fails,
`done` rejects with nobody awaiting it (an unhandled rejection; under Node's default it ends the process). `src/chain/stores.js:300-312`:
`flush()` clears `_pendingMeta` before its transaction commits, so a failed write loses the entries. `src/chain/node.js:1916-1917`:
`_graceDirty` is cleared after `setMeta('grace')`, which only buffers, so a failed flush loses the grace start times and a
reload restarts the 24 h grace.

**Fix.** Attach `done.catch(() => {})` before awaiting `fn`; put the entries back into `_pendingMeta` when the transaction
fails; clear `_graceDirty` after `flush()` resolves.

**Test.** Unit with a fake IndexedDB whose request fails: no `unhandledRejection`; the meta entry is written by the next flush.

## CR-23 low: test flakiness

**Where.** `test/unit/harden-chain-hello.test.mjs:74` (three HELLO decodes under 100 ms), `:105` (under 500 ms), `:165` (under 200
ms per frame), with `process.memoryUsage().heapUsed` deltas; `node --test` runs the files in parallel processes, so a GC pause or
a loaded CI runner fails them with correct code. `test/e2e/scenarios-v03.mjs:59-66` (`copyLab` copies a hand-written list of
`src/loader` files: one new import in `src/files` or `src/media` broke eight scenarios once, C2-14).

**Fix.** Assert operation counts (frames out, windows listed, an instrumented loop counter) instead of wall-clock time and heap
deltas, or keep only generous sanity bounds; let the media lab copy `src/` whole or bundle it with esbuild.

**Test.** Run `npm test` five times under a CPU load (`yes > /dev/null` on every core) without a failure.

---

## Checked and found sound

- **Ledger ingest order with the new ops.** `_checked` ends a wave after a permissive op (policy, allow, owner, unban, rotate,
  keyinfo); a block judged early under the old state is deferred (missing parent) or remembered as a policy refusal, and the
  memory is cleared by the next control change, so a batch whose opening op waits in the per-peer signature queue heals on the
  next sync. `rotate` authorship is a validity rule (`block.js:437`); recover beats self in either order (`state.js:900-908`).
- **Checkpoint storage.** `IdbBlockStore.applyCheckpoint` writes S and deletes the covered rows in one transaction; reopen prunes
  before loading rows (only the wiring is missing, CR-6).
- **Service Worker routes.** Reserved routes run before the hub and catch-all paths (`core.js:2030-2032`); in drop-in mode the
  worker owns `/_mw/f/` and `/_mw/media/` through the assets prefix (probe p2: `owns()` true for a `<video>`, an `<img>` poster and a
  download navigation). The range stream keeps at most 4 units in flight and re-registers sessions after a worker restart.
- **Seeding budgets and priorities.** `seedBudget`, `planSeeding` and the meters match SZ 3.1.3 to 3.1.5; month rollover and
  the throttled month record are correct; locks use choke, never `throttleUpload(0)`.
- **Calls mesh state.** Offer and ICE buffering before a roster names a peer, candidate queueing until the remote description,
  the SIG guard's 256-wide window (out-of-order relays are accepted), glare by perfect negotiation, and ended-call replies.
- **Presence.** Padded slots, MAC or signature, "away" once when hidden, entries expire after three intervals.

## Not reported again (already listed as open by the integration files)

COLLECTED that a holder cannot verify (chat O-1), the hub lane joining as kind 'group' and `wantedWires` unused, the durable-grant
reader, no page-to-pin request path (O-1) and the pin mailbox, the recent-window first screen from `cs=` snapshots, the drop-in
`mw.net.*` gap, the fetch sentence that overstates sharing under a budget.
