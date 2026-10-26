# Security & Privacy review — magnet-web ARCHITECTURE v0.1 / INTERFACES (2026-10-14)

Lens: same-origin and iframe model, SW routing, bridge/postMessage, pointer trust (DoH, TOFU, seq),
chain validation and abuse (Sybil, spam, replay, time, key compromise, owner rotation), peer-level
DoS, CSP, SRI, data retention / IP exposure / legal exposure of seeding visitors, supply chain.

Inputs: `docs/ARCHITECTURE.md`, `docs/INTERFACES.md` (read in full). No source exists yet under
`src/`; `docs/CRITIQUE.md` and `docs/research/RESEARCH-DIGEST.md` do not exist yet, so claims that
defer to them are treated as unmade. Library behaviour I rely on below was checked in
`node_modules` (webtorrent 3.0.21, bittorrent-protocol, bittorrent-tracker, create-torrent) and the
line numbers are cited. §1 facts were taken as true per the brief.

Severity: **BLOCKER** = ships a hole or a false claim that defeats a stated requirement;
**MAJOR** = real failure / exploitable weakness / misleading claim with a bounded fix;
**MINOR** = concrete but contained. Every item ends with the exact change to apply.

---

## 0. Summary table

| # | Sev | Finding | Where |
|---|-----|---------|-------|
| B1 | BLOCKER | Hub mode has no isolation: `allow-same-origin`+`allow-scripts` on same-origin content removes the sandbox; every hub site can read/poison every other site's cache, chain, identity and pins; fragment/magnet-handler auto-load makes it drive-by | ARCH §3, §7, §13; INTERFACES render.js, cache.js |
| B2 | BLOCKER | Policy (`writers`, `allow`, `bits`) is bypassable forever by choosing shallow `prev` (ordering is by depth) | ARCH §6.3–6.4; INTERFACES state.js |
| B3 | BLOCKER | Tombstoned blocks become unverifiable stubs whose `prev` edges cannot be checked → DAG/ordering poisoning and un-relayable history; needs a data-model change now | ARCH §6.1, §6.6; INTERFACES block.js |
| B4 | BLOCKER | Any WebRTC peer can send a 4 GiB length prefix: `bittorrent-protocol` buffers without a cap → remote memory-kill of every visitor's tab; our 16 KiB frame cap sits above this layer | ARCH §6.5, §13; INTERFACES torrent.js / wire-ext.js |
| M1 | MAJOR | `writers:'open'` default is a storage/CPU DoS sink: keys are free (Sybil), 14-bit PoW is pre-computable, 50 000 × 16 KiB ≈ 780 MiB per visitor; `chain=` lets any site aim its visitors at another site's chain | ARCH §6.1–6.2, §4, §13 |
| M2 | MAJOR | Anyone can mint roots (`prev: []`); heads are unbounded; HELLO carrying all heads exceeds the 16 KiB frame → sync breaks for everyone | ARCH §6.3, §6.5; INTERFACES gossip.js |
| M3 | MAJOR | Owner key model: single `ownerPub` in `reduce()` makes rotation retroactively de-authorise history; no rotation path except a scary prompt; "owner login" imports the root key into the same origin as site code | ARCH §4, §6.4, §6.7, §9 |
| M4 | MAJOR | IndexedDB is writable by same-origin script, yet the loader renders from it and seeds it with `skipVerify` → persistent poisoning and pin lock-out | ARCH §5 step 4, §13; INTERFACES cache.js, torrent.js |
| M5 | MAJOR | Framing & URL-bar spoofing: no `frame-ancestors` on `/_mw/s/*` or the shell (meta CSP cannot carry it); direct top-level navigation to `/_mw/s/*` renders with no loader; cross-origin navigation inside the iframe shows attacker content under `example.com` | ARCH §7, §13 |
| M6 | MAJOR | Third-party exposure contradicts the "no third parties" framing: pointer `tr` is *merged* with public trackers; two DoH resolvers see every visit every 10 min; IP is exposed before consent and even with uploads off; `tracker.mjs` is an open tracker | ARCH §0, §4, §5, §8, §10 |
| M7 | MAJOR | Pointer signing-input is under-specified (case, trim, unknown keys, `;` in URLs, IDN form), `exp` optional, `seq` monotonic only per key, no domain separation between pointer and block signatures | ARCH §4; INTERFACES pointer.js |
| M8 | MAJOR | Retention: superseded versions stay cached and seeded forever (owner cannot take content down), hub sites accumulate, chain payloads live forever, Safari's 7-day eviction silently wipes identity + TOFU pins | ARCH §5, §6.6, §8; INTERFACES cache.js |
| M9 | MAJOR | Misleading demo claim: SW and `crypto.subtle` need a secure context; "open the hub URL in any browser on the LAN" fails on every phone over plain http | ARCH §11, §5 step 1 |
| M10 | MAJOR | Supply chain: `allowScripts` in package.json is inert (no `@lavamoat/allow-scripts`), prebuilt `webtorrent.min.js` is not hash-pinned by the build, and the SRI claim covers 2 of 6 scripts | ARCH §13, §10; package.json |
| m1 | MINOR | Rate-limit rejections must not be cached by hash; orphan pool needs per-peer quotas | ARCH §6.2, §6.5 |
| m2 | MINOR | `allow-modals` in hub mode lets a site show `alert()` dialogs attributed to the hub origin | ARCH §7 |
| m3 | MINOR | SDK hangs forever when loaded without a parent; `postMessage(…, location.origin)` throws under an opaque origin | ARCH §9; INTERFACES sdk.js |
| m4 | MINOR | `keygen.mjs` writes the root private key as a world-readable JWK | ARCH §10 |
| m5 | MINOR | Gossip adapter must skip `webSeed` wires and ignore `mw_chain` messages before the extended handshake | ARCH §6.5; INTERFACES wire-ext.js |

---

## 1. BLOCKERS

### B1 — Hub mode has no isolation; the "stricter sandbox" claim is false

**Where.** ARCH §3 ("stricter iframe sandbox"), §7 (`sandbox="allow-scripts allow-same-origin …"` plus
`Content-Security-Policy: sandbox allow-scripts allow-same-origin …`), §13 ("Hub mode isolation: CSP
sandbox header + iframe sandbox + banner"), §10 (`manifest.webmanifest` `protocol_handlers` for
`magnet:`), INTERFACES `render.js`, `cache.js` (one `mw-sites` DB, one `identity` key `'me'`, one `pins`
store per origin).

**Problem.** `allow-same-origin` + `allow-scripts` on content that is same-origin with the embedder is
documented (HTML spec, MDN) as equivalent to no sandbox: the framed document can reach
`window.parent.document`, the parent's IndexedDB, Cache Storage, `navigator.serviceWorker`, cookies
and localStorage. The CSP `sandbox` response header grants the same flags and changes nothing. In
hub mode the shared origin therefore gives *every* loaded site:

- read access to every other site's files (`files` store, `/_mw/s/<btih>/…`), i.e. the visitor's hub
  browsing history and any private content those sites cached;
- write access to every other site's cache (persistent poisoning of site B by site A, served by our
  SW on B's next render and re-seeded with `skipVerify`, see M4);
- the visitor's single hub identity (`identity:'me'`): it can sign chain blocks *as the visitor* into
  any site's chain, and the same public key links the visitor across all sites (tracking);
- the `pins` and `pointers` stores: it can pin an attacker key for `host:victim.com` so the real
  owner's records trigger "publisher key changed" forever, or pre-seed a poisoned pointer for
  offline use;
- the loader DOM itself: fake consent/settings/"key changed → Confirm" UI.

The design cannot fix this with sandbox flags, because SW-rendering *requires* `allow-same-origin`:
a sandboxed frame without it has an opaque origin, is not a service-worker client, and its
navigation/subresource requests are not served by our SW (it would fall through to the static host's
SPA fallback). Confirm this in the spike; it is the pivot of the whole hub design.

The magnet protocol handler and the `#magnet:` / `?mw=` sources make the problem drive-by: on a hub,
clicking any magnet link anywhere (where handlers are supported) or any crafted `hub.example/#…` link
runs attacker JavaScript at the hub origin with the access above. `#host:example.com` is the same
with a DNS-anchored pointer.

**Exact change.**
1. ARCH §3/§7/§13: delete "stricter iframe sandbox" and "Hub mode isolation: CSP sandbox header +
   iframe sandbox". Replace with: *"Shared-origin hub mode provides NO isolation between sites. It is
   permitted only for (a) a single operator's own collection of sites, (b) development/LAN demos.
   Any hub that loads sites from more than one publisher MUST use per-site origins (wildcard
   subdomains)."* The loader enforces it: in shared-origin hub mode with a pointer that is not
   same-publisher-pinned, show a blocking interstitial (name, `btih`, size after metadata, tracker
   list, publisher fingerprint) with an explicit "Load anyway (this site can read and change everything
   stored by other sites on this hub)" button; never auto-load from a fragment or the protocol handler.
2. Wildcard mode (§3): key the origin by **chain id, not btih** (e.g. the first 32 hex of
   `sha256(chain id)` as the label; carry the signed record in `_magnet.<label>.hub.example` TXT or the
   fragment). Keyed by btih, every new version is a new origin, so identity, pins and the chain DB
   reset on every deploy — the recommended isolation mode would silently drop the "DB" requirement.
3. `cache.js`: identity becomes **per chain id** (`identity:<chainId>`), generated lazily on the first
   write; `pins` and `pointers` keep `scope` keys but the UI must say in hub mode that these are
   writable by any site on this hub.
4. `render.js` hub mode: drop `allow-modals` (m2) and keep the banner, but word it honestly:
   "Sites on this hub share one browser origin and can access each other's data."
5. SDK (§9): if an isolated variant is ever built with an opaque origin, `location.origin` is the
   string `"null"` and `postMessage(msg, "null")` throws; the handshake must use `'*'` with the
   `MessagePort` as the capability and the host must check `event.source` only. Note it now so the SDK
   is not written against `location.origin` in two places.
6. README/CRITIQUE (user-facing): state plainly that in per-domain mode the site is as trusted as the
   loader (same origin): an XSS in the site is an XSS in the loader; the bridge is an API, not a
   security boundary.

### B2 — Policy can be bypassed forever by choosing shallow `prev`

**Where.** ARCH §6.3 (order = Kahn over `prev`, next emitted is min `(depth, h)`), §6.4
("`policy` applies from that point in the order"; "`writers:'owner'` makes non-owner ops no-ops from
that point on (they are still stored …)"), §6.2 (policy checked at ingest), INTERFACES `state.js`.

**Problem.** `depth` is chosen by the block's author through `prev`. After the owner publishes
`{t:'policy', writers:'owner'}` at depth *d*, an attacker publishes a block with `prev = [<any
block at depth 0..d-2>]`; it has depth < *d*, becomes ready early in Kahn's algorithm and is emitted
*before* the policy block on every node, so the reducer applies it under the old open policy. The
same trick re-inserts a banned writer before an `allow` change, posts under old (lower) `bits`, and
makes "from that point in the order" meaningless. Because every node computes the same order, the
bypass is consistent and permanent. The ingest-time policy check does not help: §6.4 says the blocks
are stored anyway and the reducer re-evaluates them positionally.

**Exact change.**
1. `state.js`: policy is **causal, not positional**. For a policy block *P*, define
   `exempt(P) = ancestors(P)` (blocks the owner had already seen). A non-owner block *B* is evaluated
   under the latest (in total order) policy *P* such that `B ∉ exempt(P)`; equivalently every policy
   applies to all blocks except its own ancestors. Concurrent honest writes at the moment of a switch
   are dropped by design (document it). Implementation: BFS the ancestor set once per policy block
   (there are few) and memoise; stays within the 50 ms budget at 5 000 blocks.
2. `node.js` ingest: enforce `bits`, `maxValueBytes`, `writers`/`allow` against the **current
   effective policy at the local head** for every incoming block that is not a WANTed parent of a
   block we already hold (parents of held blocks are, by construction, ancestors of something we
   accepted — keep them so the DAG stays connected). Blocks rejected this way are not stored and not
   relayed; this also closes most of the storage-sink in M1 once `writers` is not `open`.
3. Same rule for `bits`: PoW must meet the effective policy's `bits` under rule 1, with the
   chain-wide `CONFIG.chain.bits` as a floor that is checked before anything else.
4. Add a unit test: policy switch to `owner`, then a non-owner block with `prev` at depth 0 → op is a
   no-op on all shuffles.

### B3 — Tombstoned blocks cannot be verified or safely relayed

**Where.** ARCH §6.1 (`h = sha256(canonical(e))` over the whole entry incl. `op`), §6.6
("tombstoned payloads are replaced by `{e:{…, op:{t:'tombstoned'}}}` … hash will no longer recompute →
`verified:false` … re-fetched from peers never"), §6.5 (WANT/BLOCKS), INTERFACES `block.js`,
`stores.js`.

**Problem.** Once a node redacts a payload, it holds a stub whose `h` does not recompute and whose
signature cannot be checked. Two consequences:
- When a peer WANTs `h` (it needs it to connect the DAG), the node can send only the stub. The
  receiver cannot verify `prev`, so a malicious peer can hand out stubs with **arbitrary `prev`
  edges**, which alter `depth` and therefore the total order on nodes that accept them (LWW outcomes
  diverge, B2-style insertion games), or point at garbage to fill the orphan pool. If receivers
  refuse stubs instead, any chain with one tombstone becomes un-syncable for new visitors (orphans
  below the tombstone can never be resolved).
- A node that only ever saw the stub cannot verify the tombstone was legitimate either.

This is a data-model change; chain-core is being implemented right now, so it must land before
`block.js` freezes.

**Exact change (redactable blocks).**
1. `block.js`: `Entry e = { v, site, author, seq, prev, ts, oph, nonce }` with
   `oph = hex(sha256(canonical(op)))`; `Block = { e, op, h, s }`; `h = hex(sha256(canonical(e)))`;
   `s` signs `h` as now. PoW is still over `h`. `validateBlock` checks `sha256(canonical(op)) === e.oph`
   when `op` is present.
2. Redaction = drop `op`, keep `{e, h, s}`: the stub still recomputes `h`, verifies `s`, keeps PoW,
   and its `prev` edges are trustworthy. `verified:false` disappears from §6.6.
3. Gossip: a node may send a stub only together with (or after) the tombstone block for `h`; a
   receiver accepts a stub iff it holds a valid tombstone for `h` by the owner or by `e.author`,
   otherwise it WANTs the full block. `tombstone` ops carry `h` only (unchanged).
4. Reducer: a stub contributes nothing except its DAG position. Define that a tombstone cannot be
   tombstoned (owner moderation is final; author-tombstones can be re-tombstoned by owner only if you
   need it — pick one and write it down).

### B4 — Unbounded wire message length: remote memory exhaustion of every visitor

**Where.** `node_modules/bittorrent-protocol/index.js` lines 945–951 (`_onMessageLength`: `const
length = getUint32(buffer); if (length > 0) this._parse(length, this._onMessage)`) and 850–858
(`_write` concatenates everything into one buffer until `length` bytes arrive). ARCH §6.5/§13 cap our
*gossip frames* at 16 KiB, but that check runs in `onMessage`, i.e. after the library has already
buffered the whole message.

**Problem.** Any peer that obtains a WebRTC connection (anyone who knows the public `btih` from DNS
and announces to the same tracker) sends a 4-byte prefix of `0xFFFFFFFF` followed by a byte stream;
the victim tab accumulates up to 4 GiB and is killed by the browser. One attacker process can do
this to every visitor of a site continuously, on phones in seconds. No authentication, no PoW, no
rate budget applies because no complete message is ever delivered to our code.

**Exact change.**
1. `torrent.js` `'wire'` handler (runs before `attachToTorrent`): wrap the parser on every wire:
   ```js
   const MAX_WIRE_MSG = 256 * 1024;          // largest legit msg: piece 16 KiB+13, ut_metadata 16 KiB
   const orig = wire._onMessageLength.bind(wire);
   wire._onMessageLength = (buf) => {
     const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
     if (len > MAX_WIRE_MSG) { wire.destroy(new Error('oversized message')); return; }
     orig(buf);
   };
   ```
   Record the monkey-patch in `docs/DEVIATIONS.md` and pin the `bittorrent-protocol` version in the
   lockfile review; open an upstream PR adding a `maxMessageLength` option.
2. Also set `wire.setTimeout(60_000, true)` and `wire.setKeepAlive(true)` so half-open peers are
   dropped, and count destroyed-for-oversize peers in the debug panel.
3. ARCH §13 "Peer DoS": add the line "transport-level message length cap 256 KiB enforced on every
   wire (bittorrent-protocol has none)".

---

## 2. MAJOR

### M1 — The open-writers chain is a storage and CPU DoS sink

**Where.** ARCH §6.1 (`DEFAULT_POLICY.writers = 'open'`, `bits: 14`, `rate: {n:30, perMs:600000}`
per author), §6.2 (rate limit per author), §6.6 (cap 50 000 blocks, "UI warns"), §4 (`chain=`
override), §13 ("block count cap, IDB quota handling").

**Problem.**
- Sybil: a P-256 key pair costs ~1 ms, so the per-author rate limit is bypassed by using a fresh
  key per block. The only remaining cost is PoW.
- 14 bits ≈ 16 384 SHA-256 of a ~500-byte JSON. Native code does tens to hundreds of blocks per
  second per core, and nothing binds PoW to freshness (`prev` may be ancient), so blocks can be
  pre-computed offline for months. 50 000 blocks × 16 384 bytes ≈ **780 MiB** written into every
  visitor's IndexedDB and loaded into memory at startup (§6.6 loads all blocks), on phones.
- Per-peer budgets (64 KiB/s, 50 invalid) do not help: the blocks are *valid*, and the attacker can
  present as many peers as the tracker will introduce.
- `chain=<id>` in an *unsigned* or attacker-owned pointer lets site X tell its visitors to join
  `host:victim.com`'s chain; X's own JavaScript (trusted on X's origin) then mines and posts with each
  visitor's identity — distributed spam with free PoW and naturally distinct authors.
- With `writers:'owner'` the sink persists because non-owner blocks are "still stored" (§6.4) — fixed
  by B2 change 2.

**Exact change.**
1. `DEFAULT_POLICY.writers = 'allow'` with `allow: []` is too restrictive for the guestbook demo, so
   keep `open` **only with global budgets**: per chain, non-allowlisted authors may add at most
   `openBudget = { blocks: 500, bytes: 4 MiB, perMs: 3_600_000 }` in aggregate (local receipt-time
   window, not part of state — same determinism argument as the per-author limit), and the chain has
   a hard byte cap (`maxChainBytes`, default 64 MiB) after which only owner/allowlisted blocks are
   ingested. Both in `Policy` so the owner can raise them.
2. New-author cost: the first block seen from an unknown author must meet `bits + 6` (identity
   PoW); subsequent blocks `bits`. Deterministic because "first block by author" is a function of
   the block set (lowest `seq`, tie by `h`), not of arrival.
3. `chainIdFor()` (INTERFACES pointer.js): honour `chain=` only from a **signed** record, and require
   it to be prefixed by the owner fingerprint (`chain=<fp8>:<name>`); unsigned pointers get the
   default id. This stops cross-site chain hijack.
4. UI/README: say what the chain is — a public, replicated, owner-moderated log with nuisance-cost
   PoW — and that `open` writers is for demos. Do not call PoW a spam control anywhere.

### M2 — Root and head flooding breaks gossip

**Where.** ARCH §6.3 ("`depth(b) = 0` for roots"), §6.5 (HELLO `{site, heads, n}`, "Every frame
≤ 16 KiB", WANT ≤ 64), INTERFACES `dag.js` (`heads()`), `gossip.js`.

**Problem.** Any author may publish a block with `prev: []`. Each is a root and a head. HELLO carries
*all* heads: ~250 × 64-hex hashes already exceed 16 KiB, so after a few hundred roots HELLO cannot be
encoded (or is truncated) on every node and synchronisation stalls chain-wide. Honest heads also grow
unboundedly when `prev` is capped at 8 and writers are many, just slower.

**Exact change.**
1. Non-owner blocks must have `prev.length ≥ 1` referencing a known block; only the owner may create
   a root. `publish.mjs` (or the owner's first run) creates a **genesis block**
   (`{t:'policy'}` with the initial policy) and the pointer carries `gen=<h>`; a chain is the set of
   blocks reachable to that genesis. Unsigned/ownerless pointers keep today's rules but get the
   caps below.
2. HELLO: send at most 32 heads chosen deterministically (highest depth, then lowest `h`) plus
   `n` (block count) and `hn` (head count). Peers whose `n`/`hn` differ after one exchange page through
   heads with a new frame type `5 HEADS {from: <h>, limit: 64}`; HELLO every 30 s rotates the sample.
3. `dag.js` keeps `heads()` bounded in memory (it already is a set) but `Gossip.hello()` never
   serialises more than the sample.

### M3 — Owner key: rotation breaks history, no safe rotation, root key in the untrusted origin

**Where.** ARCH §4 (TOFU, "publisher key changed" confirm), §6.4 (`reduce(orderedBlocks,
{ ownerPub })`), §6.7 (`ChainNode.open({ ownerPub })`), §5 step 7 / §9 ("owner login",
`mw.owner.policy`), §10 (`keygen.mjs`, `publish.mjs --key`).

**Problem.**
- `reduce()` takes a single `ownerPub` from the current pointer. The day the owner rotates the
  pointer key, every historical `policy`/`tombstone` block signed by the old key is re-evaluated as
  non-owner and silently stops applying: moderation is undone retroactively and the chain state jumps.
- The only rotation path is the TOFU prompt, which is indistinguishable from an attack and trains
  users to click Confirm (and is clickjackable, M5).
- "Owner login" imports the **root** key into the per-domain origin. By B1's same-origin logic, any
  XSS in the site (or any other hub site) can call `sign()` on the imported CryptoKey while the owner
  is logged in — non-extractable does not matter — and mint owner policy blocks or, with
  `signPointer` present in `src/common`, signed pointer records.
- Key compromise has no revocation; the honest statement is that in per-domain mode an attacker needs
  *both* the key and DNS/static-host write access to move visitors, which is a real strength and
  should be written down.

**Exact change.**
1. In-chain succession: owner-only op `{t:'owner', next: <pub>}`; the reducer tracks the owner as it
   walks the order (starting from the genesis author, M2) and evaluates each block's owner-ness against
   the owner in effect for that block (causal rule from B2). `ChainNode.open({ ownerPub })` becomes
   `expectedOwner`: if the chain's current owner ≠ pointer owner, surface "pointer and chain owner
   differ" in the UI; do not re-interpret history.
2. Pointer rotation field `rot=<b64url sig by previous owner over "mw-rot-v1\n"+new owner+"\n"+seq>`:
   accepted silently when valid and `seq` is higher; the prompt remains only for rotations without
   `rot`. `seq` must be monotonic per **scope**, not per key (M7).
3. Delegated moderation instead of root login: `Policy.moderators: [pub…]` (owner-only op).
   Moderators may `tombstone` and edit `notice`-type keys but not `policy`/`owner`. The owner signs the
   delegation once in Node (`tools/`) naming the fingerprint their browser shows, and imports the
   resulting block through the existing Export/Import UI; the browser never holds the root key.
   Rename "owner login" to "import owner-signed block"; keep `mw.owner.policy` but have it fail with
   `E_NOT_OWNER` unless the node identity *is* the owner (which should only happen in `tools/`).
4. README: "The owner key is the site's root of trust. Keep it offline. Compromise of the key alone
   cannot redirect visitors in per-domain mode (DNS or host write access is also needed), but it can
   seize the chain permanently."

### M4 — IndexedDB is trusted but writable by same-origin script

**Where.** ARCH §5 step 4 ("if `sites[btih]` is complete → render immediately from IndexedDB, then
seed … `skipVerify`"), §4 sources (cache as source 4; pins), §13; INTERFACES `cache.js` (`files`,
`pointers`, `pins`), `torrent.js` `seedFromCache`.

**Problem.** The loader treats `mw-sites` as integrity-protected. It is not: in per-domain mode the
site's own JavaScript (hence any XSS in it) and in hub mode any other site can write it. Consequences:
a poisoned `files` entry is rendered on every subsequent load (persistent XSS that survives until the
owner changes the btih) and *uploaded to peers* via `skipVerify`; a poisoned `pins[scope]` locks the
visitor out of legitimate updates ("publisher key changed" forever) or, combined with a poisoned
`pointers[scope]`, serves attacker content whenever DoH is unavailable (offline path).

**Exact change.**
1. `app.js` cache path: before `mountSite` **and** before `seedFromCache`, verify the cached site:
   `sha1(bencode(info)) === btih` from the *pointer* (never from IDB), then SHA-1 every piece from the
   stored blobs against `info.pieces` (WebCrypto `SHA-1`, ~0.5 s for 48 MiB on a phone; show "verifying
   cache"). Keep the result in memory for this page load only — never persist a `verifiedAt` that the
   same adversary could write. On mismatch: delete the site, fall back to download.
2. `cache.js`: a pin is honoured only if `pins[scope].owner` also matches the owner of the *currently
   verified* pointer record stored alongside it (`{ owner, record, sig }`); a pin without a verifiable
   signed record is treated as absent and re-established by TOFU. This does not stop a same-origin
   attacker, but it does stop stale/partial writes from locking users out, and it makes the lock-out
   require forging a full signed record.
3. CRITIQUE/README: "In per-domain mode the cached copy is as trustworthy as the site's own code.
   Site owners must treat XSS as loader compromise."

### M5 — Framing, clickjacking and URL-bar spoofing

**Where.** ARCH §7 (SW response headers for `/_mw/s/*`; navigation routing; renderer mirrors the iframe
path), §13 (shell CSP as `<meta>`), §4 ("confirm button" for key change), §8 (consent/settings).

**Problem.**
- `/_mw/s/<btih>/index.html` responses have no `frame-ancestors`, so `evil.com` can
  `<iframe src="https://example.com/_mw/s/<btih>/index.html">` (navigations into our scope are
  served by the SW) and frame the real site, and the shell's CSP is a `<meta>` tag, which cannot carry
  `frame-ancestors`; static hosts like GitHub Pages cannot add headers. The shell's "publisher key
  changed → Confirm", consent and "uploads on" controls are therefore clickjackable; combined with a
  one-off DNS spoof that is a full takeover.
- A user who opens a shared link `https://example.com/_mw/s/<btih>/about.html` top-level gets the
  site with no loader: no seeding, no bridge, `mw.ready()` never resolves.
- Links inside the site navigate the *iframe* cross-origin (`<a href="https://evil.example">`); the top
  URL bar keeps showing `https://example.com/…` while the frame shows attacker content. The bridge's
  `event.source === iframe.contentWindow` check stays **true** after that navigation (the WindowProxy
  is the same object); only the `origin` check protects the bridge, and the renderer's
  `history.replaceState` mirroring throws `SecurityError` when it reads the location.

**Exact change.**
1. `sw.js`: add to every `/_mw/s/*` response `Content-Security-Policy: frame-ancestors 'self'` and
   `X-Frame-Options: SAMEORIGIN`, plus `Referrer-Policy: no-referrer` in all modes (not hub only).
2. `sw.js`: if `request.mode === 'navigate' && request.destination === 'document'` (top-level) and
   the path is under `/_mw/s/`, respond `302` to the site-relative path (`/about.html`) so the shell
   mounts it.
3. `index.html`/`boot.js`: `if (window.top !== window.self) { show "Open this page directly"; stop }`
   before any UI is rendered (a sandboxed framing attempt has an opaque origin and no access to the
   victim's state, so this check is sufficient). DEPLOY.md: send `X-Frame-Options: DENY` on the shell
   where the host allows it.
4. `render.js`: on iframe `load`, try `iframe.contentWindow.location.href`; on `SecurityError`, tear the
   frame down (`src='about:blank'`) and show an interstitial "This site tried to open an external
   page; open it in a new tab?" (track the last same-origin path to restore). `sdk.js`: intercept
   clicks on cross-origin anchors and `window.open(href, '_blank', 'noopener')` instead.
5. Keep both bridge checks; add a comment that `source` equality alone is not an origin check.

### M6 — Third-party exposure contradicts the "no third parties / visitor privacy" framing

**Where.** ARCH §0 ("Third-party commodity pieces … must be honest about"), §4 (two DoH resolvers in
parallel; re-check every 10 min and on focus), §5 step 4 ("magnet with `tr`/`ws` from the pointer
merged with defaults"), §8 (consent notice shown "first run", uploads opt-out "still downloads via
peers"), §10 (`tracker.mjs`), §13.

**Problem.**
- Trackers: WebTorrent appends `client.tracker.announce` to every torrent unless the info dict is
  `private` (torrent.js 342–345), and the loader additionally merges defaults. So even an owner who
  runs their own tracker leaks `(visitor IP, btih, timestamps, peer offers)` to whichever public
  trackers ship in `config.js` — functionally a third-party analytics beacon on every page view.
- DoH: both Cloudflare and Google receive `_magnet.<hostname>` for every visitor on every load and
  every 10 minutes while the tab is open, whether or not the visitor uses them as resolvers. The
  "disagreement" heuristic buys little once records are signed and pinned.
- IP exposure starts before the consent line is shown (tracker announce + offers happen in step 4,
  notice in step 6/7), and persists with uploads off because downloading over WebRTC also exposes the
  IP; there is no genuinely private mode. Anyone who learns the btih from DNS can join the swarm and
  enumerate visitor IPs continuously (offers carry ICE candidates with the public address).
- `tracker.mjs` as specified is an **open** WebSocket tracker; a public one will be discovered and
  used for arbitrary swarms, making the owner a tracker operator for content they never chose.

**Exact change.**
1. `torrent.js`/`publish.mjs`: when the signed pointer carries `tr=`, use **only** those; defaults
   apply to raw magnets only. `publish.mjs` sets `private: true` in the info dict when `--tr` is given
   so WebTorrent itself cannot append client-level trackers (this changes the infohash, which is fine
   at publish time). Document in DEPLOY: "run your own tracker (one container) or accept that the
   default public trackers see every visitor".
2. `doh.js`: query one resolver (operator-configurable in the shell `<meta name="mw-doh">`), the
   second only on failure/NXDOMAIN; cache the answer for its TTL (min 5 min) and re-check on that
   schedule, not every 10 min. DEPLOY: ship the `<meta name="mw-pointer">` as the primary mechanism;
   DNS is for `#host:` and hosts that cannot edit the shell.
3. `app.js`: on first run show the notice **before** the first announce; until acknowledged, download
   from the web seed only when a `ws=` exists (otherwise the notice is a blocking consent). Add a
   setting "Web seed only (no peer connections)" and label "Uploads off" accurately: "still connects to
   peers; your IP is visible".
4. `tracker.mjs`: `filter(infoHash, params, cb)` allow-list from a `--allow <btih>…`/file option, on by
   default; refuse to start without one unless `--open` is passed.
5. ARCH §0/§13/README: list the parties that see a visit in each configuration (static host, tracker
   operators, STUN operators, DoH resolver(s), web seed host, other visitors) in one table.

### M7 — Pointer record: signing input under-specified; `exp` optional; `seq` per key; no domain separation

**Where.** ARCH §4 (grammar, signature input, validity), INTERFACES `pointer.js` (`signingInput`,
`verifyPointer`), `crypto.js`.

**Problem.** "keys case-insensitive", "whitespace around `;` ignored", "value exactly as it appears",
"unknown keys ignored" and "sorted by key then value" leave implementations free to diverge (does the
signer lowercase keys? trim values? include unknown keys?). Divergence means a valid record fails on
one browser build and the resolver falls through to a *less trusted* source. If unknown keys are
excluded from the signed set, an attacker who can edit DNS can later add a key a future loader honours
(e.g. a redirect) under a still-valid signature. `tr`/`ws` URLs may legitimately contain `;`, which
breaks the grammar. IDN hostnames have two forms (U-label/A-label); `scope` must be one of them.
`exp` "if present" lets a signed record of a compromised version be replayed to new visitors forever.
`seq` monotonic per owner key lets a rotation (M3) restart at 0. The owner key signs two formats
(pointer input, block `h`); they cannot collide today, but there is no explicit separation.

**Exact change.** Rewrite §4 as:
- Parser: split on `;`, trim, split on first `=`, **lowercase the key**, keep the value trimmed and
  otherwise verbatim; values MUST be percent-encoded where they contain `;`, `=`, newline or
  non-ASCII (publish.mjs does this; parser decodes only `dn`).
- Signing input: `"mw-pointer-v1\n" + <all pairs except sig, including unknown keys, as
  lowercased key + "=" + value, sorted by key then value, joined by "\n"> + "\n" + scope`; `scope`
  = hostname in lowercase A-label form (`new URL(…).hostname`), or `btih:<hex>`.
- Blocks sign `"mw-block-v1\n" + h`.
- Signed records: `exp` REQUIRED, `exp - now ≤ 400 days`, publish default 90 days; UI warns at 14
  days left. `seq` REQUIRED and monotonic per scope regardless of key.
- Multiple TXT records: choose the highest valid `seq`; tie → lexicographically smallest `sig`.
  Unit tests for each rule (INTERFACES §12 already lists variants; add these).

### M8 — Retention and redistribution: no takedown, unbounded growth, Safari eviction

**Where.** ARCH §5 step 4 (cache forever), §6.6 (blocks forever), §8 (consent copy), §11 (guestbook),
INTERFACES `cache.js` (`listSites`, `deleteSite` exist but nothing calls them automatically).

**Problem.**
- When the owner publishes a new `seq`, visitors who still have the old btih keep rendering it until
  reload and keep **seeding** it indefinitely. The owner therefore cannot take content down — the one
  moderation action a publisher is legally most likely to need.
- Hub visitors accumulate every site they ever opened (files + chains), each seeding on visit.
- Chain payloads (user posts) are stored and re-served by every visitor forever unless the owner
  tombstones; visitors have no local "hide and purge". `ts` at millisecond precision is a timing
  fingerprint of the author in a permanent public log.
- WebKit deletes all script-writable storage for a site after seven days of Safari use without
  interaction with it: identity (so the visitor can no longer tombstone their own posts), pins (TOFU
  window reopens silently) and the cache vanish.

**Exact change.**
1. `app.js`: when a newer valid pointer replaces a btih for a scope, `deleteSite(oldBtih)` and stop
   seeding it; keep at most the current version per scope. This is the takedown path — say so in
   DEPLOY ("to remove content, publish a new version; visitors drop the old one on their next load").
2. Hub: LRU cap (default 512 MiB total, 30 days unused) with per-site "Forget this site".
3. Chain: per-chain byte cap (M1), local "hide & purge payload" (stub stays for DAG connectivity,
   exactly like a tombstone but local), `ts` rounded to the minute by `createBlock`.
4. `navigator.storage.persist()` on first write; UI text: "Posts are public and copied to every
   visitor. Deleting removes the content from cooperating visitors only." Document the WebKit
   7-day rule in README so identity loss is not reported as a bug.

### M9 — Secure-context requirement makes the LAN demo claim false on phones

**Where.** ARCH §11 ("prints the hub URL to open in any browser on the LAN"), §5 step 1 (feature
detection lists `crypto.subtle`), §10 (`dev-server.mjs`, plain HTTP).

**Problem.** Service workers and `crypto.subtle` exist only in secure contexts (`https:` or
`localhost`). A phone opening `http://192.168.x.y:8080/#…` has neither: boot.js reports "missing
crypto.subtle", no identity can be created, no SW can register, and the demo fails or runs in
degraded mode without the chain — the opposite of what the demo exists to show. This is a security
property of the platform presenting to the user as a broken product.

**Exact change.** `dev-server.mjs --tls` using a `mkcert`-generated cert (document the one-time
`mkcert -install` on the phone) or `adb reverse tcp:8080 tcp:8080` for Android (then `localhost`
works), and let `boot.js` say "This page must be served over HTTPS (or localhost)" when
`!window.isSecureContext`. Update §11 wording accordingly.

### M10 — Supply chain and the SRI claim

**Where.** `package.json` (`"allowScripts": { "esbuild@0.28.2": true }` with no
`@lavamoat/allow-scripts` dependency), ARCH §10 (`copy webtorrent.min.js`), §13 ("Shell integrity:
… SRI on the shell's script tags").

**Problem.** The `allowScripts` key is read only by `@lavamoat/allow-scripts`; without it every
install script runs (esbuild's, playwright's, and anything a future transitive dep adds).
**Correction (v0.2.1, DIGEST-AMENDMENTS F8):** wrong for npm 11.19 and later, which reads `allowScripts`
as a working default-deny (a planted `postinstall` was blocked; research w2b-05 F34, PRODUCTION-DIGEST
P0-12). The rest of this item (hash-pinned bundle, the limits of SRI) stands. The shipped
`webtorrent.min.js` is upstream's prebuilt minified bundle copied from `node_modules`; the lockfile
pins the tarball, but `build.mjs` will happily copy whatever file is on the build machine. SRI covers
`boot.js`/`loader.js` only; `import('./webtorrent.min.js')`, the worker and the SW script are not
covered by SRI, and the hashes live in `index.html` on the same host — so SRI defends against nothing
in this threat model and the honest statement is that the static host is the trust root on every load.

**Exact change.** `.npmrc` with `ignore-scripts=true` (esbuild's platform binary arrives via
`optionalDependencies`; run `node node_modules/esbuild/install.js` once if needed) or add
`@lavamoat/allow-scripts` properly; `build.mjs` records `sha256(webtorrent.min.js)` in
`build.lock.json` and fails on mismatch; §13 rewrite: "The static host is the trust root for the shell
on every load (including SW updates). SRI is applied to the two static script tags for defence in
depth only."

---

## 3. MINOR

**m1 — Rate-limit/budget rejections and orphan quotas** (ARCH §6.2, §6.5). A block rejected for
rate/budget on node A but accepted on B will be WANTed again by A every 10 s indefinitely; if A caches
"rejected by `h`" it never converges. Rule: never remember rate/budget rejections by hash; keep a
per-peer orphan quota (≤ 200) and WANT a parent only from the peer that delivered the orphan.

**m2 — `allow-modals` in hub mode** (ARCH §7). `alert()`/`confirm()` from a hub site render as
"hub.example says:", a cheap spoof of loader prompts. Remove `allow-modals` from the hub sandbox.

**m3 — SDK without a parent / opaque origin** (ARCH §9, INTERFACES sdk.js). If the site is opened
top-level (M5 case) `window.parent === window` and `mw.ready()` never resolves; add a 5 s timeout
rejecting with `E_NO_HOST`. See B1 change 5 for the `"null"` origin case.

**m4 — Root key on disk** (ARCH §10). `keygen.mjs` must write `owner.jwk` with mode `0o600` and
`publish.mjs` must refuse a key file readable by group/other; print the fingerprint, never the key.

**m5 — Wire adapter hygiene** (ARCH §6.5, INTERFACES wire-ext.js). Skip wires with
`wire.type === 'webSeed'`; ignore `mw_chain` messages before `onExtendedHandshake` confirms `m.mw_chain`
(bittorrent-protocol dispatches `extended` messages by our local id regardless); treat a HELLO with
`site` mismatch as detach, not just ignore, so the peer cannot keep consuming budget.

---

## 4. Residual risks to state to the user (README / CRITIQUE wording)

1. Visitor IPs are visible to every other visitor, to the trackers, to the STUN servers and to the
   web seed; there is no private mode other than "web seed only". Anyone who knows the public btih can
   list current visitors.
2. In per-domain mode the site, the loader and the cache share one origin; the site is fully trusted.
   Shared-origin hubs give sites full mutual access; isolation requires per-site origins.
3. The chain is a public, permanent, replicated log moderated by the owner; PoW is a nuisance cost;
   `open` writers can be flooded within the budgets you configure.
4. First visit is trust-on-first-use. A DNS/resolver-path attacker on a first visit of an unsigned
   or unpinned site wins; pinning plus signatures protects every later visit.
5. The static host and the owner key are the roots of trust; losing the key seizes the chain, losing
   the host seizes everything.
6. Visitors redistribute whatever the current version contains (and, in hubs, whatever they opened).
   Takedown is "publish a new version"; cached copies on offline visitors persist until they reload.

## 5. Strengths worth keeping exactly as designed

- Content is addressed by infohash, so peers, trackers, web seeds and DNS are untrusted for
  integrity; only the pointer needs trust, and the signed/scoped/seq-protected record with TOFU is the
  right shape (scope binding kills cross-domain replay).
- Deterministic `(depth, h)` ordering with `ts` excluded prevents the usual timestamp games; no
  consensus/token theatre.
- Bridge checks both `event.source` and `event.origin`, JSON-only payloads, `textContent` UI.
- Per-peer invalid/byte budgets, frame caps, orphan cap, `max=` size cap, `nosniff`, no third-party
  scripts, self-hosted bundles, honest non-goal on anonymity, upload opt-out.
- Random peer id per page load (webtorrent index.js:57) — no cross-session tracking by peer id.

## 6. Not verified in this pass

- Whether Chromium dispatches the SW `fetch` event for a navigation into a sandboxed iframe
  *without* `allow-same-origin` (I expect not; B1 assumes the SW cannot serve such frames — confirm in
  the spike before building any isolated variant).
- WebKit's current behaviour for `navigator.storage.persist()` versus the 7-day eviction.
- Throughput numbers for PoW are order-of-magnitude estimates; measure with the real `canonicalize`.
