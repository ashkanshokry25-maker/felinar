# Red team: Sybil, spam and flooding (v0.3 proposals against v0.2.1 code)

- **Date:** 2026-10-20. **Attacker model:** motivated, has the public code and the v0.3 design, can run a custom client and a GPU, can open many WebSocket and WebRTC connections, can make unlimited keys (a key is free; a phrase is free).
- **Scope:** fake identities at scale against the hashcash fee, follow and reaction stuffing, ledger bloat to the caps, chat flooding through the relay budget, file-drop floods, tracker and rendezvous abuse, denial of service on a hub and its tracker.
- **Status labels:** `works today` (v0.2.1 code), `works against the proposal` (v0.3 design as written), `blocked by` (named control), `needs measurement`.
- **Numbers:** every figure here is arithmetic from the code constants or a cited doc. Nothing was run on a network. Hash rates of browsers and GPUs are not measured here; the only sourced ratio is SECURITY-MODEL.md (spam row): one RTX 4090 hashes about 1,650 times faster than a browser using five workers on an M3 (RESEARCH-DIGEST verdict 8).
- **Wording:** "no backend", "site ledger".

## 0. Result in one table

| # | Attack | Status | Severity |
|---|---|---|---|
| A1 | Fill the ledger to maxChainBytes for the price of 2^16 hashes per block, locking out every honest writer | works today, carries into v0.3 | blocker |
| A2 | Bypass the per-author throttle by backdating `ts` | works today | major |
| A3 | Ban evasion and unlimited identities (new key, key epoch rotation, per-site derivation) | works today and against the proposal | major |
| A4 | Cleanup cannot keep up: stubs keep `e` bytes, bans are per key, unowned sites have no moderator | works today | major |
| A5 | Reuse one chat work stamp for unlimited messages from unlimited keys | works against the proposal | blocker |
| A6 | Trial-decrypt flood: the stamp sits inside the ciphertext, ECDH runs first | works against the proposal | major |
| A7 | ROOM flood: signature verify has no cap, relay budget has no per-author fairness | works against the proposal | major |
| A8 | Mailbox and holder quota squatting by anonymous senders | works against the proposal | major |
| A9 | Eclipse a visitor with Sybil peers into 3 to 9 slots | works today (partly needs measurement) | major |
| A10 | Rendezvous poisoning on public trackers | needs measurement | major |
| A11 | Offer and ICE flood aimed at visitors | needs measurement | minor |
| A12 | Verification CPU asymmetry (cheap valid-PoW, costly signature check) | needs measurement | major |
| A13 | Reaction and follow stuffing, and `put` key overwrite | works today | major |
| A14 | File-drop floods: fake listings, preview-triggered downloads, seeding drain | works against the proposal | major |
| A15 | Denial of service on the pin node, web seed host and tracker | needs measurement | minor |
| A16 | Signup and nonce flood against server-backed sites using the sign-in format | works against the proposal | major |
| A17 | TURN open relay abuse (D-C8 option a) | works against the proposal | major |
| A18 | Fabricated "who is online" presence and look-alike display names | needs measurement | minor |

## 1. The facts every attack leans on

1. **The fee is the only cost of a key.** Defaults: `bits: 16`, `maxValueBytes: 2048`, `maxChainBytes: 8388608` (`src/chain/block.js:43-50`). 2^16 = 65,536 hashes per block. A new key has no history, deposit or age.
2. **Open sites and unowned sites accept anyone.** `writers: 'open'` is a policy choice; an unowned ledger is `open` by construction (`src/chain/state.js:58`).
3. **The throttle is local and optional.** `ingressRate: { n: 30, perMs: 600000 }` (`src/loader/config.js:89`), enforced by `_throttleOk` (`src/chain/node.js:753-770`), called at ingest (`node.js:942`, `1012`) and for own writes (`node.js:1275`). "Local, never part of validity" (`node.js:12`).
4. **The cap refuses everyone except owner, moderators and the allow list** (`state.js:769`, `784`; `node.js:984`). It is not reclaimable by deleting: a tombstone drops `v` and `z` and keeps `{ e, h, s }` (SECURITY-MODEL, deleted-post row).
5. **Peers per swarm are few.** Ledger rendezvous swarm: soft 6, hard 9 on desktop; soft 3, hard 5 on mobile (`src/loader/config.js:71`); content swarm maxConns 30 desktop, 4 to 8 mobile (`config.js:58-61`); `numwant` 2 to 3.
6. **Public trackers.** Four default WebSocket trackers (`config.js:19`); the rendezvous infohash is `sha1("mw-ledger/1/" + ledgerId)` (`torrent.js:203-208`), so anyone with the ledger id can announce to it.
7. **The v0.3 design adds free writers.** Sign-in creates a per-site key with no cost beyond the first block's fee; the record, chat-key (`mw.ck`) and file-listing (`mw.files`) appends all use the same 16-bit fee (IDENTITY-AUTH-DESIGN 3.2; REALTIME-AND-FILES-DESIGN 3, 6.4).

## 2. Attacks

### A1. Ledger bloat to the cap (works today, carries into v0.3) - blocker

- **Preconditions:** a site with `writers: 'open'` (or an unowned ledger). Public ledger id.
- **Steps:** (1) Generate keys. (2) Build blocks with the largest legal payload: `v` of 2,048 bytes plus `e` and `z`, near 3 KB each (estimate; the hard ceiling is `maxBlockBytes` 4,096, `block.js:33`). (3) Mine each at 16 bits. (4) Push to any peer; they gossip it on. 8,388,608 / about 3,000 is about 2,800 blocks, so about 1.8 x 10^8 hashes in total (arithmetic). At the 64 MiB ceiling (`LIMITS.maxChainBytesCeiling`) about 22,000 blocks, about 1.5 x 10^9 hashes. By the sourced ratio a GPU does this far faster than the browser an honest writer uses.
- **Gain / harm:** every honest writer gets `E_CAP` (`state.js:769`). Sign-in records, chat-key records (`mw.ck`, needed before anyone can be messaged) and file listings all fail, so v0.3 features die with the guestbook. Every future visitor downloads the junk (snapshots, sync): a permanent size tax. Stubs survive deletion (fact 4). Scales with GPU time only; one attacker, one afternoon.
- **Not stopped by:** the fee (a fee, not a boundary; SECURITY-MODEL says so), the throttle (A2), bans (A3, A4), moderators (A4).
- **Cheapest defences**
  1. **Reserved pools (deterministic, no new trust).** Split `maxChainBytes` in two: a vetted pool (owner, moderators, allow list, and keys with a moderator voucher) and an unvetted pool of at most 25% for everyone else. A flood fills only the unvetted pool; sign-in records of vetted members and moderation keep working. Cost to honest users: on a flooded open site, new strangers see `E_CAP` earlier; vetted users see nothing. The cap check is already view-local (`node.js:984`), so this adds no new consistency problem.
  2. **Per-key byte quota in total order** (e.g. 32 KiB per author, counted in the reducer): stops one key from taking the pool, does nothing against many keys. Pair with 1.
  3. **Rate-based fee, owner-set:** owner raises `bits` when `bytes` grows faster than a threshold (policy tightening already governs concurrent writes, so a pre-mined stockpile does not survive; `state.js` header, lines 31-35). Cost: honest phones pay more per write; each +1 bit doubles it. Memory-hard work (Argon2id) narrows the GPU gap but costs honest phones memory; needs measurement.
  4. **Recovery path:** the reserved `checkpoint` op or a signed pointer move to a new ledger id seeded from vetted content. Without it an owner cannot shed junk at all. Cost: owner effort, one-time re-link for visitors.
- **Residual:** the owner of a flooded open site must switch to `allow` or vouching; open writing without a gate is not safe against a determined attacker, and the docs should say so.

### A2. Throttle bypass by backdating `ts` (works today) - major

- **Steps:** set `e.ts` to any minute older than `now - 10 min` (validation only demands a non-negative multiple of 60,000; `block.js:308`). `_throttleOk` returns true for it: `if (b.e.ts < now - rate.perMs) return true; // history, as claimed by the block` (`node.js:757`). It is not recorded. A custom client sends unlimited blocks per key. Arrival time is never used for remote blocks.
- **Harm:** the 30-per-10-minutes limit in SECURITY-MODEL (spam row) does not exist against a custom client; A1 needs fewer keys. No other control reads `ts`, so the lie is free.
- **Fix:** for remote live blocks charge by arrival time, not claimed `ts`. Exempt only blocks that arrive in a sync session this node opened (`snapshot` mode and WANT-answered blocks), and still bound those by the byte pools in A1. Cost to honest users: none for live writing; a late-syncing laptop is billed against the byte pool, not the rate.

### A3. Ban evasion and unlimited identities (works today and against the proposal) - major

- **Steps:** a moderator bans key K (`state.js:760`; ban is per author key). The attacker mines a fresh key (no registration) and continues. In v0.3 the derivation tree makes this routine: per-site keys with an `epoch` (IDENTITY-AUTH-DESIGN, `keys:<ledgerId>` record `epoch`, line 63) so rotating the epoch yields a new site key from the same root; a new phrase yields a new root. Per-site derivation is deliberate (unlinkability), so the site cannot tie keys together. The "use the same identity here" choice is opt-in by the person and the attacker simply never opts in.
- **Gain / harm:** bans cost the attacker one block's fee; moderators pay human time per key. Sybil keys also defeat per-key quotas and reputation counts.
- **Cheapest defences:** (1) on abuse-prone sites set `writers: 'allow'` and admit people with an owner or moderator action (the 1,000-entry `maxAllow` and 50 `maxModerators` limits, `block.js:39-40`, bound this); (2) let moderators vouch (a new signed control op, or a `put` under `_mw.vouch` which moderators already may write per `state.js` underscore rule) and show unvouched keys behind an "unvetted" fold, never hide them; (3) never claim an identity is one person (the design already says keys are not people; keep it in the card text). Cost: vouching adds friction for first-time posters, and a moderator becomes a bottleneck.
- **Not available:** proof of personhood without leaking identity. Passkey attestation would give scarcity but links people across sites and is not in the design; say so rather than imply sybil resistance.

### A4. Cleanup cannot keep up (works today) - major

- **Steps:** attacker uses one block per key (A3). A moderator tombstones or bans each: a ban block is about the size of an `e` (a few hundred bytes), and ban removes all payload values of that key (`state.js:33`), but the stub stays. Bulk action does not exist: no ban by pattern, no range tombstone. On an unowned ledger there is no moderator at all (`unmoderated`, `state.js:843`).
- **Harm:** moderation scales linearly in human time against attacker scaling in GPU time. After cleanup the ledger is still bigger than before (stubs plus ban blocks).
- **Defence:** a `tombstone` that names a set of authors or a depth range for moderators (one control block, deterministic), plus the checkpoint path in A1. Cost: one more control op and test vectors; honest users see nothing.

### A5. One chat work stamp serves unlimited messages and keys (works against the proposal) - blocker

- **Design text:** stamp = `leadingZeroBits(SHA-256("mw-stamp-v1|" + recipient ek + "|" + day + "|" + nonce)) >= chatBits`, default 20 (REALTIME-AND-FILES-DESIGN 5.6). The hash covers recipient key, day and nonce only. It does not cover the sender key, the message, the envelope or a counter.
- **Steps:** (1) Read every member's `ek` from `mw.ck` (public). (2) For each, find one nonce: 2^20 = 1,048,576 hashes per recipient per day. For 1,000 members about 1.05 x 10^9 hashes per day, once. (3) Attach that stamp to every envelope to that member from every key for the rest of the day. Nothing ties the stamp to a message, so it is a day pass, not a per-message fee. Anyone who sees it on the wire can copy it too.
- **Harm:** the only stranger-spam control (design says "a fee, not a defence") costs the attacker nothing per message. The message-requests inbox fills; stored requests grow on the victim's device with no stated cap.
- **Fix:** bind the stamp to the frame: `SHA-256("mw-stamp-v2|" + tag + "|" + epk + "|" + sha256(ct) + "|" + nonce)`. Then each envelope costs 2^bits hashes. Keep it outside the ciphertext (A6). Add a cap on the requests inbox (e.g. 200, drop oldest) and a per-sender-key cap. Cost to honest users: a first message to a stranger pays the full stamp (unmeasured on phones, G-CH-6); contacts pay nothing.

### A6. Trial-decrypt flood (works against the proposal) - major

- **Steps:** stranger tags are public: `tag = SHA-256("mw-inbox-v1|" + ek + "|" + day)[:8]` (5.3). Send ENV frames carrying the victim's tag with random `epk`, `iv`, `ct`. The victim must run ECDH P-256 and AES-GCM to learn it fails. The stamp is described as carried "in the message", i.e. checked after decrypt. The cap of 50 decrypt attempts per peer per second (4.2) is per wire; a victim with 9 desktop wires or 5 mobile wires faces 450 or 250 attempts per second if the attacker holds those wires (A9).
- **Harm:** CPU and battery on the target; legit envelopes dropped when the cap is hit (the cap does not distinguish tags).
- **Fix:** put the stamp in the cleartext frame header and verify it (one SHA-256) before any ECDH; check the cap globally per tag, not only per wire; drop frames whose stamp day is not today or yesterday. Cost: the frame header shows a stamp nonce (already derivable, so no new leak).

### A7. ROOM flood and relay crowd-out (works against the proposal) - major

- **Steps:** ROOM frames are signed plaintext relayed with hop limit 4, dedupe by hash (4.1). Open rooms (`chat: 'open'`) accept any key; `members` requires a ledger writer, which on an open site is any key that paid one 16-bit fee (A1). The attacker generates keys and floods 64 KiB/s into each attached wire (the unsolicited budget; `gossip.js:77`, and the chat budget in D-C3). (a) Each frame needs an ECDSA verify; the design caps decrypts (50/s/peer) but states no cap on room signature checks: at 64 KiB/s and about 200 bytes per frame that is about 320 verifies per second per wire (arithmetic). (b) The relay budget of 64 KiB/s per peer is shared by all frames from that peer; there is no fairness per author, so flood frames crowd out legit ones. On mobile the budget is 8 KiB/s and 2 MiB per session, so a flood exhausts the session budget quickly.
- **Harm:** chat unusable on the flooded site; battery drain; peers marked invalid only when frames are malformed (20-invalid rule), not when they are valid spam.
- **Fix:** cap verifies per wire per second (e.g. 30), apply per-author token buckets before verify using the cheap claimed author field (the frame stays unverified but a cheap-first check bounds work), require a ledger-writer role proof (the author's latest ledger block hash) for `members` rooms, ban cache from the ledger, and mute locally with one tap. Cost: honest bursts in a busy room are slowed to the bucket rate.

### A8. Mailbox and holder quota squatting (works against the proposal) - major

- **Steps:** holders keep envelopes for 7 days within quotas (5.7). Senders are anonymous by design (ephemeral `epk`). An attacker sends many envelopes with random 8-byte tags to every holder, filling quota. The holder cannot attribute them, so quota is global or per wire, and per-wire is defeated by A9 or by many wires.
- **Harm:** offline delivery silently stops ("not delivered", the design's honest state), or legit mail is evicted. The owner's pin node mailbox has larger quotas and one operator, so it is a better target: one pipe to fill.
- **Fix:** holders only accept envelopes with a valid frame-bound stamp (A5) and keep per-tag and per-stamp-day caps; evict by stamp work, not by age. Cost: offline messages to strangers cost the full stamp; contacts could use a cheaper contact-derived MAC tag.

### A9. Eclipse by Sybil peers (works today; harm needs measurement) - major

- **Steps:** the rendezvous swarm id is public (fact 6). The attacker runs hundreds of cheap browser or headless peers, announces them, and answers every offer. With soft 6 / hard 9 desktop, soft 3 / hard 5 mobile (fact 5), and numwant 2 to 3, an honest visitor's few slots can all be attacker wires; first-come wires are kept for the session. Attacker peers pass the owner HELLO check (the owner key is public) and then withhold: blocks, bans, tombstones, policy changes.
- **Harm:** the visitor sees a stale ledger. A policy tightening (the owner's reaction to A1) and moderation never reach them, and the site looks healthy. Chat and file lanes ride the same slots. Combined with A6 it gives the attacker the whole decrypt budget.
- **Existing mitigation:** none specific; snapshots (`cs=`) and the web seed supply history but not fresh blocks. Wire guards limit size, not diversity.
- **Defence:** (1) keep one slot for a peer that has recently delivered a new valid block and rotate one slot at random every few minutes; (2) persist good peers' ids from the last visit and try them first; (3) let the owner publish a periodic signed head beacon at the web host (the reserved `checkpoint` op), so a visitor can tell "I am behind"; (4) show a stale warning when the host's beacon is newer than what peers give. Cost: a little more connection churn, one small signed file the owner republishes, and the UI shows "possibly out of date".

### A10. Rendezvous poisoning on public trackers (needs measurement) - major

- **Steps:** announce thousands of fake peer ids to `sha1("mw-ledger/1/" + ledgerId)` on each default tracker. Honest announces with numwant 2 to 3 get offers sent mostly to dead ids; the tracker forwards offers to random swarm members. Honest peers find each other with probability about live / (live + fakes).
- **Why unmeasured:** whether the four trackers cap peers per infohash, expire dead sockets quickly or rate-limit announces is not in this repo.
- **Harm:** new visitors cannot find peers; the site degrades to host-only (web seed plus snapshot). Same for the chat lane infohash, which is one more target (D-C1).
- **Defence:** signed `tr=` list lets an owner add an own tracker (exists, `torrent.js:84-91`); persist good peers (A9); allow PEX from existing peers (ut_pex) to bootstrap without the tracker; ship the failure row ("tracker-unreachable", `torrent.js:175-190`) so the visitor knows. Cost: the owner runs a tracker if they want robustness, which is a backend; label it.

### A11. Offer and ICE flood aimed at visitors (needs measurement) - minor

- A hostile announcer asking for a large numwant makes the tracker forward offers to honest peers; each offer may allocate an RTCPeerConnection before the post-handshake cap drops it (caps apply "after the extended handshake", `torrent.js:29-31`). Measure CPU and memory per refused connection on a phone. Defence if real: drop offers when at the hard cap before creating a peer connection.

### A12. Verification asymmetry (needs measurement) - major

- **Steps:** validation order is shape, hash, PoW, signature (node.js header). An attacker mines 2^16 hashes per block (cheap by GPU) and attaches valid signatures from fresh keys. Every block costs the victim an ECDSA verify in the pool of 2 workers (`verify-pool.js`) before admit or the throttle runs (`node.js:942`, `1012` come after verification). Per-peer unsolicited budget 64 KiB/s (`gossip.js:77`) allows many small blocks per second per wire; 50 invalid strikes ignore a peer, but valid-signature spam is not invalid (`gossip.js:616-619`).
- **Harm:** battery and CPU; honest blocks queue behind junk.
- **Defence:** check `admit` and the throttle (including cap and writer rules) before the signature; only the PoW needs to precede. Cost: none for honest users, since policy checks need only the unverified author field and a failing signature later gets the block dropped.

### A13. Reaction and follow stuffing, and `put` overwrite (works today) - major

- **Context:** the code has no reaction or follow primitive. Apps will build them from `append` and `put`.
- **Stuffing by one key:** `append` has no uniqueness rule; a "like" is an append of the target hash. One key writes unlimited likes (A2 removes the throttle). Counting distinct authors helps only until A3.
- **Overwrite:** `put` is last-writer-wins across authors in total order (`state.js:564`). A key such as `like:<h>:<pub>` is not owned by `<pub>`; any writer can overwrite it or set it to null. The IDENTITY-AUTH-DESIGN notes this for records (section 3.2) and chooses `append`; the SDK still offers `put` to apps.
- **Follow spam:** an app that notifies on follow lets the attacker spam a person with N fake followers at N fees.
- **Defence:** (1) an SDK helper and a reducer rule for author-scoped keys (key must begin with the author's key hash; others' writes refused); (2) docs that say counts from open sites measure fee-paying keys, not people; (3) show counts from vetted keys only when a site uses `allow` or vouching (A3); (4) never notify on follow from an unvetted key. Cost: a small reducer rule and a changed key convention; apps lose "global like counter" simplicity.

### A14. File-drop floods (works against the proposal) - major

- **Steps:** (a) Spam fake listings: `mw.files` appends are just a fee and a shape (`ih`, `len`, `name`, `mime`, `sha256`); nothing proves any peer holds the infohash, so listings of nonexistent files fill the directory and the cap (A1). (b) Previews: images decoded on listing view could trigger downloads of whatever the attacker listed; the design does not say listings never auto-fetch. (c) Seeding drain: desktop fetchers re-seed while open (6.5); an attacker lists many large real files hosted by Sybil seeders to drive visitors' bandwidth or storage. (d) Private shares: sealed share offers to a recipient are envelopes (A5/A6) and pile up in the requests inbox.
- **Fix:** the UI never fetches a listing's bytes without a click and shows size first; per-author cap on active listings; listing needs at least one seeder proof (a signed "I seed this" from the author at publish time is the minimum) or is shown as "unconfirmed"; the maximum `len` is checked against the class cap before any request; the public directory is paged and limited, newest-vetted first. Cost: one extra tap per file; fewer visible junk entries.

### A15. Hub, pin node and tracker denial of service (needs measurement) - minor

- A Sybil crowd of readers asks a pin node (`tools/pin.mjs`) or a web seed for full state. The per-peer budget bounds each (solicited 1 MiB/s, egress 768 KiB/s; `gossip.js:79`, `83`; solicited allowance about 17 MiB at 8 MiB cap, `gossip.js:591-595`), not the sum. The pin node's total connection cap is not in the code read here. A static web host takes the same load as any website; the design is not worse than that, and says so. Defence: an explicit total connection cap and a global egress bucket on the pin node; documented host rate limiting. Cost: the pin node drops late visitors in a flood.

### A16. Signup and nonce flood against server-backed sites (works against the proposal) - major

- **Steps:** the published sign-in challenge is SIWE-shaped (domain, ledger id or origin, nonce, issued-at, expiry, statement). Per-site keys are free, so an attacker produces unlimited valid signatures from unlimited keys against a site's verifier. A server that stores issued nonces holds one per request; one that verifies the signature before checking nonce and expiry spends ECDSA per request.
- **Harm:** account-creation spam, nonce-store exhaustion, CPU.
- **Defence in the library:** make nonces stateless (HMAC of server secret, domain, issued-at), check MAC and expiry before the signature, add an optional `difficulty` field in the challenge so a server can demand a stamp bound to the nonce and the public key, and document that the library proves control of a key, not a person, and that server-side rate limits and email or payment gates stay the server's job. Cost: a stamp on signup for sites that choose it.
- **Related and blocked:** a site abusing the loader card with repeated `mw.auth.signIn()` calls is limited by the 10 s card cooldown (`E_RATE`, IDENTITY-AUTH-DESIGN 7). Not a Sybil route.

### A17. TURN open relay abuse (works against the proposal) - major

- D-C8 option (a) puts static TURN credentials in the page, "an open relay for anyone who loads the site; abuse is bounded only by the quotas and the owner's bill" (REALTIME-AND-FILES-DESIGN 9.4). An attacker loads the page, copies the credentials and relays arbitrary traffic or exhausts the quota so legit visitors lose relay. Defence: low bitrate and session quotas, `allowed-peer-ip` ranges (deny private ranges), rotate credentials per release, and prefer option (b) when the owner accepts a small credential endpoint. State both cost and abuse in the consent card. Cost: owner money or a tiny backend.

### A18. Fabricated presence and look-alike names (needs measurement) - minor

- Public presence uses `bid = HMAC(K_site, "pres|" + pub + "|" + day)[:8]` with a key anyone can compute (5.1). If the frame does not carry a signature by `pub`, anyone can list any key as online; even if signed, Sybil keys inflate "online" counts. Profile names are not unique and the validator checks only control and bidi characters (`block.js:188-200`), so "Admin" or a copy of a moderator's name is free. Defence: signed presence only, show key fingerprints next to names in moderation views, and mark moderators from the ledger, not from names.

## 3. Already blocked (for the record)

| Attack | Blocked by |
|---|---|
| Oversized wire frames | 262,144-byte guard (`config.js:42`), gossip frame caps (`gossip.js:66-86`) |
| A peer sending invalid blocks | more than 50 invalid strikes ignore the peer (`gossip.js:82`, `616`) |
| Block forging or edits | hash recompute, PoW, signature, salted value hash (`block.js` header) |
| Pre-mined stockpile released after the owner raises `bits` | a tightening governs concurrent and later writes (`state.js:31-35`) |
| Cap overflow by non-privileged authors | `E_CAP` (`state.js:769`); it is also the lever of A1 |
| Writes from a page at more than 20 per minute | Bridge limit (`bridge.js:40`); a custom client bypasses it, A2 |
| Loader card spam | 10 s cooldown (`E_RATE`) |

## 4. What the owner can honestly claim after the fixes

- An open site on a public ledger stays usable under a GPU-equipped attacker only for vetted users: reserved pools (A1), vouching (A3) and a checkpoint path (A1, A9). Open posting by strangers is a best-effort convenience.
- Counts of likes, followers and online users are counts of keys.
- Offline chat to strangers is rate-limited by work, not blocked; a motivated attacker with a GPU can still send to many members at a price the design should state in the card help.
- Discovery depends on public trackers; the host and snapshot carry history, not live updates.

## 5. Build order (cheapest first)

1. A2 arrival-time throttle (small patch in `node.js`), plus tests with a backdated block.
2. A12 reorder: admit and throttle before signature.
3. A5 and A6 stamp redesign before `mw_chat1` is built; this is a spec change now, costly later.
4. A1 reserved pools and A4 bulk tombstone: one design note, two small reducer changes.
5. A13 author-scoped keys.
6. A9 slot rotation and A10 persisted peers; measure A10 and A11 on the four trackers.
7. A16 stateless nonces in the verification library before it ships.
