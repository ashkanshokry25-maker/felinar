# chat lane (v0.3 C1 + C2): notes and deviations

Brief: R 2.4.3, 2.7.1 to 2.7.9, 2.10.3, 2.11.2; MF-32 to MF-46; ARCHITECTURE 15.3 and 15.6; INTERFACES
v0.3 `src/chat/*`. Files: `src/chat/*.js`, `test/vectors/chat.json`, `test/unit/chat-*.test.mjs`.

This is new cryptographic code. Nothing here calls the handshake or the sealed box secure; both wait for
the outside review of R 2.19.

## Progress log (newest last; the session can be cut off)

- 2026-10-20 ET plan written; `src/chat/limits.js` first.
- core written: limits, frames, stamp, tags, ck, seal, noise, replay; lane parts written: groups, presence,
  holder, outbox. Smoke runs: DM and stranger round trips, group round trip, XX handshake (65/162/97 bytes).
- service, lane, wire written; core unit tests green (frames 9, seal 11, noise 4, replay 6). The replay test found a
  sign bug in the Bloom indexes (`| 1` made h2 a negative int32, so bits were never set); fixed with `>>> 0`.
  The Noise vector is matched by an independent node:crypto transcript written from the Noise rules.
- lane routing (10), holder (5), groups (5) and service (10) tests written; all 60 chat tests green, repeated 8 times
  without a flaky run. Review fixes after the first green run: per-wire receive order (a sealed frame could arrive
  while the responder was still finishing XX3); a persistent round-robin pointer in the fair queues (the first source
  was favoured on every drain); a token bucket that holds one largest frame (16,115 bytes) so Android's 8 KiB/s can
  still relay a large frame; a failed AEAD strikes only a frame made by that neighbour (hop 0); ACKs do not consume
  conversation counters; hidden tabs send one "away" and then nothing.
- aligned with the loader seams that landed meanwhile (`src/loader/torrent.js`): `registerWireExtension(name,
  { onWire(wire, swarmKind, { late }) }, { swarms })` and `joinLane({ kind: 'chat', infoHash, announce })`.

## Deviations (contract changes; the spec sections are updated)

| Id | What R says | What the code does | Why |
|---|---|---|---|
| D-1 | 2.7.4: one `mk = HKDF(K_pair \|\| ECDH(epk, theirChatPub), salt = tag, ...)` for contacts and strangers | Stranger frames (inbox tag, plaintext carries the sender CK) use `mk_s = HKDF(ECDH(epk, theirChatPub), salt = tag, info = "mw-dm-v2\|" + ledgerId + "\|stranger")` and carry `auth (32) = HMAC(K_pair, "mw-dm-v2\|auth\|" \|\| tag \|\| epk \|\| plaintext with auth zeroed)` after the CK; the recipient verifies the CK, computes `K_pair` with `CK.ek`, then checks `auth`. Contact frames are exactly as specified. | The recipient of a message request cannot compute `K_pair` before it has read the CK, which is inside the ciphertext. Without the inner `auth`, anyone holding a person's public CK could send requests in that person's name. Deniability is kept: the recipient can build such a frame itself (test U-CH-3). |
| D-2 | 2.4.3: Noise XX "instantiated with P-256" | Protocol name `Noise_XX_P256_AESGCM_SHA256`; public keys are the 65-byte uncompressed SEC1 points; `DH()` is the 32-byte x coordinate; everything else follows the Noise specification (revision 34) unchanged. `next()` is async (WebCrypto). | Noise defines no P-256 DH function. The vector is reproduced by an independent node:crypto transcript written from the Noise rules. |
| D-3 | 2.7.7: group signature over `"mw-grp-msg-v2\n" + ledgerId + groupId + epochId + id + t + SHA-256(body)` | Separators added: `"mw-grp-msg-v2\n" + ledgerId + "\n" + groupId + "\n" + hex(epochId) + "\n" + b64url(id) + "\n" + t + "\n" + hex(SHA-256(body))`. `K_g` uses `hex(epochId)`. | Plain concatenation of variable-length fields is ambiguous; 2.10.3 asks for a separator. |
| D-4 | 2.7.7: "the admin list `{ admins, by, sig }` is signed" (no prefix named) | Admin list `{ ledger, groupId, admins, by, t, sig }` signed over `"mw-grp-admin-v1\n" + JCS(...)`; rekey commits `{ v, ledger, groupId, name, prev, epochId, creator, commit, members, removed, admins, t, sig }` signed over `"mw-grp-commit-v1\n" + JCS(...)`. | Two new purposes, two new prefixes (2.10.3 rule). Request: add `mw-grp-admin-v1` and `mw-grp-commit-v1` to the list in R 2.10.3. |
| D-5 | 2.7.6: PRES "signed (public) or MAC'd (contacts)", 8 slots | Body `mode (1) \| 8 x 8 slots \| status (1) \| auth (64)`. PRES is built per neighbour: the slot of that neighbour's blinded id is real only when it is a contact, the rest random. Contacts: `auth` holds an 8-byte `HMAC(K_pair, "pres-mac\|" + day + "\|" + hex(slot) + "\|" + status)` at the real slot, random elsewhere. Public: one slot is `SHA-256(sitePub)[:8]`, `auth` is an ECDSA signature by the site key over `"mw-pres-v1\n" + hex(slots) + "\|" + status`. | One frame can carry one 64-byte authenticator; building per neighbour shows each neighbour at most its own slot. Request: add `mw-pres-v1` to R 2.10.3. |
| D-6 | 2.7.3: HOLDING = `frameId (32) \| expiry (4)` "routed back toward the depositor as ENV-sized padding" | Body `tag (8) \| frameId (32) \| expiry (4, Unix seconds) \| zero padding` = 357 bytes, so the frame is 371 bytes like the smallest ENV. It travels back along the path recorded in the seen-set (each relay remembers which wire a frame came from), hop at most 4, stamp 10 bits. | The reverse path is the only route a relay knows; the tag is carried for interest routing later. |
| D-7 | 2.7.3: HELD = `count (1) \| ENV bodies` | HELD items are complete ENV or SIG frames (14-byte header with the stamp, then the body), each prefixed by a 2-byte length; at most 32 items; each item is checked like a relayed frame (day, stamp). | The recipient needs the header to check the stamp and to compute `frameId` for COLLECTED. |
| D-8 | 2.7.3: XX1, XX2, XX3 "each at most 256 bytes" | XX bodies are `step (1: 1, 2, 3) \| Noise message`, at most 256 bytes in all (65, 162 and 97 bytes of Noise message with empty payloads). | One frame type for three messages needs the step. |
| D-9 | 2.7.3: INBOX-CHAL "32 random bytes" / INBOX-RESP "ECDH-based proof" | ICHAL = `challenge (32) \| hepk (65)` (a fresh ephemeral key of the mailbox); IRESP = `ek (65) \| proof (32)`, `proof = HMAC(ECDH(chatKey, hepk), "mw-inbox-resp\|" + hex(challenge) + "\|" + ek)`. The mailbox then releases the stranger mail of `ek` for day - 1 to day + 1. | The proof needs a mailbox key to run ECDH against; the response necessarily tells the mailbox which chat key collects (it already sees the tags). |
| D-10 | 2.7.5: "Holders delete on COLLECTED" with proof `HMAC(K_pair, "collected\|" + frameId)` | The proof is sent as specified, but a holder cannot check it (it does not know `K_pair`). A holder deletes only for a wire it handed that frame to (HELD) in the last 10 minutes. | See open item O-1. |
| D-11 | 2.7.3: stranger stamps at "the recipient's `chatBits`" | Relays and recipients use the site's `_mw.cfg.chatBits` (default 20, bounded 10 to 32). | A relay does not know who the recipient is; `chatBits` is a site setting in 2.5.5 (`ledger-admin cfg --requests on --chat-bits 20`). |
| D-12 | 2.7.4: plaintext `flags (1)` | Plaintext flag bit 0 marks the stranger layout (CK and auth present); a contact-tag frame with it set, or an inbox-tag frame without it, is refused. | The layout must be known before parsing. |
| D-13 | 2.7.4: ROOM signature over `"mw-room-v1\n" + ledgerId + "\n" + room + "\n" + id + "\n" + t + "\n" + SHA-256(text)` | As written, with `id` the 22-character b64url string of the 16 bytes, `t` in decimal and `SHA-256(text)` as lowercase hex; a ROOM frame also carries a 10-bit relay stamp; relays forward it only after the four checks of 2.7.4 pass. | Exact encodings for interoperability; rooms must not be a flood path (MF-32). |
| D-14 | 2.11.2: `dm.send -> { id, state }` | `state` at return is `'outbox'` for contacts (waiting for the ACK or a HOLDING; later `'delivery'` events say `'delivered'` or `'handed'`), `'sent-unknown'` for strangers; `'not-delivered'` is reported when the outbox stops (chat off or page closing) with a message that never left. `chat.group.send` returns `'sent-unknown'` or `'not-delivered'`. | The state can only be what the protocol knows at that moment (MF-35). |
| D-15 | 2.11.2: `mw.chat.direct.connect(pub)` (P2) | Non-contacts get `E_NOT_CONTACT`; contacts get `E_PEER_UNREACHABLE` ("not available in this version"). No `RTCPeerConnection` is created. SIG frames are parsed and bounded but not acted on. | Direct channels are P2 (2.7.8). |
| D-16 | brief: `registerWireExtension(..., { swarms: ['rendezvous'] })` | `{ swarms: ['rendezvous', 'chat'] }` | The separate chat lane's wires are kind `'chat'` in the loader; without it mw_chat1 would never run on the lane it joins. |
| D-17 | 2.11.2 codes | Besides the chat codes, the service uses `E_NEEDS_GESTURE`, `E_USER_CANCELLED` (a card was declined), `E_NOT_SIGNED_IN` (no working keys) from 2.11.2 and the existing `E_BAD_REQUEST` (malformed parameters). Follower tabs get `E_POLICY` for everything except reads. | Every failure needs a code the SDK already knows. |

## Open items and requests to other lanes

- **O-1 (design, for the review round):** COLLECTED cannot be verified by a holder. With the current rule a collector
  that asked for a 1-byte prefix bucket can delete every frame of that bucket it was handed. A fix needs a commitment
  the holder can check, for example the sender placing `SHA-256(HMAC(K_pair, "collected|" + frameId))` in the frame;
  that changes the ENV layout, so it is left to the owner and the review.
- **O-2 (integrator, LOCK):** `test/vectors/chat.json` is new. `test/unit/formats-vectors.test.mjs` lists vector files in
  `FILES` and fails on any unlisted file (it fails the same way for identity, ledger, media and signin). Add
  `'chat.json'` to `FILES` and append these lines to `test/vectors/LOCK.json` (not edited by this lane):

```
{"file":"chat.json","id":"chat-frame-001-collected","sha256":"4a09923554e5132a5bb4c98a2226868f6214022f6fedfc2f9700655b463cea95"}
{"file":"chat.json","id":"chat-stamp-001-bits10","sha256":"87e4fc6d6612be98c8a5ff8c45e2832101b16d3e93da99b9e6f272582be1072f"}
{"file":"chat.json","id":"chat-pair-001","sha256":"4d844da49ec6e770737604ff9c9f6587e279c447e3b1da64d00c129955b7e352"}
{"file":"chat.json","id":"chat-dm-001-contact-256","sha256":"6f269bd840183954bae5cdebdd4d9c3de98eb6c2d3ac9b2622ba351c71c94528"}
{"file":"chat.json","id":"chat-dm-002-stranger-1024","sha256":"9a99215347539ecbb9965d94e1b3c9585afd5612628410e73fdd990748f2ff26"}
{"file":"chat.json","id":"chat-sizes-001","sha256":"ab9bb25d7bb5466cacb5e57c8281b02304e66e72f5b1b94fbe65aef09ab87bff"}
{"file":"chat.json","id":"chat-noise-001-xx","sha256":"201e942a0dfd200f0467d3d768844a91c3ea621a8329a0b788ff62c2a35e3195"}
{"file":"chat.json","id":"chat-group-001-epoch","sha256":"a5e801863838ea5743b9c4a59bac3e92e8d6448b3cb29a254e5934b59ee5f397"}
```

  The vectors hold throwaway P-256 private keys made only for these vectors.
- **O-3 (lane sdk / A1):** mount `createChatService(deps).methods` for every `chat.*` method; parameters are objects
  (INTERFACES v0.3 `service.js`); `ctx.activation` must be the loader-verified click; `deps.prompt(kind, data)` must show
  the loader's own card for the kinds listed there and resolve `true` only on the person's input; `deps.store` must be
  the vault-sealed store (contacts, counters, group secrets and the replay filter go there; history only when the person
  chose keep history); `service.setVisible(bool)` on visibility changes; `deps.shareOnNetwork` for Android.
- **O-4 (identity lane, WorkingKeys):** the service reads `keys.pub`, `keys.sign(bytes) -> Uint8Array(64)` and a chat key
  as `keys.chat = { pub, ecdh(pub) }` (or `keys.chatPub` with `keys.ecdh(pub)`).
- **O-5 (lane tools, fuzz):** targets `frames.decode` (every numeric field at 0, -1, 2^53-1), `XXHandshake.next`,
  `seal.decodePlaintext`, `seal.openDm`, `groups.GroupState.receive`.
- **O-6 (integrator, E2E):** E-CH-1 to E-CH-12 and E-SO-8; delivery strings ship only after G-CH-1 and G-CH-3.
- **O-7 (phones, G-CH-6):** stranger stamps are minted inline with the synchronous SHA-256 (yielding every 16 ms); at 20
  bits that is about a million hashes. Routing it through the PoW worker is a later change; nothing is measured yet.
- **O-8:** `_mw.cfg.requests = 'introduced'` (2.17.2) is treated like `'on'`; introductions are not built.
- **O-9:** group lanes (a group's own swarm while its view is open) are not joined; groups ride the chat lane by tag.

## Constants (all in `src/chat/limits.js`)

Frame cap 16,384; HELLO 512; XX 256; CK 400; buckets 256, 1,024, 4,096, 16,000; hops 4 (ENV) and 3 (ROOM); stamps
10 / 20 bits; 20 strikes; decrypt 50 per wire and 200 per tag per second; seen-set 20,000 or 10 minutes; jitter 0.5 to
3 s; relay 64 KiB/s desktop, 8 KiB/s and 2 MiB on Android after the choice, nothing on iOS; holders 7 days, 64 per tag,
4 MiB, 1/8 per source; ACK delay 2 to 20 s; hold after 30 s; CK 90 days; replay window 7 days and 5 minutes back,
5 minutes ahead; Bloom filter 8 KiB per day with 7 hashes; groups 32 members, 7-day grace; rooms 10 per 10 s.
All "chosen" values come from R; none of the throughput numbers is measured.

## Tests

`node --test test/unit/chat-*.test.mjs`: 60 tests in 8 files (frames 9, seal 11, noise 4, replay 6, routing 10,
holder 5, groups 5, service 10), about 3 s. `node tools/lint-floor.mjs`: clean.

## Code review v0.3 (round 2, 2026-10-21): what changed after the build

The area fixer (lane chat-calls-media) and the integrator changed these contracts; INTERFACES and ARCHITECTURE 15.6, 15.7 and 15.19
carry them, and the review's record is [review/DESIGN-REVIEW.md](../review/DESIGN-REVIEW.md), section 8.

- **Concurrent rekeys (R 2.7.7, amended):** removals win, then the largest removal set, then `SHA-256(prev | creator)` (`tieKey`), then
  `epochId`; a sibling only while its parent is current or within 7 days of its replacement; a second genesis is refused. Group frames
  count only from members of the current epoch after the union of removals, and under a replaced epoch only up to `replacedAt` plus
  5 minutes (`GROUP_SKEW_MS`).
- **GroupState v2 persistence:** `toJSON`/`fromJSON` keep every epoch of the grace window and the parents siblings are checked against;
  the v1 format still restores. `readopt()` lets a member who missed epochs take a later one from an admin of its current epoch.
- **Invites are ACKed** (the admin's outbox stops resending them); a replayed copy of a delivered message gets its ACK again (at once,
  then at most once a minute per id); delivered ids are persisted.
- **HELD day window:** `_onHeld` takes HELD frames whose day is within the 7-day hold (`dayWithin`); the interest includes contact tags
  of day-7 to day-2 for held frames and WANT-TAGS only (`heldDays`).
- **Contacts' and members' CK records persist** in the sealed store and are verified again at enable.
- **The CK cache (integrator, MF-20):** `CkCache({ rotated })` refuses a CK whose signer the ledger shows as rotated away (`ck-rotated`)
  and drops one cached before the rotation arrived; an epoch jump above 1 (plus one per CK lifetime since the cached one was taken,
  `CK_EPOCH_STEP`) is not taken (`ck-epoch-jump`); no epoch above `CK_EPOCH_MAX` (2^20). Neither refusal strikes the wire (an honest
  neighbour's ledger copy may lag). `ckFor` ignores the ledger copy of a rotated-away key.
- **Clock-aware fallbacks (integrator):** without the node's own `roleOf` and `isBanned`, the service reads the reduced state with
  its clock (`roleOf(pub, st, now())`, `isBanned(pub, st, now())`): `policy.banned` holds permanent bans only since the ledger-tools fix.
- **A frame right behind a CK frame (integrator, found by the unit runs under load):** the lane awaits the `ck` listeners
  (`_emitWait`) before it reads the wire's next frame, `onCk` awaits `refreshInterest(true)`, and a refresh that a later one replaced
  waits for that one. Before, a SIG or a message sent right behind a CK frame was read before the interest held the pair's tags and
  was dropped as nobody's (a call's first ring was lost).
- **HOLDING counts once per neighbour wire**, and the delivery string reads as reported: "{count} peers reported holding it at {time}.
  They may go offline." (`DELIVERY_TEXT.handed`, still behind `STRING_FLAGS.deliveryStates`).
- **Open, on [ROADMAP.md](../ROADMAP.md):** refusing `chat.enable` when the site names no STUN list (today the lanes use host candidates
  only, so no shared STUN server learns anything); the pin mailbox has no sender yet (the hub-pin recipe marks it proposed).
