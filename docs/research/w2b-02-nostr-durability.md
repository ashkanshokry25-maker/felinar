# w2b-02 - Nostr relays and Blossom as commodity durable storage for ledger blocks and signaling

- **Topic:** Nostr relays (NIP-01 events, kinds and tags, addressable events, NIP-78, NIP-11, NIP-13, NIP-42, NIP-65, NIP-66, NIP-77) and Blossom blob servers (BUD-01..12) as replaceable, commodity infrastructure for (a) mirroring site-ledger blocks, (b) bootstrapping a ledger when no peer is online, (c) WebRTC signaling, and (d) hosting `.torrent` files, ledger snapshots and web seeds. Includes the signing question (secp256k1 Schnorr vs the ledger's P-256 / Ed25519 keys).
- **Research date:** 2026-10-17. Live probes ran 2026-10-17 20:50Z to 21:50Z from one residential/corporate IP (MacBook Air M3, macOS 27.0, Node 24.22.0, Playwright 1.64.1 = Chromium 156.0.8078.4 and WebKit 27.2). Sources are 2024-2026 unless flagged.
- **Builds on (read, not repeated):** `ARCHITECTURE.md` v0.2 (2026-10-17), `docs/review/DESIGN-REVIEW.md` ("LATER / v2" list: owner-signed checkpoints, negentropy, a Nostr/MQTT second discovery plane; S2 ledger durability floor `cs=`; item 13 `xs=`), `02-wss-trackers.md` F16/F18, `06-browser-chain-vs-crdt.md` F6/F41/F45-F47, `w1-07-prior-art.md` F22 (nsite), `w2b-06-abuse-legal-ops.md` F13, `w2c-02-chain-production-features.md`.
- **Probe scripts and raw results (re-runnable, read-only):** `docs/research/labs/w2b-02-probes/`.
- **Confidence scale:** high = read in a primary source and/or reproduced by me on 2026-10-17; medium = one good source, or inference from consistent evidence; low = anecdotal, vendor claim or my own estimate. Anything I could not verify is marked **unverified**.
- **Design-critical** findings (would change the architecture or a compatibility promise if wrong) are tagged `[DESIGN-CRITICAL]`.
- **Standing constraints I obeyed:** (1) the user's no-outbound rule: I sent **no `EVENT` frames and no uploads** to any relay or Blossom server (reads, `REQ`/`CLOSE`, `OPTIONS`, `HEAD`, small `Range` GETs of public blobs only); (2) the WebSearch budget for this turn was exhausted early, so I did **not** search; every source below is a direct fetch of a named primary source (spec, repo file, package registry, vendor page, live endpoint). Consequence: no academic uptime study was retrieved (see Open questions).

---

## Summary

1. **Verdict.** Public Nostr relays plus Blossom servers are usable as a *durability floor and cold-start path* for the site ledger and as an optional second signaling plane, but only as an **untrusted, lossy, replaceable cache** behind the existing P2P gossip and the owner's host snapshot. They cannot be the ledger's source of truth: nothing about retention, write acceptance or rate limits is guaranteed or even machine-readable. Every block is already self-authenticating (hash, hashcash, signature), which is exactly what makes dumb commodity storage safe to use. `[DESIGN-CRITICAL]`
2. **Ecosystem size and shape (measured).** 14 NIP-66 monitors reported **1,199 relays in a 3.2 h window (1,176 clearnet)**. By advertised policy only 5.4% charge, 3.6% require NIP-42 AUTH, 0.3% require NIP-13 PoW. But about **22% run software built to reject strangers** (Haven 13.9%, pyramid 4.8%, wot-relay 2.5%, zooid 1.2%), 27.5% sit behind Cloudflare, and monitors recorded no write tests at all (0 `rtt-write` tags), so "open" is advertised, not verified.
3. **Relays are volatile; lists rot.** Of the public-relay lists Trystero shipped between Feb 2024 and May 2026, only **38-58% of the relays still answer today** (Feb 2024 list: 38%; Sep 2025: 56%; Mar-May 2026: 54-58%); the freshly pruned 2026-10-04 list is 90% alive. Never hardcode relays in a magnet or pointer; resolve them dynamically (NIP-65 outbox, NIP-66 monitors) and run a repair loop. `[DESIGN-CRITICAL]`
4. **What big open relays store.** damus, nos.lol, primal, offchain.pub, nostr.mom and nostr.bitcoiner.social all serve anonymous reads of kind 30078 / 10063 / nsite kinds from many authors; 24-60% of the storable events in a 5-minute sample are in kinds absent from the NIPs table (custom kinds are not blocked); events up to **77.8 KB (damus)** and **271 KB (primal)** are present; kind 30078 and 10063 events **365-409 days old** exist on all five relays probed; kind-1 history reaches 3 years on strfry defaults (strfry rejects events older than 94,608,000 s by default) and more than 4 years on nostr.mom, nostr.wine, ditto and oxtr. relay.snort.social is an **in-memory LRU relay** (`memlay`) with nothing older than 6 months.
5. **Size limits.** NIP-01 defines none. strfry defaults: `maxEventSize` 65,536 bytes, WebSocket payload 131,072, `maxFilterLimit` 500; nostr-rs-relay default `max_event_bytes` 128 KB. In 81 parsed NIP-11 documents the most common advertised `max_message_length` is 131,072 (25 of 44 that publish one). A v0.2 ledger block (<= 4,096 canonical bytes) becomes a **~1.5 KB typical, ~6 KB worst-case** wrapper event: it fits every relay I found; the practical limits are rate and policy, not size.
6. **Do not use NIP-78 (kind 30078/78) for ledger data.** The current text says these kinds "are not meant to be used as a generic interchange format for data that should be public" and that relays "SHOULD require ... NIP-42 AUTH" and "only serve these events to the authenticated owner". Today 6 of 6 major open relays serve them anonymously; that can change at any release. Claim a dedicated kind. NIP-33 no longer exists as a separate NIP: "addressable events" (30000-39999) live in NIP-01. `[DESIGN-CRITICAL]`
7. **Signing.** Nostr signatures are BIP-340 Schnorr on secp256k1, which **WebCrypto does not support** (tested: `NotSupportedError` in Chromium 156, WebKit 27.2 and Node 24). Schnorr in JS: `@noble/secp256k1` 3.2.0 = **3.6 KB gzip**, but verify runs at only **~640-1,170/s** on an M3 versus **~18-19k/s** for WebCrypto P-256 (15-30x slower; two runs); `nostr-wasm` gets ~5.8-6.6k/s for +~120 KB gzip. Recommendation: **keep the ledger on its own keys and wrap blocks in Nostr events signed by throw-away secp256k1 keys** (option b). Relays verify the outer signature; clients verify only the inner block, so no Schnorr verify cost lands on visitors. Native secp256k1 blocks (option a) would cost 9-21 s of JS verification for a ledger at the 8 MiB cap on an M3 alone. `[DESIGN-CRITICAL]`
8. **Bootstrap economics.** A fresh visitor pulling a full 8 MiB-cap ledger event by event from relays moves ~16-21 MB (before WebSocket deflate; 8/11 probed relays negotiate permessage-deflate); a gzip snapshot of the same ledger is ~3-4 MiB. So: **snapshot first (Blossom/host), relays for the tail and for the pointer to the newest snapshot**. NIP-77 negentropy (reference JS = 3.0 KB gzip) turns a returning visitor's catch-up from 384 KB of IDs into ~34 KB (1,000 missing of 12,000) or ~2.7 KB (50 missing), but gives a fresh visitor nothing, and only about a third of relays (31.9%; not damus, nos.lol or primal) advertise NIP-77.
9. **Silent traps that break a naive client.** `limit` is silently clamped (500 on damus/nos.lol/primal; no EOSE hint, NIP-67 is advertised by 5 of 1,176 relays); strfry write-policy plugins can answer **`OK true` and not store** (`shadowReject`, source-verified), so `OK` is not a durability receipt; `created_at` windows (+900 s future, -3 years past by default); kind allow-lists; scraper rejection; per-IP write rate limits.
10. **Blossom is a good fit for immutable bulk and a bad fit for retention promises.** BUD-01 requires `Access-Control-Allow-Origin: *`, makes Range support a "should", and (new, 2026-04) defines an optional `Sunset` header. Retention is operator policy: the reference server prunes blobs **unaccessed for 1 week (`*`) / 1 month (images)** by default; 24242.io deletes after **60 days unaccessed** (100 MiB cap); blossom.band free uploads are **20 MiB, images/audio/video only**; plans from **$18/yr**. Publish to >= 3 servers, mirror with BUD-04, and keep blobs warm.
11. **CORS/preflight trap (reproduced).** WebTorrent 3.0.21's web-seed fetch sends `Cache-Control` and `user-agent`. Chromium preflights `Cache-Control`; **WebKit (iOS/Safari) also sends `user-agent`**, even for the `xs=` `.torrent` fetch. Servers with wildcard allow-headers (BUD-01 minimum `Authorization, *`) pass; servers with explicit lists fail: live test, 5 of 6 public Blossom servers passed in Chromium (Primal through a 302 to `r2a.primal.net`); `blossom.jumble.social` failed. Fix in our own code: fetch `.torrent`/snapshots ourselves with no custom headers, and strip non-safelisted headers for web seeds. `[DESIGN-CRITICAL]`
12. **Blossom as a web seed.** A BEP-19 web-seed URL is used literally only for **single-file** torrents (`webconn.js`); multi-file torrents need `<base>/<torrent name>/<path>`, which Blossom's flat `/<sha256>` namespace cannot provide. So Blossom serves as `.torrent` host (`xs`, an array fetched in parallel and infohash-checked, i.e. free N-way redundancy), snapshot host (`cs`), and optional single-file bundle web seed; for multi-file sites it needs the SW web-seed adapter of ARCHITECTURE s3.4.7 plus a signed path-to-sha256 manifest (the nsite model). `[DESIGN-CRITICAL]`
13. **Signaling over Nostr works but is not free of cost or privacy.** Trystero 0.26.0 (2026-10-04) uses ephemeral kind `20000 + hash(topic) mod 10000`, tag `x`, 5 relays out of 29 defaults (26 alive today); its Nostr strategy is 27.7 KB gzip. Relays see peer IPs (in SDP) and the room topic; the default SDP encryption key is derivable by the relay operator. A minimal own client (my estimate: ~6-8 KB gzip including noble; not built) feeding `torrent.addPeer(simplePeer)` (verified in `torrent.js`) is the better fit if we ever build the plane.
14. **Abuse and legal.** Relay copies cannot be deleted by the site owner; NIP-09 works only for the signing key, NIP-62 only per pubkey. For moderated ledgers publish to relays **only through an owner-controlled pinner key**, so tombstones and redactions can follow; disclose that relays and blob hosts see IP addresses and the ledger tag.
15. **What I could not test.** Stored-event *write* acceptance, per-IP write limits and OK messages across relays (needs an approved publishing test; a ready plan is in Recommendations R14); Firefox (Playwright's Firefox build fails to start on this macOS); WebKit-to-internet (blocked from this sandbox; local-lab only).

---

## Method and evidence log

What I actually ran (all read-only; scripts in `docs/research/labs/w2b-02-probes/`):

- **Specs read in full from raw GitHub (2026-10-17):** NIP-01, 05 (CORS/redirect rules), 09, 11, 13, 33 (stub), 35, 40, 42, 45, 62, 65, 66, 67, 70, 77, 78, 5A (nsite), B7 (Blossom), the NIPs README (index and kinds table; repo head commit `37db639582`, 2026-10-17T14:37:12Z "NIP-01: clarify that empty filter lists match nothing (#2504)"); Blossom README and BUD-00..12 (repo head `b5bd2801d1`, 2026-06-15).
- **Source/config read:** strfry `strfry.conf`, `docs/negentropy.md`, `docs/plugins.md`, `src/apps/relay/RelayWriter.cpp` and `RelayServer.h`; nostr-rs-relay `config.toml`; Damus `noteguard` README; memlay, Haven, wot-relay, pyramid, zooid READMEs; `hzrd149/blossom-server` README + `config.example.yml`; route96, nsite-gateway, nsyte READMEs; `hoytech/negentropy` README and `js/Negentropy.js`; Trystero `packages/nostr/src/index.ts`, README, CHANGELOG and `src/nostr.js` at tags 0.18.0 to 0.25.0; webtorrent 3.0.21 `lib/webconn.js` and `lib/torrent.js` (installed copy); WHATWG Fetch Standard (living, fetched 2026-10-17).
- **NIP-66 census:** paged `kind 30166` from `relay.nostr.watch` (12 pages x <= 1,000 events = 7,929 events, newest 3 minutes and oldest 3.2 h old; 14 monitor pubkeys; 1,199 relay rows).
- **NIP-11 sweep:** HTTPS `GET` with `Accept: application/nostr+json` on 92 hosts (39 well-known + 53 sampled across software families from the census; suspicious TLDs excluded): 81 parsed, 10 errors, 1 non-JSON.
- **Retention and kind probes:** `REQ` with `until` at 6 mo / 1 / 2 / 3 / 4 years (kind 1) on 12 relays; per-kind probes (30078, 10063, 15128, 35128, 5128, 2003) on 6 relays; a 5-minute sample of all kinds on 5 relays; `until`-pagination tests; NIP-65/BUD-03 resolution on 8 relays; WebSocket upgrade with `permessage-deflate` on 11 relays.
- **List rot:** recovered the default Nostr relay lists of 11 Trystero releases and tested every unique host (141) today with a WebSocket upgrade and an NIP-11 GET.
- **Blossom:** kind-10063 server lists of 337 distinct authors (sampled from 6 relays) for a usage census; for 12 servers `OPTIONS` preflight, `GET Range` on real public blobs taken from nsite manifests, `HEAD /upload` (dummy hash/size, no body); real-browser (Chromium 156) fetches of the same blobs with WebTorrent's exact options; a local CORS lab in Chromium and WebKit.
- **Measurements:** Schnorr and WebCrypto throughput (Node 24, M3); esbuild bundle sizes; Negentropy simulation with the reference JS; block-to-event size model using the project's real `canonicalize()` and the v0.2 block shape; PoW mean work.
- **Load placed on third parties:** roughly 330 short HTTPS GETs / WebSocket upgrades to ~230 relay hosts, ~130 single-`REQ` read sessions (mostly <= 100 events; about 50 of them to relay.damus.io, see F9), 12 Blossom servers x <= 6 small requests. **Zero** `EVENT` frames, `PUT`, `POST` or uploads.
- **Not tested:** any write; per-IP rate limits; relay behavior under load; multi-day uptime (one snapshot only); Firefox; WebKit over the internet; real phones; whether any relay honors NIP-40 expiry for our canary design.

### Source key (full URLs in "Sources read" at the end)

`N01..N78, N5A, NB7, NR` = NIP files (raw GitHub); `B01..B12, B-R` = Blossom BUDs; `SF-C/N/P/W` = strfry conf/docs/source; `NRR` = nostr-rs-relay config; `NG` = noteguard; `MEM, HV, WOT, PYR, ZOO` = relay READMEs; `BS` = blossom-server; `R96, NSG, NSY` = route96 / nsite-gateway / nsyte; `NEG` = negentropy; `TR-N/R/C/H` = Trystero source/README/CHANGELOG/history; `NPM` = npm registry JSON; `FETCH` = Fetch Standard; `WT` = installed webtorrent 3.0.21; `PG` = vendor pages; `BTC` = Coinbase spot; `LIVE` = my probes; `PROJ` = project docs.

---

## Findings

### A. Protocol layer

### F1. NIP-01: event format, kind ranges, tag indexing, filters `[DESIGN-CRITICAL]`

**Claim.** A Nostr event is `{id, pubkey, created_at, kind, tags, content, sig}`; `id` = SHA-256 of the UTF-8 JSON array `[0, pubkey, created_at, kind, tags, content]` with a fixed escaping rule; `sig` = BIP-340 Schnorr over secp256k1. The kind number decides storage semantics, and the spec sets **no maximum event size**.
- Ranges (NIP-01, verbatim logic): regular `1000 <= n < 10000 || 4 <= n < 45 || n == 1 || n == 2` ("expected to be stored by relays"); replaceable `10000 <= n < 20000 || n == 0 || n == 3` (latest per pubkey+kind); ephemeral `20000 <= n < 30000` ("not expected to be stored"); **addressable `30000 <= n < 40000`** (latest per kind+pubkey+`d` tag). Same-timestamp ties: lowest id wins. NIP-33 ("Parameterized Replaceable Events") is now a `final` stub: "Renamed to 'Addressable events' and moved to NIP-01"; it is not even listed in the NIPs index.
- Tag indexing: "all single-letter (only english alphabet letters: a-z, A-Z) key tags are expected to be indexed by relays ... Only the first value in any given tag is indexed." So `["t", ledgerId]`, `["x", blockHash]`, `["d", ...]` are queryable as `#t`, `#x`, `#d`; multi-letter tags (`nonce`, `server`) are not.
- Filters: `ids`, `authors`, `#e`, `#p` "MUST contain exact 64-character lowercase hex values" (prefix matching is gone); an empty list matches nothing (clarified in the repo head commit of 2026-10-17); `limit` applies to the initial query only, newest first, ties by lowest id; `limit: 0` returns no stored events.
- `OK`/`CLOSED` prefixes: `duplicate`, `pow`, `blocked`, `rate-limited`, `invalid`, `restricted`, `mute`, `error` (NIP-42 adds `auth-required`).
- Serialization: only `\n \" \\ \r \t \b \f` are escaped in `content`; "all other characters must be included verbatim". Consequence for us: a `content` that can carry arbitrary Unicode (guestbook text, emoji, U+2028, lone surrogates) is a place where two implementations can compute different ids. **Base64url `content` removes the ambiguity** (F20).

**Confidence:** high. **Sources:** N01, N33, NR (index + kinds table), repo commit list. **Date:** read 2026-10-17 (repo head 2026-10-17T14:37:12Z).

### F2. NIP-78 (kind 30078 / 78) is the wrong container; use a dedicated kind `[DESIGN-CRITICAL]`

**Claim.** NIP-78 exists for "remoteStorage-like capabilities for custom applications that do not care about interoperability" and, in its current text, tells relays to gate it: "These kinds are not meant to be used as a generic interchange format for data that should be public or exchanged between different applications"; "relays SHOULD require clients to perform the NIP-42 AUTH flow before accepting or serving kind 78 and kind 30078 events, and SHOULD only serve these events to the authenticated owner".
- Live today: all 6 open relays probed (damus, nos.lol, primal, offchain.pub, nostr.mom, nostr.bitcoiner.social) **return 100 kind-30078 events to an unauthenticated `REQ`** (61-77 distinct authors per sample, up to 22,356 bytes). So the SHOULD is not implemented where it matters yet; an update of any of these relays could change that. Only 17 of 1,176 census relays even advertise NIP-78.
- A shared, public, multi-writer ledger is exactly the "interchange" case the NIP warns against. Use a dedicated regular kind for blocks and a dedicated addressable kind for checkpoints; register them (the process is a PR to `nostr-protocol/nips`; timeline unverified). Candidate numbers must be checked against the machine-readable registry at claim time: my placeholder 30311 turned out to be taken (NIP-53), and unregistered kinds seen in the wild include 7368, 4333, 9413, 3434, 37195, 38501.

**Confidence:** high (spec + live). **Sources:** N78, N01, NR, LIVE (kindprobe). **Date:** 2026-10-17.

### F3. NIP-11: what a relay tells you, and what it does not

**Claim.** The relay information document gives advisory limits; it has no retention field and is self-reported.
- Current `limitation` keys: `max_message_length`, `max_subscriptions`, `max_subid_length`, `max_limit` ("the relay server will clamp each filter's `limit` value ... typically done silently"), `max_event_tags`, `max_content_length` (characters), `min_pow_difficulty`, `auth_required`, `payment_required`, `restricted_writes`, `created_at_lower_limit`, `created_at_upper_limit`, `default_limit`. `max_message_length` "effectively limits the maximum size of any event". Older drafts had `retention`; **the current spec has none and 0 of 81 live documents carried one**, so retention is not machine-readable anywhere I looked.
- "Relays MUST accept CORS requests": 80 of 81 parsed documents sent `Access-Control-Allow-Origin: *`, so a browser can read NIP-11 directly (the `Accept: application/nostr+json` header is CORS-safelisted by the Fetch rule: no unsafe bytes in the value; not browser-tested here).
- NIP-66 itself warns the document "MAY contradict actual values if monitors find that a different policy is implemented than is advertised."

**Confidence:** high. **Sources:** N11, N66, LIVE (nip11sweep), FETCH. **Date:** 2026-10-17.

### F4. NIP-13 proof of work: real, tiny adoption, different preimage from our Hashcash

**Claim.** NIP-13 difficulty is the number of leading zero bits of the NIP-01 id; the miner varies `["nonce", "<n>", "<target>"]` and should commit the target in the third element; because "the NIP-01 note id does not commit to any signature, PoW can be outsourced" (delegated PoW).
- Adoption: `min_pow_difficulty` is 0 in the 9 documents that set it and absent in 72; the census shows **4 of 1,176 relays (0.3%)** requiring PoW. PoW is not a practical gate on public relays today.
- The ledger's `h` hashes `canonical(e)` (ARCHITECTURE s6.1), not the Nostr serialization, so the ledger's 16-bit hashcash cannot double as NIP-13 unless block == event (option a, F19). With a wrapper, mining the wrapper id is separate and only needed for the rare PoW relay.
- Mean work is 2^bits hashes by construction (16,384 / 65,536 / 262,144 for 14 / 16 / 18 bits). Measured (`node:crypto` SHA-256, ~700-byte preimage, random content, two runs of 12-200 repetitions): 14 bits = 13.1k-16.3k hashes (19.6-23.2 ms), 16 bits = 57.0k-72.2k (85-172 ms), 18 bits = 204k-232k (334-341 ms), i.e. 420-720 kH/s on an M3 depending on machine load. Reference only: browser rates are lower and phones lower again (see `06` F-series and `w2c-02`).

**Confidence:** high. **Sources:** N13, LIVE (powmean), PROJ (ARCHITECTURE s6.1). **Date:** 2026-10-17.

### F5. Deletion, expiry, protected events, AUTH and vanish: what the owner can and cannot undo

**Claim.** Nothing in Nostr lets a *site owner* remove another author's event from a relay.
- NIP-09 (kind 5): relays "SHOULD delete or stop publishing any referenced events that have an identical `pubkey` as the deletion request"; "Relays can not, in general, perform this validation and should not be treated as authoritative." Only the signing key can delete.
- NIP-62 (kind 62, "Request to Vanish"): relays "MUST fully delete any events from the `.pubkey`" if their URL is tagged (or `ALL_RELAYS`), "MUST ensure the deleted events cannot be re-broadcasted", and paid/restricted relays must comply too. Per pubkey, so useless against ephemeral wrapper keys that nobody keeps.
- NIP-40 `expiration`: relays "MAY NOT delete expired messages immediately and MAY persist them indefinitely"; "don't consider expiring messages as a security feature". Advertised by 934 of 1,176 census relays (79.4%).
- NIP-70 `["-"]` protected events: "The default behavior of a relay MUST be to reject any event that contains `["-"]`"; accepted only from the authenticated author. **Never tag ledger events `-`**: it would forbid exactly the third-party mirroring this design relies on.
- NIP-42 AUTH (kind 22242) adds `auth-required:` and `restricted:` prefixes; 42 of 1,176 relays (3.6%) require it for something.

**Confidence:** high. **Sources:** N09, N62, N40, N70, N42, LIVE (census). **Date:** 2026-10-17.

### F6. Discovery and sync primitives: NIP-65, NIP-66, NIP-67, NIP-45, NIP-77 `[DESIGN-CRITICAL]`

**Claim.** The protocol already contains what a client needs to find relays, count and sync events, but most relays implement only part of it.
- **NIP-65 (outbox):** kind 10002 `r` tags with optional `read`/`write`; "Clients SHOULD guide users to keep `kind:10002` lists small (2-4 relays of each category)" and spread them to indexer relays. Live resolution works: for a well-known pubkey, 7 of 8 relays returned its kind-10002 list in **192-692 ms** (connect + query), `purplepag.es` also returned the BUD-03 list (kind 10063); only `user.kindpag.es` returned nothing.
- **NIP-66:** kind 30166 relay-discovery events (tags `rtt-open/read/write`, `n`, `N` supported NIPs, `R` requirements `auth/writes/pow/payment` with `!` for false, `k` accepted kinds) published by monitors announced with kind 10166. Risk text: "Clients MUST NOT require `30166` events to function ... Clients SHOULD NOT trust a single source". In practice `k` appears on 2 of 1,176 relays, so *kind acceptance cannot be discovered* from monitors, and no `rtt-write` tag exists in the 7,929 events.
- **NIP-67:** `["EOSE", subId, ["finish"|"more"|"auth"]]` tells a client whether it has everything; advertised by **5 of 1,176** relays; the EOSE hint was absent in all 29 census and pagination queries where I recorded it.
- **NIP-45 `COUNT`:** advertised by 46.3% of census relays and by damus, nos.lol, primal, nostr.mom, offchain.pub (per NIP-11); strfry caps it at `maxFilterLimitCount = 1000000`. Good for health checks ("how many blocks do you hold for ledger L").
- **NIP-77 negentropy:** client sends `NEG-OPEN <sub> <filter> <hex msg>`; messages are hex-encoded Negentropy v1 (range-based set reconciliation, 16-byte fingerprints). strfry ships it enabled (`negentropy.enabled = true`, `maxSyncEvents = 1000000`). Advertised by **375 of 1,176 (31.9%)** census relays and 34 of 81 NIP-11 documents, including offchain.pub, nostr.bitcoiner.social, nostr.oxtr.dev, purplepag.es, relay.ditto.pub, nostr21.com, **but not relay.damus.io, nos.lol, relay.primal.net or nostr.mom**.

**Confidence:** high (specs + live). **Sources:** N65, N66, N67, N45, N77, SF-C, SF-N, LIVE (outbox, census, nip11sweep). **Date:** 2026-10-17.

### B. Ecosystem and reliability

### F7. Census of the relay network (NIP-66, 14 monitors, 3.2 h window) `[DESIGN-CRITICAL for relay-selection assumptions]`

**Claim.** The network is large, mostly open by advertisement, concentrated in a few software stacks and hosts, and a fifth of it is closed by design.

| Measure (clearnet relays = 1,176; 23 more on tor/i2p/other) | Value |
|---|---|
| Events read / monitors / distinct relay URLs | 7,929 / 14 / 1,199 |
| No auth, payment, PoW or restricted-write tag | 1,083 (92.1%) |
| Payment tag / AUTH tag / PoW tag / restricted-writes tag | 64 (5.4%) / 42 (3.6%) / 4 (0.3%) / 1 |
| Software (NIP-66 `s` tag) | strfry 324 (27.6%); nostr-rs-relay 206 (17.5%); Haven 164 (13.9%); pyramid 57 (4.8%); khatru-based 55 (4.7%); nostream 34 (2.9%); wot-relay 29 (2.5%); zooid 14 (1.2%); rnostr 12; NFDB 9; ditto 7; memlay 3; unknown or other 257 (21.9%) |
| Designed to reject strangers (Haven + pyramid + wot-relay + zooid) | 264 (22.4%) |
| Hosting (NIP-66 `host.as` / `host.isp`) | Cloudflare 323 (27.5%); Hetzner ~120 (10%); DigitalOcean 61; netcup 52; Contabo 87; Akamai 42; OVH 38 |
| NIP support advertised (count of 1,176) | NIP-11 89.8% (1,056); NIP-40 79.4% (934); NIP-70 55.4% (652); NIP-45 46.3% (545); NIP-42 46.0% (541); **NIP-77 31.9% (375)**; NIP-86 33.2% (391); NIP-62 3.3% (39); NIP-78 1.4% (17); NIP-67 0.4% (5) |
| `rtt-open` (freshest event per relay: median / p90) | 611 ms / 1,383 ms (monitor locations not published) |
| `rtt-write` tags | **0** |

- Why "closed by design": Haven's README: outbox "Only the owner and whitelisted npubs can send to this relay, but anyone can read", inbox accepts only "notes where the owner or whitelisted npubs are tagged"; pyramid: "only members can publish"; wot-relay "saves all the notes that people you follow, and people they follow are posting"; zooid "implements a range of access controls". A random throw-away key will be rejected there.
- Caveats: one 3.2 h window (no uptime history); `R` tags are derived from NIP-11, not from write tests; no relay was reported by more than 11 of the 14 monitors (and most by 5-9), an artifact of monitor sharding rather than availability, so I did not use "monitors per relay" as a reachability measure; I do not know whether monitors publish for relays they cannot reach.

**Confidence:** high for counts, medium for interpretation. **Sources:** N66, HV, PYR, WOT, ZOO, LIVE (census66/agg66). **Date:** 2026-10-17 20:55-21:05Z.

### F8. NIP-11 limits actually advertised (81 documents parsed of 92 hosts; non-random sample)

**Claim.** There is no single limit set; 64 KiB-class event caps and 500-event page caps are the common floor.

| Field | Distribution (of 81) |
|---|---|
| `max_message_length` | absent 37; **131,072: 25**; 524,288: 8; 1,000,000: 2 (damus, primal); 65,535: 2 (nostr.land, eden.nostr.land); 4,000,000: 2 (Ditto); 262,200 / 262,144 / 1,310,720: 1 each; 20,000 and 10,000: 1 each (pyramid) |
| `max_limit` | absent 38; **500: 28**; 5,000: 8; 1,000: 4; 10,000 / 3,000 / 501: 1 each |
| `max_subscriptions` | 20: 17; 200: 11; 50: 6; 10: 4; others 1-2 each; absent 36 |
| `max_content_length` | absent 73; 102,400: 3; 131,072: 2; 65,536: 2; 262,140: 1 |
| `created_at_upper_limit` / `lower_limit` | upper: 900 s in 7, 300 s in 2, 0 in 7; lower: 94,608,000 s (3 years) in 2 (nostr.wine, nostr21), 0 in 12 |
| `payment_required` / `restricted_writes` / `auth_required` | 9 / 18 / 2 |
| `min_pow_difficulty` > 0 | 0 |
| `terms_of_service` present | 10 |
| Supported-NIPs lists present | 77 of 81; NIP-40 66, NIP-70 52, NIP-45 39, NIP-77 34, NIP-42 31, NIP-86 22, NIP-62 2 |

Named relays (live NIP-11): **relay.damus.io** strfry 1.1.0-158, `max_limit` 500, `max_message_length` 1,000,000, `max_subscriptions` 200; **nos.lol** strfry 1.1.3, 500 / 131,072 / 20, terms link, "Generally accepts notes, except spammy ones."; **relay.primal.net** strfry 1.1.3, 500 / 1,000,000 / 20; **nostr.wine** v0.3.3, admission 18,888,000 msats, 524,288 / `max_limit` 1,000 / subs 50, `created_at` window +300 s / -94,608,000 s, `payment_required` + `restricted_writes`; **nostr21.com** strfry, admission 21,000 msats, NIP-77, `max_limit` 10,000, +900 s; **relay.orangepill.dev** nostream 3.0.0, 3,000,000 msats per 2,592,000 s, `max_content_length` 102,400; **relay.snort.social** `v0l/memlay` 0.2.0 ("High-performance in-memory Nostr relay", `idle_timeout` 10, `max_limit` 5,000); **relay.ditto.pub** Ditto 2.3.0, 4,000,000, NIPs incl. 62 and 77, +900 s.

**Confidence:** high for the sample; medium for generalization (39 hosts were hand-picked well-known relays). **Sources:** N11, LIVE (nip11sweep). **Date:** 2026-10-17.

### F9. Defaults of the two dominant engines, and the policy layer on top `[DESIGN-CRITICAL]`

**Claim.** strfry (27.6% of relays, all three biggest public ones) and nostr-rs-relay (17.5%) ship limits that a ledger wrapper event satisfies by a wide margin, but both have operator hooks that silently change behavior.
- **strfry** `strfry.conf` (master): `events.maxEventSize = 65536` ("Maximum size of normalised JSON, in bytes"), `rejectEventsNewerThanSeconds = 900`, **`rejectEventsOlderThanSeconds = 94608000` (3 years)**, `rejectEphemeralEventsOlderThanSeconds = 60`, `ephemeralEventsLifetimeSeconds = 300`, `maxNumTags = 2000`, `maxTagValSize = 1024`; `relay.maxWebsocketPayloadSize = 131072`, `maxReqFilterSize = 200`, `autoPingSeconds = 55`, `maxFilterLimit = 500`, `maxTagsPerFilter = 3`, `maxSubsPerConnection = 200`; optional `filterValidation` (`maxKindsPerFilter = 3`, `allowedKinds`, default off); `writePolicy.plugin` (stdin/stdout JSON, actions `accept | reject | shadowReject`); negentropy on by default. Damus evidently raised the event cap (a 77,829-byte kind-38422 event is stored there).
- **nostr-rs-relay** `config.toml`: `max_event_bytes` "Defaults to 128 KB", `max_ws_message_bytes` 128 KB, `reject_future_seconds = 1800` in the sample (default "is to allow any date"), `messages_per_sec` unset = unlimited ("Limiting event creation is highly recommended if your relay is public!"), `event_kind_allowlist` / `_blacklist`, `pubkey_whitelist`, `nip42_auth`, `limit_scrapers` ("Rejects imprecise requests (kind only and author only etc)"), optional NIP-05 verification of authors (`[verified_users]`).
- **Rate limiting plugin from Damus's org (`noteguard`):** per-IP `posts_per_minute` (README sample **8**), optional `ban_after` consecutive violations with `ban_duration_secs` default 3,600 and optional Cloudflare WAF IP-list escalation; pipeline order `protected_events`, `kinds`, `whitelist`, `ratelimit`. The production values on relay.damus.io are **not published (unverified)**; the sample is not evidence of them.
- Observation (cause unverified): after roughly 50 short WebSocket sessions from my IP to relay.damus.io over about 65 minutes, at about 21:46Z it began answering WebSocket upgrades with **HTTP 503 from Cloudflare** (two attempts 20 s apart) while its NIP-11 `GET` kept returning 200 and other relays kept working; by 21:48:38Z the upgrade worked again. It may be a transient outage or a short per-IP connection throttle; either way a client that reconnects aggressively can be refused by a big relay for minutes.
- Consequence: assume a visitor behind carrier-grade NAT shares an IP-keyed budget of single-digit events per minute with strangers. Publish rarely, batch via the pinner, and treat `rate-limited:` as normal (Trystero backs off exponentially up to 15 minutes).

**Confidence:** high (config files), low for production rate numbers. **Sources:** SF-C, SF-P, NRR, NG, TR-N. **Date:** 2026-10-17.

### F10. Retention, measured `[DESIGN-CRITICAL]`

**Claim.** The big public relays retain old events for years but with relay-specific horizons; at least one large relay is volatile by design; per-kind policy can differ.
- **Kind 1 (`until` cutoff, newest event found at or before it):**

| Relay | -6 mo | -1 y | -2 y | -3 y | -4 y |
|---|---|---|---|---|---|
| relay.damus.io | 2026-04-16 | 2025-10-16 | 2024-10-11 | 2023-10-15 | none |
| nos.lol, relay.primal.net, offchain.pub | yes | yes | yes | 2023-10-16 | none |
| nostr21.com | yes | yes | yes | 2023-10-16 | none |
| nostr.mom | yes | yes | yes | 2023-10-16 | **2022-10-11** |
| nostr.wine (paid) | yes | yes | yes | 2023-10-17 | **2022-10-16** |
| relay.ditto.pub, nostr.oxtr.dev | yes | yes | yes | 2023-10-16 | **2022-10-16/17** |
| nostr.bitcoiner.social | yes | 2025-10-11 | 2024-10-08 | none | none |
| relay.snort.social (memlay) | **none** | none | none | none | none |
| relay.nostr.band | timeouts on all 5 queries (single vantage; cause unknown) | | | | |

  "none" means no such old event exists, not proof of a purge policy. The 3-year cliff on damus/nos.lol/primal/offchain/nostr21 matches strfry's default write-time `rejectEventsOlderThanSeconds = 94608000`: **an event whose `created_at` is older than 3 years cannot be (re)published to a default strfry relay**, so a wrapper must carry `created_at = now`, never the block's `ts` (F20).
- **Custom replaceable kinds:** kind 30078 and kind 10063 events aged **365-409 days** exist on all five relays checked (damus 373.9 / 396.3 d; nos.lol 373.9 / 366.5; primal 365.2 / 366.6; offchain.pub 409.4 / 368.6; nostr.mom 365.0 / 368.2). These survive only because nobody replaced them; this says custom kinds are not purged early, nothing more.
- **memlay** (relay.snort.social's engine) README: "In-memory event storage with LRU eviction", optional disk persistence. Never count it as durable.
- Blossom retention is separate and harsher (F29).

**Confidence:** high for the lower bounds measured; unknown for upper bounds and for any operator's future policy. **Sources:** SF-C, MEM, LIVE (retention, kindret). **Date:** 2026-10-17.

### F11. List rot: public relay lists lose 40-60% of their members within months `[DESIGN-CRITICAL]`

**Claim.** Even curated relay lists decay fast. I recovered the default Nostr relay list of 11 Trystero releases (git tags) and tested every host today (WebSocket upgrade and NIP-11 agree for every host except 2 in the 0.23.0 list and 1 in the 0.24.0/0.25.0 lists, which answered NIP-11 but not the upgrade):

| Trystero release | Released | Age today | Relays in list | Still answering today |
|---|---|---|---|---|
| 0.18.0 | 2024-02-17 | 32 mo | 16 | 6 (38%) |
| 0.19.0 | 2024-07-09 | 27 mo | 18 | 8 (44%) |
| 0.20.0 | 2024-07-27 | 27 mo | 17 | 8 (47%) |
| 0.20.1 | 2025-02-15 | 20 mo | 25 | 13 (52%) |
| 0.21.0 | 2025-03-26 | 19 mo | 25 | 13 (52%) |
| 0.21.8 | 2025-09-03 | 13.5 mo | 18 | 10 (56%) |
| 0.22.0 | 2025-10-11 | 12 mo | 18 | 10 (56%) |
| 0.23.0 | 2026-03-23 | 7 mo | 82 | 44 WS / 46 NIP-11 (54-56%) |
| 0.24.0 / 0.25.0 | 2026-04-27 / 05-23 | 5.7 / 4.8 mo | 55 | 32 WS / 33 NIP-11 (58-60%) |
| **0.26.0** | **2026-10-04** | 0.4 mo | 29 | **26 (90%)** after pruning |

- Caveats: lists contain relays that may already have been dead at release (no historical snapshot to separate them); one vantage point; "answering" is not "accepting writes". The pattern (about 40-45% gone within 5-7 months for an un-pruned list; ~60% within 2.7 years) is still the right planning number. Trystero's CHANGELOG records relay-list pruning or updates in 0.20.1, 0.21.8, 0.23.0 ("Removed dead default relays"), 0.25.4 and 0.26.0.
- Durability arithmetic (independence assumed, which hosting concentration makes optimistic): if a relay survives 13 months with p = 0.56, the chance that **all** of N independent copies are gone is 0.44^N = 8.5% (N=3), 1.6% (N=5), 0.14% (N=8). At 32 months (p = 0.38) with N=5 it is 9.2%. A pinner that re-mirrors to fresh relays turns this from a decay into a maintenance task; without one, relay copies are a best-effort cache.

**Confidence:** medium (method limits above). **Sources:** TR-H (tags 0.18.0-0.25.0 `src/nostr.js`, 0.26.0 `packages/nostr/src/index.ts`), TR-C, NPM (release dates), LIVE (listrot). **Date:** 2026-10-17.

### F12. Open relays store custom kinds and large events

**Claim.** Kinds outside the NIP table and events well above 64 KiB are accepted and kept by the biggest relays.
- 5-minute all-kinds sample, non-ephemeral events only: share in kinds **absent from the NIPs README table**: damus 59.9% (257 of 429), nos.lol 35.7% (105 of 294), primal 23.6% (26 of 110), nostr.mom 53.3% (89 of 167), offchain.pub 60.1% (184 of 306). The README table is not the full registry, so this shows *no table-based gating*, not that those kinds are unregistered everywhere.
- Largest stored events seen: damus 77,829 B (kind 38422), primal 271,325 B (kind 5128), 264,340 B (35128), 198,988 B (15128); nos.lol 64,012 B (35128); damus nsite manifests up to 153,304 B.
- nsite kinds 15128 (root) and 35128 (named) are stored by all six relays and 5128 (snapshot) by five of six (none seen on damus); kind 2003 (torrents, NIP-35) is stored by nos.lol, primal, nostr.mom (oldest 2023-12-03) and nostr.bitcoiner.social, none seen on damus or offchain.pub.

**Confidence:** high (sample), medium for generalization. **Sources:** NR, N5A, N35, LIVE (kindprobe, kindmix). **Date:** 2026-10-17.

### F13. `limit` is clamped silently and EOSE gives no completeness hint `[DESIGN-CRITICAL]`

**Claim.** A client that asks for `limit: 1000` and stops when it receives fewer than 1000 events will believe it is finished after the first page on most big relays.
- Measured with `limit: 1000`, kind 30078: nos.lol, relay.primal.net and offchain.pub returned **500 per page** with no `EOSE` hint (`eose_hint` null on every query); damus returned 466 then 5 then 1 (a small, hot set). relay.damus.io also clamped the census query to 500; relay.nostr.watch allowed 1,000.
- `until = oldest created_at` (inclusive) works: each following page returned 499 new of 500, one duplicate from the boundary second. If more events share one second than the page size, an `until` loop stalls (new = 0) and silently skips events.
- NIP-67 hints (`finish`/`more`) would fix this but 5 of 1,176 relays advertise it.
- Algorithm that survives this: take the page size from NIP-11 `max_limit` when present, else assume 500; continue until a page yields **zero new ids**, not until it returns fewer than requested; detect same-second saturation (page full and all new events share the boundary second) and switch to narrower filters (`#x` id batches, `since/until` slicing) or negentropy.

**Confidence:** high. **Sources:** N01, N11, N67, LIVE (pagetest). **Date:** 2026-10-17.

### F14. `OK true` is not a durability receipt (strfry `shadowReject`) `[DESIGN-CRITICAL]`

**Claim.** A relay can acknowledge an event it did not store.
- strfry `src/apps/relay/RelayWriter.cpp`: only `Accept` results are appended to the list of events to write; for any other plugin result the code calls `sendOKResponse(msg->connId, eventIdHex, res == PluginEventSifterResult::ShadowReject, okMsg)`, and `RelayServer.h` defines `sendOKResponse(..., bool written, ...)` building `["OK", id, written, message]`. So **`shadowReject` produces `["OK", id, true, ...]` and the event is dropped**. `docs/plugins.md` lists the actions `accept`, `reject`, `shadowReject`.
- NIP-01 also defines the `mute` prefix for ignored events and `duplicate` for repeats (both can arrive with `true` or `false`).
- Consequence: durability is established only by read-back (`REQ {"ids":[id]}` or `#x`) after a delay, per relay, and by a periodic COUNT/NEG coverage check. Treat `OK false` prefixes `blocked|restricted|auth-required|pow` as terminal for that relay (Trystero retires such relays) and `rate-limited` as a backoff signal.

**Confidence:** high (source read). **Sources:** SF-W, SF-S, SF-P, N01, TR-N. **Date:** 2026-10-17.

### F15. Paid relays: prices, what they buy

**Claim.** Paid access is cheap but buys a write-acceptance policy, not a retention guarantee.
- Spot BTC/USD on 2026-10-17 21:20Z: **$81,507** (Coinbase), so 1 sat is about $0.000815. nostr.wine admission 18,888 sats ~ **$15.40** one time (3-year `created_at` floor, +300 s ceiling); nostr21.com admission 21 sats ~ **$0.017**; relay.orangepill.dev 3,000 sats per 30 days ~ **$2.45/month**; nostr.build plans (which include a personal relay with "unlimited events with no expiry" and a Blossom subdomain) $18 / $69 / $120 / $240 per year for 5 / 25 / 100 / 500 GB. 9 of 81 sampled relays set `payment_required`.
- A paid relay is the only commodity option where an owner can have the pinner key accepted predictably; it still gives no SLA, and a payment disappears with the operator. NIP-62 obliges paid relays to honor vanish requests.

**Confidence:** high for prices on the date; BTC conversion is a snapshot. **Sources:** N11, BTC, PG (nostr.build plans, blossom.band), LIVE (nip11sweep). **Date:** 2026-10-17.

### C. Signing and libraries

### F16. WebCrypto cannot do secp256k1, so Nostr signatures are JS or WASM `[DESIGN-CRITICAL]`

**Claim.** Nostr events are signed with BIP-340 Schnorr on secp256k1 (NIP-01), and no engine I tested exposes that curve through `crypto.subtle`.
- Test: `crypto.subtle.generateKey({name:'ECDSA'|'ECDH', namedCurve:'secp256k1'})` throws `NotSupportedError` in **Chromium 156.0.8078.4, WebKit 27.2 and Node 24.22.0**; the same calls for `ECDSA P-256` and `Ed25519` succeed in all three. (Firefox could not be launched here, F36.)
- Consequences: (1) v0.2's identity (a non-extractable P-256 `CryptoKey` kept in IndexedDB) cannot hold a Nostr key; (2) a Nostr secret key in a browser is raw bytes in JS memory, acceptable only for throw-away keys; (3) every Schnorr verification in a client is JS or WASM (F18). Whether WebAuthn authenticators can sign secp256k1 is **unverified** and not needed for this design.

**Confidence:** high. **Sources:** LIVE (webcrypto_curves), N01, PROJ (`06` F45-F47). **Date:** 2026-10-17.

### F17. Libraries: versions, licences, measured bundle sizes

| Package (npm `latest`, date) | Notes | Bundle I measured (esbuild 0.28.2, minified, ES2020): min / gzip / brotli |
|---|---|---|
| `@noble/secp256k1` **3.2.0** (2026-08-30) | zero deps; README "4.8KB (gzipped)" for the whole lib; Schnorr `signAsync`/`verifyAsync` use WebCrypto SHA-256 | Schnorr only: **7.7 KB / 3.6 KB / 3.3 KB** |
| `@noble/curves` **2.4.0** (2026-08-27) | dep `@noble/hashes` 2.4.0; faster (precomputes) | `schnorr` sign+verify: 33.3 KB / 13.2 KB / 11.7 KB |
| `@noble/hashes` 2.4.0 (2026-08-27) | | `sha256`: 5.8 KB / 2.8 KB / 2.4 KB |
| `nostr-tools` **2.25.2** (2026-09-04), Unlicense | deps pinned: `@noble/curves` 2.0.1, `@noble/hashes` 2.0.1, `@noble/ciphers` 2.1.1, `@scure/base` 2.0.0, `@scure/bip32` and `bip39` 2.0.1, `nostr-wasm` 0.1.0; 5.4 MB unpacked | `/pure` (keys, `finalizeEvent`, `verifyEvent`): 27.2 KB / 11.3 KB / 10.0 KB; `/pool` + pure: 46.6 / **16.7** / 14.8; `/relay` + `/nip13` + pure: 40.8 / 15.0 / 13.3; `/wasm` path: 294 KB / **119.8 KB** / 100.7 |
| `nostr-wasm` 0.1.0 (2023-12-22) | libsecp256k1 verify in WASM; no release in 2.8 years | (counted in the `/wasm` row) |
| `@trystero-p2p/nostr` **0.26.0** (2026-10-04) | deps `@noble/secp256k1` ^3.2.0, `@trystero-p2p/core`; `trystero` 0.26.0 is a one-line wrapper of it | Nostr strategy: 75.6 KB / **27.7 KB** / 25.1; torrent strategy: 65.3 / 23.3 / 21.0 |
| `blossom-client-sdk` 5.1.0 (2026-08-20) | dep `@noble/hashes` ^1.8.0 | not measured |
| `applesauce-relay` 6.2.1 (2026-06-29), `@nostr-dev-kit/ndk` 3.0.3 (2026-02-23), `nostr-idb` 5.1.0 (2026-07-10) | not evaluated | not measured |
| Negentropy reference JS (`hoytech/negentropy/js/Negentropy.js`) | single file, no deps, WebCrypto SHA-256; npm `negentropy` is `0.0.0` (2023), not a maintained client | 7.8 KB / **3.0 KB** / 2.7 KB |

- Audit status (from the library's own README): `@noble/secp256k1` v3 "has not been independently audited. It is a rewrite of v1, which has been audited by cure53 in Apr 2021"; it points to `noble-curves` as the audited sister project. Releases use signed commits and npm provenance. The ledger already plans `@noble/hashes` and `@noble/ed25519` as fallbacks (`06` F49), so one more noble dependency is consistent with the supply-chain policy (pin versions, `ignore-scripts`, `build.lock.json`).
- `nostr-tools` is the right tool for **Node tooling** (publisher, pinner). For the browser I would not ship it wholesale: the pool client alone is 16.7 KB gzip, versus a hand-written relay client of a few hundred lines plus 3.6 KB for the signature.

**Confidence:** high (registry JSON + my builds). **Sources:** NPM, LIVE (bundle sizes), NEG, TR-N. **Date:** 2026-10-17.

### F18. Measured signature throughput and what it costs at ledger scale `[DESIGN-CRITICAL]`

| Operation (Apple M3, Node 24.22.0, single thread) | per second | per op |
|---|---|---|
| `@noble/secp256k1` 3.2.0 Schnorr sign / verify (sync) | 511-536 / 638-669 | 1.87-1.96 / 1.49-1.57 ms |
| `@noble/curves` 2.4.0 Schnorr sign / verify | 717-737 / 1,051-1,174 | 1.36-1.39 / 0.85-0.95 ms |
| `nostr-tools` 2.25.2 `finalizeEvent` (hash + sign, 1.4 KB event) | 632-651 | 1.54-1.58 ms |
| `nostr-tools` 2.25.2 `verifyEvent`, JS, fresh objects | 885-963 | 1.04-1.13 ms |
| `nostr-tools/wasm` `verifyEvent` (nostr-wasm 0.1.0) | 5,750-6,575 | 152-174 us |
| WebCrypto ECDSA P-256 verify / sign (Node, async) | 17,991-18,935 / 35,926-36,744 | 53-56 / 27-28 us |
| WebCrypto Ed25519 verify (Node, async) | 11,937-12,506 | 80-84 us |
| `@noble/hashes` 2.4.0 SHA-256, 1 KB | 202,871-206,087 | 5 us |

- Cross-checks: the noble README reports (Apple M4) secp256k1 ECDSA verify 788/s and sign 6,888/s; wave-1 measured in Chromium 155 on this M3 WebCrypto P-256 verify 15.0-15.4k/s and Ed25519 verify 34-35k/s (`06` F47). These Node numbers are not browser numbers; the ratios are what matter.
- Measurement trap: `nostr-tools` caches the verification result in a symbol property, and object spread copies it, so benchmarking `verifyEvent({...ev})` reports ~30 million ops/s. I verified freshly JSON-cloned events.
- Derived cost to verify a whole ledger at the 8 MiB `maxChainBytes` default (about 10.2k blocks at my 820-byte typical snapshot size; `w2c-02` estimates 13.6k): JS Schnorr 8.7-12.9 s (noble-curves) or 15.2-21.3 s (noble-secp256k1); nostr-wasm 1.6-2.4 s (+~120 KB gzip); WebCrypto P-256 0.7-0.9 s. Phones are probably 3-10x slower than the M3 (extrapolation, low confidence): **26 s to 3.6 min** for native Schnorr verification of a full ledger.
- Signing is not the problem: one wrapper signature costs 1.4-2 ms even in JS.

**Confidence:** high for this machine, medium for browsers and phones. **Sources:** LIVE (bench, bench2), NPM, PROJ (`06` F47, `w2c-02`). **Date:** 2026-10-17.

### F19. Options for the ledger's relation to secp256k1: wrap, do not migrate `[DESIGN-CRITICAL]`

| | (a) Block = Nostr event, native Schnorr | **(b) Wrapper: block inside an event signed by a throw-away secp256k1 key** | (c) Dual signature inside the block |
|---|---|---|---|
| Change to block v1 / identity | Yes (format and key type) | None | Yes (format) |
| Client verify cost | Schnorr per block (F18: 9-21 s JS, or +120 KB WASM) | Inner P-256 only (0.7-0.9 s); outer signature ignored by clients | Same as (a) if Schnorr is checked |
| Key storage | Raw bytes in JS (F16) | Raw bytes, throw-away, never persisted | Both |
| Relay interop | Native (relays validate id, sig, PoW) | Relays validate the envelope only; inner is opaque | Native-ish |
| Hashcash | One PoW over the Nostr id serves ledger and NIP-13 | Ledger PoW on `h` unchanged; NIP-13 on the wrapper only for the 0.3% of relays that need it | Two |
| Re-publish after 3 years / clock windows | **Impossible on strfry defaults**: id covers `created_at` | Free: wrapper `created_at` = now, inner block untouched | As (a) |
| Size | ~0.8 KB event for a ~0.7 KB block (v0.1-shaped model: 775 B vs 696 B; tags carry parents, content only the op) | ~1.5 KB event for a 799 B v0.2 block (F20) | +100 B |
| Added code | Rewrite validator and canonical form | ~300 lines + 3.6 KB gzip | |
| Fits DESIGN-REVIEW | Contradicts the frozen block v1 and the WebCrypto key plan | Fits (relay plane is an optional cache) | |

- **Recommendation: (b).** The inner block stays the only thing a visitor trusts; the wrapper signature exists to satisfy relays. Keep (a) as a v2 option *only* if owners want a Nostr-native identity (NIP-07 / NIP-46 signers); note DESIGN-REVIEW's own Ed25519 plan does not help here (still not secp256k1).
- Outer/inner binding: tag `["x", h]` must equal the recomputed inner `h`; a mismatch means ignore the event. The wrapper does not authenticate content, so any party may wrap any known block; that is how pinners mirror and it is safe because blocks are self-authenticating.

**Confidence:** high for costs (measured), medium for the recommendation (untested end to end). **Sources:** LIVE (bench, blocksize2), N01, N13, SF-C, PROJ (ARCHITECTURE s6.1, DESIGN-REVIEW). **Date:** 2026-10-17.

### D. Mapping blocks to events, and syncing

### F20. Block-to-event mapping: kinds, tags, encoding, sizes, clocks `[DESIGN-CRITICAL]`

**Claim.** One regular-kind event per block and one addressable checkpoint per pinner and ledger fit every relay limit I found, if `content` is base64url and `created_at` is "now".

```
BLOCK EVENT       kind KIND_BLOCK    (regular range 1000-9999, claimed via the NIPs repo; NOT 30078)
  tags    [["t", ledgerId], ["x", h]]            // optional ["nonce","<n>","<bits>"] for the rare PoW relay
  content base64url(utf8(canonical(Block)))      // Block = {e,h,s,v?} byte-for-byte as gossiped
  created_at  now, clamped to the relay's window; never block.ts
  sig     BIP-340 by a throw-away key (visitors) or the pinner key (np)
CHECKPOINT EVENT  kind KIND_CKPT     (addressable range 30000-39999, claimed)
  tags    [["d", ledgerId], ["x", "<sha256 of gzip snapshot>", "snapshot"], ["server", "https://..."]...,
           ["n", "<height>"], ["root", "<hex>"], ["gen", "<genesis h>"]]
  content ""     // signed by a pinner key listed as np= in the P-256-signed pointer
```

- **Sizes (my model with the real `canonicalize()` and the v0.2 block shape; 87-char P-256 author, `mw1:`+27-char ledger id, random hashes; word-soup text, so compression is optimistic):**

| Block | Canonical block | Wrapper event (base64url) | Deflated (per message) |
|---|---|---|---|
| typical post (140 B text, 2 heads) | 799 B | 1,523 B (1.9x) | 1,118 B |
| 1 KiB text, 3 heads | 1,752 B | 2,793 B (1.6x) | 1,585 B |
| ~2 KiB text, 8 heads (default `maxValueBytes`) | 3,052 B | 4,527 B (1.5x) | 2,195 B |
| `v`-less skeleton (tombstoned) | 626 B | 1,292 B | 971 B |
| worst case at `maxBlockBytes = 4096` | 4,096 B | ~6.3 KB (computed, not built) | |

  Averages over 2,000 typical events: 1,552 B raw, 1,135 B with per-message deflate (ratio 0.73), 0.42 if one deflate stream with context takeover. Versus strfry `maxEventSize` 65,536 and the common NIP-11 `max_message_length` 131,072 the headroom is 10x or more everywhere.
- **Why base64url, not escaped JSON:** NIP-01 escapes only seven characters and says "all other characters must be included verbatim"; ledger values may contain any Unicode. In my first (v0.1-shaped) model the escaped-JSON form was 1,266 B and base64url 1,444 B (+14%): a small price for an `id` that cannot differ between implementations. (Design reasoning from the NIP text; no mismatch was observed because no event was published.)
- **Regular kind for blocks, addressable for checkpoints:** regular events are stored once by id and never replaced (dedupe by id; the owner or pinner can request NIP-09 deletion); addressable `d = ledgerId` keeps one checkpoint per pinner. Addressable-per-block (`d = h`) would let a pinner redact `v` by replacement, but relays "MAY discard" older versions, so it buys nothing certain.
- **Clock windows:** strfry rejects `created_at` more than 900 s in the future or 94,608,000 s in the past by default; nostr.wine +300 s / -3 years; nostr-rs-relay's sample config sets `reject_future_seconds = 1800`. Phones with wrong clocks will see `invalid:`/`blocked:` replies. Cheap guard: before publishing, read the newest event time from a `limit: 1` query to the same relay and clamp `created_at` into `[relay_now - 60, relay_now]`.
- **Queries:** `{"kinds":[KIND_BLOCK],"#t":[ledgerId]}`; missing parents by `{"kinds":[KIND_BLOCK],"#x":[<=64 hashes]}` (a 64-hash filter is ~4.2 KB); strfry allows `maxTagsPerFilter` = 3 and 200 filters per `REQ`.

**Confidence:** high for sizes and limits; medium for the schema (untested against relays). **Sources:** N01, N11, SF-C, NRR, LIVE (blocksize, blocksize2), PROJ (ARCHITECTURE s6.1, s6.6). **Date:** 2026-10-17.

### F21. An open-write relay plane is floodable: read through pinner keys first `[DESIGN-CRITICAL]`

**Claim.** Anything published under `#t = ledgerId` is untrusted input; relays cannot validate it, and newest-first pagination lets junk bury real blocks.
- An attacker needs only relay acceptance (per-IP rate limits, F9, slow but do not stop a distributed attacker; the real acceptance rate of strangers' events was **not measured**, F36).
- Defense in depth, all cheap: (1) the primary read path asks for `authors: [np...]` (keys that the P-256-signed pointer lists), which an attacker cannot forge; (2) the open `#t` read is a budgeted background supplement (at most 2 pages per relay; stop when more than half of a page fails validation); (3) validate in the order the ledger already uses (length cap, base64url decode, recompute `h`, PoW bits, then signature) so junk costs microseconds; (4) NIP-13 on the wrapper is optional per relay (only 0.3% require it).
- This mirrors v0.2's peer budgets ("> 50 invalid blocks from a peer: ignore for the session").

**Confidence:** medium (reasoned; flood acceptance untested). **Sources:** N01, N13, SF-C, NG, PROJ (ARCHITECTURE s6.3, s6.6). **Date:** 2026-10-17.

### F22. Negentropy (NIP-77): measured sync cost with the reference implementation `[DESIGN-CRITICAL]`

**Claim.** Negentropy is excellent for a returning visitor or a pinner repairing a relay, useless for a fresh visitor, and available on about a third of relays.
- Simulation (reference JS on both sides, 12,000 random 32-byte ids with clustered timestamps; binary bytes, the wire is hex so double them):

| Case | Rounds | Bytes (up + down) | Naive (all ids) |
|---|---|---|---|
| fresh visitor, 0 of 12,000 | 1 (8 with a 50,000-byte frame limit) | 384,011 | 384,000 |
| returning, missing newest 1,000 | 3 | 33,807 (33 B per missing) | 384,000 |
| returning, missing newest 50 | 2 | 2,712 | 384,000 |
| pinner 12,000 vs relay lacking 200 random | 2 | 76,022-77,422 (about 380 B per missing; two runs) | 384,000 |
| identical sets | 1 | 338 | 384,000 |
| fresh, small ledger (1,000) | 1 | 32,011 | 32,000 |

- Cost of the code: reference JS 3.0 KB gzip, lazy-loadable. Adoption: advertised by 31.9% of census relays (and 34 of 81 sampled NIP-11 documents), not by damus, nos.lol, primal or nostr.mom. strfry limits a sync to `maxSyncEvents = 1000000` records, and `NEG-ERR` replies with a `blocked:` or `closed:` reason must be handled.
- Use: (1) returning visitor catch-up where the relay advertises 77; (2) pinner coverage repair (`NEG-OPEN` with the pinner's filter against each relay, upload the `have` set, verify); (3) never for fresh visitors, who should take the snapshot.

**Confidence:** high (simulation with the reference code); medium for real-relay behavior (not run against live relays). **Sources:** N77, SF-N, SF-C, NEG, LIVE (negsim). **Date:** 2026-10-17.

### F23. Bootstrap economics: snapshot first, relays for the pointer and the tail `[DESIGN-CRITICAL]`

| Path (ledger at the 8 MiB cap, ~10.2k blocks at 820 B; 13.6k per `w2c-02`) | Bytes | Round trips |
|---|---|---|
| Snapshot, gzip JSON from Blossom or the host | ~3.1 MiB (0.37 x 8 MiB; 3.9 MiB for 13.6k blocks) | 1 GET (+ 1 checkpoint lookup) |
| Relay `REQ` by `#t`, raw | 15.8 MB (10.2k x 1,552 B) to 21.1 MB (13.6k) | 21-28 pages of 500 per relay |
| same with per-message deflate | 11.5-15.4 MB (ratio 0.73); 6.6-8.9 MB if the server keeps context takeover (0.42) | |
| Negentropy catch-up, returning, 1,000 missing | ~34 KB of reconciliation + ~1.5 MB of events | 3 + page(s) |

- permessage-deflate was negotiated by 8 of 11 relays probed (the seven strfry relays damus, nos.lol, primal, offchain.pub, nostr.mom, nostr.bitcoiner.social, nostr21.com, plus nostr.wine); not by relay.ditto.pub, relay.snort.social, purplepag.es. Browsers negotiate it automatically.
- The snapshot ratio (0.37 gzip, 0.30 brotli) comes from word-soup text and is optimistic; real guestbook text compresses less. Medium confidence.
- Safari's seven-day script-storage eviction (`06` summary item 6) is the strongest argument for this layer: an iOS visitor who returns after eviction needs a cheap, host-independent rebuild path.

**Confidence:** medium (model + measured parts). **Sources:** LIVE (blocksize2, wsext, negsim), PROJ (`06`, `w2c-02`). **Date:** 2026-10-17.

### E. Signaling over Nostr

### F24. Trystero 0.26.0's Nostr strategy: mechanics, defaults, cost

**Claim.** The mechanism (already live-verified in `02` F18) is small and robust; Trystero 0.26 split into `@trystero-p2p/*` packages and its relay handling is worth copying.
- Event: `kind = strToNum(topic, 10_000) + 20_000` (ephemeral range), tag `["x", topic]`, subscription `{kinds:[...], since: now, "#x":[...]}` batched; signed with `schnorr.signAsync` from `@noble/secp256k1`; announcements carry a random `nonce` because "Relays deduplicate IDs, and created_at only has second precision".
- Defaults: `defaultRedundancy = 5` of **29** default relays (deterministically shuffled by app id), `steadyAnnounceIntervalMs = 60_000`, `maxRelayBackoffMs = 15 * 60_000`; `rate-limited:` replies back the relay off exponentially; `duplicate:` is benign; `^(blocked|restricted|auth-required|pow):` marks the relay **terminal and retires it**.
- Liveness today: 26 of 29 default relays answer (90%); 3 do not (F11). Bundle: 27.7 KB gzip (Nostr strategy), 23.3 KB (torrent strategy), i.e. +4.4 KB for the relay transport on top of the tracker one.
- README comparison: Nostr is "highly decentralized with hundreds of active relays ... a good choice if you're interested in decentralization and high redundancy"; MQTT, BitTorrent, IPFS are recommended after it "based on robustness".

**Confidence:** high. **Sources:** TR-N, TR-R, TR-C, NPM, LIVE (bundles, listrot), PROJ (`02` F18). **Date:** 2026-10-17 (0.26.0 published 2026-10-04).

### F25. Feeding the WebTorrent swarm from a Nostr plane is supported by webtorrent itself

**Claim.** `torrent.addPeer(peer)` accepts a `simple-peer` WebRTC instance (`_addPeer` -> `Peer.createWebRTCPeer`), so a Nostr-signaled connection can join the torrent swarm without a tracker; Trystero's own rooms are a separate RTCPeerConnection stack and would not feed WebTorrent without an adapter.
- Verified in the installed webtorrent 3.0.21 `lib/torrent.js` (lines ~1036-1110): string peers are TCP/uTP addresses; any non-string object is treated as a WebRTC connection (its `id` is the dedupe key); `addPeer` throws if called before the `infoHash` event. Wave-1 recorded the same path (`01` s. "Other peer paths").
- Therefore the plane we would build is: derive `topic = sha256("mw-signal|" + btih)`, publish/subscribe ephemeral events as Trystero does, run `new SimplePeer({initiator, trickle:false})` ourselves, exchange `signal` payloads over the events, then `torrent.addPeer(sp)`. Cost: ~2 KB of our code + 3.6 KB (Schnorr) + the SimplePeer already inside webtorrent. Effort M; priority P2 because trackers already work and the tracker-resilience agent (w2b-01) owns the primary plane.

**Confidence:** high for the API (code read), medium for effort. **Sources:** WT, TR-N, PROJ (`01`). **Date:** 2026-10-17.

### F26. Signaling over relays leaks more than a tracker does

**Claim.** A relay sees the visitor's IP, the room topic (a hash of the infohash or ledger id) and SDP, whose ICE candidates contain addresses.
- Trystero README: SDPs "are sent via the chosen peering strategy medium. By default the SDP is encrypted using a key derived from your app ID and room ID ... however a relay strategy operator can reverse engineer the key using the room and app IDs"; a `password` parameter gives a real secret. A shared per-site password does not help a public site (it would sit in the page).
- Relays also keep ephemeral events for a while (strfry: `ephemeralEventsLifetimeSeconds = 300`), and anyone who knows the topic can subscribe and collect the IPs of every peer in the room. Trackers expose the same IPs (`03` covers that); the new exposure is that relay operators are numerous, unknown, and log by default.

**Confidence:** high. **Sources:** TR-R, SF-C, PROJ (`03`, `02` F23). **Date:** 2026-10-17.

### F. Blossom

### F27. What the Blossom spec guarantees and leaves open (BUD-00..12, repo head 2026-06-15)

**Claim.** Blossom gives content-addressed, CORS-open blob retrieval by SHA-256 with optional Range, Nostr-signed uploads and a user server list; it guarantees nothing about retention or throughput.
- **BUD-01 (mandatory):** servers MUST send `Access-Control-Allow-Origin: *` on all responses; preflight MUST carry `Access-Control-Allow-Headers: Authorization, *` and `Access-Control-Allow-Methods: GET, HEAD, PUT, DELETE`; `GET /<sha256>[.ext]` returns the blob with a `Content-Type` (default `application/octet-stream`); redirects (307/308) are allowed but "MUST redirect to a URL containing the same sha256" and the destination "MUST set the `Access-Control-Allow-Origin: *` header"; Range support is only "**should** support range requests ... and signal support using the `accept-ranges: bytes` and `content-length` headers on the `HEAD`"; an optional **`Sunset`** response header (added 2026-04, PR #99) advertises expected expiry ("advisory only"); errors may carry `X-Reason`.
- **BUD-02:** `PUT /upload` with raw bytes; the server "MUST NOT modify the blob"; 201 new / 200 existing; descriptor `{url, sha256, size, type, uploaded}`, extensible with `magnet`, `infohash` (BUD-02) or `nip94` (BUD-08, whose example includes `["magnet", ...]` and `["i", infohash]`).
- **BUD-03:** replaceable **kind 10063** with ordered `server` tags; uploaders MUST upload to at least the first server and MAY mirror to others; readers take the last 64-hex run in a URL as the hash and fall back to the author's list, then a well-known server. **BUD-04:** `PUT /mirror {"url": ...}` (server pulls and checks the hash against the token's `x` tag; `502` if the origin fails). **BUD-06:** `HEAD /upload` with `X-SHA-256`, `X-Content-Length`, `X-Content-Type` (example reason "Max allowed size is 100MB"). **BUD-07:** `402` with `X-Cashu` / `X-Lightning`. **BUD-09:** `PUT /report` with NIP-56 kind-1984 events carrying `x` tags; servers "MAY consider removed blobs sha256 as blocked to prevent rewrite". **BUD-10:** `blossom:<sha256>.<ext>?xs=&as=&sz=` URIs. **BUD-12:** `GET /list/<pubkey>` is "unrecommended"; `DELETE /<sha256>`.
- **BUD-11 (auth):** a kind **24242** event; `expiration` tag required; `t` verb `get|upload|list|delete|media`; optional `server` (lowercase domain) and `x` (hash) scoping; header `Authorization: Nostr <base64url, no padding, of the event JSON>`; `PUT /upload` **requires** an `x` tag equal to `X-SHA-256`. Security note: an unscoped token "can be replayed against other servers", worst for `delete`.
- NIP-B7 tells clients to "verify that the sha256-hash of its contents matches"; NIP-96 is `unrecommended: replaced by Blossom` in the NIPs index.
- Consequences: (1) reading needs only `fetch` + `crypto.subtle.digest('SHA-256')`; (2) **uploading needs a secp256k1 Schnorr signature and the hash up front, so uploads belong in Node tooling**, never in the visitor's browser; (3) integrity is strong, availability is operator policy (F29).

**Confidence:** high. **Sources:** B-R, B01-B12, NB7, NR. **Date:** read 2026-10-17 (specs `draft`, last repo commit 2026-06-15).

### F28. Which Blossom servers people actually use

**Claim.** Usage is concentrated on a handful of servers; most authors list two.
- Census: kind-10063 lists of **337 distinct authors** (newest ~100 per relay from damus, nos.lol, primal, offchain.pub, nostr.mom, nostr.bitcoiner.social): 65 distinct server hosts, median 2 per author (max 16). Share of authors listing: **blossom.primal.net 238 (70.6%)**, blossom.band 104 (30.9%), nostr.download 77 (22.8%), blossom.jumble.social 70 (20.8%), 24242.io 42 (12.5%), nostr.media 42, cdn.nostrcheck.me 33, blossom.ditto.pub 32, blossom.yakihonne.com 30, blossom.f7z.io 23, blossom.data.haus 22, cdn.satellite.earth 15, cdn.hzrd149.com 8. Selection bias: recently active clients.
- Software behind them: `hzrd149/blossom-server` (Node/Hono; local or S3 storage, retention rules), `v0l/route96` (Rust; nostr.download; free quota, optional Lightning payments), nostr.build's own stack (blossom.band), Primal's (BUD-01/02/04/05 per its landing page; blob requests 302 to `r2a.primal.net`, served by Cloudflare, and the host name suggests R2 object storage), Ditto (landing page: 1,400,454 blobs), BunnyCDN-fronted servers (24242.io, nostr.media).
- nsite use: my sampled manifests contain 42,280 path-to-sha256 pairs (21,443 distinct blobs); manifest `server` tags: blossom.primal.net 411, nostr.download 233, cdn.hzrd149.com 159, blossom.ditto.pub 143, nsite.run 107, blssm.us 103.

**Confidence:** high for the sample. **Sources:** B03, PG (landing pages), BS, R96, LIVE (blossom census). **Date:** 2026-10-17.

### F29. Retention, size caps and prices differ by an order of magnitude `[DESIGN-CRITICAL]`

| Server / software | Retention | Max blob | Allowed types | Price |
|---|---|---|---|---|
| `blossom-server` (reference; default `config.example.yml`) | **pruned when unaccessed**: `image/*` 1 month, `video/*` 1 week, `*` **1 week**; rules double as an allowlist (415 if no rule matches); prune loop; `removeWhenNoOwners` | `upload.maxSize` 2 GB | per rules | self-host |
| 24242.io | "Files are deleted if not accessed for **60 days**" ("free and unrestricted ... no warranties ... for now") | 100 MiB | any | free (zaps) |
| blossom.band (nostr.build) | free: "no limit on the number of uploads or retention"; paid plan storage counts against the plan; lapsed plan "not deleted the moment a plan expires" | **20 MiB free**, 100 MiB paid | free: images, audio, video only; paid adds PDF, SVG, ZIP | free; $18 / $69 / $120 / $240 per year (5 / 25 / 100 / 500 GB) |
| route96 (nostr.download) | operator config | sample config `max_upload_bytes` 100 MB; `free_quota_bytes` 100 MB | | optional Lightning |
| blossom.primal.net, blossom.ditto.pub, cdn.satellite.earth, cdn.nostrcheck.me | **not published (unverified)** | not published | | |

- Unauthenticated `HEAD /upload` preflights returned 400, 401, 403 or 404 (or timed out) on every server, so size caps could not be read without a token.
- `Sunset` is the standard way to learn retention per blob; `nostr.download` exposes `sunset` in `Access-Control-Expose-Headers`, but none of the sampled blobs carried a value (unverified in practice).
- Implications: (1) a snapshot or `.torrent` on the reference software is deleted a week after its last request unless something requests it; (2) blossom.band's free tier cannot hold a `.torrent` or `.gz` (types unverified, but the list does not include them) and caps at 20 MiB; (3) always publish to >= 3 servers with different software, mirror via BUD-04, and run a keep-alive plus a re-mirror-on-404 job (R5).

**Confidence:** high (vendor pages and config read on the date); retention enforcement itself unmeasured. **Sources:** BS, PG (24242.io, blossom.band, nostr.build plans), R96, B01, LIVE (blossomprobe). **Date:** 2026-10-17.

### F30. Live CORS and Range behavior, and the browser preflight trap `[DESIGN-CRITICAL]`

**Claim.** BUD-01's wildcard preflight makes Blossom servers browser-fetchable; servers that replaced `*` with an explicit header list break WebTorrent's web-seed and `xs` fetches on Safari/iOS, and one breaks them on Chromium too.
- **Fetch Standard (living, 2026-10-17):** `range` is CORS-safelisted only when it parses as a single `bytes=N-M` / `bytes=N-` range (suffix ranges like `bytes=-500` are not); `Cache-Control` is not safelisted; `User-Agent` is **not** a forbidden header name, so a page may set it. webtorrent 3.0.21 `webconn.js` sends `Cache-Control: no-store`, `user-agent`, `range` and uses `cache: 'no-store'`; `_getMetadataFromServer` (the `xs` fetch) sends `user-agent` only. Neither reads response headers (`res.ok` then `arrayBuffer()`), so `Access-Control-Expose-Headers` is not needed, but a server that ignores `Range` and returns `200` with the full body hands webtorrent a whole file as one piece (hash failure, retry after 10 s).
- **Local lab (Playwright 1.64.1, Chromium 156.0.8078.4 and WebKit 27.2, fetch with WebTorrent's exact options against five CORS policies):** Chromium's preflight lists `cache-control` only (it ignores `user-agent`); **WebKit lists `cache-control,user-agent`**. Results: `Authorization, *` (BUD-01 minimum), `Authorization,Content-Type,*` and echo-the-request policies pass in both engines in every mode. An explicit list that includes `Range, Cache-Control` but not `User-Agent` (the blossom.band policy) **passes in Chromium and fails in WebKit**, including the user-agent-only `xs` fetch. An explicit list without `Cache-Control` (the blossom.jumble.social policy) **fails in both engines** for web-seed fetches and fails WebKit's `xs` fetch. A bare `Range` request needs no preflight in either.
- **Live (2026-10-17):**

| Server | Preflight policy (`OPTIONS` as a browser sends it) | `GET Range` on a real public blob | Chromium 156, WebTorrent options |
|---|---|---|---|
| blossom.primal.net | `Authorization, *` | 302 to `r2a.primal.net` (Cloudflare-served) then 206, `Content-Range: bytes 0-63/99` | **OK** (followed the cross-origin redirect) |
| nostr.download | `...x-identical-media,*`; exposes `x-reason,x-identical-media,sunset` | 206; `cache-control: max-age=31536000, immutable` | **OK** |
| blossom.ditto.pub | `Authorization, *` | 206 | **OK** |
| blossom.yakihonne.com | `Authorization,Content-Type,*` | 206 | **OK** |
| cdn.hzrd149.com | `Authorization,Content-Type,*` | 206 | **OK** |
| blossom.jumble.social | explicit list: `Authorization,Content-Type,X-SHA-256,X-Content-Length,X-Content-Type` | 206 (no preflight needed) | **FAIL** (`Failed to fetch`) |
| blossom.band | explicit list with `Range, Cache-Control`, no `User-Agent` | sample blobs not hosted (404) | n/a; WebKit would fail (lab) |
| 24242.io, nostr.media (BunnyCDN) | `Authorization, *` | sample blobs not hosted | not tested |
| cdn.satellite.earth | echoes request headers and `Origin` | sample blobs 404; root page "Frontend app not built" | not tested |
| cdn.nostrcheck.me | every request timed out from this vantage | | |

- WebKit could not reach the internet from this sandbox (every live fetch aborted after 10 s, probably the local firewall), so WebKit results are local-lab only; Firefox did not start (F36).
- Fix, in our code: (1) fetch `.torrent` and snapshot bytes with plain `fetch(url)` (no custom headers, so no preflight anywhere); (2) for web seeds, stop sending `Cache-Control`/`user-agent`: either a Service Worker fetch handler that re-issues cross-origin web-seed requests with `Range` only, or a replacement connection passed to `torrent.addWebSeed(conn)` (it accepts a connection object with a string `connId`, `webtorrent/lib/torrent.js` L1123; the built-in `WebConn` is a `bittorrent-protocol` Wire, so a replacement has to be one too, which the prebuilt bundle does not export); (3) make `check-webseed.mjs` send the preflight WebKit sends (`Access-Control-Request-Headers: cache-control,user-agent`) and fail on rejection.

**Confidence:** high (Chromium end-to-end on live servers; WebKit local lab). **Sources:** FETCH, WT, B01, LIVE (corslab, corslab2, blossom_browser_test, blossomprobe). **Date:** 2026-10-17.

### F31. Blossom with WebTorrent: what fits and what does not `[DESIGN-CRITICAL]`

**Claim.** Blossom is a clean host for the `.torrent` (`xs`) and the ledger snapshot (`cs`); it is a web seed only for single-file torrents.
- **`xs`:** `torrent.xs` may be an array; all URLs are fetched in parallel and each result must parse and match the infohash (`parsedTorrent.infoHash !== self.infoHash` is rejected). Several Blossom URLs plus the host URL give free redundancy at zero trust. ARCHITECTURE s5.4 already has the loader fetch the `.torrent` itself and pass bytes to `client.add`, which is the safer path (F30).
- **Web seed:** for `files.length <= 1` webtorrent requests `this.url` literally with `Range: bytes=start-end`; for multi-file torrents it requests `<url>/<file path with the torrent path stripped>`. Blossom exposes only `/<sha256>[.ext]`, so a multi-file torrent (every v0.2 site) cannot use a Blossom URL as `ws=`.
- Paths forward: (i) `.torrent` and snapshot on Blossom (ready now, effort S); (ii) a single-file bundle torrent web-seeded from several Blossom servers (works, but changes how sites are packaged); (iii) keep multi-file torrents and extend ARCHITECTURE s3.4.7's Service Worker web-seed adapter so `GET /_mw/ws/<name>/<path>` maps to `https://<blossom>/<sha256 of that file>` with `Range`, using a **signed path-to-sha256 manifest published as its own blob** (hash carried in the signed pointer), because `/.mw/files.json` is inside the torrent and unknown before metadata. That is exactly the nsite model (F32); effort M-L, priority P3.
- Servers that redirect (Primal to `r2a.primal.net`) add a hop per range request; fine for pieces of 256 KiB.

**Confidence:** high (code read), medium for effort estimates. **Sources:** WT, B01, B02, PROJ (ARCHITECTURE s3.4.7, s5.4, DESIGN-REVIEW item 13). **Date:** 2026-10-17.

### F32. nsite (NIP-5A) is the working precedent for "signed manifest on relays, bytes on Blossom"

**Claim.** The pattern magnet-web needs for its blob plane already runs in production for static sites.
- NIP-5A: manifest kinds **15128** (root, replaceable, no `d`), **35128** (named, addressable, `d` matching `^[a-z0-9-]{1,13}$`), **5128** (immutable snapshot, regular); legacy 34128 deprecated. Tags: `path` (absolute path to sha256), `x` aggregate hash (SHA-256 of the sorted `<hash> <path>\n` lines), `server`, `title`, `description`, `source`, `a`/`A` for copies. Hosts SHOULD verify blob hashes; they try manifest `server` tags first, then the author's kind-10063 list, else 404.
- Tooling: `hzrd149/nsite-gateway` (Deno + Hono) defaults `LOOKUP_RELAYS=wss://user.kindpag.es,wss://purplepag.es`, `MAX_FILE_SIZE=128 MB`, up to 4 verification workers, bad-source cache 86,400 s, preferred-source cache 604,800 s; `sandwichfarm/nsyte` deploys with concurrency, `--sync` ("Sync missing blobs across all servers") and `status` ("relay coverage, manifest history, and Blossom server coverage"), i.e. the same coverage and repair loop recommended in R5/R6.
- `w1-07` F22 recorded that only server-side gateways exist; I found no client-side verifying nsite loader either (nsite-gateway and nsyte are a server and a CLI).
- Differences: nsite needs a gateway to render, magnet-web renders client-side from the Service Worker; nsite manifests are secp256k1-signed, ours are P-256. An nsite export of a magnet-web site (manifest + blobs) would let any nsite host serve the plain files, a no-JS and crawler fallback (R15, optional).

**Confidence:** high. **Sources:** N5A, NSG, NSY, PROJ (`w1-07` F22), LIVE (kindprobe). **Date:** 2026-10-17.

### G. Operations: privacy, takedown, cost, test limits

### F33. Privacy: what each party learns

| Party | Learns | Notes |
|---|---|---|
| Relay operator (and its CDN; 27.5% are behind Cloudflare) | visitor IP, the page's **`Origin` header** (browsers send it on every WebSocket upgrade, so the relay learns *which site*, not just the ledger), subscription filters (`#t` = ledger id; signaling topic), timing, all event content | content is public; an ephemeral outer key does not hide the inner P-256 `author`, which every ledger reader sees anyway |
| Blossom host | visitor IP, `Origin` on CORS requests, blob hash requested, timing | `Referrer-Policy: no-referrer` (ARCHITECTURE s7.1) removes `Referer`, not `Origin` |
| NIP-11 / indexer relay (outbox lookups) | IP, pubkey `np` being resolved | one lookup per cold start |

- Mitigations: nothing contacts a relay or Blossom host before consent (ARCHITECTURE s8 ordering); "Host only" mode disables it; a Settings toggle "Use public relays as backup" (default on in shell mode after consent, off in drop-in); pick a random subset of 3 of 5 relays per session; fresh outer key per tab session; disclosure sentence in the consent notice and DEPLOY.md (R10).
- All probe sessions used `Origin: https://example.org`; every relay upgraded the socket, so relays do not enforce an Origin allow-list (unlike `tracker.files.fm`, `02` F3).

**Confidence:** high (protocol facts), medium on exposure through CDNs. **Sources:** SF-C, B01, PROJ (ARCHITECTURE s7.1, s8), LIVE (ws probes). **Date:** 2026-10-17.

### F34. Takedown and deletion: relay copies are out of the owner's hands (aligns with `w2b-06` F13)

- A visitor-published wrapper event can be deleted only by its own throw-away key (NIP-09) and the key is gone; NIP-62 is per pubkey. So for **moderated ledgers, relays must receive blocks only from an owner-controlled pinner key**: tombstones can then follow (NIP-09 kind 5 for the old event, a new `v`-less skeleton event, 626 B canonical), and a pinner can also request vanish or stop mirroring. Open visitor publishing is acceptable only for `writers: 'open'` ledgers whose owners accept that copies persist.
- Blossom: delete needs the uploader's token (BUD-12); 24242.io: "First person to upload an object owns it", "Illegal content deleted without hesitation or recourse"; BUD-09 reports can make a server block a hash permanently; BUD-11 warns unscoped delete tokens replay across servers. Because blobs are content-addressed a takedown on one server does not affect copies elsewhere; the owner re-uploads or mirrors.
- Relay operators decide per relay and per kind (kind blacklists, plugins, ToS); only 10 of 81 sampled NIP-11 documents link terms of service. Whether public relays object to non-social, machine-generated kinds is **unverified** (their terms were not read).
- Child-safety, DMCA and reporting duties are `w2b-06`'s scope (3A-3E); this finding only adds the relay/Blossom-specific levers.

**Confidence:** medium-high. **Sources:** N09, N62, B09, B11, B12, PG (24242.io), PROJ (`w2b-06` F13), LIVE (nip11sweep). **Date:** 2026-10-17.

### F35. Cost model and a caution about seeding relays

| Item | Cost | Basis |
|---|---|---|
| Relay storage per ledger copy | ~15-21 MB at the 8 MiB cap (1,552 B per event) | F20/F23 |
| Snapshot + `.torrent` per site | ~3.1-3.9 MiB + ~5 KB | F23 |
| Free public relays / Blossom tiers | $0, no SLA | F10, F29 |
| nostr.build Purist (relay + Blossom subdomain, 5 GB) | $18 per year | F29 |
| nostr.wine / nostr21 admission | ~$15.40 once / ~$0.017 once | F15 (BTC $81.5k) |
| Own relay on Oracle Always Free | $0 (A1 2 OCPU / 12 GB, 10 TB/month egress, idle-reclaim rule; `02` F16); strfry on ARM untested here | `02` F16 |
| Keep-alive requests | one GET or HEAD per blob per server per week | F29 |

- **Seeding caution:** if a public relay applied the README's sample limit of 8 events per minute per IP (production values unpublished), mirroring a 10k-block ledger would take about 21 hours per relay. So: put history in the snapshot, publish only the checkpoint and the tail to public relays, and run bulk history only against relays the owner controls or pays for.
- Durability: F11's survival numbers (N=5 independent relays: 1.6% chance all gone after 13 months, 9.2% after 32 months) assume independence; 27.5% Cloudflare hosting and shared software defaults make it optimistic, which is why the snapshot on >= 3 Blossom servers plus the host copy is the real floor.

**Confidence:** medium (model). **Sources:** LIVE (blocksize2), PG, BTC, NG, PROJ (`02` F16). **Date:** 2026-10-17.

### F36. Limits of this research environment

- **Firefox**: Playwright's Firefox build 1555 exits with "Could not find profile folder" on macOS 27.0 (also with a profile in the scratch directory), so Firefox's preflight behavior for `Range` and `User-Agent` is **unverified**.
- **WebKit over the internet**: every live fetch aborted after 10 s; local-lab only.
- One vantage IP, one snapshot in time, Node numbers for crypto, no phones, no multi-day uptime series, **no writes** (the standing no-outbound rule), and no WebSearch (budget exhausted), so no published measurement study of relay uptime was retrieved.
- The sampled NIP-11 set is partly hand-picked; the census depends on 14 monitors of unknown location; every "alive" statement is "alive at 2026-10-17 20:50-21:50Z".

---

## Design sketch: three optional planes, each replaceable

This is a proposal built from the measured parts above; **it has not been run end to end** (no writes were permitted).

**Planes.** (0) P2P gossip as in ARCHITECTURE v0.2 (unchanged, always first). (1) **Blob plane**: `.torrent` and ledger snapshot on the host plus >= 3 Blossom servers, listed in the signed pointer. (2) **Relay plane**: one addressable *checkpoint* per pinner key and ledger, plus the *tail* of recent blocks as wrapper events, plus (optionally, later) signaling. Losing plane 1 or 2 must never break rendering; they only change how fast and how completely a fresh visitor sees the ledger.

**Pointer additions (v0.3 proposal, inside the P-256-signed record; unknown keys are already kept and signed by v0.2 s4):** `np=<64-hex x-only secp256k1 pubkey>` (repeatable, <= 3; the pinner keys allowed to publish checkpoints and authoritative tails), `cs=<https URL>` made repeatable (<= 4; Blossom URLs carry their own sha256, so the loader can verify bytes), optional `rl=<wss URL>` hints (<= 3). Relay and Blossom lists for `np` are otherwise resolved dynamically from its kind 10002 / 10063 (F6), which is what protects the pointer from list rot (F11).

**Cold start with no peer online (budgets in brackets):**
1. Render from the host or web seed as today; the ledger bootstraps after render (ARCHITECTURE s5.5).
2. **Snapshot:** race the first two `cs` URLs with plain `fetch` (no custom headers, F30); if the URL ends in a 64-hex name, check `sha256(bytes)`; gunzip with `DecompressionStream`; ingest up to `maxChainBytes` through the worker pool (inner P-256 signatures only) [~3-4 MiB, 1 GET].
3. **Checkpoint (needs `np`):** pick 3 of >= 8 pre-filtered relays at random; `REQ {"kinds":[KIND_CKPT],"authors":[np...],"#d":[ledgerId],"limit":1}`; take the highest `n` / newest `created_at` across relays; if its snapshot hash is newer than ours, fetch it from the checkpoint's `server` tags [3 relays x 1 query, 5 s timeout].
4. **Tail:** `REQ {"kinds":[KIND_BLOCK],"authors":[np...],"#t":[ledgerId],"since": checkpoint.created_at - 600}` paged by `until` with the zero-new-ids stop (F13); where the relay advertises NIP-77 and we hold blocks, use `NEG-OPEN` with the same filter (F22) [<= 10 pages per relay].
5. **Open supplement (background):** the same filter without `authors`, <= 2 pages per relay, stop when more than half of a page fails validation (F21).
6. **Completeness statement:** recompute `root` and compare with the checkpoint's `root`/`n`; the UI says "in sync with checkpoint (height n)" or "n blocks behind", never "complete".

**Publishing.** *Visitor* (only if the plane is on and consent was given): after the local commit and the gossip announce, publish the wrapper to at most 2 relays with a fresh throw-away key; one attempt, one backoff; never block the UI; sample a read-back by `#x` every 10 minutes. *Pinner* (`pin.mjs --mirror`, owner's key `np`): publish every block to all chosen relays at the pace each relay tolerates, verify by read-back, repair coverage with `COUNT` / `NEG-OPEN`; every N minutes or M blocks build the snapshot, upload to >= 3 Blossom servers (BUD-02 plus BUD-04 mirrors), publish the checkpoint; weekly keep-alive of every blob; emit a coverage report for CI.

**Failure modes and responses**

| Failure | Symptom | Detection | Response |
|---|---|---|---|
| Relays die or change policy | no checkpoint, timeouts | per-relay error counters; CI `check-relays` | refresh defaults each release; resolve `np` outbox; use snapshot URLs |
| Relay shadow-rejects | `OK true`, event never appears | read-back by `#x` after 60 s | drop relay from the write set after 2 misses (F14) |
| Rate limit | `rate-limited:` | OK/CLOSED prefix | exponential backoff to 15 min; pinner paces ~1 event / 8 s; history goes in the snapshot (F35) |
| Terminal rejection | `blocked:`/`restricted:`/`auth-required:`/`pow:` | prefix | retire relay for the session (Trystero behavior) |
| Clock skew | `invalid:` (too far off) | prefix | clamp `created_at` to relay time (F20) |
| Silent `limit` clamp / same-second burst | incomplete tail | zero-new stop, saturated boundary second | narrow filters, `#x` batches, NEG (F13) |
| Flood under `#t` | junk pages | validation failure ratio | authors-first reads, budgets (F21) |
| Blob pruned | 404 on `cs`/`xs` | `check-site`, keep-alive job | other servers, BUD-04 re-mirror from a healthy copy (F29) |
| Explicit CORS list | Safari/iOS `Failed to fetch` | preflight emulation in `check-webseed` | header-free fetches; avoid such servers for `ws` (F30) |
| Free-tier type or size rejection | `415`/`413` | publish-time `HEAD /upload` with token | choose servers by software and plan (F29) |
| Pinner key lost or abused | stale or hostile checkpoints | root/count mismatch after ingest | integrity unaffected (blocks verify); rotate `np` with a new pointer `seq`; treat checkpoints as hints |
| iOS storage eviction | empty IndexedDB after 7 days | `meta` missing | rebuild from snapshot (3-4 MiB) |
| WebSocket blocked (corporate proxy) | relay plane silent | connect errors | snapshot over HTTPS still works; P2P as before |

---

## Concrete recommendations for magnet-web

Effort: **S** <= 1 day, **M** about 2-5 days, **L** > 1 week. Priority: **P0** before any "production-ready" claim; **P1** needed for the durability floor; **P2** valuable, after P1; **P3** optional or later.

| # | Recommendation | Prio | Effort |
|---|---|---|---|
| R1 | Header-free fetches for `.torrent` and snapshots | P0 | S |
| R2 | Strip non-safelisted headers on web-seed requests; WebKit-faithful preflight check | P0 | S |
| R3 | Claim dedicated kinds; never use kind 30078/78 | P0 | S |
| R4 | `publish.mjs --blossom`: upload `.torrent` + snapshot to >= 3 servers, emit repeatable `xs=`/`cs=` | P1 | M |
| R5 | Weekly keep-alive and re-mirror workflow for blobs | P1 | S |
| R6 | Pinner mirror mode: relay publishing, read-back, repair, checkpoint | P1 | M |
| R7 | Optional client relay plane (wrapper events, authors-first reads) | P1 | M |
| R8 | Relay list management: CI refresh, NIP-65/NIP-66 resolution, quarantine rules | P1 | S |
| R9 | Pointer v0.3 fields `np`, repeatable `cs`, optional `rl` | P1 | S |
| R10 | Disclosure and consent text for relays and blob hosts | P1 | S |
| R11 | Observability: relay coverage and blob health in `check-site.mjs` | P1 | S |
| R12 | Negentropy for returning visitors and pinner repair | P2 | M |
| R13 | Nostr signaling plane (own minimal client + `addPeer`), default off | P2 | M |
| R14 | Approved write-acceptance test (script prepared, not run) | P1 | S |
| R15 | nsite (NIP-5A) export as a static, crawler-friendly mirror | P3 | M |
| R16 | Service Worker blob-seed adapter for multi-file torrents (`mf=` manifest) | P3 | M-L |
| R17 | Owner-run relay recipe (strfry on Oracle Always Free) | P3 | S |
| R18 | Native secp256k1 identity (option a) only on owner demand | P3 | L |

**R1 (P0, S). Fetch `.torrent` and snapshot bytes with a header-free `fetch(url)`.** Why: webtorrent's own `xs` fetch sends `user-agent`, which WebKit puts in a preflight (F30); explicit-list servers (blossom.band-style, jumble-style) then fail on iOS. ARCHITECTURE s5.4 already fetches `xs` itself; make that the only path, verify `sha1(info) === btih` ourselves, pass bytes to `client.add`, and never leave `xs` in the magnet handed to webtorrent. Acceptance: WebKit lab run against the `band_like` and `jumble_like` policies passes; unit test asserts no request headers are set.

**R2 (P0, S). Web-seed requests must carry only a safelisted `Range`.** Why: `Cache-Control`/`user-agent` force a preflight, and explicit allow-lists fail (F30). Do it in the Service Worker (re-issue cross-origin web-seed fetches with `Range` only, the same place ARCHITECTURE s3.4.7 already rewrites web-seed URLs) or with a replacement `WebConn`. Extend `check-webseed.mjs` to send `OPTIONS` with `Access-Control-Request-Headers: cache-control,user-agent` and fail if not allowed. Acceptance: lab matrix of F30 all green in Chromium and WebKit; live check against 3 Blossom servers.

**R3 (P0, S). Claim two kinds; do not use 30078/78.** Why: NIP-78 is private app data that relays "SHOULD" AUTH-gate (F2). Draft a short NIP (`KIND_BLOCK` regular 1000-9999, `KIND_CKPT` addressable 30000-39999, tags `t`/`x`/`d`, base64url content), check candidates against the machine-readable registry and a relay sample, then open the PR to `nostr-protocol/nips` (**a public submission: needs Ash's approval**). Until accepted, use the draft numbers behind a config constant. Acceptance: kinds absent from the README table and from a 5-relay sample.

**R4 (P1, M). `publish.mjs --blossom <server>...` (Node, `@noble/secp256k1` or `nostr-tools`).** Upload `site.torrent` and the snapshot (BUD-02 with a kind-24242 token scoped by `server` and `x`), mirror to the others with BUD-04, print repeatable `xs=`/`cs=` lines into `pointer.txt`, `meta.html`, `dns.txt`; use a dedicated publisher key (not the P-256 owner key; mode 0600 like `owner.jwk`). Pre-flight with BUD-06 `HEAD /upload` to catch 413/415/402. Acceptance: three servers of different software hold the blobs; `check-site.mjs` passes; deleting one server's copy still loads the site.

**R5 (P1, S). Keep-alive and repair workflow.** Weekly CI job: `GET Range 0-0` for every `xs`/`cs` URL on every server; on 404 re-mirror from a healthy copy (BUD-04) or re-upload; fail the job when fewer than 2 healthy copies remain. Why: reference-software default prunes unaccessed blobs after a week, 24242.io after 60 days (F29); `nsyte --sync` is the precedent (F32). Acceptance: delete a blob; the job restores it.

**R6 (P1, M). Pinner mirror mode (`pin.mjs --mirror` or `tools/mirror.mjs`).** Stable secp256k1 key `np` in a 0600 file; publishes wrapper events for all blocks and the checkpoint to >= 5 relays at each relay's tolerated pace; verifies by read-back (`#x`, after 60 s); repairs with `COUNT` and `NEG-OPEN`; builds and uploads snapshots; writes a coverage JSON. Moderated ledgers must publish only through this key (F34). Acceptance: after 24 h, >= 3 relays return the full tail by `authors:[np]`; a tombstoned block disappears from `v`-bearing relay copies after NIP-09 plus the skeleton re-publish.

**R7 (P1, M). Optional client relay plane.** Minimal relay client (WebSocket + `@noble/secp256k1` async, ~3.6 KB gzip, a few hundred lines; not `nostr-tools`), relay selection (R8), the cold-start sequence of the design sketch, validation order from F21, publishing with throw-away keys to <= 2 relays, Trystero-style OK/CLOSED handling (backoff on `rate-limited`, retire on `blocked|restricted|auth-required|pow`), a Settings toggle, off in drop-in mode, on in shell mode after consent. Acceptance: with all peers and trackers blocked, a fresh browser shows the pinner-published ledger from relays plus snapshot within 10 s on broadband; killing every relay changes nothing else.

**R8 (P1, S). Relay list management.** (a) `tools/check-relays.mjs` (NIP-11 + WebSocket + CORS + a canary read) run in CI before each release to refresh the shipped candidate list (>= 8, mixed software, none `memlay`, none Haven/pyramid/wot-relay/zooid for writes); (b) at runtime resolve `np`'s kind 10002 and 10063 from >= 2 indexer relays (purplepag.es answered in 650 ms in my test; `user.kindpag.es` returned nothing for my key) and prefer them; (c) quarantine on terminal prefixes; (d) cap relay connections at 5 and rotate. Why: list rot (F11), closed-by-design relays (F7), outbox precedent (F6). Acceptance: a release with a deliberately stale list still bootstraps through the outbox.

**R9 (P1, S). Pointer v0.3.** Add `np`, repeatable `cs`, optional `rl`; update ARCHITECTURE s4, s6.6, s10; unknown-key tolerance already covers old clients; keep each value <= the DNS TXT string budget (`publish.mjs` already splits at 255 bytes). Acceptance: signing vectors for the new keys; an old loader ignores them.

**R10 (P1, S). Disclosure.** Add to the consent notice and DEPLOY.md: "Public relays and file hosts you connect to can see your IP address, the address of this site and which ledger you read." Add the Settings toggle "Use public relays as backup" and keep "Host only" meaning no relays either. Why: F33. Acceptance: string present in DESIGN-REVIEW s4.5 wording; test that no WebSocket opens before consent.

**R11 (P1, S). Observability.** Extend `check-site.mjs`: per relay `COUNT` and read-back of the newest 3 heights, per blob HEAD + Range + sha256 + preflight emulation + `Sunset` value, exit non-zero when fewer than 2 relays or 2 blob servers are healthy. Optionally a weekly canary event with a `["expiration", now+3600]` tag (**publishing needs approval**; R14). Acceptance: CI turns red when the second-to-last server is removed.

**R12 (P2, M). Negentropy.** Vendor `Negentropy.js` (3.0 KB gzip), lazy-load, use only where `supported_nips` contains 77 and we already hold blocks; frame limit 50,000; handle `NEG-ERR blocked/closed`; pinner uses it for repair. Why: 11x less traffic for a returning visitor missing 1,000 of 12,000 (F22). Acceptance: simulated and live (offchain.pub, nostr.bitcoiner.social) catch-up under 100 KB for 1,000 missing.

**R13 (P2, M). Nostr signaling plane.** Own client, topic `sha256("mw-signal|" + btih)`, ephemeral kind in the 20000 range, SDP encrypted under a per-session secret exchanged inside the first message, `simple-peer` + `torrent.addPeer` (F25); default off; one extra relay set (5 of >= 8) separate from the block relays. Coordinate with w2b-01 (trackers). Acceptance: two tabs connect with trackers blocked.

**R14 (P1, S). Approved write-acceptance test.** Prepared, not run: `docs/research/labs/w2b-02-probes/relay-write-probe.mjs` (dry-run by default). Plan: a throw-away key; 20 relays (the R8 candidates); per relay at most 3 events: a 1.5 KB and a 6 KB wrapper (`KIND_BLOCK` placeholder) and a checkpoint, each with `["expiration", now+3600]`; record `OK` text, read-back by `#x` after 60 s and 1 h, `created_at` skew replies (+5 min, +20 min), then NIP-09 deletes; then a paced burst (1 event / 10 s, stop at the first `rate-limited:`) on 3 relays only. Needs Ash's explicit approval for the send and the relay list (user rule: no outbound without approval). Output feeds the "open-write" column that NIP-66 cannot provide.

**R15 (P3, M). nsite export.** Publish a NIP-5A manifest (`path` -> sha256, aggregate `x`) and the files to Blossom in addition to the torrent; nsite hosts then serve a static, crawlable copy (helps the `w2a-05` SEO gap for shell mode) and the same manifest enables R16. Cost: a secp256k1 key for the manifest, one more event.

**R16 (P3, M-L). Blob-seed adapter.** Signed path-to-sha256 manifest as its own blob (`mf=` in the pointer); the SW answers `/_mw/ws/<name>/<path>` from `https://<blossom>/<sha256>` with `Range` (F31). Only if hosting without an own web-seed host becomes a goal.

**R17 (P3, S). Owner-run relay recipe.** `docker-compose` + `strfry.conf` for Oracle Always Free: `events.maxEventSize` >= 16384, `rejectEventsOlderThanSeconds` large, `allowedKinds` limited to our two kinds, a writePolicy that accepts `np` and rate-limits others, a NIP-11 document, TLS via Caddy. Untested here; validate with R14's script. It is the only way to guarantee write acceptance and retention.

**R18 (P3, L). Native secp256k1 identity.** Only if owners ask for NIP-07 / NIP-46 signers; costs a block format change, 9-21 s of JS verification at the cap or +120 KB of WASM (F18, F19).

---

## Gotchas

1. `OK true` does not mean stored: strfry `shadowReject` replies `true` and drops the event (F14). Verify by read-back.
2. strfry rejects `created_at` older than 3 years and newer than 15 minutes by default; nostr.wine +5 min. Wrapper `created_at` = relay-clamped now, never the block `ts` (F20).
3. `limit` is clamped silently to 500 on damus, nos.lol, primal, offchain.pub; EOSE carries no hint; use zero-new-ids stop and watch same-second bursts (F13).
4. Only single-letter tags are indexed and only their first value (`#t`, `#x`, `#d`); `nonce`, `server` are not queryable (F1).
5. NIP-01 `content` escaping is minimal and implementation-sensitive; use base64url (F20).
6. NIP-78 (kind 30078/78) is "private app data" that relays SHOULD AUTH-gate; today open, tomorrow maybe not (F2).
7. Never add the NIP-70 `["-"]` tag; relays reject it by default and it forbids third-party mirroring (F5).
8. About 22% of relays are closed by design (Haven, pyramid, wot-relay, zooid) and reject strangers; NIP-66 `R` tags do not show this, and no monitor tests writes (F7).
9. relay.snort.social is an in-memory LRU relay; never count it as a durable copy (F10).
10. 27.5% of relays are behind Cloudflare; "5 independent relays" is not 5 independent failure domains (F7, F35).
11. Relay lists rot: 40-45% of an un-pruned list is gone in 5-7 months (F11).
12. NIP-66 monitors can be wrong or biased; "monitors per relay" is a sharding artifact, not availability (F7).
13. Public relays rate-limit per IP; a README sample shows 8 events per minute (production values unknown), and relay.damus.io answered my WebSocket upgrades with 503 for about two minutes after ~50 sessions in an hour (cause unverified). Never bulk-seed history; cap reconnect rates (F9, F35).
14. WebSocket handshakes always carry `Origin`: relays learn the site, not just the ledger (F33).
15. Blossom retention: unaccessed blobs are pruned (1 week on reference-software defaults, 60 days on 24242.io); `Sunset` is optional and rarely set (F29).
16. Free Blossom tiers filter by type and size (blossom.band free: 20 MiB, images/audio/video only); a `.torrent` or `.gz` may be refused (F29).
17. CORS: wildcard allow-headers pass everywhere; explicit lists fail on WebKit (user-agent) or everywhere (no Cache-Control); redirects (Primal to `r2a.primal.net`) need CORS on the target too (F30).
18. A web-seed server that ignores `Range` returns 200 + full body; webtorrent treats it as a piece and fails the hash (F30).
19. Blossom uploads need Schnorr tokens with an `x` tag; BUD-11 tokens are replayable across servers unless scoped with a `server` tag (F27).
20. "First uploader owns the blob" (24242.io): a squatter can hold delete rights; content addressing lets you re-host elsewhere (F34).
21. Wrapper events have no relay-side validation: a flood under `#t` can bury real blocks; read through `authors:[np]` first (F21).
22. `nostr-tools` caches verification on the event object; benchmark with fresh clones (F18).
23. WebCrypto has no secp256k1; Nostr keys are raw bytes in JS memory; keep them throw-away in browsers (F16).
24. The Trystero default SDP key is derivable by relay operators; relays also keep ephemeral events for ~5 minutes on strfry (F26).
25. `torrent.addPeer` throws before the `infoHash` event (F25).
26. Fetching `xs` through webtorrent adds a `user-agent` header, i.e. a preflight on WebKit (F30).
27. NIP-11 and CORS: 80 of 81 parsed documents sent `Access-Control-Allow-Origin: *`, so a browser can read them; one did not (F3), so treat a failed NIP-11 read as "unknown", not "dead".

---

## Open questions

1. **Write acceptance**: which relays store a 1.5-6 KB regular-kind wrapper and a checkpoint from an unknown key, and what do they reply? Needs the approved test (R14). Until then the "open-write" share is advertised, not measured.
2. **Per-IP write rate limits** of damus, nos.lol, primal, offchain.pub (noteguard's 8/min is a README sample only).
3. **Does anything retain a custom regular kind for years?** Replaceable kinds 30078/10063 are retained >= 1 year (F10); regular custom kinds were not probed beyond kind 1 and kind 2003 (nostr.mom holds kind-2003 events from 2023-12-03).
4. **Uptime over time.** I have one snapshot; NIP-66 history and any academic uptime study were not retrieved (WebSearch budget). A weekly snapshot job (R8) would produce the series.
5. **Firefox behavior** for `Range` and `User-Agent` in CORS requests (Playwright Firefox would not start) and **WebKit over the internet** (blocked here).
6. **Real-world compression**: the 0.73 / 0.42 ratios are zlib on synthetic text; permessage-deflate on live relays unmeasured.
7. **Registering kinds**: process and time for a NIP PR; whether maintainers object to machine-generated kinds on public relays; relay terms of service on non-social use (nos.lol and nostr.mom terms were not read).
8. **Blossom size and type limits** for authenticated `HEAD /upload` (needs a token) on primal, ditto, band, nostr.download; whether `.torrent` / `.gz` are accepted on free tiers.
9. **Does Primal's R2 redirect target answer preflights with WebTorrent's headers on WebKit?** Chromium passed; WebKit untested live.
10. **`nostr-wasm` maintenance**: last release 2023-12-22; acceptable only if option (a) is ever pursued.
11. **Key management UX** for the pinner key `np` and the Blossom publisher key (separate from the P-256 owner key; where do small owners keep them?).
12. **nsite compatibility**: would an nsite host serve a magnet-web publish copy unchanged (SPA fallbacks, headers)? Not tested.
13. **Cost of Cloudflare-hosted relays going dark together** (27.5% share): a correlated-failure drill (all CF relays blocked) was not run.
14. **Legal**: relay and Blossom operators receiving takedown notices about a ledger tag or blob hash; `w2b-06` covers the framework, the operator-side practice here is unverified.

---

## Sources actually read (all fetched or probed 2026-10-17 unless noted)

**Nostr specs (raw GitHub):** https://raw.githubusercontent.com/nostr-protocol/nips/master/{01,05,09,11,13,33,35,40,42,45,62,65,66,67,70,77,78,5A,B7}.md ; https://raw.githubusercontent.com/nostr-protocol/nips/master/README.md ; https://api.github.com/repos/nostr-protocol/nips/commits?per_page=3 (head 2026-10-17T14:37:12Z).
**Blossom specs:** https://raw.githubusercontent.com/hzrd149/blossom/master/README.md ; https://raw.githubusercontent.com/hzrd149/blossom/master/buds/{00..12}.md ; https://raw.githubusercontent.com/hzrd149/blossom/master/implementations/README.md ; https://api.github.com/repos/hzrd149/blossom/commits?per_page=5 (head 2026-06-15).
**Relay and Blossom software:** https://raw.githubusercontent.com/hoytech/strfry/master/strfry.conf ; .../strfry/master/docs/negentropy.md ; .../docs/plugins.md ; .../src/apps/relay/RelayWriter.cpp ; .../src/apps/relay/RelayServer.h ; https://git.sr.ht/~gheartsfield/nostr-rs-relay/blob/master/config.toml ; https://raw.githubusercontent.com/damus-io/noteguard/master/README.md ; https://raw.githubusercontent.com/v0l/memlay/master/README.md ; https://raw.githubusercontent.com/bitvora/haven/master/README.md ; https://raw.githubusercontent.com/bitvora/wot-relay/master/README.md ; https://raw.githubusercontent.com/fiatjaf/pyramid/master/README.md ; https://raw.githubusercontent.com/coracle-social/zooid/master/README.md ; https://raw.githubusercontent.com/fiatjaf/khatru/master/README.md ; https://raw.githubusercontent.com/hzrd149/blossom-server/master/README.md and `config.example.yml` ; https://raw.githubusercontent.com/v0l/route96/master/README.md ; https://raw.githubusercontent.com/hzrd149/nsite-gateway/master/README.md ; https://raw.githubusercontent.com/sandwichfarm/nsyte/main/README.md ; https://raw.githubusercontent.com/hoytech/negentropy/master/README.md and `js/Negentropy.js`.
**Trystero:** https://raw.githubusercontent.com/dmotz/trystero/main/packages/nostr/src/index.ts ; .../main/README.md ; .../main/CHANGELOG.md ; https://raw.githubusercontent.com/dmotz/trystero/{0.18.0,0.19.0,0.20.0,0.20.1,0.21.0,0.21.8,0.22.0,0.23.0,0.24.0,0.25.0}/(src/nostr.js | packages/nostr/src/index.ts).
**Registries and standards:** https://registry.npmjs.org/{nostr-tools,@noble/curves,@noble/secp256k1,@noble/hashes,@scure/base,nostr-wasm,@trystero-p2p/nostr,@trystero-p2p/core,@trystero-p2p/torrent,@trystero-p2p/mqtt,trystero,blossom-client-sdk,applesauce-core,applesauce-relay,@nostr-dev-kit/ndk,nostr-idb,negentropy} ; https://fetch.spec.whatwg.org/ (CORS-safelisted request-header, forbidden request-header) ; https://api.coinbase.com/v2/prices/BTC-USD/spot ($81,506.965 at 2026-10-17T21:20Z).
**Vendor and server pages:** https://blossom.band/ ; https://24242.io/ ; https://blossom.ditto.pub/ ; https://blossom.primal.net/ ; https://nostr.build/plans/ (redirects to https://account.nostr.build/plans) ; https://nostr.download/ ; https://satellite.earth/ ; https://cdn.satellite.earth/ ; https://nostr.watch/ and https://api.nostr.watch/ (SPA shells; the v1 API returned 502).
**Live protocol endpoints probed (read-only):** NIP-11 of 92 relay hosts (list in `labs/w2b-02-probes/results/`); `relay.nostr.watch`, `relay.damus.io`, `nos.lol`, `relay.primal.net`, `offchain.pub`, `nostr.mom`, `nostr.bitcoiner.social`, `nostr.wine`, `nostr21.com`, `relay.ditto.pub`, `relay.snort.social`, `purplepag.es`, `indexer.coracle.social`, `relay.nos.social`, `profiles.nostr1.com`, `user.kindpag.es`, `relay.nostr.band` (timeouts); Blossom servers `blossom.primal.net`, `blossom.band`, `nostr.download`, `blossom.jumble.social`, `24242.io`, `nostr.media`, `cdn.nostrcheck.me`, `blossom.ditto.pub`, `blossom.yakihonne.com`, `blossom.f7z.io`, `cdn.satellite.earth`, `cdn.hzrd149.com`.
**Project files (read):** `docs/ARCHITECTURE.md` v0.2, `docs/INTERFACES.md`, `docs/review/DESIGN-REVIEW.md`, `docs/research/{02-wss-trackers,06-browser-chain-vs-crdt,w1-07-prior-art,w2b-06-abuse-legal-ops,w2c-02-chain-production-features}.md`, installed `node_modules/webtorrent/lib/{webconn,torrent}.js` (3.0.21), `src/chain/canonical.js`.
