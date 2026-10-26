# magnet-web improvements digest (research wave 2c)

- **Date:** 2026-10-19. **Status:** research digest, not normative. The normative documents stay `docs/ARCHITECTURE.md` v0.2, `docs/INTERFACES.md` v0.2 and `docs/review/DESIGN-REVIEW.md`. Where this digest proposes a change to them it says so; it edits nothing.
- **Inputs** (all in `docs/research/`, all written 2026-10-17):

| Short name | File | Topic | Second-pass check |
|---|---|---|---|
| w2c-01 | `w2c-01-content-layer-alternatives.md` | web seeds, IPFS, Blossom, Arweave, BitTorrent v2 | no VERIFY report; `labs/w2c-01-verify-lab/` holds raw results only (section 4.4) |
| w2c-02 | `w2c-02-chain-production-features.md` | site ledger: snapshots, compaction, erasure, encryption, access control, spam | `w2c-02-...-VERIFY.md`: 2 confirmed, 6 nuanced, 1 side claim refuted; the file ends after claim 7 |
| w2c-03 | `w2c-03-identity-ux.md` | visitor identity, backup, passkeys, names, moderation UX | `w2c-03-...-VERIFY.md`: 4 confirmed, 4 nuanced |
| w2c-04 | `w2c-04-hub-gateway-operations.md` | public hub: origins, PSL, takedown, abuse, cost, federation | none |
| w2c-05 | `w2c-05-testing-qa-production.md` | test strategy, fault injection, cross-engine, devices | none |
| w2c-06 | `w2c-06-standards-and-ecosystem.md` | standards, registries, BEPs, ecosystem | `w2c-06-...-VERIFY.md`: 2 confirmed, 6 nuanced |
| w2c-07 | `w2c-07-incentives-economics.md` | incentives, consent, offload model, costs | none |

- **Citations.** `w2c-0N` plus the label that file uses: `S3` = Summary item 3; `R4`, `A2`, `R-06` = recommendation IDs from its "Concrete recommendations" section; `F3`, `G12`, `F-D1` = finding IDs; `Gotcha 5`; `OQ 7` = open question 7; `§3.3` = numbered section. `w2c-0N-V claim K` = claim K of that file's VERIFY report.
- **Method.** For each file: Summary, Recommendations, Gotchas and Open questions read in full; findings opened only where cited; VERIFY reports read for verdicts and correction texts. The code tree was spot-checked by grep on 2026-10-19 for the "Tree" column in section 3 (no tests run). One extra table (section 9.2) was produced with the w2c-07 calculator, offline.
- **Evidence limits shared by all seven files.** The shared WebSearch budget ran out in every run, so gaps are missing evidence, not negative findings. All measurements are desktop (MacBook Air M3). Playwright Firefox 157 did not launch. "WebKit 27.2" is Playwright's build, not Safari. No phone was measured.
- **Wording** follows DESIGN-REVIEW §4 (site ledger; no backend).

---

## 1. Executive verdict

1. **Keep the v0.2 architecture.** No file found a reason to change the core: per-site origins, the signed pointer, the web seed as the floor, the site ledger with payload outside the hash and the causal owner rule. The work is amendments before the formats freeze, an operating layer for hubs, and much stronger testing. (w2c-02 §3.0; w2c-04 S1; w2c-06 S1)
2. **The web seed is the biggest silent-failure risk, not the peers.** Stock webtorrent 3.0.21 stalls forever behind a host that ignores `Range` and hot-loops against a host that returns wrong bytes (tens of thousands of requests per 10-15 s on loopback, no ban). Its own request headers make every IPFS gateway fail the CORS preflight. Fix this first. (w2c-01 S1-S2; w2c-05 S1)
3. **Peer-to-peer delivery buys resilience and host independence, not a smaller bill.** A site under about 16 MiB gets about 0% of its first-load bytes from peers; 25 eligible seeders online need about 448,000 visits a day in the baseline model; a mobile visitor pays about 30 times what the host saves. Availability comes from the web seed or a pinner. (w2c-07 S3-S5)
4. **No incentive layer.** Visitors seed because of a default, a cause or enforcement, and a generic site has none of the three at full strength. No tokens, points or rankings; a symmetric consent prompt; byte budgets on uploads. (w2c-07 S1, S6, S8, S11)
5. **Freeze the compatibility promises now, while they are cheap:** algorithm-tagged key strings, a salted value hash, reserved control-op names and an unknown-op rule, the pointer grammar as a stated RFC 6376 profile with a size budget, and golden test vectors that may only be added to. (w2c-02 R1, R3, R6; w2c-06 A1-A2; w2c-03 R1; w2c-05 R-06)
6. **Site ledger: lossless packing plus redaction with a signed skeleton for v1, an owner checkpoint block next, lossy pruning later.** Do not promise forward secrecy; keep validity independent of clocks. (w2c-02 S1, S5, S7, S8, as narrowed by w2c-02-V)
7. **Privacy: no personal data or free text in permanent fields.** Key deletion is the retention action, erasure reaches cooperating peers only, and a salted hash is still personal data. (w2c-02 S9; w2c-02-V claim 7)
8. **Identity v1 is a seed-derived guest identity with a recovery phrase, created at the first write.** Browser storage is not durable, and a non-extractable key can be used, and even structured-cloned to another origin, by any same-origin script. Passkeys are a v2 wrapper, never the only key. (w2c-03 S1-S6; w2c-03-V claims 1-3)
9. **Hubs need an operating layer:** labels enforced at the edge under a configured sites domain, a takedown path that reaches installed visitors (451 plus `Clear-Site-Data: "storage"` plus a status ping), a separate cookie-free sites domain, a minimum abuse program, and no hub directory. Sponsored free gateways just ended (`ipfs.io` and `dweb.link` on 2026-09-21), so hubs must be cheap to run. (w2c-04 S2-S13)
10. **Nobody will specify this for us, and the tests are not yet a gate.** Publish MW-PTR/1 and MW-LOG/1 with vectors, align syntax with mature RFCs, do not build on DNSLink, Helia, Web Bundles or free IPFS gateways. Make the test suite green and hermetic first; cross-engine peer-to-peer behaviour cannot be inferred from Playwright. (w2c-06 S1-S3, S12; w2c-01 S3; w2c-05 S4, S6)

---

## 2. Decisions

### 2.1 Decisions table

| # | Decision | Evidence | Source file § |
|---|---|---|---|
| D1 | The web seed stays mandatory; peers accelerate; every non-origin source is untrusted bytes checked by hash | PeerTube removed WebTorrent from its player (v6.0.0, issue #5465); P2P Media Loader is HTTP-first; the offload model gives about 0% for small sites | w2c-01 S7; w2c-06 S9; w2c-07 S1, S4 |
| D2 | Strip `Cache-Control` and `User-Agent` from web-seed requests with a `self.fetch` wrapper installed before importing webtorrent | Chromium 156, 13 hosts: 10 pass with the headers stripped vs 6 stock; all 4 IPFS gateways go from CORS failure to success | w2c-01 F3, R1a |
| D3 | Replace stock web-seed connections: `new WebTorrent({ webSeeds: false })` plus `torrent.addWebSeed(conn)` with strict response checks, blame, backoff, drop, pad synthesis and a progress watchdog | a Range-ignoring host left a torrent at 28 of 32 pieces forever; a corrupt-206 host drew 58,421-66,926 requests in 10 s; the prototype finishes the same scenarios in 20-80 ms | w2c-01 F2, F6, R1; w2c-05 F-D1, R-01 |
| D4 | Second content layer = more HTTP sources plus a signed per-file SHA-256 manifest (`mf=`); Blossom is the preferred content-addressed mirror | Blossom addresses are flat SHA-256 and BUD-01 mandates CORS; 3 servers served verified downloads with working Range | w2c-01 S4, R4, R5a, R5b |
| D5 | Not now: Helia or verified-fetch in the loader, free public IPFS gateways, publishing BitTorrent v2 or hybrid torrents. Reserve `btmh=` | `ipfs.io`/`dweb.link` retired 2026-09-21; verified-fetch bundles to 1.27 MiB min (598 packages); webtorrent has no BEP 52 and pad files stall path-based web seeds | w2c-01 S3, S6, R13, R14; w2c-06 A17 |
| D6 | Arweave only as an optional permanence anchor, never a first-load source | `arweave.net` ignores Range and answers the preflight with a 302; uploads are immutable and public | w2c-01 S5, R8 |
| D7 | Salt the value hash: `vh = hex(sha256(utf8("mw-vh-v1\n") + z + utf8(canonical(v))))` (+ = byte concatenation), `z` = 16 random bytes carried beside `v` and deleted with it | an unsalted `vh` lets anyone confirm guesses of short values forever; EDPB Guidelines 02/2025 v2.0 para 52 | w2c-02 R1, §3.2; w2c-02-V claim 7 |
| D8 | No personal data or free text in permanent fields: restricted charset for keys and list names, enum codes only in control ops | control ops and keys live inside `e`, which can never be redacted | w2c-02 R3, Gotcha 23 |
| D9 | Reserve `checkpoint`, `vanish`, `grp` and caveated `allow`; decide the unknown-control-op rule; version the snapshot (`mw-snap/1`) | avoids a protocol version bump for features already planned | w2c-02 R6 |
| D10 | History: v1 = lossless packing (L0) plus redaction with a signed skeleton (L1); owner checkpoint next; lossy pruning (L2) only behind a fence | desktop cold start is cheap (50,000 records read in 150-192 ms); a checkpoint buys tip completeness and a rollback anchor, not speed | w2c-02 S1, S4, S5, R7, R15; w2c-02-V claims 1, 4, 5 |
| D11 | No forward-secrecy promise; private lists later with owner-distributed epoch keys; no MLS or BeeKEM in v1 | Keyhive and NIP-44 state no forward secrecy; ts-mls is unaudited; Keyhive says not for production | w2c-02 S7, §3.5 |
| D12 | Access control stays clock-free (the causal `controlFor` rule); grants gain caveats later | UCAN relies on `exp`/`nbf` with skew buffers and an rc revocation spec; Meadowcap has no revocation | w2c-02 S8, R10 |
| D13 | Spam: keep the 16-bit stamp as a fee; skip identity-admission proof-of-work; add local mute, per-author quotas and later subscribable lists | identity PoW adds about 8% to an attacker's per-op cost at a 200-op quota; Waku moved off PoW | w2c-02 S10, R11 |
| D14 | Queries: keep the in-memory reducer; add a paged `mw.db.list`; SQLite WASM only as an optional lazy module | indexed lookups 0.3-9 ms at 50,000 records; SQLite WASM costs 468,637 B gzip | w2c-02 S6, R5, R18 |
| D15 | Key strings carry an algorithm tag now: canonical `p256:<b64url>`; W3C Multikey and did:key are documented mappings at interop edges; P-256 stays the only generated key type in v1 | the strings sit inside hashed block bodies and signed pointers, so a later change forces a version bump and a ledger fork; P-256 Multikey needs point compression | w2c-06 A2, Gotcha 10; w2c-03 R1; w2c-03-V claim 4 |
| D16 | Visitor identity v1: seed-derived per-chain key, lazy creation, recovery phrase, durability UX; no persistent identity on a shared-origin hub | Safari's 7-day rule, iOS CryptoKey persistence failures, same-origin use of non-extractable keys | w2c-03 §4.2, R2-R4, R7; w2c-03-V claims 1-3 |
| D17 | Passkeys only as an optional v2 wrapper of the seed (PRF); the phrase stays the master backup | PRF support varies by provider; the RP ID differs per origin; same PRF output across synced devices is unconfirmed | w2c-03 S5, §4.3, R13; w2c-03-V claims 7-8 |
| D18 | Names: self-chosen nickname, local petname, key-derived suffix on collision; IDs of at least 64 bits in the details view; names, avatars and short IDs are never proof | an 8-hex (32-bit) ID is brute-forced in about 2 hours on 8 cores; an identicon carries about 24 bits | w2c-03 S7-S8, R5 |
| D19 | Hub labels are exactly `^[a-z2-7]{32}$` under a configured sites domain, enforced at the edge and in the loader | wildcard DNS lets anyone mint `bank-login.<hub>`; edge and loader must agree | w2c-04 S3, R1 |
| D20 | Hub takedown: 451 plus `Clear-Site-Data: "storage"` plus `Link: rel="blocked-by"` on every path of a denylisted label; a network-only `/_mw/hub/status` ping exempt from the SW precache; never send `"cookies"` | measured in Chromium 156: a 404/410 for the SW script does not uninstall it; a self-unregistering SW keeps IndexedDB; `Clear-Site-Data: "storage"` wipes the origin even on non-2xx responses | w2c-04 F9, R3, Gotchas 6-9 |
| D21 | Hub domains: a separate, cookie-free sites domain registered for at least 2 years; a PSL entry is the goal, not a launch condition | the PSL is gated (small projects "quite likely to be declined"); the statichost.eu and nftstorage.link incidents | w2c-04 S5, R4, "Reconciliation with neighbouring notes" |
| D22 | No hub-run directory or search | w2b-06 R4: indexing and search can be a communication to the public (Ziggo) | w2c-04 R10, R12 |
| D23 | No incentive layer: no tokens, points, rankings, referral rewards or credit API; any recognition is local-only | token drawdowns of 89.6-99.56% from their highs; an uploaded MiB is worth about $0.00008 at CDN list price; verifying uploads needs a trusted party | w2c-07 S6, R2, §4.7 |
| D24 | Upload byte budgets per visit and per day per origin, on top of the existing rate caps | reciprocity does not bound load; the longest 10% of visits hold about 51% of all dwell time | w2c-07 S11, R3, §4.3, F29 |
| D25 | Symmetric consent: an equal-weight "Host only" button on the notice and no primary styling on OK. This amends a DESIGN-REVIEW §4.5 string marked final | a highlighted accept moved acceptance by 6-12 points (Utz et al.); EDPB: lack of consent is the default state | w2c-07 R4, §5.1 |
| D26 | Pointer grammar = RFC 6376 tag-list profile with its deviations stated, `v=mw1` first, strings joined without spaces, size SHOULD be at most 450 B and MUST be at most 900 B | the written standards disagree; a realistic signed pointer is about 480 B (two TXT strings) | w2c-06 A1, S4; w2c-06-V claim 3 |
| D27 | Publish MW-PTR/1 and MW-LOG/1 as versioned specs with vectors; then request IANA `TXT _magnet` | the BEP repository has merged nothing since 2020-05-01; an IANA Reference must resolve stably | w2c-06 A3, A4; w2c-06-V claims 1, 6 |
| D28 | No DNSLink or btlink dual-publish in v1 (reading `_dnslink` only as an unsigned mirror hint stays optional) | the DNSLink organisation was archived on 2026-07-31 and has no namespace registry | w2c-06 A10; w2c-01 R7 |
| D29 | Golden vectors are compatibility gates: vectors may only be added; changing one needs a version bump | the project's `verify()` agrees with all 262 Wycheproof P-256 P1363 vectors and `canonicalize()` matches all six RFC 8785 files | w2c-05 R-06, F-E5 |
| D30 | Peer-to-peer E2E is a gate on Chromium only; WebKit and Firefox P2P run as tracked experiments on Linux; real devices cover iOS and Android | locally WebKit opened no data channel and Firefox did not start; no device farm documents data channels between remote sessions | w2c-05 S4, R-04, R-10 |
| D31 | Never test peer loss with `setOffline`; arm a CDP impairment rule before any `RTCPeerConnection` exists | offline does not cut an established data channel; impairment applies only to connections created while a rule is armed | w2c-05 S3, R-03 |

### 2.2 Where the files disagree, and which source wins

| # | Topic | What each file says | Wins | Resulting rule |
|---|---|---|---|---|
| 1 | Browser-side web-seed probe | w2c-05 R-01 requires a visible `Content-Range: bytes 0-0/<n>` and exposed headers; w2c-01 F5, R2(b) checks only status and body length in the browser | w2c-01 | measured: `cdn.satellite.earth` and `nostr.download` do not expose `Content-Range`, so the w2c-05 rule would reject working hosts. Check `Content-Range` totals in Node (`tools/check-webseed.mjs`) only. |
| 2 | Accepted status codes | w2c-05 R-01 rejects anything but 206; w2c-01 R1 accepts 206, or 200 for a whole-file range with the exact length | w2c-01 | a whole-file 200 is a correct answer. |
| 3 | Bad-bytes loop size | w2c-01 F2: 58,421-66,926 requests in 10 s; w2c-05 F-D1: 27,474 and 38,057 requests in 15 s | no conflict | different loopback harnesses; the defect is the missing ban and backoff, not the rate (w2c-05 Gotcha 23). |
| 4 | Canonical key string | w2c-03 R1: Multikey (did:key-compatible), P0; w2c-06 A2: `p256:`/`ed25519:` prefix with Multikey as a mapping, P1 | w2c-06 for the encoding, w2c-03 for the priority | the prefix avoids point decompression (modular square roots) on every verify path (w2c-06 Gotcha 10). P0, because w2c-06's own argument (the strings sit inside hashed bodies) makes a later change a fork. |
| 5 | Default hashcash difficulty | w2c-05 §1 (Summary) and F-I1 time a "default 14-bit hashcash" (0.03 s Chromium, 0.25-0.31 s WebKit); ARCH v0.2 §6.1 `DEFAULT_POLICY.bits: 16` and `src/chain/block.js` `bits: 16` | the spec | 14 bits was the v0.1 default. Scale only: at w2c-05's async WebCrypto digest rates, 16 bits (65,536 digests on average) would take about 0.12-0.13 s in Chromium and 1.0-1.2 s in WebKit on the M3 (my arithmetic). The implemented miner (`src/chain/pow.js`) uses a synchronous JS SHA-256 with a midstate, so re-measure `mine()` itself per engine and phone class (P2-21). |
| 6 | Safari 7-day wording | w2c-03 §4.2 copy "after a week without a visit"; DESIGN-REVIEW §4.3 "after 7 days without a visit"; w2c-03-V claim 2: "7 days of Safari use without interacting with the site", only while Prevent Cross-Site Tracking is on, per registrable domain | w2c-03-V | primary text (WebKit pages, MDN). DESIGN-REVIEW marks its strings final, so a revision needs the owner (section 6, question 27). |
| 7 | PRF at `create()` | w2c-03 Gotcha 2: creation usually returns no PRF result; w2c-03-V claim 8: `eval` at `create()` does return results in the virtual authenticator | w2c-03-V, narrowly | real providers vary, so keep "create, evaluate in a separate `get()`, verify, fall back". |
| 8 | Passkey provider migration | w2c-03 Gotcha 4: switching providers can destroy PRF-derived keys; w2c-03-V claim 8: FIDO CXF can carry hmac-secret material | w2c-03-V | migration need not destroy the key; the phrase stays the master backup either way. |
| 9 | IPFS Service Worker Gateway upkeep | w2c-06 F8 lists it among projects without dedicated maintainers; w2c-06-V claim 5, w2c-01 S3 and w2c-04 S2: its README names two IPFS Foundation maintainers | w2c-06-V | primary README. Seven other IPFS projects do carry "no dedicated maintainer". |
| 10 | Web Packaging | w2c-06 S7: "dead end"; w2c-06-V claim 8: alive as the Isolated Web Apps signed container | w2c-06-V | the decision (not a foundation for ordinary-browser delivery) is unchanged. |
| 11 | y-indexeddb trim | w2c-02 Gotcha 8: snapshot write and old-row delete in separate, non-atomic transactions; w2c-02-V section 0: refuted, one transaction in Chromium 156 and WebKit 27.2 | w2c-02-V | experiment. "Never trust a summary" still stands on automerge-repo #781 and Subduction #306. |
| 12 | Hypercore fork fence | w2c-02 G2 and Gotcha 9: `allowFork` is an explicit opt-in on the receiving side; w2c-02-V claim 2: `allowFork` defaults to true (readers follow a higher fork unless they set it to false) | w2c-02-V | source read and behaviour tested. |
| 13 | Owner encryption key for the sealed inbox and for reports | w2c-02 R12: X25519 key, XChaCha20-Poly1305 via noble; w2c-03 R16: ECDH P-256, HKDF, AES-GCM in WebCrypto | merge, primitive open | one owner sealed-box construction should serve both. Inference: with a fresh ephemeral key per message, AES-GCM's per-key nonce limit does not bite, so the WebCrypto-native option avoids a dependency; epoch-key groups (many messages per key) keep XChaCha via noble (w2c-02 Gotcha 17). |
| 14 | Visitor escape hatch | w2c-04 R3 adds `?mw-unregister=1` without defining it; w2c-06 A12 defines `?mw-sw-unregister=1`: unregister the SW, clear caches, reload, never touch identity or ledger storage | w2c-06 | the only definition; it mirrors `?ipfs-sw-unregister=true`. One name. The hub's 451 wipe is a separate path. |
| 15 | Probe tools | w2c-01 R2 `tools/probe-webseed.mjs`; w2c-05 R-14 `tools/host-check.mjs`, R-18 `tools/probe.mjs`; w2c-04 R7: fold into one tool with a `--hub` mode | w2c-04 plus the tree | `tools/check-webseed.mjs` and `tools/check-site.mjs` already exist and are two of the three tools allowed to reach the internet (`docs/DEV-NETWORK.md`). Extend them; add no new network tool. |
| 16 | Unknown paths on the host | w2c-05 R-14: an unknown path falls back to the shell; w2c-04 Gotcha 3: never map 403/404 to `/index.html` (a `200 text/html` for a missing script poisons caches) | both, split by request type | ARCH §3.1 returns the shell for any unknown path (host SPA fallback, a `/404.html` copy). Rule: unknown navigations get the shell; a missing subresource may get that HTML only with a 404 status (the `/404.html` route gives that), never as `200 text/html`, and never for `/_mw/*` or `/mw-sw.js` (hubs answer real 404s). Test both. |
| 17 | Shell size budget | w2c-05 R-12: initial JavaScript at most 160 KB gzip (webtorrent 64.4 KB); w2c-04 R13: shell at most 150 KB brotli (webtorrent 55,969 B) | one budget | one CI budget in gzip, brotli reported beside it; recalibrate after the hardened web seed lands (+22 KB gzip, w2c-01 F6). |
| 18 | Subscribable moderation lists | w2c-02 R11 bundles them at P1; w2c-03 R15 has them at P2 | split | per-author quotas for `writers:'open'` are the urgent part (P1); signed subscribable lists need UI and follow (P2). Local mute and block is P0 (w2c-03 R6). |
| 19 | Label length | w2c-04 R1: enforce exactly 32 characters; w2c-06 A7: make the length a parameter for 52-character v2 ids | both | enforce 32 now (security); keep the length a named constant so a tagged v2 id kind can be added with a version bump. |
| 20 | PSL as a requirement | w1-11 R3: MUST for multi-publisher hubs; w2c-04 F6: likely declined for a young hub | w2c-04 (it reconciles this itself) | the PSL is the goal; the launch condition is a separate domain, no cookies, an abuse program and documented residual risk. |

---

## 3. Prioritised recommendations (merged and deduplicated)

**Effort** uses one scale: S = up to 2 working days, M = 3-10, L = more than 10 (one engineer, with tests). Each file had its own scale, so a letter can differ from the source. **Priority:** P0 = before the formats freeze or before any public release; P1 = needed for v1.0; P2 = after v1.0; P3 = optional or watch. **Tree** = what grep showed in the code on 2026-10-19 (a dash = not checked).

### 3.1 P0, freeze group (cheap now, a version bump later)

| ID | Eff | What | Justifying file | Tree |
|---|---|---|---|---|
| P0-1 | S | Salted value hash `z` exactly as in w2c-02 §3.2: `valueHash(value, z)`, `redact()` and `tombstone` drop `v` and `z`, `WANT {h, v:true}` returns both | w2c-02 R1 | absent from `src/chain/block.js` |
| P0-2 | S | Restricted charset `[A-Za-z0-9._:/-]` for `k` and `l`; enum codes only in control ops; SDK warns on keys that look like personal data | w2c-02 R3 | - |
| P0-3 | S | Reserve `checkpoint`, `vanish`, `grp`, caveated `allow`; decide the unknown-control-op rule; `mw-snap/1` | w2c-02 R6 | none of these names in `src/chain/` |
| P0-4 | S | Erasure semantics: hidden equals absent; decide whether banned authors' payloads are dropped; decide what a tombstoned `put` shows (Matrix blanks the property instead of reverting); confirm that `tombstone` and `ban` are exempt from the `controlFor` ancestor filter, and test it | w2c-02 R2, Gotcha 22; w2c-02-V claim 6 | - |
| P0-5 | S | Algorithm-tagged key strings (`p256:` canonical) in `owner=`, `author` and `rot`; an unknown tag is "unsupported key type", never a silent accept; document the Multikey mapping | w2c-06 A2; w2c-03 R1 | absent |
| P0-6 | S | Pointer grammar profile (D26) with the RFC 10023 one-string conflict noted and size warnings in `publish.mjs`; reserve `btmh=` and the w2c-01 hint keys (`mf=`, `bs=`, `sz=`) as signed and ignored when unknown | w2c-06 A1, A17; w2c-01 R7; w2c-06-V claim 3 | - |
| P0-7 | S | Golden vectors and a `conformance/` directory: Wycheproof P-256 P1363, the RFC 8785 files, golden pointer, block and frame vectors, a frozen IndexedDB fixture per release; add-only rule; a runner with no Node-only APIs | w2c-05 R-06; w2c-06 A11, A14 | - |
| P0-8 | S | Storage integrity rules: one IndexedDB transaction per batch, verify on load, never delete from a summary, garbage collection as copy, verify, delete; crash-injection tests | w2c-02 R4 | - |

### 3.2 P0, release group (before any public release)

| ID | Eff | What | Justifying file | Tree |
|---|---|---|---|---|
| P0-9 | S | Green, hermetic baseline on Node 22 and 24: a glob instead of a directory, per-test timeouts, close open handles | w2c-05 R-25 | `docs/deviations/orchestrator-notes.md` (2026-10-18): two unit files never exit, two tests fail |
| P0-10 | S | Web-seed stopgap: a `self.fetch` wrapper that removes `Cache-Control` and `User-Agent` from cross-origin Range requests, installed before the dynamic import; a test that fails if the bundle adds other non-safelisted headers | w2c-01 R1a | absent: `webSeeds: true`; the loader probe sends `Cache-Control` on purpose to mimic the stock preflight |
| P0-11 | M | Hardened web-seed connection (`MwWebSeed`): Range-only headers; 206, or a whole-file 200, with the exact length; SHA-1 blame on whole-piece requests; backoff 10 s to 10 min; drop a URL after repeated integrity failures (count failures with decay, not only consecutive ones, section 4.4); synthesize pad zeros (detect pads by the BEP 47 attribute as well as the `.pad/N` path); cancel bodies on rejection; a 20 s no-progress watchdog with a specific UI message; a canary test for the private `_hashes` field | w2c-01 R1; w2c-05 R-01; w2c-01-verify-lab | absent |
| P0-12 | M | Seed doctor: extend `tools/check-webseed.mjs` (mid-file range with exact length, `Content-Range` total, no `Content-Encoding` on Range, OPTIONS 2xx without redirect, report "passes with stock headers" vs "passes only when stripped"); keep the loader's 1-byte probe to status and body length | w2c-01 R2; w2c-05 R-14 | partial: `bytes=0-0`, CORS and `--xs` checks exist; the tool still requires `Allow-Headers` for `cache-control` and `user-agent`, which P0-10 makes unnecessary |
| P0-13 | S | Web-seed list policy: 3-4 `ws=` URLs with at least one independent provider; `maxWebConns` 2 on mobile (the default is 4 per URL); the full file URL for single-file torrents | w2c-01 R3 | - |
| P0-14 | M | Fault servers and a hostile-wire harness: a web-seed fault server (ignores Range, 403, truncated 206, corrupt bytes, no CORS) and in-memory `Wire` pairs (length `0x7FFFFFFF` with a slow drip, truncated handshakes, keep-alive floods, oversized `mw_chain` frames, wrong-length bitfields) | w2c-05 R-01, R-02 | the cap is done (`guardWire` reads the prefix unsigned; `CONFIG.wire.maxMessageBytes` = 262,144; unit-tested); the harness is not |
| P0-15 | S | CDP impairment helper armed before `goto`; split E2E case 5 into HTTP offline, peer loss and tracker down | w2c-05 R-03 | - |
| P0-16 | L | Model-based and seeded-simulation tests for DAG order, the reducer and gossip (fast-check `fc.commands`, seeded virtual network) | w2c-05 R-05 | - |
| P0-17 | M | Linux cross-engine pipeline in the pinned Playwright image: component tests in three engines, Chromium P2P as the gate, WebKit and Firefox P2P as experiments | w2c-05 R-04 | - |
| P0-18 | M | Identity core: 16-byte seed, HKDF-SHA256, P-256 scalar, JWK `{d, x, y}` import (never PKCS8 without the public key), created at the first write, dedicated key store, read-back self-test, seed fallback, memory-only mode when `indexedDB` is missing | w2c-03 R2; w2c-03-V claim 3 | - |
| P0-19 | L | Backup and restore: 12 words (BIP-39 list as an encoding only), print, QR, optional encrypted file (Argon2id 64 MiB t=3 via hash-wasm, or noble scrypt N=2^16), a re-entry check, one normalisation rule with test vectors | w2c-03 R3, Gotchas 11-12 | - |
| P0-20 | S | Durability UX: `persist()` from a user gesture at identity creation; show `persisted()` truthfully; corrected Safari copy; Add to Home Screen hint after the first post | w2c-03 R4; w2c-03-V claim 2 | - |
| P0-21 | M | Name and ID hygiene: NFC, reject control, format and bidi characters, length caps, UTS #39 skeleton check, petnames, `Name (xxxx)` suffix, 64-bit IDs and avatar seeds | w2c-03 R5 | - |
| P0-22 | M | Local mute and block per chain: never gossiped, included in the encrypted backup, placeholder with Undo | w2c-03 R6 | - |
| P0-23 | S | No persistent identity and no export on a shared-origin hub | w2c-03 R7; w2c-03-V claim 1 | - |
| P0-24 | S | Honest economics in README, DEPLOY and CRITIQUE (section 9); say "mean dwell" and "eligible seeders" | w2c-07 R1 | - |
| P0-25 | S | A "no incentive layer" clause in ARCH §8; no reward or credit symbol in INTERFACES | w2c-07 R2 | - |
| P0-26 | M | Upload byte budgets per visit and per day per origin, enforced with the existing choke lock; Settings shows sent this visit, today, and the limit | w2c-07 R3 | absent from `policy.js` and `config.js` |
| P0-27 | S | Symmetric notice: a "Host only" button of equal weight, OK not styled as primary, consent stays `pending` until a click | w2c-07 R4 | OK is still `mw-primary` in `ui.js` |

### 3.3 P0, hub group (before any public hub; skip if no hub is offered)

| ID | Eff | What | Justifying file | Tree |
|---|---|---|---|---|
| P0-28 | S | Label grammar at the edge and in the loader; the hostname must end in a configured sites domain; the w2c-04 Appendix B vectors in `test/unit` | w2c-04 R1 | partial: `app.js` has `HUB_LABEL_RE = /^([a-z2-7]{32})\.(.+)$/`, which accepts any suffix |
| P0-29 | S | Share links that survive a cache loss (`#<pointer>` or `#host:`); verify `hubLabelFor(record, ledgerId) === label` before rendering | w2c-04 R2 | - |
| P0-30 | M | Takedown path: edge 451 plus `Clear-Site-Data: "storage"` plus `Link: rel="blocked-by"`; boot-time `/_mw/hub/status` ping (`no-store`, 3 s, fail open) that the SW passes through uncached; the loader wipes itself on 451; the visitor escape hatch `?mw-sw-unregister=1` (caches only) | w2c-04 R3; w2c-06 A12 | - |
| P0-31 | S (M with counsel) | Domain plan and minimum abuse program: separate cookie-free sites domain registered for at least 2 years, CAA, Search Console, PSL application, `abuse@`, `security.txt`, a report link in the loader, a takedown policy, a DMCA agent or DSA contact point as applicable | w2c-04 R4, R5 | - |

### 3.4 P1 (needed for v1.0)

| ID | Eff | What | Justifying file |
|---|---|---|---|
| P1-1 | M | Signed per-file manifest `mw-manifest.json` committed in the pointer as `mf=` (NIP-5A aggregate-hash rule): verify files at rest and when served, skip unchanged files on update, per-file fallback | w2c-01 R4 |
| P1-2 | M | Blossom: `publish.mjs --blossom` (BUD-02 upload, BUD-04 mirror, a throwaway Nostr key, never the owner key) and a loader fallback by hash after about 8 s without progress | w2c-01 R5a, R5b |
| P1-3 | S | IPFS guidance: dedicated or paid gateways only, `--wrap-with-directory` layout, never the retired public gateways | w2c-01 R6 |
| P1-4 | M | Scheduled probes: a daily mirror canary (alerts on `Sunset`, 429, `Retry-After`, DNS failure, lost Range or CORS) and a production synthetic run of `check-site.mjs --headless`, plus a hub canary label if a hub exists | w2c-01 R11; w2c-05 R-18; w2c-04 R14 |
| P1-5 | M | Owner checkpoint block and self-verifying snapshot with the corrected predicate ("the checkpoint was accepted, not orphaned"); pin the highest checkpoint; treat `(n, root)` as a self-check; show "N values pending" when a snapshot arrives without payloads | w2c-02 R7, §3.3; w2c-02-V claim 4 |
| P1-6 | S | `HELLO.ckpt` and "in sync with owner checkpoint"; alert on two checkpoints with equal `n` and different `root` | w2c-02 R8 |
| P1-7 | S | The `vanish` control op | w2c-02 R16 |
| P1-8 | M | `tools/import.mjs`: JSON, CSV or SQL dump to owner-signed blocks plus a genesis checkpoint (Node only) | w2c-02 R9 |
| P1-9 | M | Spam layering: deterministic per-author quotas for `writers:'open'`, relay-local scoring (Reject penalised, Ignore not), local hide-and-purge | w2c-02 R11 |
| P1-10 | S + counsel | Legal and privacy package: controller roles, DPIA template, privacy notice, erasure runbook ("removed from cooperating peers") | w2c-02 R13 |
| P1-11 | M | Reporting and an owner queue: NIP-56 categories, counted by unique reporters, never auto-hide, copy says reports are public | w2c-03 R8 |
| P1-12 | S | Multi-device decision: keep `seq` informational and say "one device at a time", or adopt device sub-keys | w2c-03 R9 |
| P1-13 | S | Identity tests: WebKit in the identity matrix, a Chromium virtual-authenticator PRF test, a real-device checklist | w2c-03 R11 |
| P1-14 | S | Comprehension test of the key-loss copy and the backup flow with 5-8 people; targets set before launch | w2c-03 R12 |
| P1-15 | M | Reference hub `deploy/hub/` (AWS Terraform, Cloudflare Workers, Caddy) with CI | w2c-04 R6 |
| P1-16 | M | `check-site.mjs --hub` and host-conformance checks: grammar, 421/404/451, the status ping, `/_mw/hub/*`, headers, no `Set-Cookie`, `*.localhost` isolation, Range 206, preflight, exposed headers, no `Content-Encoding` on Range, navigation fallback vs subresource 404 | w2c-04 R7; w2c-05 R-14 |
| P1-17 | S | ARCH and DEPLOY updates per the w2c-04 "Delta to ARCHITECTURE.md v0.2" table, the wildcard host-capability table, the identity store per chain id; record deviations | w2c-04 R8; w2c-03 R10 (its Ed25519 sentence fix is moot, w2c-03-V claim 4) |
| P1-18 | S | Standard hub response headers: HSTS, `nosniff`, `Referrer-Policy: no-referrer`, frame denial, the shell CSP, `Permissions-Policy` default-deny, `Origin-Agent-Cluster: ?1`, COOP `same-origin-allow-popups`, `X-Robots-Tag: noindex, nofollow` | w2c-04 R9 |
| P1-19 | S | The apex is a gate only; production hubs refuse unknown labels by default | w2c-04 R10 |
| P1-20 | M | MW-PTR/1 and MW-LOG/1 as standalone specs (RFC 2119 keywords, public domain, a versioned permanent URL, vectors) | w2c-06 A3 |
| P1-21 | S | `xs`/`ws` contract: `xs` MUST be https; surface webtorrent's `warning` on infohash mismatch; `publish.mjs --verify-ws`; track the unmerged draft BEP PR #171 "Magnet-URI Webseeding" | w2c-06 A5; w2c-06-V claim 6 |
| P1-22 | M | Chaos catalogue (22 scenarios, each with its injector) | w2c-05 R-07 |
| P1-23 | L | NAT and relay matrix (nftables routers, coturn, relay-only, UDP blocked; classify the NAT before trusting a cell) | w2c-05 R-08 |
| P1-24 | M | Jazzer.js fuzz targets for every parser of untrusted input, nightly | w2c-05 R-09 |
| P1-25 | M | Real-device program: a one-day device-farm spike (do remote data channels form at all?), weekly smoke, a release checklist | w2c-05 R-10 |
| P1-26 | M | Accessibility: axe on every UI state, exactly one `role="status"` region, a manual screen-reader script | w2c-05 R-11 |
| P1-27 | M | Performance budgets with the Lighthouse 13.5 Node API and `mw:*` timing marks | w2c-05 R-12 |
| P1-28 | M | Soak and leak harness on CDP counters | w2c-05 R-13 |
| P1-29 | L | Migration corpus of 10-12 generated sites and a `doctor` report of migration blockers | w2c-05 R-15 |
| P1-30 | M | Upgrade and version-skew tests (SW update, loader and SW skew, IndexedDB schema, N-1 peers) | w2c-05 R-16 |
| P1-31 | S | Show the notice after 10 s of visible dwell, still before the first announce | w2c-07 R4b |
| P1-32 | S | Sharing meter and one rate-limited thanks message (rules in w2c-07 §4.5) | w2c-07 R5 |
| P1-33 | S | `tools/swarm-calc.mjs` and the DEPLOY section "Will my site have peers?" | w2c-07 R6 |
| P1-34 | M | Measure instead of model: bytes by source in `mw.net.stats()`, owner opt-in randomized-response aggregates, measured consent, policy share, connect success and offload in DEMO-RESULTS | w2c-07 R7 |
| P1-35 | S | Filter-list hygiene: neutral names under `/_mw/`, an informational CI job against the major lists, a plain-language page | w2c-07 R8 |
| P1-36 | M | Availability kit: finish `pin.mjs`, a one-command recipe, an owner-signed pinner heartbeat shown in the status bar | w2c-07 R9 |
| P1-37 | S | Paged `mw.db.list(name, {after, limit, order})` over the in-memory arrays (w2c-02 files R5 under P2 but says to do this step now) | w2c-02 R5, §3.8 |

### 3.5 P2 (after v1.0)

| ID | Eff | What | Justifying file |
|---|---|---|---|
| P2-1 | S | Pointer hint keys `bs=`, `ipfs=`, `ar=`, `ns=`, `sz=`; `_dnslink` read only as an unsigned mirror hint whose bytes are checked against `mf=` | w2c-01 R7; w2c-06 A10 |
| P2-2 | M | Optional Arweave anchor at release; Range-capable gateways only | w2c-01 R8 |
| P2-3 | M | Bundle mode (one container file per torrent), only if still wanted after P1-1 and P1-2 | w2c-01 R9 |
| P2-4 | M | Always-on seeder spike: libtorrent 2.1.x, anacrolix/torrent and SpawnDev.WebTorrent against a `wss://` tracker with a Chromium peer, carrying `mw_chain` | w2c-01 R10; w2c-06 A16 |
| P2-5 | M | nsite export (experimental) | w2c-01 R12 |
| P2-6 | M | Grants with caveats (`k` prefixes, `max`, `q`) | w2c-02 R10 |
| P2-7 | S | Owner sealed inbox, one construction shared with encrypted reports (conflict 13) | w2c-02 R12; w2c-03 R16 |
| P2-8 | L | Member groups with epoch keys (noble box, 16.8 KB gzip) | w2c-02 R14 |
| P2-9 | M | L2 pruning behind a checkpoint fence (causal fence, `(h, depth)` table, RFC 6962 Merkle root) | w2c-02 R15 |
| P2-10 | M | Retention epochs for inbox and group keys | w2c-02 R17 |
| P2-11 | M | Query layer step 2: split headers and values, add `author` and `depth` indexes, when caps rise or phones show memory pressure | w2c-02 R5 |
| P2-12 | M | "Protect with passkey": PRF output wraps the seed | w2c-03 R13 |
| P2-13 | M | Verified names over DoH (`_mw-id.<domain>` TXT or a well-known file, bidirectional check) | w2c-03 R14 |
| P2-14 | M | Subscribable owner and moderator lists with "hidden by <list>" and Undo | w2c-03 R15; w2c-02 R11 |
| P2-15 | L | Device sub-keys with root-signed delegation, only if P1-12 chooses per-author chains | w2c-03 R17 |
| P2-16 | M | Signed deny list `/_mw/deny.json` (w2b-06 R3 format) with owner-key and per-file-hash entries | w2c-04 R11 |
| P2-17 | S | Cost guardrails: Workers static assets or CloudFront Pro flat rate, budgets and alarms, a per-IP WAF rule, web seeds on R2 or B2, never on a proxied Free-plan CDN | w2c-04 R13 |
| P2-18 | S | Multi-label `*.localhost` e2e (launch Chrome directly for partitioning tests) | w2c-04 R15 |
| P2-19 | M | BYO-domain hosting (Cloudflare for SaaS or CloudFront multi-tenant), only if managed hosting is offered | w2c-04 R16 |
| P2-20 | S | Visual regression in the pinned container | w2c-05 R-17 |
| P2-21 | M | Generators, scale benchmarks, and PoW calibration of `mine()` at 16 bits per engine and phone class | w2c-05 R-19 |
| P2-22 | M | Node synthetic swarm over `node-datachannel` | w2c-05 R-20 |
| P2-23 | S | Clock seams on every time-dependent path; skew tests | w2c-05 R-21 |
| P2-24 | S | Flake hygiene (seeds, shuffle, traces, quarantine with expiry) | w2c-05 R-22 |
| P2-25 | S | Request IANA `TXT _magnet` once P1-20 is stable | w2c-06 A4 |
| P2-26 | S | `mw_v` key in the BEP 10 extended handshake (can ride with P1-20) | w2c-06 A6 |
| P2-27 | S | Hostname grammar written into ARCH §3.2 (one label, at most 63 octets, RFC 4648 base32, length as a named constant) | w2c-06 A7 |
| P2-28 | M | pkarr pointer channel with a BEP 46 export; needs Ed25519 owner keys | w2c-06 A8 |
| P2-29 | S | Fix stale statements (`05-doh-dns-txt.md` F9 on `_dmarc`; 72, not 69, registry records) | w2c-06 A18; w2c-06-V edits 1-2 |
| P2-30 | M | RFC 8484 wire-format DoH as a second resolver family (shares a DNS codec with pkarr) | w2c-06 A19 |
| P2-31 | S | Document and test network-type detection limits per engine | w2c-07 R10 |
| P2-32 | S | Desktop hidden-tab bound (pause uploads after 60 minutes hidden) and battery rule (pause below 40% while discharging) | w2c-07 R11 |
| P2-33 | S | Chrome 146+ Local Network Access check with two visitors behind one router | w2c-07 R12 |
| P2-34 | M | Peer-first trial for sites of 50 MiB or more (delay the web seed about 1.5 s when the tracker returns many peers) | w2c-07 R13 |

### 3.6 P3 (optional or watch)

- **Content:** decline Helia for now and re-check its triggers (named maintainers, a router operator, a lazy bundle under about 300 KB) (w2c-01 R13); decline `publish --hybrid` and watch webtorrent issue #1117 (w2c-01 R14).
- **Ledger:** optional SQLite WASM with `opfs-sahpool` (w2c-02 R18); witness cosigning, noting that P-256 is not a defined C2SP checkpoint algorithm (w2c-02 R19; w2c-02-V claim 3); UCAN or Biscuit and MLS or BeeKEM after audits (R20); hash-boundary segments (R21); Argon2id or RLN-style limits and post-quantum key wrapping (R22).
- **Identity:** did:key display and export (w2c-03 R18); desktop opt-in Nostr link statement (R19); SLIP-39 recovery cards (R20); phrase-free restore via passkey, only after the two-device PRF test passes (R21).
- **Hub:** a directory only after counsel (w2c-04 R12); HSTS preload, practically irreversible (R17); PSL re-application with usage evidence (R18); label sharding across domains, unproven (R19).
- **Testing:** Playwright Android and iOS Simulator automation (w2c-05 R-23); OSS-Fuzz once the repository is public (R-24).
- **Standards:** `<link rel="describedby" type="application/x-bittorrent">` hint (w2c-06 A9); no new protocol scheme (A13); JCS wording (A14); a dependency-policy page (A15); `/.well-known/magnet-web`, only if DoH blocking is seen in practice (A20).
- **Economics:** an owner "support this site" link kept apart from sharing (w2c-07 R14); bilateral receipts, only if field data shows 10 or more eligible seeders regularly (R15).

---

## 4. Verified, nuanced and refuted claims

Three VERIFY reports re-checked 24 headline claims: **8 confirmed, 16 nuanced, 0 refuted outright**, plus one refuted side claim. w2c-01, w2c-04, w2c-05 and w2c-07 have no VERIFY report; their claims rest on their own lab evidence. Apply the corrections below when the source files or ARCH are next edited.

### 4.1 w2c-02-V (site ledger)

| # | Claim | Verdict | Correction to apply |
|---|---|---|---|
| 1 | History splits into L0 lossless packing, L1 payload removal with a signed skeleton, L2 coordinated lossy trimming | nuanced | Yjs with the default `gc: true` discards deleted content when a live doc is re-encoded, so y-indexeddb's 500-row trim is L1-like; "coordinated" fits Loro and Hypercore, not p2panda or Willow (in-band deterministic rules); Hypercore `truncate` removes the newest blocks (a rollback), not old history. |
| 2 | Lossy trimming needs a fence | nuanced | Hypercore's `allowFork` defaults to true; Loro is confirmed in primary docs (shallow-snapshot peers cannot import older updates); the Merkle-CRDT paper offers a 2020 "future work" intuition, not a fence. |
| 3 | C2SP tlog-checkpoint and tlog-witness details | confirmed | Both are v1.1.0 dated 2026-10-07. The checkpoint spec defines ML-DSA-44 and Ed25519, not ECDSA P-256, so a P-256 checkpoint block borrows the text format and is not a conforming C2SP checkpoint. |
| 4 | An owner checkpoint over all heads makes a snapshot complete | nuanced | The test is "the checkpoint was accepted and is not an orphan", not a global `Dag.missing()`. Tip completeness covers only ancestors of the latest checkpoint; it covers the header skeleton, not payloads (a host can strip `v` silently); `(n, root)` is a redundant self-check; it does not stop a consistent older snapshot. |
| 5 | Cold start is cheap at our caps | nuanced | Reading 50,000 records: 150-192 ms in ephemeral contexts, 155-182 ms (Chromium) and 212-259 ms (WebKit) from a persistent profile. The 8 MiB cap holds 15.8k-22.0k blocks, not 13.6k; 13.6k blocks validate in 0.96 s (Chromium) and 1.14 s (WebKit) through `validateBlock` and a 2-worker pool, so budget 1.1-1.9 s at the cap on an M3. WebKit verifies P-256 about 1.5 times slower. Phones unmeasured. |
| 6 | Matrix redaction mechanics | confirmed | Additions: a redacted state event blanks the property instead of reverting it; Synapse keeps unredacted copies for 7 days by default; Matrix keeps and redacts an event whose content hash fails, while `validateBlock` rejects the block, so the spec should say which it means. |
| 7 | EDPB Guidelines 02/2025 v2.0 paragraphs | nuanced | Para 52: a salted or keyed hash "will also be considered personal data"; once the salt or key is deleted it "should not be linkable to the original data", under conditions. The text never says the hash stops being personal data. "Unsalted ... not sufficient" is hedged ("in general", "on a public" ledger). The EDPB declined to endorse any cryptographic recipe. |
| 8 | 50k-record IndexedDB and SQLite numbers; reducer plus plain IndexedDB is enough | nuanced | Two compound indexes plus one single-key index, not three compound; WebKit insert ranged 2.1-3.3 s over four runs; persistent-profile Chromium insert 2.9-3.8 s; the reducer at 50k blocks was never benchmarked. (The detail section for this claim is missing from the file; the verdict comes from its summary table.) |
| side | y-indexeddb writes the snapshot and deletes old rows in separate, non-atomic transactions | refuted | One transaction in Chromium 156 and WebKit 27.2 (from the report's summary; its section 9 is not in the file). |

### 4.2 w2c-03-V (identity)

| # | Claim | Verdict | Correction to apply |
|---|---|---|---|
| 1 | A non-extractable key in the loader origin's IndexedDB is usable by any same-origin script | confirmed | Stronger than stated: the CryptoKey can be structured-cloned to another origin and used there. Privacy copy: "the site you are on can act as you and can hand that on". |
| 2 | Safari deletes script-writable storage after 7 days without interaction; `persist()` heuristics | nuanced | "7 days of Safari use without interacting with the site", only while Prevent Cross-Site Tracking is on, per registrable domain. `persist()` returned false again, also in a persistent profile. |
| 3 | CryptoKey persistence fails in the wild on iOS Safari (open-chat #9343) | nuanced | The counts are a 2026-09-10 snapshot (October: 7-15 a day); the diagnosis is an unverified, AI-written hypothesis; Playwright's default context is incognito-like; a persistent WebKit profile round-trips keys across restarts; new variant: `indexedDB` missing entirely, which calls for a memory-only identity mode. |
| 4 | Ed25519 is in WebCrypto in every engine; P-256 aligns with WebAuthn, did:key and VCs | nuanced | Engine support confirmed. The "not yet universal" sentence exists only in the archived v0.1, so w2c-03 R10's fix is moot. WebAuthn L3 lists EdDSA first, `eddsa-jcs-2022` is a W3C Recommendation and did:key's flagship example is Ed25519: the case for P-256 rests on platform authenticators and root delegation, not on spec alignment. |
| 5 | Argon2 is not in the WebCrypto set Chrome is shipping | confirmed | Ship milestone 155, not 154. Installed Chromium 156 has ML-KEM, ML-DSA, ChaCha20-Poly1305 and X-Wing, no Argon2. WebKit's position is neutral with Argon2 reservations. noble's JS Argon2 is 4.7-5.9 times slower than WASM. |
| 6 | The same key on two devices forks a linear feed (SSB); ARCH's informational `seq` is harmless; the 06 draft would fork | confirmed | Worse than a fork: under the 06 draft rule all later ops of a cloned key are ignored. |
| 7 | PRF support is uneven and should be an enhancement | nuanced | Windows Hello "Feb 2026 / KB5077181" is not in Microsoft's KB text; the Apple hybrid PRF bug recurred in 2026; an iOS security-key PRF bug is open; MDN data is stale for Safari; Dashlane needs a role qualifier. |
| 8 | PRF semantics and the virtual-authenticator lab | confirmed | Only the with-user-verification PRF is exposed; `eval` at `create()` returns results in the virtual authenticator; FIDO CXF can carry hmac-secret material. |

### 4.3 w2c-06-V (standards)

| # | Claim | Verdict | Correction to apply |
|---|---|---|---|
| 1 | RFC 8552 registry: Expert Review, stable Reference, MUST register | confirmed | "Stable" is read loosely in practice (draft revisions, vendor URLs); the request form is IANA's generic one. |
| 2 | Registry state on 2026-10-17 | nuanced | 72 records (60 names, 17 TXT rows), not 69; `_x402` is registered against draft -01 while the draft is at -03. None of `_magnet`, `_dnslink`, `_atproto`, `_btlink`, `_ipfs` is registered (holds). |
| 3 | TXT syntax conventions disagree; v0.2 deviates from RFC 6376 | nuanced | The DNSOP draft -13 is a domain-verification draft with SHOULD-level rules. v0.2 repeats only `tr`/`ws`/`xs` (plus unknown keys) and rejects duplicate single-valued keys as DKIM does; its lowercasing matches RFC 6763 and the draft. RFC 10023 (July 2026) requires exactly one character-string, which conflicts with a two-string, 480-byte pointer. |
| 4 | DNSLink spec; nobody consumes `dnslink=/btih/` | nuanced | `@helia/dnslink` has a public `namespaces` option, so skipping unknown namespaces is only the default; say "no consumer found in the sources checked". |
| 5 | DNSLink has no steward; Shipyard ended; projects without maintainers | nuanced | The Service Worker Gateway is maintained (two named maintainers for the IPFS Foundation since 2026-09-22); Helia has no banner; seven other projects carry "no dedicated maintainer". |
| 6 | The BEP process is dormant | nuanced | No merges since 2020-05-01, but community drafts keep arriving unmerged, including PR #171 "Magnet-URI Webseeding", which formalises `ws` and `xs`. The highest BEP is 55 only if meta BEP 1000 is excluded. |
| 7 | webtorrent 3.0.21 BEP support, `xs=` behaviour, magnet-uri parsing | confirmed | "Maintenance mode" is an inference from the commit log. `bittorrent-dht` (a Node dependency) implements BEP 44, but WebTorrent does not expose it and the browser build has no DHT. |
| 8 | Web Packaging is a dead end | nuanced | Alive as the Isolated Web Apps signed container (`wbn-sign` 0.3.3 and WICG/webpackage commits on 2026-10-15); dead for ordinary-browser site delivery. |

### 4.4 Checks without a VERIFY report, and corrections found while digesting

- **`labs/w2c-01-verify-lab/`** (raw results from 2026-10-17 18:02-18:17 ET, 22:02-22:17 UTC; no written report; outside this digest's brief, read because P0-11 depends on it). It reproduces w2c-01 F2 for stock webtorrent: with a Range-ignoring host first in a two-URL list, 4 pieces stay missing in 4 of 4 runs and still after 130 s; a corrupt-only host draws 47,700-60,014 requests in 10 s; truncated-206 and HTML-200 hosts are survived. Its script `hardened-extra.mjs` names two edge cases of the prototype connection that no report covers: the drop rule counts consecutive integrity failures only (`MAX_STRIKES = 5` in `labs/w2c-01-lab/hardened-conn.mjs`, reset by any success), so a host that corrupts some pieces but never 5 in a row is never dropped; and pad files are recognised by the `.pad/N` path regex only, not by the BEP 47 `attr: 'p'` flag. Both behaviours are confirmed in the prototype's code; no result file for those runs exists. P0-11 asks for both fixes.
- **Hashcash default:** w2c-05 measured against 14 bits (v0.1); v0.2 uses 16 (conflict 5).
- **Wire length prefix:** w2c-05 F-D2 corrects the wave-1 "4 GiB" to "up to 2 GiB - 1" (`0xFFFFFFFF` reads as -1, a keep-alive). The tree already reads the prefix unsigned in `guardWire`.
- **`_dmarc` is registered** (w2c-06 Appendix B item 1, correcting `05-doh-dns-txt.md` F9).
- **ChaCha20-Poly1305 is arriving in Chromium's WebCrypto** (w2c-03-V claim 5), where w2c-02 Gotcha 17 had no shipping status. XChaCha20 is still absent, so noble stays the choice for epoch-key groups.
- **w2c-02-V is incomplete:** it ends after claim 7. Claim 8, its section 9 (the y-indexeddb experiment) and section 11 (evidence index) are referenced in its summary but not present.

---

## 5. Constraints discovered

### 5.1 Compatibility (browsers, libraries, protocols)

- **webtorrent 3.0.21:** web-seed requests add `Cache-Control` and `User-Agent` (non-safelisted, so every cross-origin request needs a preflight); any 2xx is accepted; no ban or backoff; `maxWebConns` is 4 per URL; single-file torrents need the full file URL (BEP 19 appends the name, webtorrent does not); a `url-list` or `ws=` spawns stock connections unless `webSeeds: false`; no BEP 52, 44 or 46, DHT or PEX in the browser; BEP 47 pad files appear as ordinary `.pad/N` files; `xs=` is fetched with CORS and dropped with only a `warning` event on an infohash mismatch. (w2c-01 F1-F3, Gotchas 1-8; w2c-06 S6, Gotchas 12-13)
- **bittorrent-protocol 5.0.9** reads the length prefix as a signed 32-bit integer. (w2c-05 Gotcha 1)
- **Cross-origin reads:** `Content-Range` and `Content-Encoding` are invisible to page script unless exposed; a preflight must answer 2xx without a redirect. (w2c-01 Gotchas 2, 5)
- **WebCrypto:** no Argon2 and no XChaCha20. Ed25519 arrived in Chrome 137, Firefox 129, Safari 17 and Samsung Internet 30, all above the INTERFACES floor (Safari/iOS 15.4, Chromium 110, Firefox 115), so any Ed25519 verification needs a JS fallback (inference from w2c-06 Gotcha 11 and INTERFACES). WebKit rejects PKCS8 private keys without the public key. Non-extractable keys can be used and structured-cloned by same-origin script. (w2c-03 Gotcha 1; w2c-03-V claims 1, 5)
- **Multikey for P-256 needs compressed points;** decompression needs BigInt modular square roots. (w2c-06 Gotcha 10)
- **Storage:** Safari deletes script-writable storage after 7 days of Safari use without interaction with the site (Prevent Cross-Site Tracking on), all at once per registrable domain, Home Screen web apps exempt; `persist()` returned false in both headless engines; one origin may take up to 60% of disk (Chromium, Safari) or 10 GiB per site group (Firefox), so loader quotas are advisory against hostile same-origin script. (w2c-03-V claim 2; w2c-04 S6, Gotcha 17)
- **Service Workers** (Chromium 156 only): a 404 or 410 for the SW script does not uninstall it; a self-unregistering script leaves IndexedDB and localStorage; `Clear-Site-Data` works on network responses, not on SW-synthesized ones; its `"cookies"` directive is registrable-domain-wide. (w2c-04 F9, Gotchas 6, 9)
- **Hostnames:** one DNS label of at most 63 octets; 32 base32 characters are exactly 160 bits with one spelling; SHA-256 ids need 52 characters. (w2c-04 S3; w2c-06 S11)
- **DNS TXT:** a signed pointer of about 480 B needs two character-strings joined without spaces; RFC 6763 s6.2 puts 400 B as the size that fits a 512-byte UDP answer; pkarr packets cap at 1000 B; RFC 10023 asks for exactly one string (a single-purpose convention, not binding here). (w2c-06 S4; w2c-06-V claim 3)
- **BEP 10:** extra handshake keys need a client prefix (`mw_chain`, `mw_v`). (w2c-06 S6)
- **Network signals:** `connection.type` exists only in Chromium on Android, `saveData` only in Chromium; iOS and Firefox expose nothing, so by default most phones never upload. (w2c-07 Gotcha 7)
- **Chrome Local Network Access** may prompt for same-LAN WebRTC pairs from Chrome 146 (Microsoft eCDN documentation; untested here). (w2c-07 F30)
- **Content blockers:** uBlock Origin's default privacy list blocks P2P-CDN scripts by name and path under the rule that such scripts "MUST be opt-in". (w2c-07 S8)
- **Test tooling:** Playwright Firefox 157 does not start on this macOS 27; WebKit opened no data channel locally; Playwright's default flags disable third-party storage partitioning; its SW API is Chromium-only; `page.clock` and `routeWebSocket` stop at the main thread; Lighthouse CI bundles Lighthouse 12.6.1 while Lighthouse is at 13.5.0. (w2c-05 Gotchas 3-9, 15; w2c-04 Gotcha 11)

### 5.2 Operational

- **IPFS public gateways** (`ipfs.io`, `dweb.link`) retired on 2026-09-21 and Shipyard stopped on 2026-09-30; gateway state changed within a single session, so re-probe before every release. (w2c-01 S3, Gotcha 11; w2c-04 S2)
- **Blossom:** no SLA, blobs may expire (BUD-01 `Sunset`), payment (402) allowed, every BUD except BUD-01 is a draft; 4 of 13 servers held the test blob. (w2c-01 Gotchas 12-13)
- **Arweave:** uploads are immutable and public, prices float, `arweave.net` ignores Range. (w2c-01 S5, Gotcha 14)
- **Request-metered hosts** count every Range request (Pinata free plan: 10,000 requests a month); each extra mirror multiplies concurrent requests. (w2c-01 R3, Gotcha 15)
- **Hub cost:** a shell-only hub costs about $21 per million cold visits on CloudFront pay-as-you-go and about $2.40 per million on Cloudflare Workers Paid. The web-seed mirror is the real cost: 4.9 TiB (100,000 cold visits x 50 MiB) is about $466 on CloudFront, $26 on Bunny Volume and $7 on R2 if peers serve nothing. Cloudflare's CDN terms restrict large files on Free, Pro and Business unless R2 or Workers serve them. (w2c-04 S11, Gotcha 16)
- **Wildcard hosting:** CloudFront with ACM (certificate in us-east-1), Workers routes, Vercel and Caddy with DNS-01 can serve `*.sites-domain`; Cloudflare Pages and Workers Custom Domains cannot; use one wildcard certificate, never per-label certificates (Let's Encrypt limits and Certificate Transparency exposure). (w2c-04 S4, Gotchas 1-2, 14)
- **Never map 403/404 to `/index.html`** with a CloudFront custom error response. (w2c-04 Gotcha 3)
- **Scheduled CI** is best-effort and stops after 60 days of repository inactivity; Checkly's free plan allows 1,000 browser runs a month. (w2c-05 Gotcha 17)
- **Datacenter probes prove availability, not NAT traversal.** (w2c-05 Gotcha 18)
- **This machine:** LuLu raises prompts per Playwright binary path; `docs/DEV-NETWORK.md` keeps every browser on 127.0.0.1; cross-engine P2P runs belong in a Linux container. (w2c-05 Gotcha 8)
- **Ecosystem fragility is organisational:** pin versions, vendor small pieces, keep the specs implementable without any single project. (w2c-06 Gotcha 18)

### 5.3 Legal (nothing here is legal advice; every file asks for counsel)

- **EDPB Guidelines 02/2025 v2.0 (adopted 07 July 2026):** personal data on a replicated ledger is "not advisable"; public keys are identifiers; salted hashes remain personal data; the EDPB endorsed no cryptographic recipe. The guidelines apply to the site ledger by analogy only. (w2c-02 S9, Gotcha 6; w2c-02-V claim 7)
- **Erasure reaches cooperating peers only.** NIP-62's "legally binding" is the NIP's own sentence; Synapse's erase leaves messages visible to earlier members. Do not copy either as a compliance claim. (w2c-02 Gotchas 2, 7)
- **Consent:** silence is not consent (EDPB 03/2022). Whether OK on the current notice is valid consent for exposing a visitor's IP address remains open (w2b-06). (w2c-07 S9, OQ 8)
- **Hub operator:** the hub's domain is in the URL bar of every hosted site; no hub-run directory or search (Ziggo); a DMCA agent if US-facing and a DSA contact point if EU-facing; the DSA classification of a shell-only hub and Canadian requirements are unresearched. (w2c-04 S12, OQ 8)
- **PSL:** an entry needs at least 2 years of registration left and a `_psl` TXT record, may be refused for small projects, and has no SLA. (w2c-04 S5)
- **Site owners' notice-and-action duties** for reports (for example under the DSA) are unresearched. (w2c-03 OQ 8)
- **Licences:** `bt-fetch` is AGPL-3.0-or-later; DiceBear's CC BY styles need attribution. (w2c-06 S12; w2c-03 Gotcha 15)

---

## 6. Open questions

| # | Question | Blocks | How to settle | Source |
|---|---|---|---|---|
| 1 | Do Firefox and Safari accept web seeds with stripped headers, honour `Clear-Site-Data: "storage"` for Service Workers and caches, re-fetch the SW soon after a navigation, and pass P2P E2E? | P0-10, P0-17, P0-30 | Linux pipeline (P0-17) and real devices (P1-25) | w2c-01 OQ 1-2; w2c-04 OQ 2; w2c-05 OQ 3 |
| 2 | Phone numbers: IndexedDB writes with indexes, P-256 verify, `mine()` at 16 bits, Argon2id at 64 MiB, SQLite `opfs-sahpool` | checkpoint cadence, KDF parameters, PoW default | P1-25, P2-21 | w2c-02 OQ 8; w2c-03 OQ 4; w2c-05 OQ 10 |
| 3 | Does a synced passkey return the same PRF output on every device? | phrase-free restore (P3) | two physical devices per provider | w2c-03 OQ 1; w2c-03-V claim 7 |
| 4 | P-256 or Ed25519 for owner and author keys; is a mixed-algorithm ledger wanted? | P2-28, passkey roadmap | owner decision; P0-5 keeps it reversible | w2c-03 OQ 5; w2c-06 OQ 3-4 |
| 5 | Per-author sequence chain or not (multi-device)? | P1-12, P2-15 | decide before multi-device work | w2c-03 OQ 6 |
| 6 | Unknown control op: invalid block, or valid and ignored? | P0-3 | decide before the freeze | w2c-02 OQ 3 |
| 7 | Does a tombstoned `put` revert to the previous value or blank the key (Matrix blanks)? Are banned authors' payloads dropped? Is a "clear key" variant needed? | P0-4 | decide before the freeze | w2c-02 OQ 1, 13; w2c-02-V claim 6 |
| 8 | Per-op random salt (chosen) or an author-held keyed commitment? | P0-1 | decide before the freeze | w2c-02 OQ 2 |
| 9 | Is a restricted charset enough for permanent keys and list names, or should the SDK hash user-supplied keys? | P0-2 | privacy review | w2c-02 OQ 4 |
| 10 | Checkpoint cadence and snapshot caps on cellular; should the pointer name the newest checkpoint (`ck=`) to stop rollback to an older consistent snapshot; how should the loader treat a snapshot stripped of payloads? | P1-5 | field data, then owner decision | w2c-02 OQ 5, 12; w2c-02-V claim 4 |
| 11 | Snapshot hosting over HTTPS only (`cs=`) or also through the per-ledger anchor torrent? | P1-5 | decision | w2c-02 OQ 14 |
| 12 | Can the SW add COOP/COEP without breaking the iframe, WebRTC or `blob:` rendering? | P3 SQLite | experiment | w2c-02 OQ 9 |
| 13 | Legal: controller roles; whether an author key is personal data for recipients (CJEU C-413/23 P not retrieved); DSA status of a shell-only hub; Canadian law for a small hub; owners' reporting duties; validity of OK as consent for IP exposure | P0-31, P1-10 | counsel | w2c-02 OQ 10; w2c-03 OQ 8; w2c-04 OQ 8; w2c-07 OQ 8 |
| 14 | Pointer separator: `;` only, or also accept spaces? How long does IANA take? | P0-6, P2-25 | decide before the first public record; ask the experts informally | w2c-06 OQ 1-2 |
| 15 | Will the PSL accept a young hub, and does Safe Browsing narrow verdicts to subdomains of listed suffixes? | P0-31 | ask the maintainers; a controlled test | w2c-04 OQ 3; w2c-06 OQ 12 |
| 16 | KeyValueStore propagation time; flat-rate plan with wildcard names plus KVS; real CloudFront Functions runtime and cost | P1-15 | deploy a test label | w2c-04 OQ 1, 5, 6, 12 |
| 17 | Pointer discovery for signed labels without a backend; identity across hubs | P0-29 | design | w2c-04 OQ 4, 11 |
| 18 | Real consent click-through (with and without the 10 s deferral), mean engaged dwell, eligible share and offload on the example site | economics claims, P1-31 | P1-34 | w2c-07 OQ 1-2 |
| 19 | Does Chrome 146+ prompt for same-LAN WebRTC pairs? | P2-33 | real-device check | w2c-07 OQ 10 |
| 20 | Do device farms allow data channels between remote sessions; is the local WebKit data-channel failure caused by LuLu, WebKit or headless mode? | P1-25 | one-day spike; run inside the Linux image | w2c-05 OQ 1-2 |
| 21 | Do common hosts compress Range responses for text types? | P0-12 | `check-webseed.mjs` per host | w2c-01 OQ 4; w2c-05 OQ 5 |
| 22 | Do dedicated IPFS gateways serve multi-file directory CIDs with Range, CORS and no compression surprises? | P1-3 | a paid-plan test | w2c-01 OQ 3 |
| 23 | Which Blossom servers keep a 5 MiB blob for a year, at what capacity? | P1-2 | longitudinal probe | w2c-01 OQ 8 |
| 24 | Do native seeders (libtorrent 2.1, anacrolix) interoperate with browser peers; do mainstream clients follow BEP 46 links? | P2-4, P2-28 | spike | w2c-01 OQ 5; w2c-06 OQ 8 |
| 25 | Are there public pkarr relays besides `pkarr.pubky.app`? | P2-28 | survey; self-hosting option | w2c-06 OQ 6 |
| 26 | Should the loader shell itself get a second host? | availability | design | w2c-01 OQ 11 |
| 27 | Should DESIGN-REVIEW §4.3 (Safari wording) and §4.5 (notice buttons) be amended? Both strings are marked final. | P0-20, P0-27 | owner decision | conflict 6; D25 |
| 28 | Should the web-seed integrity cap count consecutive failures (prototype) or total failures with decay; should pads be recognised by attribute or by path? | P0-11 | unit tests with an intermittently corrupt host | w2c-01-verify-lab |
| 29 | Search-budget leftovers (missing, not negative): offload-by-audience data from Streamroot, Peer5 and PeerTube; Matrix policy lists; Megolm; RLN proof time in browsers; Firefox Related Origin Requests; Signal and Session recovery designs; other WebTorrent site loaders | none directly | rerun with a search budget | w2c-07 §8; w2c-02 OQ 11; w2c-03 OQ 9; w2c-06 OQ 13 |

---

## 7. Roadmap proposal

### 7.1 v0.3 (within weeks)

- **Green, hermetic test baseline (P0-9):** no later item can be gated without it.
- **Web-seed hardening (P0-10 to P0-13, the fault server of P0-14):** the availability floor fails silently today, and every other path depends on it.
- **Format freeze items (P0-1 to P0-8):** cheap before any public record or block exists; a version bump and a ledger fork afterwards.
- **CDP impairment helper and the split E2E case (P0-15):** peer-loss tests must test peer loss.
- **Honest policy (P0-24 to P0-27):** economics text, the no-incentive clause, byte budgets and a symmetric notice are small changes that protect visitors and keep claims true.
- **Identity core and durability UX (P0-18, P0-20, P0-23):** stops silent identity loss for new identities; the phrase UI can follow in v1.0.
- **Paged `mw.db.list` (P1-37):** a small SDK addition now avoids an SDK change later.
- **DEPLOY and ARCH corrections (P1-17, P1-33):** hosting guidance is wrong without the wildcard table and the swarm calculator.

### 7.2 v1.0 (first public, production-ready release)

- **Remaining P0 gates (P0-14 harness, P0-16, P0-17, P0-19, P0-21, P0-22):** DESIGN-REVIEW item 25 makes passing gates the definition of production-ready.
- **Hub group (P0-28 to P0-31, P1-15 to P1-19), only if a public hub ships:** a hub without labels, takedown and an abuse program is a phishing host.
- **Ledger P1 (P1-5 to P1-12):** checkpoints, `vanish`, import and spam layering are what "production database" means in w2c-02.
- **Content P1 (P1-1 to P1-4):** a manifest plus a Blossom fallback removes the web seed as a single point of failure without a new P2P stack.
- **Specs (P1-20, P1-21, with `mw_v` from P2-26):** the IANA request and any second implementation need stable, versioned texts.
- **Testing P1 (P1-22 to P1-30):** chaos, NAT, fuzzing, devices, accessibility, performance, soak, migration and upgrade coverage are the remaining release evidence. Pull one piece of P2-21 forward into the device runs: time `mine()` at 16 bits on real phones, because open-writing sites ship with that default and it has only been estimated (conflict 5).
- **Economics P1 (P1-31, P1-32, P1-34 to P1-36):** measured numbers replace modelled ones, and the pinner kit gives owners a real availability plan.
- **Identity checks (P1-13, P1-14):** WebKit coverage and a comprehension test before the copy ships.

### 7.3 Later (v1.x and v2)

- **Identity v2 (P2-12 to P2-15; P3 identity items):** passkeys, verified names and subscribable lists help, but need v1 identity in the field first.
- **Ledger growth (P2-6 to P2-11; P3 ledger items):** encryption, caveated grants and pruning matter once real ledgers approach the caps.
- **Standards and naming (P2-25, P2-27 to P2-30):** IANA registration, pkarr and wire-format DoH follow stable specs and Ed25519 owner keys.
- **Content extras (P2-1 to P2-5):** hints, Arweave, nsite, bundle mode and native seeders are optional once the manifest exists.
- **Hub operations (P2-16 to P2-19; P3 hub items):** deny lists, cost guardrails, BYO domains, HSTS preload and PSL re-application grow with usage.
- **Testing extras (P2-20 to P2-24; P3 testing items):** visual regression, scale generators, a synthetic swarm, clock seams and flake hygiene keep the suite trustworthy as it grows.
- **Economics extras (P2-31 to P2-34; P3 economics items):** tune with field data from P1-34.
- **Watch list:** Helia's triggers (w2c-01 R13), webtorrent BEP 52 (#1117), WAICT and signature-based SRI, Isolated Web Apps, a DNSLink revival, the draft BEP PR #171.

---

## 8. Standards alignments to adopt now

| Standard or convention | Adopt now as | Do not claim or do | Source |
|---|---|---|---|
| RFC 6376 s3.2 tag-list, RFC 7208 s3.3 string joining | normative ABNF profile for MW-PTR/1: `v=mw1` first; deviations stated (names case-folded, `tr`/`ws`/`xs` repeatable, unknown tags kept in the signed bytes); character-strings concatenated without spaces | do not call the record "DKIM-style" without the deviations | w2c-06 A1, Gotcha 3; w2c-06-V claim 3 |
| RFC 6763 s6.2 and the pkarr packet cap | size budget: SHOULD be at most 450 B, MUST be at most 900 B; `publish.mjs` warns above 450 | - | w2c-06 A1 |
| RFC 8785 (JCS) | canonical block bytes, tested against the six published vector files | do not claim W3C Data Integrity (`ecdsa-jcs-2019`) conformance; describe the signature as "inspired by" it | w2c-06 A14, Gotcha 15; w2c-05 R-06 |
| Wycheproof ECDSA P-256 P1363 | signature vector suite in Node and in three engines | - | w2c-05 R-06 |
| W3C Multikey and did:key | a documented mapping from `p256:`/`ed25519:` strings; display and export later | not the canonical wire string; did:key cannot rotate or revoke | w2c-06 A2, Gotcha 10; w2c-03 Gotcha 18 |
| BEP 9, 10, 19, 53 and webtorrent `xs=` | `xs` and `ws` mandatory at publish, `xs` https only; prefixed BEP 10 names (`mw_chain`, later `mw_v`); full file URLs for single-file seeds | no new BEP submission; no v2 or hybrid publishing; `btmh=` only reserved | w2c-06 A5, A6, A17; w2c-01 R3 |
| RFC 4648 base32 and the IPFS subdomain-gateway label rules | one lowercase label, 32 characters now, length as a named constant | - | w2c-06 A7; w2c-04 R1 |
| RFC 8552 underscore names | use `_magnet` now; file the IANA request once MW-PTR/1 is stable (P2) | do not claim a registration that does not exist yet | w2c-06 A4, Gotcha 5 |
| RFC 2142 (`abuse@`), RFC 9116 (`security.txt`), RFC 7725 (451 with `Link: rel="blocked-by"`) | minimum abuse program for any public hub | - | w2c-04 R3, R5 |
| W3C Clear-Site-Data | `"storage"` only, for takedown | never `"cookies"` | w2c-04 Gotcha 6 |
| Public Suffix List | apply for the sites domain at launch; design to be safe without it | not a launch condition | w2c-04 R4 |
| Unicode NFC and UTS #39 | name normalisation and confusable checks | - | w2c-03 R5 |
| BIP-39 word list, NIP-49 payload shape | encoding of the recovery phrase and of the encrypted backup file | no BIP-39 PBKDF2 step; tell users not to paste the words into wallets | w2c-03 R3, Gotcha 12 |
| NIP-56 report categories | report vocabulary | reports are signals, never automatic actions | w2c-03 R8 |
| NIP-5A aggregate-hash rule | the `mf=` manifest hash (sorted `<sha256> <path>` lines, then SHA-256) | - | w2c-01 R4 |
| C2SP signed-note text | only if witnesses ever happen (P3) | a P-256 checkpoint is not a conforming C2SP checkpoint | w2c-02-V claim 3 |
| WCAG 2.2 AA | working accessibility target | - | w2c-05 R-11 |

**Considered and not adopted** (keep this as a decision record): DNSLink or btlink dual-publish (w2c-06 A10); Web Bundles and Signed Exchanges, alive only as the IWA container (w2c-06-V claim 8); Isolated Web Apps and Direct Sockets (enterprise ChromeOS only); BEP 44/46 in the browser (reach them through pkarr later); SCITT, COSE receipts and CT 2.0 (linear logs, the site ledger is a DAG); RFC 6920 `ni:`; Nostr relays as a pointer channel (secp256k1 is not in WebCrypto); Iroh WASM (browser traffic is relay-only); new protocol schemes (`web+` plus letters only, if ever); Helia and verified-fetch (w2c-06 §3.1; w2c-01 R13).

---

## 9. Honest economics

Every number in this section is a **model output** of `docs/research/labs/w2c-07-lab/little-calc.mjs` under stated assumptions, not a measurement. P1-34 replaces the soft inputs with field data.

**Formulas** (w2c-07 Appendix B.1): mean visitors online `E[N] = visits per day x mean dwell seconds / 86,400` (Little's law; with Poisson arrivals the count online is Poisson for any dwell distribution, and w2c-07's simulation confirms it for heavy-tailed dwell with variance/mean 0.998-1.002). The chance an arriving visitor is alone is `exp(-E[N])`. Eligible seeders online = visits per second x eligible share x mean seeding time per visit. Use the **mean** dwell, not the median: with the assumed Weibull dwell (shape 0.6) a 60 s mean has a 21.6 s median.

### 9.1 Concurrent visitors by daily visits and mean dwell (w2c-07 Appendix B.4, table T1)

Cells: mean visitors online, with the chance of arriving alone in parentheses.

| Visits per day | 20 s | 60 s | 180 s | 600 s |
|---|---|---|---|---|
| 100 | 0.02 (98%) | 0.07 (93%) | 0.21 (81%) | 0.69 (50%) |
| 1,000 | 0.23 (79%) | 0.69 (50%) | 2.08 (12%) | 6.94 (0.10%) |
| 10,000 | 2.31 (9.9%) | 6.94 (0.10%) | 20.8 (0.00%) | 69.4 (0.00%) |
| 100,000 | 23.1 (0.00%) | 69.4 (0.00%) | 208 (0.00%) | 694 (0.00%) |
| 1,000,000 | 231 (0.00%) | 694 (0.00%) | 2,083 (0.00%) | 6,944 (0.00%) |

### 9.2 Eligible seeders online, baseline scenario

Visitors online are not seeders. A visitor seeds only after consenting (0.30), on a desktop or a confirmed phone network (0.35), with a direct connection that works (0.80): an eligible share of 0.084, about 1 visit in 12 (w2c-07 Appendix B.2). Generated on 2026-10-19 with `node little-calc.mjs --visits V --dwell D --size 50` (ready to seed after 3 s; web seed 8 MiB/s; peers 1 MiB/s each; first peer wire after 2 s). Cells: eligible seeders online / chance that none is online / expected share of a 50 MiB site's bytes that come from peers. The 60 s column matches w2c-07 table T2.

| Visits per day | 20 s | 60 s | 180 s | 600 s |
|---|---|---|---|---|
| 100 | 0.00 / 100% / 0.01% | 0.01 / 99% / 0.04% | 0.02 / 98% / 0.13% | 0.06 / 94% / 0.44% |
| 1,000 | 0.02 / 98% / 0.13% | 0.06 / 95% / 0.42% | 0.17 / 84% / 1.3% | 0.58 / 56% / 4.1% |
| 10,000 | 0.17 / 84% / 1.3% | 0.56 / 57% / 4.0% | 1.72 / 18% / 11% | 5.81 / 0.30% / 27% |
| 100,000 | 1.72 / 18% / 11% | 5.58 / 0.38% / 27% | 17.2 / 0% / 46% | 58.1 / 0% / 60% |
| 1,000,000 | 17.2 / 0% / 46% | 55.8 / 0% / 59% | 172 / 0% / 65% | 581 / 0% / 67% |

Visits per day needed for 25 eligible seeders online at a 60 s mean dwell: about 8,960,000 (pessimistic, share 0.0042), **448,000 (baseline, 0.084)**, 82,000 (optimistic, 0.459, which assumes a default-on design). (w2c-07 S3, table T2)

### 9.3 Share of first-load bytes from peers, by site size (w2c-07 tables T3 and T3b)

Columns: mean eligible seeders online. Web seed at 8 MiB/s (a fast CDN path); the rows in brackets use a slow 2 MiB/s host path.

| Site size | 0.1 | 1 | 3 | 10 | 30 | 100 |
|---|---|---|---|---|---|---|
| 2 MiB | 0% | 0% | 0% | 0% | 0% | 0% |
| 5 MiB | 0% [0.65%] | 0% [5.3%] | 0% [11%] | 0% [16%] | 0% [19%] | 0% [20%] |
| 20 MiB | 0.22% [2.6%] | 2.0% [21%] | 5.1% [44%] | 11% [66%] | 16% [75%] | 19% [78%] |
| 50 MiB | 0.75% [3.0%] | 6.9% [24%] | 17% [50%] | 37% [75%] | 53% [86%] | 63% [90%] |
| 128 MiB | 0.96% [3.2%] | 8.8% [26%] | 22% [53%] | 47% [79%] | 69% [91%] | 81% [95%] |

### 9.4 What it saves the host, and what it costs a mobile visitor (w2c-07 tables T4 and T5)

| Visits per day | Site | Egress per month | Expected offload | Saved per month at CloudFront list ($0.085/GB) |
|---|---|---|---|---|
| 1,000 | 5 MiB | 146 GB | 0% | $0 |
| 100,000 | 5 MiB | 14,648 GB | 0% | $0 |
| 10,000 | 50 MiB | 14,648 GB | 4.0% | about $50 |
| 100,000 | 50 MiB | 146,484 GB | 27% | about $3,325 (overstated: volume tiers fall to $0.06/GB above 50 TB and $0.025 above 1 PB) |

Many hosts charge nothing for this traffic: R2 egress is free, GitHub Pages has a 100 GB monthly soft limit, and CloudFront's flat-rate Free plan includes 100 GB (w2c-07 S4).

Uploading 15 MiB on mobile data costs the visitor about $0.038 at the 2023 global mean of $2.59/GB, about 30 times the $0.00125 the host saves; the ratio ranges from 0.2 (Israel) through 54 (Northern America average) to 515 (Zimbabwe). (w2c-07 S5, table T5; prices are a 2023 edition, OLD)

### 9.5 What offload is realistic

- **Small sites (under about 16 MiB) on a fast host get about 0% of first-load bytes from peers at any audience size:** the web seed delivers 16 MiB in the 1.5-3 s a first peer wire needs. Their gain is resilience: a verified local copy, instant and offline revisits, the site ledger replicated between visitors online together, and service from peers while the host is down if anyone is online. (w2c-07 S4, Gotcha 4)
- **Medium sites (20-50 MiB):** single-digit percentages until about 10,000 visits a day with dwell of minutes; a 50 MiB site reaches 27% at 100,000 visits a day and a 60 s mean dwell (table 9.2).
- **Large sites with big audiences or long dwell:** 40-80%. w2c-07 F28 worked examples: a hobby blog (400 visits a day, 45 s) is alone 81% of the time with 0% offload; a docs site (8,000 a day, 90 s, 20 MiB) has 0.68 eligible seeders, no seeder online 51% of the time, 1.4% offload (2.5% at the peak hour); a desktop-heavy tool (100,000 a day, 120 s, optimistic share, 50 MiB) reaches 62 eligible seeders and 60%; a media site (5,000 a day, 20 minute dwell, 500 MiB) reaches 13.9 eligible seeders and 60%.
- **A slow host path raises the peer share a lot** (the bracketed values in 9.3), which is the case for the P2-34 peer-first trial on large sites.
- **Time of day:** multiply E[N] by about 1.25 at the peak hour for a global audience and 1.6-1.9 for a national one; national audiences fall to 0.21-0.32 of the mean at night (Wikimedia hourly views, w2c-07 S10).
- **A few long tabs carry most of the seeding:** the longest 10% of visits hold 51-60% of all dwell time (w2c-07 F29), which is why the per-day budget matters more than the per-visit one.
- **Phones are mostly out:** uploads are off on cellular and unknown networks, which is economically necessary and removes most phones (63-88% of Wikimedia views are mobile) from the seeder pool. (w2c-07 S5, Gotcha 7)
- **Model limits:** Poisson arrivals (bursts enter only through the peak factor); consent, device and dwell treated as independent; partial seeders ignored; each seeder's uplink assumed free; CPU, battery and queueing cost on the seeder not measured. NetSession, the best dataset, is a different regime (GB files, 25 M clients, a trusted control plane). (w2c-07 Appendix B.3, Gotchas 2, 11-12)

### 9.6 Defaults that follow (w2c-07 §4.3, §4.5)

| Setting | Desktop | Phone, Wi-Fi confirmed | Cellular, unknown or Save-Data |
|---|---|---|---|
| Upload rate (existing, ARCH §8) | 1 MiB/s | 256 KiB/s | 0 |
| Upload budget per visit (new) | min(256 MiB, 4 x site size) | min(32 MiB, 1 x site size) | 0 |
| Upload budget per day per origin (new) | 512 MiB | 64 MiB | 0 |
| Hidden tab | pause uploads after 60 minutes hidden (new); existing battery rule kept | client destroyed (existing) | nothing runs |
| Battery | pause uploads while discharging below 40% (new) | n/a | n/a |

The thanks message appears at most once per origin per 30 days, only after 8 MiB to at least 2 peers, 60 s after load and 5 s without input, never on cellular, never after a decline or pause, never in a hidden tab, with equal-weight "Keep sharing" and "Stop sharing" buttons and no confirmshaming, streaks, badges or leaderboards. Ready-to-use README, DEPLOY and status-bar texts are in w2c-07 §3.1-§3.3; they already follow DESIGN-REVIEW §4.

---

## 10. Identity UX decisions

### 10.1 v1: "guest identity with a recovery phrase" (w2c-03 §4.2, as corrected by w2c-03-V)

| # | Decision | Detail | Source |
|---|---|---|---|
| I1 | States | Reader (no key, no prompts; reading and seeding never create an identity), Guest (created at the first write attempt with a one-line inline step, not a modal), Backed up, Manage | w2c-03 §4.2 |
| I2 | Key derivation | 16-byte CSPRNG seed, HKDF-SHA256 (salt `mw/id/v1`, info includes the chain id), P-256 scalar, JWK `{d, x, y}` import as non-extractable with `x` and `y` from a curve library; never PKCS8 without the public key | w2c-03 R2, Gotcha 1 |
| I3 | Robustness | read-back sign and verify self-test; on failure keep the seed and import per session; memory-only mode when `indexedDB` is missing | w2c-03 §4.2 step 2; w2c-03-V claim 3 |
| I4 | Scope | one derived identity per chain id; one phrase restores all of them | w2c-03 §4.2 |
| I5 | Key string | `author` is `p256:<b64url>`; P-256 is the only generated type in v1 | D15 |
| I6 | Backup | 12 words (BIP-39 list as an encoding only, checksum included), Copy, Print, QR, optional encrypted file (Argon2id 64 MiB t=3 p=1 in WASM, or scrypt N=2^16; authenticated encryption; NIP-49 shape; one normalisation rule with vectors), then a 3-word re-entry check | w2c-03 R3, Gotchas 9-12 |
| I7 | Restore | paste the phrase, scan the QR or load the file; same public key per chain; copy: "Use one device at a time unless the site says otherwise." | w2c-03 §4.2 step 5 |
| I8 | Durability | request `navigator.storage.persist()` at identity creation from a user gesture; show `persisted()` truthfully and never gate on it; on iOS Safari outside a Home Screen app, warn and suggest Add to Home Screen after the first post; never claim durability | w2c-03 R4, Gotcha 8 |
| I9 | Trust boundary | the phrase, seed and backup status never reach the SDK, `postMessage` or localStorage; export, restore and every security prompt run in loader-owned, visually distinct UI after a user gesture, never in site-controlled UI | w2c-03 Gotchas 14, 19 |
| I10 | Shared-origin hubs | no persistent identity and no export; offer read-only plus a pointer to an isolated URL | w2c-03 R7; w2c-03-V claim 1 |
| I11 | Names | the self-chosen name is a nickname (at most 48 characters today); a local petname overrides it on this device and keeps the original visible; equal nicknames render with a key-derived suffix, `Alex (7F3A)`; only the owner-signed badge for owner and moderators is authoritative | w2c-03 §4.2, R5 |
| I12 | Name input | NFC; reject control, format and bidi-control characters; caps by code points and bytes; UTS #39 restriction level and skeleton comparison against names already in the chain; show "looks like <existing name>" | w2c-03 R5 |
| I13 | IDs and avatars | compact view: name, avatar, 4-character suffix (20 bits, disambiguation only); details: 64-bit ID (13 base32 characters) plus the full key string with copy and QR; avatars seeded from at least 64 bits and labelled "for recognition"; none of these is ever used in a security decision | w2c-03 R5, Gotcha 15 |
| I14 | Visitor moderation | per-post Mute ("You won't see this person on this device; they aren't told"), Block, Report (NIP-56 category plus a short note), Copy author ID; placeholders with "Show once" and Undo; lists per chain, never gossiped, included in the encrypted backup | w2c-03 R6, §4.2 |
| I15 | Reports | appended to a reserved `reports` list, public to peers (the UI says so), rate-limited per author; the owner sees them grouped by unique reporters; never auto-hide on counts | w2c-03 R8, Gotcha 17 |
| I16 | Multi-device | keep `seq` informational; deduplicate on the block hash `h`, never on the signature (ECDSA signatures are malleable) | w2c-03 R9, Gotcha 13 |

**Copy for v1** (proposals; the owner approves because DESIGN-REVIEW §4.3 holds a final Safari string):

- Identity card: "Your identity is a secret key kept in this browser. It is not stored on any server. If this site's data is cleared, you will not be able to edit or delete your posts. Safari can clear it if you use Safari for 7 days without using this site. Save a recovery phrase to keep control. [Save recovery phrase] [Later]" (w2c-03 §4.2 step 3, Safari sentence corrected per w2c-03-V claim 2)
- Phrase warning: "Anyone with these words can post as you. Do not reuse them anywhere else. We cannot recover them for you." (w2c-03 §4.2 step 4)
- Privacy line, per-domain mode: "The site you are on can act as you and can hand that on." (w2c-03 §4.2; w2c-03-V claim 1)

### 10.2 v2: "passkey-protected, verifiable, shareable moderation" (w2c-03 §4.3)

| # | Decision | Detail | Source |
|---|---|---|---|
| J1 | Protect with passkey | feature-detect `extension:prf` with `getClientCapabilities()`; create the passkey, evaluate PRF in a separate `get()` with a fixed salt, derive a key with HKDF, wrap the seed with AES-GCM; the phrase stays the master backup; fall back silently without PRF. Removes silent signing by same-origin script (inference, untested) | w2c-03 R13; w2c-03-V claims 7-8 |
| J2 | Known PRF gaps to test first | only the with-user-verification PRF is exposed; Apple hybrid PRF bug (2026 recurrence); iOS security-key PRF bug; Windows Hello support date unverified; every origin (site, hub, mirror) is a different RP ID | w2c-03-V claim 7; w2c-03 Gotcha 6 |
| J3 | Phrase-free restore | prototype only, after two physical devices per provider return the same PRF output | w2c-03 R21, OQ 1 |
| J4 | Device sub-keys | root-signed delegation and revocation, only if the per-author-chain decision (P1-12) requires it | w2c-03 R17 |
| J5 | Verified names | identity-signed statement plus `_mw-id.<domain>` TXT or a well-known file, checked both ways through the existing DoH code, with a visible "no longer verified" state | w2c-03 R14 |
| J6 | Moderation lists | owner and moderator lists, subscribed by default for the site, can be unsubscribed, "hidden by <list>" with Undo | w2c-03 R15 |
| J7 | Encrypted reports | the owner publishes an encryption key in the policy; one sealed-box construction shared with the owner inbox (conflict 13) | w2c-03 R16; w2c-02 R12 |
| J8 | Extras | did:key export (state that rotation is a magnet-web feature), desktop opt-in Nostr link statement, SLIP-39 recovery cards | w2c-03 R18-R20 |
| J9 | Algorithm | Ed25519 owner keys become an option with the pkarr channel (P2-28); author keys stay P-256 while the passkey roadmap is live (open question 4) | w2c-06 A2; w2c-03 OQ 5 |

### 10.3 Gates before identity ships

- WebKit in the identity unit and E2E matrix, a Chromium virtual-authenticator PRF test, and a real-device checklist covering iOS Safari (tab, private, Home Screen, Lockdown Mode), Android Chrome and Firefox (P1-13).
- A comprehension test of the key-loss copy and the backup flow with 5-8 people, with targets set before launch (for example the share of identities with two or more posts that saved a backup, and the restore success rate) (P1-14).
