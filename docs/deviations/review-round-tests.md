# Review round, tests fixer (finding HUB-12)

First written 2026-10-23 20:30 EDT, finished 2026-10-24 04:06 EDT (America/Toronto). Brief: the "tests" area of the review
round. No serious findings were assigned to it. The one minor finding was HUB-12
(`.orchestration/reports/all-findings-2026-10-22.json`; the verdicts file has no record for it).

Files: `test/unit/hub-moderator-gaps.test.mjs` (new) and this note. No file under `src/` or `tools/` was edited, and no
shared file was touched.

## Findings

| Finding | Status | Files | Test |
| --- | --- | --- | --- |
| HUB-12 (minor): the moderator-cap test builds every moderator block on the head (`test/unit/chain-v03-review.test.mjs:130`-`171`) | partial | `test/unit/hub-moderator-gaps.test.mjs` | `node tools/run-unit.mjs hub-moderator-gaps.test.mjs`: 3 pass, 10 todo, 0 fail |

### HUB-12: what was done

The finding asks for the regression tests named in HUB-1, HUB-2, HUB-4, HUB-6 and HUB-7, and for each one to fail on the
current tree. Those five are live chain defects that belong to the chain fixer, and none of them is fixed yet (`src/chain/state.js`
and `src/chain/node.js` are unchanged since 2026-10-20 23:58 EDT). Adding them as plain failing tests would turn `npm test`
red for every fixer running at the same time and for the checkpoint loop. So each one is a node:test `todo` case. A failing
todo is reported as `# TODO` with its assertion and does not fail the run. Every case drives the real ChainNode with signed
blocks and the simulator's clock, in the shapes the head-built test cannot reach:

| Line | Case | Shape | Today |
| --- | --- | --- | --- |
| `test/unit/hub-moderator-gaps.test.mjs:48` | HUB-1 control | self rotation with no ban in play | pass |
| `:62` | HUB-1 (todo) | banned key A signs rotate A->V and V signs nothing; V keeps role `writer`, its 3 posts and values, `rotations.has(A)` is false, V's next write is accepted | fails: the victim's role is `reader` |
| `:105` | HUB-2 (todo) | moderator ban, live: value held after 1 h of sim clock, owner `voided` shows the post again | fails: held 5 of 6 |
| `:122` | HUB-2 (todo) | moderator bulk tombstone (`authors`, `before`): values held after 1 h, in `graceList()`, void restores them | fails: held 0 of 5 |
| `:166` | HUB-4 control | 12 moderator bans forked from the genesis, all claiming one hour, delivered with `ingest(..., 'sync')`: at most `modActionsPerHour` (2) | pass |
| `:177` | HUB-2 cap (todo) | the same 12 bans: only the authors banned in the final state lose their posts | fails: 6 hidden with 2 banned |
| `:190` | HUB-4 (todo) | 12 forked bans claiming 12 past hours before a 1 h old appointment, as history: at most 2 x 2 in effect | fails: `banned: 12` |
| `:207` | HUB-4 gossip (todo, probe p1c) | a linear chain of 12 backdated bans forked from the genesis, ended by a tip claiming now that joins the head, fetched by a real sync over `sim.link`: at most 4 banned, at least 8 posts visible | fails: `banned: 12` |
| `:249` | HUB-4 checkpoint (todo, probe p13) | owner checkpoint, every post pruned (asserted), then 10 bans built on covered posts claiming hours 400 days before the ledger: at most 1 x 2 banned | fails: `banned: 10` |
| `:286` | HUB-4 allow (todo, probe p2) | allow ledger, `modAllowPerDay: 2` granted 1 h ago, 10 forked allow blocks of 2 keys claiming 10 past days, as history: `allowCount` and the keys with role `writer` at most 4 | fails: `allowCount: 20` |
| `:324` | HUB-6 control | the owner's `_deny/...` entry and `_mw.cfg` are in effect | pass |
| `:335` | HUB-6 (todo) | moderator `put _deny/x null` and `put _mw.cfg` (live): the takedown and the owner's cfg stand, and the owner can still replace cfg | fails: the takedown is lifted |
| `:366` | HUB-7 (todo) | a stranger's `rotate` on an owner-only ledger and on an allow ledger it is not a member of: `E_POLICY`, not stored | fails: admitted |

The control cases gate today. They pin behaviour that holds now and that the fixes must keep. The bounds in the HUB-4 cases
are the ones the finding's test names: effects at most cap x clock hours (or days) since the appointment block, whatever
the delivery (sync, Sim gossip, after a checkpoint).

The second pass (2026-10-24) closed what the first note left open: the probes p1c, p13 and p2 are now the cases at lines 207,
249 and 286 (the probe scripts were gone, so they were rebuilt from the finding's evidence and run on the tree first: 12, 10
and 20 effects, matching the finding). The run of the file was stable over 3 runs (3 pass, 10 todo, every todo failing with
the numbers above).

Why partial and not fixed: the finding's own test says "npm test must fail on the current tree for each". These cases fail
visibly but do not gate until the chain fixer removes the `todo` option of each case as its fix lands (Requests 1). One
shape is still not covered: the HUB-7 window budget (`hub-lane-recent.test.mjs`, a window over 5,000 ineffective control
blocks keeps the owner's control blocks). Which control blocks count as ineffective, and whether they are refused at
admission or only cut from the window, is the HUB-7 fix's design (its fix lists both), so the case belongs with that fix.

## Suites run

- `node tools/run-unit.mjs hub-moderator-gaps.test.mjs`: exit 0 (3 pass, 10 todo), stable over 3 runs (04:03 EDT).
- `npm test` at 04:05 EDT: lint floor clean (147 files). Unit: 2097 tests, 2069 pass, 10 todo (this file), 18 fail. None of
  the 18 comes from this change (Requests 2 to 4): `repo-layout.test.mjs:31` (1), `files-validate.test.mjs:118` (1),
  `files-c2-handoff.test.mjs` (9 cases and 2 suites) and `media-service.test.mjs` (5).
- No end-to-end scenario touches these files, so no `--only` run was needed.

## Requests

1. Chain fixer (HUB-1, HUB-2, HUB-4, HUB-6, HUB-7): when a fix lands, delete the `{ todo: '...' }` argument of the matching
   case in `test/unit/hub-moderator-gaps.test.mjs` (HUB-1 line 62; HUB-2 lines 105, 122, 177; HUB-4 lines 190, 207, 249,
   286; HUB-6 line 335; HUB-7 line 366). Old text, for example at line 62:
   `test('HUB-1: ...', { todo: 'HUB-1: rotation needs the target\'s consent (src/chain/state.js:909)' }, async () => {`;
   new text: `test('HUB-1: ...', async () => {`. If a fix refuses a block at admission, not only in the state rule, the
   assertions still hold, because they check the node's state and do not assume the block was admitted. The one exception
   is HUB-7 at line 366, which expects `rejected: [{ h, reason: 'E_POLICY' }]` from `ingest(..., { live: true })`. If the
   HUB-4 fix makes a fork from before the appointment inadmissible at sync, the case at line 207 still holds (it waits at
   most 20 s of sim clock for the tip and then checks state). The HUB-7 window case named in the finding goes into
   `hub-lane-recent.test.mjs` with that fix.
2. Integrator, `test/unit/repo-layout.test.mjs:36`: fails on `SECURITY-KEY.asc` (746 bytes, a PGP public key block, created
   2026-10-23 19:54 EDT, now tracked since checkpoint a73267a). `E_BANNED` from the first note is deleted (staged `D`). No
   document names `SECURITY-KEY.asc` (`git grep` finds only this note); `docs/PUBLISH-CHECKLIST.md:113` publishes the security
   key at `$SECURITY_KEY_URL`, not as a top-level file. Either the lane that made it moves it (for example under `docs/`) or
   removes it, or, if it stays at the top level, `repo-layout.test.mjs:20` gains it: old text
   `'README.md', 'LICENSE', 'SECURITY.md',`, new text `'README.md', 'LICENSE', 'SECURITY.md', 'SECURITY-KEY.asc',`. The
   tests fixer did not make that edit because whether the key belongs in the release is not a test question.
3. Media or files fixer, `test/unit/files-validate.test.mjs:118` (U-FI-3): `imageSize(GIF(300, 200), 'image/gif')` returns
   `null` since `src/files/preview.js` changed (2026-10-23 20:28 EDT, `gifSize`: the first-frame extent). The fixture GIF has
   no image descriptor. Either `gifSize` falls back to the logical screen when no frame follows, or the fixture gains a
   first-frame descriptor; the lane that changed `preview.js` chooses.
4. Media or files fixer: `test/unit/media-service.test.mjs` (5 cases, first at line 594) and `test/unit/files-c2-handoff.test.mjs`
   fail with `TypeError: this._keepPublic is not a function` (`src/files/lane.js:433`) and `this._watch is not a function`.
   This is the half-finished change the brief names; not touched here.
