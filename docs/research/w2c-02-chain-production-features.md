# w2c-02 - Chain / database production features: snapshots, compaction, queries, encryption, access control, GDPR deletion

**Project:** magnet-web (static loader, magnet-addressed sites, visitor-replicated signed ledger, no backend of ours)
**Research date:** 2026-10-17. Every "current" statement is as of that date.
**Scope:** how the per-site signed Merkle-DAG log should grow up for production: checkpoints / snapshots / compaction, browser query layers, end-to-end encryption for private lists, capability-style access control, GDPR erasure in an append-only replicated log, and the economics of rate limiting and spam on an open-write log.
**Builds on (not repeated here):** `06-browser-chain-vs-crdt.md` (op envelope 3.1.2, owner moderation 3.1.5, Hashcash table F36-F41, OrbitDB F16-F19, Autobase F21, Peerbit F32, SSB F34, Meadowcap F35, WebCrypto matrix F45, Ed25519 speeds F47, RBSR F54); `docs/review/distributed-systems.md` (B2 redactable blocks, B4 window sync, M6 fence, M7 caps, M13 `cs=` snapshot); `docs/review/security.md` (B3 `oph`, M1 budgets, M8 takedown); and the **normative baseline `docs/ARCHITECTURE.md` v0.2 section 6** (edited 2026-10-17 17:17; v0.1 is kept at `docs/review/ARCHITECTURE-v0.1.md`), `docs/INTERFACES.md` and `docs/review/DESIGN-REVIEW.md` items 1-5, S2, S9 and its LATER list. I first read v0.1; the spec was rewritten while I worked, so section 3 is written as amendments to v0.2 and several earlier findings were re-checked against it.

---

## 0. How to read this document

- **Confidence.** `high` = primary source read in this session (or measured here). `medium` = primary source partly read, one source only, or my inference from two or more primary sources (labelled). `low` = search-result snippet only or model knowledge not re-verified (labelled).
- **(star) = design-critical**: if the claim were wrong, an architecture decision or a compatibility promise (wire format, id derivation, reducer semantics, public promises to users) would change.
- **"Measured"** = I ran it on 2026-10-17 on a MacBook Air (Apple M3, 8 cores, macOS 27.0) in headless Playwright Chromium 156.0.8078.4 and the Playwright WebKit build whose UA says `Version/27.2 Safari/605.1.15`. These are **desktop numbers only**. I measured nothing on a phone. Firefox failed to launch under Playwright (profile error) and is not measured. Raw numbers: Appendix A. Reproduction files are in `docs/research/labs/w2c-02-lab/` (Appendix B).
- **Search budget.** The shared WebSearch budget ran out part-way through this run (the tool refused further searches). After that I used only direct fetches of known primary-source URLs and local measurements; I did not work around the limit. Things I wanted and could not verify are listed in section 5 and marked "unverified" where they appear.
- **Source dates.** Living specs (Matrix, Willow, C2SP, UCAN, SQLite) have no single date; I give the version/status line the page showed on 2026-10-17. Older sources are flagged "OLD".
- **Law.** Nothing here is legal advice. Where a GDPR point matters I quote the EDPB text and mark how far the analogy to our design goes.

---

## 1. Summary

1. **(star) Use three compaction tiers, not one.** The systems I read split cleanly into (L0) lossless storage/transfer packing that never changes what history exists (Automerge snapshot+incremental chunks, Yjs `mergeUpdates`, y-indexeddb trimming at 500 updates), (L1) payload removal that keeps a signed, verifiable skeleton (Matrix redaction, Bamboo, Buttwoo, p2panda, Willow payload digests), and (L2) explicit, coordinated lossy history trimming (Loro shallow snapshots, p2panda `PruneFlag`, Willow prefix pruning, Hypercore `truncate` with a new fork id). Build L0+L1 for v1 and reserve L2. (G1, G2, G10, G11)
2. **(star) Redaction by commitment is mainstream; the commitment must be hiding.** Matrix signs the redacted form of an event plus a content hash, so a redacted event still verifies; Bamboo, Buttwoo and p2panda do the same with a payload hash and size. EDPB Guidelines 02/2025 **v2.0 (adopted 07 July 2026)** adds the GDPR constraint: an unsalted or unkeyed hash is not to "be considered sufficient", a salted or keyed hash "will also be considered personal data" until the salt/key is deleted, and a perfectly hiding commitment becomes "useless" once the original data and its witness are deleted. So: sign a **salted** value commitment inside the signed block (ARCH v0.2's `vh`, which is currently unsalted) and delete value and salt together. (G10-G12, R1)
3. **(star) A redaction must be an ordered op whose effect does not depend on whether a given peer still holds the body.** Matrix keeps redacted events in the state computation ("a redacted join event will still result in the user being considered joined"). Otherwise replicas that kept the body and replicas that dropped it compute different views, and `v`-less relays become a body-withholding vector. ARCH v0.2 already behaves this way (a `v`-less block without a tombstone is only a DAG node; it is relayed only with its justifying tombstone); 3.4 lists the remaining gaps. (G10, G11, inference)
4. **(star) CPU is not why we need checkpoints on desktop; durability, tip completeness, storage budget and slow phones are.** Measured: loading 50,000 stored records from IndexedDB takes 150-190 ms. ARCH v0.2 signs with ECDSA P-256, which WebCrypto verifies natively in every supported browser (doc 06 F47: 15.0-15.4k verifications/s on an M3), so the 8 MiB default cap (about 13.6k blocks of 618 B) costs about 0.9 s on an M3 and 2.7-9 s on a phone if phones are 3-10x slower (extrapolation); v0.2 already verifies in a worker pool after first render. The noble-JS fallback problem in doc 06 returns only if Ed25519 is adopted (LATER list). (G8)
5. **Owner checkpoint = an owner block whose `prev` lists every head, plus `n` and `root`.** A Merkle-DAG already commits to a block's whole causal past, so a snapshot is complete exactly when every ancestor of its latest checkpoint is present; the checkpoint adds tip completeness (a host cannot silently drop the newest tombstone or ban), a rollback anchor, and the commitment pruning needs later. Precedent: C2SP `tlog-checkpoint` / `tlog-witness`, Autobase/Hypercore `signedLength`, Ethereum weak-subjectivity checkpoints ("The overall trust required is low"). A block cannot commit to the hash of the file that contains it, so it commits to the block set. Do not make newcomers trust a state hash they cannot recompute. (G5-G7, R7, inference)
6. **Queries: v0.2's in-memory reducer is enough at our caps; keep IndexedDB plain and SQLite optional.** Measured at 50k records: indexed lookups 0.3-9 ms, bulk insert with three indexes 1.0 s (Chromium) / 2.1 s (WebKit), full read 150-190 ms. SQLite WASM 3.53.4 costs 468,637 B gzip (402,035 wasm + 66,602 minified JS), needs COOP/COEP for its `opfs` VFS or accepts a single connection with `opfs-sahpool`. Add a paged `mw.db.list` now, indexes and a header/value split later, SQLite as an optional lazy module (P3). (G17-G20, R5)
7. **(star) Do not promise forward secrecy for private lists.** Keyhive's own write-up: "any kappa > 1 immediately eliminates forward secrecy" and their implementation sets kappa to infinity; NIP-44 states "No forward secrecy" and "No post-compromise security"; EDPB says encryption is "overtaken by time". Ship owner-distributed **epoch keys** (rekey on member removal, protects future content only) with a 16.8 KB-gzip noble box, and a sealed inbox to the owner for PII-bearing submissions. Defer MLS/BeeKEM (RFC 9420 section 14 makes the application resolve conflicting commits; ts-mls "has not undergone a formal security audit"; Keyhive says "DO NOT use this release in production"). (G21-G26)
8. **(star) Capability validity must not depend on wall clocks.** UCAN 1.0.0 uses `exp`/`nbf` seconds with a recommended +-60 s skew buffer, its revocation spec is only v1.0.0-rc.1 and "SHOULD be considered the last line of defense"; Meadowcap has no revocation and uses timestamp ranges; Keyhive notebook 01 says operations can be backdated (my paraphrase). ARCH v0.2's causal rule (`controlFor(B)`, DESIGN-REVIEW item 2: a control block governs every block that is not its ancestor) is the clock-free answer and already covers `allow` removal; keep it and add caveats to grants. (G27-G30)
9. **GDPR posture: keep PII out of the shared log, and make key lifetime the retention policy.** EDPB: clear, encrypted or hashed personal data on a ledger is "not advisable"; public signature verification keys are identifiers and retention applies to the transactions they signed. So: salt `vh`, restricted key names, rounded `ts`, no PII or free text in permanent fields, a sealed inbox with rotating epoch keys for contact-form style data, a visible erasure workflow (`tombstone`, new `vanish`), and an honest notice that erasure binds cooperating peers only. (G12-G16, R1-R3, R12, R16, inference)
10. **Spam: PoW is a fee, not a defence, and the systems that tried it moved on.** The Waku RLN paper says PoW "imposes a high computational cost ... devices with limited resources won't be able to participate"; Waku moved to RLN (on-chain membership, 100 messages per 10 minutes per member). GossipSub v1.1 keeps scoring local and subjective. ATProto labels show the subscribable-moderation pattern. Our arithmetic (G34) shows identity-admission PoW adds only about 8% to an attacker's per-op cost at a 200-op quota. Keep layered controls: owner moderation, byte budgets, quotas, subscribable mute lists. (G31-G35, R11)
11. **Existing-site migration gets a database story:** a `tools/import` that turns a JSON/CSV/SQL dump into owner-signed ops plus a genesis checkpoint, so the first visitor already sees the old data. (R9)
12. **Spec alignment.** ARCH v0.2 already agrees with most of this: payload outside the hash with final tombstones, causal owner policy, `ts` rounding, `cs=` snapshots, owner-bound ledger id. The amendments are: **salt `vh`** (P0, R1), no free text or personal data in permanent fields (P0, R3), fix the erasure semantics (P0, R2), `vanish` and an owner checkpoint block (P1, R16, R7), local mute lists and quotas (P1/P2, R11, R10), encryption (P2, R12, R14). See 3.0-3.2.
13. **Unverified in this run (search budget):** CJEU C-413/23 P (EDPS v SRB), the AEPD erasure PoC note, Matrix moderation policy lists, Megolm, SSB private-box, Kleppmann-style access-control papers, RLN proof-generation time in browsers, real-phone numbers. See section 5.

---

## 2. Findings

IDs are `G1...`; doc 06 uses `F1...`.

### 2.1 Snapshots, compaction and checkpoints

**G1 (star) History handling splits into three tiers across the systems; only the third loses information, and every system that offers it makes it an explicit, coordinated act.** *Confidence: high.*
- **L0, lossless packing.** automerge-repo stores `[docID,"incremental",hash-of-change]` and `[docID,"snapshot",heads-at-compaction]` chunks; "Occasionally automerge-repo will decide that it's time to 'compact' the document", combining incrementals into a snapshot; it "only deletes data which is incorporated into the compacted document", which is why concurrent tabs are safe without transactions. Automerge 3.0 (July 2025) cut memory "over 10x" (Moby Dick paste: 700 MB to 1.3 MB) by keeping the compressed history representation at runtime, and still "stores the full history". Yjs `Y.mergeUpdates` "doesn't garbage-collect deleted content"; "You still need to load the document to a Y.Doc to reduce the document size". y-indexeddb sets `PREFERRED_TRIM_SIZE = 500`: once 500 update rows exist it waits 1000 ms of quiet, writes one full-state row, then deletes older rows in a separate, non-atomic transaction.
- **L1, payload removal with a verifiable skeleton.** See G10, G11 (Matrix, Bamboo, Buttwoo, p2panda, Willow).
- **L2, lossy trimming.** Loro `ExportMode::ShallowSnapshot(frontiers)`: "only contains the history since the target frontiers" and keeps the complete current state; `StateOnly` is "a shallow snapshot with depth=1". p2panda-core 0.7.1 has a `prune` header extension "representing points in a log where all preceding operations can be deleted". Willow prefix pruning: "The entries prefixed by blogidea are deleted by a newer entry at that prefix". Hypercore `truncate` increments the fork id ("Per default this will update the fork id of the core to + 1").
- OrbitDB: its `DATABASES.md` (read 2026-10-17) lists Events, Documents and KeyValue types and says only database heads are synchronised on open, but says nothing about oplog pruning or compaction; doc 06 F16/F18 cover its oplog and the deprecated `ipfs-log`. No compaction precedent comes from there.
- Why it matters: our editors-per-keystroke problem does not exist (a guestbook emits few ops), so L0 compaction inside IndexedDB is nearly irrelevant; the transfer/snapshot form of L0 and the L1 payload GC are what we need.
- Sources: [OrbitDB DATABASES.md](https://raw.githubusercontent.com/orbitdb/orbitdb/main/docs/DATABASES.md), [Automerge storage](https://automerge.org/docs/reference/under-the-hood/storage/) (living doc, read 2026-10-17), [Automerge 3.0 post](https://automerge.org/blog/automerge-3/) (July 2025), [Yjs document updates](https://docs.yjs.dev/api/document-updates) (living), [y-indexeddb source](https://raw.githubusercontent.com/yjs/y-indexeddb/master/src/y-indexeddb.js) (master, read 2026-10-17), [Loro ExportMode](https://docs.rs/loro-internal/1.13.9/loro_internal/encoding/enum.ExportMode.html) (loro-internal 1.13.9), [p2panda-core 0.7.1](https://docs.rs/p2panda-core/latest/p2panda_core/), [Willow data model](https://willowprotocol.org/specs/data-model/index.html) (status "Final", no date), [Hypercore README](https://raw.githubusercontent.com/holepunchto/hypercore/main/README.md).

**G2 (star) Lossy trimming needs a fence: a way to say "ops that do not descend from the trim point are no longer mergeable".** *Confidence: medium-high (three independent mechanisms; the Loro sync limitation is snippet-level only).*
- Merkle-CRDT paper (doc 06 F15): discarding history "should not be attempted before making sure that every replica is aware of them", which needs the replica set or "an external source of truth".
- Hypercore: truncation produces a new fork id, "the fork id should be monotonely incrementing", and `allowFork` is an explicit opt-in on the receiving side.
- Loro: a search-result summary of the shallow-snapshot docs said only nodes holding versions after the trim point can continue syncing and that peers should be coordinated first; the docs.rs page I could read does **not** document import behaviour for a peer lacking the trimmed history. Treat that sentence as unconfirmed.
- Our mapping: DESIGN-REVIEW item 2 chose a causal rule over doc 06's `minEpoch` fence flag: a control block governs every block that is not its ancestor. A pruning checkpoint would reuse that machinery: blocks that are neither ancestors nor descendants of the checkpoint become no-ops. Cost: concurrent writes by offline authors made before they saw the checkpoint are lost; the UI must say so.
- Sources: doc 06 F15 ([arXiv:2004.00107](https://arxiv.org/abs/2004.00107)), [Hypercore README](https://raw.githubusercontent.com/holepunchto/hypercore/main/README.md), [Loro ExportMode](https://docs.rs/loro-internal/1.13.9/loro_internal/encoding/enum.ExportMode.html), Loro docs summary via WebSearch snippet (loro.dev returned HTTP 403 to my fetches).

**G3 Compaction that deletes after a partial read is a real, current bug class (automerge-repo #781, opened 2026-10-05, still open).** *Confidence: high that the report exists and says this; unconfirmed by maintainers.*
- "Partially written chunk silently drops changes on load, and compaction then deletes them": a torn incremental chunk makes `loadIncremental` return only the snapshot without an error, the loaded heads then mark all chunk keys stored, and the next save deletes the valid incrementals too; "the loss is permanent unless a peer still has the changes". Proposed fixes: validate every chunk on load (author estimates 1.2x-2x load cost) or atomic writes. y-indexeddb has the mirror-image weakness: snapshot write and old-row delete are separate IndexedDB transactions (harmless there only because the snapshot is written first).
- Rule for us: ops are content-addressed and signed, so every record can be re-verified; never delete based on a summary (heads, counts); copy, verify, then delete; one IndexedDB transaction per batch.
- Source: [automerge-repo #781](https://github.com/automerge/automerge-repo/issues/781) (read 2026-10-17).

**G4 Sedimentree/Subduction is the closest published design for coordination-free, deterministic compaction of a hash-linked graph, but it is pre-alpha and its design doc is internally inconsistent.** *Confidence: high for what the pages say.*
- README: "fragments are organized by the number of leading zero bytes in their hashes"; "Designed to work with encrypted data partitions". Design doc (Beelay `docs/sedimentree.md`, a proposal): a commit hash read as a number gives the "level" of a chunk boundary by its zeros (the doc mixes leading/trailing zeros and base-10/hex examples); a stratum has start hash, end hash and interior checkpoint hashes; ordering is "a reverse depth first traversal" because "the parents of a commit never change"; a "minimal" tree drops anything supported by lower strata; peers agree on boundaries with no coordination because boundaries depend only on hashes and parent links.
- Status: "This is an early release preview. It has a very unstable API. No guarantees are given." and "DO NOT use for production use cases at this time." An open shipped-data bug (subduction #306, opened 2026-09-21): fragments written by automerge < 3.5 list their own head among their checkpoints, `heads_assuming_minimal` removes it, the newest change disappears from advertised heads and sync cannot repair it (8 of 8 repro runs).
- Take: the idea (boundaries from content hashes, so every peer cuts the same segments) is useful for resumable/partial snapshot download later (P3). Do not implement it in v1. Test lesson (mine): advertised heads after compaction must equal heads before.
- Sources: [subduction README](https://github.com/inkandswitch/subduction) (read 2026-10-17), [sedimentree.md](https://raw.githubusercontent.com/automerge/beelay/main/docs/sedimentree.md) (undated proposal), [subduction #306](https://github.com/inkandswitch/subduction/issues/306).

**G5 (star) There is a standard text format and a witness protocol for exactly the object we want to sign: a size, a root hash and an origin.** *Confidence: high for the specs; the mapping onto a DAG is my inference.*
- C2SP `tlog-checkpoint`: "A checkpoint is a signed note where the body is precisely formatted"; body lines: origin, tree size (ASCII decimal), root hash (base64 RFC 6962 root), optional extension lines ("NOT RECOMMENDED"); signature lines follow a blank line; key id = `SHA-256(name || "\n" || sigtype || pubkey)[:4]`; a signer "MUST NOT sign any checkpoint which is inconsistent with any checkpoint it previously signed". Ed25519 log signatures cover the note text and carry no timestamp. References are `signed-note@v1.1.0`, `tlog-cosignature@v1.1.0`.
- C2SP `tlog-witness`: `POST add-checkpoint` with `old <size>`, up to 63 consistency-proof lines, a blank line and the checkpoint; 409 if `old` is not the size the witness last cosigned, 422 for a bad proof or a different root at equal size; "The witness MUST persist the new checkpoint before responding"; a witness that sees a validly signed but inconsistent checkpoint "MUST NOT cosign" it and "MAY log the request" as misbehaviour evidence; split views are detected only when clients and monitors collect cosignatures from several witnesses.
- Autobase/Hypercore: `signedLength` = blocks "signed by a quorum" (equal to `length` for single-signer cores) is the same idea with the owner as sole indexer (doc 06 F21).
- Gap for us: RFC 6962 consistency proofs need an append-only tree, and a sorted-hash commitment over a DAG is not append-only. But a Merkle-DAG already commits to each block's whole causal past through `prev`, so for the lossless case (no pruning) a checkpoint can be an ordinary owner block that lists all heads (3.3). Two honest options for external witnessing: (a) no witnesses in v1, treat two checkpoint blocks with equal `n` and different `root` as an owner fork or tampering; (b) later, commit to an append-only list of per-checkpoint "segment roots" so a standard consistency proof applies (P3).
- Sources: [tlog-checkpoint](https://c2sp.org/tlog-checkpoint), [tlog-witness](https://c2sp.org/tlog-witness) (both read 2026-10-17, no date shown), doc 06 F21.

**G6 Inclusion proofs for "late parents" are cheap.** *Confidence: high.* Russ Cox: "the proof that a given record is contained in the tree requires lg N hashes"; consistency proofs at most 3 lg N; tiles store only the bottom row of each fixed-height block (height 4: 16 stored hashes instead of 30). For 100,000 ops that is about 17 hashes (about 544 B). Use: after an L2 prune, an op that references a pruned parent id carries a Merkle inclusion proof against the checkpoint's `root` instead of the node holding every pruned id. Source: [Transparent Logs for Skeptical Clients](https://research.swtch.com/tlog) (OLD, about 2019; the fetch showed no date).

**G7 Ethereum's weak-subjectivity checkpoint is the explicit precedent for "trust one social anchor, then verify objectively from there".** *Confidence: high.* "a chain that can progress objectively after some initial seed of information is retrieved socially"; a new or long-offline node needs a recent checkpoint from a trusted source; "The overall trust required is low"; checkpoints come from client software, other full nodes or block explorers and can be cross-checked; the page says blocks before the checkpoint cannot be changed. For us the social anchor is already the owner key in DNS; a checkpoint adds no new trust root, only a new thing the owner can sign. Doc 06 F1 documents the same trust model in Helios. Source: [ethereum.org weak subjectivity](https://ethereum.org/en/developers/docs/consensus-mechanisms/pos/weak-subjectivity/) (living page).

**G8 (star) Cold-start cost is small on desktop at our caps and moderate on phones; it is not a reason to prune history.** *Confidence: medium (measured on M3; phone figures are extrapolations from doc 06).*
- Measured, 50,000 synthetic records of 618 B: `getAll()` from IndexedDB 192 ms (Chromium 156), 150 ms (WebKit). ARCH v0.2 section 6.7 loads all blocks at startup.
- ARCH v0.2 signs blocks with **ECDSA P-256** (section 6.1). Doc 06 F47 (Chromium 155, M3): WebCrypto P-256 verify 15.0-15.4k/s; for comparison WebCrypto Ed25519 34-35k/s and noble JS Ed25519 2.4k/s. "Phones are probably 3-10x slower (extrapolation)."
- At the 8 MiB default cap (DESIGN-REVIEW item 4): about 13.6k blocks, i.e. about 0.9 s of verification on an M3 and 2.7-9 s on a phone if the 3-10x guess holds. v0.2 already renders first and verifies in a worker pool (section 5.5). A 50,000-block ledger is about 3.3 s on an M3.
- P-256 is native in every supported browser, so the doc 06 worry (17-57 s on a phone for 13.6k ops on the noble fallback) applies only if Ed25519 identities are adopted later (LATER list); revisit then.
- Consequence: the checkpoint's value is tip completeness, rollback anchoring and durability (G5, 3.3), not CPU. Build L2 pruning only for storage budget (iOS site caps, review browser-mobile M1), never for verification time.
- Sources: local measurement (Appendix A), doc 06 F47, ARCHITECTURE v0.2 sections 5.5, 6.1, 6.7.

**G9 Local forgetting is still visible to peers: a node that purges a body must stop advertising it.** *Confidence: high for the Hypercore README text; the mapping is my inference.* Hypercore `core.clear(start, [end])` removes blocks "from your local cache", yet "The core will also gossip to peers it is connected to, that is no longer has these blocks" (sic), and `core.snapshot()` is a session "backed by a storage snapshot so will not truncate nor append". Take: our local purge (3.4 gap 4) and any sparse node must drop purged bodies from what they advertise in `HELLO`/`INV` so peers do not wait for them, while headers stay advertised. Source: [Hypercore README](https://raw.githubusercontent.com/holepunchto/hypercore/main/README.md).

### 2.2 Redaction by commitment and GDPR erasure

**G10 (star) Matrix is the production proof that "sign the redacted form plus a content hash" works, including its DAG-connectivity details.** *Confidence: high (two spec pages read).*
- Server-server "Signing events": outgoing events are "hashed, redacted, and signed"; the content hash (`hashes.sha256`, unpadded base64) covers "the complete event including the unredacted contents" with `unsigned`, `signatures`, `hashes` removed, in Canonical JSON; the signature covers the **redacted form, which keeps `hashes`**; on receipt, if signatures verify but the content hash does not match, the receiver does not drop the event (my summary of the spec) and "should use the redacted copy it calculated rather than the full copy it received".
- Room v11 redaction algorithm keeps `event_id, type, room_id, sender, state_key, content, hashes, signatures, depth, prev_events, auth_events, origin_server_ts` and strips `content` except a per-type allowlist (for example `m.room.member` keeps `membership`; `m.room.power_levels` keeps the permission keys). So redaction never breaks DAG links or authorization.
- Redacted events still count: "a redacted `join` event will still result in the user being considered joined".
- Room v12: "The power level of 'room creators' is infinitely high"; room ID = hash of the create event; State Resolution v2.1 (MSC4297, CVE-2025-49090) adds the "conflicted state subgraph" and starts iterative auth checks from an empty state to stop "state resets" (rollbacks without a revocation). Disclosure timeline: pre-disclosure 2025-07-16, coordinated release 2025-08-11, post 2025-08-14.
- Inference (labelled): Matrix keeps an **unsalted** content hash in every redacted event; by the EDPB paragraph quoted in G12 that is a linkability/dictionary-check risk for low-entropy bodies. We should salt.
- Sources: [Matrix server-server API, Signing events](https://spec.matrix.org/latest/server-server-api/) (read 2026-10-17), [room v11 redactions](https://spec.matrix.org/latest/rooms/v11/), [room v12](https://spec.matrix.org/latest/rooms/v12/), [Project Hydra](https://matrix.org/blog/2025/08/project-hydra-improving-state-res/) (2025-08-14).

**G11 Four independent log formats separate a signed header (with payload hash and size) from a deletable payload.** *Confidence: high.*
- Bamboo: each entry commits to "the hash of the payload" and "the size of the payload in bytes", both signed; a holder of the payload must check both ("the feed must be considered invalid from that entry onwards" on mismatch); the format "supports transitive partial replication and local deletion of data" and the README contrasts it with SSB, which signs payloads directly (so deleting a payload there would break replication; this is my paraphrase of the README, not a quote); forks make it an "append-or-delete log" because earlier-valid entries must be deterministically invalidated.
- Buttwoo (SSB): `[metadata, signature, content]`; metadata has `hash` = `0x00 || BLAKE3(content)` (33 B), `contentLength` <= 16384, `previous`, `sequence`, `timestamp`; signature over metadata only; "This allows validation of a log without the actual content"; deletion is called "a whole topic in itself"; Lipmaa links were left out.
- p2panda-core 0.7.1: "An operation is constructed from a 'Header' and a 'Body'"; the split "allows deletion of payloads without breaking the integrity of the append-only log"; headers can travel first and bodies be loaded "lazily".
- Willow: Entry = namespace, subspace, path, timestamp, `payload_length`, `payload_digest`; newer-wins order is timestamp, then payload digest, then length.
- SSB forks: doc 06 F34 records (community thread, snippet-level) that a forked SSB feed is "effectively dead"; Bamboo turns the same problem into the explicit "append-or-delete" rule, which is the equivocation idea in doc 06 3.1.3 (rule 7: ignore every op of the author from the fork on); ARCH v0.2 dropped per-author sequence validation (`seq` is informational, S9), so equivocation is not a validity concern there.
- Ecosystem health: SSB tooling is dormant (doc 06 F34: ssb-db2 last release 2023-11-21), so these are design references, not dependencies.
- Sources: [Bamboo README](https://raw.githubusercontent.com/AljoschaMeyer/bamboo/master/README.md) (undated, OLD), [Buttwoo spec](https://raw.githubusercontent.com/ssbc/ssb-buttwoo-spec/master/README.md) (undated), [p2panda-core](https://docs.rs/p2panda-core/latest/p2panda_core/), [Willow data model](https://willowprotocol.org/specs/data-model/index.html).

**G12 (star) EDPB Guidelines 02/2025 v2.0 gives the compliance recipe in so many words.** *Confidence: high for the quotes (PDF extracted with pdftotext and read); medium for how directly they bind a signed DAG log (see G16).*
- Version history: v1.1 adopted 08 April 2025 (pre-consultation); **v2.0 adopted 07 July 2026** after public consultation.
- Para 50: "technical impossibility cannot be invoked to justify non-compliance with GDPR requirements".
- Para 51 (encryption): after key deletion the data is "unintelligible, at least until the algorithm is broken ..."; "encrypted personal data is still personal data and encryption does not remove the need for GDPR compliance"; "even state-of-the-art encryption perfectly implemented will be overtaken by time if the blockchain is retained indefinitely".
- Para 52 (hashing): a salted or keyed hash "will also be considered personal data"; after the key or salt is deleted "the hash should not be linkable to the original data" if nothing leaked; "the use of unsalted or unkeyed hashes should, in general, not be considered sufficient".
- Para 53 (commitments): with a perfectly hiding commitment, "once the original data and its witness are deleted, the commitment persisting in the blockchain is useless".
- Para 54/109 (Recommendation 2): store only a proof-of-existence form on the ledger; keep the data used to verify it outside.
- Para 80: retention "also applies to these identifiers and, if the identifiers take the form of public signature verification keys, to the transactions signed by the corresponding private signing keys".
- Para 102-104: erasure must be "complied with by design" (para 102); design so personal data "can be effectively rendered anonymous"; "It is therefore not advisable to register personal data in those forms [clear text, encrypted or hashed] on a blockchain. Instead ... off-chain." Para 103 also says "the EDPB recommends looking at other tools if the strong integrity property of blockchains is not needed."
- Recommendation 11 (para 120): at the end of the retention period the solution must "allow for data deletion or ... render the data anonymous. If such solution does not exist, then no personal data should be stored on the chain." Recommendation 16 (para 125): "Neither technical implementation choice nor data subjects' consent can restrict these rights."
- Roles (para 36-44): decentralised governance is not an excuse; permissioned designs give "a clearer allocation of responsibilities" and "organisations should favour permissioned blockchains"; in permissionless networks "nodes should be qualified as controllers or joint controllers" where they have "decisive influence" on purposes and essential means.
- Cross-document note: `w2b-06-abuse-legal-ops.md` quotes the consultation text of 02/2025 and lists its final-adoption status as unverified; the PDF's own version history shows v2.0 adopted 07 July 2026, so paragraph numbers quoted there should be re-checked against v2.0.
- Source: [EDPB Guidelines 02/2025 v2.0 PDF](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf) (07 July 2026), [EDPB page](https://www.edpb.europa.eu/documents/guideline/guidelines-022025-on-processing-of-personal-data-through-blockchain_en).

**G13 Erasure in cooperative networks is best-effort by design, and the precedents say so.** *Confidence: high for the texts; no source says any of them satisfies GDPR.*
- Nostr NIP-09 (kind 5): relays "SHOULD delete or stop publishing" referenced events with the same pubkey; clients MUST validate the pubkey match; "Relays SHOULD continue to publish/share the deletion request events indefinitely"; clients "MAY choose to inform the user that their request for deletion does not guarantee deletion because it is impossible to delete events from all relays and clients".
- Nostr NIP-62 "Request to Vanish" (kind 62; Draft, optional; created 2025-02-19, updated 2026-06-13): "Relays MUST fully delete any events from the `.pubkey` if their service URL is tagged", "MUST ensure the deleted events cannot be re-broadcasted", paid relays must comply, relays "MAY store the signed request", a kind-5 against a vanish "has no effect"; the page claims the procedure "is legally binding in some jurisdictions".
- Matrix Synapse: deactivating with `erase: true` "mark[s] the user as GDPR-erased"; "messages sent by the user will still be visible by anyone that was in the room when these messages were sent" but are "hidden from users joining the room afterwards"; display name, avatar and profile fields are removed; media and messages are not deleted by this call.
- Take: model erasure as signed ops (`tombstone`, `vanish`), have honest nodes purge and refuse to re-serve, and state plainly that non-cooperating copies can exist (security review M8 text already says this).
- Sources: [NIP-09](https://nips.nostr.com/9), [NIP-62](https://nips.nostr.com/62) (updated 2026-06-13), [Synapse user admin API](https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html) (living doc).

**G14 The academic "redactable blockchain" line uses chameleon hashes and a trapdoor; we do not need it.** *Confidence: high on the abstract.* Ateniese, Magri, Venturi, Andrade (IEEE EuroS&P 2017; ePrint 2016/757, revised 2017-05-11): rewrite or compress block content using chameleon hashes and a secret trapdoor held by one trusted entity or shared among distrustful parties; proof of concept on Bitcoin Core; motivations include "improper content" and "the right to be forgotten". For a log we design from scratch, a header/body split gives redaction without a trapdoor key whose compromise would let the holder silently rewrite history. Source: [ePrint 2016/757](https://eprint.iacr.org/2016/757).

**G15 Older and unverified legal inputs.** *Confidence: low-medium.* CNIL (29 Oct 2018, OLD) advises "it is important not to store personal data in cleartext on a blockchain", names commitments, keyed-hash fingerprints and encryption as options, and asks controllers to test "the real necessity to use blockchain technology"; the page I fetched did not discuss key destruction. CJEU C-413/23 P (EDPS v SRB) and the AEPD erasure proof-of-concept note (cited in EDPB footnote 49) could not be retrieved in this run: **unverified**. Sources: [CNIL](https://www.cnil.fr/en/blockchain-and-gdpr-solutions-responsible-use-blockchain-context-personal-data), EDPB footnote 49.

**G16 Who is the controller for a site's chain is a legal question we cannot settle here.** *Confidence: medium (inference from EDPB para 36-44).* The site owner chooses the purposes (a guestbook), publishes the pointer, sets policy and moderates: the closest match to the "authority" in a permissioned design. Visitors who replicate and relay are plausibly in the "nodes" bucket where roles depend on "decisive influence". EDPB para 13 treats chains "generated and controlled by and for a single entity" as out of scope for part of the guidelines, but says the mitigations "could prove useful for any blockchain processing personal data". Action: get counsel to review before launch; treat the guidelines as the best available analogy, not as binding on a non-consensus signed log.

---

### 2.3 Queries and indexes in the browser

**G17 (star) IndexedDB with three compound indexes handles 50,000 ops comfortably; in-memory SQLite WASM inserts faster on both engines but is not needed at our caps.** *Confidence: high for these machines (measured); phones unmeasured.*

Test data: 50,000 synthetic ops, 618 B of JSON each (id 43 chars, author, seq, type, clock, parent id, key, ts, 300-char body, 86-char signature), 200 authors. IndexedDB indexes: `byAuthorSeq [a,s]`, `byCollTypeClock [coll,t,c]`, `byParent p`. SQLite: `ops` table with the same three indexes, in-memory (no OPFS), main thread, one transaction.

| Measurement (median of 100 runs unless noted) | Chromium 156 (M3) | WebKit 27.2 (Playwright build, M3) |
|---|---|---|
| IndexedDB bulk insert, 3 indexes, 5,000 puts per transaction | 994 ms | 2,095 ms |
| IndexedDB bulk insert, no secondary index | 562 ms | 958 ms |
| IndexedDB `getAll()` of all 50,000 (median of 5) | 192 ms | 150 ms |
| IndexedDB latest 50 posts (cursor `prev` on `[coll,t,c]`) | 0.6 ms | 2 ms |
| IndexedDB one author's ops (250 rows, `[a,s]` range `getAll`) | 1 ms | 2 ms |
| IndexedDB count of posts (key-range `count`) | 0.7 ms | 9 ms |
| IndexedDB `getAllRecords` latest 50 (Chrome 141+ API) | 0.3 ms | below 1 ms (preview build) |
| SQLite WASM 3.53.4 init (local file, uncached) | 24.8 ms | 23 ms |
| SQLite insert 50,000 rows, 3 indexes, one transaction | 609 ms | 342 ms |
| SQLite `SELECT *` of all rows (median of 5) | 219 ms | 206 ms |
| SQLite latest 50 / one author / count | 0.2 / 1.2 / 1.2 ms | below 1 / 1 / 1 ms |

Notes: WebKit rounds `performance.now()` to 1 ms, so "below 1 ms" means the timer could not resolve it. The random "children of a parent" probe hit parents with no children most of the time, so I do not report it. These runs say nothing about OPFS-backed SQLite persistence cost, WebKit on a phone, or Firefox.
- Reading: with the 8 MiB default cap (about 13.6k blocks) every query path is single-digit milliseconds on desktop, ARCH v0.2 loads every block into memory at startup (full read 150-190 ms at 50k), and cold load is dominated by signature verification (G8), not storage. IndexedDB insert slows about 2x with indexes on both engines; batch writes (5,000 per transaction here) and avoid awaiting non-IndexedDB promises inside a transaction (review browser-mobile m4).
- Source: this machine, 2026-10-17 (Appendix A, B).

**G18 SQLite WASM: size and persistence constraints.** *Confidence: high.*
- `@sqlite.org/sqlite-wasm` **3.53.4-build2** (npm, 2026-10-02, Apache-2.0, 86 versions, 8 files). Measured: `sqlite3.wasm` 868,907 B raw / 402,035 gzip / 348,812 brotli; `index.mjs` 642,742 B raw unminified, minified by esbuild 217,850 raw / 66,602 gzip / 58,224 brotli. Shipped total about **468,637 B gzip** (407,036 B brotli).
- Official persistence page: `kvvfs` is main-thread only and about 5 MB; the `opfs` VFS runs in a Worker, needs SharedArrayBuffer and therefore COOP/COEP response headers, lists Chromium (about mid-2022), Firefox 111+ and Safari 16.4+ but says "Safari versions less than version 17 are incompatible with the current OPFS VFS implementation"; its reliable connection limit "is unknown" (8-10 concurrent workers worked in 2026-03 testing with `SQLITE_BUSY` handling); `opfs-wl` (added in 3.53.0) uses Web Locks FIFO queuing and needs `Atomics.waitAsync`; **`opfs-sahpool`** (added in 3.43) needs **no** COOP/COEP, "should work on all major browsers released since March 2023", is the fastest OPFS option, but supports multiple simultaneous connections only within one thread or with client-side pause/unpause help (3.50+). Phrases outside quotation marks in this bullet are my summary of the page.
- The package README repeats: for the Worker/OPFS path "you need to set the following headers on your server: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`"; Node supports in-memory only.
- Inference (labelled): our host-agnostic static deployment (S3/CloudFront, GitHub Pages, Cloudflare Pages) cannot be assumed to set those headers, so `opfs-sahpool` plus a Web Locks leader tab (which we need anyway, doc 06 F24) is the only variant that fits; whether a Service Worker can inject COOP/COEP for the loader page was not verified here.
- Sources: [sqlite.org WASM persistence](https://sqlite.org/wasm/doc/trunk/persistence.md) (living doc), npm registry and package README for `@sqlite.org/sqlite-wasm@3.53.4-build2`, local esbuild/gzip/brotli measurements.

**G19 IndexedDB 3.0 features are uneven; feature-detect only.** *Confidence: high (MDN browser-compat-data `main`, fetched 2026-10-17).* `IDBObjectStore.getAllRecords`: Chrome 141, Firefox 153, Safari "preview" (not shipped). `getAll`/`getAllKeys`: Chrome 48 / Firefox 44 / Safari 10.1. `IDBTransaction.durability`: Chrome 83 / Firefox 126 / Safari 15. `IDBFactory.databases`: Chrome 72 / Firefox 126 / Safari 14. `FileSystemSyncAccessHandle`: Chrome 102 / Firefox 111 / Safari 15.2. `StorageManager.persist()`: Chrome 55 / Firefox 57 / Safari 15.2; `estimate()` Safari 17.

**G20 Other storage layers I checked.** *Confidence: medium-high.* `idb` 8.0.4 (2026-10-06): 1,365 B gzip bundled. Dexie 4.4.6 (2026-09-10): 32,729 B gzip bundled. `wa-sqlite`: the npm package is `1.0.0` from 2024-01-05 only; its README lists IDB-backed VFSs (`IDBBatchAtomicVFS`, `IDBMirrorVFS`), OPFS VFSs (`OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS`, `OPFSWriteAheadVFS`), `AccessHandlePoolVFS` and memory VFSs, states no sizes, and says "MIT, effective February 10, 2023" with existing licensees allowed to continue under GPLv3 (my reading: a license change); I could not read its VFS comparison table. `@electric-sql/pglite` 0.5.10 (2026-10-14) is 35 MB unpacked: not a fit. Sources: npm registry (queried 2026-10-17), [wa-sqlite README](https://raw.githubusercontent.com/rhashimoto/wa-sqlite/master/README.md), local bundling.

### 2.4 End-to-end encryption for private lists

**G21 (star) Forward secrecy and "history for late joiners / offline replicas" pull in opposite directions; the systems that ship say so.** *Confidence: high.*
- Keyhive notebook entry 06 (Derek Yen, 2026-07-31): in the decentralized setting "any kappa > 1 immediately eliminates forward secrecy" (the post writes kappa as the Greek letter; kappa = how many old individual group secrets a user keeps), "kappa > 1 is also necessary to handle the possibility of group partitions and concurrency", the implementation sets kappa to infinity, and "forward secrecy is not considered very important" for BeeKEM's context. Entry 02 (2025-01-21) footnote: "BeeKEM in isolation provides forward secrecy, but Keyhive as a whole does not."
- NIP-44 v2 (audited by Cure53, December 2023) lists "No forward secrecy", "No post-compromise security", "No deniability", "No post-quantum security".
- EDPB para 51 (G12): encryption is "overtaken by time" if the ledger is retained indefinitely.
- Consequence: a replicated log that serves late joiners must let a new member decrypt history it is entitled to, so old epoch keys must exist somewhere. What we can honestly promise: (a) non-members and relays cannot read; (b) after removal, a member cannot read content encrypted under later epochs (post-removal secrecy for future content only); (c) retention by key deletion is a policy the key holder (owner) executes, not a property of the protocol.
- Sources: [Keyhive 06](https://www.inkandswitch.com/keyhive/notebook/06/), [Keyhive notebook index](https://www.inkandswitch.com/keyhive/notebook/), [NIP-44](https://nips.nostr.com/44), EDPB PDF.

**G22 Group-key protocols exist, but none is ready to be our dependency; MLS also hands the ordering problem back to the application.** *Confidence: high.*
- RFC 9420 (MLS): forward secrecy and post-compromise security "for groups in size ranging from two to thousands", costs "scale as the log of the group size"; "MLS assumes a trusted AS but a largely untrusted DS"; section 14: "Applications MUST have an established way to resolve conflicting Commit messages for the same epoch", either by preventing conflicts or "developing rules for deciding which Commit out of several sent in an epoch will be canonical"; forked group states must be deleted promptly "to ensure forward secrecy". In our model the owner's sequence number is exactly such a rule.
- `ts-mls` 1.6.4 (2026-08-28; 2.0.0-rc.16 on the `rc` tag): "aims to be a full implementation of RFC 9420", 19 ciphersuites, "suitable for browsers", "This library has not undergone a formal security audit." It declares exact peer pins (`@noble/ciphers` 2.1.1, `@noble/curves` 2.0.1, `@hpke/*` exact) so `npm install` next to `@noble/ciphers@2.4.0` fails with ERESOLVE (I hit this).
- Keyhive/BeeKEM: entry 04 (2025-03-10) "DO NOT use this release in production applications" and "has also not been through a security audit"; Subduction (its successor sync layer) says "DO NOT use for production use cases at this time" (G4).
- Sources: [RFC 9420](https://datatracker.ietf.org/doc/rfc9420/), [ts-mls README](https://raw.githubusercontent.com/LukaJCB/ts-mls/main/README.md), npm registry, Keyhive notebook.

**G23 Encrypting only the payload lets non-members relay and validate; what stays in clear is still a lot.** *Confidence: high for OrbitDB/Keyhive/Willow page contents.*
- OrbitDB (docs/ENCRYPTION.md): two layers, `data` (payload only) and `replication` (whole log entry); "an orbitdb peer can replicate a database without being able to decrypt the payloads (=data)"; modules are `{encrypt, decrypt}`; the bundled password-based module is "Use at your own risk" (unaudited); the page says nothing about key distribution, rotation, forward secrecy or metadata leakage.
- Keyhive/Beelay: the sync server "only has the ciphertext" but the commit-graph hashes and heads stay outside the encryption envelope (entry 05, entry 01 "removing read access from sync servers altogether").
- Willow Confidential Sync: timestamps, payload lengths, digests and delegation public keys leak to an active eavesdropper (L2 tier); guessable names can be confirmed ("cannot prevent peers from confirming guesses about data they shouldn't know about").
- For us, relays must be able to check signature, PoW, size and policy, so `e` stays in the clear; author, sequence, parents, rounded time, key or list name and the envelope length are visible. Pad values (G24).
- Sources: [OrbitDB ENCRYPTION.md](https://raw.githubusercontent.com/orbitdb/orbitdb/main/docs/ENCRYPTION.md), [Keyhive 01](https://www.inkandswitch.com/keyhive/notebook/01/), [Willow PIO](https://willowprotocol.org/specs/pio/index.html) (no status or date shown).

**G24 Length leakage has a cheap, specified mitigation to copy.** *Confidence: high.* NIP-44 pads plaintext with a power-of-two bucket scheme: minimum padded size 32 bytes, "Padding algorithm is related to powers-of-two"; 65,537 bytes pads to 81,920 in its test vectors. It uses HMAC-SHA256 rather than an AEAD tag ("polynomial MACs are much easier to forge" is its stated reason); we do not need to copy that choice. Source: [NIP-44](https://nips.nostr.com/44).

**G25 Library options with measured browser sizes (esbuild 0.28.2, minified, ES2022, 2026-10-17).** *Confidence: high for sizes; fit is my judgement.*

| Option | Raw | gzip -9 | brotli q11 | Notes |
|---|---|---|---|---|
| `@noble/ciphers` 2.4.0 `xchacha20poly1305` only | 11,448 B | 4,896 B | 4,231 B | 24-byte random nonces |
| noble "box": xchacha20poly1305 + x25519 + hkdf + sha256 (2.4.0 each) | 44,042 B | 16,823 B | 14,803 B | enough for sealed boxes and epoch-key wraps |
| `@noble/curves` ed25519 only | 33,555 B | 13,436 B | 12,026 B | doc 06 fallback |
| `hpke-js` 1.8.0 (CipherSuite, KemId, KdfId, AeadId) | 69,552 B | 19,939 B | 16,813 B | RFC 9180 HPKE |
| `age-encryption` 0.3.1 (Encrypter/Decrypter/identities) | 142,996 B | 52,199 B | 40,010 B | pulls `@noble/post-quantum` and `@scure/base` |
| `libsodium-wrappers` 0.8.4 (wasm embedded) | 433,770 B | 151,487 B | 123,951 B | |
| `@noble/hashes` argon2id | 14,007 B | 5,617 B | 4,951 B | pure JS |
| SHA-256 only (`@noble/hashes`) | 5,402 B | 2,640 B | 2,312 B | |

- `age-encryption` (typage) offers X25519 and scrypt recipients, WebAuthn recipients, a `generateHybridIdentity()` post-quantum identity (the page does not name the algorithm), streaming, and can use a WebCrypto X25519 `CryptoKey`. The age v1 format has about **200 B fixed overhead** with one X25519 recipient (22 B version line + 98 B stanza + 48 B MAC line + 16 B nonce + 16 B tag; derived from the format rules) and **+98 B per extra recipient**, plus 16 B per 64 KiB chunk. That is the wrong shape for thousands of small ops: use age (or HPKE) to wrap a per-list key once per member, not per op.
- Per-op overhead with an epoch key and XChaCha20-Poly1305: 24 B nonce + 16 B tag = 40 B (design arithmetic).
- Sources: local bundling (Appendix A), [age v1 spec](https://c2sp.org/age), [typage README](https://raw.githubusercontent.com/FiloSottile/typage/main/README.md), npm registry.

**G26 WebCrypto cannot do everything we want; the modern-algorithms draft is not something to depend on.** *Confidence: high for the draft's content, low for shipping status.*
- Doc 06 F45: Ed25519 in Chrome/Edge 137, Firefox 129, Safari 17, Samsung Internet 30; X25519 in Chrome 133, Firefox 130, Safari 17.
- WICG "Modern Algorithms in the Web Cryptography API" (Draft Community Group Report, dated **14 September 2026**; editors from Proton and Okta; "Latest published version: none"; not standards-track): ML-KEM-512/768/1024, hybrids `MLKEM768-X25519`, `MLKEM768-P256`, `MLKEM1024-P384`, ML-DSA, SLH-DSA, AES-OCB, **ChaCha20-Poly1305**, SHA-3, cSHAKE, TurboSHAKE, KangarooTwelve, KMAC and **Argon2d/i/id**; HPKE does not appear in the part I could read (the fetch covered the first 100,000 of 317,437 characters). MDN compat data (fetched 2026-10-17) records `SubtleCrypto.encapsulateKey/decapsulateKey` only in Chrome 155 (Firefox "preview", Safari none) and has no per-algorithm entries, so availability of ChaCha20-Poly1305 or Argon2id in any shipping browser is **unverified**.
- Consequence: v1 uses WebCrypto X25519/Ed25519/AES-GCM/SHA-256 where present and noble for XChaCha20-Poly1305 and for fallbacks; revisit when the draft ships.
- Sources: [WICG modern algos](https://wicg.github.io/webcrypto-modern-algos/) (2026-09-14), MDN BCD, doc 06 F45.

### 2.5 Access control

**G27 (star) Anything that expires or is revoked by wall-clock time is fragile in a system with untrusted clocks; the capability specs say so in their own words.** *Confidence: high.*
- UCAN delegation spec "Version 1.0.0": `exp` is required but may be `null`, `nbf` optional, both Unix seconds; a chain "MAY have different validity periods, but MUST all be valid at execution-time"; the main spec recommends "A buffer of +-60 seconds"; no maximum chain depth or token size is stated. Revocation is a separate spec at **v1.0.0-rc.1**: a signed `ucan/revoke` invocation naming a delegation CID; validators "MUST" check a revocation cache; "Revocations MUST be immutable and irreversible"; it admits it is "unable to guarantee delivery in a certain time bound" and that revocation "SHOULD be considered the last line of defense", preferring expiry and reduced scope.
- Meadowcap (status "Final (as of 21.11.2025)"): capabilities restrict by subspace, path and **timestamp range** ("valid for one week at a time"); the page never mentions revocation; removal is done by the owner writing entries with timestamps "two weeks in the future" that overwrite the member's; clock trust is not discussed.
- Keyhive 01: operations can be backdated (my paraphrase of the post), "Concurrent access control will always have some tricky situations", and it defers "What is the best strategy to handle operations from an agent that was revoked concurrently" to a future post; consensus is "a last resort".
- Peerbit issue #1346 (doc 06 F32, opened 2026-08-30): "Validating trust only when an entry is first ingested leaves races around revocation and offline replicas".
- Consequence: ARCH v0.2's causal rule (DESIGN-REVIEW item 2: a control block governs every block that is not its ancestor, so concurrent and backdated writes are caught without any clock) is the right answer and already covers policy tightening and `allow` removal. Keep `ts` and any `exp` out of validity.
- Sources: [UCAN spec](https://github.com/ucan-wg/spec), [UCAN delegation](https://raw.githubusercontent.com/ucan-wg/delegation/main/README.md), [UCAN revocation](https://raw.githubusercontent.com/ucan-wg/revocation/main/README.md), [Meadowcap](https://willowprotocol.org/specs/meadowcap/index.html), [Keyhive 01](https://www.inkandswitch.com/keyhive/notebook/01/).

**G28 Matrix room v12 is the closest large-scale analogue of "owner is the root of authority and the chain id is bound to it".** *Confidence: high for facts, medium for the mapping.* Room v12 gives creators an infinitely high power level and derives the room ID from the create event; State Resolution v2.1 exists because auth evaluated against an ambiguous state produced "state resets". ARCH v0.2's ledger id (`mw1:` + b64url(sha256(owner|chain)), DESIGN-REVIEW item 3, review M5) is the same binding, and its causal rule `controlFor(B)` plays the role of state resolution: a control block always governs the blocks that are not its ancestors, so rollback-without-revocation cannot arise from reordering. Sources: G10.

**G29 Candidate capability formats if capability mode ever needs delegation.** *Confidence: medium.*
- UCAN 1.0: DAG-CBOR canonical encoding, policy language over invocation `args` (`==`, `!=`, `<`, `like`, `and`, `or`, `not`, `all`, `any`), proof chains. JS ecosystem is mixed: `@ucanto/core` 10.4.6 (2025-10-27, a different generation, unverified against 1.0), and an `iso-ucan` audit tracker that says upstream revocation text still describes the pre-1.0 format (search snippet only; it may predate the rc.1 revocation text I read).
- Biscuit: Ed25519, Datalog policies, offline attenuation ("you can generate a new one with less rights"), unique revocation identifiers; `@biscuit-auth/biscuit-wasm` 0.6.0 (2025-09-26) is 2.5 MB unpacked; spec status not stated on the site.
- Meadowcap: see G27.
- For a site-owner-centric system the owner-signed grant with caveats is enough for v1; delegation by members is a P3 feature.
- Sources: UCAN pages above, [Biscuit](https://www.biscuitsec.org/), npm registry.

**G30 Peerbit's open ACL issue independently converges on the same three-part design (policy epoch, authority-signed policy head or short-lived capabilities, epoch-key encryption with sealed envelopes).** *Confidence: high (issue re-read 2026-10-17; doc 06 F32 read it on 2026-10-14).*
- Issue #1346 "TrustedNetwork v2: roles, deterministic revocation, and future-write confidentiality": opened 2026-08-30, last updated 2026-09-03, still open. Quotes: "validating trust only when an entry is first ingested leaves races around revocation and offline replicas" unless there is a common authorization boundary; stage B option 1 "a linearized, authority-signed policy head with writes bound to the policy sequence they were authorized under"; option 2 "short-lived, authority-signed capabilities with deterministic expiry and renewal rules"; stage C "Encrypt application content under an epoch key and distribute that key in sealed envelopes to authorized readers". It adds that a `canRead` predicate alone is not confidentiality, because a peer that obtains replicated blocks can retain or redistribute plaintext.
- Latest status: the 2026-09-03 comment says no v2 revocation API will be activated until prerequisite #1417 is complete and independently verified.
- OrbitDB (doc 06 F17): `IPFSAccessController` is an immutable write list, `OrbitDBAccessController` has mutable `grant`/`revoke`, and neither documents ban semantics or what happens to entries already replicated; Peerbit's issue is the same gap stated more precisely.
- Mapping: ARCH v0.2's causal owner policy is their option 1 (a policy head that writes are bound to); section 3.5 is their stage C. Their option 2 says "deterministic expiry" without saying whether it is clock- or sequence-based in the text I read: unknown.
- Source: [peerbit issue #1346](https://github.com/dao-xyz/peerbit/issues/1346).

### 2.6 Rate limiting economics and spam on open-write logs

**G31 Systems that tried PoW for p2p spam control moved away, citing exactly our constraint.** *Confidence: high for the sources; Waku's current production status not checked.*
- Waku-RLN-Relay (arXiv 2207.00117, July 2022, a two-page paper): "The PoW technique imposes a high computational cost for messaging hence devices with limited resources won't be able to participate"; peer scoring "is prone to censorship and is also subject to inexpensive attacks where the spammer can send bulk messages by deploying millions of bots". Whisper (EIP-627) is named as the PoW example.
- RLN v2 (Waku blog, 2024-07-10): `x` messages per `y` seconds per member, initially **100 messages per 10 minutes**; membership registered in a smart contract (Ethereum Sepolia testnet at the time, L2 expected), insertion cost "between 100k and 200k gas"; the Merkle tree lives on chain so light clients are stateless. The blog does not give proof-generation time or mention PoW. I found no browser proof-generation figure: **unknown**.
- Applicability: RLN needs a membership registry. An owner-signed Merkle root of admitted commitments would remove the chain but turns it into capability mode with a zero-knowledge wrapper; heavy for v1. Watch item (P3).
- Sources: [Waku-RLN-Relay](https://arxiv.org/pdf/2207.00117) (downloaded, 2 pages), [RLN v2 post](https://blog.waku.org/2024-07-10-rln-v2-stateless-light-clients/).

**G32 Relay-level scoring should be local and subjective; validity stays pure.** *Confidence: high.* libp2p GossipSub v1.1: "The score is locally computed by each individual peer based on observed behaviour and is not shared"; components include invalid messages (P4), application-specific score (P5), IP colocation (P6) and a behavioural penalty (P7); validator outcomes are Accept, Reject (triggers P4) and **Ignore** ("not delivered or forwarded" but "does not trigger the P4 penalty"); thresholds for gossip, publish, graylist and PX. This is the model for the "propagation limits never change validity" rule (doc 06 3.1.0) and for review M14's split budgets. Source: [gossipsub-v1.1.md](https://raw.githubusercontent.com/libp2p/specs/master/pubsub/gossipsub/gossipsub-v1.1.md).

**G33 Composable, subscribable moderation has a working signed-data design.** *Confidence: high.* ATProto labels: `src, uri, val (<=128 B), cts, exp, sig, neg`; signed by a key in the labeler's DID document; retraction by publishing the same label with `neg: true` and a later `cts`; "Labels were originally designed to support composable moderation"; clients pick sources with an HTTP header (`atproto-accept-labelers`), with a `redact` flag. Take: let a visitor subscribe to additional owner-style signed mute lists (author key bans / op hides) in addition to the owner's, with the same retract-by-negation shape. Source: [atproto.com/specs/label](https://atproto.com/specs/label). (Matrix moderation policy lists are an analogue I could not fetch: unverified.)

**G34 Identity-admission PoW barely changes the attacker's per-op price.** *Confidence: high for the arithmetic; inputs from doc 06.* Doc 06 F39: 16 bits = 65,536 hashes per op; one RTX 4090 about 2.2x10^10 SHA-256/s (hashcat forum); naive phone solvers 40-120 kH/s, optimized-phone figure 460 kH/s is an extrapolation. Security review M1 suggests `bits + 6` for a new author's first op (22 bits = 4.2M hashes: 42 s on a 100 kH/s iPhone WebCrypto loop, about 9 s at the extrapolated optimized rate, too slow for UX). Per-op attacker cost with a one-time identity stamp of 2^20 and a per-author quota Q:
- Q = 200 ops: (1,048,576 / 200) + 65,536 = 70,779 hashes/op, only 8% above 65,536.
- Q = 5 ops: (1,048,576 / 5) + 65,536 = 275,251 hashes/op, 4.2x.
- At 70,779 hashes/op a single GPU still mints about 3.1x10^5 ops/s.
So PoW cannot price spam against a GPU at any cost a phone tolerates; its job is to stop naive scripts. Real limits are quotas, byte budgets and moderation.

**G35 Memory-hard hashing as a Hashcash inner function costs 10^4-10^5 times a SHA-256 on the same CPU; whether it narrows the GPU gap is unmeasured here.** *Confidence: high for timings, low for the attacker comparison.* Argon2id (`@noble/hashes` 2.4.0, pure JS, main thread, M3): 4 MiB / t=1 = 11.4 ms (Chromium), 12 ms (WebKit); 16 MiB / t=1 = 44.9 / 48 ms; 19 MiB / t=2 = 105.5 / 110 ms. Doc 06 F36 measured 3.2M SHA-256/s for a specialised loop (about 0.31 microseconds each), so one 16 MiB Argon2id evaluation is about 1.4x10^5 SHA-256 hashes of CPU time. A puzzle of k bits needs 2^k evaluations (k = 3 is about 0.09 s at 4 MiB and about 0.36 s at 16 MiB on an M3). I did not measure phones or any GPU/ASIC Argon2 rate; the memory-hardness argument is textbook but I did not fetch RFC 9106 in this run: **unverified for our parameters**.

### 2.7 What maps to our signed Merkle-DAG with deterministic order

| System | Mechanism | Take | Leave |
|---|---|---|---|
| Matrix (rooms v11/v12) | Signature over redacted form + content hash; redaction keeps DAG fields; redacted events still affect state | Header/body split; redaction as an ordered op; owner-as-root bound to chain id | Full state resolution; unsalted content hash |
| Bamboo, Buttwoo, p2panda, Willow | Signed header with payload hash + size; payload deletable; prune flag / prefix pruning | salted `vh` in `e` (R1); explicit checkpoint op (R7) | Lipmaa links (Buttwoo dropped them); Willow's timestamp-based winner and expiry (clock trust) |
| Automerge / Yjs | Content-addressed storage chunks; compaction at thresholds; no history pruning | L0 packing, verify-then-delete | Per-keystroke update model |
| Loro / Hypercore / Autobase | Shallow snapshot; truncate = new fork id; quorum `signedLength` | L2 prune with fence; owner = single indexer | Whole-core forks as the normal case |
| Sedimentree / Subduction | Hash-depth boundaries, strata, "minimal" tree | Idea for resumable snapshot segments (P3) | Pre-alpha code, open head-bookkeeping bug |
| C2SP + Go sumdb | Signed note (origin, size, root) + witnesses + tiles | Checkpoint text format; witness idea | RFC 6962 consistency proofs (needs append-only tree) |
| Ethereum | Weak-subjectivity checkpoint | Owner key as the social anchor | n/a |
| Keyhive / MLS | Capability delegation + group keys; FS and PCS | Epoch/rotation vocabulary | Dependency on pre-alpha / unaudited code; MLS needs a conflict rule (the owner chain) |
| Nostr | NIP-09 delete, NIP-62 vanish, NIP-44 padding, NIP-13 PoW | `tombstone`, `vanish`, padding buckets | Relay-dependent guarantees |
| ATProto labels | Signed, negatable, subscribable | Subscribable mute lists | Labeler service infrastructure |
| Waku RLN / GossipSub | Staked rate limit / local peer score | Relay-level local scoring now; RLN as a watch item | On-chain membership |

---

## 3. Concrete recommendations for magnet-web

**Baseline.** `docs/ARCHITECTURE.md` **v0.2** (normative, edited 2026-10-17 17:17, which supersedes the v0.1 I first read) section 6 "Site ledger", `docs/INTERFACES.md` (`block.js`, `dag.js`), and `docs/review/DESIGN-REVIEW.md` items 1-5, S2, S9 and the "LATER / v2" list. Doc 06 is the proposal v0.2 was derived from; its field names are superseded:

| Doc 06 proposal | ARCHITECTURE v0.2 (normative) |
|---|---|
| `a`, `s`, `p`, `d[]` | `author`, `seq` (informational), `prev` (sorted, unique, up to 8) |
| `c` Lamport clock, order `(c, a, id)` | `depth`, order `(depth, h)` |
| `x` body inside the signed bytes | `v` outside `h`, committed by `vh` (DESIGN-REVIEW item 1) |
| owner `mod.*` log, `minEpoch` fence | control ops `policy`, `owner`, `tombstone`, `ban`, `allow` plus the causal rule `controlFor(B)` (item 2) |
| `pw {bits, n}` | `e.bits` + `e.nonce` |
| Ed25519 | ECDSA P-256 (Ed25519 is on the LATER list) |
| `dbId` | ledger id `mw1:` + b64url(sha256(owner + "\|" + chain-or-scope)).slice(0, 27) |

Priorities: **P0** = amend before `block.js` / wire format freeze (cheap now, breaking later); **P1** = needed for a production-ready database; **P2** = valuable, after P1; **P3** = watch or optional. Effort: **S** = days, **M** = 1-3 weeks, **L** = more than 3 weeks (one engineer, with tests). "Status" says how the item relates to v0.2.

### 3.0 What v0.2 already decides and this research corroborates (keep as is)

- Payload outside the hash, final tombstones, unredactable control ops, and "relay a `v`-less block only together with the tombstone that justifies it" (item 1): matches Matrix, Bamboo, Buttwoo, p2panda, Willow (G10, G11) and answers the body-withholding concern in G11.
- The causal owner-policy rule: `controlFor(B)` folds the control blocks C with `B` not in `ancestors(C)`, so tightenings and removals govern concurrent and later writes and cannot be bypassed by a shallow `prev` (item 2). This is the clock-free "remove wins" semantics that Peerbit #1346 stage B option 1 describes and that UCAN and Meadowcap lack (G27, G30).
- Owner-bound ledger id and key succession (item 3), the same binding Matrix room v12 uses (G28).
- `ts` rounded to the minute, `seq` informational (S9); `writers:'owner'` default, 8 MiB cap, 16-bit stamps presented as a fee (item 4; G31, G34).
- `cs=` gzip snapshot, `tools/snapshot.mjs` (S2) and `node.importSnapshot` (section 6.8).
- The LATER list already names owner-signed checkpoints, history pruning, capability write mode, deterministic per-author quotas, local mute lists and local hide-and-purge. This document supplies evidence for which to pull forward.

### 3.1 Prioritised feature list

| ID | Pri | Effort | Status vs v0.2 | What to build or change | Evidence and why |
|---|---|---|---|---|---|
| R1 | P0 | S | Amend item 1 | **Salt the value hash.** `vh = hex(sha256("mw-vh-v1\n" \|\| z \|\| canonical(v)))` with `z` = 16 random bytes carried as `Block.z` beside `v`; `tombstone` / `redact()` drops `v` **and** `z`; `WANT {h, v:true}` returns both. Section 3.2 has the exact rules. | EDPB para 52-54 (G12): unsalted or unkeyed hashes "not ... sufficient", salted ones are personal data until the salt is deleted; for short values (a name, "yes") an unsalted `vh` lets anyone confirm guesses. Matrix's unsalted `hashes.sha256` is a counter-example (G10). |
| R2 | P0 | S | Amend section 6.5 | **Fix the erasure semantics now** (3.4): hidden is equivalent to absent; a `v`-less block without tombstone takes no effect (already true); decide ban payload purge; decide what a tombstoned `put` reveals (previous value); reserve the name `vanish`. | G10 (redacted events still count), G13 (best-effort erasure), EDPB Rec 16. |
| R3 | P0 | S | Amend section 6.1 | **No personal data or free text in permanent fields.** Control ops and `e.op` keys (`k`, `l`) are never redactable: restrict `k`/`l` to `[A-Za-z0-9._:/-]`, make the SDK warn on PII-like keys, forbid reason strings in control ops (enum codes only), keep profile names in `v`, show the one-screen privacy notice at first write. | EDPB para 26-27, 80, 103, Recommendations 4, 10 (G12). |
| R4 | P0 | S | Amend section 6.7 | **Storage integrity rules:** one IndexedDB transaction per batch (already write-through); verify on load (recompute `h`; signatures in the worker pool); never delete from a summary; any GC is copy, verify, delete; crash-injection tests. | G3 (automerge-repo #781), y-indexeddb's non-atomic delete. |
| R6 | P0 | S | Amend section 6.1 / INTERFACES | **Reserve control-op names and the unknown-op rule:** `checkpoint`, `vanish`, `grp`, and `allow` entries with caveats; decide now whether an unknown control `t` makes a block invalid or is relayed and ignored; version the snapshot media type (`mw-snap/1`). | Compatibility promise: avoids a protocol-version bump for features already planned. |
| R7 | P1 | M | Pull forward from LATER | **Owner checkpoint block + self-verifying snapshot** (3.3): an owner block whose `prev` lists every head, carrying `n` and `root`; the loader pins the highest checkpoint and checks DAG closure, `n` and `root` over the downloaded `cs` snapshot. Initial cadence guess: 256 new blocks or 24 h (no evidence; tune). | S2 has an unauthenticated `cs=` file; G5-G8; DAG closure is free (inference). |
| R8 | P1 | S | Amend section 6.6 | `HELLO` gains `ckpt` (hash of the latest accepted checkpoint); the UI shows "in sync with owner checkpoint" next to the existing `inSync`; two checkpoint blocks with equal `n` but different `root` raise an alert (owner fork or tampered snapshot). | Doc 06 open question 16; G5. |
| R9 | P1 | M | New | **`tools/import.mjs`**: JSON/CSV/SQL dump to owner-signed `put`/`append` blocks (Node only; the owner key never enters a browser) plus a genesis checkpoint, so existing sites migrate with their data (user goal 1). | Owner-only roots and Node-side signing are v0.2 rules (section 6.2). |
| R11 | P1 | M | Pull forward from LATER | **Spam layering:** local mute lists (subscribable, signed, retractable) and local hide-and-purge; relay-level local scoring with Accept/Reject/Ignore outcomes; deterministic per-author quotas when `writers:'open'` is offered; keep `bits` 16; **skip** identity-admission PoW. | G31-G35; arithmetic in G34. |
| R13 | P1 | S | New | **Legal and privacy package:** counsel review of controller roles, DPIA template, privacy notice text, owner runbook for erasure requests. Align with `w2b-06-abuse-legal-ops.md`. | G12, G15, G16. |
| R16 | P1 | S | New control op | **Implement `vanish`** (3.4): author-signed (or moderator/owner-signed) erase-all for one key's earlier blocks; drops `v` and `z`. | G13 (NIP-62, Synapse erase), EDPB Rec 16. |
| R5 | P2 | M | Defer | **Query layer:** keep the in-memory reducer; add a paged `mw.db.list` API now; split `blocks` into headers and values with `author`/`depth` indexes only when caps rise or phones show memory pressure (3.8). No SQLite in v1. | G17 (50k records load in 150-190 ms; indexed queries 0.3-9 ms). |
| R10 | P2 | M | Pull forward from LATER | **Grants with caveats:** extend `allow` entries with `k` prefixes, `max` value bytes and `q` quota; revocation stays `allow {remove}` under the causal rule (3.6). | G27-G30. |
| R12 | P2 | S | New | **Owner sealed inbox** for contact-form style submissions (3.5): sealed to an owner X25519 key published under the owner-only `_inbox` key, rotated per retention epoch. | G12 (para 51, Rec 11), G21, G24, G25. |
| R14 | P2 | L | New | **Member groups with epoch keys** (private lists) per 3.5; noble box (16.8 KB gzip). | G21-G25. |
| R15 | P2 | M | LATER (history pruning) | **L2 pruning behind a checkpoint** (3.3): causal fence, `(h, depth)` table for pruned parents, Merkle root with inclusion proofs; trigger on storage budget, not CPU. | G2, G6, G8. |
| R17 | P2 | M | New | **Retention epochs:** inbox and group keys rotate on a schedule; old private keys deleted after processing. | G12 (para 51, Rec 11), G21. |
| R18 | P3 | M | New | **Optional SQLite WASM module**, lazy-loaded, `opfs-sahpool` in a leader Worker; 468,637 B gzip; not in the default bundle. | G18. |
| R19 | P3 | M | New | **Witness cosigning** of checkpoints (C2SP signed-note text projection); needs an append-only structure over per-checkpoint segment roots. | G5. |
| R20 | P3 | L | New | **Delegable capabilities** (UCAN-1.0-shaped or Biscuit) and **MLS/BeeKEM** groups, once audited implementations and stable specs exist. | G22, G29. |
| R21 | P3 | M | New | **Hash-boundary segments** (Sedimentree idea) for resumable snapshot download beyond roughly 100k blocks. | G4. |
| R22 | P3 | S | New | **Argon2id or RLN-style limits** after phone benchmarks; **post-quantum** key wrapping when WebCrypto ML-KEM ships. | G35, G31, G26. |

### 3.2 Amendment to the block format (ARCHITECTURE v0.2 section 6.1, DESIGN-REVIEW item 1)

```
Block = { e, h, s, v?, z? }
  z   = 16 random bytes (b64url); present iff v is present; never inside e
  vh  = hex( sha256( utf8("mw-vh-v1\n") || bytes(z) || utf8(canonical(v)) ) )     // inside e.op for payload ops
verify when v is present: z present and 16 bytes; recompute vh; byteLength(canonical(v)) <= maxValueBytes
redact(block) and tombstone: drop v AND z, keep { e, h, s }
WANT { h, v:true } answers carry v and z together; a node that deleted v for a tombstoned h never re-requests it
maxBlockBytes counts canonical(e) + canonical(v) (+ the 22-character z)
INTERFACES block.js: valueHash(value) becomes valueHash(value, z)
```
Cost: 16 random bytes per payload block, about 28 bytes of the 4,096-byte block budget (under 1 percent).

Control-op additions (content lives inside `e`, so it is permanent and unredactable; **no free text, enum codes only**):

| `t` | Valid from | Content | Effect |
|---|---|---|---|
| `vanish` (R16) | the author key itself, a moderator, the owner | `{author}` | every block by `author` that is an ancestor of this block loses `v` and `z` and takes no effect (for a moderator or owner: only the blocks they had seen; use `ban` for the rest); later blocks by the same key are unaffected unless banned |
| `checkpoint` (R7) | owner | `{n, root}` | see 3.3 |
| `grp` (R14) | owner | `{gid, ep, wraps:[{kid, w}]}` | epoch-key wraps for a private list (3.5) |
| `allow` (R10, extends v0.2) | owner | `{add:[pub \| {pub, k?:[prefix], max?:uint, q?:uint}], remove:[pub]}` | grants with caveats (3.6); bare `pub` strings stay valid |

Wire and gossip: `HELLO` gains `ckpt`. Pointer record: no change; `cs=` stays the only hint. A checkpoint block cannot commit to the hash of the snapshot file that contains it (circular), so the commitment is to the block **set** (`n`, `root`) and the file hash is deliberately not part of the design.

Compatibility promises worth writing down: (1) `h` and `s` cover `e` only, so redaction never changes an id; (2) a `v`-less block without a tombstone never takes effect; (3) tombstones and `vanish` are final; (4) snapshots are versioned and their completeness is authenticated by an owner checkpoint (set commitment, not a file hash); (5) erasure binds cooperating peers only; (6) control ops are permanent and contain keys and hashes only.

### 3.3 Owner checkpoint block (R7) and later pruning (R15)

**Definition.** A `checkpoint` block C is an owner block whose `prev` lists every head the owner holds (if there are more than 8 heads, mint intermediate checkpoint blocks that each merge up to 8 heads, then a final one that merges those; `maxPrev` is 8). Because `h` commits to `prev` and so on recursively, **the DAG already commits to C's whole causal past**: a node that holds C and whose `Dag.missing()` is empty has every ancestor of C. `n = |ancestors(C)|` and `root = sha256(concat(sorted ancestor hashes as bytes))` (the same function as `Dag.root()` restricted to ancestors; equal to it when C covers the whole DAG) are a cheap second check. The block cannot also commit to the hash of the snapshot file that contains it (circular), so it commits to the block set instead.

**What it adds over v0.2's unauthenticated `cs=` file.**
1. *Tip completeness and freshness.* Without C, a snapshot host can drop the newest blocks (tips nothing references yet, for example the latest tombstone, `ban` or `allow` removal) and nobody can tell. With C, every head the owner had seen is an ancestor of C, so dropping one leaves C an orphan.
2. *A rollback anchor.* The loader pins the highest `checkpoint` it accepted for the ledger and flags a snapshot whose latest owner block does not descend from it.
3. *The commitment L2 needs later.*

**What it does not add.** Protection against a malicious static host that also serves the loader (that host is already the trust root, review requirements-fidelity M4); anything about blocks written after C; and detection of a **consistent older snapshot** by a first-time visitor with no pin and no peers (rollback). A signed pointer field naming the newest checkpoint hash would close that gap at the cost of republishing the pointer: open question. For per-domain sites where the owner controls the host, this is defence in depth; it matters most when `cs` is mirrored on third-party storage or fetched from peers.

**Owner side (`tools/snapshot.mjs`, Node, owner key available):** mint intermediate checkpoint blocks until one `checkpoint` block can list all heads; compute `n` and `root`; write the gzip JSON snapshot (blocks sorted by `(depth, h)`; payloads `v` and `z` for live blocks, `v`-less for tombstoned) including C; upload to the `cs` URL; update the signed pointer only if the URL changed.

**Loader side:**
1. Fetch the snapshot after first render (v0.2 section 5.5), enforce `maxChainBytes` while streaming.
2. Ingest through the normal path (shape, `h`, PoW, signature in the worker pool, `vh`/`z`).
3. Find the highest owner `checkpoint` in the ingested set; require `Dag.missing()` empty for its ancestors; recompute and compare `n` and `root`.
4. On any failure, discard the snapshot and mark the URL suspect for the session; keep gossip as the fallback.
5. Pin the checkpoint hash per ledger; later snapshots must descend from it.
6. Catch up the tail with the existing SYNC windows (section 6.6).

**L2 (R15), LATER.** Pruning breaks DAG closure for retained blocks, so it needs: (i) a causal fence, `checkpoint` with `prune` makes blocks that are neither ancestors nor descendants of C no-ops (the same machinery as `controlFor`); (ii) a table of `(h, depth)` for pruned parents still referenced by retained blocks, committed by a Merkle root, because ARCH section 6.4 needs parent depths to stay deterministic; (iii) a Merkle `root` with RFC 6962 hashing instead of the flat hash so late parents can carry inclusion proofs of about lg N hashes (G6). Trigger it by storage budget (iOS site caps, review browser-mobile M1) not CPU (G8). The UI must say that concurrent writes made before the fence are lost.

### 3.4 Erasure and redaction semantics: confirmations and gaps

**Already in v0.2 (confirm with tests):** a tombstoned block takes no effect; a `v`-less block without tombstone is only a DAG node (so it is invisible, the "pending value" case); the relay rule stops `v`-less blocks from travelling without the justifying tombstone; tombstones are final; control ops cannot be redacted.

**Gaps to close (R2, R16):**
1. **`vanish`.** Without it, erasing one person's contributions needs one tombstone per block. Semantics: ancestors-of-the-vanish-block by that author (the author's own block lists their last block in `prev`, S9, so the ancestor set is the natural "everything I signed so far"). Reuse the memoised ancestor sets.
2. **`ban` and payload purge.** v0.2 says banned authors' blocks take no effect but does not say whether honest nodes drop their `v`/`z`; the distributed-systems review (M7) wanted that. Decide explicitly; if yes, a ban must be treated as final for payloads because tombstones are final.
3. **What a tombstoned `put` reveals.** The last-writer-wins fold runs over remaining blocks, so the previous value of that key reappears. That is right for moderation, surprising for self-erasure; either document it or add a "clear key" variant.
4. **Local forgetting.** A visitor who purges `v` locally must not re-request it, and must stop advertising it (G9). Needs a local flag distinct from a signed tombstone.
5. **No free text in `tombstone`/`ban`/`vanish`** (R3), because they are permanent.
6. **Copy.** "Removed from cooperating peers"; non-cooperating copies can exist (G13).

### 3.5 Encryption (R12 sealed inbox, R14 groups, R17 retention) in v0.2 terms

- **Envelope in `v`.** A private payload op carries `v = {"enc": 1, "g": gid, "ep": n, "n": <b64url 24 B>, "ct": <b64url>}`; the salted `vh` commits to it like any value, and redaction removes the ciphertext. AEAD is XChaCha20-Poly1305 with AAD `utf8("mw-enc-v1\n" + ledgerId + "\n" + gid + "\n" + ep + "\n" + author + "\n" + seq)` so a ciphertext cannot be replayed under another author, epoch or ledger. Plaintext is padded in NIP-44-style power-of-two buckets, minimum 32 B (G24). Per-block overhead 40 B plus padding.
- **Member keys.** A member publishes an X25519 box key `bk` inside the `profile` value (`v = {name, bk}`), authenticated by the block signature. `kid = b64url(sha256(bk || gid)[:8])` so key ids differ per group (design choice to limit linkability).
- **Group state** is owner-only control ops `{t:'grp', gid, ep, wraps}`: `ep:0` creates; a later op with the same `ep` adds members (optionally with wraps for earlier epochs = "history access"); `ep+1` rotates after a removal. A wrap is `epk(32) || nonce(24) || XChaCha20-Poly1305(HKDF(ECDH(esk, bk) || epk || bk, "mw-wrap-v1"), K_ep, aad = gid||ep||kid)`, 104 B raw per member (design arithmetic). Control ops are permanent: key ids and wraps never disappear, so membership of past epochs is permanently visible as hashes.
- **Ordering.** The owner chain is the single sequencer of epochs, which satisfies MLS's requirement that "applications MUST have an established way to resolve conflicting Commit messages" (G22) without a protocol.
- **Sealed inbox (R12).** The owner publishes the current inbox public key under the owner-only key `_inbox` (`put _inbox {ep, ik}`, S9 reserves `_` keys); submitters `append` to a list `inbox` (allowed by `writers:'allow'`/`'open'`) with `v = {"enc": 2, "ep": n, "epk": ..., "n": ..., "ct": ...}` sealed to `ik` (ephemeral X25519, HKDF, XChaCha20-Poly1305, padded, AAD built like the one above with `gid` = `inbox`). Only the owner can read. **Retention (R17):** rotate `ik` on a schedule and delete old private keys after processing; ciphertext stays replicated, so key deletion, not block deletion, is the retention action (EDPB para 51: still personal data, "overtaken by time").
- **Promises to state in the UI:** relays and non-members cannot read; a removed member cannot read epochs after the rotation; no forward secrecy and no protection for content encrypted under epochs the member held (G21).
- **Libraries:** noble box, 16,823 B gzip. Do not ship libsodium (151,487 B), age per block (about 200 B overhead each) or MLS/BeeKEM in v1 (G22, G25).

### 3.6 Grants with caveats (R10)

v0.2 already has `writers:'allow'`, `allow {add, remove}`, up to 1,000 keys, moderators, and removal under the causal rule. Extend each entry with optional caveats `k` (key or list-name prefixes), `max` (value bytes) and `q` (blocks per key, counted in total order, DESIGN-REVIEW LATER "deterministic per-author quotas"). Evaluation is a pure function of the block and `controlFor(B)`; no clocks. Revocation: `allow {remove:[pub]}` governs every block by that key that is not an ancestor of the removal, including backdated ones that cite old parents. A block becomes **settled** once an owner block (for example a checkpoint) has it as an ancestor; because S9 makes `prev` include the owner's own last block, every later owner control block then also has it as an ancestor, so the seedbox's periodic checkpoint confirms recent writes against future revocation (inference). Delegation by members (UCAN-style) is deferred (R20): UCAN 1.0 states no chain-depth or size limit and its revocation spec is rc.1 (G27).

### 3.7 Anti-spam deltas (R11)

Keep 16-bit stamps as a nuisance fee and keep the published sentence ("the hashcash is a spam fee for scripts, not a security boundary", item 4). Do not add an identity-admission stamp unless per-author quotas are tiny (G34: +8% per-op cost at Q = 200). Pull forward: deterministic quotas for `writers:'open'`; subscribable signed mute lists with retraction (G33) and local hide-and-purge; relay-level scoring where Ignore carries no penalty and Reject does (G32); per-wire rate limits stay local and never become validity rules.

### 3.8 Query layer (R5)

v0.2 loads every block at startup and reduces in memory (reducer under 50 ms at 5,000 blocks). My measurements (G17) show the storage side is not the bottleneck: reading 50,000 records back takes 150-190 ms, indexed IndexedDB lookups 0.3-9 ms. I did not measure the reducer at 50k blocks. Plan: (1) now, add `mw.db.list(name, {after, limit, order})` over the in-memory arrays so sites page instead of rendering everything; (2) when caps rise above 8 MiB or phones show memory pressure, split the `blocks` store into headers and values, add `author` and `depth` indexes, load values lazily, and make tombstone a single delete in the values store; (3) SQLite WASM only as an optional module (R18). Thresholds for step 2 need phone measurements: unknown.

### 3.9 Tests to add (extends ARCHITECTURE v0.2 section 12 and DESIGN-REVIEW)

1. **Salted commitment:** tampered `z`, missing `z`, wrong `vh`, `v` over `maxValueBytes`; `redact()` removes both `v` and `z`; a stub with altered `prev` still fails `h`.
2. **Erasure convergence:** shuffled and partitioned block sets including tombstones and `vanish`, with nodes that dropped `v` and nodes that kept it: identical state hashes.
3. **Checkpoint:** snapshot missing one ancestor (orphan, `missing()` non-empty), missing the newest tombstone (checkpoint absent or orphaned), forged block (signature failure), duplicate blocks, rollback to an older checkpoint, two conflicting checkpoints at equal `n`.
4. **Storage:** kill the tab at every await of a batch; no silent loss; advertised heads after any GC equal heads before (the subduction #306 class).
5. **Causal grants:** a block concurrent with `allow {remove}` is a no-op; an ancestor survives; a backdated block citing old parents is a no-op.
6. **Encryption:** removed member cannot read the next epoch; late joiner with and without history access; AAD replay under another author fails; padding buckets.
7. **Query:** CI micro-benchmark at 50,000 blocks on Chromium and WebKit (thresholds: indexed lookup under 20 ms, bulk write under 5 s) plus a manual iOS run; reducer time at 50,000 blocks.
8. **Privacy lint:** keys and list names match the restricted charset; no control op has a free-text field; `ts` has minute precision.

---

## 4. Gotchas

1. **ARCH v0.2's `vh = sha256(canonical(v))` is unsalted, and an unsalted value hash is confirmable personal data.** EDPB para 52: salted or keyed hashes are personal data until the salt/key is deleted; unsalted or unkeyed ones are "not ... sufficient". For short values ("yes", a name, a city) anyone can test guesses against `vh` forever, because the stub keeps `vh` after the tombstone. Salt per block (`z`, 16 random bytes, travelling with `v` and deleted with it): R1. Matrix keeps an unsalted `hashes.sha256` in redacted events: a precedent for the mechanism, not for the privacy level (inference).
2. **Deleting `v` and `z` locally does not delete them from peers that kept both;** they can still prove the commitment. All copy and runbooks must say "removed from cooperating peers".
3. **If the reducer looked at local `v` presence, replicas would diverge.** v0.2 avoids it (a `v`-less block without tombstone is only a DAG node); keep it that way and test it (3.9 item 2).
4. **`v`-less blocks are a value-withholding channel.** v0.2's relay rule (only with the justifying tombstone) and bounded `WANT {h, v:true}` cover it; the PoW stamp already binds `e`, which contains `vh`, so a block cannot be minted without choosing its value.
5. **Author public keys and their signatures are identifiers** (EDPB para 80). Reusing one key across sites links content; rotating a key does not erase what it signed. Use one device key per site and keep real-world identity out of the log.
6. **The EDPB text is guidance for blockchains, applied here by analogy.** Single-entity chains are partly out of scope (para 13); our owner-moderated log sits between "permissioned" and "permissionless". CJEU C-413/23 P and the AEPD note were not retrieved (section 5).
7. **NIP-62's "legally binding in some jurisdictions" is the NIP's own sentence;** no source I read says a vanish request satisfies GDPR. Synapse's GDPR-erase leaves messages visible to earlier members. Do not copy either as a compliance claim.
8. **Compaction must never trust a summary.** automerge-repo #781 (torn write, silent drop, next compaction deletes valid data); y-indexeddb writes the snapshot and deletes old rows in separate transactions; Subduction #306 (fragment erases its own head, 8 of 8 repro runs). Test "heads before == heads after".
9. **Lossy trimming without a fence forks the log.** Hypercore increments a fork id and requires `allowFork`; Loro's "only peers with later versions can sync" statement is snippet-level and its docs were not retrievable; the Merkle-CRDT paper says pruning needs a replica-set or external source of truth.
10. **An owner key compromise is worse with checkpoints:** an attacker can sign a pruning checkpoint plus a snapshot that omits blocks. Keep v0.2's `owner` succession op and `rot=` pointer field, the checkpoint pin, and consider witnesses (P3).
11. **`root` is a set commitment, not an append-only log;** RFC 6962 consistency proofs and C2SP witnesses do not apply directly. Do not advertise witness support until the segment-root design exists.
12. **A flat sorted-hash `root` has no inclusion proofs.** It is collision-resistant and right for equality and completeness checks (it is the same function as v0.2's `Dag.root()` and `HELLO.root`), but pruning needs a Merkle tree (G6). Do not reuse sum-style sync fingerprints (negentropy, on the LATER list) as an owner commitment: its fingerprints are "short digests" tuned for efficiency (README) (inference).
13. **Sedimentree's design doc is inconsistent** (leading vs trailing zeros, base 10 vs hex) and I found no "10%" overhead figure in it (a search summary claimed one; unconfirmed). Treat all numbers about it as unverified.
14. **IndexedDB on WebKit is slower to write with indexes** (2.1 s vs 1.0 s for 50k ops in my runs, both M3 desktop). Batch writes; do not await foreign promises inside a transaction; `performance.now()` is rounded to 1 ms in WebKit; `getAllRecords` is Chrome 141 / Firefox 153 only (Safari "preview").
15. **SQLite WASM pitfalls:** `opfs` VFS needs COOP/COEP; Safari < 17 is incompatible with it; `opfs-sahpool` has no multi-connection support; Node supports in-memory only; the shipped JS glue is 642 KB unminified (67 KB gzip minified) plus a 402 KB gzip wasm.
16. **Dependency traps:** `ts-mls` 1.6.4 pins exact peers that conflict with current noble (ERESOLVE); it is unaudited; Keyhive/Subduction are explicitly not for production; `age-encryption` has no stability or audit statement on its README; `wa-sqlite` on npm is `1.0.0` from 2024-01-05 only.
17. **XChaCha20-Poly1305 is not in WebCrypto** (the WICG draft lists ChaCha20-Poly1305 and Argon2 but has no shipping status in MDN data). AES-GCM with random 96-bit nonces has a per-key message limit far below what XChaCha's 192-bit nonce allows (model knowledge, not re-verified here); keep XChaCha via noble.
18. **NIP-44 is HMAC-based, not an AEAD, and has no forward secrecy or post-compromise security;** copy its padding, not its group story.
19. **Time in capabilities is a trap:** UCAN marks `exp` required in one table and RECOMMENDED in another section; Meadowcap's removal-by-future-timestamp lets any clock error win until it is overwritten. ARCH v0.2 uses the causal rule instead.
20. **PoW arithmetic:** a one-time identity stamp barely moves the attacker's per-op price (G34); a stamp phones can finish in seconds is milliseconds for a GPU.
21. **Argon2 timings are main-thread blocking JS** (45 ms for 16 MiB on an M3); run in Workers; iOS memory limits for 16+ MiB allocations are unmeasured.
22. **Spec ambiguity found while mapping (ARCH v0.2 section 6.5).** `controlFor(B)` folds control blocks C with B not in `ancestors(C)` and the text says this is also how a later `ban` or `tombstone` reaches a block; read literally, a tombstone or ban whose target is an ancestor would never apply. Presumably tombstone and ban are exempt from the ancestor filter; confirm and add a test (R2).
23. **Control ops are permanent.** `ban`, `allow`, `grp` and `checkpoint` live inside `e` and cannot be redacted: they hold keys, hashes and ciphertext forever. Keep names, reasons and free text out of them (R3).
24. **A checkpoint block cannot commit to the file that contains it** (circular). Commit to the block set (`n`, `root`), not to a file hash.
25. **Evidence limits of this run:** WebSearch budget ran out; phone numbers are not measured; Firefox did not launch under Playwright; Loro's website returned 403; the AEPD PDF, EUR-Lex and Anubis docs returned stubs or errors.

---

## 5. Open questions

1. **Hidden-op semantics for `put`:** is "hidden equals absent" (older value reappears) acceptable when a user erases their latest value, or do we need a "key cleared" tombstone variant? (3.4 gap 3)
2. **Commitment form:** per-op random salt (chosen) vs an author-held keyed commitment that lets the author prove ownership later. Which gives the simpler erasure runbook?
3. **Forward-compat rule for unknown control ops** (`t` values this build does not know): invalid block, or valid and ignored? Decide before the freeze (R6).
4. **Keys and list names are permanent** (inside `e`) and drive last-writer-wins routing: is a restricted charset plus SDK warnings (R3) enough, or should the SDK hash user-supplied keys for sites that key by names or e-mail addresses?
5. **Checkpoint cadence and size caps:** what is the right trigger and maximum snapshot size for phones on cellular (review section 5 says sync should stop at 2 MiB on `saveData`)?
6. **Pruning UX and recovery (R15):** who may prune, how does an owner undo an accidental pruning checkpoint, and how are offline authors told that their writes were dropped?
7. **Witnessing:** is an append-only segment-root log (R19) worth the complexity, and who would run witnesses for small sites?
8. **Phone measurements still needed:** IndexedDB insert with indexes on iOS Safari and Android Chrome; ECDSA P-256 verify (WebCrypto; Ed25519 only if it is ever adopted); specialised SHA-256 loop; Argon2id memory limits and thermal throttling; SQLite `opfs-sahpool` on iOS. Doc 06 Appendix B already has a single-file calibration page for hashing.
9. **COOP/COEP for SQLite `opfs`:** can the loader's Service Worker inject the headers without breaking the sandboxed iframe, WebRTC or the `blob:` rendering path? Unverified; DESIGN-REVIEW's LATER list already carries "Cross-origin isolation (COOP/COEP) for hosted sites (R04 R8)".
10. **Legal scope (not legal advice):** controller roles for the site owner and for visitors who replicate; whether an author public key in a header is personal data for third-party recipients (CJEU C-413/23 P, 4 September 2025, was not retrievable here: **unverified**); the AEPD erasure proof-of-concept note (EDPB footnote 49) was not read; whether a NIP-62-style vanish is sufficient in practice; non-EU regimes relevant to the owner's jurisdiction (not researched).
11. **Not fetched because the search budget ran out:** Matrix moderation policy lists, Megolm, SSB private-box, Kleppmann-style papers on access control and Byzantine CRDTs, RFC 9106 (Argon2) security claims, RLN proof-generation time in browsers and any owner-managed (chain-free) RLN registry design. Ask for a follow-up run if these matter.
12. **Rollback by a consistent older snapshot (3.3):** should the signed pointer name the newest checkpoint hash (`ck=`) so a first-time visitor with no peers can detect it, accepting a pointer republish per checkpoint?
13. **Ban and tombstone decisions (3.4):** do banned authors' `v`/`z` get dropped; what does a tombstoned `put` reveal (previous value); do we want a "clear key" variant?
14. **Snapshot hosting:** HTTPS-only (`cs=`) or also a torrent (a second swarm and trackers; v0.2 already has a deterministic anchor torrent per ledger, S1, which could carry it)?
15. **L2 depth table:** is the `(h, depth)` table for pruned parents (3.3) acceptable in size, or can retained blocks be re-rooted at a checkpoint without breaking determinism of `depth`?
16. **Deterministic CBOR vs JCS for headers** (size and speed): still not evaluated (doc 06 open question 15).
17. **Real-device matrix for this document's claims:** Firefox and Safari 18/26/27 on hardware; the Playwright WebKit build is not Safari.

---

## 6. Sources

**Read in full or in the relevant sections (primary, fetched 2026-10-17 unless noted):**
EDPB Guidelines 02/2025 v2.0 PDF and page (adopted 07 July 2026); Matrix spec: server-server API "Signing events" (v1.19 living), room v11, room v12, Project Hydra post (2025-08-14); Bamboo README; Buttwoo spec; p2panda-core 0.7.1 docs.rs; Willow data model, Meadowcap ("Final (as of 21.11.2025)"), Private Interest Overlap; Hypercore README; Automerge storage doc and Automerge 3.0 post (July 2025); automerge-repo issue #781 (2026-10-05); Yjs document-updates docs; y-indexeddb source; Loro `ExportMode` docs.rs (1.13.9); Subduction README and issue #306 (2026-09-21); Beelay `docs/sedimentree.md`; C2SP `tlog-checkpoint`, `tlog-witness`, `age`; Russ Cox "Transparent Logs for Skeptical Clients"; ethereum.org weak subjectivity; Keyhive notebook index, entries 01 and 06 (2026-07-31); RFC 9420 (abstract, section 14); NIP-09, NIP-44, NIP-62 (updated 2026-06-13); Synapse user admin API; ePrint 2016/757; ATProto labels spec; libp2p GossipSub v1.1; Waku RLN v2 post (2024-07-10) and arXiv 2207.00117 (2022-07); UCAN spec, delegation (1.0.0) and revocation (v1.0.0-rc.1) READMEs; Biscuit site; OrbitDB ENCRYPTION.md and DATABASES.md; negentropy README; typage and ts-mls READMEs; SQLite WASM persistence page; WICG modern algorithms draft (2026-09-14); wa-sqlite README; CNIL page (2018, OLD); MDN browser-compat-data files for IndexedDB, StorageManager, FileSystemSyncAccessHandle, SubtleCrypto.
Local: npm registry queries and bundle-size builds (esbuild 0.28.2) for `@sqlite.org/sqlite-wasm`, `age-encryption`, `@noble/*`, `libsodium-wrappers`, `hpke-js`, `idb`, `dexie`; benchmark in Playwright Chromium and WebKit (Appendix A).
Local project documents read: `docs/ARCHITECTURE.md` v0.2 (sections 4, 5.5, 6.1-6.8, 10, 12), `docs/INTERFACES.md` (`block.js`, `dag.js`), `docs/review/DESIGN-REVIEW.md` (items 1-4, S2, S9, LATER list), `docs/review/distributed-systems.md`, `docs/review/security.md`, `docs/research/06-browser-chain-vs-crdt.md`, and the headline sections of `w2b-06-abuse-legal-ops.md`.
Doc 06 findings reused: F10, F15, F21, F32, F34, F35, F36-F39, F44, F45, F47, F54 (their sources are listed there).

**Search-result snippets only (not confirmed against a page):** Loro shallow-snapshot "only nodes holding later versions can keep syncing" (loro.dev returned HTTP 403); `iso-ucan` audit issue #648 on revocation; the "10%" metadata-overhead claim for Subduction; Matrix "Phase 2 / State DAGs (MSC4242)" status.

**Attempted and failed or empty (do not cite):** AEPD "Tech-note-blockchain.pdf" (returned an HTML stub), EUR-Lex CELEX 62023CJ0413 (empty), `anubis.techaro.lol` docs (Access Denied page; the GitHub raw Anubis page was read instead: default "5 leading zeroes"), npmjs.com package pages (403), loro.dev (403), wa-sqlite VFS comparison table (not reached).

---

## Appendix A - raw measurements (2026-10-17)

Machine: MacBook Air, Apple M3, 8 cores, macOS 27.0, Node 24.22.0. Browsers: Playwright Chromium `HeadlessChrome/156.0.8078.4`; Playwright WebKit (UA `Version/27.2 Safari/605.1.15`). 50,000 ops, 618 B JSON each, 200 authors, 5,000 puts per IndexedDB transaction, SQLite in-memory. Medians as in the table in G17.

Chromium raw (ms): IDB indexed insert 993.6; IDB no-index insert 562.4; IDB full scan 192 (median of 5); IDB latest50 0.6; byAuthor 1; countPosts 0.7; getAllRecords 0.3; SQLite init 24.8, insert 609.2, full scan 218.9, latest50 0.2, byAuthor 1.2, count 1.2; Argon2id 4 MiB/t1 11.4, 16 MiB/t1 44.9, 19 MiB/t2 105.5.
WebKit raw (ms): IDB indexed insert 2095; no-index 958; full scan 150; latest50 2; byAuthor 2; count 9; SQLite init 23, insert 342, full scan 206; Argon2id 12 / 48 / 110.

Bundle sizes (esbuild 0.28.2, `--bundle --minify --format=esm --platform=browser --target=es2022`; gzip -9 / brotli q11): see G25 and G18. SQLite WASM: `sqlite3.wasm` 868,907 / 402,035 / 348,812 B; minified `index.mjs` 217,850 / 66,602 / 58,224 B.

Derived: 8 MiB / 618 B = 13,574 ops; 64 MiB / 618 B = 108,590 ops; verification at 34k/s (WebCrypto) and 2.4k/s (noble) from doc 06 F47.

## Appendix B - reproduction

Files are copied to `docs/research/labs/w2c-02-lab/` (see `RUN.txt` there): `bench/index.html` (benchmark page), `bench-server.mjs`, `bench-run.mjs`, `sizes.sh`, `entries/*.mjs`, and the raw JSON results. They need `npm install --ignore-scripts` of the pinned packages in a separate directory (never inside the repo's `node_modules`), then the commands in `RUN.txt`.
