# Live chat and file sharing between signed-in visitors, with no backend (v0.3 design proposal)

- **Status:** design proposal, 2026-10-20, written as amendments to [ARCHITECTURE.md](../../ARCHITECTURE.md) (6.6 gossip, new 6.11 chat lane, new 6.12 file lane, 8 policy, 9 SDK) and [INTERFACES.md](../../INTERFACES.md) (new `src/chat/*`, `src/files/*`; changes to `src/loader/torrent.js`, `policy.js`, `api.js`, `bridge.js`). Nothing here is built. Decisions are **D-Cn** with alternatives.
- **Built from:** [R8](R8-realtime-chat-and-files.md) (findings F1 to F10, options A to D and F1 to F4), [R5](R5-weak-area-audit.md) F3, F4, F9, F13, [R6](R6-legal-compliance.md) F3, F9, F11, [R2](R2-privacy-failures-2026.md) F13, F16, [R1](R1-landscape-differentiators.md) 6.2. Identity, keys and sign-in come from [IDENTITY-AUTH-DESIGN.md](IDENTITY-AUTH-DESIGN.md); privacy rows from [PRIVACY-UPGRADES.md](PRIVACY-UPGRADES.md) V5 to V8.
- **Wording:** "no backend", "site ledger". Byte counts are arithmetic from R8; nothing here is measured on a network.

## 1. Summary (10 bullets)

1. **Nothing conversational goes in the site ledger.** It holds only a signed chat-key record per member, public file listings and moderation actions. Bodies, presence, receipts, envelopes, recipient lists and wrapped file keys never touch it (R8 summary 1).
2. **Transport is a second wire extension, `mw_chat1`, on a separate opt-in chat swarm**, under the existing wire guard (262,144 bytes) with a 16 KiB frame cap. Readers who never turn chat on never join it. Direct WebRTC channels are an opt-in second tier with signalling over the wires (R8 F2).
3. **Messages are sealed boxes:** ephemeral-static ECDH P-256, HKDF-SHA-256, AES-256-GCM, with the sender's signature inside, padded to power-of-two buckets. WebCrypto provides every primitive. **There is no forward secrecy in v0.3**, and the UI help says so (R8 F4).
4. **Groups of up to 32 use an epoch group secret** shared by sealed box, with the sender's signature inside every message and a new secret and a new swarm id on every removal. Sender keys are P2 and MLS is P3; the Signal ratchet library has no browser target and MLS for the browser has no audit (R8 F4).
5. **Live only by default.** Offline delivery is best effort through opt-in holder peers (7 days, quotas) or the owner's pin node; the UI shows "delivered", "held by N peers" or "not delivered", never just "sent" (R8 F5).
6. **Files are encrypted first, then torrented, then referenced.** Public files get a ledger listing of about 250 to 400 bytes; private files get no ledger entry, and their key travels inside a chat envelope (about 125 bytes per recipient). A file lasts only while someone keeps it, unless the owner pins it (R8 F9).
7. **Uploaded content never executes at the site origin:** download as attachment, `nosniff`, previews only for decoded images and plain text, or a sandboxed frame without `allow-same-origin` (R8 F9).
8. **Every residual exposure is stated per observer** (section 9). Peers and relays see IP addresses; trackers and STUN see swarm membership; neighbours see sizes and times; members can keep and forward anything they receive. Host-only visitors cannot chat. Tor cannot carry WebRTC.
9. **A relay with no backend has a cost nobody else mentions:** TURN credentials must either be public (an open relay for anyone who loads the site, limited only by quotas) or minted by a small credential endpoint, which is a backend. D-C8 makes the owner choose.
10. **Build order:** ledger rules and the chat-key record first, then `mw_chat1` and sealed DMs, then holders and presence, then public rooms and small groups, then the private and public file lanes, with direct channels and TURN last.

## 2. Principles

1. Off by default, opt in per feature: chat, presence, holding for others, uploads, direct channels (R6 P0 4; PRIVACY-UPGRADES rule 2).
2. Signed in to chat: every message is signed by the sender's site key; guests may read public rooms only if the owner allows it.
3. The ledger is for public, long-lived facts. Everything conversational is ephemeral in the swarm.
4. Say what is exposed in the same card that turns a feature on.
5. Phones never relay or hold by default, and nothing promises background delivery on iOS.

## 3. What the site ledger records, and what it never records (amends ARCHITECTURE 6.1 and SECURITY-MODEL)

| Item | In the ledger? | How |
|---|---|---|
| Chat-key record | yes, public | `append('mw.ck', { ek, epoch, exp, sig })` by the member (5.2) |
| Public file listing | yes, public | `append('mw.files', { ih, len, name, mime, sha256, t })` (6.4) |
| Moderation (ban, tombstone of a listing) | yes | existing control ops |
| Chat settings (`chat: off/members/open`, `files: off/members`, caps) | yes | owner `_mw.chat` key (advisory, honest clients enforce) |
| Message bodies, presence, typing, receipts | **never** | `mw_chat1` frames only |
| DM envelopes, mailbox tags | **never** | frames and holders only |
| Group membership lists, group secrets | **never** | sealed envelopes to members |
| Private-share recipients, wrapped file keys, private infohashes | **never** | inside sealed envelopes |

**Rule and test (R8 P0):** a validator lint in `src/chain/block.js` rejects `append` values on any `mw.*` list that do not match that list's schema, and rejects lists named `dm`, `chat`, `pres` or `mw.env` outright. Honest clients refuse to write them; peers drop them as `shape`.

## 4. Transport (new ARCHITECTURE 6.11, "Chat lane")

### 4.1 Swarms (D-C1)

- **Site chat lane:** infohash `sha1(utf8("mw-chat1|" + ledgerId))`, joined through the same rendezvous mechanism as the ledger swarm (ARCHITECTURE 5.5). The id is a label, not a secret: anyone who knows the ledger id can join and list who is there.
- **Private group lane:** infohash `sha1(utf8("mw-grp1|") || groupSecret)`; only holders of the secret can find it (Berty's seed-derived rendezvous is the precedent, R8 Option C). The tracker still sees the id and the IPs.
- **Alternative rejected:** chat on the ledger rendezvous swarm (no extra announce, but every reader would carry chat traffic and the opt-in would be meaningless); per-pair swarms brokered by the tracker (T-C, which shows the tracker who talks to whom; R8 F2).
- **Cost:** one more announced infohash per tab with chat on; phones already cap rendezvous wires at 3 to 5 (R8 Q1, needs measurement).

### 4.2 `mw_chat1` frames (D-C2)

Binary: `byte0 = type`, `byte1 = version`, then the body. Each frame at most 16,384 bytes; the wire guard (`CONFIG.wire.maxMessageBytes` = 262,144, `src/loader/torrent.js`) still applies first.

| Type | Name | Body | Relayed? |
|---|---|---|---|
| 0x01 | HELLO | `{ v, site, owner, lanes: ['dm','room','hold'] }` JSON; no identity | no |
| 0x02 | PRES | blinded id (8), epoch day (4), status (2), flags (1); about 20 B | no (neighbours only) |
| 0x03 | ENV | sealed envelope (5.3): tag (8), epk (65), iv (12), ct | yes, hop limit 4, dedupe by SHA-256 of the frame |
| 0x04 | ROOM | signed plaintext room message `{ room, id, t, text, author, sig }` | yes, hop limit 4 |
| 0x05 | WANT-TAGS | up to 32 mailbox tags the sender expects | no |
| 0x06 | HELD | envelopes matching a WANT-TAGS, batched to the cap | no |
| 0x07 | CHAL / 0x08 RESP | challenge-response login proofs (IDENTITY-AUTH-DESIGN 4.1) | no |
| 0x09 | SIG | WebRTC offer, answer or candidate for a direct channel, sealed to the other party | yes, as ENV |
| 0x0A | ACK | sealed delivery acknowledgement (contacts only) | yes, as ENV |

- **Budgets (D-C3):** relay of others' frames at most 64 KiB/s per peer on desktop; 8 KiB/s and 2 MiB per session on mobile classes and only after "Share on this network" (R8 F6). Decrypt attempts capped at 50 per peer per second. A peer sending more than 20 invalid frames is ignored for the session.
- **Attach rules:** as `mw_chain1`: only wires that advertise `mw_chat1`, never web-seed wires, nothing before the extended handshake.
- **Host-only and consent:** `mw_chat1` is never registered unless consent is `accepted` and the visitor turned chat on. Host-only visitors cannot chat (there are no peers); that is stated, not worked around.

### 4.3 Direct channels (option B, P2)

Per conversation, opt in with "Connect directly (shows your IP address to this person)". SDP and candidates travel as sealed SIG frames over the chat lane, so trackers do not see the pairing. Separate data channels for chat and files (one association shares one congestion window, RFC 8831 s5); files chunked at 16 KiB (RFC 8831 s6.6 advises 16 KB without interleaving). Fresh DTLS certificate per connection. `maxMessageSize` is read at runtime (MDN).

## 5. Presence and messages

### 5.1 Presence (D-C4)

- Off by default. When on: PRES to direct neighbours every 30 s while visible; "away" once on `visibilitychange` to hidden; nothing from hidden tabs; restore on `pageshow` (R8 F3).
- **Blinded id for contacts:** `bid = HMAC-SHA-256(K_pair, "pres|" + day)[:8]`, where `K_pair` is the pairwise key of 5.3. Only contacts resolve it; it rotates daily.
- **Public presence** ("visible to everyone on this site") is a separate toggle: `bid = HMAC(K_site, "pres|" + pub + "|" + day)[:8]` with `K_site = SHA-256("mw-pres-v1|" + ledgerId)`, which anyone can compute; it lists the member in "who is online".
- **Limit:** presence tells every neighbour that this IP is online on this site's chat lane; public presence adds the key.

### 5.2 Chat-key record (D-C5)

`append('mw.ck', { ek: <65 B raw P-256 ECDH pub, b64url>, epoch, exp, sig })`, `sig = ECDSA(signKey, "mw-chat-key-v1\n" + ledgerId + "\n" + ek + "\n" + epoch + "\n" + exp)`. About 175 to 260 bytes; one PoW fee per rotation. Readers take the newest valid, unexpired item per author. Rotation every 90 days or on demand; old private halves stay on the device to read old held mail until the visitor deletes them. **Alternative:** extend the `profile` op's value (fewer list items, but a change to what `profile` means in 6.5); rejected for v0.3.

### 5.3 Direct messages: sealed box S1 (D-C6)

```
plaintext  = pad( canonical({ id: <16 B>, t, kind: 'text'|'file'|'invite'|'ack'|'sig', body,
                   from: <sender p256: signKey>, sig }) )
sig        = ECDSA(sender signKey, "mw-msg-v1\n" + ledgerId + "\n" + recipient ek + "\n" + id + "\n" + t + "\n" + SHA-256(body))
key        = HKDF-SHA-256(ikm = ECDH(epk_private, recipient ek), salt = tag, info = "mw-chat-v1|" + ledgerId, L = 32)
frame ENV  = 0x03 | 0x01 | tag(8) | epk(65) | iv(12) | AES-256-GCM(key, iv, plaintext)
pad        = to 256, 1,024, 4,096 or 16,000 bytes (the largest bucket fits the 16 KiB frame)
```

- Naming the recipient's `ek` inside the signature stops a recipient forwarding a signed message to a third party as if it had been sent to them.
- **Addressing tags:**
  - *Contacts:* `K_pair = HKDF(ECDH(my chat key, their ek), info = "mw-pair-v1|" + ledgerId)`; `tag = HMAC(K_pair, "tag|" + day)[:8]`. Only the two parties can compute or recognise it; it rotates daily.
  - *Strangers (first contact):* `tag = SHA-256("mw-inbox-v1|" + ek + "|" + day)[:8]`. Anyone who reads the recipient's chat-key record can compute it, so an observer learns "someone wrote to this key today", not who. The message must carry a work stamp (5.6). A member can turn message requests off.
- **Sizes:** a 3-line message in the 256-byte bucket is about 410 bytes on the wire; a padded 1 KiB body about 1.3 KiB (R8 F4).
- **Replay:** receivers keep a seen-set of `id` per sender for the retention window.
- **Delivery:** if the recipient is a neighbour, send to that wire; otherwise flood with hop limit 4. The recipient returns a sealed ACK for contacts only (no ACK to strangers, so strangers cannot probe whether someone is online). No read receipts in v0.3.
- **Honest limits:** no forward secrecy and no post-compromise security: anyone who later obtains the recipient's chat private key and kept the envelopes can read them. NIP-17 has the same limit (R8 F4).

### 5.4 Groups (D-C7)

- **v0.3, up to 32 members:** the creator makes `groupSecret` (32 random bytes) and `epoch = 1`; sends each member an `invite` S1 envelope carrying `{ groupId, name, secret, epoch, members: [pub], admins: [pub] }`. Group messages are ENV frames on the group lane encrypted under `K_g = HKDF(groupSecret, info = "mw-grp-msg|" + epoch)`, with the sender's signature inside, padded as in 5.3.
- **Membership change:** an admin adds a member by sending them the current invite; removes by creating a new secret and epoch (and therefore a new group swarm) and sending it to the remaining members. A removed member keeps everything before the change and nothing after.
- **What the group cannot do:** admins are a convention inside the group; the site owner cannot see or moderate private groups; no member can impersonate another (inner signatures), but any member can leak everything.
- **Alternatives:** per-message wraps to each member (125 bytes per member, fine to 8; R8 F4); sender keys (P2); MLS via ts-mls (P3, gated on an audit, a measured bundle size and an ordering rule for commits, since MLS needs a delivery service that orders handshake messages; RFC 9420).

### 5.5 Public rooms

Site-wide live rooms on the chat lane (default room "Lobby"). ROOM frames are signed plaintext; clients drop frames from keys banned in the ledger and frames whose author lacks the role the owner requires (`chat: 'members'` means writers in the ledger policy). Moderators can ban (ledger) and the loader stops showing that key's room messages at once. Nothing is stored unless a visitor keeps history locally. Rooms are public to anyone on the chat lane, including people who join only to record.

### 5.6 Spam controls (R8 F8)

1. Contacts skip all checks. 2. `chat: 'members'` limits writers to the ledger's allowed writers. 3. First contact from a stranger carries a work stamp: `leadingZeroBits(SHA-256("mw-stamp-v1|" + recipient ek + "|" + day + "|" + nonce)) >= chatBits`, default 20 (about 1.05 million hashes, unmeasured on phones; G-CH-6). 4. Message requests inbox that never auto-previews; block key; mute. 5. Per-peer relay and decrypt caps (4.2). 6. Ledger bans for public lanes. The stamp is a fee, not a defence.

### 5.7 Stored or ephemeral, and offline envelopes

- **Default:** messages live in memory. "Keep history on this device" per conversation stores envelopes and plaintext sealed under `K_vault` (IDENTITY-AUTH-DESIGN 3.3). Nothing goes to the ledger.
- **Holder peers (opt in, desktop only by default):** hold ENV frames whose tags they do not recognise for up to 7 days, 64 envelopes per tag and 4 MiB per holder, evicting oldest. Recipients send WANT-TAGS for the tags they expect (contacts' pair tags for the last 7 days and their own inbox tag) and receive HELD batches. Holders learn tag, size and arrival time, never sender or recipient (R8 F5).
- **Owner pin node as mailbox (opt in):** the headless loader pin node (`tools/pin.mjs`) holds envelopes as a peer with larger quotas. It sees IPs, tags and sizes, not content.
- **Owner WebSocket mailbox (option D, P3):** the only lane that works in Tor Browser; it is a backend the owner runs, and the docs say so.
- **States in the UI:** "delivered" (ACK received), "held by N peers", "not delivered (nobody online to hold it)".

## 6. Files (new ARCHITECTURE 6.12, "File lane")

### 6.1 Lanes (D-C9)

| Lane | What | Ledger entry | Who can fetch | Default |
|---|---|---|---|---|
| F1 public | plaintext torrent, listed | `mw.files` listing | anyone on the site | off; owner turns on |
| F2 private | encrypted torrent | none | anyone with the infohash gets ciphertext; only recipients get the key | on for signed-in members when chat is on |
| F3 direct send | 16 KiB chunks over a direct channel, no torrent | none | the one recipient, both online | P2, with direct channels |
| F4 owner pin | the pin node fetches and seeds a listed or shared file | unchanged | as the lane | owner action |

### 6.2 Creating a torrent in the browser

`client.seed(blob)` builds the torrent on the device; piece length defaults to about 1,024 pieces, at most 4 MiB pieces (create-torrent README, R8 F1); about 20 KiB of SHA-1 piece hashes for the default. Pieces go to the existing blob chunk store (`src/loader/blob-chunk-store.js`); nothing is assembled whole in memory on a phone. `destroyStoreOnDestroy` when the visitor stops sharing. File torrents are separate from the site torrent and have their own caps, so a shared file cannot evict the site (R5 F13). Note the v1 infohash is SHA-1 (SECURITY-MODEL).

### 6.3 Encryption for private files

`fk` = 32 random bytes. The file is encrypted in 64 KiB records with AES-256-GCM, nonce = 8-byte random file prefix plus a 4-byte record counter, with the last record flagged in the AAD (STREAM construction; overhead 16 bytes per 64 KiB, 0.02%). The torrent is made from the ciphertext, so the infohash and every piece are ciphertext. The share is an S1 envelope of kind `file`: `{ ih, len, name, mime, sha256 (plaintext), fk, prefix }`. For a group, the same object goes in a group message. Name and type stay inside the envelope.

### 6.4 Public listing

`append('mw.files', { ih: 40 hex, len, name: up to 96 characters, mime, sha256: 64 hex, t })`, about 250 to 400 bytes, under `maxValueBytes` 2,048; the PoW fee applies (owner and moderators exempt). Allowed only when the policy turns F1 on and the author may write.

### 6.5 Seeding rules

- Seed only files the visitor uploaded or chose to open. Never seed an unlisted infohash someone sends without the visitor accepting it. One-time notice at first download: "While this page is open you also share this file, and others can see your IP address."
- Desktop fetchers re-seed while the tab is open and policy allows; phones only after "Share on this network".
- Phone uploads: "This file is available only while you keep this page open" unless the owner's pin node is configured, in which case the loader offers "Ask the site to keep a copy" (F4) and says the pin node will see the file if it is public, or ciphertext if private (R5 F3).

### 6.6 Serving rule (security)

Uploaded bytes are delivered by the Service Worker with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a generic type; previews only for images decoded with `createImageBitmap` and plain text rendered as text; anything else opens in a sandboxed iframe without `allow-same-origin`. In per-domain and drop-in modes site code runs with loader privilege, so an uploaded HTML or script file served inline would run as the site (SECURITY-MODEL; R8 F9).

### 6.7 Takedown

A tombstone on a listing removes it from honest copies; the loader then refuses to fetch or seed that infohash and stops seeding it if it is. A ledger ban stops the author's further listings. Copies on other software and offline devices remain, and the same bytes can be re-uploaded (SECURITY-MODEL "Takedown"). Private files are outside the owner's reach.

## 7. Size and battery limits (amends ARCHITECTURE 8)

| Limit | Desktop | Mobile unmetered | Mobile unknown or metered | Source |
|---|---|---|---|---|
| Frame size | 16 KiB | 16 KiB | 16 KiB | RFC 8831 s6.6; R8 P0 |
| Relay of others' chat frames | 64 KiB/s | 8 KiB/s, 2 MiB per session, after "Share on this network" | 0 | R8 F6 |
| Holding for others | opt in | off | off | 5.7 |
| Public file, per file | 25 MiB | 25 MiB | 25 MiB | R8 F9 |
| Public files, per site (listing cap) | 256 MiB | same | same | R8 F9 |
| Private file, per file | 100 MiB | 25 MiB | 25 MiB | R8 F9 |
| Seeding files | while open | after opt in | after opt in, 128 KiB/s cap as today | `config.js` line 62 |
| Presence beats | 30 s while visible | 30 s while visible | 30 s while visible; none hidden | R8 F3 |

The site caps (128, 48, 24 MiB by class; `config.js` lines 27 and 28) are unchanged and separate. Waking a closed page (Web Push) needs a server; v0.3 has none, so no background delivery anywhere.

## 8. Moderation, takedown and the seeders' legal position (R6 F3, F9, F11; not legal advice)

- The owner can moderate public rooms (bans), public file listings (tombstones) and membership (`allow`). The owner cannot see, scan or moderate private chats, private groups or private files, and there is no key escrow.
- Where the DSA or the UK Online Safety Act apply, an owner who enables public uploads or rooms should assume hosting or user-to-user duties: notice and action, statements of reasons, illegal-content risk assessment, and for services likely used by children, children's assessments (R6 F9). "No backend" does not remove them.
- An end-to-end design cannot satisfy a scan or decrypt order technically; the project will not add a back door; that is a business risk for owners in some jurisdictions (R6 F11). The EU interim scanning regime lapsed on 2026-04-03 (Medium); a replacement with an E2EE carve-out is reported from one source only (Low).
- Seeders: a visitor who re-seeds a file uploads content they did not create. Mitigation: seed only what the visitor opened, show the notice, and never say seeders are "just relaying" (R6 P0 6). Anyone with an infohash and tracker access can list seeders' IPs (SECURITY-MODEL).
- Defaults for children's sites: chat, files and profiles off unless the owner adds an external age method (R6 F10).

## 9. The full metadata and IP exposure statement

### 9.1 Per observer

| Observer | Sees | Mitigation | What remains after the mitigation |
|---|---|---|---|
| Neighbour peer on the chat lane | your IP; that you use chat on this site; frame sizes (in buckets) and times; opaque envelopes; blinded presence | padding; blinded ids; opt-in presence; host-only | IP, timing, size class, that you are on this site |
| A contact (recipient) | your key and message; your IP only if they are your neighbour | swarm-lane delivery (default); TURN relay-only for direct channels | your key and content, by design; your IP on direct channels without relay |
| A stranger you have not accepted | nothing until they message you; your chat key from the ledger | message requests; no ACK to strangers; option to refuse requests | they can write to you (with a stamp) and compute your inbox tag |
| Tracker operator | IP, chat-lane and group-lane infohashes, announce times | own tracker; secret group ids | IP and membership of the public lane; IP and an opaque id for groups |
| STUN operator | IP, that a WebRTC session starts | owner's own STUN; consent first (already) | IP |
| Holder peer | tag, size, arrival time; IP of the neighbour that sent it | daily rotating tags; quotas | per-day linkage of a tag's traffic volume |
| TURN relay, if used | both IPs, bytes, times; never content | none: this is the trade | the relay operator sees who connects to whom |
| Owner pin node mailbox | IPs, tags, sizes, times | opt in; rotating tags | as holder plus IP |
| Network observer or ISP | connections to trackers, STUN and peer addresses | none in a browser | that you use a peer-to-peer site, and when |
| Malicious visitor in the swarm | IPs of everyone on the public lane; keys with public presence; public rooms; can flood | blinded presence; stamps; caps; bans | the audience over time; who posts in public rooms |
| Group member | everything the group sees | rekey on removal | can keep, screenshot and forward anything |
| Anyone with a private file's infohash | the ciphertext, its size, seeders' IPs | encrypt first; never list privately shared files | existence, size and seeders of that file |
| The site owner | public rooms, listings, ledger | none needed | cannot read private lanes; controls the code visitors run (IDENTITY-AUTH-DESIGN 6.5) |

### 9.2 Statements the docs and UI must carry

- "Messages and private files are encrypted between your keys. The people connected to you see your IP address, when you are active and the rough size of what you send. Trackers see that you joined this site's chat."
- "Nobody sees you as online unless you turn presence on. Turning it on shows the people connected to you that this IP address is here."
- "Anyone you send something to can keep it and pass it on."
- "If nobody who can hold your message is online, it is not delivered. We will show you which."
- "Host-only mode turns chat and file sharing off. There is no way to chat without connecting to other people's browsers or to a relay."
- "Tor Browser does not run WebRTC, so chat does not work there."
- "There is no forward secrecy yet: if someone later gets your chat key and kept your old messages, they can read them."

### 9.3 Mobile defaults

Chat on: send and receive own messages only; no relaying, no holding, no seeding until "Share on this network"; no presence from hidden tabs; iOS stops networking soon after backgrounding and data-only peer connections are reported to drop (forum posts and WebKit bug 226163, search snippets only; R8 F3), so the UI says "Messages arrive while this page is open".

### 9.4 Relay with no backend (D-C8, new finding)

`iceTransportPolicy: 'relay'` hides a visitor's address from peers, needs a TURN server and sends its credentials to it (MDN, R8 F7). With no backend there are two ways to give browsers TURN credentials, and the owner must pick one:
- **(a) Static credentials in the site (recommended for small sites):** owner-run coturn with long-term credentials published in the page, restricted by coturn quotas (per-user and total sessions, max bit rate) and allowed-peer ranges. It is an open relay for anyone who loads the site; abuse is bounded only by the quotas and the owner's bill. Cloudflare's TURN service costs US$0.05 per GB outbound when not used with its SFU (developers.cloudflare.com/realtime/turn/, updated 2026-09-25; R5 F4) but needs server-side minted credentials, so it fits only (b).
- **(b) A credential endpoint:** a tiny function that mints short-lived credentials. That is a backend; label it so.
- TURN stays off by default (ARCHITECTURE 8, B7). When on, the consent card names the relay and its operator.

## 10. SDK surface (amends ARCHITECTURE 9 and INTERFACES `api.js`, `bridge.js`, `sdk.js`)

All methods require `mw.auth.state() === 'signed-in'` unless noted. UI methods open loader cards.

```
mw.chat.enable() -> { on: true, lanes }                 UI. Card names recipients (PRIVACY-UPGRADES 5). E_HOST_ONLY, E_NOT_SIGNED_IN,
                                                         E_POLICY (site chat 'off'), E_USER_CANCELLED
mw.chat.disable() -> { on: false }                      leaves lanes, stops presence and holding
mw.chat.state() -> { on, presence, holder, relayOnly, peers, lanes }      (no sign-in needed)
mw.chat.presence.set({ on, public?: false }) -> {...}   UI for public: true
mw.chat.presence.list() -> [{ pub?, bid, status, since }] contacts resolved; strangers only if public
mw.chat.contacts.list() / add(pub, { nick }) / remove(pub) / block(pub) / unblock(pub)
mw.chat.requests.list() / accept(id) / decline(id) / setOpen(bool)
mw.chat.dm.send(pub, { text } | { file: ref }) -> { id, state: 'delivered'|'held'|'not-delivered'|'sending' }
     E_NO_CHAT_KEY (recipient has no valid mw.ck), E_BLOCKED, E_LIMIT (> 16,000 B padded), E_STAMP (aborted), E_RATE
mw.chat.dm.history(pub, { limit, before }) -> [msg]     local history only if kept
mw.chat.dm.keepHistory(pub, bool)
mw.chat.room.join(name = 'Lobby') / leave(name) / send(name, { text }) -> { id }   E_POLICY, E_BANNED
mw.chat.group.create({ name, members: [pub] }) -> { groupId }     E_LIMIT (> 32)
mw.chat.group.invite(groupId, pub) / remove(groupId, pub) / leave(groupId) / send(groupId, { text } | { file })
     E_NOT_MEMBER, E_NOT_ADMIN
mw.chat.holder.set(bool)                                UI; desktop default off; phones refused unless sharing is on
mw.chat.direct.connect(pub) -> { connected }            UI with IP warning; E_PEER_UNREACHABLE (P2)
mw.chat.on(event, fn) -> unsubscribe   events: 'message', 'delivery', 'request', 'presence', 'room', 'group', 'state'

mw.files.enable() -> { on }                             UI; E_HOST_ONLY, E_POLICY
mw.files.share(blob, { public?: false, to?: [pub] | groupId, name?, mime? }) -> { ref, ih, listed: bool }
     public requires policy F1 and writer role; E_LIMIT (size cap by class), E_POLICY
mw.files.list() -> [{ ref, ih, name, len, mime, author, t }]       public listings (no sign-in needed)
mw.files.received() -> [{ ref, from, name, len, t }]                private shares from envelopes
mw.files.fetch(ref, { onProgress }) -> { blob, verified: bool }    E_FILE_UNAVAILABLE (no seeder), E_FILE_TOMBSTONED, E_DECRYPT
mw.files.save(ref)                                       UI; download as attachment (6.6)
mw.files.stopSharing(ref) / remove(ref)                  remove = tombstone own listing
mw.files.pinRequest(ref) -> { requested }                only if the owner runs a pin node
mw.files.on('progress' | 'shared' | 'received' | 'removed', fn)
```

**New error codes:** `E_HOST_ONLY`, `E_NO_CHAT_KEY`, `E_BLOCKED`, `E_STAMP`, `E_NOT_MEMBER`, `E_NOT_ADMIN`, `E_PEER_UNREACHABLE`, `E_FILE_UNAVAILABLE`, `E_FILE_TOMBSTONED`, plus `E_NOT_SIGNED_IN`, `E_USER_CANCELLED`, `E_DECRYPT` from IDENTITY-AUTH-DESIGN 7. **Bridge:** `UI_METHODS` adds `chat.enable`, `chat.presence.set` (public), `chat.holder.set`, `chat.direct.connect`, `files.enable`, `files.save`; `PUSH_EVENTS` adds `chat`, `files`. **New modules:** `src/chat/frames.js`, `seal.js`, `tags.js`, `stamp.js`, `lane.js` (wire extension and relay), `groups.js`, `holder.js`; `src/files/encrypt.js`, `lane.js`, `serve.js` (SW attachment rule).

## 11. Example site specification (peer-guestbook, "Members" area)

| Screen | Behaviour |
|---|---|
| **Turn on chat** banner (signed-in only) | opens `mw.chat.enable()`; the card lists who sees what (9.2) |
| **Who is online** | contacts with blinded presence; members with public presence; a count of other chat-lane peers ("3 others connected"), never their IPs |
| **Lobby** room | live public room; moderators' ban button; "public, anyone connected can read this" label; no history unless kept |
| **Messages** | contact list, message requests inbox (no preview), per-conversation thread with delivery state, "keep history on this device" toggle, block |
| **New group** | pick up to 32 contacts; admin badge; remove member shows "they keep what was already sent" |
| **Files** | public list (if the owner enabled it) with name, size, author, "fetch"; "Share a file" with Public (if allowed) or Private to a person or group; progress; "available while this page is open" on phones; "Ask the site to keep a copy" if a pin node exists |
| **Share privately** | pick file, pick person or group, send; the recipient sees an offer and accepts before any download or seeding |
| **Chat settings** | presence (off, contacts, public), holder (desktop), relay-only (if the owner runs TURN), message requests on or off, "what others can see" link |
| Host-only visitors | the Members area says "Chat and file sharing need a connection to other visitors. You chose host only." with a button to Settings |

## 12. Test plan

**Unit and vectors:** frame codec round trips and rejection of oversize frames; sealed-box vectors (`test/vectors/chat.json`) in Node, Chromium and WebKit; padding buckets; contact and inbox tags; stamp verification; replay set; group rekey (removed member cannot decrypt epoch + 1); file encryption records, truncation and reordering detection; listing schema lint; the ledger lint of section 3.

**End-to-end (loopback, three browser contexts):** E-CH-1 two members exchange DMs, delivered states correct. E-CH-2 recipient offline, a holder (third context) holds, recipient returns and receives; with no holder the state is "not delivered". E-CH-3 a stranger without a stamp is dropped; with a stamp lands in requests. E-CH-4 moderator ban hides a key's room messages for all. E-CH-5 group removal: the removed member stops receiving. E-CH-6 host-only refuses `chat.enable` and `files.share` with `E_HOST_ONLY` and no request leaves. E-CH-7 phone class (emulated) relays nothing. E-FI-1 public share, fetch, tombstone, loader stops seeding and refuses fetch. E-FI-2 private share decrypts only for the recipient; a third context with the infohash gets ciphertext only. E-FI-3 an uploaded HTML file downloads as attachment and never renders. E-FI-4 a 25 MiB file on the phone class goes through the chunk store without whole-file memory. E-CH-8 no chat or file data appears in any ledger block (scan all blocks).

**Real devices (new gate rows):** G-CH-1 phone on LTE to laptop on home Wi-Fi: DM delivery rate over 50 attempts, connect failures counted (R5 F4 c). G-CH-2 iOS background: what happens to an open conversation after 10 s, 60 s, 5 min. G-CH-3 two members online together on the hosted example site over a week (swarm-calc check). G-CH-4 file 25 MiB from Android to iPhone. G-CH-5 TURN relay-only, both directions. G-CH-6 stamp time at 20 bits on a low-end Android.

## 13. Build order (agents, after the identity waves)

| Wave | Agent | Owns | Depends on |
|---|---|---|---|
| 0 | Owner | D-C1 to D-C9; site defaults; legal review of public rooms and files | none |
| 1 | C1 ledger-rules | section 3 lint in `src/chain/block.js`, `mw.ck` and `mw.files` schemas, vectors | identity A2 |
| 2 | C2 chat-core | `src/chat/frames.js`, `seal.js`, `tags.js`, `stamp.js`, chat vectors | identity A1 (chat key) |
| 2 | C3 chat-lane | `src/chat/lane.js`, changes to `src/loader/torrent.js` and `policy.js` (budgets, attach rules) | C2 |
| 3 | C4 holders-presence-groups | `holder.js`, presence in `lane.js`, `groups.js` | C3 |
| 3 | C5 file-lane | `src/files/*`, Service Worker serving rule in `src/sw/core.js` | C1, C2 |
| 4 | C6 SDK and UI | `api.js`, `bridge.js`, `sdk.js`, cards in `ui.js` and `strings.js` | C3, C5 |
| 4 | C7 example and drop-in | `examples/peer-guestbook/` Members area, `src/dropin/panel.js` | C6 |
| 5 | C8 tests and gate | `test/unit/chat-*`, `test/e2e/*chat*`, `*files*`, DEMO-RESULTS rows | all |
| later | C9 direct channels, TURN | option B, D-C8, `deploy/` compose file | C3 |

Ship order if time is short (R5 F9): one-to-one DMs (live only) first, then holders, then private files, then rooms, groups and public files.

## 14. What this means for magnet-web

- **Today (0.2.1, true of the code):** visitors in a site swarm exchange signed public ledger entries over `mw_chain1`; a public message list through `mw.db.append` is permanent, public and costs a fee. No private channel, no ECDH, no presence, no file lane, no TURN (R8 "Today").
- **Upgrade (v0.3):** sections 3 to 11: chat lane, sealed DMs, small groups, public rooms, holders, presence, private and public file lanes, the exposure statement and the limits.
- **Cannot:** hide IP addresses from first-hop peers, trackers, STUN or a relay; route WebRTC through Tor; guarantee offline delivery or order across devices; erase messages or files on other devices; scan, moderate or recover private chats and files, so a scan or decrypt order cannot be met technically; tell which keys are real people; keep an iOS page connected in the background; offer forward secrecy before a ratchet tier exists.

## 15. Recommendations

| Pri | Effort | Item |
|---|---|---|
| P0 | S | Section 3 rule in ARCHITECTURE 6 and SECURITY-MODEL, with the lint (R8 P0) |
| P0 | M | Chat-key record with rotation and vectors (D-C5) |
| P0 | M | `mw_chat1` lane under the wire guard, 16 KiB cap, budgets, off by default and in host-only mode |
| P0 | M | S1 sealed box with inner signature, padding, ids, replay set; "no forward secrecy" in help and SECURITY-MODEL |
| P0 | S | Serving rule for uploads (6.6) |
| P0 | S | Recipients-register rows and consent copy (PRIVACY-UPGRADES 5) |
| P1 | M | Stamps, contacts, requests inbox, block, decrypt caps |
| P1 | M | Holder peers and delivery states; blinded opt-in presence |
| P1 | L | Private file lane; then public file lane with tombstone-stops-seeding and owner pin |
| P1 | M | Small groups with epoch rekey; public rooms with ledger bans |
| P2 | M | Direct channels with sealed signalling and the IP warning |
| P2 | S | TURN relay-only per D-C8, off by default, in the compose file |
| P2 | L | Pairwise hash ratchet plus DH step, with outside review before it is called secure |
| P3 | L | MLS tier gated on an audit, a bundle measurement and a commit-ordering rule |
| P3 | M | Owner WebSocket mailbox for Tor Browser users, labelled as a backend |

## 16. Open questions

1. Is a separate chat swarm worth one more announce per tab on phones (R8 Q1)? Measure.
2. How often are two members online together on a small site (G-CH-3)? If rarely, holders and the pin mailbox decide whether chat is usable at all.
3. Fixed `chatBits` 20 or per-site (R8 Q2)? Measure on a low-end phone first.
4. D-C8: static TURN credentials or a credential endpoint, and who pays?
5. Should the owner be able to keep private chat on while turning private files off (R8 Q6)?
6. Which scan or decrypt obligations could reach an owner who enables E2E chat on a static site (UK s. 121 guidance 2026-05-08; EU CSA trilogue; R6 Q4)? Counsel.
7. Can ECDH keys persist in iOS Safari where ECDSA keys were reported to fail (R8 Q5)? Real device.
8. Sources marked "search snippet only" in R8 (iOS background behaviour, Tor and WebRTC, mDNS candidates) must be confirmed from primary pages before public docs quote them.
