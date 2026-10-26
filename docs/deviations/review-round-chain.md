# Review round, chain fixer (area "chain")

Written 2026-10-24 04:50 EDT (America/Toronto). Brief: the chain findings of the review round of R 5.3
(`.orchestration/reports/all-findings-2026-10-22.json`, verdicts in `verdicts-2026-10-23.json`). Files edited:
`src/chain/block.js`, `state.js`, `node.js`, `gossip.js`, `multi.js`, `tools/ledger-admin.mjs`, the chain tests
`test/unit/chain-net-helpers.mjs`, `chain-net-node`, `chain-net-protocol`, `chain-net-sync`, `chain-net-wire`,
`freeze-schema`, `freeze-state`, `hub-lane-multi`, the new `test/unit/chain-review-round.test.mjs` (20 tests), and
appended vectors in `test/vectors/block.json`, `ledger.json` and `LOCK.json` (no existing vector or LOCK entry changed).
`src/chain/recent.js` was not touched.

## Findings

| Finding | Status | Files (line) | Test |
| --- | --- | --- | --- |
| HUB-1 (blocker) | fixed | `block.js:83` (SELF_ROTATE_PREFIX), `:317` (selfRotateSigningInput), `:535` (nsig check); `state.js:1503` (rotationLinks), `:1180` (chain and family from linked rotations only), `:1142` (write chain), keychange of next only when linked, `:1639`/`:1727` (S marks a linked self rotation `n: 1`), `:2374` (allowListed), `:2285` (admit: E_BANNED for a banned key's rotate); `tools/ledger-admin.mjs:562`, `:570`, `:1118` (`--next-key` signs nsig) | `chain-review-round.test.mjs:49`, `:76`, `:91`; `freeze-state.test.mjs` U-LG-1 rotate; vectors blk-023 to blk-025, lg-026, lg-027 |
| SYB-1 (blocker) | fixed (same change as HUB-1) | as HUB-1 | `chain-review-round.test.mjs:49`; lg-026 |
| HUB-7 (major) | fixed | `state.js:2285` (admit: writeProblem and bans for a self rotate), `:1142` (reducer: the first self rotation of `from` with the write right wins) | `chain-review-round.test.mjs:108` |
| SYB-4 (major) | fixed (same change as HUB-7) | as HUB-7 | `chain-review-round.test.mjs:108` |
| HUB-2 (blocker) | fixed | `state.js:1421` (modHidden: payload hidden by moderator standing only), assemble `modHidden`; `node.js:1348` (_graceRule uses it; owner bans, owner bulk tombstones, author tombstones and the P0 path still drop at once) | `chain-review-round.test.mjs:153`, `:178`; `chain-net-node.test.mjs` "bans and tombstones" (a moderator ban now keeps the value for the grace) |
| HUB-4 (major) | fixed | `state.js:909` (modGranted: a moderator block has standing only with the appointing policy in its causal past), pass 1b and 1d use it; `:889` (a covered parent counts as S's newest item time, `B.maxTs`); `:2302` (admit: moderatorInPast) | `chain-review-round.test.mjs:197`, `:251`; vector lg-028 |
| SYB-2 (blocker) | fixed | `state.js:125` (EPOCH_ACTION_HOURS 24, EPOCH_ALLOW_DAYS 7), `:1211` (capOk counts an epoch total), `:922` (allow additions per epoch); no new policy field: the owner raises modActionsPerHour or modAllowPerDay, or checkpoints, to give more | `chain-review-round.test.mjs:228` |
| HUB-6 (major) | fixed | `state.js:1432` (a voided author's '_' puts and appends have no effect; a put without owner standing does not replace an owner-written entry; a `_deny/` entry changes only by the owner or its author), `:2230` (admit E_POLICY 'owner-protected') | `chain-review-round.test.mjs:283`; vector lg-029 |
| HUB-5 (major) | partial | chain side unchanged on purpose: the first keyinfo stays final (MF-20); the planted-commitment case is pinned as the documented limit | `chain-review-round.test.mjs:572`. The fix is in the loader (Requests 2) |
| MP-1 (blocker) | fixed | `gossip.js:1173` (a session takes at most n + c + 64 listed hashes from a peer, then strike and end), `:138` maxSessionBacklog 8192 queued or wanted per session (a cut window is listed again by the next session) | `chain-review-round.test.mjs:327` |
| MP-2 (major) | fixed | `gossip.js:139` syncStartGapMs, `:1540` (one session start per peer per 2 s), `:1033` (a fresh root does not end a session younger than that) | `chain-review-round.test.mjs:355` |
| MP-6 (major) | fixed | `node.js:1123` (_unpaidParent), `:1716`, `:1876` (an exempt parent below the fee, not by a vetted author, that would itself wait for parents is refused E_POLICY, not remembered): one paid orphan carries at most its own (up to 8) free parents | `chain-review-round.test.mjs:396`; `chain-net-node.test.mjs` cap test (no zero-fee block hangs below the paid one) |
| STALK-8 (major) | fixed | `gossip.js:574` (each peer gets the ANN after its own random delay: 0.5 to 3 s for a local block, the head-carrying HELLO after the longest; up to 1 s for a relay), `:140`, `:191`; `node.js:1595` (local flag), `:751` (seedable random); `multi.js` tick: the lane ANN of a held ledger's new head waits 0.5 to 3 s | `chain-review-round.test.mjs:428`; timing-exact tests use `NO_JITTER` (`chain-net-helpers.mjs`) |
| SCALE-8 (major) | fixed | `node.js:168` (maxLifetimeBlocks = MAX_LEDGER_BLOCKS - 64), `:1114` (_lifetimeFull), checks in _precheck, _place, _wouldPlace and _writeNow (E_CAP for every author, vetted ones included) | `chain-review-round.test.mjs:457` |
| STALK-3 (blocker) | partial | `multi.js:400` (follow(id, { private: true })), `:377` (holdings), `:883` (no HAVE after a pull), `:1069` (three same-shape decoy RECENTs from the peer's HAVE list), `:1085` (a peer with too few other ledgers is not asked), `:782` (decoy answers dropped) | `chain-review-round.test.mjs:502`. The callers do not pass `private` yet, and a viewed page is still HAVE'd in full (Requests 3, 4) |
| DS-3 (major) | fixed | `multi.js:78` (refresh every 30 minutes), `:1062` (a refresh asks for the newest 20 posts); ANN keeps windows current; phones go idle sooner (_idle) | `chain-review-round.test.mjs:536` |
| SCALE-11 (major) | partial | `multi.js:723` (one answer per ledger per wire per minute unless the ledger's root moved), `:739` (S once per wire) | `chain-review-round.test.mjs:536`; `hub-lane-multi.test.mjs` flood test runs the rate rule alone. Charging lane egress to the metered seed budget is loader work (Request 5) |
| DS-2 (major; verifier 2: minor) | partial | `tools/ledger-admin.mjs:1049` (checkpoint prints the snapshot and cs= upload step, and says copies prune at once) | none new. mw_chain1 has no frame for S; adding one is a wire change for the integrator (Request 6) |
| MP-11 (minor) | fixed | `gossip.js:1043` (one peer's HELLO heads hold at most 256 wants) | `chain-review-round.test.mjs:376` |
| MAL53-13 (minor) | fixed | `state.js:319` (ws: https, public host, no IP literal in a private, loopback, link-local or shared range, no IPv6 literal, no localhost or .local) | `chain-review-round.test.mjs:562` |
| DS-10 (minor) | rejected: minor, deferred | the defect is in `src/chain/recent.js:329`, which this brief may not touch | Request 7 |
| MP-12 (minor) | rejected: minor, deferred | `gossip.js:461` refuses the fifth wire of a group and `wire-ext.js` hands it to ignoreWire; `test/unit/harden-chain-hello.test.mjs:208` and `:278` (not this brief's) pin that behaviour | Request 8 |
| SCALE-4 (minor; verifiers: minor, documented gap OPERATIONS.md, ROADMAP.md:64) | rejected: minor, deferred | a per-author share was tried and removed: at max(64 KiB, pool / 16) it refused honest single-author histories in `chain-net-scale.test.mjs:51` and `harden-chain-hello.test.mjs:115`; the share is an owner decision (ROADMAP "per-author byte quota") | none |
| SYB-19 (minor) | rejected: minor, deferred | same mechanism as SCALE-4 on ownerless ledgers (`node.js` _vetted returns true when `_genesisOwner === null`) | none |

Format changes (format defects, so vectors were added, none changed): the optional `nsig` of a self rotation
(validity: 'op' when malformed, 'sig' when it does not verify; blk-023 to blk-025) and the `n: 1` mark of a linked self
rotation in the checkpoint state S. State rules changed (unreleased freeze group): HUB-1/SYB-1 linking, HUB-7/SYB-4
write right, HUB-4 appointment in the causal past and the covered floor, SYB-2 epoch totals, HUB-6 reserved entries
(lg-026 to lg-029). `freeze-schema.test.mjs` compares v1 ops with the frozen v0.2.1 reducer: its generator now keeps the
genesis moderator set, because a moderator appointed concurrently with its actions is a deliberate difference (HUB-4).

## Suites run

- `node --test` over chain-*, freeze-*, hub-*, harden-chain-*, tools-v03-ledger, tools-ledger, formats-vectors: 327
  pass, 0 fail, 10 todo (the todo cases of `hub-moderator-gaps.test.mjs`, which all pass now: Request 1).
- `npm test` (lint floor clean over 147 files): at 04:31 EDT 2,219 of 2,259 passed, the failures in calls-*, call-ui,
  strings-c2, repo-layout, tools-install-scripts, tools-review-requests and one integration-v03-reconcile case, all
  outside this area (calls-service and integration-v03-reconcile pass alone four times out of four). At 04:57 EDT the
  run stopped at the 300 s limit inside `chat-lane-routing.test.mjs` (SEC-7, the chat area, edited in parallel); every
  other non-browser unit file at 05:00 EDT: 2,227 pass, failures only in repo-layout, tools-install-scripts and
  tools-review-requests (other areas).
- e2e, every request on 127.0.0.1: `--only 1,2,4,E-SO-1,E-SO-2,E-SO-11` 6 of 6; `--only E-SO-1,E-SO-2` passed; `--only
  1,2,3,4,E-HD-1,E-SO-1,E-SO-2,E-SO-11` 7 of 8; `--only 1,2,4,E-HD-1,E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-8` 5 of 9. The only
  failing step is E-SO-2 "ADA's post reaches BO's timeline" (45 s), with E-SO-3, E-SO-4 and E-SO-8 failing after it on
  its closed pages. That step fails the same way on a scratch copy of the tree whose chain files are those of commit
  3287fbb (before this work): 1 of 2 runs, so it is an existing intermittent failure, not this change. E-SO-6, E-SO-7 and
  E-SO-9 fail on that copy too.

## Requests

1. Integrator, `test/unit/hub-moderator-gaps.test.mjs:62`, `:105`, `:122`, `:177`, `:190`, `:207`, `:249`, `:286`,
   `:335`, `:366`: delete the `{ todo: '...' }` argument of each case (old text e.g. `test('HUB-1: ...', { todo: 'HUB-1:
   rotation needs the target\'s consent (src/chain/state.js:909)' }, async () => {`, new text `test('HUB-1: ...', async
   () => {`). All ten pass on this tree (`node --test --test-reporter=tap test/unit/hub-moderator-gaps.test.mjs`: ok 1 to
   13).
2. Loader (HUB-5), `src/loader/api.js:992` writeRotation: return a reason instead of null: `{ ok: false, reason:
   'commitment-not-yours' }` when `st.keyinfo.get(n.from).rc !== b64url(sha256(utf8(n.rp)))`, `'no-keyinfo'` when it is
   missing, `'refused'` on a write error; and at bind time (`src/loader/api.js:969` nodeIdentityOf callers, app.js
   bindKeys and dropin/engine.js) compare the ledger's `keyinfo.rc` for the key with the bundle's rc and show the
   "This site set a recovery commitment that is not yours" card on a mismatch. Test: loader-review-v03.test.mjs, a
   node whose ledger holds another rc: no sign-in, the card, writeRotation reason 'commitment-not-yours'.
3. Loader (STALK-3), `src/loader/personal-site.js:348`: old `try { deps.multi.follow(ledger) } catch (err) {`, new `try
   { deps.multi.follow(ledger, { private: record && record.pub === false }) } catch (err) {` (or the record field that
   marks a private follow), and the same for `examples/social/js/data.js:356` (the follow before the `pub` branch).
4. Loader (STALK-3), `src/loader/app.js` joinHubLane `A.multi.hold(A.ledgerId)`: hold in full (HAVE full) only the
   member's own page; a page merely viewed should be followed, not held, so its id is not broadcast. Add a PRIVACY.md
   row and the Settings sentence the finding gives.
5. Loader (SCALE-11), torrent.js lane meters: charge mw_chain2 egress (MultiGossip `_transmit`) to the H lane of the
   seed budget with the metered row's 128 KiB/s and session cap; mw_chain1 too.
6. Integrator (DS-2): either a mw_chain1 frame that carries `{ checkpoint block, S }` when a HELLO shows c > 0 and WANTs
   hit covered hashes (the receiver has `applyCheckpoint(S, { block })` with the anchor check), or a prune delay in
   `node.js` _autoCheckpoint (`config.pruneDelayMs`, for example 72 h from first sight) with
   `chain-v03-review.test.mjs` and `harden-chain-prune.test.mjs` updated; and docs/OPERATIONS.md: republish cs= after
   every checkpoint.
7. Recent lane owner (DS-10), `src/chain/recent.js:329`: old `if (truncated) this._truncated = true;`, new
   `this._truncated = truncated === true;` (the newest answer decides; a full window from another peer clears it). Test:
   `RecentView.add([], { truncated: true })`, then a full untruncated window: `state().controlExact` is true and a
   no-standing block is refused with `strike: true`. Also (HUB-7 defence in depth) `recent.js:129`-`136`
   windowFromDag: put control blocks that are not in `state.effective` after the effective ones so truncation cuts them
   first.
8. Integrator (MP-12), `src/chain/wire-ext.js` `_ignored`: for reason 'group-cap' only set `link.dropped` and do not call
   `hooks.ignoreWire` (the content wire stays); `src/chain/gossip.js:461` attach: evict the oldest same-group peer that
   has delivered nothing instead of refusing the newcomer; update `harden-chain-hello.test.mjs:208` and `:278`.
9. Docs: `docs/OPERATIONS.md:905` and the rows at `:730`-`:733`: a moderator ban and a moderator bulk tombstone now keep
   values for the 24 h grace like a single tombstone (voided, removal or an unban inside it restores them; an owner ban
   does not wait); the hourly and daily caps bound live admission and, per checkpoint epoch, 24 hours and 7 days of
   actions whatever times they claim; a moderator acts only after its appointment. `docs/SECURITY-MODEL.md:303`: add the
   per-epoch totals. `docs/THREAT-MODEL.md` STALK A3 rows: the announcement jitter now exists for blocks (gossip.js and
   the lane ANN). The rotate row of R 2.5.3 and ARCHITECTURE 15.4: `nsig` (next's consent) for a self rotation, and the
   write right. `docs/CRUD.md` and the ledger-admin help: `rotate --by self --next-key`.
10. Tools test owner, `test/unit/tools-v03-ledger.test.mjs:246`: add the consensual form (`rotateOp({ by: 'self', from,
    next, ledgerId, nextKey })` carries nsig; `state.keychange` then holds next too); the existing case stays valid (a
    self rotation without nsig retires the old key).
11. Integrator: E-SO-2's step "ADA's post reaches BO's timeline over the hub follow lane" fails intermittently with or
    without this brief's chain changes (above); `window.__mwShell.inspect().hubLane` of both tabs at that step would
    show whether BO's lane never saw a HAVE for ADA's ledger or got an empty window.
