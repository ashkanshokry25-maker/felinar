# R8. Realtime chat and file sharing between signed-in visitors, with no backend

- **Track:** v0.3 research, topic realtime-chat-and-files (R8). **Date:** 2026-10-20. **Applies to:** magnet-web 0.2.1 plus the planned v0.3 identity.
- **Builds on (not repeated):** ARCHITECTURE s6.1 (block v1, P-256 identity, `maxBlockBytes` 4096), s6.6 (`mw_chain1` wire extension, frames up to 15 KiB), s8 (four network classes, uploads off on phones, TURN off, two STUN operators), s9 (SDK); SECURITY-MODEL "What is not protected" (IP addresses, confidentiality between peers, takedown); PRIVACY "Recipients register"; research w2c-03 (identity UX); R6 (legal: F1 erasure, F3 controller, F9 DSA and OSA, F11 encryption law).
- **Method:** primary pages opened with WebFetch on 2026-10-20 where a URL is given with "(opened)". Items marked "search snippet only" come from a search result and were not opened. Items marked "from knowledge, not re-checked" are background and carry no weight in a recommendation. No browser was launched.

## Summary

1. **Put nothing conversational in the site ledger.** The ledger is replicated to every visitor, hash-linked and cannot be erased from peers that already hold a block (SECURITY-MODEL, R6 F1). Message bodies, presence, typing, receipts, DM envelopes, private-share recipient lists and wrapped file keys must never be written to it. It may hold only public, long-lived facts: a visitor's chat key binding (a signed ECDH public key), a public file listing, and moderation actions.
2. **Transport: add a second wire extension, `mw_chat1`, on a separate chat swarm, and keep `mw_chain1` untouched.** A separate swarm makes chat opt-in (readers who never enable chat never join it) and keeps chat traffic off the ledger rendezvous swarm. The loader already guards wires at `CONFIG.wire.maxMessageBytes` = 262,144 (src/loader/torrent.js); the new extension must live under the same guard and its own frame cap (recommend 16 KiB).
3. **Raw WebRTC data channels are an optional second tier, not the base.** They are baseline across browsers since January 2020 (MDN, opened), but every direct channel shows both peers' addresses to each other, SCTP messages above about 16 KB can block other traffic on the association (RFC 8831 s6.6, opened), and brokering them needs signalling. Signalling can ride the existing wires, so the trackers do not see it.
4. **Encryption, v0.3: a sealed-box per message (ephemeral-static ECDH P-256, HKDF-SHA-256, AES-256-GCM), with the sender's signature inside the ciphertext.** WebCrypto already provides every primitive and the identity is already P-256. It has no forward secrecy against theft of the recipient's long-term chat key. State that plainly. Use a separate ECDH chat key bound to the identity by a signature, not the ECDSA signing key itself.
5. **Do not ship the Signal double ratchet or MLS in v0.3.** The official libsignal is Rust with Java, Swift and Node bindings, AGPLv3, and its README says use outside Signal is unsupported and APIs may change without notice (opened). It lists no WebAssembly or browser target. The one MLS library found for browsers, ts-mls, supports the P-256 suite but says it has had no audit (opened). Plan a hash-ratchet pairwise tier for v0.4 and treat MLS as a gated later option.
6. **Offline delivery is best-effort and must say so.** Peers can hold opaque sealed envelopes under a rotating mailbox tag for a short time. On a small site there may be nobody online to hold them. The honest options are: deliver when both are online, a holder-peer lane with a 7 day cap, and an owner pin node as a stronger but IP-visible mailbox. Briar uses a separate Mailbox for the same problem (opened).
7. **Metadata is the hard part and cannot be removed.** Peers and relays see IP addresses, timing and sizes. Trackers and STUN see swarm membership. Tor does not carry WebRTC (UDP), so it cannot hide a browser's WebRTC addresses; TURN can hide them from the other peer but moves trust to the TURN operator. Mitigations that do exist: secret-derived swarm ids for private groups, size padding, rotating mailbox tags, opt-in presence, relay-only mode.
8. **Spam control without accounts: layered, and the hashcash fee is only one layer.** Contacts and allow lists first, per-message work for strangers (cost 2^bits hashes on average), receiver-side blocking, owner/moderator bans for public lanes. Unsolicited first contact is the weak point of every system studied (NIP-17 says so itself, opened).
9. **Files: encrypt first, then torrent, and reference by infohash.** The uploader seeds from the browser; fetchers re-seed while the tab is open; when everyone leaves the file is gone unless the owner pins it. Public files get a ledger listing (about 150 to 400 bytes); private files get no ledger entry at all, and the infohash plus file key travel inside a chat envelope.
10. **Moderation reaches the listing, not the bytes, and E2E private shares are outside the owner's reach.** Tombstoning a listing and banning an author stops cooperating clients. Seeders and the owner carry real legal exposure (R6 F9); the default must be: public file lane off until the owner turns it on, never auto-seed what the visitor did not open, never render uploaded content at the site origin.

## Findings

### F1. What magnet-web already has that chat and files can reuse (files read 2026-10-20)

- **Wires.** WebTorrent exposes each peer as a `bittorrent-protocol` duplex through `torrent.on('wire')` and `wire.use(Extension)` (WebTorrent api.md, opened). magnet-web already adapts `mw_chain1` this way (ARCHITECTURE s6.6; src/chain/wire-ext.js, `EXT_NAME = 'mw_chain1'`). Hostile-frame protection is already there: `guardWire` destroys a wire on a length prefix over `CONFIG.wire.maxMessageBytes` before buffering (src/loader/torrent.js).
- **A rendezvous swarm.** The ledger rendezvous infohash is derived from the ledger id, "a label, not a secret" (SECURITY-MODEL). A chat swarm can be derived the same way from a different label.
- **Policy.** s8 already classifies desktop, mobileUnmetered, mobileUnknown, mobileMetered; uploads are off on phones until "Share on this network" (128 KiB/s). A hidden phone tab locks uploads at once and rebuilds the client on return. These rules decide what chat and presence can do on a phone (F6).
- **Not there today.** No ECDH or X25519 code exists in src (grep of src, 2026-10-20). No TURN (B7: TURN off, two STUN operators). No file lane. The browser-held identity is ECDSA P-256 (s6.1).
- **WebTorrent in the browser.** Browser peers speak WebRTC only and can connect only to WebRTC-capable clients (WebTorrent FAQ, opened). Tracker changes were needed for WebRTC offers. Piece size from `create-torrent` defaults to about 1,024 pieces, capped at 4 MiB (create-torrent README, opened). The v1 infohash is SHA-1 (SECURITY-MODEL lists the weakness).

### F2. Transport options, with measured limits

| Option | What it is | Source of limits |
|---|---|---|
| T-A wire extension `mw_chat1` | Binary frames over BEP 10 on wires of the chat swarm; flood or targeted forward | WebTorrent api.md (opened); magnet-web wire guard |
| T-B WebRTC data channel, signalling over wires | `RTCPeerConnection` per pair; SDP and ICE candidates carried in `mw_chat1` frames | MDN RTCDataChannel (opened); RFC 8831 |
| T-C WebRTC data channel, signalling via trackers | A second swarm id per pair; tracker relays offers | WebTorrent tracker protocol; trackers see the pair swarm id |
| T-D Ledger as transport | Messages as blocks | rejected: permanent, public, 4096-byte blocks, PoW per block |

Facts for the table:

- **Data channel API.** `ordered` defaults to true; `maxRetransmits` and `maxPacketLifeTime` allow unreliable delivery; `bufferedAmount` and `bufferedAmountLowThreshold` give flow control; data channels have been available across browsers since January 2020 (MDN RTCDataChannel, opened 2026-10-20).
- **Message size.** `RTCSctpTransport.maxMessageSize` is read at runtime, so do not hard-code it (MDN, opened; "Baseline since May 2023"). RFC 8831 s6.6: without message interleaving, SCTP "does not support the interleaving of user messages", so a large message can monopolise the association; senders SHOULD limit messages to 16 KB where interleaving is not negotiated (RFC 8831, opened). Design rule: chunk file data at 16 KiB on a data channel.
- **Congestion.** All streams of one association share one congestion window (RFC 8831 s5, opened). A file transfer on the same channel as chat will delay chat; use a second channel or a second connection.
- **Why T-A first.** It needs no new connection, no new permission and no signalling. Messages travel as far as peers are connected. The cost is that intermediate peers carry opaque envelopes and see IPs of neighbours only. The receiver does not learn the sender's IP unless they are direct neighbours. This is an honest advantage over T-B and T-C, where the two ends always learn each other's addresses.
- **Why keep T-B.** Typing hints and larger transfers want a direct pipe, and calls need it. Make it per-conversation opt-in: "Connect directly (shows your IP address to this person)".
- **T-C is not recommended.** Pair swarm ids at a tracker reveal who contacts whom to the tracker operator.

### F3. Presence

- **What the existing code already does.** The ledger gossip sends HELLO every 30 s and on head change (s6.6); the tracker keepalive is an offer-free announce after 55 s of silence (s8, B1).
- **Design.** `PRES` frame: 1 byte type, 1 byte flags, 8 bytes blinded id, 8 bytes epoch counter, 2 bytes status; about 20 bytes plus the BEP 10 framing (6 bytes). At 30 s on 6 wires that is about 5 bytes per second. The cost is the radio waking, not the bytes.
- **Blinded id.** `bid = HMAC-SHA-256(key = contact-secret or site-secret, msg = pubkey || day)` truncated to 8 bytes. Strangers see only a rotating label; contacts who share the secret resolve it. Public presence by raw public key must be an explicit "visible to everyone on this site" toggle, default off.
- **Mobile.** A hidden phone tab is rebuilt and uploads are locked (s8). So: no presence beacons from a hidden tab; send "away" once on `visibilitychange` to hidden; restore on `pageshow`. iOS suspends WebSockets and WebRTC soon after backgrounding and developers report data-only peer connections drop without an active media track (Apple Developer Forums thread 799259 and 716118, WebKit bug 226163; search snippets only, forum posts, not Apple documentation). Do not promise background delivery on iOS.
- **Honest limit.** Presence in any swarm tells every connected peer "this IP is online and is using this site". That is already true of ordinary swarm membership (PRIVACY); presence adds the link to a key.

### F4. Encryption between P-256 identities

- **WebCrypto.** `deriveKey` with `ECDH`, `X25519` and `HKDF` is supported and the page itself shows ECDH to AES-GCM (MDN SubtleCrypto.deriveKey, opened). ChaCha20-Poly1305 is not offered by WebCrypto (MDN supported algorithms, opened); X25519 browser versions must be feature-detected (the page's own example wraps key generation in try/catch). Because the identity is P-256 today, P-256 ECDH is the zero-dependency choice. IMPROVEMENTS-DIGEST row 13 already notes the WebCrypto-native construction is acceptable with a fresh ephemeral key per message.
- **Key separation.** Use a separate ECDH key pair for chat. Publish in the profile record `{ ek: <p256 ECDH pub, 65 bytes raw>, sig: <ECDSA by the identity over "mw-chat-key-v1" || site || ek>, exp }`. About 65 + 64 bytes, about 175 characters base64url, fits `maxValueBytes` 2048. Rotate on a schedule; old keys remain valid for decrypting until deleted locally.
- **Message construction (S1, sealed box).**
  ```
  frame = 0x01 | v | tag(8) | epk(65) | iv(12) | ct(n + 16)
  ct    = AES-256-GCM(key = HKDF-SHA-256(ECDH(esk, rek), salt = tag, info = "mw-chat-v1" || site || sender_hint), plaintext = padded(body || sender_pub || sig))
  ```
  Overhead for a 1 KiB padded body: 1 + 1 + 8 + 65 + 12 + 16 = 103 bytes plus the sender's 64-byte signature and 87-character public key inside the ciphertext (about 150 bytes), so about 1.3 KiB on the wire per padded-1-KiB message. A 3-line message padded to a 256-byte bucket costs about 410 bytes. Padding to power-of-two buckets (256, 1024, 4096) hides length classes. NIP-17 does not mention padding (opened), which is a gap not to copy.
  - Sender authentication is by the signature inside; the outer layer carries nothing that names the sender (same goal as NIP-17's gift wrap, which uses a fresh one-time key per wrap, opened).
  - **No forward secrecy** against a stolen recipient chat key, and no post-compromise security. NIP-17 has the same limit: "any client with the user's private key can recover all messages" (opened).
  - Replay: include a random 128-bit message id inside the plaintext; receivers keep a seen-set per sender for the retention window.
- **Pairwise hash ratchet (S2, v0.4).** After a first S1 exchange, derive `ck0 = HKDF(ECDH(a_static, b_static) || ECDH(ea, eb))`, then step `ck_{i+1} = HMAC(ck_i, 0x02)`, `mk_i = HMAC(ck_i, 0x01)`, delete `ck_i` after use. That gives forward secrecy for messages received after a step but not post-compromise recovery; add a DH ratchet step per round trip to approach the Signal double ratchet. Requires ordered per-pair state in IndexedDB and handling of skipped keys; effort M; custom crypto, so it needs outside review before it is called secure.
- **Signal double ratchet libraries (from searches).** Official libsignal: Rust core, Java/Swift/TypeScript (Node) bindings, AGPLv3, "use outside Signal is unsupported", APIs change without notice, no WebAssembly mention (libsignal README, opened). A 2019 verified WebAssembly implementation (LibSignal*, IEEE S&P 2019) exists as research (search snippet only). The npm `signal-protocol` fork warns it has not been reviewed (search snippet only). Conclusion: no maintained, audited, browser-ready, permissively licensed double ratchet was found.
- **MLS (RFC 9420).** Published July 2023, Standards Track; targets groups of two to thousands; key-update cost scales with the logarithm of group size; gives forward secrecy and post-compromise security; requires a delivery service that orders and routes messages ("largely untrusted") and an authentication service that is assumed trusted; PrivateMessage leaves group id, epoch and content type in cleartext; padding is the application's choice (RFC 9420 datatracker, opened). Libraries: OpenMLS (Rust, MIT) and a developer write-up that compiles it to WebAssembly for a browser (search snippet only, one personal project); ts-mls (TypeScript, MIT, 111 stars, 637 commits at opening, supports `MLS_128_DHKEMP256_AES128GCM_SHA256_P256`, one core dependency `@hpke/core`, P-256 needs `@noble/curves`, Node 20+, "No formal security audit has been performed", ts-mls README, opened). No bundle size is published on the page; measure before adopting.
  - **Fit with no backend.** MLS needs a total order on Commits per group. The site ledger could be the delivery service for handshake messages (small, public ciphertext) but that publishes group ids, epochs and activity times forever. A per-group ordering in the chat swarm needs a rule for concurrent commits. Both are research, not v0.3 work.
- **Group messaging in S1.** Wrap one random content key per message to each recipient: per recipient 65 + 12 + 32 + 16 = 125 bytes (about 167 base64url characters). For 8 members that is about 1 KiB of wraps plus one body ciphertext. NIP-17 sends one event per recipient and says groups above about 10 members "need another scheme" (opened). For larger groups use sender keys (a per-sender symmetric chain distributed by S1 wraps, rekeyed on removal); that scheme lets a removed member read nothing after rekey but everything before.

### F5. Ephemeral versus stored, and offline delivery

- **Default: ephemeral.** A message lives in memory and in the sender's and receiver's chosen local history only. "Nothing stored unless the users choose" means the loader writes no chat plaintext to IndexedDB by default; a per-conversation "Keep history on this device" toggle writes ciphertext under a device-local key.
- **Holder peers.** A sender who cannot reach the recipient floods the sealed envelope with a mailbox tag `mt = HMAC(ECDH(sender_static_hint, recipient_ek), epoch_day)[:8]` to peers; peers that opt in as holders keep it up to 7 days within a quota (suggest 64 envelopes per tag, 4 MiB per holder). The recipient, on joining, announces the tags it expects (a Bloom-style set, 32 tags per frame) and fetches matches. Holders learn tag, size and arrival time, never sender or recipient. Tag rotation per day breaks long-term linkage by holders.
  - Abuse: deposits require the stranger-level work stamp (F8). Quota evicts oldest.
  - **Honest limit.** Success needs some holder to be online both when the sender is and when the recipient returns. On a site with a handful of visitors this often fails; the UI must show "delivered", "held by N peers" or "not delivered", never "sent" alone.
- **Owner pin node as mailbox.** A stronger option for sites that already run a pin node: it sees IPs and tags but not content. Briar does the same job with a Mailbox for users online at different times and says only that it is secure, without detail (Briar how-it-works, opened).
- **What the ledger holds for chat.** Only: `profile` with `ek` and signature (F4); `allow`/`ban` already existing. Nothing else.

### F6. Cost on phones

- Chat on a metered or unknown phone follows the existing four-class policy: uploads off until the visitor chooses to share; chat frames are tiny, but chat flooding makes the phone relay other people's envelopes, which is upload. Give chat its own budget line: relay at most 8 KiB/s and 2 MiB per session on mobile classes, 64 KiB/s on desktop, separate from the file upload rate, and show it in the policy panel.
- Hidden tab: stop holding and relaying (the existing lock does this for uploads); do not attempt to keep sockets alive. Waking a closed page (Web Push) needs a server; the design does not have it.
- Hashcash on a phone: expected 2^bits hashes (not measured here); use the existing worker miner (s6.1) and measure on a low-end phone before setting defaults.

### F7. Metadata exposure, by observer

| Observer | Sees (T-A swarm lane) | Sees (T-B direct) | Mitigation | Cost |
|---|---|---|---|---|
| Neighbour wire peer | IP, that you use the chat swarm, frame sizes and times, opaque envelopes | same, plus that you talk to a named peer | padding, opt-in swarm, host-only mode | none |
| Recipient | the sender's key (after decrypt); sender IP only if a direct neighbour | sender IP always | prefer T-A; TURN relay-only for T-B | TURN operator trust |
| Tracker operator | IP, swarm infohash, announce times | pair swarm id if T-C is used | secret-derived chat swarm id for private groups; avoid T-C | id is not secret for public lanes |
| STUN operator | IP, that a WebRTC session starts | same | already B7: two operators, probe gated by consent | none |
| Holder peer | tag, size, arrival time | n/a | rotating tags | 8 bytes per tag |
| TURN relay (if enabled) | both IPs, bytes, times, not content (DTLS) | n/a | none; this is the trade | cost of running it |
| Network observer | traffic to trackers and peers | same | none in browser | none |
| Malicious visitor in the swarm | list of IPs and keys visible in public presence; can join chat swarm; can flood | n/a | blinded presence; PoW; receiver blocking | see F8 |

- **WebRTC address exposure.** Browsers replace local IPs with mDNS names in candidates, but the public address from STUN is still sent to the peer (Chrome PSA and IETF mdns-ice-candidates draft, search snippets only, 2019 to 2021). `iceTransportPolicy: "relay"` restricts candidates to relayed addresses so the peer does not receive direct candidates (MDN RTCPeerConnection, opened). It requires a TURN server and sends TURN credentials to it (same page).
- **Tor.** Tor does not carry UDP, so Tor Browser disables WebRTC and Tails and Whonix cannot run it (Tor Project forum and issue tracker, search snippets only). A browser tab cannot route WebRTC over Tor. The only Tor-compatible lanes are HTTPS/WebSocket ones: a mailbox through a pin node reached over WebSocket works in Tor Browser without WebRTC, at the price that the pin node sees tags and sizes. magnet-web in Tor Browser would therefore be host-only for peers; chat there needs a WebSocket relay, which is a backend the owner runs. State it.
- **Honest summary.** The design hides content and, in the swarm lane, the sender's IP from the recipient. It does not hide membership in the chat swarm, timing, size classes after padding, or addresses from the first-hop peers, trackers and STUN. No browser-only design can.

### F8. Spam and abuse without accounts

- **Layers, cheapest first.** (1) Contacts: messages from keys the receiver has accepted skip all checks. (2) Allow lists: the owner's `allow` list (up to 1,000 keys, s6.1) and policy `writers` already exist; a site can set chat to "allowed writers only". (3) Stranger stamp: first contact from an unknown key must carry a work stamp at `chatBits` (suggest 20 for first contact, 0 once accepted); expected 2^20, about 1.05 million hashes per message to a stranger. Bind the stamp to `recipient_ek` and a day so it cannot be reused. (4) Receiver controls: block key, mute site, "message requests" inbox that never auto-previews. (5) Rate: per-peer relay budget (existing 64 KiB/s unsolicited style) and per-key quota. (6) Public lanes: moderator `ban` (existing) and tombstone.
- **Limits.** Hashcash does not stop a determined attacker with real hardware and is regressive for phones (Hashcash is a fee, per CRITIQUE row "A proof-of-work fee per message"). NIP-17 says its random wrapper keys prevent reputation-based filtering (opened). Our inner-signature design has the same property: you can only filter after decrypting. Cost of that decryption is one ECDH per frame, so cap attempts per peer per second.
- **Group abuse.** Groups have no admins in NIP-17 ("no moderation", opened). In magnet-web a private group can have an admin key inside the group, not in the ledger; owner moderation does not reach private groups. Public rooms (signed, plaintext, ledger-adjacent) are the ones the owner can moderate.

### F9. File sharing

- **Mechanics.** `client.seed(File)` builds a torrent in the browser; piece length defaults to about 1,024 pieces, max 4 MiB (create-torrent README, opened). Hashing is on the uploader's device; a 100 MiB file takes noticeable time on a phone (not measured here). Pieces are stored by the chunk store: memory or IndexedDB-backed; the project already has memory and blob chunk stores (src/loader). WebTorrent documents `destroyStoreOnDestroy` and says to destroy the store on page close if data must not persist (api.md, opened).
- **What happens when the uploader leaves.** The file stays available only while any fetcher with the full file stays connected. Fetchers re-seed while the tab is open and policy allows (desktop: yes; phones: only after the visitor chooses to share). If no one has all pieces the download stalls. There is no web seed for user files unless the owner adds one. State "files last as long as someone keeps them" in the UI and give the owner a "pin" action (the owner's pin node fetches and seeds).
- **Size limits (proposal).** Public lane: 25 MiB per file, 256 MiB per site, listed in policy. Private lane: 100 MiB desktop, 25 MiB phone. The existing per-site `maxSiteBytes` is 128/48/24/24 MiB by class (s8); the file lane needs its own cap so a shared file cannot evict the site.
- **Encrypted files.** Encrypt before torrenting so the infohash and every piece are ciphertext. Chunked AES-256-GCM in 64 KiB records with a counter nonce and a final-record flag (STREAM construction, from knowledge, not re-checked); file key `fk` random 256-bit; overhead 16 bytes per 64 KiB (0.02 percent). Key delivery: wrap `fk` per recipient with S1 (125 bytes each) inside a chat envelope together with the infohash, length, filename and SHA-256 of the plaintext. Private files get no ledger entry. Anyone who learns the infohash can still download the ciphertext and see size and timing; the infohash is what the swarm keys on, so size and existence are visible to anyone who knows the infohash and to the tracker that sees the announces.
- **Public file listing in the ledger.** One `append` to list `files`: `{ ih (40 hex), len, name (up to 96 chars), mime, sha256 (64 hex), thumb? no, t }` about 250 to 400 bytes, well inside `maxValueBytes` 2048 and a 4096-byte block. The PoW fee applies; moderators and the owner are exempt.
- **Group-shared file (non-public).** `fk` wrapped to the group content key; no recipient list on the ledger. For up to 8 named recipients, 8 x 167 characters is about 1.3 KiB, which still fits a chat envelope but not comfortably a ledger value, one more reason not to put wraps on the ledger (also the permanence argument in Summary 1).
- **Serving rule (security).** In per-domain and drop-in modes site code runs with loader privilege (SECURITY-MODEL). Uploaded bytes must never be served as HTML or script at the site origin: download only, `Content-Disposition: attachment` through the Service Worker, `X-Content-Type-Options: nosniff`, or a sandboxed iframe without `allow-same-origin`. Previews limited to images decoded through `createImageBitmap` and plain text. This is design reasoning from the existing model, not a cited fact.
- **Takedown.** A tombstone on the listing removes `v` for cooperating peers (s6.1); a ban stops the author's writes. The loader should refuse to fetch a tombstoned infohash and stop seeding it. Peers running other software, and devices offline, keep the bytes; the same file can be re-uploaded (SECURITY-MODEL "Takedown"). Say so in the owner guide.
- **Legal exposure (summary of R6, not advice).** R6 F9 and F11: an owner who enables public uploads should assume provider-like duties under the DSA and the UK Online Safety Act where those apply; a design with end-to-end private sharing cannot scan, escrow keys or comply with a scan or decrypt order technically, and the project will not add a back door; owners are probably controllers for personal data posted to an open ledger (Russmedia, C-492/23, 2025-12-02, as cited in R6 F3). Seeders: a visitor who re-seeds a file they fetched uploads bytes of content they did not choose. Mitigation: seed only files the visitor opened or accepted, never unlisted ones; show a one-time notice at first file download. Anyone who knows an infohash and can reach the tracker can list the IPs seeding it (SECURITY-MODEL), so seeders' addresses are discoverable for infringing content; do not claim otherwise.

### F10. What existing systems teach (what was opened versus not)

| System | Relevant design | Lesson for magnet-web | Status of evidence |
|---|---|---|---|
| Keet / Holepunch (Hyperswarm, HyperDHT) | Peers addressed by public key; DHT hole-punching; relaying is opt-in; Keet adds relays through call participants | Topic-based swarm discovery with key-addressed connections is the model for a secret chat swarm; browsers cannot run a DHT or UDP hole-punching, so only the idea transfers | Pear docs (search snippet only); not opened |
| Berty / Wesh | OrbitDB over IPFS; rendezvous points derived from a 32-byte seed plus a time token; replication servers see group id, signature and attachment key only and cannot decrypt; direct transports like BLE need both online; "not thoroughly audited" | Time-rotating rendezvous and untrusted replication holders are the same shape as our mailbox tags and holder peers | Wesh protocol page (opened) |
| Briar | No central server; Bluetooth, Wi-Fi, or Tor when online; Mailbox for non-overlapping online times | Best match for the honesty required about offline delivery; Tor is its metadata mitigation, which a browser cannot use | Briar how-it-works (opened) |
| Session | Onion-routed storage network; Protocol v2 (announced 2025-12-01) re-adds forward secrecy and post-quantum; network migration 2025-05-19; Oxen 11.7 / Session Router 1.1 announced 2026-10-19 | Shows what stronger metadata protection costs: a node network. Out of reach without a backend; also shows PFS was a later add-on | Session blog index (opened, summaries only) |
| Nostr NIP-17 / NIP-59 / NIP-44 | Rumor, seal, gift wrap with a one-time key; 1 to 3 recipient relays from kind 10050; randomised timestamps up to 2 days back; relays still see the recipient pubkey | Copy: sender hidden inside, randomised time. Avoid: recipient tag visible and permanent, no padding, no moderation | NIP-17 (opened); OpenSats page (search snippet only) |
| Matrix P2P (Pinecone) | Experimental overlay; repo last pushed 2025-03-04 per a search result; self-described experimental | Not a model to adopt; no evidence of a shipped browser P2P mode | search snippet only |
| Jami, Tox | not verified; pages returned 404 | none | not opened |
| Secure Scuttlebutt | Per-identity append-only feeds; private messages visible as existing to the network; a move from pubs to rooms | Reinforces: others can see that a private message exists and when; also the single-writer feed fork problem noted in w2c-03 | handbook and LWN (search snippets only) |
| PairDrop / Snapdrop | Browser file sharing by WebRTC on a LAN, WebSocket signalling to a server, TURN for NAT; pairing by 6-digit code or QR; persistent pairing with shared secrets | Pairing codes and "accept before download" are good UX; PairDrop needs a server for signalling, which we replace with wires | PairDrop README (opened) |
| Magic Wormhole | Mailbox server plus transit relay; single-use human codes | Rendezvous plus relay is the minimal backend pattern; a transit relay is the missing piece for strict NATs | README (opened; protocol details not on the page) |
| WebTorrent sharers (instant.io, similar) | Browser seeds, WebRTC peers | Confirms the browser-seeding path; also the dependence on WSS trackers and on someone staying online | WebTorrent FAQ (opened) |

## What this means for magnet-web

### Today (0.2.1)

- Visitors in one site swarm already exchange signed public entries over `mw_chain1`; they can write a public message list through `mw.db.append`, which is permanent, public, costs a PoW fee per entry and cannot be private (SDK s9, SECURITY-MODEL). That is a public wall, not chat.
- There is no private channel, no ECDH, no presence, no file lane, no TURN.
- Peers and trackers already see IP addresses and site membership once the visitor accepts sharing (PRIVACY); chat adds the key-to-IP link.

### Upgrade (v0.3 design)

**Option A. Swarm chat (recommended base).** `mw_chat1` extension on a chat swarm, S1 sealed-box messages, blinded presence (opt-in), holder peers, stranger stamp.
- Bytes: message 1.3 KiB (padded 1 KiB) or about 410 B (256-byte bucket); presence about 26 B per beat per wire (20 B body plus 6 B framing, my estimate); chat key record about 175 B in the ledger once per rotation.
- Taps: first use: "Turn on chat" consent (1), after sign-in. Send: pick a person or room (1), type, send (1). Add a contact: scan or paste a key or code (2 to 3).
- Browser support: wire extension and WebCrypto ECDH on all current engines the loader supports; the iOS limitation is background, not support.
- Honest limits: no forward secrecy in S1; neighbours see IPs; offline delivery best-effort; key loss means history loss; a member of the swarm can flood.

**Option B. Direct channels over wires (add-on).** `RTCPeerConnection` per pair after consent, SDP over `mw_chat1`, 16 KiB chunks, separate channels for chat and files, fresh certificate per connection. Needed for typing, calls and fast transfers.
- Bytes: SDP offer and answer, typically a few KiB (not measured).
- Taps: "Connect directly" prompt (1) with the IP warning.
- Browser support: baseline since January 2020 (MDN); iOS background drop.
- Honest limits: both ends learn each other's addresses; NAT failure without TURN; TURN changes trust (F7).

**Option C. Secret-swarm private groups.** Derive the group's swarm id from the group secret (`sha1("mw-grp1" || secret)`), so only holders can find it. Berty's seed-derived rendezvous is the precedent (opened).
- Taps: create group (2), invite by pasted link or QR (2 per member).
- Limits: the tracker still sees the id and IPs; invite links are bearer secrets; leaking the link gives access to future messages; no admin enforcement outside the group.

**Option D. Owner relay lane (opt-in for strict-privacy or Tor users).** A WebSocket mailbox on the owner's pin node: tags and sealed envelopes only. It is a backend the owner runs; say so.
- Limits: the owner learns IPs and tag timing; does not suit "no backend" sites.

**File Option F1. Public file lane.** Plaintext torrent, listed in the ledger. Owner turns it on in policy. Taps: pick file (1), "Share with everyone on this site" (1), progress. **F2. Private file.** Encrypted torrent, key in chat envelope, no ledger entry. Taps: pick file (1), choose person or group (1-2). **F3. Direct-channel send** for small files (up to 25 MiB), no torrent, 16 KiB chunks over Option B, both online. **F4. Owner pin** for lasting files.
- Bytes: listing 250 to 400 B; encryption overhead 0.02 percent plus 125 B per recipient wrap; torrent metadata 20 bytes per piece (SHA-1), so about 20 KiB for the default of about 1,024 pieces.
- Limits: availability depends on someone online; SHA-1 infohash; uploader's and fetchers' IPs visible to anyone with the infohash and tracker access; takedown is partial.

### Cannot (stated)

- Hide IP addresses from first-hop peers, trackers and STUN operators in a browser, or route WebRTC through Tor.
- Guarantee offline delivery, delivery order across devices or "read" semantics.
- Erase a message or file from other people's devices.
- Scan, moderate or recover private chat or private files, and therefore cannot comply with a scan or decrypt order technically (R6 F11).
- Tell anyone which keys are real people: an identity is a key, not a person (R6 F10).
- Keep a phone connected in the background on iOS.
- Offer forward secrecy in S1, or post-compromise security before a ratchet tier exists.

## Recommendations

| Pri | Effort | Recommendation |
|---|---|---|
| P0 | S | Write the rule into ARCHITECTURE s6 and SECURITY-MODEL: the ledger never holds chat bodies, presence, receipts, DM envelopes, private-share recipients or wrapped file keys. Add a lint test in the chain validators that rejects reserved list names (`dm`, `chat`, `pres`) when the value looks like a sealed envelope. |
| P0 | M | Add the signed chat key record (`ek`, signature, `exp`) to the profile format, with separate key generation and rotation. Golden vectors in test/vectors. |
| P0 | M | `mw_chat1` extension and chat swarm under the existing `guardWire` cap, 16 KiB frame cap, per-peer relay budget, off by default and off in host-only mode. |
| P0 | M | S1 sealed-box message format with signature inside, power-of-two padding, message id, replay set. State "no forward secrecy" in the UI help and SECURITY-MODEL. |
| P0 | S | Serving rule for uploaded files: never executed or rendered as HTML at the site origin; download or sandboxed preview only. |
| P0 | S | Consent copy and recipients-register rows for chat and file swarms (each peer, each holder, TURN if used); defaults off until the visitor opts in (R6). |
| P1 | M | Stranger stamp (`chatBits`), contacts, block, message requests inbox; per-peer decrypt-attempt cap. |
| P1 | M | Holder peers with rotating mailbox tags, 7-day cap, quota, and honest delivery states in the UI. |
| P1 | M | Blinded, opt-in presence; none from a hidden tab. |
| P1 | L | Public file lane: policy switch, ledger listing, 25 MiB cap, tombstone makes cooperating clients stop fetching and seeding, owner pin action. |
| P1 | L | Private file lane: chunked AES-GCM, key in chat envelope, no ledger entry, never auto-seed what the visitor did not open. |
| P2 | M | Option B direct channels with signalling over wires, 16 KiB chunks, separate channels, fresh certificate each time, IP warning. |
| P2 | M | Secret-swarm private groups (Option C) with sender keys and rekey on removal; groups above 8 use sender keys, not per-message wraps. |
| P2 | L | Pairwise hash ratchet (S2) plus DH step; external crypto review before release. |
| P2 | S | Optional TURN relay-only mode for users who accept a TURN operator; TURN stays off by default (B7). |
| P3 | L | MLS tier, gated on an audited browser-capable library, a measured bundle size and a total-order rule for commits. ts-mls is the candidate (no audit today). |
| P3 | M | Owner WebSocket mailbox (Option D) for Tor Browser users, documented as a backend the owner runs. |

## Open questions

1. Is a separate chat swarm worth the extra tracker announces (one more infohash per tab) on phones that already cap rendezvous wires at 3/5? Needs a measurement.
2. Should the first-contact stamp be fixed (20 bits) or follow the site policy `bits`? A per-site `chatBits` is simpler; neither was measured on a low-end phone.
3. What are the real bundle sizes and cold-start times of ts-mls plus `@noble/curves` and `@hpke/core`? The README gave none.
4. How many sites will have enough concurrent visitors for holder peers to work at all? A pilot on the example site should record delivered, held and failed rates before the UI promises anything.
5. Does Safari or iOS Lockdown Mode break ECDH key persistence the way open-chat #9343 reports for ECDSA (w2c-03)? Needs a test on a real device.
6. Should the owner be able to turn the private file lane off while keeping private chat on (R6 F9)?
7. Which jurisdictions' scan or decrypt obligations (UK Ofcom s121 guidance, EU CSA Regulation in trilogue) could reach an owner who enables E2E chat on a static site? R6 flags this as unresolved and the Regulation 2026/1881 report as single-source.
8. Jami, Tox, Matrix P2P, Hyperswarm internals and SSB box2 were not verified from primary pages; confirm before quoting them in public docs.

## Sources (accessed 2026-10-20)

Opened: WebTorrent api.md https://github.com/webtorrent/webtorrent/blob/master/docs/api.md; WebTorrent FAQ https://github.com/webtorrent/webtorrent/blob/master/docs/faq.md; create-torrent https://github.com/webtorrent/create-torrent; MDN RTCDataChannel https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel; MDN RTCSctpTransport.maxMessageSize https://developer.mozilla.org/en-US/docs/Web/API/RTCSctpTransport/maxMessageSize; MDN RTCPeerConnection https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection; MDN SubtleCrypto.deriveKey https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey; MDN Supported algorithms https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API/Supported_algorithms; RFC 8831 https://www.rfc-editor.org/rfc/rfc8831.html; RFC 9420 https://datatracker.ietf.org/doc/rfc9420/ (first 100,000 of 307,746 characters read; s16.4 not read); ts-mls https://github.com/LukaJCB/ts-mls; libsignal https://github.com/signalapp/libsignal; NIP-17 https://github.com/nostr-protocol/nips/blob/master/17.md; Briar https://briarproject.org/how-it-works/; Wesh protocol https://berty.tech/docs/protocol/; Session blog index https://getsession.org/blog; PairDrop https://github.com/schlagmichdoch/PairDrop; Magic Wormhole https://github.com/magic-wormhole/magic-wormhole.

Search snippets only (not opened): Pear docs https://docs.pears.com/building-blocks/hyperswarm; OpenSats private DMs https://opensats.org/topics/private-dms; Pinecone repo listing https://awesome.ecosyste.ms/projects/github.com%2Fmatrix-org%2Fpinecone; IETF mdns-ice-candidates https://www.ietf.org/archive/id/draft-ietf-mmusic-mdns-ice-candidates-02.html; Chrome PSA https://groups.google.com/g/discuss-webrtc/c/6stQXi72BEU/m/7qVwleLiBwAJ; Tor issue https://gitlab.torproject.org/tpo/applications/tor-browser/-/issues/41021; Tor forum https://forum.torproject.org/t/safe-way-to-user-webrtc/2231; Apple forums https://developer.apple.com/forums/thread/799259 and https://developer.apple.com/forums/thread/716118; WebKit bug https://bugs.webkit.org/show_bug.cgi?id=226163; SSB handbook https://handbook.scuttlebutt.nz/faq/misc/privacy; LWN https://lwn.net/Articles/1065471/; LibSignal* https://eprint.iacr.org/2019/542.

Project files: ARCHITECTURE.md s6.1, s6.6, s8, s9; SECURITY-MODEL.md; PRIVACY.md; CRITIQUE.md; IMPROVEMENTS-DIGEST.md row 13; research/w2c-03-identity-ux.md; research/v03/R6-legal-compliance.md F1, F3, F9, F10, F11; src/chain/wire-ext.js; src/loader/torrent.js.
