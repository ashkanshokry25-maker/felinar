# w2c-02 VERIFY - skeptical fact-check of "Chain / database production features"

**Target:** `docs/research/w2c-02-chain-production-features.md` (research date 2026-10-17), eight design-critical claims relayed by the workflow harness.
**Check date:** 2026-10-17 (about 21:20 to 22:10 UTC). **Checker stance:** try to refute or narrow each claim; re-open every cited primary source; replicate or extend every measurement the claim leans on.
**Evidence kept:** scripts and raw JSON in `docs/research/labs/w2c-02-verify-lab/` (see section 11). Downloaded sources were kept in a session scratchpad (not in the repo).
**Nothing here is legal advice.**

---

## 0. Result at a glance

| # | Claim (short) | Verdict | The correction that matters |
|---|---|---|---|
| 1 | Three history tiers: L0 lossless packing, L1 payload removal with signed skeleton, L2 explicit coordinated lossy trimming | **nuanced** | The facts about each system hold. But "none prune history" is false for Yjs in its default configuration (`gc` is on, so y-indexeddb's trim discards deleted content); "coordinated" fits Loro and Hypercore but not p2panda or Willow (in-band deterministic rules); Hypercore `truncate` cuts the newest blocks (a rollback), not old history; the taxonomy is a synthesis, not exhaustive. |
| 2 | Lossy trimming needs a fence: Hypercore fork id + `allowFork`, Merkle-CRDT paper, Loro (snippet-level) | **nuanced** | Hypercore's `allowFork` defaults to **true** (opt-out), so "requires allowFork / explicit opt-in on the receiving side" is inverted. The Loro statement is no longer snippet-level: docs.rs (`loro` 1.16.2) and the loro.dev concept page both say it. The Merkle-CRDT paper only offers an "intuitive note" for "future work" (2020). |
| 3 | C2SP tlog-checkpoint / tlog-witness details; RFC 6962 proofs need an append-only tree | **confirmed** | Every wire-level detail checks out. Both specs are **v1.1.0, dated 2026-10-07** (the original said "no date shown"). ECDSA P-256 is not one of the checkpoint algorithms the spec defines. |
| 4 | Owner checkpoint block listing all heads makes a snapshot complete iff all ancestors are present | **nuanced** | Structurally sound. But tip completeness covers only blocks that are ancestors of the latest checkpoint (a newer tombstone or ban can still be dropped silently); it covers the DAG skeleton, not payloads (`v`); the right predicate is "C accepted, not orphan", not a global `Dag.missing()`; `(n, root)` is a redundant check. |
| 5 | Cold start cheap: 150-192 ms read; 13.6k blocks verify in about 0.9 s on an M3; 2.7-9 s on phones | **nuanced** | Numbers match the raw JSON and the arithmetic is right. But: ephemeral (private-browsing-style) contexts; WebKit verifies P-256 about 1.5x slower than Chromium (doc 06 F47 is Chromium-only); the 8 MiB cap holds 15.8k-22.0k real blocks under the implemented byte accounting, not 13.6k; through the project's own `validateBlock` and default 2-worker pool 13.6k blocks take 0.96 s (Chromium) / 1.14 s (WebKit); the phone leg is unverifiable here. |
| 6 | Matrix: signs redacted form + content hash; mismatch -> redact; redaction keeps DAG fields; redacted events still affect state; unsalted hash | **confirmed** | All five sub-claims match spec v1.19 and rooms v11/v12 text. Extra precedent the original missed: a redacted state event *blanks* the property instead of reverting to the previous value; Synapse keeps the unredacted copy for 7 days by default. |
| 7 | EDPB Guidelines 02/2025 v2.0 (07 July 2026), paras 50-53, 80, 104 | **nuanced** | Every paragraph number and quote exists. Two paraphrases are stronger than the text: para 52 says a salted/keyed hash "will also be considered personal data" with **no** "until the salt or key is deleted"; "unsalted ... not sufficient" is hedged ("in general", "public blockchain"). |
| 8 | 50k-record IndexedDB / SQLite WASM numbers; reducer + plain IndexedDB sufficient | **nuanced** | Numbers match the JSON and replicate on Chromium. But "three compound indexes" is two compound + one single-key; inserts are single-shot (WebKit insert ranged 2.1-3.3 s over four runs); contexts were ephemeral (persistent-profile Chromium insert 2.9-3.8 s); the reducer was never benchmarked. |

Also found while checking (section 9): the original's statement that y-indexeddb writes the snapshot and deletes old rows "in a separate, non-atomic transaction" is **refuted** by experiment (one transaction in Chromium 156 and WebKit 27.2).

---

## 0.1 Method and limits

- **Method.** Each cited URL was fetched directly with `curl` and saved raw (then converted to text and grepped for the exact wording); PDFs via `pdftotext`; the EDPB track-changes `.docx` was unzipped in a separate directory; npm packages were installed with `--ignore-scripts` outside the repo. Where a claim depends on behaviour (Hypercore `allowFork`, Yjs GC, y-indexeddb transactions, verification cost, ephemeral vs persistent IndexedDB) I wrote and ran a test.
- **Limit 1: no fresh web searches.** The shared WebSearch budget ("limit: 200 WebSearch calls per turn, shared by every agent in it") was already used up: all four searches I attempted were refused, and I did not work around it. Everything below comes from direct fetches of known primary-source URLs, local files and local experiments. Consequences: I could not look for newer literature (for example a Matrix MSC about salted redaction hashes) or for phone benchmark data.
- **Limit 2: loro.dev.** It answers non-browser clients with a Cloudflare challenge (HTTP 403, "Just a moment..."), reproducing the original's problem. I read the loro.dev concept page from a Wayback Machine snapshot (`web.archive.org/web/20261002155214/https://loro.dev/docs/concepts/shallow_snapshots`) that I fetched before I learned the search budget was gone. I treat it as secondary. The Loro conclusion in claim 2 stands on docs.rs alone.
- **Limit 3: devices.** No phone was measured. Firefox does not launch under Playwright here ("Could not find profile folder"), same as in the original run. "WebKit 27.2" is Playwright's WebKit build (UA `Version/27.2`), not Safari.
- **Limit 4: noise.** The Mac (MacBook Air, Apple M3, 4P+4E cores, 24 GB, macOS 27.0) was shared with other agents' jobs during my runs (load average about 6 on 8 cores). Absolute timings are indicative; same-run comparisons are more reliable. Run-to-run spread is reported where I repeated.
- **Dates.** Living specs have no single date; I give the version line shown on 2026-10-17. Older sources are flagged OLD.

---

## 1. Claim 1 - the three history tiers

> **Claim (verbatim).** History handling splits into three tiers: L0 lossless packing (Automerge snapshot+incremental chunks, Yjs mergeUpdates, y-indexeddb trims at 500 updates; none prune history), L1 payload removal with a verifiable signed skeleton, and L2 explicit coordinated lossy trimming (Loro ShallowSnapshot, p2panda PruneFlag, Willow prefix pruning, Hypercore truncate with a new fork id).
> *Their confidence: high.*

**Verdict: nuanced.** Every named mechanism exists and behaves as described. The grouping, "none prune history" and "coordinated" are not right as stated. *My confidence: high on the facts below (primary text read and, for Yjs and y-indexeddb, executed); medium on the taxonomy critique, which is judgement.*

### What holds
- **Automerge storage** (`automerge.org/docs/reference/under-the-hood/storage/`, footer "Copyright 2026 Automerge contributors"): keys are `[<document ID>, <chunk type>, <chunk identifier>]`, chunk type `"snapshot"` or `"incremental"`, the id is "the heads of the document at compaction time or the hash of the change bytes". "Occasionally automerge-repo will decide that it's time to 'compact' the document ... and combine them into a single snapshot". Compaction "only deletes data which is incorporated into the compacted document". A snapshot here is a save of the whole document, so history is kept.
- **Automerge 3.0** (post dated July 2025): "Automerge stores the full history of documents"; memory "cut ... down by over 10x"; "pasting Moby Dick into an Automerge 2 document consumes 700Mb of memory, in Automerge 3 it only consumes 1.3Mb". I grepped the two newer monthly posts (July and August 2026) for prune, garbage, truncat, compact, shallow, trim, history, forget, delete, erase, redact, sedimentree and subduction: the August post has no hit, and the July hits are about Subduction performance, Sedimentree and Hexane. Nothing mentions removing history. So "Automerge does not prune history" holds as of August 2026.
- **Yjs `mergeUpdates`** (`docs.yjs.dev/api/document-updates`): "this feature only merges document updates and doesn't garbage-collect deleted content. You still need to load the document to a Y.Doc to reduce the document size."
- **y-indexeddb** (`master/src/y-indexeddb.js`): `export const PREFERRED_TRIM_SIZE = 500`; `_storeTimeout = 1000` (debounced with `clearTimeout`); `storeState` adds `Y.encodeStateAsUpdate(doc)` then deletes the older rows. The npm release `y-indexeddb@9.0.12` (published 2023-11-02) differs from master by one comment typo ("untill"), so the code is unchanged for about three years.
- **Loro** `ExportMode::ShallowSnapshot` (docs.rs `loro-internal 1.13.9`, published 01 August 2026): "The shallow snapshot only contains the history since the target frontiers"; `StateOnly`: "It's a shallow snapshot with depth=1 at the target version". The public `loro` crate is at **1.16.2** (crates.io, updated 2026-09-21) and its `ExportMode` text is identical.
- **p2panda-core 0.7.1** (docs.rs, 21 August 2026): `prune::PruneFlag` - "Flag indicating that all preceding operations in a log can be deleted"; module text below. Also `validate_prunable_backlink`: "Alternative backlink validation method for logs which allow pruning."
- **Willow data model** (Status: Final): the store rule "there are no two of its Entries old and new such that old.subspace_id == new.subspace_id, and new.path is a prefix of old.path, and new is newer than old", enforced by the join: "remove all Entries with a path p whose timestamp is strictly less than the timestamp of any other Entry of the same subspace_id whose path is a prefix of p."
- **Hypercore** (`holepunchto/hypercore` main, `package.json` 11.39.0): `await core.truncate(newLength, [options])` - "Per default this will update the fork id of the core to + 1 ... Note that the fork id should be monotonely incrementing."
- **L1 evidence.** p2panda: the header/body split "allows deletion of payloads without breaking the integrity of the append-only log". Willow `Entry` carries `payload_length` and `payload_digest`.

### Corrections and nuances
1. **"None prune history" is false for Yjs in its default configuration.** `new Y.Doc().gc === true` (Yjs 13.6.33). Yjs docs: "doc.gc ... Set doc.gc = false to disable garbage collection and be able to restore old content." `INTERNALS.md`: "If garbage collection is enabled in Yjs, when an object is deleted its content is discarded." y-indexeddb's trim stores `Y.encodeStateAsUpdate(doc)` of a live doc, so it discards deleted content. I ran it (`results/yjs-gc-test.json`): insert 35,000 characters, delete them all, type "visible".
   | Encoding | gc = true (default) | gc = false |
   |---|---|---|
   | `Y.mergeUpdates(updates)` (the L0 operation) | 35,043 B, still contains the deleted text | 35,043 B, contains it |
   | load into `Y.Doc` then `encodeStateAsUpdate` (what y-indexeddb's trim stores) | **43 B, deleted text gone** | 35,043 B, contains it |
   So `mergeUpdates` is L0, but the 500-row trim is **L1-like** (payload of deleted items removed, item structure kept, no signature). It does not make old ops unmergeable, which is why it is not L2 either.
2. **"Coordinated" fits only two of the four L2 examples.** Loro's own page says "Coordinate before trimming: Ensure all peers synchronized" (archived loro.dev page, see claim 2) and Hypercore needs the writer to bump a fork. p2panda's `PruneFlag` is an author-signed in-log marker: "When operations arrive on a peer using p2panda-stream ... garbage collection will automatically occur and eventually data will be removed network-wide. The process by which eligible prune points are established is an application layer concern." Willow's prefix pruning is a deterministic CRDT join rule (timestamp-based) that every replica applies on receipt; it needs no coordination, only trust in timestamps. These two are *in-band deterministic* rules, the closest analogue of ARCH v0.2's causal `controlFor` rule.
3. **Hypercore `truncate` is not history trimming.** It shortens the log from the **end** (newest blocks) and forks it, a rollback or rewrite. Dropping old blocks in Hypercore is `core.clear(start, [end])`, which only "reclaim[s] storage" locally ("clear block 4 from your local cache") while "The core will also gossip to peers it is connected to, that is no longer has these blocks" (sic). So Hypercore is a precedent for the *fence* (a signed fork id), not for compaction semantics. Willow's prefix pruning is likewise a delete rule rather than log compaction; its own page describes it as "overwriting a directory in a file system with an empty file".
4. **The taxonomy is a synthesis, not exhaustive.** Automatic, local, uncoordinated lossy stemming exists: CouchDB's `_revs_limit` "sets the maximum number of document revisions that will be tracked by CouchDB, even after compaction has occurred" (docs show a GET example returning 1000; I did not find the default stated on that page). Synapse's `redaction_retention_period` (default `7d`) is another automatic step. A tier for "automatic local GC of deleted payloads" (Yjs, CouchDB) would fit the evidence better than forcing them into L0.

### Exact correction text (replaces the G1 L0/L2 bullets)
- L0: Automerge snapshot+incremental chunks and Yjs `mergeUpdates` keep all history. Yjs with the default `gc: true` additionally discards the content of deleted items whenever a state is re-encoded from a live `Y.Doc`, which is what y-indexeddb's 500-row trim does; the item structure survives, so later merges still work. Classify that as L1-like.
- L2: Loro `ShallowSnapshot` (peers lacking later history cannot import; docs say coordinate first) and p2panda `PruneFlag` / Willow prefix pruning (in-band, deterministic) trim old history; Hypercore `truncate` instead removes the newest blocks under a new fork id (readers follow forks by default) and is only a fence precedent.

### Sources
Automerge: https://automerge.org/docs/reference/under-the-hood/storage/ , https://automerge.org/blog/automerge-3/ , https://automerge.org/blog/2026-july/ , https://automerge.org/blog/2026-august/ . Yjs: https://docs.yjs.dev/api/document-updates , https://docs.yjs.dev/api/y.doc , https://raw.githubusercontent.com/yjs/yjs/main/INTERNALS.md . y-indexeddb: https://raw.githubusercontent.com/yjs/y-indexeddb/master/src/y-indexeddb.js . Loro: https://docs.rs/loro-internal/1.13.9/loro_internal/encoding/enum.ExportMode.html , https://docs.rs/loro/latest/loro/enum.ExportMode.html . p2panda: https://docs.rs/p2panda-core/latest/p2panda_core/ , https://docs.rs/p2panda-core/latest/p2panda_core/prune/index.html . Willow: https://willowprotocol.org/specs/data-model/index.html . Hypercore: https://raw.githubusercontent.com/holepunchto/hypercore/main/README.md . CouchDB: https://docs.couchdb.org/en/stable/api/database/misc.html . Synapse: https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html .

---

## 2. Claim 2 - lossy trimming needs a fence

> **Claim (verbatim).** Lossy history trimming needs a fence so that ops not descending from the trim point stop being mergeable: Hypercore truncate increments a fork id and requires allowFork, the Merkle-CRDT paper says pruning needs replica-set knowledge or an external source of truth; Loro's 'only peers with later versions can sync' statement is snippet-level only (loro.dev returned 403).
> *Their confidence: medium.*

**Verdict: nuanced.** One of the three supports is factually inverted (Hypercore `allowFork`), one is correctly quoted but weaker than presented (the paper), and the one they marked "snippet-level only" is now confirmed by primary documentation. The principle itself (a trim needs a fence or prior coordination) is well supported. *My confidence: high.*

### Hypercore: `allowFork` is on by default
- README `truncate`: "Per default this will update the fork id of the core to + 1 ... the fork id should be monotonely incrementing." README `core.signable([length], [fork])` returns a buffer that "encodes the core's key, tree hash, length, & fork", so the fork id is part of what the writer signs.
- README option listing: `allowFork: true, // Enables updating core when it forks`. The code settles the default. `index.js` (line 1418 at fetch): `allowFork: opts.allowFork !== false,`. `lib/replicator.js` constructor: `allowFork = true,`. Only when it is `false` does `_addReorg()` return `null` and `_updateFork()` return `false`, so the peer never follows a higher fork.
- Therefore a Hypercore reader **follows a truncation fork by default** and refuses only if constructed with `allowFork: false`. "Requires allowFork" / "an explicit opt-in on the receiving side" (G2) is the wrong way round. The fence still exists (the fork id is signed and monotone, readers can refuse) but it is weaker by default than described.

### Merkle-CRDT paper (arXiv:2004.00107v2, 27 Apr 2020, OLD)
The quote is faithful: "We leave the topics of DAG compaction and garbage collection for future work, although we intuitively note that discarding parts of the Merkle-DAG should not be attempted before making sure that every replica is aware of them. This, in turn, requires either having knowledge of the current replica-set or using an external source of truth (i.e. a blockchain), a system constraint that we did not have before." Two limits: it is an explicit *intuition* deferred to future work, and it argues for **coordination before discarding**, not for a post-trim fence. Citing it as a third mechanism for "ops not descending from the trim point stop being mergeable" stretches it.

### Loro: no longer snippet-level
- docs.rs `loro` 1.16.2 `LoroDoc::export`: "[ExportMode::shallow_snapshot(..)]: GC'd snapshot starting at frontiers" and "**Shallow snapshots: peers cannot import updates from before the shallow start.**" The `LoroError` enum has the variants `ImportUpdatesThatDependsOnOutdatedVersion` and `SwitchToVersionBeforeShallowRoot`; `LoroDoc::is_shallow` ("Check if the doc contains the full history"); `revert_to` documents: "If the document is shallow and the target is before the shallow start, revert will fail."
- loro.dev concept page (now `/docs/concepts/shallow_snapshots`, previously `/docs/advanced/shallow_snapshot`; read from the Wayback snapshot of 2026-10-02, see limit 2): "Synchronization Limitations - Important: Peers can only sync if they have versions after the shallow snapshot point." and under Best Practices "Coordinate before trimming: Ensure all peers synchronized". The same page markets shallow snapshots for privacy ("Sensitive data permanently removed from history" after deleting and re-exporting), which is a different erasure model from ARCH v0.2's tombstones.

### Other fences that need no out-of-band step
p2panda: the prune marker is in-log and `validate_prunable_backlink` validates logs whose prefix is gone. Willow: the timestamp join rule drops any older entry under a pruned prefix when it arrives. Both are single-writer or timestamp-ordered, so neither faces the multi-writer problem ARCH v0.2 has (concurrent offline authors); the closest analogue remains the causal `controlFor` rule, as the original says.

### Exact correction text
"Hypercore: a truncation bumps a fork id that is covered by the signed tree head; readers follow a higher fork **by default** (`allowFork` defaults to true) and refuse it only with `allowFork: false`. Merkle-CRDT paper: an intuition (future work, 2020) that discarding needs knowledge of the replica set or an external source of truth; it is a coordination requirement, not a fence. Loro: confirmed in primary docs: shallow-snapshot peers cannot import updates from before the shallow start (`LoroError::ImportUpdatesThatDependsOnOutdatedVersion`); docs advise coordinating first."

### Sources
https://raw.githubusercontent.com/holepunchto/hypercore/main/README.md , https://raw.githubusercontent.com/holepunchto/hypercore/main/index.js , https://raw.githubusercontent.com/holepunchto/hypercore/main/lib/replicator.js , https://arxiv.org/abs/2004.00107 (PDF https://arxiv.org/pdf/2004.00107) , https://docs.rs/loro/latest/loro/struct.LoroDoc.html , https://docs.rs/loro/latest/loro/enum.LoroError.html , https://loro.dev/docs/concepts/shallow_snapshots (403 to scripts; archived copy https://web.archive.org/web/20261002155214/https://loro.dev/docs/concepts/shallow_snapshots) , https://docs.rs/p2panda-core/latest/p2panda_core/prune/index.html , https://willowprotocol.org/specs/data-model/index.html .

---

## 3. Claim 3 - C2SP tlog-checkpoint and tlog-witness

> **Claim (verbatim).** C2SP tlog-checkpoint defines the signed-note checkpoint (origin, size, root hash, signatures after a blank line) and tlog-witness defines cosigning with consistency proofs (409 for wrong old size, 422 for bad proof or root mismatch, persist before responding, MUST NOT cosign inconsistent checkpoints). RFC 6962 consistency proofs need an append-only tree, which a sorted-hash commitment over a DAG is not, so witnessing is not directly available.
> *Their confidence: high.*

**Verdict: confirmed.** Every wire-level detail is in the text; the reasoning about append-only trees is correct. Notes below are refinements. *My confidence: high.*

### Evidence
I read the editor's copies (`raw.githubusercontent.com/C2SP/C2SP/main/...md`) and the stable renderings that `c2sp.org/tlog-checkpoint` and `c2sp.org/tlog-witness` redirect to: **both are "v1.1.0 (2026-10-07)"** (tlog-checkpoint lists versions v1.1.0, v1.0.0, v1.0.0-rc.1; tlog-witness lists v1.1.0, v1.0.0, v1.0.0-rc.1, v0.1.0). The two renderings agree on everything below.
- **tlog-checkpoint.** "A checkpoint is a signed note where the body is precisely formatted for use in transparency log applications." Note text: line 1 the log's **origin**, line 2 the **tree size** "encoded as an ASCII decimal", line 3 the **root hash**, "the base64 encoding of the root of the RFC 6962 Merkle hash tree at the specified tree size"; extension lines optional and "NOT RECOMMENDED". "As a signed note, the note text described above is followed by an empty line, and one or more signature lines." And: "A log or cosigner MUST NOT sign any checkpoint which is inconsistent with any checkpoint it previously signed."
- **tlog-witness `add-checkpoint`.** Body = `old <size>` line, up to 63 consistency-proof lines ("The client MUST NOT send more than 63 consistency proof lines"), an empty line, then the checkpoint. "If it doesn't match, the witness MUST respond with a '409 Conflict'" when the old size differs from the size of the latest checkpoint it cosigned (body: that size, `Content-Type: text/x.tlog.size`). **422** when a Merkle consistency proof "doesn't verify", when the proof is non-empty with old size 0, when a size-0 checkpoint lacks the empty-tree hash, and "If the old size matches the checkpoint size, the witness MUST check that the root hashes are also identical. If they don't match, the witness MUST respond with a '422 Unprocessable Entity'". "The witness MUST persist the new checkpoint before responding" (with an atomicity note describing the rollback race). The witness "MAY log the request even if the checkpoint fails one of the consistency checks above (but MUST NOT cosign the checkpoint), as it might be proof of log misbehavior." Other codes: 400 (old size greater than size), 403 (no valid trusted signature), 404 (unknown origin).
- **RFC 6962 section 2.1.2** (fetched from rfc-editor.org): "Merkle consistency proofs prove the append-only property of the tree. A Merkle consistency proof for a Merkle Tree Hash MTH(D[n]) and a previously advertised hash MTH(D[0:m]) of the first m leaves, m <= n, is the list of nodes in the Merkle tree required to verify that the first m inputs D[0:m] are equal in both trees." A flat `sha256(concat(sorted hashes))` is not a tree over a list whose first m leaves stay fixed (a new hash that sorts in the middle shifts every later leaf), and ARCH's depth-window digests `dg(k)` also change when a late concurrent block lands in an old window. So no consistency proof can exist for them.

### Refinements
1. **Dates.** The original recorded "no date shown"; the stable pages show v1.1.0 dated 2026-10-07, ten days before the research. Cite the version.
2. **Where "MUST NOT cosign" lives.** The general rule ("MUST NOT sign any checkpoint which is inconsistent ...") is in tlog-checkpoint and binds logs and cosigners; tlog-witness repeats it for failed checks ("but MUST NOT cosign the checkpoint").
3. **Algorithms.** The checkpoint spec defines three note signature algorithms: ML-DSA-44 checkpoint cosignatures ("SHOULD be used"), Ed25519 log signatures (no timestamp) and Ed25519 checkpoint cosignatures; tlog-witness says "Witnesses SHOULD use ML-DSA-44". ARCH v0.2's owner key is **ECDSA P-256**. `signed-note` v1.1.0 does register type `0x02` ("ECDSA signatures as implemented by github.com/transparency-dev/witness", curve "SHOULD be NIST P-256"), but tlog-checkpoint does not list it among the algorithms defined for checkpoints. So a P-256-signed checkpoint block borrows the *text format*; it would not be a conforming C2SP checkpoint without an extra definition.
4. **"Not directly available" is right, with an indirect path.** A witness checks only append-only consistency, never contents. An owner-kept append-only list whose leaves are successive checkpoint-block ids (the original's option (b)) can be witnessed unchanged and would detect split views of the *checkpoint sequence*, not of DAG contents. tlog-witness also defines an optional `sign-subtree` call (not needed here).

### Sources
https://c2sp.org/tlog-checkpoint (redirects to @v1.1.0) , https://c2sp.org/tlog-witness (redirects to @v1.1.0) , https://raw.githubusercontent.com/C2SP/C2SP/main/tlog-checkpoint.md , https://raw.githubusercontent.com/C2SP/C2SP/main/tlog-witness.md , https://raw.githubusercontent.com/C2SP/C2SP/main/signed-note.md , https://www.rfc-editor.org/rfc/rfc6962.txt .

---

## 4. Claim 4 - owner checkpoint block over all heads

> **Claim (verbatim).** Design inference: because a Merkle-DAG block commits to its whole causal past through prev, an owner checkpoint block that lists all heads makes a snapshot complete exactly when every ancestor is present (Dag.missing() empty). The checkpoint adds tip completeness (a host cannot silently drop the newest tombstone or ban), a rollback anchor and the commitment pruning needs later; it cannot commit to the hash of the file that contains it (circular), so it commits to the block set (n, root). It does not stop a consistent older snapshot served to a first-time visitor with no peers.
> *Their confidence: medium.*

**Verdict: nuanced.** The core inference is sound. Two of the stated benefits are overstated as phrased and one predicate is imprecise. *My confidence: high on the logic (derived from the v0.2 text, no code exists yet), medium on how it plays out in an implementation.*

### What I checked
- **Commitment.** ARCH v0.2 section 6.1: `h = hex(sha256(utf8(canonical(e))))`; `e.prev` holds parent hashes (sorted, unique, up to 8, at least 1 except the owner's genesis); section 6.3 ingest order is "Shape and limits -> `h` recomputes -> PoW -> signature -> `v` matches `vh` ...". So an accepted block does commit to its whole causal past. If the owner's checkpoint `C` lists every head the owner holds, every block the owner held is an ancestor of `C` or `C`'s ancestors. Sound.
- **Circularity.** A block cannot contain the hash of a file that contains the block. Correct.
- **Older snapshot.** The limitation is stated and correct; note that `HELLO.ckpt` (3.2/3.3) lets *peers* announce the newest checkpoint, which does not help a visitor with no peers.
- **Code.** When I started, `src/chain/` held only `canonical.js` and `crypto.js`; other agents then added `dag.js`, `block.js`, `state.js` and `verify-pool.js` (file times 17:53-18:00 on 2026-10-17, so they may still change). The implemented `Dag.missing()` is `for (const h of this._waiting.keys()) if (!this._blocks.has(h) && !this._orphans.has(h)) out.push(h)`: it lists parents that some orphan waits for and that are in neither the DAG nor the orphan pool, i.e. it is global over the pool. `add()` returns `'added' | 'duplicate' | 'orphan'`. There is no `checkpoint` op yet (`CONTROL_OPS = policy, owner, tombstone, ban, allow`), as expected for a proposal.

### Nuances
1. **The predicate.** "Dag.missing() empty" is a property of the whole orphan pool. It is non-empty if any unrelated orphan exists (even when every ancestor of `C` is present) and trivially empty if `C` itself is absent (nothing references it). The precise test is "`C` has been accepted into the DAG (not an orphan)"; then every ancestor is present by induction. Section 3.3 of the original ("a node that holds C and whose `Dag.missing()` is empty") is sufficient but not necessary.
2. **"A host cannot silently drop the newest tombstone or ban" is true only for blocks that are ancestors of the latest checkpoint the loader sees.** A tombstone, ban or `allow` removal minted after that checkpoint, or by a moderator after the owner's last checkpoint, can be dropped silently. The original's own "What it does not add" says so ("anything about blocks written after C"); the claim's summary sentence drops that qualifier. The benefit is "tip completeness as of C", and its value depends on checkpoint cadence, which is still an open question (original section 5, item 5).
3. **Completeness is of the header skeleton, not of payloads.** ARCH 6.1: "A block without `v` is valid and counts only as a DAG node." A snapshot host can strip `v` from live blocks without invalidating any checkpoint; the loader sees pending DAG nodes and must `WANT { h, v:true }` from peers. For a first-time visitor with no peers that is silent content censorship that the checkpoint cannot reveal. `(n, root)` commit to hashes, not to payload presence.
4. **`(n, root)` adds no authentication beyond the `prev` chain.** Given a closed ancestor set with recomputed hashes, `n` and `root` are determined, so they are a cheap implementation self-check (and the form pruning would later need), not an extra guarantee. The original calls it a "cheap second check", which is accurate; the claim's phrasing could be read as more.
5. **Relative to the owner's view.** "All heads the owner holds" means blocks the owner never saw are outside the commitment. "Complete" is complete as of what the owner knew when minting `C`.

### Exact correction text
"An owner checkpoint block `C` whose `prev` lists every head the owner holds makes the DAG skeleton complete, as of `C` and as the owner saw it, exactly when `C` has been accepted as a non-orphan. It adds tip completeness only for blocks that are ancestors of the latest checkpoint (a newer tombstone or ban can still be dropped), says nothing about payloads (`v`), and `(n, root)` is a redundant consistency check because `prev` hashing already commits to the ancestor set. It does not stop a consistent older snapshot."

### Sources
Local: `docs/ARCHITECTURE.md` (6.1, 6.3, 6.4, 6.6, 6.7), `docs/INTERFACES.md` (`dag.js`), `docs/review/DESIGN-REVIEW.md` (S2, LATER list), original doc 3.3. External: https://c2sp.org/tlog-checkpoint .

---

## 5. Claim 5 - cold start is cheap at our caps

> **Claim (verbatim).** Cold start at our caps is cheap: reading 50,000 stored records from IndexedDB takes 150-192 ms (Chromium 156 / WebKit 27.2 on an M3). ARCH v0.2 uses ECDSA P-256 (WebCrypto verify 15.0-15.4k/s on an M3 per doc 06 F47), so the 8 MiB default cap (about 13.6k blocks) verifies in about 0.9 s on an M3 and 2.7-9 s on a phone if phones are 3-10x slower (extrapolation). History pruning is therefore not needed for CPU reasons, only for storage budget.
> *Their confidence: medium.*

**Verdict: nuanced.** The quoted numbers match the raw files and the arithmetic is right, and the conclusion survives my tests at the 8 MiB default. What the sentence hides: the numbers come from ephemeral (private-browsing-style) browser contexts; the P-256 figure is Chromium-only and WebKit is about 1.5x slower; the 8 MiB cap holds 15.8k-22k real blocks, not 13.6k; and the phone leg cannot be checked here. *My confidence: high for what I measured, none for phones.*

### What checks out
- `labs/w2c-02-lab/results/result-chromium.json`: `idbIndexed.fullScan.medMs = 192`, UA `HeadlessChrome/156.0.8078.4`; `result-webkit.json`: `150`, UA `Version/27.2 Safari/605.1.15`; both `n = 50000`, `recBytes = 618`, `hc = 8`. The machine is a MacBook Air, Apple M3 (checked with `system_profiler`).
- ARCH v0.2 6.1: `s = ECDSA-P256-SHA256(...)`; `DEFAULT_POLICY.maxChainBytes = 8388608`; verification "in a worker pool" (5.5); `createVerifierPool({ size = 2 })`.
- Doc 06 F47 (verbatim table row): "WebCrypto ECDSA P-256 sign / verify | 30-32k / 15.0-15.4k | 64-byte IEEE P1363 signature"; heading "Measured signature performance (Worker, Chromium 155, M3, 200-byte message)"; text "Phones are probably 3-10x slower (**extrapolation**)". The claim quotes it faithfully.
- Arithmetic: 8,388,608 / 618 = 13,573.9; 13,574 / 15,000 = 0.905 s; / 15,400 = 0.881 s; x3 = 2.7 s; x10 = 9.0 s.

### Measurements I added (this M3, load average about 6, so indicative)
**A. Verification of 13,574 spec-format blocks with the project's own code.** I generated ARCH 6.1 blocks (ECDSA P-256, RFC 8785 via `src/chain/canonical.js`, 200 authors, PoW mined at 8 bits) that the real `validateBlock` accepts (2,000 of 2,000 in a Node probe), then timed `validateBlock` and the real `createVerifierPool` (esbuild IIFE worker bundle of `src/chain/pow-worker.js`, as the repo's build does). Median of 3 runs.

| 13,574 blocks | Chromium 156 | WebKit 27.2 |
|---|---|---|
| `validateBlock` on the main thread, sequential | 1,357 ms (10.0k/s) | 2,677 ms (5.1k/s) |
| `validateBlock` on the main thread, 64 in flight | 1,308 ms (10.4k/s) | 1,853 ms (7.3k/s) |
| `createVerifierPool` size 1 | 1,852 ms | 1,830 ms |
| **`createVerifierPool` size 2 (ARCH default)** | **958 ms (14.2k/s)** | **1,137 ms (11.9k/s)** |
| `createVerifierPool` size 4 | 651 ms (20.8k/s) | 822 ms (16.5k/s) |

**B. Signature-only, comparable to F47** (my minimal harness, same blocks): Chromium 945-960 ms = **14.1-14.4k verifies/s on the main thread** (F47: 15.0-15.4k/s in a Worker, so about 4-8% lower); two workers 531 ms (25.5k/s). **WebKit 1,368-1,543 ms = 8.8-9.9k/s** (two workers 730 ms, 18.6k/s). One distinct key per block (the project's import cache holds 256 keys) costs a further 5-20% on the main thread (Chromium full pipeline 1,116 ms; WebKit 1,428 ms; the WebKit 2-worker figure was noisy).

**C. Block sizes under ARCH 6.1** (canonical JSON via the project's canonicalizer; real `blockBytes(block)` is "canonical(e) + canonical(v)" and `Dag.bytes` sums it):

| Payload mix | canonical(e) + canonical(v) | whole `{e,h,s,v}` JSON | blocks in 8 MiB (implemented accounting) |
|---|---|---|---|
| guestbook post, 120-char text + name (v about 135 B) | 530 B | 705 B | **15,819** |
| 1-byte value | 388 B | 563 B | 21,596 |
| control block (no `v`) | 381 B | 551 B | **21,992** |

**D. IndexedDB, same flat 618 B record as the original, 4 runs each (the first under heavier machine load), persistent on-disk profile vs the original's ephemeral context, fresh browser process for the cold read.**

| 50,000 records | ephemeral `getAll` (orig.: 192 / 150 ms) | persistent, cold read in a fresh process: first scan / later scans |
|---|---|---|
| Chromium 156 | 187-245 ms | **155-182 ms** / 161-173 ms |
| WebKit 27.2 | 141-156 ms | **227-259 ms** / 212-229 ms |

**E. Real nested v0.2 blocks** (`keyPath: 'h'`, no secondary index, as ARCH 6.7), persistent profile, fresh-process cold read:

| Blocks | Chromium 156 first / later scan | WebKit 27.2 first / later scan |
|---|---|---|
| 13,574 | 45 / 46 ms | 91 / 66 ms |
| 50,000 | 165 / 166 ms | 288 / 256 ms |

**F. After the read** (real `Dag` + `reduce`, section 8): `Dag.add` for 13.6k blocks 43-47 ms, `reduce` 4-8 ms, so a stored ledger of the default size is queryable about 0.1-0.15 s after the read, with verification off the critical path.

### Corrections and nuances
1. **The 15.0-15.4k/s figure is Chromium-only.** On the same M3, WebKit 27.2 verifies P-256 about 1.5x slower (8.8-9.9k/s signature-only; 11.9k/s through the real pool of 2). Every browser on iOS uses WebKit, so the baseline for the phone leg should be the WebKit number.
2. **"About 13.6k blocks" is the synthetic IndexedDB record, not a block.** With the implemented byte accounting (`blockBytes` = canonical(e) + canonical(v)) the 8 MiB default holds **15.8k posts to 22.0k control blocks**. At the real pool of 2 workers that is 1.1-1.55 s on Chromium and 1.3-1.85 s on WebKit. "About 0.9 s" is the right order of magnitude (measured 0.96 s for 13.6k blocks in Chromium) but the worst case at the default cap is about 1.6-2x that.
3. **Ephemeral contexts.** The original bench used `browser.newPage()`. Sibling research (`w1-08-mobile-constraints.md` F-32) documents that Playwright's WebKit non-persistent context is the private-browsing-style ephemeral session. Persistent on-disk numbers differ (table D): the claimed 150-192 ms holds for Chromium but WebKit persistent is **212-259 ms**, up to 35% above the quoted upper bound; real nested blocks read slower than flat records on WebKit (288 ms for 50,000).
4. **The 64 MiB ceiling is outside "our caps".** `maxChainBytesCeiling` is 64 MiB: 126k (530 B blocks) to 176k (381 B blocks) blocks, i.e. 8.9-12.4 s of verification on Chromium and 10.6-14.7 s on WebKit through the real pool of 2, on this desktop. The sentence "not needed for CPU reasons" is a statement about the default cap, not the ceiling.
5. **The phone leg is unverifiable here.** No phone was measured (nor in this repo; `w1-08-mobile-lab` has no crypto timing). Mechanically applying 3-10x to the WebKit pool-of-2 figure gives 3.4-11.4 s at 13.6k blocks and 5.5-18.4 s at 22k blocks; that is an extrapolation on an extrapolation and I have no data to support or reject the 3-10x factor.
6. **Verification time is not on the critical path** (render first, verify in workers), which is why the conclusion survives. It still determines time-to-consistent-state after a snapshot ingest, battery cost, and when a tip-completeness check (claim 4) can answer.

### Exact correction text
"Reading 50,000 stored records from IndexedDB took 150-192 ms in ephemeral Playwright contexts (Chromium 156, WebKit 27.2, M3); from a persistent profile in a fresh process it is 155-182 ms (Chromium) and 212-259 ms (WebKit). Through the project's own `validateBlock` and a 2-worker verifier pool, 13.6k blocks validate in about 0.96 s (Chromium) / 1.14 s (WebKit); P-256 verify is about 14k/s in Chromium and 9-10k/s in WebKit on an M3 (doc 06 F47's 15.0-15.4k/s is Chromium only). The 8 MiB default holds 15.8k-22.0k blocks, so budget 1.1-1.9 s. Phone times are unmeasured."

### Sources
Local: `docs/research/labs/w2c-02-lab/results/result-chromium.json`, `result-webkit.json`, `bench/index.html`; `docs/research/06-browser-chain-vs-crdt.md` F47; `docs/ARCHITECTURE.md` 5.5, 6.1, 6.7; `src/chain/block.js`, `dag.js`, `verify-pool.js`, `pow-worker.js`; `docs/research/w1-08-mobile-constraints.md` F-32. Raw data and scripts: `docs/research/labs/w2c-02-verify-lab/` (section 11).

---

## 6. Claim 6 - Matrix redaction mechanics

> **Claim (verbatim).** Matrix signs the redacted form of each event including a content hash; a receiver with valid signatures but a content-hash mismatch redacts instead of dropping; the redaction algorithm keeps prev_events, auth_events, depth, hashes and signatures so the DAG stays connected; redacted events still affect state (a redacted join still counts). Matrix's content hash is unsalted.
> *Their confidence: high.*

**Verdict: confirmed.** All five sub-claims match the spec text (Server-Server API v1.19, rooms v11 and v12, fetched 2026-10-17). *My confidence: high.*

| Sub-claim | Where | Text |
|---|---|---|
| Signs the redacted form, hash included | S2S "Signing Events > Adding hashes and signatures to outgoing events" | "Before signing the event, the content hash of the event is calculated ... stored in the event object, in a hashes object, under a sha256 key. The event object is then redacted, following the redaction algorithm. Finally it is signed ... The signature is then copied back to the original event object." The spec's example code: "The hashes are not stripped and cover all the keys in the event ... The signature only covers the essential keys and the hashes. This means that we can check the signature even if the event is redacted." |
| Hash mismatch -> redact, not drop | S2S "Checks performed on receipt of a PDU" and "Validating hashes and signatures on received events" | "Passes signature checks, otherwise it is dropped. Passes hash checks, otherwise it is redacted before being processed further." and "If the hash check fails, then it is assumed that this is because we have only been given a redacted version of the event. To enforce this, the receiving server should use the redacted copy it calculated rather than the full copy it received." |
| Redaction keeps the DAG fields | rooms v11 "Redactions" (v12 "Unchanged from v11" repeats the list) | Keep: `event_id, type, room_id, sender, state_key, content, hashes, signatures, depth, prev_events, auth_events, origin_server_ts`; `content` is stripped except per type (for example `m.room.member` keeps `membership`, `join_authorised_via_users_server` and the `signed` key of `third_party_invite`; `m.room.create` keeps everything; `m.room.power_levels` keeps `ban, events, events_default, invite, kick, redact, state_default, users, users_default`). v11 change: top-level `origin`, `membership` and `prev_state` are no longer protected. |
| Redacted events still affect state | S2S "Rejection"; client-server "Redactions" | "This is in contrast to redacted events which can still affect the state of the room. For example, a redacted join event will still result in the user being considered joined." |
| Content hash is unsalted | S2S "Calculating the content hash for an event" | "First, any existing unsigned, signatures, and hashes properties are removed. The resulting object is then encoded as Canonical JSON, and the JSON is hashed using SHA-256." I grepped the S2S spec and rooms v11/v12 for "salt": no hits (the client-server spec's "salt" hits are HKDF and key backup). |

### Additions the original missed (not corrections)
1. **Redacted state blanks the property; it does not revert it.** Client-server spec: "When redacted, state events behave as though their properties were simply not specified, except those protected by the redaction algorithm ... a redacted topic does not necessarily cause the topic to revert to what it was prior to the event - it causes the topic to be removed from the room." That is the opposite of ARCH v0.2's behaviour for a tombstoned `put` (the last-writer-wins fold falls back to the previous value, original 3.4 gap 3) and is a ready precedent for original open questions 1 and 13.
2. **The reference server keeps the original for a while.** Synapse `redaction_retention_period`: "How long to keep redacted events in unredacted form in the database. After this period redacted events get replaced with their redacted form in the DB ... Defaults to '7d'" (checked every 5 minutes; `null` disables). Redaction in the spec is not immediate deletion in the reference implementation.
3. **Unsalted in practice.** The redacted skeleton keeps `sender`, `origin_server_ts`, `prev_events`, `depth` and the rest of what the hash covers except `content`, so a low-entropy body can be confirmed by guessing; magnet-web's per-block salt `z` is a real improvement over the precedent, as the original says.
4. **A design difference worth stating.** Matrix keeps an event whose content hash fails and redacts it. ARCH v0.2 / the implemented `validateBlock` reports `value-hash` and the block is rejected (and the sender counted as invalid). Both are defensible; the spec should say which one it means.
5. **G10's side facts check out.** The Project Hydra post is dated 2025-08-14; it names MSC4289, MSC4291 (CVE-2025-54315) and MSC4297 (State Resolution v2.1, CVE-2025-49090), a pre-disclosure on 16 July 2025 and releases on Monday 11 August.

### Sources
https://spec.matrix.org/latest/server-server-api/ , https://spec.matrix.org/latest/rooms/v11/ , https://spec.matrix.org/latest/rooms/v12/ , https://spec.matrix.org/latest/client-server-api/ , https://matrix.org/blog/2025/08/project-hydra-improving-state-res/ , https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html .

---

## 7. Claim 7 - EDPB Guidelines 02/2025 v2.0

> **Claim (verbatim).** EDPB Guidelines 02/2025 v2.0 (adopted 07 July 2026): unsalted or unkeyed hashes are not considered sufficient (para 52); a salted or keyed hash is still personal data until the salt or key is deleted (para 52); with a perfectly hiding commitment, once the original data and its witness are deleted the commitment is 'useless' (para 53); encrypted personal data remains personal data and encryption is 'overtaken by time' (para 51); public signature verification keys are identifiers and retention applies to the transactions they signed (para 80); technical impossibility cannot justify non-compliance (para 50); clear, encrypted or hashed personal data on a ledger is not advisable (para 104).
> *Their confidence: high.*

**Verdict: nuanced.** The document, the version, the adoption date and every paragraph number are right, and five of the seven statements are faithful. Two paraphrases are stronger than the text, and one of them (the "until" in the second statement) carries design weight. *My confidence: high (PDF read in full for these paragraphs; track-changes file and consultation report cross-checked). Not legal advice.*

**Document.** PDF cover: "Guidelines 02/2025 on processing of personal data through blockchain technologies, Version 2.0, Adopted on 07 July 2026"; version history: v1.1, 08 April 2025, "adoption of the guidelines before public consultation"; v2.0, 07 July 2026, "adoption of the guidelines after public consultation". The EDPB page shows "07 July 2026 / Final version". 27 pages.

| Claim wording | Para | What the PDF says | Assessment |
|---|---|---|---|
| unsalted or unkeyed hashes are not considered sufficient | 52 | "It should also be noted that the use of unsalted or unkeyed hashes should, in general, not be considered sufficient to guarantee the necessary level of confidentiality protection for storing personal data on a public blockchain." | Supported. The paraphrase drops "in general" and "public blockchain". |
| a salted or keyed hash is still personal data until the salt or key is deleted | 52 | "... the GDPR will still apply to that processing activity and that the hash will also be considered personal data, as will any other identifiers that might exist." And: "after deletion of the secret key or salt, the hash should not be linkable to the original data, provided that the algorithm has not been broken, the keys have not been compromised or leaked, and the salt was not leaked or poorly chosen." | First half supported. **"Until the salt or key is deleted" is the claim's inference.** The text never says the hash stops being personal data; it says it "should not be linkable", under three provisos. |
| perfectly hiding commitment: data and witness deleted => "useless" | 53 | "If the commitment has been computed using a perfectly hiding state-of-the art scheme, then once the original data and its witness are deleted, the commitment persisting in the blockchain is useless. It will be neither possible to recover nor to recognise the original personal data." | Supported. "Perfectly hiding" (information-theoretic, for example Pedersen) is stricter than the salted SHA-256 that ARCH's `vh` would become; that design falls under para 52, not 53. |
| encrypted data remains personal data; "overtaken by time" | 51 | "The EDPB recalls that encrypted personal data is still personal data and encryption does not remove the need for GDPR compliance. Further, even state-of-the-art encryption perfectly implemented will be overtaken by time if the blockchain is retained indefinitely." | Supported verbatim. |
| public signature verification keys are identifiers; retention applies to transactions they signed | 80 | "... the data retention period also applies to these identifiers and, if the identifiers take the form of public signature verification keys, to the transactions signed by the corresponding private signing keys." | Supported, but conditional ("if the identifiers take the form of ...") and about users' identifiers; para 26 makes public keys personal data when "the user is a natural person and those public keys can be used to identify the individuals by means reasonably likely to be used". |
| technical impossibility cannot justify non-compliance | 50 | "The EDPB emphasises that technical impossibility cannot be invoked to justify non-compliance with GDPR requirements" (footnote 24: EDPB ChatGPT Taskforce report, May 2024, para 7). | Supported verbatim. |
| clear, encrypted or hashed personal data on a ledger is not advisable | 104 | "It is therefore not advisable to register personal data in those forms on a blockchain. Instead, personal data in those forms should be stored off-chain." | Supported ("blockchain"; the claim omits the off-chain instruction). |

### What changes for the design
1. **Deleting `v` and `z` is minimisation and unlinkability, not anonymisation of the block.** What remains after deletion is the signed header: the author's public key (an identifier, paras 26 and 80), the signature, a rounded timestamp, the op and `vh`. Para 52's own wording ("will also be considered personal data", "should not be linkable") does not turn that stub into non-personal data. The original's own gotcha 5 says as much; the claim's "until deleted" phrasing reads more strongly.
2. **The EDPB declined to bless any cryptographic recipe.** The consultation report (published with v2.0) lists among not-incorporated comments those "requesting recognition of specific cryptographic approaches as fully compliant solutions, which has been clarified in the Paragraph 30 footnote". In the final PDF the relevant footnotes read: footnote 12 (attached to para 30): on-chain metadata "may constitute personal data when they enable direct or indirect identification of a natural person"; footnote 13 (attached to para 33, which covers keyed hashes and HMACs): "Security measures are technical and organisational protections but not fully guarantees for data protection."
3. **Track changes v1.1 -> v2.0.** I unzipped the published track-changes `.docx`: paras 51, 52, 53, 80 and 104 are substantively unchanged ("way" became "measure" in 51; a comma deleted in 52; "to" inserted in 80). Para 50's sentence on technical impossibility is unchanged (surrounding wording was tightened). So sources that quote v1.1 are still good for these paragraphs.
4. **Supporting but older material (OLD).** AEPD-EDPS "Introduction to the hash function as a personal data pseudonymisation technique" (October 2019; fetched, 31 pages), single-use salt section: "In the case that the relevant salt is deleted, the original message and - only if certain guarantees are complied with - the identifier on which a single-use salt model is applied may be considered anonymised." That is the closest published support for the per-block random `z` design, and it is conditional. The EDPB's own summary leaflet (uploaded September 2026, cover dated May 2025) says "Once the off-chain data is deleted, the proof alone can't be used to identify anyone", a simplified statement that does not match para 52's wording.
5. **Side citations in the original's G12 also check out** against the PDF: para 13 (single-entity chains partly out of scope), paras 36-44 ("organisations should favour permissioned blockchains", "decisive influence", "joint controllers"), 54 and 109 (off-chain), 102-104, 120 (Recommendation 11) and 125 (Recommendation 16). The AEPD proof-of-concept note that the original recorded as an HTML stub downloads fine (HTTP 200, PDF, 50 pages, "November 2024"); I skimmed it and did not read it in full.

### Exact correction text
"Para 52: a salted or keyed hash 'will also be considered personal data'; after the secret key or salt is deleted it 'should not be linkable to the original data', provided the algorithm is unbroken, the keys and salt were not leaked and the salt was well chosen. The guidelines do not say the hash then stops being personal data. 'Unsalted or unkeyed hashes should, in general, not be considered sufficient ... on a public blockchain.'"

### Sources
https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf , https://www.edpb.europa.eu/documents/guideline/guidelines-022025-on-processing-of-personal-data-through-blockchain_en , https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_trackchanges.docx , https://www.edpb.europa.eu/system/files/2026-07/edpbreport_publicconsultaton_guidelines_blockchain_202502_en.pdf , https://www.edpb.europa.eu/system/files/2026-09/edpb-summary-022025-blockchains_en.pdf , https://www.aepd.es/guias/Tech-note-blockchain.pdf , https://www.edps.europa.eu/sites/default/files/publication/19-10-30_aepd-edps_paper_hash_final_en.pdf .

