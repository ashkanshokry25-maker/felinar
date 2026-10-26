# 06 - Browser "blockchain" nodes vs signed DAG/CRDT replication

**Project:** magnet-web (serverless, magnet-addressed sites, visitor-replicated DB)
**Research date:** 2026-10-14. Every "current" statement is as of that date.
**Scope of this file:** what a real blockchain node can and cannot do in a browser; why a browser-only PoW chain fails; the Merkle-CRDT / OrbitDB pattern; status of the candidate libraries; Hashcash anti-spam numbers; canonical JSON; Ed25519 / ECDSA in WebCrypto; key storage; and a recommended data model.

## 0. How to read this document

- **Confidence.** `high` = primary source read in this session and/or measured in this session. `medium` = primary source partly read, or corroborated only by secondary sources. `low` = search-result snippet only, or my inference (labelled).
- **"Measured"** = I ran it on 2026-10-14 in headless Brave (UA `HeadlessChrome/155.0.0.0`) on a MacBook Air (Apple M3, macOS 27.0.1), inside Web Workers, with a throw-away profile and a localhost-only server. These are **desktop numbers only**. I did not test on any phone. Every phone figure below is a third-party report and is labelled as such.
- **Design-critical (★)** marks findings that would change the architecture if they were wrong.
- Source dates are the publication or last-update date of the source where one was visible; "undated" where the fetched page showed none.
- Web-search summaries were used only as pointers. Anything that matters was re-read from the primary page, the registry, or the repository.

---

## 1. Summary

1. **★ A browser "blockchain node" cannot be our database.** Real chain clients that run in a browser exist in 2026 - Helios `@a16z/helios` 0.12.0 (2026-10-05), Lodestar `@lodestar/light-client` 1.43.0 (2026-05-20), smoldot 3.7.0 (2026-10-07, with browser WebRTC to public full nodes), Celestia Lumina - but all are **light clients that verify someone else's chain** through RPC / beacon-API / WebSocket / WebRTC links to servers (and, for the Ethereum clients, a trusted checkpoint). None can host our application data, none participates as an equal in the chain's gossip from a browser, and none is serverless. I found no browser-native Bitcoin P2P node. Nostr is a signed-event format with relay servers, not a chain.
2. **★ A browser-only proof-of-work chain is unsound.** PoW security assumes honest CPU majority (Nakamoto 2008). One RTX 4090 does about 2.2x10^10 SHA-256/s (hashcat forum) = about 1,650x a fully loaded 5-worker M3 browser (1.3x10^7 H/s, measured) = about 2x10^5x an iPhone running a naive WebCrypto solver (about 10^5 H/s, published). Small PoW chains are 51%-attacked with rented hash power in practice (Ethereum Classic, Jul-Aug 2020: about 17.5 BTC of rented hash power for a >3,000-block reorg). Selfish mining pays below 1/4 of hash power. And the chain only exists while at least one foreground tab holds it: iOS reportedly suspends WebRTC in the background, Safari deletes script-written storage after 7 days of Safari use without interaction, and browser eviction is all-or-nothing.
3. **★ The right primitive is a "blockchain-shaped log without consensus":** per-author signed, hash-chained operations that form a causal Merkle-DAG (a Merkle-CRDT), a deterministic reducer, and an owner-signed policy log for moderation. This is what OrbitDB's oplog does (signed entries, Lamport clock, deterministic LWW sort), what the Merkle-CRDT paper describes (while warning that plain CRDTs assume non-adversarial replicas, hence the signatures), and what Kleppmann & Howard formalise as Byzantine Eventual Consistency (apps that tolerate arbitrary numbers of Byzantine nodes are Sybil-immune by design). Guestbook / comments / reactions fit. Name registries, balances, one-person-one-vote and unique-visitor counts do **not**.
4. **No candidate library should be adopted wholesale** (table in section 2.5). OrbitDB 4.0.0 is the closest conceptual match but needs Helia + libp2p and, per its own docs, a relay server for browser-to-browser links. y-webrtc has had no release since 2023-12-28 and **all three of its default signaling servers are dead** (verified 2026-10-14). automerge-repo has no WebRTC adapter and its npm `latest` tag points to an alpha. Gun is relay-centric on a slow cadence. Peerbit is active but its ACL v2 (roles, deterministic revocation) is still in progress (issue #1346, Aug 2026). Hypercore/Hyperswarm officially target Bare/Node/Pear; in browsers only via an experimental relay marked "Do not use it in production". SSB's JS stack has been dormant since 2023. Use them as design references.
5. **Crypto:** Ed25519 in WebCrypto now ships in every major engine: Chrome / Edge / Android WebView **137**, Firefox **129** (not 130 - 130 is X25519), Safari / iOS **17**, Samsung Internet **30**. Measured on M3: WebCrypto Ed25519 verify 34-35k/s vs 2.4k/s for `@noble/ed25519` in JS (about 14x). Use WebCrypto when present, `@noble/ed25519` 3.2.0 (3.9 KB gzip) as fallback. ECDSA P-256 is universal but is a different identity type. **Safari produces randomized Ed25519 signatures**, so never derive an operation ID from signature bytes.
6. **★ Key and storage persistence is the weakest link on iOS.** A non-extractable Ed25519 `CryptoKey` round-trips through IndexedDB in Chromium (tested), but WebKit has open bugs (non-extractable X25519 comes back `null`, bug 312279, filed 2026-04-14; `CryptoKey` as a property of an indexed record, bug 177350, open since 2017; ongoing ECDSA `DataCloneError` reports from iOS Safari as of 2026-10-14). Safari also drops script-written storage after 7 days of Safari use without interaction (Home Screen web apps are exempt), and eviction deletes the whole origin at once - identity key and DB together. Design: runtime self-test, seed fallback, explicit export/backup.
7. **PoW as anti-spam is a speed bump, not a defence.** Published phone rates for naive WebCrypto-loop solvers are about 40-120 kH/s; an optimized single-block solver is about 4.6x faster than a WebCrypto loop on desktop (measured). At 16 bits a phone pays about 0.14-1.6 s, a single GPU can still mint about 3x10^5 messages/s. Real defences: owner moderation, subjective mute lists, optional capability mode. Commit the target difficulty inside the op (the NIP-13 trick).
8. **Platform facts that shape the node:** `RTCPeerConnection` does not exist in dedicated Workers (measured in Chromium 155; also smoldot's changelog) so the transport stays on the main thread; Chrome exempts hidden pages with an open `RTCDataChannel` from intensive timer throttling, but Safari/Firefox lack the Page Lifecycle `freeze` event and iOS reportedly suspends WebRTC in the background, so on phones "node" means "foreground tab"; `SharedWorker` reached Chrome Android only in v148 (Samsung Internet: none) so coordinate tabs with Web Locks + BroadcastChannel; Brave randomizes `navigator.hardwareConcurrency`.
9. **Recommended data model (section 3.1):** device-key authors; op = canonical bytes `B` with `{v, db, a, s, p, d[], c, e, t, x, ts, pw}`; `id = SHA-256(domain || B)`; `sig = Ed25519(domain || B)`; transmit `B` verbatim; validity is a pure function of the op set; view = deterministic fold ordered by `(c, a, id)`; owner moderation = ban / hide / policy / fence / checkpoint ops in the owner's own hash-chained log, precedence by **owner sequence number**, never by timestamp; sync by heads + range-based set reconciliation riding the torrent's BEP-10 extension channel; owner-signed checkpoints for bootstrap and pruning.
10. **Top risks to resolve before building:** (a) site code must not share an origin with the identity key / DB (section 3.1.9); (b) iOS key + DB persistence; (c) availability without an always-on peer; (d) moderation semantics under reordering; (e) legal exposure from every visitor relaying user-posted content; (f) Safari Lockdown Mode (used by security-hardened visitors) reportedly disables JIT / WebAssembly / WebRTC, so the loader needs a clear "unsupported configuration" path.

---

## 2. Findings

### 2.1 What real blockchain nodes can run in a browser in 2026

**F1 (★) Helios is a real in-browser Ethereum light client, but it needs two third-party servers and a trust anchor.** *Confidence: high.*
- `@a16z/helios` **0.12.0** was published 2026-10-05 (9 npm versions since 2025-06-17, MIT). It ships WASM + TypeScript bindings "for web and Node.js", as UMD and ES module, and exposes an EIP-1193 provider via `createHeliosProvider({executionRpc, consensusRpc, network, checkpoint}, 'ethereum')`. It also supports OP Stack (`op-mainnet`, `base`) and Linea.
- README: Helios "converts an untrusted centralized RPC endpoint into a safe unmanipulable local RPC". The execution RPC "must be a supported Ethereum Execution API Provider that provides the `eth_getProof` endpoint". The consensus RPC "must be a consensus node that supports the light client beaconchain api" (default `https://www.lightclientdata.org`, run by the Helios authors).
- Trust root: the weak-subjectivity checkpoint - "If this is set to a malicious value, an attacker can cause the client to sync to the wrong chain." Checkpoints under two weeks old are recommended; older ones work with a warning because "there are theoretical attacks".
- Therefore it reads and verifies Ethereum state (accounts, storage, receipts via proofs). It does not validate every block, does not join Ethereum gossip, does not store the chain, and cannot hold *our* data.
- Sources: [a16z/helios README](https://raw.githubusercontent.com/a16z/helios/master/README.md) (read 2026-10-14), [helios-ts README](https://raw.githubusercontent.com/a16z/helios/master/helios-ts/README.md) (read 2026-10-14), [npm registry @a16z/helios](https://registry.npmjs.org/@a16z/helios) (queried 2026-10-14).

**F2 (★) Lodestar's light client also runs in a browser but needs a beacon node exposing four REST routes.** *Confidence: high.*
- `@lodestar/light-client` **1.43.0** (2026-05-20, Apache-2.0). README: "Access to a beacon node that supports the light client specification is necessary", specifically `GET /eth/v1/beacon/light_client/updates`, `.../optimistic_update`, `.../finality_update`, `.../bootstrap/{block_root}`. "System requirements are quite low so its possible to run a light client in the browser".
- Start-up is `Lightclient.initializeFromCheckpointRoot({config, transport: new LightClientRestTransport(api), genesisData, checkpointRoot, ...})`. A single browser distribution build exists since 1.20.0 (`lightclient.min.mjs`, global `window.lodestar.lightclient`, with a documented top-level-await timing hack).
- Same limits as F1: REST transport to a server, a checkpoint root as trust anchor, headers + sync-committee verification only.
- Sources: [npm readme @lodestar/light-client](https://registry.npmjs.org/@lodestar/light-client) (registry JSON, 2026-10-14).

**F3 Nimbus has a verified proxy, not a proven browser client.** *Confidence: low-medium (search snippets + issue titles only; README not read in full).*
- `nimbus_verified_proxy` (in `status-im/nimbus-eth1`) is a light-client-backed JSON-RPC proxy: it "stores no data", needs an upstream JSON-RPC endpoint with `eth_getProof`, and a trusted block root of roughly the last one to two weeks. A maintainer comment on nimbus-eth1 issue #467 reportedly says WASM packaging has sort of happened, but only for the verified proxy (paraphrase of a search snippet). The Nimbus guide labels the consensus light client BETA.
- I could not confirm an officially supported browser build. Treat Nimbus as "unverified in browsers".
- Sources: [nimbus_verified_proxy README](https://github.com/status-im/nimbus-eth1/blob/master/nimbus_verified_proxy/README.md) and [issue #467](https://github.com/status-im/nimbus-eth1/issues/467) (search-result snippets, 2026-10-14), [Nimbus guide](https://nimbus.guide/consensus-light-client.html).

**F4 (★) smoldot (Polkadot/Substrate) is the most mature browser chain client, and it shows the real shape of a browser "node": browser -> public full node, authenticity not validity.** *Confidence: high.*
- `smoldot` **3.7.0** (2026-10-07; license `GPL-3.0-or-later WITH Classpath-exception-2.0` per npm metadata), used via `polkadot-api` 3.2.1 (2026-10-02). README: "Works both in the browser and in NodeJS/Deno"; "Light clients don't verify whether blocks are valid but only whether blocks are _authentic_."
- Its CHANGELOG shows browser WebRTC (libp2p `webrtc-direct`) is enabled by default ("WebRTC is now considered stable enough to be enabled by default", with a `forbidWebRtc` option). 3.7.0 adds DNS-over-HTTPS resolution because "A browser cannot put a domain name in a WebRTC session description". Another entry: WebRTC is "forbidden instead" of crashing in worker threads "where `RTCPeerConnection` doesn't exist".
- These WebRTC links go from the browser to a **public full node with a stable UDP address and cert hash**. They are not browser-to-browser.
- Sources: [smoldot README](https://github.com/paritytech/smoldot) (read), [smoldot wasm-node CHANGELOG](https://raw.githubusercontent.com/paritytech/smoldot/main/wasm-node/CHANGELOG.md) (3.7.0 entry dated 2026-10-07), [npm smoldot](https://registry.npmjs.org/smoldot).

**F5 Celestia's Lumina is a Rust light node that targets WASM.** *Confidence: medium.*
- README: "Rust implementation of Celestia's data availability node able to run natively and in browser-based environments", with data availability sampling and "Native and browser persistent storage". The only transport the README names is WebTransport ("browsers only allow WebTransport to be used in Secure Context"). Serving it in a browser currently requires compiling `lumina-cli` manually. Browser transport details beyond WebTransport are unverified.
- Source: [celestiaorg/lumina](https://github.com/celestiaorg/lumina) (README read 2026-10-14).

**F6 Bitcoin and Nostr.** *Confidence: Bitcoin low-medium, Nostr high.*
- Bitcoin: I found no browser-native P2P node. Bitcoin's P2P layer is TCP, which a page cannot open (see F7). BIP-157/158 light clients such as Kyoto are native Rust libraries; I found no browser build. Browser wallets therefore must talk to HTTP / WebSocket servers (not verified in detail).
- Nostr is not a blockchain. NIP-01: `id` = SHA-256 of a fixed JSON-array serialization `[0, pubkey, created_at, kind, tags, content]` with explicit escaping rules; `sig` = BIP-340 Schnorr over secp256k1 of that id; relays are WebSocket servers. NIP-13 defines PoW as leading zero bits of the id, with the target difficulty committed in a `nonce` tag. NIP-77 wraps Negentropy set reconciliation. Useful as a *format* reference, not as a serverless substrate.
- Sources: [NIP-01](https://raw.githubusercontent.com/nostr-protocol/nips/master/01.md), [NIP-13](https://raw.githubusercontent.com/nostr-protocol/nips/master/13.md), [NIP-77](https://raw.githubusercontent.com/nostr-protocol/nips/master/77.md) (all read 2026-10-14); Kyoto/bip157 (search results only).

**F7 (★) Structural browser limits: no raw sockets, no listening, WebRTC needs signaling.** *Confidence: high.*
- OrbitDB docs: "For various security reasons, a browser cannot dial another peer over a raw TCP or QUIC connection from within a web page." and "Browsers do not listen for incoming connections ... for a browser to respond to an incoming connection a relay is required". per a search-result snippet of the js-libp2p docs / Dec 2023 release post, extra server(s) are needed to connect two browsers because signaling is not part of the WebRTC specification, and libp2p does that signaling over circuit-relay-v2 connections.
- Consequence: any browser chain client is a *client of servers* (RPC, beacon API, WSS full nodes, relays) unless a signaling channel exists. For us that channel can be the WebTorrent tracker network (see F55), which is itself volunteer infrastructure.
- Sources: [OrbitDB CONNECTING_PEERS.md](https://raw.githubusercontent.com/orbitdb/orbitdb/main/docs/CONNECTING_PEERS.md) (read), [js-libp2p release post](https://blog.libp2p.io/releases/2023-12-12-js-libp2p/) (snippet, 2023-12-12).

**F8 (★) Synthesis - what browser chain nodes can and cannot do.** *Confidence: high (synthesis of F1-F7).*

| Can | Cannot |
|---|---|
| Verify headers / finality / sync-committee signatures and Merkle proofs for *another chain's* state | Store or serve the chain, or act as a gossip peer for it |
| Run in WASM from a static page | Run without RPC / beacon / WSS servers or without a trusted checkpoint |
| Persist a small checkpoint (e.g. 32 bytes for Helios) | Validate every block (smoldot: authenticity, not validity) |
| Give an on-chain read of ENS / token / contract state | Host *our* app data without gas, a wallet, and a chain choice |
| (smoldot) open WebRTC to public full nodes | Make browser-to-browser links without a signaling relay |

---

### 2.2 Why a browser-only proof-of-work chain is insecure and impractical

**F9 (★) PoW's security premise is a CPU-majority assumption that visitors cannot meet.** *Confidence: high.*
- Nakamoto: "The system is secure as long as honest nodes collectively control more CPU power than any cooperating group of attacker nodes." "Proof-of-work is essentially one-CPU-one-vote." The same text notes that one-IP-one-vote "could be subverted by anyone able to allocate many IPs" - exactly the Sybil problem that PoW exists to price.
- Source: [Bitcoin whitepaper](https://bitcoin.org/bitcoin.pdf) (2008, text read via pdftotext 2026-10-14).

**F10 (★) Hash-rate asymmetry is 3-5 orders of magnitude against even a modest attacker (one GPU vs one browser).** *Confidence: desktop numbers high (measured); phone numbers medium (third-party); GPU/ASIC numbers medium-high (forum + computed).*

| Actor | SHA-256 rate | Basis |
|---|---|---|
| iPhone / Android, naive WebCrypto-loop solver | about 4x10^4 - 1.2x10^5 H/s | ALTCHA/Infobip (Galaxy A14: 100k hashes in 2.5 s; "Phone 12 mini": 0.83 s); Anubis reports on HN: iPhone 17 about 100 kH/s, iPhone 12 mini about 110 kH/s, iPhone Air about 90 kH/s |
| Desktop M3, 1 Worker, WebCrypto loop | 0.70 MH/s | **measured** |
| Desktop M3, 1 Worker, custom single-block JS | 3.2-3.7 MH/s | **measured** |
| Desktop M3, 4-5 Workers, custom JS | 13.0-13.2 MH/s | **measured** |
| 1 x RTX 4090 (hashcat mode 1400) | about 2.18x10^10 H/s | hashcat forum post (Jan 2023) |
| 1 x RTX 5090 (hashcat mode 1400) | about 2.72x10^10 H/s | hashcat forum benchmark thread |
| Bitcoin network | about 9.5x10^20 H/s | **computed**: difficulty 132.72T (CoinWarz, Oct 2026) x 2^32 / 600 s (that is double-SHA-256 work) |

One RTX 4090 is about 1,650 fully loaded M3 browsers and about 2x10^5 iPhone-class naive solvers. Three hundred concurrent visitors all hashing flat-out add up to about 1.4x10^8 H/s (phones at about 0.46 MH/s each, extrapolated) up to about 4x10^9 H/s (maxed-out 13 MH/s desktops) - roughly 0.6% to 18% of one RTX 4090 - and real visitors do not hash continuously. Rented hash power makes that GPU (or many) available by the hour.
- Sources: [hashcat forum RTX 4090](https://hashcat.net/forum/post-57490.html), [hashcat forum RTX 5090](https://hashcat.net/forum/post-62406.html) (both via search snippets), [CoinWarz difficulty](https://www.coinwarz.com/bitcoin-difficulty) (snippet, Oct 2026), [Infobip/ALTCHA](https://www.infobip.com/developers/blog/beyond-the-puzzle-lessons-from-our-captcha-evolution) (2025-10-29, read), [HN thread](https://news.ycombinator.com/item?id=49500040) (read; comments about 44 days before 2026-10-14), my benchmark (Appendix A).

**F11 Small PoW chains are 51%-attacked with rented hash power.** *Confidence: high for ETC (CoinDesk read), medium for Bitcoin Gold (secondary).*
- Ethereum Classic, Jul 29 - Aug 6 2020: per Bitquery (quoted by CoinDesk) the attacker "paid about 17.5 BTC ($204,000)" for hash power from a NiceHash seller and double-spent "a little over 800,000 ETC (about $5.6 million)"; the first reorg exceeded 3,000 blocks, the second exceeded 4,000. ETC hash rate was about 1.6 TH/s.
- Bitcoin Gold, Jan 2020: reports of NiceHash-sourced reorgs costing on the order of $1,700 each (secondary sources; low-quality aggregator figures disagree).
- Sources: [CoinDesk 2020-08-06](https://www.coindesk.com/tech/2020/08/06/ethereum-classic-suffers-second-51-attack-in-a-week) (read), [Cloud Security Alliance, "Rent to Pwn"](https://cloudsecurityalliance.org/blog/2020/11/20/rent-to-pwn-the-blockchain-51-attacks-made-easy) (snippet).

**F12 The "honest majority" bar is lower than 50%.** *Confidence: high.* Eyal & Sirer show selfish mining is profitable below the "wrongly assumed 1/2 bound" - "less than 1/4 of the resources" - and that rational miners would drift toward a majority. Source: [arXiv 1311.0243](https://arxiv.org/abs/1311.0243) (2013, abstract read).

**F13 (★) A visitor-hosted chain has no persistence guarantee.** *Confidence: high for Chrome / WebKit documented behavior, medium for iOS WebRTC suspension (developer reports only).*
- Safari ITP deletes "all of a website's script-writable storage after seven days of Safari use without user interaction on the site" (IndexedDB included); Home Screen web apps have their own counter. MDN: eviction is all-or-nothing per origin ("all of its data, not parts of it, is deleted at the same time"). Details in F25.
- Chrome: hidden pages "won't be discarded unless under extreme resource constraints" if they play audio or use WebRTC; the Page Lifecycle `freeze` event is Chrome-only ("Safari: not supported. Firefox: not supported."). iOS Safari: developers report WebRTC "suspended as soon as the screen locks or Safari goes into the background" (Apple Developer Forums, Feb 2025, no Apple reply). See F22-F23.
- Net: the chain exists only while at least one foreground tab with the data is online, and a mobile visitor's copy can vanish. "All visitors keep the chain alive" is true only in aggregate and only while they are looking at the page.

**F14 Silent hashing is a trust, legal and blocking risk.** *Confidence: medium-high.*
- Eskandari et al. (2018): the Coinhive library "will use all available CPU resources" by default; most scripts were configured near 25% CPU; "resource consumption of in-browser cryptojacking can noticeably degrade a computer's performance". The paper cites the May 2015 New Jersey AG settlement with a browser-miner developer: "No website should tap into a person's computer processing power without clearly notifying the person and giving them the chance to opt out." Mozilla blocks known cryptominer domains by default in Enhanced Tracking Protection (Disconnect lists; default since Firefox 69, Sept 2019). Coinhive shut down 2019-03-08, citing a >50% hash-rate drop after a Monero fork and an XMR price fall.
- Domain-based blocking is unlikely to hit our own loader, but sustained background hashing would look identical to what users and blockers hate. Only hash on an explicit user action, with visible progress and cancel.
- Sources: [arXiv 1803.02887](https://arxiv.org/abs/1803.02887) (read), [Mozilla blog on cryptominer blocking](https://blog.mozilla.org/en/products/firefox/firefox-news/todays-firefox-blocks-third-party-tracking-cookies-and-cryptomining-by-default/) (snippet, 2019), [Security Affairs on Coinhive](https://securityaffairs.com/81775/breaking-news/coinhive-shutdown.html) (snippet, 2019-02-28).

---

### 2.3 Merkle-CRDTs, OrbitDB's oplog, and Byzantine Eventual Consistency

**F15 (★) The Merkle-CRDT paper is the right base pattern - and states its own limits.** *Confidence: high.*
- Sanjuan, Poyhtari, Teixeira, Psaras, arXiv:2004.00107 v2 (27 Apr 2020). Merkle-DAG nodes are self-verifying through their CID and "can be fetched (pulled) from any source willing to provide them, trusted or not". A Merkle-DAG acts as a logical clock ("Merkle-Clock") that every replica builds without coordination; no consensus needed; scales "to the order of thousands of replicas".
- Quote that matters for us: CRDTs "are useful in non-adversarial scenarios, where the participating replicas are known to behave correctly." Hence signatures and an authorization layer must be added by us.
- Limitations the authors list: ever-growing DAG; "deep and thin" DAGs make cold syncs slow ("may take significantly longer than it would take to ship a snapshot"); discarding history "should not be attempted before making sure that every replica is aware of them", which "requires either having knowledge of the current replica-set or using an external source of truth (i.e. a blockchain)". They also note signatures may be put on broadcast messages instead of payloads to keep them out of the DAG.
- Our reading: owner-signed checkpoints + snapshot torrents are the "external source of truth" for pruning and fast bootstrap.
- Source: [arXiv:2004.00107](https://arxiv.org/abs/2004.00107) (PDF read via pdftotext).

**F16 OrbitDB's oplog is a production example of the pattern.** *Confidence: high.*
- Entry fields (docs example): `v, id, key, sig, next[], refs[], clock{id,time}, payload{op,key,value}, identity` stored as IPLD (DAG-CBOR). Entries are "cryptographically signed by the writer which is then verified by the receivers". The oplog "is formally a Merkle-CRDT".
- Ordering: "a deterministic sort function ... By default, an oplog uses a Last Write Wins sort function, which uses a logical clock (Lamport Clock)"; ties broken by the writer's clock id; the example log sorts A1, B1, A2, B2, A3.
- Signature scheme: the sample entry has a 33-byte compressed secp256k1 `key` and a DER `sig` (not Ed25519, not WebCrypto).
- Sources: [OrbitDB OPLOG.md](https://raw.githubusercontent.com/orbitdb/orbitdb/main/docs/OPLOG.md), [IDENTITIES.md](https://raw.githubusercontent.com/orbitdb/orbitdb/main/docs/IDENTITIES.md) (read 2026-10-14).

**F17 OrbitDB's access control is write-allowlist based; moderation of open-write DBs is not built in.** *Confidence: medium-high (docs read; code not audited).*
- `IPFSAccessController`: write list fixed at creation ("The access information cannot be changed after the initial setup (as it is immutable)"), `write: ['*']` allows anyone. `OrbitDBAccessController`: mutable, with `grant` / `revoke` of a capability per identity id. Custom controllers implement `canAppend(entry)`.
- The docs do not describe ban semantics for wildcard-write databases, nor how revocation interacts with entries already replicated (Peerbit calls that same class of problem a "revocation race", F32). Treat OrbitDB's ACL as a starting point, not a moderation system.
- Source: [OrbitDB ACCESS_CONTROLLERS.md](https://raw.githubusercontent.com/orbitdb/orbitdb/main/docs/ACCESS_CONTROLLERS.md).

**F18 (★) OrbitDB status on 2026-10-14: v4.0.0, not v2/v3.** *Confidence: high.*
- `@orbitdb/core` **4.0.0** published 2026-05-14 (98 npm versions; tags v2.4.x/2.5.0, v3.0.0-3.0.2, v4.0.0). v4 is the "Upgrade to libp2p 3 / Helia 6" release (commits 2026-03-29/30); `engines.node >= 22`. Dev dependencies: `helia ^6.0.22`, `@libp2p/gossipsub ^15.0.16`, `@libp2p/circuit-relay-v2 ^4.1.7`; runtime dependencies include `@ipld/dag-cbor`, `@libp2p/crypto`, `level`. npm `helia` latest is **7.1.16** (2026-09-29), one major ahead of what OrbitDB 4 develops against - compatibility with Helia 7 is unverified.
- v3 (2025) was announced as "feature-complete" with modular encryption. Repo: 8,818 stars, 27 open issues, last push 2026-05-14, **no GitHub Releases** (tags only). README claims "works both in Browsers and Node.js". Older packages `orbit-db` (0.29.0) and `ipfs-log` (6.0.0) are marked "Package no longer supported" on npm (Jan 2023).
- Weight: `dist/orbitdb.min.js` is 250,867 bytes (unpkg listing) *without* Helia / libp2p; bundlephobia puts `helia@7.1.16` alone at 1.10 MB min / **318 KB gzip** with 31 dependencies.
- Sources: [npm @orbitdb/core](https://registry.npmjs.org/@orbitdb/core), [package.json](https://raw.githubusercontent.com/orbitdb/orbitdb/main/package.json), [repo tags/commits](https://github.com/orbitdb/orbitdb), [OrbitDB June 2025 post](https://orbitdb.substack.com/p/what-happened-at-orbitdb-in-june) (snippet), [unpkg listing](https://unpkg.com/@orbitdb/core@4.0.0/?meta), [bundlephobia](https://bundlephobia.com/package/helia@7.1.16) - all queried 2026-10-14.

**F19 (★) OrbitDB in a browser is not serverless: browser-to-browser needs a relay.** *Confidence: high.* OrbitDB's own docs: "A connection cannot be made directly to a browser node ... a relay is required to 'listen' on the browser's behalf", "A relay server is required to facilitate the discovery of a node and establish a direct connection to another node", and the test relay is started with `npm run webrtc`. OrbitDB + Helia would add a second signaling / peer-discovery plane next to WebTorrent's trackers. Source: [OrbitDB CONNECTING_PEERS.md](https://raw.githubusercontent.com/orbitdb/orbitdb/main/docs/CONNECTING_PEERS.md).

**F20 (★) Theory: some DB apps are Sybil-immune by design - the justification for "no consensus".** *Confidence: high for the abstract; the paper body was not read.* Kleppmann & Howard (arXiv:2012.00472, 2020-12-01): "there is a category of database applications that are, by design, immune to Sybil attacks because they can tolerate arbitrary numbers of Byzantine-faulty nodes", characterised as **Byzantine Eventual Consistency (BEC)** and achieved by an algorithm "based on Byzantine causal broadcast". Apps such as double-spend prevention are outside that category (my inference; the abstract does not enumerate them). Source: [arXiv:2012.00472](https://arxiv.org/abs/2012.00472).

**F21 Autobase is a second, independent precedent for "causal DAG of signed single-writer logs + linearization + quorum checkpoint".** *Confidence: high for README facts.* "Autobase writer nodes explicitly reference previous nodes creating a causal directed acyclic graph"; nodes are linearized and, "as new causal information comes in, existing nodes may be reordered ... Any changes to the view will be undone and reapplied" (i.e. the view is a recomputable fold); a `signedLength` checkpoint is "signed by a quorum of indexers"; writer membership changes are ops (`addWriter`). This maps to our design with a single indexer (the owner). Source: [autobase README](https://raw.githubusercontent.com/holepunchto/autobase/main/README.md) (read; v7.28.2, 2026-09-08).

---

### 2.4 Platform facts that constrain "every visitor is a node"

**F22 Chrome keeps hidden pages with an open data channel out of intensive throttling and discarding, but the lifecycle API is Chrome-only.** *Confidence: high (Chrome docs read).*
- Page Lifecycle: browsers "occasionally freeze and discard hidden tabs (at their discretion)". Hidden pages observed playing audio, "using WebRTC", updating the title/favicon, showing alerts or sending push "won't be discarded unless under extreme resource constraints". Recommended `freeze` handler: close IndexedDB / BroadcastChannel connections, close WebRTC, close WebSockets, release Web Locks. Support: Chrome 68, Edge 79, **Safari "not supported", Firefox "not supported"**. (Page undated in my fetch.)
- Chrome 88 intensive wake-up throttling (timers batched to once per minute) applies only if the page has been hidden >5 minutes, chain count >=5, silent >=30 s **and "WebRTC is not in use"**; "in use" means an `RTCPeerConnection` with an open `RTCDataChannel`. No WebSocket exemption is described. (Chrome blog, last updated 2021-01-18.)
- Sources: [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api), [Timer throttling in Chrome 88](https://developer.chrome.com/blog/timer-throttling-in-chrome-88).

**F23 (★) On iOS assume the node is alive only while the tab is in the foreground.** *Confidence: medium-low (developer reports; no Apple statement found).*
- Apple Developer Forums (Feb 2025, 0 replies): "in iOS Safari, these technologies [WebRTC and Web Audio] are suspended as soon as the screen locks or Safari goes into the background." Apple DTS (Sep 2025, about *native* apps): "Once your app gets suspended, however, all low-level networking stops." I found no WebKit document that settles the Safari-page case.
- Design consequence: on `visibilitychange` / `pageshow` re-announce, reconnect and run a fast anti-entropy pass; never assume background gossip on phones.
- Sources: [Apple forum thread 774239](https://developer.apple.com/forums/thread/774239), [thread 799259](https://developer.apple.com/forums/thread/799259).

**F24 (★) `RTCPeerConnection` is not available in dedicated Workers (Chromium); tab coordination needs Web Locks + BroadcastChannel.** *Confidence: high for Chromium (measured), unknown for Safari/Firefox.*
- Measured in Chromium 155: inside a dedicated Worker `typeof RTCPeerConnection === 'undefined'`, while `crypto.subtle`, `indexedDB` and `navigator.locks` exist. smoldot's changelog independently records the same ("inside a worker thread, where `RTCPeerConnection` doesn't exist"). So the WebRTC transport (WebTorrent) lives on the main thread; hashing, signature verification, DAG merge and PoW go to Workers via transferable buffers.
- MDN compat data: `SharedWorker` Chrome 5 / **Chrome Android 148** / Firefox 29 (Android 33) / Safari 16 / Samsung Internet only 4.0 (removed in 5.0); Web Locks `navigator.locks.request`: Chrome 69, Firefox 96, Safari 15.4; `BroadcastChannel`: Chrome 54, Firefox 38, Safari 15.4. Use a Web Lock to elect one tab as the single "node" per browser profile and BroadcastChannel to let other tabs read from it; do not depend on SharedWorker.
- Sources: my test page (Appendix A), [smoldot CHANGELOG](https://raw.githubusercontent.com/paritytech/smoldot/main/wasm-node/CHANGELOG.md), [MDN BCD api/SharedWorker.json, LockManager.json, BroadcastChannel.json](https://github.com/mdn/browser-compat-data) (fetched 2026-10-14).

**F25 (★) Storage persistence differs sharply by browser, and eviction is all-or-nothing.** *Confidence: high.*
- `navigator.storage.persist()`: Chrome 55, Firefox 57, Safari 15.2 (`estimate()`: Safari 17). MDN: Firefox shows a permission prompt; "Safari and most Chromium-based browsers ... automatically approve or deny the request based on the user's history of interaction with the site". WebKit: grants "based on heuristics like whether the website is opened as a Home Screen Web App"; an origin "might be excluded from eviction if it has active page at the time of eviction, or its storage is in persistent mode".
- Safari ITP (WebKit, 2020-03-24; MDN restates it): "all of a website's script-writable storage after seven days of Safari use without user interaction on the site" - IndexedDB, LocalStorage, SessionStorage, service-worker registrations and caches. "Web applications added to the home screen are not part of Safari and thus have their own counter of days of use." A visitor who does not interact with the origin within 7 days of Safari use loses the identity key and the DB.
- MDN: "When an origin's data is evicted by the browser, all of its data, not parts of it, is deleted at the same time." Quotas: Chromium up to 60% of disk; Firefox best-effort min(10% of disk, 10 GiB), persistent up to 50%; Safari browser apps about 60% per origin (80% overall).
- Chromium 155 test profile: `navigator.storage.persist` exists, `persisted()` was `false` by default.
- Sources: [WebKit: Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) (2020-03-24), [WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/) (2023-08-10), [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [BCD api/StorageManager.json](https://github.com/mdn/browser-compat-data).
- I found no source confirming that the 7-day rule is unchanged in Safari 18 / 26 / 27; WebKit's tracking-prevention page (search snippet) still lists it.

**F26 Safari Lockdown Mode may disable JIT, WebAssembly and WebRTC; Apple's own page is vague.** *Confidence: medium-low.*
- Apple Support (published 2026-09-14): "Certain complex web technologies are blocked, which might cause some websites to load more slowly or not operate correctly"; users can exclude a site per-site. The page does not name JIT, WebAssembly or WebRTC. Third-party analyses (iOS 16, 2022) report JIT and WebAssembly disabled and WebRTC peer connections / data channels unavailable. WebKit bug 273824 (filed 2024-05-07, still NEW, last activity 2025-03-14): WebAssembly stays blocked since iOS 17.4 "even when an exception is added".
- Consequence: the loader (WebRTC + WASM + JS-heavy crypto) probably cannot run for such visitors; detect and show an explicit message. Without JIT, pure-JS PoW and noble verification will be far slower (unmeasured).
- Sources: [Apple Support 105120](https://support.apple.com/en-us/105120), [WebKit bug 273824](https://bugs.webkit.org/show_bug.cgi?id=273824), [sevarg.net analysis](https://www.sevarg.net/2022/07/20/ios16-lockdown-mode-browser-analysis/) (snippet).

**F27 On iPhone all mainstream browsers are WebKit; iOS 17 is the Ed25519 floor.** *Confidence: high for the guideline, medium for the device cutoff.*
- App Store guideline 2.5.6: "Apps that browse the web must use the appropriate WebKit framework and WebKit JavaScript. You may apply for an entitlement to use an alternative web browser engine ... for the EU and Japan." So Chrome / Firefox / Brave / Edge on iPhone follow the Safari matrix, with the EU/Japan alternative-engine exception.
- iOS 17 needs an A12 or later: iPhone 8, 8 Plus and X stay on iOS 16 and therefore lack WebCrypto Ed25519 (Safari 17 is the first version). Keep a JS fallback.
- Sources: [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [9to5Mac iOS 17 compatibility](https://9to5mac.com/2023/09/18/ios-17-compatible-iphone/) (snippet, 2023-09-18).

**F28 Brave randomizes `navigator.hardwareConcurrency`.** *Confidence: medium-high.* Brave's farbling table lists "Hardware Concurrency"; on this 8-CPU Mac, three headless Brave launches reported 5, 4 and 5. Do not size a PoW worker pool from it blindly: cap at 4 and calibrate by measuring a short burst. Source: [Brave farbling](https://dev-pages.brave.software/fingerprinting/farbling.html) (read), my runs (Appendix A).

---

### 2.5 Candidate libraries: status and fit (as of 2026-10-14)

| Library | Latest / date | Browser connectivity | Authorship + moderation | Verdict |
|---|---|---|---|---|
| **OrbitDB** `@orbitdb/core` | 4.0.0 / 2026-05-14 | libp2p via Helia; browser-to-browser needs a relay (docs) | Signed entries (secp256k1); immutable allowlist or grant/revoke; no documented ban semantics | Best conceptual reference; do not depend on it |
| **Peerbit** `peerbit` | 5.4.10 / 2026-10-02 (`@peerbit/shared-log` 16.0.40) | libp2p; browser bootstrap not read | `TrustedNetwork` has "one undifferentiated trusted role"; v2 (roles, deterministic revocation) in progress | Watch; not for now |
| **Hypercore / Hyperswarm / Autobase** | hypercore 11.39.0 / 2026-10-14; hyperswarm 4.17.2; autobase 7.28.2 | Docs list Bare / Node / Pear only; browsers via `@hyperswarm/dht-relay` 0.4.3 (2023-10-30): "experimental. Do not use it in production"; `hyperswarm-web` 2.2.0 (2022-02-15) | Signed single-writer logs; Autobase membership via `addWriter` ops | Design reference; not a browser option |
| **Gun** `gun` | 0.2020.1241 / 2025-07-01 | WebSocket relay peers (README); `lib/webrtc.js` exists with Google + Cloudflare STUN | Timestamp-`state` LWW with deferred future states; SEA for user auth | No |
| **Yjs** + y-webrtc | yjs 13.6.33 / 2026-09-23 (v14 beta); y-webrtc 10.3.0 / **2023-12-28**; y-websocket 3.1.0 / 2026-08-06 | y-webrtc needs signaling; **all 3 default signaling servers dead** | No per-update signatures; room password only | Fine for trusted collaborators; not for public writes |
| **Automerge** + automerge-repo | automerge 3.5.0 / 2026-09-16; automerge-repo stable 2.5.6 / 2026-05-18 (npm `latest` tag = **2.6.0-alpha.3**) | Official adapters: WebSocket, MessageChannel, BroadcastChannel; **no WebRTC adapter** (npm `@automerge/automerge-repo-network-webrtc` is 404; community `automerge-repo-network-peerjs` 1.2.3 / 2024-09-12) | Keyhive / Beelay / Subduction access control are pre-alpha | No for now |
| **Secure Scuttlebutt** | ssb-db2 8.1.0 / 2023-11-21; ssb-browser-core 14.0.0 / 2023-01-12 | n/a | Subjective follow graph | Lessons only (F34) |
| **Nostr** `nostr-tools` | 2.25.2 / 2026-09-04 | WebSocket relays | Per-event Schnorr signatures; NIP-13 PoW | Format reference (F6) |
| **Minimal op-log (section 3.1)** | `@noble/ed25519` 3.2.0 + `canonicalize` 5.1.0 + `idb-keyval` 6.3.0 | Rides WebTorrent BEP-10 (F55) | Owner policy log | **Recommended**, but we then own protocol risk |

Sizes (bundlephobia, entry bundle, minified / gzip): helia 7.1.16 1.10 MB / 318 KB (31 deps); @orbitdb/core 4.0.0 242 KB / 75.5 KB (excludes Helia/libp2p); yjs 93.7 KB / 28.2 KB; @automerge/automerge 3.5.0 **4.92 MB / 1.64 MB** (default entry; WASM embedded, slimmer builds unmeasured); gun 41.6 KB / 16.2 KB; @noble/ed25519 8.1 KB / 3.9 KB; canonicalize 2.1 KB / 0.9 KB; idb-keyval 2.1 KB / 0.8 KB; tweetnacl 32.3 KB / 10.7 KB; hash-wasm (whole library) 215 KB / 77.7 KB. (libp2p 3.3.12 returned no bundlephobia result; a full OrbitDB browser stack is strictly larger than Helia alone.)

**F29 (★) Yjs + y-webrtc: stale, dead defaults, and no authorship.** *Confidence: high for versions and the dead defaults; the authorship point is my inference.*
- y-webrtc 10.3.0 was last published 2023-12-28; it builds on `simple-peer` 9.11.1 (2022-02-17). README defaults: `signaling: ['wss://signaling.yjs.dev', 'wss://y-webrtc-signaling-eu.herokuapp.com', 'wss://y-webrtc-signaling-us.herokuapp.com']`. **Verified 2026-10-14:** `signaling.yjs.dev` is a CNAME to a `herokudns.com` target that returns no address (Cloudflare and Google DoH return only the CNAME; `curl` cannot resolve it), and both herokuapp hosts answer HTTP 404 "No such app". The README claim "public signaling servers are available" is no longer true.
- README: `password` encrypts traffic over untrusted signaling servers; peers form a mesh capped at `20 + floor(rand*15)` connections; "Not suited for a large amount of collaborators on a single document".
- Inference: Yjs updates carry no per-author signatures and the only access control is the shared room password, so any peer can emit updates that edit any part of the shared document. Fine inside a trusted group, wrong for public guestbook-style writes.
- Sources: [y-webrtc README](https://raw.githubusercontent.com/yjs/y-webrtc/master/README.md), [npm y-webrtc](https://registry.npmjs.org/y-webrtc), [npm yjs](https://registry.npmjs.org/yjs), DNS/HTTP probes run 2026-10-14.

**F30 Gun: relay-centric, timestamp-based LWW, slow cadence.** *Confidence: medium.*
- `gun` 0.2020.1241 published 2025-07-01 (previous: 2024-04-05, 2022-12-23, 2022-08-09). README tells you to run relay peers (Heroku / Docker / etc.) and warns the Docker image "may be old with missing security updates". `lib/webrtc.js` exists in the repo (uses `stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`) but the README does not describe it. Conflict resolution uses timestamps as `state`: future-dated updates are deferred ("the joke is on them, they will have to wait 2 years"), ties resolved by lexical sort; the talk admits NTP "does not give you any formal guarantees". I found no CVE for `gun` in one search (absence not verified).
- Sources: [npm gun](https://registry.npmjs.org/gun), [gun README](https://raw.githubusercontent.com/amark/gun/master/README.md), [lib/webrtc.js](https://raw.githubusercontent.com/amark/gun/master/lib/webrtc.js), [gun.eco "distributed matters"](https://gun.eco/distributed/matters.html).

**F31 Automerge: strong CRDT, no WebRTC adapter, heavy bundle, access control not ready.** *Confidence: high for npm/README facts, medium for Keyhive status.*
- README adapters: WebSocket, MessageChannel, BroadcastChannel ("simple (inefficient) tab-to-tab"). npm `@automerge/automerge-repo-network-webrtc` returns 404. The `latest` dist-tag of `automerge-repo` and its adapters currently points at `2.6.0-alpha.3` while the newest stable is 2.5.6 - **pin versions explicitly**. Dist-tags also show `subduction` and `experimental` (3.0.0-experimental.2) lines. Keyhive (convergent-capability access control), Beelay and its successor Subduction are described by Ink & Switch as pre-alpha.
- Sources: [automerge-repo README](https://github.com/automerge/automerge-repo), [npm registry](https://registry.npmjs.org/@automerge/automerge-repo), [Ink & Switch Keyhive](https://www.inkandswitch.com/keyhive/) (snippet).

**F32 (★) Peerbit's open ACL issue names exactly the moderation hazard we must design around.** *Confidence: high.*
- `peerbit` 5.4.10 (2026-10-02), very active. Issue #1346 "TrustedNetwork v2: roles, deterministic revocation, and future-write confidentiality" (opened 2026-08-30, still open): "`TrustedNetwork` currently has one undifferentiated trusted role"; "Validating trust only when an entry is first ingested leaves races around revocation and offline replicas"; "Merely deleting a trust relation at local arrival time is insufficient." Proposed: versioned membership records with a policy epoch, and either "a linearized, authority-signed policy head that writes are bound to" or short-lived signed capabilities with fixed expiry; plus epoch-key encryption. Status 2026-09-03: "foundation, not an owner-revocation API".
- Our model (section 3.1) adopts the policy-head / epoch approach and makes validity a pure function of the op set.
- Sources: [peerbit issue #1346](https://github.com/dao-xyz/peerbit/issues/1346) (read), [npm peerbit](https://registry.npmjs.org/peerbit).

**F33 Hypercore / Hyperswarm: very active, but not a browser stack.** *Confidence: high.* Holepunch's docs list the supported runtimes as Bare, Node.js, Pear (desktop / mobile / terminal); browsers are not listed. The only browser route is `@hyperswarm/dht-relay` (README: "This project is still experimental. **Do not use it in production**"; a relay runs a full DHT and, in "custodial" mode, handles secret keys) or the stale `hyperswarm-web`. Sources: [docs.pears.com](https://docs.pears.com/), [dht-relay README](https://github.com/holepunchto/hyperswarm-dht-relay), npm registry.

**F34 (★) Secure Scuttlebutt lessons.** *Confidence: medium (protocol guide read; critique and forum are informal).*
- Format: `previous`, `author`, `sequence`, `hash`, `signature`; "A message ID is a hash of the message including signature"; the signature "must be the last entry in the dictionary".
- Keys: "If a user loses their secret key or has it stolen they will need to generate a new identity"; "Each device still uses its own identity, there is no avoiding that" (archived fusion-identity section).
- Forks: the guide is silent; a community thread says that if a forked feed's branches both sync, "your feed is effectively dead" (search snippet, undated). Restored backups on a second device are the usual cause.
- Signing fragility (informal 2020 critique, Sitaker): "the same design error as XML canonicalization and ASN.1 DER, only botched"; feed requests have no byte limit ("150 bytes or 150 megabytes").
- Ecosystem: `secure-scuttlebutt` is deprecated (renamed `ssb-db`); `ssb-db2` last release 2023-11-21; `ssb-browser-core` 2023-01-12.
- Lessons we apply: sign exact bytes; one key per device and detect forks deterministically; bound response sizes; cheap new identities, content outlives keys; subjective mute lists complement owner moderation.
- Sources: [SSB protocol guide](https://ssbc.github.io/scuttlebutt-protocol-guide/) (read), [Sitaker notes](https://derctuo.github.io/notes/secure-scuttlebutt.html) (read, 2020), [npm registry](https://registry.npmjs.org/ssb-db2).

**F35 Willow / Meadowcap: delegable capabilities without revocation.** *Confidence: medium-high.* Meadowcap capabilities are chains of signed delegations restricted by subspace, path and time range; "communal" vs "owned" namespaces. The spec page describes **no revocation mechanism**; instead capabilities are time-bounded ("valid for one week at a time") and an owner can overwrite a bad actor's entries with "Entries from the future". Useful for an optional capability mode, with the caveat that time-based expiry needs a trustworthy clock. Source: [Meadowcap spec](https://willowprotocol.org/specs/meadowcap/index.html) (read).

---

### 2.6 Hashcash-style PoW for anti-spam: phone numbers, difficulty, Sybil limits

**F36 (★) Measured desktop SHA-256 rates in a Worker (Brave / Chromium 155, Apple M3).** *Confidence: high for these machines; they are NOT phone numbers.* Inputs are 43 bytes (one SHA-256 block). All four implementations were cross-checked for identical digests before timing.

| Implementation | Rate (hashes/s) | Relative |
|---|---|---|
| Custom single-block JS (specialised hashcash loop) | 3.23-3.67 million | 1.0x |
| `hash-wasm` 4.12.0 (WASM, sync after init) | 3.21 million | 1.0x |
| `@noble/hashes` 2.4.0 `sha256` (generic JS) | 0.87 million | 0.27x |
| `crypto.subtle.digest`, `await` each call | 0.70-0.75 million | 0.21x (4.6x slower than custom JS) |
| `crypto.subtle.digest`, 64 or 1024 calls in flight | 0.53-0.55 million | slower than sequential |
| Custom JS, 5 Workers (run 1) / 4 Workers (run 3) | 13.2 / 13.0 million total | about 4x of 1 Worker |

Raw output is in Appendix A; the single-file page that reproduces it is Appendix B and should be run on real phones.

**F37 Published phone figures (third-party; anecdotal or vendor-run).** *Confidence: medium-low.*
- ALTCHA via Infobip (2025-10-29), 100,000 SHA-256 cycles per solve: Galaxy A14 (2023) 2.5 s (about 40 kH/s); "Phone 12 mini (2020)" 0.83 s (about 120 kH/s); MacBook Pro M3 Pro 0.33 s (about 300 kH/s); AWS EC2 c6a.xlarge 1 s; AWS Lambda 1 GB 8 s. The article notes consumer devices "significantly outperform cloud servers" - i.e. PoW as a bot filter against *server-side* scrapers, not against GPUs.
- Anubis users on Hacker News (comments about 44 days before 2026-10-14): iPhone 17 about 100 kH/s ("difficulty level 6 ... takes ~180sec"), iPhone 12 mini about 110 kH/s, iPhone Air about 90 kH/s, Pixel 8 on Firefox "slightly less than a minute" for the same site, iPad Pro M2 about 30 s vs about 3 s on a Mac Studio. Anubis' docs say difficulty "defaults to 5 leading zeroes" without stating hex digits vs bits; the HN numbers fit hex digits (16^6 / 100 kH/s = 168 s).
- Cap.js (WASM 0.0.7, vendor benchmark, "difficulty 4 with 50 challenges", hash count per challenge not defined on the page): Galaxy A34 795 ms, iPhone SE (2020) 798 ms, Pixel 7 423 ms, Pixel 9 414 ms, M3 MacBook 212 ms.
- Order of magnitude: **naive WebCrypto-loop solvers are about 10^5 H/s on phones**; WASM / specialised solvers finish sub-second at modest difficulty. An optimized phone solver is plausibly 0.3-1 MH/s per core, but that is my **extrapolation** (naive phone rate x the 4.6x desktop ratio = about 0.46 MH/s), not a measurement.
- Sources: [Infobip](https://www.infobip.com/developers/blog/beyond-the-puzzle-lessons-from-our-captcha-evolution), [HN item 49500040](https://news.ycombinator.com/item?id=49500040), [Cap.js benchmark](https://capjs.js.org/guide/benchmark.html), [Anubis how-it-works](https://raw.githubusercontent.com/TecharoHQ/anubis/main/docs/docs/design/how-anubis-works.mdx).

**F38 Do not use `crypto.subtle.digest` as the inner loop.** *Confidence: high (desktop), medium (phones).* On M3 it is 4.6x slower than a specialised JS loop and batching does not help (F36); on iPhones the published figure for WebCrypto-loop solvers is only about 100 kH/s (F37). Anubis reportedly switches to a pure-JS SHA-256 on Firefox / Pale Moon "for speed" (search snippet, not confirmed in its docs). Use a single-block specialised loop (message <= 55 bytes) or WASM, in Workers.

**F39 (★) Difficulty table and the attacker's side.** *Confidence: arithmetic is exact; inputs are as labelled.* Expected work is 2^bits hashes; actual solve time is exponentially distributed (5% of solves take more than 3x the mean, 0.7% more than 5x).

| bits | expected hashes | Galaxy A14 naive (40 kH/s) | iPhone naive (100 kH/s) | phone optimized (about 460 kH/s, **extrapolated**) | M3, 1 Worker (3.2 MH/s) | M3, 4-5 Workers (13.2 MH/s) | one RTX 4090 (21.8 GH/s): messages/s |
|---|---|---|---|---|---|---|---|
| 14 | 16,384 | 0.41 s | 0.16 s | 36 ms | 5 ms | 1.2 ms | 1.3x10^6 |
| 16 | 65,536 | 1.6 s | 0.66 s | 0.14 s | 20 ms | 5 ms | 3.3x10^5 |
| 17 | 131,072 | 3.3 s | 1.3 s | 0.29 s | 41 ms | 10 ms | 1.7x10^5 |
| 18 | 262,144 | 6.6 s | 2.6 s | 0.57 s | 81 ms | 20 ms | 8.3x10^4 |
| 20 | 1,048,576 | 26 s | 10.5 s | 2.3 s | 0.33 s | 80 ms | 2.1x10^4 |
| 22 | 4,194,304 | 105 s | 42 s | 9.1 s | 1.3 s | 0.32 s | 5.2x10^3 |

Reading: a difficulty that costs a mid-range phone one second still lets a single consumer GPU mint hundreds of thousands of messages per second. PoW can stop casual scripts; it cannot stop a motivated attacker. Reasonable defaults: **16 bits** for ordinary posts (about 0.1-1.6 s on phones), owner-raisable to **18-20** during an attack, and never above what a low-end phone can finish in a few seconds. Splitting the work into several smaller sub-puzzles (Cap.js uses 50) cuts the variance for the same expected cost.

**F40 (★) Sybil resistance cannot come from PoW; design for it instead.** *Confidence: high.*
- Douceur (IPTPS 2002): "without a logically centralized authority, Sybil attacks are always possible except under extreme and unrealistic assumptions of resource parity and coordination among entities".
- Laurie & Clayton (WEIS 2004, about email): puzzle difficulty derived from spammer economics (>= 5.8 s per message for break-even on a $500 PC, 50 s to restore 0.1 cent/email pricing) and from botnet "free CPU" (346 s for S = 0.01) would stop "significant numbers of senders of legitimate email"; "proof-of-work will not be a solution to the problem of spam". The numbers are 2004 email economics; the structural argument (attackers have cheap or stolen or specialised compute, legitimate users do not) transfers directly.
- Kleppmann & Howard (F20): choose application semantics that tolerate arbitrary Byzantine nodes.
- Sources: [Douceur](https://www.microsoft.com/en-us/research/publication/the-sybil-attack/) (snippet), [Laurie & Clayton PDF](https://www.cl.cam.ac.uk/~rnc1/proofwork.pdf) (read), [Back, Hashcash](https://www.hashcash.org/papers/hashcash.pdf) (2002, intro read).

**F41 Borrow NIP-13's PoW details.** *Confidence: high.* Difficulty = leading zero bits of the id; the miner commits the target difficulty in the nonce tag ("clients can protect against situations where bulk spammers targeting a lower difficulty get lucky and match a higher difficulty"); verification is a few lines of code. Hashcash is non-interactive here (no server issues a challenge), so the stamp must bind to the author, sequence, database and body to prevent reuse. Source: [NIP-13](https://raw.githubusercontent.com/nostr-protocol/nips/master/13.md).

---

### 2.7 Deterministic canonical JSON (RFC 8785 JCS)

**F42 RFC 8785 is usable but is an Independent-stream Informational RFC with sharp edges.** *Confidence: high (RFC read).*
- RFC 8785 (June 2020; authors Rundgren, Jordan, Erdtman; "Independent Submission", "Category: Informational"). It builds on ECMAScript JSON serialization of primitives, constrains data to I-JSON (RFC 7493) and sorts properties deterministically.
- Rules: no duplicate property names; strings must be valid Unicode and "lone surrogates ... MUST cause a compliant JCS implementation to terminate with an appropriate error"; numbers must be IEEE-754 doubles serialized per ECMAScript 7.1.12.1 (with Note 2); NaN / Infinity are errors; larger integers "RECOMMENDED to represent ... as JSON strings"; property names sorted by UTF-16 code units; "all components involved in a scheme depending on JCS MUST preserve Unicode string data 'as is'" (no normalization).
- Appendix A is a roughly 50-line ECMAScript sample canonicalizer that explicitly omits error handling and UTF-8 generation.
- Source: [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (full text read).

**F43 JavaScript JCS libraries.** *Confidence: high.*
- `canonicalize` **5.1.0** (2026-09-18): zero dependencies, ESM, TypeScript types, npm provenance attestation, maintained by the RFC co-author (`samuelerdtman`); 2.1 KB min / 0.9 KB gzip (bundlephobia). Note three major releases in five months (3.0.0 on 2026-04-08, 4.0.0 on 2026-08-12, 5.0.0 on 2026-09-08, then 5.1.0 on 2026-09-18); pin the version and review the diff.
- `json-canonicalize` 3.0.1 (2026-09-10, a different maintainer); `@truestamp/canonify` 2.1.0 (2023-01-19).
- Sources: [npm canonicalize](https://registry.npmjs.org/canonicalize), [bundlephobia](https://bundlephobia.com/package/canonicalize@5.1.0).

**F44 (★) Prefer "sign the exact bytes" over "sign the canonical form of an object".** *Confidence: high (design reasoning backed by three sources).* SSB's signed-JSON format is called "the same design error as XML canonicalization and ASN.1 DER, only botched" (informal critique, F34). Nostr avoids the problem with a fixed positional array and explicit escaping rules (NIP-01, F6). The Merkle-CRDT paper suggests signing the message rather than re-deriving it (F15). Recommended: the creator produces canonical bytes `B` once (JCS or a fixed array), the wire format carries `B` verbatim, `id = SHA-256(domain || B)`, `sig = Ed25519(domain || B)`, and verifiers never re-serialize. Deterministic CBOR (RFC 8949 section 4.2) / DAG-CBOR (as OrbitDB uses) is a binary alternative; I did not evaluate it.

---

### 2.8 Signatures and keys in the browser

**F45 (★) WebCrypto support matrix (MDN browser-compat-data `main`, fetched 2026-10-14).** *Confidence: high for Chrome / Firefox / Safari (BCD + IPFS blog agree), medium for Samsung Internet (BCD only).*

| Engine | Ed25519 (`generateKey`/`sign`/`verify`/`importKey`/`exportKey`) | X25519 | ECDSA P-256 |
|---|---|---|---|
| Chrome desktop + Android | **137** (2025-05-27) = first unflagged release (BCD records no earlier entry; earlier flagged availability not verified) | 133 | 37 |
| Edge | **137** (2025-05-29) | 133 | Chromium-based |
| Android WebView | **137** | - | - |
| Firefox desktop + Android | **129** (2024-08-06) | **130** (2024-09-03) | 34 |
| Safari macOS + iOS | **17.0** (2023-09-18) | 17 | 7 |
| Samsung Internet | **30.0** (Chromium 143, 2026-05-11); **29.0 (Chromium 136) lacks it** | - | - |
| Brave / Opera | Chromium-based; same Chromium >= 137 rule (exact Brave / Opera versions not looked up) | | |

- Correction to the brief: Firefox's Ed25519 is **129**; **130** is X25519.
- Spec state: Ed25519 is now in the W3C Web Cryptography API Level 2 Editor's Draft (11 Aug 2026; 44 mentions) and the WICG "Secure Curves" CG report (28 Jan 2026). `SubtleCrypto.supports()` (static feature test) exists only in Chrome 155 and is flagged experimental - feature-detect with `try { await crypto.subtle.generateKey({name:'Ed25519'}, ...) }` instead.
- IPFS blog (2025-08-13): Ed25519 "is now supported in every major browser engine, reaching 79% and counting"; expects confident reliance "around 2027".
- Devices that stay on a fallback: iOS 16 (iPhone 8 / 8 Plus / X, see F27), Samsung Internet <= 29, WebView < 137, Chrome / Edge < 137, Firefox < 129.
- Sources: [BCD api/SubtleCrypto.json](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/SubtleCrypto.json) and `browsers/*.json`, [IPFS blog](https://blog.ipfs.tech/2025-08-ed25519/), [W3C WebCrypto L2 ED](https://w3c.github.io/webcrypto/), [Secure Curves CG report](https://wicg.github.io/webcrypto-secure-curves/).

**F46 (★) Safari signs Ed25519 with randomized (non-deterministic) signatures; Chromium is deterministic.** *Confidence: high.* BCD note for Safari 17: "Generates randomized signatures as per draft-irtf-cfrg-det-sigs-with-noise, instead of deterministic signatures as per RFC 8032." The Secure Curves draft keeps this as open "Issue 28: Allow creating randomized EdDSA signatures?". Measured: in Chromium 155 two signatures of one message were byte-identical, and a signature made by `@noble/ed25519` from a seed was byte-identical to WebCrypto's after importing the same seed as JWK. Consequence: an operation `id` must hash the signed content, never the signature; do not dedupe by signature bytes. Verification interoperates (noble signature verified in WebCrypto: true).

**F47 Measured signature performance (Worker, Chromium 155, M3, 200-byte message).** *Confidence: high for this machine.*

| Operation | per second | note |
|---|---|---|
| WebCrypto Ed25519 sign / verify | 64-67k / 34-35k | native |
| WebCrypto ECDSA P-256 sign / verify | 30-32k / 15.0-15.4k | 64-byte IEEE P1363 signature (measured) |
| `@noble/ed25519` 3.2.0 sync sign / verify | 10.1k / 2.4k | ZIP215 verify; needs `@noble/hashes` sha512 for sync |
| noble README (Apple M4, Node) sign / verify | 7,275 / 2,004 | their `npm run bench` |
| tweetnacl 1.0.3 sign | 651 | noble README comparison |

WebCrypto Ed25519 verify is about 14x faster than noble in JS on this machine. Budget (M3): 10,000 ops = 0.29 s native vs 4.1 s noble; 100,000 ops = 2.9 s vs 41 s. Phones are probably 3-10x slower (**extrapolation**). Verify in a Worker, in windows, and prefer snapshot checkpoints over replaying all history.

**F48 (★) Different Ed25519 verifiers can disagree on malformed signatures, which breaks a deterministic validity function.** *Confidence: high for the phenomenon (two sources), medium for how it plays out across browsers (not tested).* ZIP 215: "implementations conformant to RFC 8032 need not agree on whether signatures are valid." Chalkias et al., "Taming the many EdDSAs": "most libraries do not comply with the latest standardization recommendations", which is "of practical importance for consensus-driven applications". `@noble/ed25519` defaults to ZIP215 verification (`{zip215:false}` switches to strict RFC 8032 / FIPS 186-5 checks). With a mix of WebCrypto engines and noble, a crafted signature could verify on some nodes and not others. Mitigation: pre-check inputs in JS before handing them to any backend (reject S >= group order, reject non-canonical or small-order R and A) and use strict mode in noble; only the attacker's own op is affected, but dependents may stall. Sources: [ZIP 215](https://zips.z.cash/zip-0215), [ePrint 2020/1244](https://eprint.iacr.org/2020/1244), [noble-ed25519 README](https://github.com/paulmillr/noble-ed25519).

**F49 Fallback libraries.** *Confidence: high for versions and provenance.*
- `@noble/ed25519` **3.2.0** (2026-08-27): zero runtime dependencies, "3.7KB (gzipped)" per README (bundlephobia 3.9 KB), async by default (uses `crypto.subtle` SHA-512), sync needs `@noble/hashes` `sha512`. Audit: v1 was audited by Cure53 (Feb 2022); "The current version has not been independently audited." `@noble/hashes` 2.4.0: Cure53 audit at 1.0.0 (Jan 2022; excludes blake3, sha3-addons, sha1, argon2), "regular AI-assisted self-audits" since Apr 2026; sha256 is 2.8 KB gzip. Both are published from GitHub Actions with npm provenance attestations.
- `tweetnacl` 1.0.3: last published 2020-02-10, no provenance, 10.7 KB gzip, much slower. `@stablelib/ed25519` 2.1.0 (2026-03-30). `libsodium-wrappers` 0.8.4 (2026-04-19, WASM).
- Recommendation: `@noble/ed25519` + `@noble/hashes` as the fallback; keep the identity format algorithm-tagged so P-256 or a later scheme can be added.
- Sources: [noble-ed25519](https://github.com/paulmillr/noble-ed25519), [noble-hashes](https://github.com/paulmillr/noble-hashes), npm registry JSON (2026-10-14).

**F50 ECDSA P-256 is the universal fallback but a different identity type.** *Confidence: high.* Supported since Chrome 37 / Firefox 34 / Safari 7; signatures are 64-byte P1363 (measured); non-deterministic; verify is about half as fast as Ed25519 in WebCrypto (15k/s vs 34k/s). Not preferable unless the real-device matrix shows Ed25519 persistence failing on iOS; even then the seed fallback in F53 is algorithm-agnostic and cheaper than switching curves.

**F51 (★) The WebCrypto spec intends exactly this: non-extractable keys stored via structured clone in IndexedDB.** *Confidence: high.* WebCrypto Level 2 ED (11 Aug 2026): "any existing or future web storage mechanisms that support storing serializable objects can be used to store CryptoKey objects. In practice, it is expected that most authors will make use of the Indexed Database API ... This allows the storage and retrieval of key material, without ever exposing that key material to the application or the JavaScript environment."
Chromium 155 tests (this session): (i) a non-extractable Ed25519 `CryptoKeyPair` survives an IndexedDB put/get; the restored private key is still non-extractable and `exportKey` throws `InvalidAccessError`; the public key exports as 32 raw bytes; (ii) a `CryptoKey` stored as a property of an indexed record is retrievable through the index; (iii) the key can be `postMessage`d to a Worker, which signs with it; (iv) a 32-byte seed imported as a non-extractable key from JWK `{kty:'OKP', crv:'Ed25519', d, x}` signs identically to noble.
Limit: non-extractable prevents *exfiltration*, not *use*. Any script in the same origin can call `sign` with the key while the page is open. So untrusted site code must never share the identity's origin (section 3.1.9).

**F52 (★) WebKit and Firefox have had, and WebKit still has, CryptoKey / IndexedDB bugs; Ed25519 on real iOS is unverified by me.** *Confidence: high that the bugs exist, low on which key types fail today.*
- WebKit bug 312279 (filed 2026-04-14, Safari 26.4, status NEW, unassigned): non-extractable **X25519** `CryptoKey` returns `null` after IndexedDB put/get; AES-GCM non-extractable "appear to work"; Ed25519 / ECDSA not reported.
- WebKit bug 177350 (filed 2017-09-22, still NEW): a `CryptoKey` stored as a property of an object breaks queries through an index on another property; workaround: keep keys in a separate object store.
- open-chat issue #9343 (updates through 2026-10-14): `DataCloneError: The object can not be cloned` when persisting an **ECDSA** `CryptoKeyPair` in IndexedDB, "Almost all iOS Safari (latest: Safari 26.6.1 on iOS 18.7)", about 10-12 occurrences a day; the maintainers suspect Safari private browsing (unverified).
- cipheroom PR #13: reports "WebKit (Safari, and every iOS browser) can't read X25519 CryptoKeys back from IndexedDB" ("Unable to deserialize data") and keeps an Ed25519 key "non-extractable, which WebKit stores fine" - but tested only in Playwright's WebKit; real iPhone verification was still pending at merge.
- Firefox: non-extractable ECDSA keys threw `DataCloneError` (bug 1434898, closed as duplicate of 1133698, fixed in Firefox 93).
- Sources: [WebKit 312279](https://bugs.webkit.org/show_bug.cgi?id=312279), [WebKit 177350](https://bugs.webkit.org/show_bug.cgi?id=177350), [open-chat #9343](https://github.com/open-chat-labs/open-chat/issues/9343), [cipheroom PR 13](https://github.com/Alex-Fix/cipheroom/pull/13), [Mozilla 1133698](https://bugzilla.mozilla.org/show_bug.cgi?id=1133698).

**F53 (★) Therefore: self-test, then fall back to a persisted seed.** *Confidence: medium (design inferred from F51-F52).* At first write: generate a non-extractable key pair, put it in a dedicated key store, read it back, sign + verify a probe. If anything fails (null, DataCloneError, exception), generate a 32-byte CSPRNG seed, persist the bytes, and per session either import it as a non-extractable key via JWK (WebCrypto) or sign with noble. Trade-off: a stored seed can be read by same-origin script and used offline, a non-extractable key cannot - so prefer the key when the self-test passes. Offer export / import of the seed (it is the identity backup) and explain that clearing site data loses the identity.

---

### 2.9 Sync building blocks

**F54 Range-based set reconciliation (Negentropy) fits "gossip + anti-entropy" better than walking a deep DAG.** *Confidence: medium-high.*
- Meyer, "Range-Based Set Reconciliation" (arXiv:2212.13567, Dec 2022 / v2 Feb 2023): recursively split sets and compare fingerprints of partitions. Negentropy (hoytech) requires a 32-byte ID per record (hash of the canonical record) and an ordering key; its README lists a JavaScript implementation as "Stable"; used by strfry and Waku Sync and standardised for Nostr as NIP-77. The npm package named `negentropy` is a 2023 stub (0.0.0), so the usable JS is the repo's `js/` directory (packaging unverified). It never transfers records itself: it only tells each side which IDs the other lacks.
- This avoids the paper's "deep and thin DAG, slow cold sync" problem (F15) and works with arbitrary numbers of authors.
- Sources: [arXiv:2212.13567](https://arxiv.org/abs/2212.13567), [negentropy README](https://github.com/hoytech/negentropy), [NIP-77](https://raw.githubusercontent.com/nostr-protocol/nips/master/77.md).

**F55 (★) DB gossip can ride the torrent swarm's WebRTC data channels via the BitTorrent extension protocol (BEP 10).** *Confidence: high for the API, untested end-to-end.* WebTorrent exposes `torrent.on('wire', (wire, addr) => { wire.use(MyExtension) })`; `bittorrent-protocol` supports extensions that register a name in the extended handshake and exchange messages with `wire.extended(code, buffer)` / event hooks; `wire.type` can be `'webrtc'`. Current versions: `webtorrent` 3.0.21 and `bittorrent-protocol` 5.0.9 (both 2026-07-27). This means **no second signaling plane** (unlike OrbitDB / libp2p, F19). Caveats: DB peers are limited to peers of the current site version's swarm unless a separate "DB swarm" is announced (open question 6); other agents own the transport details. Sources: [WebTorrent API docs](https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/api.md), [bittorrent-protocol README](https://raw.githubusercontent.com/webtorrent/bittorrent-protocol/master/README.md) (both read 2026-10-14).

---

## 3. Recommendations for our design

### 3.1 Recommended data model: a signed op-DAG with an owner policy log (no consensus)

This is a **design proposal derived from the sources above**, not a validated protocol. It needs the property tests in 3.1.11 before anyone relies on it. Plain-language name for the product: "signed replicated log". Do not call it a blockchain.

#### 3.1.0 Principles
1. Every record is an immutable, self-authenticating **op**. The database is a deterministic fold over the *set* of valid ops (F15, F16, F21).
2. **Validity is a pure function of the op, the ops it references, and the owner's policy ops** - never wall-clock time, arrival order, or local node state. That is what lets replicas converge even when some peers are Byzantine (F20) and avoids Peerbit's "revocation race" (F32).
3. **No consensus.** We promise integrity, authenticity, eventual consistency and owner moderation. We do not promise total order, uniqueness, deletion everywhere, or availability (3.1.10).
4. The **owner is a moderation authority, not a sequencer**: policy lives in the owner's own hash-chained log, and precedence is the **owner's sequence number**, never a timestamp.
5. Limits that can legitimately differ between nodes (rate limits, retention, relay choices) affect **propagation and retention, never validity**.

#### 3.1.1 Keys and identifiers
- **Owner key `O`**: Ed25519 public key, published in the DNS TXT record next to the magnet link (record format owned by the DNS research agent) or, in hub mode, in a signed manifest inside the torrent. The loader checks that the TXT key and the manifest key agree.
- **`dbId = SHA-256("mw/db/v1\0" || O)`**: stable across site releases (the infohash changes on every release; the DB must not).
- **Author key `A`**: a device-local Ed25519 key, created lazily at the first write (read-only visitors create nothing). Identity = device; no cross-device linking in v1 (SSB lesson, F34). Public keys are stored algorithm-tagged (`ed25519:<base64url>`) so a later algorithm can coexist.

#### 3.1.2 Op envelope
`B` is the canonical JSON (RFC 8785, all integers < 2^53) of:

| Field | Meaning | Rule |
|---|---|---|
| `v` | format version | `1` |
| `db` | `dbId` (base64url) | must equal the DB's id (blocks cross-site replay) |
| `a` | author public key | |
| `s` | author sequence number | starts at 1, strictly +1 |
| `p` | id of this author's op `s-1` (`""` for `s=1`) | per-author hash chain |
| `d` | up to 4 ids of DAG heads the author had seen | causal parents |
| `c` | Lamport clock | `c = 1 + max(c(p), c(d_i))`, must exceed all |
| `e` | id of the owner policy op the author used (`""` = genesis policy from the manifest) | binds the op to a policy epoch |
| `t` | type | `post`, `reply`, `react`, `edit`, `del`, `profile`; `mod.*` only if `a == O` |
| `x` | body | type-specific, size-capped (default 4 KiB) |
| `ts` | author's clock (ms) | **advisory display hint only**, never used for validity or ordering |
| `pw` | `{bits, n}` | PoW stamp when the policy requires one (3.1.6) |

- `id = base64url(SHA-256("mw/op/v1\0" || B))`
- `sig = Ed25519.sign(sk, "mw/sig/v1\0" || B)`
- Wire message = `{B, sig}`. **`B` is sent verbatim; verifiers hash and verify the received bytes before parsing.** No re-serialization (F44).
- `id` excludes `sig`, so Safari's randomized signatures (F46) cannot change an id. Domain-separation prefixes and `db` inside `B` prevent cross-protocol and cross-site signature reuse.

#### 3.1.3 Validity rules (pure)
An op is **valid** iff all of the following hold; ops whose references are not yet known are **pending** (stored in a bounded buffer, excluded from the view, never relayed):
1. **Shape**: schema, size caps, `v`, `db`, known `t` (unknown types are invalid in v1; extend by bumping `v`).
2. **Crypto**: `sig` verifies under `a` with strict Ed25519 rules and the pre-checks from F48; `id` recomputes.
3. **Chain**: if `s > 1`, `p` names a valid op by the same author with `s-1`.
4. **Clock**: `c > c(p)` and `c > c(d_i)`.
5. **Policy**: `e` names a known owner policy op (or genesis); the op satisfies that policy (PoW bits, body size, allowed types, writer mode); and `epoch(e) >= minEpoch`, where `minEpoch` is the **maximum** `minEpoch` across all owner policy ops (a grow-only max, so it commutes).
6. **Moderation ops**: `a == O` and the owner chain is intact.
7. **No equivocation**: if the set contains two different ops with the same `(a, s)`, every op of `a` with sequence >= `s` is **ignored**. The pair is a self-contained fork proof that peers may forward. (SSB: forks kill a feed; here a fork only kills that cheap key.)

#### 3.1.4 View (reducers) and ordering
- **Order**: visible ops sorted by `(c, a, id)` - a deterministic total order consistent with causality (OrbitDB's Lamport-then-writer-id rule, F16).
- `post` / `reply`: grow-only set; replies reference a parent id inside `x`.
- `edit`: valid only if the editor authored the target; last-writer-wins per target by `(c, id)`; history kept.
- `del` (author deletes own op): tombstone; the body may be dropped by any node, the header stays for DAG integrity.
- `react`: LWW register per `(author, target)` by `(c, id)`; the count is the number of authors with a non-null value.
- `profile`: LWW per author. Names are cosmetic and non-unique; the UI must show a short key fingerprint.
- **Counters** (visits, likes): a per-author G-Counter is trivially inflated by Sybils (F40). Label them "devices", never "people". For trustworthy numbers the owner signs `mod.checkpoint{stats}`.
- Visible = valid AND author not banned AND op not hidden AND not covered by an ignored fork.

#### 3.1.5 Owner moderation (owner-signed, in the owner's own log; precedence = owner `s`)
| Op | Effect |
|---|---|
| `mod.ban{target}` / `mod.unban{target}` | per-author LWW by owner `s`; a ban **retroactively hides all ops by that author**, regardless of `c` or `ts` (defeats backdating) |
| `mod.hide{target}` / `mod.unhide{target}` | same, per op id |
| `mod.policy{bits, maxBody, allowTypes, rate, writers:"open"\|"cap", minEpoch}` | defines an epoch (= this op's owner `s`). Raising `minEpoch` **fences** older epochs: ops authored under them become invalid. Convention: when tightening PoW during an attack set `minEpoch` to the new epoch; routine tweaks leave it alone |
| `mod.checkpoint{upToOwnerSeq, c, count, root, snapshot, stats?}` | owner attests an ID-set root and where to fetch the snapshot (a torrent); nodes that verified the snapshot may prune covered history (the "external source of truth" of F15) |
| `mod.cap{subject}` / `mod.uncap{subject}` (v1.1, optional) | capability mode (`writers:"cap"`), revocation by owner `s` rather than time-based expiry because clocks are untrusted (Meadowcap relies on expiry, F35) |
| `mod.rotate{nextKey}` (v1.1) | key rotation, valid only if its hash was pre-committed in the TXT record |

Determinism notes and limits:
- A gap in the owner's chain leaves later `mod.*` ops pending, so nodes fetch the owner chain first (it is tiny) and the owner should run an always-on seed.
- An owner fork (two ops with the same owner `s`) is treated as **key compromise**: freeze moderation state at the fork and alert; recovery is out of band (new key in DNS).
- `ts` and `c` are never used as a ban cut-off because a new identity can pick old `deps` and claim a small `c`.
- Moderation hides; it cannot erase bytes from other peers' disks. Honest nodes stop relaying hidden ops and drop their bodies.
- This mirrors the policy-head / epoch / deterministic-boundary approach Peerbit is converging on (F32).

#### 3.1.6 Anti-spam stack (defaults, owner-tunable)
1. **Structural**: strict schema, `|B| <= 4096`, `d <= 4`, allowed types only.
2. **Relay-level rate limits** (per author and per peer token buckets): excess ops are not relayed or are deferred - this changes propagation, not validity.
3. **PoW stamp** `pw={bits, n}` with `SHA-256("mw/pow/v1\0" || db || a || s || SHA-256(x) || n)` having >= `bits` leading zero bits; `bits` is **committed in the op** and must be >= `policy.bits` of the op's epoch (NIP-13, F41). Default **16**; owner may raise to 18-20 and fence (F39). Solve in Workers with a specialised single-block loop or WASM (F36, F38), at most 4 Workers (F28), only after the user presses Submit, with progress and cancel (F14); consider several smaller sub-puzzles to reduce variance.
4. **Owner moderation** (3.1.5) and **local mute lists** per visitor (subjective filtering; SSB/Nostr practice).
5. **Capability mode** for sites that want closed posting.

#### 3.1.7 Sync and transport
- **Channel**: a BEP-10 extension (e.g. `mw_log`) on every WebTorrent `wire` (F55); no second signaling system is needed.
- **Messages** (each <= 64 KiB): `HELLO{v, db, ownerSeq, heads[<=16], count}`, `INV{ids}`, `GET{ids}`, `OPS{wires}`, `NEG{negentropy bytes}`.
- **On connect**: (1) compare owner-log position and fetch missing owner ops first; (2) if far behind, fetch the latest `mod.checkpoint` and its snapshot via the torrent engine (bulk transfer is what BitTorrent is for), verify against the owner's signature, then (3) reconcile the tail with range-based set reconciliation over `(c, id)` (F54); (4) live push of new ops with dedup and a small fan-out (<= 8), forwarding only valid, visible ops.
- **Budgets**: per-peer ops/s and bytes/s, bounded outstanding `GET`s, bounded pending buffer per author, verification in Worker batches. Verification cost is the scaling limit (F47).
- **Phones**: foreground only; on `visibilitychange` / `pageshow`, re-announce and run a reconciliation pass (F23).

#### 3.1.8 Persistence, backup, eviction
- IndexedDB object stores: `keys` (a **separate store**, never a property of an indexed record - WebKit #177350), `ops` (`id -> {B, sig}`), `byAuthor` index `(a, s)`, `heads`, `meta`, `outbox`.
- At first write: request `navigator.storage.persist()` and run the key self-test (F53).
- Elect one tab as the node with a Web Lock; other tabs read via BroadcastChannel (F24).
- Eviction is all-or-nothing and Safari deletes after 7 days without interaction (F25). UI must offer **Export identity** (the seed), explain what clearing site data does, and on iOS suggest Add to Home Screen.
- Retention is a per-node resource decision: views converge over the *retained* set. The owner's checkpoint defines the canonical horizon.

#### 3.1.9 (★) Security boundary: site code vs identity
Non-extractable keys protect against *theft*, not *use* (F51). Site code arrives over BitTorrent and must be treated as untrusted. It must **not** run in the same origin as the loader's IndexedDB and keys. Use a different origin per site or a sandboxed iframe (opaque origin) with a narrow `postMessage` API: `db.read(query)` returns view data; `db.submit({t, x})` makes the loader build, preview, and sign after a user gesture. The private key, raw op store and policy never cross the boundary. This conflicts with the most direct Service Worker design (the SW serving site files same-origin so relative URLs work) and needs a joint decision with the loader / Service Worker research.

#### 3.1.10 What this model cannot do (explicit non-goals)
No total order or uniqueness (first-come names, balances, votes, tickets, unique-visitor counts); no deletion from other peers; no confidentiality (public by default); no real-time delivery or background gossip on phones; no availability without overlapping online peers or a seed. If a feature needs one of these, make the owner (or an external chain) the sequencer and say so in the UI.

#### 3.1.11 Verification plan (before any trust)
- **Convergence property tests**: random permutation, duplication and partition of the same op set across N replicas must yield identical view hashes.
- **Byzantine generators**: bad signatures, forks, backdated `c`, cross-`db` replay, oversize bodies, wrong PoW bits, `mod.*` from non-owner, owner-chain gaps, stale epochs - never crash, never diverge.
- **Moderation races**: ban / hide / policy / fence arriving before, after and interleaved with the ops they affect.
- **Cross-backend signature test**: WebCrypto vs noble on RFC 8032 vectors and malformed edge cases; strict pre-checks (F48).
- **Real-device matrix**: iOS 16 (no Ed25519), iOS 17 / 18 / 26 Safari (normal, private, Home Screen, Lockdown), iPhone Chrome / Brave (WebKit), Android Chrome >= 137 and WebView < 137, Samsung Internet 29 / 30, Firefox Android, Brave Android. Run Appendix B on each, run the key self-test, and run a 7-day persistence test.

### 3.2 Action list

1. **Name and scope.** Describe the system as a "signed replicated log (no consensus)" for guestbook / comments / reactions; list the non-goals in 3.1.10 in the product docs.
2. **Build the op-DAG of 3.1; do not adopt a database library wholesale** (F18, F19, F29-F33). Keep OrbitDB, Peerbit, Autobase, Meadowcap and SSB as design references. Dependencies: WebCrypto + `@noble/ed25519` / `@noble/hashes` (fallback), `canonicalize` (or the 50-line RFC Appendix A function), `idb-keyval`-style IndexedDB wrapper; total under 10 KB gzip.
3. **Use the torrent swarm's data channels for gossip** (BEP-10, F55) and avoid libp2p / Helia / y-webrtc signaling dependencies.
4. **Fix the origin / key boundary first** (3.1.9) - it can invalidate the Service Worker design.
5. **Identity**: Ed25519, algorithm-tagged; lazy creation; round-trip self-test; seed fallback; export / import (F51-F53).
6. **IDs from signed bytes, never from signatures**; strict verification pre-checks; one verification backend per node (F46, F48).
7. **PoW**: default 16 bits, committed target, specialised solver in <= 4 Workers, only on Submit; owner can raise and fence; calibrate on real phones with Appendix B before freezing defaults (F36-F41).
8. **Moderation**: implement ban / hide / policy / fence / checkpoint exactly as 3.1.5 with the owner's `s` as precedence; ship a headless owner "seedbox" (same protocol, Node) as the availability answer; publish owner checkpoints as snapshot torrents.
9. **Sync**: heads + range-based reconciliation; owner log first; foreground-only on phones (F23, F54).
10. **Compatibility**: noble fallback where WebCrypto Ed25519 is missing (Chrome / Edge / WebView < 137, Samsung Internet <= 29, Firefox < 129, iOS 16); an explicit message when WebRTC / WASM are blocked (Lockdown Mode, F26).
11. **Supply chain**: pin exact versions (automerge `latest` was an alpha; `canonicalize` shipped three majors in five months); prefer packages with npm provenance; vendor the crypto code into the repo.
12. **Content policy before launch**: every visitor stores and relays user-posted content; define size caps, hide / drop behavior and an abuse path (legal exposure is unresearched here).
13. **Re-check on the day of build**: OrbitDB / Helia 7 compatibility, Peerbit ACL v2, Keyhive / Subduction, WebKit bugs 312279 / 177350 / 273824, and the open questions below.

---

## 4. Gotchas

1. **Firefox is 129, not 130, for WebCrypto Ed25519**; 130 is X25519 (F45).
2. **Samsung Internet 29 is Chromium 136 and lacks Ed25519**; 30.0 (Chromium 143, 2026-05-11) is the first with it. BCD is the only source (F45).
3. **iPhone 8 / 8 Plus / X cannot run iOS 17**, so they have no WebCrypto Ed25519 (Safari 17 floor). Keep the noble fallback (F27).
4. **Safari signs Ed25519 non-deterministically.** Never derive IDs from, or dedupe by, signature bytes (F46).
5. **Ed25519 verifiers disagree on malformed signatures** (ZIP 215: "implementations conformant to RFC 8032 need not agree"). noble defaults to ZIP215. Use strict mode plus JS pre-checks, or one backend per node (F48).
6. **`SubtleCrypto.supports()` exists only in Chrome 155** (experimental). Feature-detect by trying `generateKey` (F45).
7. **`crypto.subtle.digest` is the wrong PoW inner loop**: 4.6x slower than a specialised loop on M3, about 100 kH/s on iPhones in the wild; batching makes it slower (F36-F38).
8. **Hashcash time is exponentially distributed**: with a 1 s mean, 5% of solves take more than 3 s (F39). Use sub-puzzles and progress UI.
9. **`RTCPeerConnection` is absent in dedicated Workers (Chromium measured)**: the transport lives on the main thread (F24).
10. **`SharedWorker` is missing on Samsung Internet and reached Chrome Android only in v148**; use Web Locks + BroadcastChannel (F24).
11. **The Page Lifecycle `freeze` event is Chrome-only** (Safari / Firefox "not supported"); do not build node logic on it (F22).
12. **iOS: assume the node dies in the background** (developer reports, not Apple documentation) (F23).
13. **WebKit CryptoKey / IndexedDB bugs**: X25519 returns `null` (312279); `CryptoKey` as a property of an indexed record breaks index queries (177350); ECDSA `DataCloneError` reports on iOS Safari continue (open-chat #9343). Keep keys in their own store; self-test; seed fallback (F52-F53).
14. **Eviction is all-or-nothing and Safari deletes after 7 days without interaction.** Key and DB vanish together. Home Screen web apps are exempt. Firefox prompts for `persist()` (F25).
15. **Safari Lockdown Mode** may disable JIT / WASM / WebRTC (Apple's page is vague; WebKit 273824: WASM blocked even with an exception since iOS 17.4). Slower JS also means slower noble verification and PoW (F26).
16. **Same-origin execution is the architecture's biggest hole**: non-extractable keys can still be *used* by any script in the origin (F51, 3.1.9).
17. **Library traps**: y-webrtc's three default signaling servers are dead (F29); automerge-repo's npm `latest` is an alpha (F31); `orbit-db` and `ipfs-log` are deprecated on npm (F18); OrbitDB 4.0.0 develops against Helia 6 while Helia is at 7.1.16 (F18); `hyperswarm-web` is stale since 2022 and `@hyperswarm/dht-relay` says "Do not use it in production" (F33); Gun's cadence is slow (F30).
18. **Browser chain clients are not serverless**: Helios and Lodestar need execution / beacon RPC servers and a checkpoint under about two weeks old; smoldot is GPL-3.0-or-later with a Classpath exception (F1, F2, F4).
19. **RFC 8785 is an Independent-stream Informational RFC.** Lone surrogates and NaN / Infinity are errors; integers beyond 2^53 must be strings; keys sort by UTF-16 code units; `canonicalize` shipped three major releases in five months (F42-F43).
20. **Counters and "unique visitors" are Sybil-inflatable** under any scheme without a trusted gatekeeper (F40).
21. **Brave randomizes `navigator.hardwareConcurrency`** (observed 5, 4, 5 on an 8-CPU Mac); cap worker pools and measure (F28).
22. **Owner key is a single point of failure**: loss means no moderation, compromise means total loss of integrity; DNS TXT is the root of trust (3.1.1, open question 8).
23. **A Merkle-DAG only grows**; cold sync of a deep DAG is slow; pruning needs the owner's checkpoint (F15).
24. **`ts` is attacker-controlled** and must never decide validity or ordering (3.1.2).
25. **Evidence quality varies.** Phone hash rates are third-party anecdotes or vendor benchmarks; phone-optimized rates are my extrapolation; Nimbus, Bitcoin Gold and several mining items are snippet-level (section 6 separates "read" from "snippet").

---

## 5. Open questions

1. Does a non-extractable Ed25519 `CryptoKeyPair` round-trip IndexedDB on **real** iOS Safari 17 / 18 / 26 (normal, private, Home Screen) and on Firefox / Samsung Internet? Does JWK seed import work there? (I could only test Chromium.)
2. Do Safari's and Firefox's WebCrypto Ed25519 verifiers agree with noble on malformed edge cases? Which pre-checks are sufficient?
3. Real phone hash rates for a specialised JS / WASM solver, thermal throttling over 5-10 s, and battery cost - run Appendix B on at least six devices before fixing PoW defaults.
4. What exactly does iOS Safari do to `RTCDataChannel`s, timers and IndexedDB transactions when the page is backgrounded or the screen locks, and does a Home Screen web app differ? Is there any WebKit statement?
5. Current Lockdown Mode behavior (iOS 26 / macOS 27) for WebRTC, WASM and JIT; does the per-site exclusion work now (WebKit 273824)?
6. **DB swarm identity**: peers of the current site-version torrent only, or a dedicated stable swarm derived from `dbId` (impact on trackers, metadata fetching for an infohash with no content, continuity across site releases)? Joint decision with the WebTorrent research.
7. **Origin isolation** (3.1.9): per-site origin vs sandboxed iframe, and whether a Service Worker can serve a sandboxed (opaque-origin) frame. Joint decision with the Service Worker / loader research.
8. **Owner key custody and rotation**: DNS TXT as root of trust (DNSSEC availability through DoH?), pre-rotation record format, recovery after key loss, hardware-backed signing (WebAuthn does not sign arbitrary Ed25519 messages - unverified), offline-signing CLI.
9. Do the rules in 3.1.3 / 3.1.5 actually satisfy Byzantine Eventual Consistency? I read only the abstract of Kleppmann & Howard; a proof sketch or model check is needed.
10. Range-based reconciliation in browsers: packaging and mobile performance of the JS implementation (repo `js/`, not the 2023 `negentropy` npm stub); versus a trivial per-author `{a: maxSeq}` vector for small DBs.
11. Realistic ops-per-site, bytes-per-op, IndexedDB write throughput on iOS, and sensible default caps.
12. **Legal / safety**: liability when every visitor stores and relays user-posted content; hide / drop semantics; reporting path.
13. If a library is ever reconsidered: OrbitDB 4 with Helia 7, Peerbit browser bootstrap and ACL v2 timing, Keyhive / Subduction maturity, WebTorrent-compatible adapters.
14. Optional chain integration: would ENS / an L2 via Helios or Lodestar be a better root of trust than DNS TXT, accepting RPC servers?
15. Deterministic CBOR vs JCS for `B` (size, speed, library weight) - not evaluated.
16. In production, how do peers detect divergence (compare a view hash in `HELLO`, or compare against the owner's checkpoint root)?
17. Does Safari's 7-day script-storage rule still apply unchanged in Safari 18 / 26 / 27 (only the 2020 post and a search snippet of WebKit's tracking-prevention page support it)?

---

## 6. Sources

**Read in this session** (page / file / PDF / registry JSON fetched and inspected; dates are source dates or 2026-10-14 for live registries and raw repository files):

*Browser chain clients and chain security*
- Helios README and TS README: https://raw.githubusercontent.com/a16z/helios/master/README.md , https://raw.githubusercontent.com/a16z/helios/master/helios-ts/README.md
- Lodestar light-client README (npm readme): https://registry.npmjs.org/@lodestar/light-client
- smoldot README and CHANGELOG: https://github.com/paritytech/smoldot , https://raw.githubusercontent.com/paritytech/smoldot/main/wasm-node/CHANGELOG.md
- Celestia Lumina README: https://github.com/celestiaorg/lumina
- Nostr NIP-01 / NIP-13 / NIP-77: https://raw.githubusercontent.com/nostr-protocol/nips/master/01.md , .../13.md , .../77.md
- Bitcoin whitepaper (2008): https://bitcoin.org/bitcoin.pdf
- Eyal & Sirer, selfish mining (2013): https://arxiv.org/abs/1311.0243
- CoinDesk, ETC second 51% attack (2020-08-06): https://www.coindesk.com/tech/2020/08/06/ethereum-classic-suffers-second-51-attack-in-a-week
- Eskandari et al., browser-based cryptojacking (2018): https://arxiv.org/pdf/1803.02887
- Kleppmann & Howard, BEC (2020-12-01): https://arxiv.org/abs/2012.00472

*Merkle-CRDT, OrbitDB and sibling designs*
- Merkle-CRDTs (v2, 2020-04-27): https://arxiv.org/pdf/2004.00107
- OrbitDB (main, 2026-05-14): https://raw.githubusercontent.com/orbitdb/orbitdb/main/README.md , `package.json` , `docs/OPLOG.md` , `docs/ACCESS_CONTROLLERS.md` , `docs/IDENTITIES.md` , `docs/ENCRYPTION.md` , `docs/REPLICATION.md` , `docs/CONNECTING_PEERS.md`; GitHub API for tags / commits / repo meta; https://unpkg.com/@orbitdb/core@4.0.0/?meta
- Autobase README: https://raw.githubusercontent.com/holepunchto/autobase/main/README.md
- Hyperswarm DHT relay README: https://github.com/holepunchto/hyperswarm-dht-relay ; Pear docs: https://docs.pears.com/
- y-webrtc README: https://raw.githubusercontent.com/yjs/y-webrtc/master/README.md ; DNS-over-HTTPS probes (Cloudflare, Google) and HTTP probes of the three default signaling hosts, 2026-10-14
- Gun README, `lib/webrtc.js`, and "distributed matters" talk: https://raw.githubusercontent.com/amark/gun/master/README.md , https://raw.githubusercontent.com/amark/gun/master/lib/webrtc.js , https://gun.eco/distributed/matters.html
- automerge-repo README: https://github.com/automerge/automerge-repo
- Peerbit issue #1346 and README: https://github.com/dao-xyz/peerbit/issues/1346 , https://raw.githubusercontent.com/dao-xyz/peerbit/master/README.md
- SSB protocol guide and critique: https://ssbc.github.io/scuttlebutt-protocol-guide/ , https://derctuo.github.io/notes/secure-scuttlebutt.html
- Meadowcap spec: https://willowprotocol.org/specs/meadowcap/index.html
- npm registry JSON, queried 2026-10-14: https://registry.npmjs.org/<package> for @orbitdb/core, helia, @a16z/helios, @lodestar/light-client, smoldot, polkadot-api, yjs, y-webrtc, y-websocket, y-indexeddb, @automerge/automerge, @automerge/automerge-repo (+ adapters), automerge-repo-network-peerjs, gun, peerbit, @peerbit/shared-log, hypercore, hyperswarm, hyperdht, @hyperswarm/dht-relay, autobase, hyperswarm-web, ssb-db2, ssb-browser-core, secure-scuttlebutt, ipfs-log, orbit-db, @noble/ed25519, @noble/curves, @noble/hashes, tweetnacl, @stablelib/ed25519, libsodium-wrappers, canonicalize, json-canonicalize, @truestamp/canonify, hash-wasm, webtorrent, bittorrent-protocol, libp2p, @libp2p/webrtc, nostr-tools, simple-peer, peerjs, idb-keyval
- Bundlephobia size API (queried 2026-10-14): https://bundlephobia.com/api/size?package=<pkg>

*PoW, Sybil and anti-spam*
- Laurie & Clayton (2004): https://www.cl.cam.ac.uk/~rnc1/proofwork.pdf ; Back, Hashcash (2002): https://www.hashcash.org/papers/hashcash.pdf
- Infobip / ALTCHA benchmark (2025-10-29): https://www.infobip.com/developers/blog/beyond-the-puzzle-lessons-from-our-captcha-evolution
- Hacker News thread on Anubis (comments about 44 days before 2026-10-14): https://news.ycombinator.com/item?id=49500040
- Cap.js benchmark page (undated): https://capjs.js.org/guide/benchmark.html ; Anubis docs: https://raw.githubusercontent.com/TecharoHQ/anubis/main/docs/docs/design/how-anubis-works.mdx
- Range-Based Set Reconciliation abstract: https://arxiv.org/abs/2212.13567 ; Negentropy README: https://raw.githubusercontent.com/hoytech/negentropy/master/README.md

*Canonical JSON, WebCrypto, storage, platform*
- RFC 8785 (June 2020): https://www.rfc-editor.org/rfc/rfc8785.txt
- MDN browser-compat-data (`main`, 2026-10-14): https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/SubtleCrypto.json (also `StorageManager.json`, `CryptoKey.json`, `SharedWorker.json`, `LockManager.json`, `BroadcastChannel.json`, `RTCPeerConnection.json`, and `browsers/*.json`)
- IPFS blog on Ed25519 in Chrome (2025-08-13): https://blog.ipfs.tech/2025-08-ed25519/
- W3C Web Cryptography API Level 2 ED (11 Aug 2026): https://w3c.github.io/webcrypto/ ; WICG Secure Curves CG report (28 Jan 2026): https://wicg.github.io/webcrypto-secure-curves/
- noble-hashes and noble-ed25519 READMEs: https://github.com/paulmillr/noble-hashes , https://github.com/paulmillr/noble-ed25519
- ZIP 215: https://zips.z.cash/zip-0215 ; Chalkias et al., "Taming the many EdDSAs" (ePrint 2020/1244): https://eprint.iacr.org/2020/1244
- WebKit bugs 312279, 177350, 273824: https://bugs.webkit.org/show_bug.cgi?id=312279 , ...=177350 , ...=273824 ; open-chat issue: https://github.com/open-chat-labs/open-chat/issues/9343 ; cipheroom PR: https://github.com/Alex-Fix/cipheroom/pull/13 ; Mozilla bugs: https://bugzilla.mozilla.org/show_bug.cgi?id=1133698 , ...=1434898
- WebKit blog posts: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ (2020-03-24), https://webkit.org/blog/14403/updates-to-storage-policy/ (2023-08-10)
- MDN storage quotas and eviction: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- Apple: https://support.apple.com/en-us/105120 (Lockdown Mode, 2026-09-14), https://developer.apple.com/app-store/review/guidelines/ , https://developer.apple.com/forums/thread/774239 , https://developer.apple.com/forums/thread/799259
- Chrome: https://developer.chrome.com/docs/web-platform/page-lifecycle-api (undated), https://developer.chrome.com/blog/timer-throttling-in-chrome-88 (2021-01-18)
- Brave farbling: https://dev-pages.brave.software/fingerprinting/farbling.html
- WebTorrent docs and bittorrent-protocol README: https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/api.md , https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/faq.md , https://raw.githubusercontent.com/webtorrent/bittorrent-protocol/master/README.md

**Seen only as search-result snippets (lower weight; not read in full):** Nimbus verified-proxy README and nimbus-eth1 issue #467 (https://github.com/status-im/nimbus-eth1/blob/master/nimbus_verified_proxy/README.md); Kyoto / bip157 crates; hashcat forum posts (https://hashcat.net/forum/post-57490.html , https://hashcat.net/forum/post-62406.html); CoinWarz (https://www.coinwarz.com/bitcoin-difficulty); Bitcoin Gold attack coverage and Cloud Security Alliance "Rent to Pwn"; Douceur, "The Sybil Attack" (https://www.microsoft.com/en-us/research/publication/the-sybil-attack/); Mozilla cryptominer-blocking blog and Security Affairs on Coinhive; js-libp2p release post (https://blog.libp2p.io/releases/2023-12-12-js-libp2p/); Ink & Switch Keyhive (https://www.inkandswitch.com/keyhive/); OrbitDB Substack June 2025; sevarg.net Lockdown analysis; 9to5Mac iOS 17 compatibility; the Scuttlebutt forum thread on forks (via viewer.scuttlebot.io).

---

## Appendix A - raw measurements (2026-10-14)

**Environment:** MacBook Air, Apple M3 (8 CPUs reported by `sysctl`), macOS 27.0.1; Brave (UA `HeadlessChrome/155.0.0.0`), `--headless=new`, throw-away `--user-data-dir`, page served from `127.0.0.1` (secure context), all work inside Web Workers; libraries downloaded from the npm registry (`@noble/hashes` 2.4.0, `@noble/ed25519` 3.2.0, `hash-wasm` 4.12.0). `navigator.hardwareConcurrency` reported 5, 4, 5 on the three launches. No phone or other device was touched.

**Run 1** (43-byte inputs; digests of all four implementations matched `crypto.subtle`):

| Test | ops/s |
|---|---|
| custom single-block JS SHA-256 | 3,226,357 |
| `@noble/hashes` sha256 (sync) | 873,760 |
| `hash-wasm` createSHA256 (sync after init) | 3,213,888 |
| `crypto.subtle.digest`, await each | 700,288 |
| `crypto.subtle.digest`, 64 in flight | 550,240 |
| `crypto.subtle.digest`, 1024 in flight | 527,397 |
| custom JS x 5 Workers (3 s) | 13,194,453 total (2.57-2.68 M each) |
| WebCrypto Ed25519 sign / verify | 64,083 / 34,397 |
| `@noble/ed25519` sign / verify | 10,118 / 2,439 |
| WebCrypto ECDSA P-256 sign / verify | 29,892 / 14,993 |
| Ed25519 signature length / P-256 signature length | 64 / 64 bytes |
| two WebCrypto Ed25519 signatures of one message identical? | true (Chromium) |
| noble signature verifies in WebCrypto? | true |

**Run 2** (key handling, Chromium 155): non-extractable Ed25519 pair survives IndexedDB (restored key `extractable:false`, `exportKey('jwk', private)` -> `InvalidAccessError`, raw public key 32 bytes, noble verifies the WebCrypto signature); seed -> JWK import (`extractable:false`) gives a signature byte-identical to noble; key cloned to a Worker via `postMessage` signs successfully; `CryptoKey` as a property of an indexed record is retrievable via the index; `navigator.storage.persist` exists, `persisted()` was `false`; `SubtleCrypto.supports('generateKey','Ed25519')` returned `true`; in a dedicated Worker `typeof RTCPeerConnection` was `'undefined'` while `crypto.subtle`, `indexedDB` and `navigator.locks` were present.

**Run 3** (single-file page of Appendix B, 4 Workers): custom JS 3,669,466 H/s (1 Worker), `crypto.subtle.digest` 746,544 H/s, 13,039,280 H/s total; Ed25519 sign / verify 66,820 / 35,240 per s; P-256 sign / verify 31,580 / 15,447 per s; self-test of the custom hash passed.

## Appendix B - single-file calibration page (tested in Chromium 155)

Serve over HTTPS or `http://localhost` (WebCrypto needs a secure context), open on the phone, wait about 25 s, and record the printed numbers and the UA string. Append `?post=1` only if a `/result` endpoint exists.

```html
<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mw-bench</title>
<pre id="o" style="white-space:pre-wrap;font:13px/1.4 monospace">starting…</pre>
<script>
// Single-file calibration page: SHA-256 PoW rate (WebCrypto loop vs custom JS) + Ed25519/P-256 speed.
// Serve over HTTPS or http://localhost (crypto.subtle needs a secure context). No dependencies.
function workerMain() {
  const K = Uint32Array.from([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const IV = Uint32Array.from([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const W = new Uint32Array(64), blk = new Uint8Array(64), out = new Int32Array(8);
  function compress() {
    for (let i = 16; i < 64; i++) { const a = W[i-15], b = W[i-2];
      W[i] = (W[i-16] + (((a>>>7)|(a<<25))^((a>>>18)|(a<<14))^(a>>>3)) + W[i-7] + (((b>>>17)|(b<<15))^((b>>>19)|(b<<13))^(b>>>10))) | 0; }
    let a=IV[0],b=IV[1],c=IV[2],d=IV[3],e=IV[4],f=IV[5],g=IV[6],h=IV[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7))) + ((e&f)^(~e&g)) + K[i] + W[i]) | 0;
      const t2 = ((((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10))) + ((a&b)^(a&c)^(b&c))) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0; }
    out[0]=(IV[0]+a)|0; out[1]=(IV[1]+b)|0; out[2]=(IV[2]+c)|0; out[3]=(IV[3]+d)|0; out[4]=(IV[4]+e)|0; out[5]=(IV[5]+f)|0; out[6]=(IV[6]+g)|0; out[7]=(IV[7]+h)|0; }
  function load(m) { blk.fill(0); blk.set(m); blk[m.length] = 0x80; const bits = m.length * 8; blk[62] = (bits >>> 8) & 255; blk[63] = bits & 255;
    for (let i = 0; i < 16; i++) W[i] = (blk[4*i]<<24)|(blk[4*i+1]<<16)|(blk[4*i+2]<<8)|blk[4*i+3]; }
  const hex = (u8) => Array.from(u8, x => x.toString(16).padStart(2, '0')).join('');
  function customLoop(sec) {
    const pre = new TextEncoder().encode('mw-pow-v1:0123456789abcdef:'), msg = new Uint8Array(pre.length + 8); msg.set(pre);
    const t0 = performance.now(); let n = 0;
    while (performance.now() - t0 < sec * 1000) { for (let k = 0; k < 4096; k++, n++) { let v = n; for (let d = 7; d >= 0; d--) { msg[pre.length + d] = 48 + (v % 10); v = (v / 10) | 0; } load(msg); compress(); } }
    return n / ((performance.now() - t0) / 1000); }
  async function timed(sec, fn) { const t0 = performance.now(); let n = 0; while (performance.now() - t0 < sec * 1000) { for (let i = 0; i < 32; i++) { await fn(n++); } } return n / ((performance.now() - t0) / 1000); }
  self.onmessage = async (e) => {
    const r = {};
    try {
      if (e.data.task === 'multi') { self.postMessage({ hps: customLoop(e.data.sec) }); return; }
      const probe = new TextEncoder().encode('hello hashcat 12345'); load(probe); compress();
      const ref = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', probe)));
      r.selfTestOk = Array.from(out, x => (x>>>0).toString(16).padStart(8, '0')).join('') === ref;
      r.customJsHps = customLoop(2);
      const buf = new Uint8Array(43).fill(65);
      r.webcryptoDigestHps = await timed(2, (i) => { buf[42] = i & 255; return crypto.subtle.digest('SHA-256', buf); });
      const msg = new Uint8Array(200).fill(7);
      for (const [name, gen, alg] of [['ed25519', { name: 'Ed25519' }, 'Ed25519'], ['p256', { name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }]]) {
        try { const kp = await crypto.subtle.generateKey(gen, false, ['sign', 'verify']); const sig = await crypto.subtle.sign(alg, kp.privateKey, msg);
          r[name + 'SignPerSec'] = await timed(1.5, () => crypto.subtle.sign(alg, kp.privateKey, msg));
          r[name + 'VerifyPerSec'] = await timed(1.5, () => crypto.subtle.verify(alg, kp.publicKey, sig, msg)); }
        catch (err) { r[name] = 'unsupported: ' + err.name; } }
    } catch (err) { r.error = String(err); }
    self.postMessage(r); };
}
const url = URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')()'], { type: 'text/javascript' }));
const o = document.getElementById('o'), P = (s) => { o.textContent += '\n' + s; };
(async () => {
  const res = { ua: navigator.userAgent, cores: navigator.hardwareConcurrency, secure: isSecureContext };
  P('UA: ' + res.ua + '\ncores(reported): ' + res.cores + '  secureContext: ' + res.secure);
  if (!crypto.subtle) { P('crypto.subtle missing (not a secure context?)'); return; }
  P('single-worker tests (~10 s)…');
  const w = new Worker(url); res.single = await new Promise((ok, no) => { w.onmessage = e => ok(e.data); w.onerror = e => no(e.message); w.postMessage({ task: 'single' }); }); w.terminate();
  P(JSON.stringify(res.single, (k, v) => typeof v === 'number' ? Math.round(v) : v, 1));
  const n = Math.max(2, Math.min(4, res.cores || 4)); P('multi-worker custom JS x' + n + ' (3 s)…');
  const rs = await Promise.all(Array.from({ length: n }, () => new Promise((ok, no) => { const x = new Worker(url); x.onmessage = e => { ok(e.data.hps); x.terminate(); }; x.onerror = e => no(e.message); x.postMessage({ task: 'multi', sec: 3 }); })));
  res.multiHps = rs.reduce((a, b) => a + b, 0); P('total custom JS H/s with ' + n + ' workers: ' + Math.round(res.multiHps));
  for (const bits of [16, 18, 20]) P('est. time for ' + bits + ' bits: ' + (2 ** bits / res.single.customJsHps).toFixed(2) + ' s (1 worker), ' + (2 ** bits / res.multiHps).toFixed(2) + ' s (' + n + ' workers)');
  P('DONE'); document.title = 'done';
  if (location.search.includes('post=1')) fetch('/result', { method: 'POST', body: JSON.stringify(res) });
})().catch(e => P('ERROR ' + e));
</script>
```
