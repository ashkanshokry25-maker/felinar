# freeze lane notes (F1: ledger freeze group; src/chain/block.js, state.js, dag.js)

Status: v0.3 freeze group implemented as R 1.5 N-4, R 2.5.3, R 2.10.1, R 2.10.2 and ARCHITECTURE
15.4, with the items below decided where the review left them open. Validity stays a function
of `e` (and `v` against `vh`) only (R 2.1 rule 4): the only new validity checks are shapes and
the rotate `rsig`, a signature over fields of `e`.

## Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test test/unit/freeze-ops.test.mjs test/unit/freeze-state.test.mjs \
      test/unit/freeze-checkpoint.test.mjs test/unit/freeze-schema.test.mjs \
      test/unit/chain-core-block.test.mjs test/unit/chain-core-state.test.mjs test/unit/chain-core-dag.test.mjs
    node tools/lint-floor.mjs

82 tests, 0 failures; lint-floor clean over src/. Also run, unchanged and passing: chain-net-node,
chain-net-sync, chain-net-stores, chain-net-scale, chain-net-protocol, tools-ledger,
v021-integration, chain-core-browser (68 pass, 1 skipped). formats-vectors fails today for
reasons outside this lane (media.json is not in FILES; ptr-010 no longer verifies); its block
vector test passes with the new vectors.

## Contract additions (INTERFACES "src/chain/block.js and state.js (freeze group, 15.4)")

Proposed replacement text for that section, marked v0.3 (this lane writes only its own files,
so the integrator or the docs owner pastes it):

```
src/chain/block.js and state.js (freeze group, 15.4)  [v0.3]
block.js
  CONTROL_OPS = ['policy','owner','tombstone','ban','allow','unban','keyinfo','rotate','checkpoint']; FUTURE_CONTROL_OPS = ['vanish','grp']
  POLICY_FIELDS = [...v1, 'modAllowPerDay','modActionsPerHour','reservedPool','voided']; FREEZE_POLICY_DEFAULTS = { 20, 60, 25, [] }
  FREEZE_LIMITS = { maxCheckpointHeads: 32, maxBulkAuthors: 64, maxVoided: 50, maxReservedPool: 50, maxModAllowPerDay: 1000, maxModActionsPerHour: 100000 }
  ROTATE_PREFIX = 'mw-rotate-v1\n'; export function rotateSigningInput(ledgerId, from, next) -> string
  validateBlock: 'op' for a malformed new op, 'limit' over a cap, 'sig' for a bad rotate rsig, 'unknown-op' for vanish, grp
                 and the v0.2.1 checkpoint placeholder (no heads)
  DEFAULT_POLICY is unchanged (v1 fields only)
state.js
  reduce() handles the new ops and state rules; State adds keyinfo, rotations, keychange, checkpoint, modTombstoned,
    ownerWritten, profileMeta, policy.{ banUntil, modAllowPerDay, modActionsPerHour, reservedPool, voided }
  export function reduceFromCheckpoint(S, blocksAfter, opts) -> State        // throws E_SNAP when S does not verify
  export function checkpointFor(dag, heads, opts) -> { S, snap, n, bytes, heads }   // what the owner signs
  export function schemaOk(listOrKey, value, kind?) -> boolean    // hides non-matching mw.* items; never affects validity
  export function authorScope(pub) -> '@' + 16 chars + '/'; isScopedKey(k); checkpointSnap(S); decodeCovered(str)
  snapshot() adds keychange, checkpoint and the new policy fields
dag.js
  dag.pruneTo(checkpointBlock, S) -> { dropped }; export function pruneTo(dag, checkpointBlock, S) (same)
  dag.isCovered(h), dag.coveredCount, dag.checkpointBase() -> { h, snap, S } | null
  add(): a prev naming a covered hash counts as held; a covered hash is 'duplicate'
```

`pruneTo` is a Dag method (the contract line had no dag argument); the exported function takes
the dag first.

## Decisions (where the review left a detail open)

1. **The v0.2.1 checkpoint placeholder stays unknown-op.** Locked vector blk-007 and
   chain-net-node expect `{ t: 'checkpoint', n, root }` to be `unknown-op`. A checkpoint op
   without `heads` is therefore the undefined reserved form (`unknown-op`); with `heads` it must
   be exactly `{ t, heads, snap, n, bytes }` or it is `op`.
2. **checkpoint fields.** `n` = the number of covered hashes (cumulative over earlier
   checkpoints); `bytes` = byteLength(canonical(S)) (chosen: lets a peer size the cs= fetch);
   `heads` sorted and unique; every head must be in the checkpoint block's causal past or already
   covered, at least one not yet covered.
3. **S format.** `state` holds: owner.keys, the folded policy, kv / lists / profiles items as
   `{ v | name, author, h, ts, o?: 1 }` (o: written with owner standing), unlifted bans
   `{ h, author, owner, until? }`, pending tombstone targets (strong and moderator-only, targets
   not covered), keyinfo, winning rotations and authors, all as sorted arrays.
4. **What a checkpoint settles (both reducers follow it, so full and pruned copies agree).**
   Every covered block counts as in the causal past of every uncovered block; uncovered blocks
   are ordered by (relative depth, h), relative depth 0 when all parents are covered; moderator
   day and hour counts restart; covered control effects stand (a later `voided` reaches only
   uncovered blocks); later bans, tombstones and bulk tombstones still hide covered items, and a
   hidden covered `put` winner does not bring back an older value. A checkpoint is ignored while
   its covered set has an ownerConflict. reduce(full DAG) equals reduce(pruned copy) and
   reduceFromCheckpoint(S, later blocks) on random DAGs with every op (unit-tested).
5. **unban.** An unban lifts the bans of that author in its causal past, for blocks in its
   causal future: the owner lifts any, a moderator only moderator bans (so an owner ban stands
   until the owner lifts it). Blocks hidden before the unban stay hidden.
6. **ban.until.** banUntil per author is the longest unlifted ban (Infinity when permanent);
   `policy.banned` keeps every author with an unlifted ban, timed ones included (roleOf unchanged).
7. **keyinfo write right** counts allow membership inherited through settled and self rotations
   (not recover ones, which depend on keyinfo), and the governing PoW for non-privileged keys.
   Bans never remove a keyinfo.
8. **rotate.** Self: signed by from, PoW for non-privileged keys. Recover: signed by next, rp must
   hash (sha256 of utf8 of the tagged key, b64url) to from's winning keyinfo.rc. First self in
   total order wins among selfs. Inheritance is transitive over chains of rotations. A key's
   author-scoped '@' keys do not move to next.
9. **voided** comes from the policy fold at the heads, never applies to blocks with owner
   standing, and covers every control op of that author (ban, unban, tombstone, bulk, moderator
   allow, keyinfo, rotate). An `after` the reducer does not hold voids all of that author's blocks.
   One entry per author.
10. **Moderator allow.** A moderator allow block with a non-empty `remove` has no effect (admit
    refuses it with E_NOT_OWNER); additions count per moderator per UTC day of the claimed ts in
    total order, and a block that crosses the cap keeps its first additions.
11. **Moderator hour cap** counts ban, unban, single and bulk tombstones that would take effect; a
    moderator tombstoning its own entry is an author tombstone and is not counted.
12. **Bulk tombstone** needs `before` in its own causal past (or covered); the block `before`
    itself is hidden (strict future).
13. **Schemas** (schemaOk): mw.s needs ct of exactly 1,040 bytes (1,024-byte plaintext plus the
    tag), iv 12 bytes, hint 4 bytes; mw.files, mw.ck (shape only, no signature check), mw.link,
    _mw.cfg (the 2.5.5 keys, unknown keys refused), _deny/<43 b64url>, _roles/<22 b64url>.
    Exact keys everywhere. A put of null is always schema-valid. Other names have no schema.
14. **Items keep the v0.2.1 shape** `{ h, author, ts, v }`; owner standing lives in
    `state.ownerWritten`.

## Measured

- maxBlockBytes bounds the caps before the op limits do: a bulk tombstone fits at most 39 tagged
  keys and a policy at most 20 voided entries in 4,096 bytes (measured with a 32-character site
  id). The 64 and 50 caps are still checked ('limit' at 65 and 51).
- reduce of the 5,000-block chain-core-state ledger: median 1.7 ms on this laptop (the test's
  own measurement, Node 24).

## Vectors (integrator: append to test/vectors/LOCK.json; add 'ledger.json' to FILES in formats-vectors)

block.json gained blk-009 to blk-022 (new ids only, existing vectors untouched). ledger.json is
new: 20 DAG-level vectors, real signed blocks, one or more per state rule; freeze-state.test.mjs
checks them (any arrival order, and from S for the checkpoint vector).

    {"file":"block.json","id":"blk-009-unban","sha256":"f58ead217d0e7063cd4ebb0dfb61ce4923f153ca795c2ab9c077768a3e06406f"}
    {"file":"block.json","id":"blk-010-ban-until","sha256":"34118d7f9b7eb6d7767a71fb2f3bf3703d99cef3f60d3fd906ecdfa10c6e1752"}
    {"file":"block.json","id":"blk-011-keyinfo","sha256":"9666d53eeda8290bc682ccc9118efe6b47b4436015a413782b25235e4420efb7"}
    {"file":"block.json","id":"blk-012-rotate-self","sha256":"071747d4e9c8d623b448acc35a3489ff6b49c3047fd1bb45b8cbda8cea66aaf9"}
    {"file":"block.json","id":"blk-013-rotate-recover","sha256":"959cc9df848a825b5fc841cc9eeb64c6133b899c99f96bf5fbf854607cf84b81"}
    {"file":"block.json","id":"blk-014-rotate-recover-wrong-rsig","sha256":"7f4f0f61824e86427bca349b3fd2e453dc91e3a780457300ec2e13e404af9693"}
    {"file":"block.json","id":"blk-015-checkpoint","sha256":"92a2eccb58b1ba28bddabfbf2bee766c900a44a73fc2e870f22c1a31efad61e9"}
    {"file":"block.json","id":"blk-016-checkpoint-33-heads","sha256":"cd80d40b845009425fed8f8cbcd57edfc745f712e64765baaa91f93fdb391722"}
    {"file":"block.json","id":"blk-017-bulk-tombstone","sha256":"f8a4ba72c4eb2b5f848e79c9d7d8a1a62d9dd57e11e1c014aaf63df9862795c1"}
    {"file":"block.json","id":"blk-018-bulk-tombstone-65-authors","sha256":"1cb508cae11e09b375c5eb46629dddbbbc5c919d9d4e3d261fc262a766479827"}
    {"file":"block.json","id":"blk-019-policy-freeze-fields","sha256":"a88b3cc693e6d38ca5ee27efa5640eefb9257aafcd3db950fad6fa487598278b"}
    {"file":"block.json","id":"blk-020-vanish","sha256":"84832e23f7eee20c5de46e599c2b72fdc487570498234fd1685ee6add4097911"}
    {"file":"block.json","id":"blk-021-grp","sha256":"6aa85bbd0fa9d46e01e1c8c4c8df9bdda8ec2cdb354fb2658b76109ada41db5f"}
    {"file":"block.json","id":"blk-022-rotate-self-wrong-author","sha256":"63e0824e6d29fcc810078de4f814df59500aeaf937ea0f56555df92dce10d6ef"}
    {"file":"ledger.json","id":"lg-001-moderator-unban-lifts-moderator-ban","sha256":"bbd56a60c23aa625d26be03e1bc62cd8934660e088824e20b3dd5cfcb2be54b6"}
    {"file":"ledger.json","id":"lg-002-moderator-cannot-lift-owner-ban","sha256":"ac7e7f730bf489102c865921c56e921764777742183d8799715b497b192138f3"}
    {"file":"ledger.json","id":"lg-003-owner-unban","sha256":"efdfde9249d43dcce13c4d69ca04cb27d84f20df352a9dd256bed8adaafedd24"}
    {"file":"ledger.json","id":"lg-004-ban-until","sha256":"78314a92a37e6a05809dc41ce6bbf883030edb2b96cf251202f70b4a06abaed8"}
    {"file":"ledger.json","id":"lg-005-keyinfo-first-wins","sha256":"b5dcf14ec7b0aa50525ee55c3d007c30325b9c2c4166ae1c6714f9648c4ab599"}
    {"file":"ledger.json","id":"lg-006-recover-beats-self-after","sha256":"513f9027625168dcbb3d524dbdc2227e2b8fbe9a5bdd5f6c90ad87f2e9dd2bbd"}
    {"file":"ledger.json","id":"lg-007-recover-beats-self-before","sha256":"2c5bc06077c389772376deba8d83864f4f7b85aa257b1a26a1dccb2c4e6b0154"}
    {"file":"ledger.json","id":"lg-008-lowest-recover-wins","sha256":"e38335e401dfb915572b19f9eb967166f891070aff6967e26e080bce9c236322"}
    {"file":"ledger.json","id":"lg-009-recover-needs-keyinfo","sha256":"0238e3f900e38b0487974739a92e0958618b83079ab9bceec5557b54af4c5ae2"}
    {"file":"ledger.json","id":"lg-010-next-inherits-allow-not-moderator","sha256":"4e267138d843532a8ba66c3eb79181c1e566fe6a64c4ccbaef063532d9ac503d"}
    {"file":"ledger.json","id":"lg-011-next-inherits-bans","sha256":"2cb15cf3865b388f399bef7dd5b739082b2a8ac48c7a031165fc2628c238c706"}
    {"file":"ledger.json","id":"lg-012-voided","sha256":"9bd0d1c234c3063b656a2cb6548c4785b19a5865fd7855633545f394b8a01c6c"}
    {"file":"ledger.json","id":"lg-013-owner-protected-payload","sha256":"f13d676994d18a8e4332ae126de6a50529b6dd9d55a2869d30691c2ed84a3d05"}
    {"file":"ledger.json","id":"lg-014-author-scoped-keys","sha256":"a27dbc6ea120b3fd15ae7723c6fc5ef8b6b8149bea2ed4f5f8a869dadf1696b8"}
    {"file":"ledger.json","id":"lg-015-bulk-tombstone","sha256":"8cd0c23cc06623b4c72bd5e28007a706e02aa502a3f813831060a9e9ef0ba7c9"}
    {"file":"ledger.json","id":"lg-016-moderator-allow-day-cap","sha256":"6bb88b35874b8894e74de6d76d96f2a18860b473db557baf5511d2e4f50beb9c"}
    {"file":"ledger.json","id":"lg-017-moderator-allow-next-day","sha256":"b7575cb2aa6db24e8fe9313d968057aaf1015c5f958fd9d890d26f502d15f410"}
    {"file":"ledger.json","id":"lg-018-moderator-actions-hour-cap","sha256":"6f5df2a11d71808c52439455a82f4a41d0cf734c740fd0eece74bb130c36bc8b"}
    {"file":"ledger.json","id":"lg-019-schema-hides-non-matching-items","sha256":"96912e4ade02014f8c5cf39805d24a84b111659a091935bc694826480499021c"}
    {"file":"ledger.json","id":"lg-020-checkpoint","sha256":"19bfd2f371f28d7b25c8b8db1b3955244da1e5916ba8e87b305e60180c6e550c"}

## Requests to other lanes

- **chain-net (node.js, stores.js):** prune with dag.pruneTo only to the checkpoint in
  `state.checkpoint` (in effect), persist S and the covered set, serve S by snap (cs=); a
  covered hash is never WANTed (dag.missing() excludes it). Reserved-pool admit rule,
  E_LEDGER_FULL and moderator-tombstone grace remain yours; `policy.reservedPool` is in State.
  admit() now refuses: E_POLICY 'scope', 'owner-protected', 'keyinfo-set', 'recover'; moderator
  allow with remove E_NOT_OWNER; unban and bulk tombstone like ban. Moderator caps are state
  rules, not refusals. Note the depth of a block whose covered parent this copy never held is
  the deepest covered depth (windows can differ from a full copy there).
- **tools (ledger-admin):** unban, keyinfo, rotate (rotateSigningInput for rsig) and checkpoint
  (checkpointFor gives { S, snap, n, bytes, heads }); policy fields from POLICY_FIELDS (genesis
  defaults stay DEFAULT_POLICY; freeze fields only when set).
- **SDK / records lanes:** authorScope(pub) for '@' keys; schemaOk for client-side checks; the
  32 sealed items per author rule is still an SDK convention (not in the reducer).
- **docs:** paste the INTERFACES text above and mark ARCHITECTURE 15.4 "v0.3"; 15.4 could add
  decisions 4 and 5.
