# Red team: malicious peers and wire attacks (v0.2.1 code and the v0.3 proposals)

- **Date:** 2026-10-20. **Attacker model:** a motivated visitor with the public code, the public design documents, a scripted WebRTC client and as many tracker connections as they like. No access to the host, the owner key or any victim's device.
- **Scope:** wire and peer attacks only. Spam economics, phishing, illegal content, supply chain and pointer poisoning are in the sibling red-team files in this folder; they are referenced, not repeated.
- **Method:** read the two proposals, then the code (cited as file:line), then wrote and ran one scratch test (A1) outside the project. Everything else is code reading and is marked "needs measurement" where the harm depends on timing I did not measure. Nothing was launched at a non-local address; nothing was pushed; no project file was changed except this report.
- **Status labels:** works today (0.2.1 code, shipped or about to ship), works against the proposal (v0.3 text as written), blocked by (the named control stops it), needs measurement.
- **Wording:** "no backend", "site ledger". Numbers marked "measured here" come from the A1 script (Node on this Mac, a single run, not a benchmark); numbers marked "arithmetic" are derived from constants cited in the same row.

## 1. Result in ten lines

1. **One 205-byte HELLO freezes a visitor's tab for as long as the attacker likes (A1, measured here).** It is in the code that ships in 0.2.1. This should block the first public release.
2. The per-swarm connection caps can be bypassed by reusing one self-declared peer id on many wires, and the eviction order favours the oldest wires, so a Sybil group that connects first keeps the rendezvous slots (A2, A3).
3. A peer can make a download-only phone upload 16 KiB for every 30-byte `ut_metadata` request, past the choke lock and the upload throttle (A5, needs measurement).
4. Every block from a throwaway key gets an ECDSA verification before the writer policy rejects it, and policy rejections are never struck (A4).
5. Several small shared tables can be filled by one peer: wants, sync slots, deferred blocks (A6, A7).
6. Web-seed URLs from an unsigned magnet are not filtered, counted or capped: LAN and localhost probing, and a click-driven request reflector (A9).
7. The chat design floods: sealed envelopes cannot be filtered by a relay, the hop limit has no field in the frame, the work stamp is not bound to the frame, and holders evict oldest-first (B1 to B4).
8. The chat challenge binding to "wire session ids" is defeated by the same peer-id spoofing as A2 (B7).
9. Direct-channel signalling accepted from strangers hands the attacker the victim's IP address and a UDP probe of the victim's network (B6).
10. File lane: torrent metadata, image dimensions and file names from strangers are unchecked in the text (B9, B10).

## 2. What the design and code already stop

| Attack | Stopped by | Where | Residual |
|---|---|---|---|
| Announce a 2 GiB message length, or trickle bytes into the parse buffer | Length read unsigned, wire destroyed over 262,144 bytes before buffering; watchdog at 524,288 bytes every 2 s; fails closed if the patch point is missing | `src/loader/torrent.js:331-362`, `config.js` `wire`, `wireGuard` | Guard wraps a private method of the vendored library (documented in SECURITY-MODEL) |
| Oversized or malformed gossip frame | `decode` rejects over 15,360 bytes, bad JSON, unknown type, failed validator; 50 strikes then ignore | `gossip.js:164-182`, `:616-638` | Frames are decoded before the budget is charged (A8); ignoring does not close the wire (A2) |
| Forged, altered or replayed block | Hash, proof of work, signature, value hash checked cheapest first; unknown ops rejected | `block.js:381-398` | CPU cost of the signature step (A4) |
| Piece poisoning on the site swarm | Every piece checked against the SHA-1 in the stored torrent, which must hash to the pointer's infohash; mismatch deletes and refetches | SECURITY-MODEL "A peer or a web seed sends altered files" | Wasted bandwidth per poisoned piece; SHA-1 contributor collision (already documented) |
| Hostile `metadata_size` on the rendezvous swarm | `ut_metadata.cancel()` on rendezvous wires | `torrent.js:~890` | Content wires keep ut_metadata (A5) |
| Fake web seed serving wrong bytes | Probe plus per-piece verification; 3 failures in 30 s skip the seed for 5 minutes | `config.js` `webseed` | Not a defence against URL choice (A9) |
| Window messages from another origin or frame to the Bridge | `ev.source` and `ev.origin` both checked | `bridge.js:312-322` | In shell mode the frame is same-origin by design, so site code is trusted (SECURITY-MODEL "Same-origin site code") |
| The web-seed rewrite route used as a proxy or page | Octet-stream, `nosniff`, `sandbox` CSP, CORP same-origin | `src/sw/core.js:1594-1604` | none found |
| Script click on a loader card | `isTrusted` check | `ui.js:32-38`, `panel.js:77-81` | Overlay and redress (B11) |
| Login proof replayed on another site | `aud` and `ledger` bound, loader supplies nonce (IDENTITY-AUTH-DESIGN 4.1) | design | Channel binding (B7) |
| Rendezvous wires grouped by a spoofed peer id merging two visitors | Each wire is its own gossip peer | `wire-ext.js:13-26` | The same trust problem remains in the cap code (A2) |

## 3. Attacks on the code that ships (v0.2.1)

### A1. One HELLO freezes the tab. Works today. Severity: blocker.

- **Preconditions:** the attacker knows the site id and owner key (both are public in the pointer and the ledger id), can join the rendezvous swarm (its infohash is derived from the ledger id, SECURITY-MODEL "What is not protected") and completes the `mw_chain1` extended handshake.
- **Actions:** send one HELLO `{ v: 1, site, owner, n: 5, d: 9e15, root: <64 hex that is not ours>, heads: [<one unknown hash>] }`. The validator accepts any safe integer for `d` (`gossip.js:136-139`; compare `k <= 1e9` in the SYNC and INV validators, `:142-145`). `_onHello` sees an unknown head and a depth beyond the fast path, so it calls `_maybeSync` (`:833-836`, `:1234-1254`). `_startSync` takes `D = max(ourD, hello.d)` and loops `for (k0 = 0; k0 <= last; k0 += 128)` building a 128-entry list and a SYNC frame per step (`:1256-1283`, loop at `:1273`). Nothing bounds `last`.
- **Measured here (scratch script, one run each, Node on this Mac):** frame 198 to 205 bytes. d = 1e6: 6 ms, 124 SYNC frames. d = 2e7: 33 ms, 2,443 frames. d = 2e9: 3.2 s, 244,142 frames, 89 MB resident. d = 2e10: 34 s, 2.44 million frames, 290 MB resident. The cost is linear in `d`; at 9e15 the loop would run for days. A browser tab runs the same code on its main thread.
- **Gains and harm:** every visitor on the ledger swarm that attaches the attacker can be frozen or crashed (out of memory) by one frame, repeatedly, each reload. Moderation, posting and rendering stop for them. Scales to the whole swarm at the cost of one connection per victim. It also makes the ledger a tool against the site's own readers.
- **Cheapest effective defence:** (1) validate HELLO: `n <= maxBlocks` (maxChainBytes over the smallest block size), `d >= -1` and `d < n`; (2) clamp `last` in `_startSync` to the same bound and refuse the HELLO as malformed (a strike) when it exceeds it; (3) unit test with `d = Number.MAX_SAFE_INTEGER`. **Cost to honest users:** none; an honest node never sends `d >= n`.
- **Related, same class, must be checked in the same pass:** every integer, array length and string length in every frame type, in 0.2.1 and in the new `mw_chat1` frames, needs an upper bound that the validator enforces (see B8). Run a fuzzer that sets every numeric field to 2^53-1.

### A2. Cap bypass with one reused peer id, and ignored peers keep their slot. Works today (code reading); the wire-level part needs measurement. Severity: major.

- **Preconditions:** attacker opens many WebRTC connections to the victim (the tracker relays the attacker's offers to random swarm members; the attacker can also answer the victim's offers).
- **Actions:** every wire presents the same 20-byte peer id in its BitTorrent handshake. WebTorrent does not reject duplicate handshake peer ids (it only refuses its own id, `node_modules/webtorrent/lib/peer.js:177`), and its connection cap `maxConns` applies to outbound `_drain` only (`torrent.js:2103-2105`). The loader's caps count unique `wire.peerId` values: `_swarmCount` (`src/loader/torrent.js:924-932`) and `_enforceCap` (`:941-962`, the `seen` set skips every further wire with a known id). So N wires with one id count as one and are never evicted. The emergency bound before the handshake (`:886-889`) uses the same count.
- **Gains:** unlimited wires from one attacker; each is its own gossip peer with its own 64 KiB/s unsolicited budget and its own 50-strike allowance (`wire-ext.js` comment, `gossip.js:558-588`), so every other per-peer limit in this report multiplies by N. Memory and DTLS cost land on the victim.
- **Also:** `_strike` sets `ignored` but never closes the wire (`gossip.js:616-638`); an attacker that burned its 50 strikes still occupies a counted slot.
- **Cheapest defence:** key caps by wire, not by peer id (keep peer id only for the "visitors" display count); count unique wires; destroy the wire when the gossip ignores it; set an absolute ceiling on total wires per torrent. **Cost:** an honest visitor with two wires (site and rendezvous swarm) counts twice against a per-swarm cap, which is already how the swarms are separated.
- **To measure:** open 100 wires with one id against a test client and read `torrent.wires.length`.

### A3. Rendezvous eclipse: tracker Sybils plus a newest-first eviction rule. Works today; partly documented. Severity: major.

- **Preconditions:** none beyond a script. Public WebSocket trackers have no per-IP quota (SECURITY-MODEL tracker row).
- **Actions:** (a) announce hundreds of fake peers on the rendezvous infohash with no real WebRTC behind them; the tracker hands the victim's offers to random swarm members, so most of the victim's three offers per announce (`config.js` `numwant`) go to Sybils that never answer (`glareWatchMs` 20 s, three retries, `ledger` block). (b) For the offers that complete, hold the slots: `wireScore` is `1e12` for any wire advertising `mw_chain1` plus bytes exchanged (`torrent.js:233-238`); on the rendezvous swarm nobody holds metadata, so `downloaded + uploaded` is 0 for everyone and every score ties; ties break "newest first" (`:953`), so the oldest wires win and a late honest wire is the one dropped. (c) Sybil wires advertise `mw_chain1` to take the 1e12 bonus, and stay silent: `wire.setTimeout(60000)` is a request timeout only (bittorrent-protocol clears it when no request is outstanding, `index.js:900-904`), so an idle wire is never closed.
- **Gains:** the victim sees only the ledger the Sybils pass on: stale heads, withheld bans and tombstones (a moderator's ban reaches everyone else first), and for the v0.3 chat lane a complete view of the victim's traffic. Not a forgery: blocks are still verified.
- **Already limiting it:** the site swarm also carries `mw_chain1`; the web seed and the `cs=` snapshot are the floor (SECURITY-MODEL).
- **Cheapest defence:** (1) reserve part of the cap for "outbound" wires the victim chose (Bitcoin-style anchor slots) and score by tenure and by valid blocks delivered, not by who came first; (2) random eviction among ties instead of newest-first; (3) close wires that have been silent for 2 minutes after the extended handshake; (4) diversify announces over the four trackers and the owner's tracker; (5) keep `cs=` snapshot polling when the peer count is high but the head has not moved for N minutes ("peers but no progress" is the eclipse signature). **Cost:** a little complexity; the idle-wire close costs honest users nothing.
- **Needs measurement:** how often a tracker returns a Sybil on the public trackers; the live sharing of Sybils to honest peers on `tracker.openwebtorrent.com`.

### A4. Signature verification before policy: throwaway-key CPU burn. Works today (cost needs measurement). Severity: major.

- **Preconditions:** a site where most keys are not writers (the default is `writers: 'owner'`) or a site with a fee the attacker will not pay.
- **Actions:** generate fresh P-256 keys, sign valid blocks with `bits: 0` (the node verifies with `minBits: 0`, `node.js:811`; the fee is enforced later by `admit`), and send them in BLOCKS frames at 64 KiB/s unsolicited or, after faking an ANN, as "solicited" blocks at 1 MiB/s (`gossip.js` limits). `_ingest` verifies every fresh block (hash, proof of work, key import and ECDSA verify, `block.js:381-398`, `node.js:854`) before `_place` calls `admit` and rejects with `E_POLICY` (`node.js:989-1003`). `E_POLICY`, `E_RATE` and `E_CAP` are not in `INVALID_REASONS` (`gossip.js` top), so no strike. Solicited allowance counts only bytes that were added (`gossip.js:597-600`), so rejected blocks never exhaust it. The per-author throttle (30 per 10 minutes) is keyed on the author, which the attacker rotates.
- **Arithmetic:** a minimal block is roughly 400 bytes, so 64 KiB/s is about 160 verifications per second per wire; with A2 the figure multiplies by the wire count. The 2-worker pool and the serialised `_exclusive` queue (`node.js:~830`) put honest writes behind the backlog.
- **Gains:** battery drain on phones, laggy posting for everyone, delayed moderation.
- **Cheapest defence:** do the cheap checks first. Before the signature, look up the author in the current control state: if `writers` is not `open` and the author is not owner, moderator or allow-listed, reject without verifying; if `open`, check the claimed `bits` against the policy fee first (a hash and a leading-zero count, far cheaper than ECDSA). Add a per-wire verification budget (for example 20 verifications per second) and count `E_POLICY` from a wire as half a strike after a threshold. **Cost:** blocks from authors whose allow-list entry has not arrived yet become "deferred" instead of verified; the existing deferral path (`node.js:996`) already handles that.
- **Needs measurement:** verifications per second per core on a mid-range phone.

### A5. `ut_metadata` request amplification past the choke lock and the throttle. Works today (code reading); needs measurement of delivered rate. Severity: major.

- **Preconditions:** a content wire (site swarm) to a victim that has the torrent metadata.
- **Actions:** send `ut_metadata` request messages (about 30 bytes each) in a loop. bittorrent-protocol answers every one with a data message of up to 16 KiB (`node_modules/ut_metadata/index.js` `_onRequest`, no counter). The choke lock only affects piece requests (`torrent.js:~375-395`), and when uploads are off the code calls `throttleUpload(-1)`, which means unlimited (`torrent.js:665` and `:1939-1941`: `limit = ... > 0 ? ... : -1`). The code's own comment says the throttle sits on every outbound byte, but with uploads disabled there is no throttle to sit.
- **Arithmetic:** 16 KiB over 30 bytes is a ratio of about 550 for a full piece; a small site's metadata is one short piece, so the practical ratio is the metadata size over the request size.
- **Gains:** a "download-only" phone on a metered network uploads whatever the link carries; battery and data drain; it defeats the mobile policy table (`config.js` `policy`) and the promise in PRIVACY.md that phones do not upload until the visitor opts in. The same hole would carry the v0.3 chat and file wires.
- **Cheapest defence:** after the extended handshake, once the metadata is complete locally, drop `ut_metadata` requests from wires beyond a small allowance (for example 4 per wire per minute), or unregister the extension handler on wires that already have the metadata. **Cost:** none; peers only need metadata once.

### A6. One peer fills the want table. Works today (code reading). Severity: minor.

- `_onAnn` and unsolicited `_onInv` create a want per advertised hash (`gossip.js:837-840`, `:927-934`), up to 200 per frame, with the advertising peer as the only source. The table is capped at 8,192 (`maxWants`, `:1088-1091`) with no per-peer share. At 64 KiB/s an attacker can ANN roughly a thousand fabricated hashes per second (arithmetic: 67 bytes per hash) and keeps the table full because each fake want lives for several 10-second tries (`wantTimeoutMs`, `maxTries`). Honest ANNs are then dropped (`_s.dropped++`), so live propagation of new blocks falls back to the periodic HELLO and sync, which is slower but still works.
- **Defence:** cap wants per source peer (for example 256) and drop the peer's oldest on overflow. **Cost:** none.

### A7. Sync-slot squatting. Works today (code reading). Severity: minor to major.

- At most four sync sessions run at once across all peers (`maxSyncSessions`, `gossip.js:1252`). A peer that sends a HELLO with an unknown root and a plausible depth gets a session; if it answers nothing the session ends only after `syncIdleMs` (8 s) and then backs off per peer (up to 60 s). Four wires (or one id with many wires, A2) holding sessions in rotation keep an honest new peer's session from starting; a visitor who is far behind needs a session, because the fast path covers only two depth levels (`fastPathDepth`).
- **Defence:** shorten idle sessions that have added nothing (3 s), prefer peers with prior delivered blocks, and let a session with a proven peer pre-empt one with an unproven peer. **Cost:** none.

### A8. Decode before budget; deferred and orphan pools shared across peers. Works today. Severity: minor.

- `handle` runs `decode` (JSON parse of up to 15 KiB) before `_charge` (`gossip.js:404` against `:421`), so a wire can burn CPU with frames that are dropped for budget afterwards. Check the bucket on frame length first.
- The deferred pool (512, `node.js:81`) and the orphan pool (2,000 global, 256 per peer, `dag.js:57`) are first-in-first-out across all peers; a Sybil group (A2) evicts honest entries. Per-peer shares for deferred blocks, as the orphan pool already has.

### A9. Web seeds and exact-source URLs from an unsigned magnet. Works today after the visitor's click. Severity: major (limited harm, cheap fix).

- **Preconditions:** the victim opens an unsigned magnet or hub link and clicks through the gate (SECURITY-MODEL "drive-by load"). The pointer's `ws=` and `xs=` lists come from the link.
- **Actions:** `webseedBases` and `xsUrls` accept any `http:` or `https:` URL, with no cap on the count and no address filter (`torrent.js:95-115`; `magnet.js` collects every `ws=`). `_probeAll` probes all of them at once (`:1190-1226`). A link can name `http://127.0.0.1:<port>/...` (allowed from an https page because loopback is a potentially trustworthy origin), LAN addresses on an http page, or a third party's server.
- **Gains:** a blind GET with Range to any listed address from the victim's browser; the loader's own status distinguishes "unreachable" from "wrong-bytes" (`:1336`), a port-scan oracle for localhost services; and a reflector: a link with hundreds of `ws=` entries sends each clicking visitor's requests (and retries, five minutes apart) to a target. The attacker's cost is one link.
- **Cheapest defence:** for unsigned records allow at most 4 web seeds and 2 `xs`, require https, and refuse loopback, link-local, private and `.local` hosts unless the URL is the page's own origin (`orderWebseeds` already knows the origin). Do not surface per-URL failure reasons for non-owner URLs. **Cost:** a developer testing a web seed on a LAN address must use the signed pointer path or the page's own origin.

### A10. Idle and slow wires. Needs measurement. Severity: minor.

- Covered in A3: no idle timeout. A peer that responds one piece at a time just inside the 30 s request timeout (WebTorrent's `PIECE_TIMEOUT` via `setTimeout`, then `wire.destroy()` on `timeout`, `torrent.js:1320-1331`) wastes at most one request window per wire and is replaced; a peer that never sends and never requests is not closed. Piece poisoning costs bandwidth for each bad piece fetched; confirm that a hash failure destroys the wire and does not just retry (lab: serve one flipped byte from a hostile peer, count refetches).

## 4. Attacks on the v0.3 proposals

These attack the design text as written. The code does not exist yet, so each is "works against the proposal" unless stated.

### B1. Relay flood and hop-limit ambiguity on `mw_chat1`. Works against the proposal. Severity: blocker for the chat feature.

- **Design facts (REALTIME 4.2, 5.3):** ENV frames are opaque sealed boxes, "relayed, hop limit 4, dedupe by SHA-256 of the frame"; the ENV layout (`0x03 | 0x01 | tag | epk | iv | ct`) has no hop field; relay budget 64 KiB/s per peer on desktop; a relay cannot decrypt or verify anything.
- **Actions:** an attacker generates unlimited unique frames (random bytes after a valid header; no key needed) and sends at the per-peer budget on every wire it holds. Each honest relay forwards them to its neighbours up to its own relay budget. Since no field proves anything, the relay cannot tell junk from mail, so relay budgets fill with junk and honest envelopes are dropped or delayed. If hop is a header byte outside the text, any hostile relay resets it to 4; if it is not in the frame at all, "hop limit 4" cannot be enforced and the flood is unbounded except by the seen-set, whose size is not specified.
- **Scale:** one attacker with k wires degrades every node within four hops; with A2, k is not capped.
- **Cheapest defence:** (1) put the hop byte and a 16-bit "work stamp" in the clear header, and make the stamp commit to the frame: `SHA-256("mw-stamp-v1" | tag | epk | iv | SHA-256(ct) | day | nonce)` with a leading-zero count the relay can check in one hash; relays forward only stamped frames; (2) route by interest: relay an ENV only to a neighbour that has sent a WANT-TAGS containing its tag (the recipients already announce their tags, 0x05), plus a small random fan-out for first contact; (3) per-wire fair queues so one wire cannot take the whole budget; (4) bound and specify the seen-set (for example 8,192 hashes, 10 minutes). **Cost to honest users:** the sender mines a stamp per message (their own estimate: about 1.05 million hashes at 20 bits, unmeasured on phones, gate G-CH-6); relay-by-interest means a first message to a stranger travels by the small random fan-out and may need a holder.

### B2. Stamp is reusable and the tag is computable. Works against the proposal. Severity: major.

- Stranger inbox tag: `SHA-256("mw-inbox-v1|" + ek + "|" + day)[:8]` (5.3); stamp: `leadingZeroBits(SHA-256("mw-stamp-v1|" + recipient ek + "|" + day + "|" + nonce))` (5.6). The stamp covers the recipient and the day, not the frame. One mined nonce is valid for every frame to that recipient that day. Anyone can compute the recipient's inbox tag from the public chat-key record.
- **Actions:** mine one stamp (about a million hashes), then send unlimited junk frames to the victim's inbox tag; the victim must try an ECDH, HKDF and AES-GCM for each, up to the 50 per peer per second cap, times the number of wires (A2). Also fills the victim's "message requests" and the holders' slots for that tag (B3).
- **Defence:** bind the stamp to the frame hash as in B1 so each frame needs its own work; an inbox owner can raise `chatBits` when under attack (published in the chat-key record, so senders know). Reject frames with a tag that matches but a stamp below the recipient's current bits before any ECDH. Cap the requests inbox (for example 200 entries, oldest dropped, never auto-preview). **Cost:** honest strangers wait for one stamp per message instead of per day; contacts skip stamps.

### B3. Holder poisoning and wipe. Works against the proposal. Severity: major.

- **Design facts (5.7):** holders keep ENV frames for 7 days, 64 per tag, 4 MiB per holder, evict oldest.
- **Actions:** send frames to a holder with random tags until 4 MiB is reached, then keep sending: eviction is oldest-first, so the holder's whole mailbox is replaced by junk. Arithmetic: 4 MiB over 16 KiB frames is 256 frames, a few seconds at the 64 KiB/s budget. For one victim, send 64 junk frames to the victim's computable stranger-inbox tag (B2) at every holder: the real message is evicted by newer junk.
- **Also:** "held by N peers" in the UI cannot be verified; a Sybil holder (cheap, opt-in, desktop-only is only a convention) acknowledges and drops, so the sender is told the message is safe when it is not (the same Sybil power as A3).
- **Defence:** per-source quotas (a holder accepts at most 1/8 of its store from one neighbour); evict from the largest source first, not oldest overall; require the B1 stamp on held frames; senders send to at least two independent holders and the UI says "held by N peers (not verified)". **Cost:** a few lines in the holder; senders use more bandwidth.

### B4. WANT-TAGS and HELD as an amplifier. Works against the proposal. Severity: major.

- A WANT-TAGS frame (up to 32 tags, about 300 bytes) can be answered with HELD batches "to the cap" (16 KiB frames; 5.7). No rate limit on HELD answers is stated (only relay and decrypt caps in 4.2). Ratio is large (arithmetic: 16 KiB per 300 bytes, repeated). A Sybil can drain a holder's uplink and a mobile holder's data.
- Also an oracle: the stranger inbox tag of any key is computable, so anyone can ask any holder "do you hold mail for this person today", learning the existence, count and arrival time of messages for them (R8 accepts "someone wrote to this key"; the oracle makes it queryable by anyone, not only observers on the path).
- **Defence:** answer a tag at most once per wire per minute, total HELD egress capped like relay; answer stranger-inbox tags only to a wire that proves it is the key owner (a signed challenge on the recipient's chat key, one extra round). **Cost:** one round trip on a mailbox fetch.

### B5. Presence and room spoofing. Works against the proposal. Severity: minor (presence), major (rooms if unspecified).

- **PRES (5.1):** public presence id is `HMAC(K_site, "pres|" + pub + "|" + day)[:8]` where `K_site` derives from the ledger id alone, and the frame is unsigned. Anyone can compute the id of every member listed in the ledger, claim they are online, or claim away. It also lets any peer list which members are online by dictionary over ledger authors. Defence: sign PRES with the member's key, or do not offer public presence.
- **ROOM (5.5):** the frame is signed, but the text does not say (a) the order of checks: look up the author's role before verifying the signature, or each ROOM frame from a throwaway key costs an ECDSA verify (A4); (b) a freshness window: replay of an old signed message after the seen-set rotates; (c) a clamp on `t`: an author who sets `t` far in the future pins a message to the end of any list sorted by time. Defence: role lookup first, accept `|now - t| <= 5 minutes`, display order by arrival not claimed time, seen-set keyed by author and id with the same window.

### B6. Direct-channel signalling from strangers. Works against the proposal. Severity: major.

- **Design facts (4.3, SIG 0x09):** SDP offers and candidates travel as sealed frames; direct channels are "opt in per conversation".
- **Actions:** the attacker, a stranger who passes the stamp, sends the victim a SIG offer whose candidates name addresses of the attacker's choosing, including private and loopback ranges. If any client auto-answers, or builds the ICE agent before the visitor accepts: (a) the victim's reflexive and host addresses reach the attacker (the exact exposure the design tries to keep behind relay mode); (b) the victim's browser sends STUN binding requests (UDP) to every listed address, a blind probe of the victim's LAN.
- **Defence:** accept SIG only from accepted contacts who have been granted "connect directly" for that conversation; never create an `RTCPeerConnection` from an unaccepted offer; drop candidates in private, loopback and link-local ranges unless the contact is on the same site-local network by choice; rate-limit one pending offer per contact. **Cost:** a stranger cannot start a direct call; they message first.

### B7. Challenge-response bound to wire ids is defeated by relaying. Works against the proposal. Severity: major.

- **Design facts (IDENTITY-AUTH-DESIGN 4.1):** CHAL/RESP over a peer wire must be bound by `chan: [idA, idB]`, "both sides' wire session ids"; binding to DTLS fingerprints is "verify feasibility". The loader's own comment (`wire-ext.js:13-26`) says the remote peer id is self-declared and nothing checks it.
- **Actions:** M sits between honest A and honest B (M is a peer of both). M presents itself to B with A's id and to A with B's id. B sends a challenge with `chan = [idB, idA]`; M relays it to A, who signs `chan = [idA, idB]`; M returns the proof. The two sets are the same, so B accepts the proof as "A is on this wire" while the wire is M's. For a proof used only to open a chat session the harm is that M can pose as A to B (M sees B's traffic, B believes it speaks to A's wire); the sealed envelopes are still end-to-end, so content stays sealed, but presence, "you are connected to A" and any gating by wire identity fail.
- **Defence:** do not use peer ids; run an ephemeral ECDH on the wire and sign the transcript (both ephemeral public keys and both site keys) with each site key, then derive the session MAC key from it (a SIGMA-style exchange). A relay then has two different transcripts. This needs no DTLS access. **Cost:** one extra message and about 65 bytes each way, once per wire.
- **Also:** the nonce for server-backed sign-in comes from the server through site code; a hostile script on that site obtains a proof for that site only (`aud` bound), which is the documented same-origin limit; a proof for site X cannot be redeemed at site Y (blocked by `aud`).

### B8. Parser surface of the new frames. Needs a spec rule. Severity: major (preventive).

- A1 exists because one integer had no upper bound. The chat design has more: HELLO `lanes` JSON, `ROOM` text and author, `WANT-TAGS` count, `HELD` batch counts, envelope `epk` (a 65-byte point that may not be on the curve), `ct` length against the bucket sizes (256, 1,024, 4,096, 16,000 bytes only), `t`. **Rule to add to REALTIME 4.2:** every field has a stated maximum; HELLO is at most 512 bytes; envelope length must equal one of the bucket sizes plus 94 bytes of overhead, else it is malformed and counts as a strike; unknown type or version is a strike; every `importKey` and `decrypt` runs in try/catch with the strike on failure; run the A1 fuzzer on every numeric field; the 20-invalid-frames rule (4.2) must apply per wire, not per peer id (A2).

### B9. Files: untrusted torrent metadata. Works against the proposal. Severity: major.

- **Design facts (6.1 to 6.7):** the public listing holds `ih`, `len`, `name`, `mime`, `sha256`; "file torrents have their own caps". The text does not say that the downloaded metadata is validated against the listing.
- **Actions:** the attacker lists an infohash of a torrent they built: `len` in the listing says 25 MiB but the torrent holds 4 GiB; or a million 16-byte pieces (the piece-hash table exceeds the 8 MiB `.torrent` cap or burns memory just under it); or many files with names like `../mw-sw.js`, `index.html` or paths that collide with site routes if the file lane reuses `serveEntryFile` (`src/sw/core.js:1111-1134`, which picks the type from the path's extension); or `pad` entries. SHA-1 verification of pieces does not help: the attacker made the torrent.
- **Defence:** a file torrent must have exactly one file, `length === listing.len` and at most the lane cap, a piece length in a fixed range (16 KiB to 4 MiB), a piece count under a stated bound, no `pad` files, no path components, and the `.torrent` under a small cap (for example 256 KiB); the file lane gets its own SW route and namespace keyed by infohash, never `serveEntryFile`; the type served is a fixed table keyed by the sniffed class, never the listing's `mime`. **Cost:** none for honest uploads from the loader's own `client.seed`.

### B10. Files: decode bombs and name spoofing. Works against the proposal. Severity: major.

- **Preview (6.6):** "images decoded with `createImageBitmap`". A 200-byte-header PNG can declare 65,535 by 65,535 pixels; decoding allocates gigabytes and kills the tab or the page. Defence: read the dimensions from the header first, refuse over a pixel cap (for example 24 million), decode in a worker, and cap total preview memory. Animated formats and SVG are not previewed.
- **Names:** `name` is up to 96 characters from a stranger. Bidi override characters make `invoice-` + U+202E + `fdp.exe` display as a PDF; quotes and semicolons break a naive `Content-Disposition`. Defence: strip control and bidi characters, NFC-normalise, show the extension separately, set `filename*=UTF-8''...` percent-encoded, and display the sniffed type next to the claimed one.

### B11. Drop-in card overlay (cross-origin and same-page tricks). Works against the proposal as it grows; works today at lower stakes. Severity: major for the "any site" sign-in.

- **Facts:** the drop-in panel is a fixed element with `z-index: 2147483000` and `!important`, hosting a closed shadow root in the host page's own document (`src/dropin/panel.js:150-154`); the clicks it accepts must be `isTrusted` (`:77-81`). That stops a script that calls `click()`. It does not stop UI redress: a host-page script or third-party tag (an ad, a widget) can draw an element at `z-index: 2147483647` over the "Approve" button, or place a transparent frame under the visitor's real click, or move or hide the host element with page CSS because the host element lives in the light DOM.
- **Why it matters now:** the new goal is one identity usable "on any existing site through the drop-in". The harm of a redressed card is a login proof for that site (aud bound, so only that site), or the explicit "use the same identity here" choice (linkability) accepted by a visitor who thought they clicked something else.
- **Defence that works:** do the consent in a window the host page cannot draw over: a small popup or top-level page on the loader's origin (like the OAuth and passkey sheets), with the origin shown by the browser. The in-page card is only a prompt that opens it. Alternatives that help but do not close it: `popover`/`dialog.showModal()` (top layer, but later top-layer elements stack above it), a short delay and "move the mouse first" checks (usability cost), an `IntersectionObserver` v2 occlusion check on the card (Chromium only), and the confirmation word entered by the visitor for the linkable choice. **Cost:** a popup per sign-in (blockers; fine on a click).

## 5. Priority list for the owner

| Order | Item | Why first | Effort |
|---|---|---|---|
| 1 | A1: bound `d` and `n` in HELLO, clamp `_startSync`, fuzz every integer | Remote tab freeze in shipping code | S |
| 2 | A2: cap by wire, close ignored wires | Multiplies every other limit | S |
| 3 | A5: stop `ut_metadata` replay | Mobile promise broken | S |
| 4 | A4: policy and fee check before signature, per-wire verify budget | CPU and battery | S |
| 5 | A9: web-seed filter and count cap for unsigned records | Reflector and LAN probe | S |
| 6 | A3, A7, A6, A8: tenure scoring, anchor slots, idle close, per-peer shares | Eclipse and table fills | M |
| 7 | B1, B2, B3, B4, B8 before the chat lane is built | Rules are cheap in the design, costly after the frame format freezes | M |
| 8 | B6, B7 before direct channels and wire login | Wrong choice leaks IPs and breaks wire identity | S in the spec |
| 9 | B9, B10, B11 before files and the "any site" widget | Each has an easy design-time fix | M |

## 6. What I did not test, and what each claim rests on

- A1 is measured with a scratch script that imports `Gossip`, `Dag`, `encode` and `MSG` from the repository and attaches one fake peer; I did not drive a real browser or a real wire.
- A2 rests on reading `torrent.js`, `peer.js` and `torrent.js` in WebTorrent for the duplicate peer id; a lab run is needed.
- A3, A4, A5, A10: code reading; delivered rates and verification costs are not measured. A5 needs a lab with a real WebRTC wire on a phone profile.
- B1 to B11 are design review: the code does not exist. Where I wrote a number from the design (budgets, 20 bits) I did not verify it.
- No attack here needs the owner key, a host compromise or a bug in the browser; each needs only the ability to connect as a peer or to publish a link.
