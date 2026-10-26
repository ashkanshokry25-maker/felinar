# Red team: stalking, doxxing and deanonymisation (v0.3 proposals against v0.2.1 code)

- **Date:** 2026-10-20. **Role:** attacker with the public code and the design. **Scope:** linking a key to an IP address and a person; what a stalker in the same group learns; what a malicious hub operator learns.
- **Reviewed:** IDENTITY-AUTH-DESIGN.md, REALTIME-AND-FILES-DESIGN.md, PRIVACY-UPGRADES.md (V1 to V8), PRIVACY.md, and code in `src/chain/block.js`, `gossip.js`, `src/loader/config.js`, `torrent.js`, `doh.js`, `app.js`, `api.js`.
- **Labels:** "works today" (v0.2.1), "works against the proposal", "blocked by", "needs measurement". Nothing was run; every claim is from reading the text and code. The cross-site sign-in addendum (SIWE-shaped challenge, widget, server library) has no design text yet, so section 4 attacks the stated requirements.
- **Wording:** "no backend", "site ledger".

## 1. Verdict in one table

| ID | Attack | Label | Sev |
|---|---|---|---|
| A1 | Inbox-tag test: any neighbour matches a public key to an IP through WANT-TAGS | works against the proposal | blocker |
| A2 | Public-presence blinded id is computable from the key: IP to key in one frame | works against the proposal (opt-in feature, but the card does not say it) | major |
| A3 | First-seen origin inference: the neighbour that delivers a block, ROOM frame or ENV first is the author | works today for blocks; works against the proposal for chat | blocker |
| A4 | Sybil swarm harvest: join the public chat lane or ledger swarm, collect every IP, then run A1 to A3 | works today (IPs); works against the proposal (keys) | blocker |
| A5 | Phrase leak is retroactive and total: the derivation is enumerable over public ledger ids | works against the proposal | major |
| A6 | Public link statements and "use the same identity here" publish a permanent cross-site link | works against the proposal | major |
| A7 | Cooperating sites, a server verifier and the tracker/STUN set re-link people by IP and timing despite per-site keys | works against the proposal | major |
| A8 | Photos with EXIF and file names in public listings and private shares | works against the proposal | blocker |
| A9 | Public listing fields and file hashes: known-file confirmation and uploader timing | works against the proposal | major |
| A10 | Stalker in the same group: stranger tag, request stamps, no-ACK oracle gaps, history of one key | works against the proposal | major |
| A11 | Malicious hub operator (shared-origin host, tracker, pin node, TURN) | works today / against the proposal | major |
| A12 | Profile names, writing style, `mw.me` fields and the directory | works against the proposal | minor |
| A13 | Presence timing and write-time correlation (minute-rounded `ts` partly blocks) | needs measurement | minor |
| A14 | WebRTC host-candidate and IPv6 leakage on the swarm path | needs measurement | minor |
| A15 | Moderator or owner role as a surveillance post | works against the proposal | minor |

Already stopped (so not repeated below): sign-in publishes nothing (IDENTITY 4.1, V1); `ts` is rounded to the minute (`block.js` line 55, `roundTs` line 150), which blunts exact-time correlation to about 60 s; per-ledger derived keys stop key-equality linking across sites by default (IDENTITY 3.1); chat bodies, recipients and presence never enter the ledger (REALTIME 3); contact-pair tags use `K_pair` and are not computable by outsiders (REALTIME 5.3); host-only mode keeps a visitor off trackers, STUN and peers (PRIVACY.md lines 18 to 22).

## 2. Attacks on the proposals and the current code

### A1. Inbox-tag test binds a public key to an IP (blocker, works against the proposal)

- **Preconditions:** the target has chat on and has published `mw.ck` (REALTIME 5.2, public). The attacker is any neighbour on the chat lane; no special role, no holder status.
- **Steps:**
  1. Read the target's `ek` from the ledger (the attacker also knows the target's `signKey` from their posts).
  2. Compute today's stranger tag: `SHA-256("mw-inbox-v1|" + ek + "|" + day)[:8]` (REALTIME 5.3). Every input is public.
  3. Watch WANT-TAGS frames (0x05, up to 32 tags, REALTIME 4.2). A recipient lists "its own inbox tag" there so holders can return mail. Any neighbour receiving that frame sees it, not only holders.
  4. The wire that sends a WANT-TAGS containing the computed tag is the target. Its IP is known to the attacker as a WebRTC peer.
- **Gain:** key to IP, hence to ISP, city and often a home address by IP geolocation and subscriber records (a stalker needs only a subpoena-free city-level result to start). It also gives a live "is online" feed for that person while they are on the site, even with presence off, which defeats V5's "nobody sees you as online unless you turn it on".
- **Who is harmed:** anyone with chat on, worst for people who post under a pseudonym on a sensitive site.
- **Scale:** one passive connection per site; the test is a table lookup over all keys on the ledger, so it deanonymises every chat-enabled member at once (cost: one SHA-256 per member per day).
- **Why the design misses it:** the doc treats the inbox tag as hiding "who", but it is a deterministic function of a public key, and the recipient has to disclose it to get mail. The pair-tag path is fine; the stranger path is not.
- **Cheapest defence:** do not send the stranger inbox tag in clear on WANT-TAGS. Options, cheapest first: (a) bucket the stranger tag to 8 bits of a hash of `ek` so about 1 in 256 of members share each tag (k-anonymity; cost: roughly 256 times more trial decryptions of strangers' mail, capped by the existing 50 attempts per peer per second); (b) request held mail only over the private contact tags plus a salted bucket; (c) drop stranger-to-stranger offline delivery in v0.3 (strangers reach you only live, while both are online; message requests need the recipient online). Cost to honest users: (c) means a first message to an offline stranger is not delivered; (a) costs CPU.

### A2. Public presence is a key-to-IP beacon (major, works against the proposal)

- **Preconditions:** the victim turns on "visible to everyone on this site" (REALTIME 5.1). The attacker is a neighbour.
- **Steps:** `bid = HMAC(K_site, "pres|" + pub + "|" + day)[:8]` where `K_site = SHA-256("mw-pres-v1|" + ledgerId)` is computable by anyone. Precompute every member's bid for the day; PRES every 30 s names the IP.
- **Gain:** key to IP plus a live online/away timeline (sleep schedule, workplace hours, time zone) for stalking.
- **Defence:** this is the toggle working as written, but the card says only "shows the people connected to you that this IP address is here". It should say "and which of your names it belongs to, to everyone who can reach you". Cost: wording. A real fix is to make public presence a roster published by an optional hub, which is a backend; do not.

### A3. First-seen origin inference (blocker, works today for blocks, against the proposal for chat)

- **Preconditions:** attacker holds many connections (A4), or just one adjacent to the target.
- **Steps today (code):** `gossip.js` announces new blocks with ANN to every other peer at once and sends a coalesced HELLO 250 ms after a head change (lines 33, 433 to 447); there is no random delay on first send. A node that sees a new block arrive from wire W before any other wire, and whose own link set is wide, concludes W's operator authored it. Block `author` is a public key, so the block itself is the key-to-IP evidence.
- **Steps for chat:** ENV and ROOM frames are flooded with "hop limit 4" (REALTIME 4.2). If the hop count is carried in the frame and a sender sends at the maximum, a neighbour reads "remaining hops = 4" and knows the sender is the origin. Even with a hidden counter, first-seen timing across a wide Sybil set identifies the entry point. ROOM frames carry the author key in plaintext, so every room message is a signed IP-to-key link for first-hop neighbours (the proposal admits this for neighbours; it understates that a Sybil can be everyone's neighbour).
- **Gain:** IP to key for every poster, and for ENV (DM) frames the IP of the sender to the extent the recipient tag is known (A1).
- **Scale:** automated, passive, no interaction with the victim.
- **Defence (cheapest first):** (1) per-frame random send jitter 0.5 to 3 s before first relay and before the HELLO head update, plus relay to a random subset (not every peer) on first hop; (2) no hop counter, use dedupe plus a TTL by age; (3) optional "send via a random relay" (one extra hop through a peer chosen at random) for posts and DMs, a mix-network of depth 1. Cost: delivery delay of seconds; (3) adds one more party who sees the plaintext of ROOM/ENV size and timing. Be honest that none of this hides a global observer; the docs already say IP is visible to first-hop peers.
- **Needs measurement:** how many connections a Sybil needs. `config.js` caps wires per class; tracker `numwant` sets how many offers each announce returns (lines 57 to 86). Measure on the lab to state a number.

### A4. Sybil harvest of the swarm (blocker, works today for IPs)

- **Preconditions:** none. The ledger rendezvous infohash is `sha1hex("mw-ledger/1/" + ledgerId)` (`torrent.js` line 203 to 208) and the chat lane infohash is `sha1("mw-chat1|" + ledgerId)` (REALTIME 4.1). Both are computable from a public ledger id. Any WebSocket tracker returns peers to anyone who announces.
- **Steps:** announce from many addresses, collect peer offers over weeks (a tracker scrape or repeated announces), connect, speak HELLO, and log `peerId` plus IP. Join the chat lane the same way. Then combine with A1 to A3.
- **Gain:** the full audience list of a site over time, with join/leave times. Combined with a key list, an IP to key table for the whole membership. PRIVACY.md already says "including people who join only to record addresses" for IPs; the new thing is the key join.
- **Defence:** keep chat lane id secret for private groups (already, REALTIME 4.1); for the public lane accept the exposure and say so with numbers once measured. Add a per-IP-prefix cap on wires and an owner option "members-only lane id" derived from a secret shared in a signed invite (cost: invite flow). For small or at-risk sites, default chat to off (already the plan).

### A5. Phrase leak is retroactive and total (major, works against the proposal)

- **Preconditions:** the 12 words (128 bits) leak once (phishing, a photo of the paper, shoulder surf, a family member). IDENTITY 9 names this and accepts it.
- **Steps:** `siteSeed = HKDF(root, "seed|" + ledgerId)`; the attacker derives the key for every ledger id he can list (the directory, search, a crawl of public pointers). Matching `e.author` values on those ledgers reveals every site the person ever used and all their posts, plus the vault key `K_vault` derivation for any copy of their backup, plus `K_name`, so opaque list names `mw.r.*` resolve to records.
- **Gain:** a stalker with access to a partner's phrase gets a complete history across sites, including sites the victim thought were unlinkable. Past messages are also readable if the stalker kept ENV frames (no forward secrecy).
- **Defence:** (1) keep the root a 32-byte secret with an optional passphrase mixed into HKDF (a "25th word", cost: one more secret to remember), so a leaked phrase alone enumerates nothing; (2) offer per-site `siteSeed` export only for QR hand-off (already) and keep default recovery per site as an option; (3) tell the user that one phrase opens everything (already in V3). Cost of (1): lost passphrase equals lost identity. The design flags this as open question 6 (128 bits); the privacy cost is bigger than the brute-force cost.

### A6. Link statements and "use the same identity here" publish the join (major, works against the proposal)

- **Preconditions:** the person picks the explicit same-identity option, or migrates a 0.2.1 key.
- **Steps:** migration writes `append('mw.link', { from: legacy pub, to: new pub, ... })` to the public ledger (IDENTITY 3.7). A same-identity choice across sites must either reuse a public key (equal key on both ledgers, trivially joinable by anyone) or publish a signed statement joining two keys. Both are permanent in the site ledger and in every peer's copy; tombstones hide, they do not erase.
- **Gain:** a permanent public join between a pseudonym on a harmless site and the identity on a sensitive one, or between a work identity and a personal one. Scrapers can build the join table for the whole population. `did:key` display (IDENTITY 3.6) hands attackers a stable cross-site handle if a UI shows it.
- **Defence:** make the same-identity choice per site, revocable in the card, with a plain warning that it is permanent and public on this site's ledger; allow link statements to be sealed (shown only to a named verifier by presentation proof) instead of published; never put the link in a public list by default. For server-backed sites, same-identity means the server sees the shared key only, not a ledger write (no permanence beyond that server). Cost: more UI.

### A7. Cross-site re-linking by metadata despite per-site keys (major, works against the proposal)

- **Preconditions:** two sites, one attacker running both (or two colluding operators), or one tracker/STUN operator serving many.
- **Steps:** (1) the same IP appears at both sites' trackers within the same minute after one sign-in; (2) the loader announces the same `peerId`-style behaviour and the same WebRTC fingerprint set; (3) the server verification library reads `domain, ledger/origin, nonce, iat` and the server logs IP and user agent; the two operators join the logs; (4) the drop-in widget on many existing sites loads from one place, so its host sees every site a person signs in to by IP and timing.
- **Gain:** the property "sites cannot link a person across sites" holds for keys only. The design says so ("IP, timing, reused names, writing style" in IDENTITY 9) but the cross-site product raises the stakes: it is advertised as a passkey-like login, and users will expect passkey-like unlinkability.
- **Defence:** (1) host the widget script from each site's own origin or sign it with a hash the site pins, so no third party sees visits (cost: owners vendor a file); (2) a per-site random delay of the first tracker announce (already `joinJitterMs` 1500 in `config.js` line 85, widen to 5 to 20 s for sign-in-linked sites); (3) the verification library must not log or return IP and must document that the challenge carries no user-linkable field; (4) state that a server-backed site sees the visitor's IP at sign-in, always. Cost: seconds of delay, vendoring.

### A8. Photos with EXIF (blocker, works against the proposal)

- **Preconditions:** files lane on (public F1 or private F2), users upload camera photos, which commonly carry GPS, device model, serial and time.
- **Steps:** download a public listing (`mw.files`: `ih, len, name, mime, sha256, t`); a private file is fetched by anyone who gets the infohash but only decryptable by recipients (members can leak); a recipient or any member of a public lane reads EXIF from a photo's original bytes. The design transmits the original bytes (REALTIME 6.2, 6.3) and previews with `createImageBitmap` (6.6), which does not remove metadata from the stored/shared file.
- **Gain:** exact home location, timestamps, camera id; a stalker finds where someone lives from one profile photo or "check out my new desk" picture. This is the most common real-world doxxing path.
- **Who is harmed:** every uploader, especially those who think a pseudonymous site protects them.
- **Defence:** re-encode images in the loader before sharing (canvas or `createImageBitmap` then re-export to JPEG/WebP strips EXIF, ICC and thumbnails; cost: quality and a few hundred ms, and some size growth), on by default with a "keep original" switch in a warning card; strip PDF, Office and video metadata is not possible in a browser reliably, so for non-image types show "this file may contain your name, location or device information" and allow only images, plain text and PDFs in v0.3. Also show a preview of the metadata that will be removed. File names also leak (`IMG_20261019_Smith.jpg`): default to a random display name with the original optional.

### A9. Hashes, sizes and timing on file listings (major, works against the proposal)

- **Steps:** (1) public `sha256` lets anyone confirm a known file (a leaked document, a photo the attacker already holds) is on the site and who listed it, with `t` to the minute and `author` key; (2) a private file's infohash and size are visible to all seeders; a stalker who has a copy of a particular file computes its ciphertext size (plaintext size + 16 bytes per 64 KiB + prefix) and watches for torrents of that size, linking uploader and recipients by IP (V7 admits existence and size leak); (3) file sizes in `len` identify camera models and screenshots; (4) the seeder list for the infohash is a list of IPs of everyone who holds it.
- **Defence:** pad private files to size buckets (cost: up to 2x on the last bucket, say powers of two above 1 MiB); omit plaintext `sha256` from public listings for files tagged private-ish or use a salted hash that only the fetch path needs (cost: lose the cross-copy dedupe and "same file" verify); for sensitive sites require unlisted infohash plus request-only fetch.

### A10. The stalker inside the group (major, works against the proposal)

- **Stranger first contact:** anyone can write to anyone's inbox tag (computable) with a work stamp of about 1.05 million hashes (REALTIME 5.6); the stamp is a fee, not a defence, and a determined harasser pays it. The recipient only learns "a request arrived". **Defence:** requests require a prior signed introduction by a mutual contact or the owner's `allow` list; default `setOpen(false)`; block lists sync across devices in the sealed record (cost: slower first contact).
- **Ban evasion:** bans are per key; a stalker mints a new key per ledger (Sybil, IDENTITY 9). A PoW fee of 16 bits is seconds. **Defence:** for sites with chat, raise write `bits` for new keys and add an age/reputation gate for DMs to strangers (cost: friction for real newcomers).
- **Key history as a stalking tool:** every post by a key is public and permanent; a stalker follows one key's whole history. **Defence:** the "rotate site key" feature (D-10) is also a privacy feature, not only a recovery one; offer "start a new identity on this site" with one tap and no link statement.
- **Profile enumeration:** `mw.ck` and `profile` names are readable by any peer. **Defence:** show names only to contacts on request (cost: discovery harder).
- **Online oracle:** the "no ACK to strangers" rule blocks a direct probe, but the delivery state ("held by N peers") and WANT-TAGS (A1) restore it. Fixing A1 closes this.
- **Screenshots and forwarding:** by design they cannot be stopped (V8).
- **Location by relaying:** a stalker on direct channels sees the victim's IP; the card says so, but a stranger who "connects directly" only needs one tap from the victim. **Defence:** direct channels refuse non-contacts (cost: P2 feature narrower).

### A11. Malicious hub operator (major)

Hub means the shared-origin host that serves several sites, the static host, a tracker, a pin node or a TURN relay.

- **Shared-origin hub (works today):** it serves the loader, so it controls the code that sees the unlocked key. It can log IP, sites visited and, with the loader, read vault contents after unlock (IDENTITY 6.5). It can also ship a loader that publishes the root. The design's honest note stands; the added risk is that persistent identity on a shared hub links all of a person's sites through one origin's IndexedDB. The plan already says "refuse persistent identity" on shared-origin hubs; keep that as a hard rule and test it (E-7).
- **Tracker operator (works today):** sees IP, `ledgerId`-derived infohashes (so which site, though only a hash; a dictionary of known ledgers un-hashes it), announce times and WebRTC offers. With chat on, adds the chat-lane infohash, so the operator knows which IPs use chat on which site. **Defence:** owner-chosen tracker list through the signed pointer (exists), plus optional self-run tracker; cost: owner effort.
- **TURN operator (works against the proposal, D-C8):** static public credentials make every visitor use a shared relay that sees both IPs and timing of every direct channel. **Defence:** keep TURN off by default (done); when on, show the operator by name (done).
- **Pin-node owner:** sees every IP that fetches or uploads and the plaintext of public files; for private mailbox, tags and sizes. **Defence:** documented; avoid mailbox on the same node as the site owner's analytics.
- **DoH resolvers (works today):** Cloudflare, dns.sb and Google see the IP and `_magnet.<site>` every 5 minutes while the page is open (`doh.js`, PRIVACY.md line 36). This is a presence beacon for a visitor even without chat: the resolver learns "this IP kept the page open for N hours" and the site name. **Defence:** `mw-doh` custom resolver (exists); lengthen the poll when the tab is hidden; cost: slower pointer updates.
- **Compromised owner key (policy):** the owner can set `allow`/`bans`, but cannot read sealed records; owner can ship new code to sign-in cards that capture phrase entry. Hence the phrase-phishing note, and the identity origin recommended in IDENTITY 6.5.

### A12. Profile metadata, styles and the directory (minor to major by site)

- Display names are public and reused; stylometry, posting hours (minute-rounded `ts`) and writing habits link pseudonyms across sites with no key match. The directory (the list of known ledgers/pointers) allows A5 enumeration and the pseudonym search ("find this username on every magnet-web site"). `mw.me` fields (`contacts`, `files`) are sealed but of fixed size, and reserved names exclude PII (good).
- **Defence:** no global name search; discourage identical names across sites in the sign-in card ("this name is already used on N sites you use", computed locally, never uploaded); cost: a hint.

### A13. Presence and write timing (needs measurement)

- PRES every 30 s with 8-byte ids and flags; a neighbour gets an IP-level uptime log even if ids are blinded. Write-time and PoW completion times (16 bits is about seconds on a phone) fingerprint device classes. **Measure:** time to mine at the default bits on three device classes, and whether the minute-rounded `ts` plus PoW wait leaks the device class.

### A14. WebRTC address exposure (needs measurement)

- Host and IPv6 candidates can reveal local addresses or a stable IPv6 suffix that identifies a device across networks; mDNS-obfuscated host candidates are browser dependent. The proposal says IP is visible to peers; it does not say what else. **Measure:** log the candidates from the lab on Chromium and WebKit with and without mDNS masking, and say what each browser exposes.

### A15. Roles as surveillance posts (minor)

- Moderators and the owner see public rooms and can mint advisory roles; a moderator who is also a Sybil observer (A4) sees the audience. Nothing stops an owner from running A1 to A4 against their own members. **Defence:** state it in the owner docs; the owner's pin node should log nothing by default.

## 3. What the design already stops (no action)

1. Sign-in as a ledger event: not written, so no permanent presence log.
2. Direct key equality across sites: HKDF per ledger id, vectors in tests.
3. Exact post times: minute-rounded `ts`.
4. Private record contents, sizes (fixed 1,024-byte plaintext) and list names (opaque, HMAC).
5. DM bodies and recipients on the wire from outsiders (sealed envelope) when the tag is a pair tag.
6. Challenge replay across sites (domain and ledger bound).
7. Silent seeding of unopened files and background presence from hidden tabs.

## 4. The cross-site sign-in (stated requirements, no design text yet)

| Concern | Attack | Label | Cheapest defence |
|---|---|---|---|
| Server learns IP plus key | any server-backed site stores `pub`, IP, time; a breach or a subpoena yields them | works against the proposal | state it; no way around it for a server; keep the library free of logging |
| Fake verifier | an attacker site asks for a signature for `domain = bank.example` | blocked by loader-owned card showing the real origin and by `aud` | the loader reads origin itself, never from page text |
| Challenge farming | a site gets the user to sign a nonce for a victim site's verifier | blocked by domain/origin binding if the loader fills `domain` from `location` | never accept domain from the page |
| Same-identity prompt fatigue | a site repeatedly asks "use the same identity here" until the user taps yes | works against the proposal | one prompt per site per 30 days, default "no", show the list of sites that would be joined |
| Widget host sees all sign-ins | drop-in widget served from a central host | works against the proposal | self-hosted widget, SRI hash |
| Passkey sync | provider sees which RP IDs exist | not magnet-web's leak, but state it | wording |
| Recovery phrase scanning | QR hand-off over a camera in view of others | needs measurement | short authentication string present; add 2-minute expiry |

## 5. Ranked fixes (cost to honest users)

| Pri | Fix | Closes | Cost |
|---|---|---|---|
| P0 | Stranger inbox tag: bucket or drop offline stranger delivery; never put it in WANT-TAGS | A1, A10 oracle | slower first contact |
| P0 | Strip EXIF by re-encoding images by default; random display file names; limit file types | A8 | image quality, a few hundred ms |
| P0 | First-relay jitter, no hop counter, relay subset | A3 | seconds of delay |
| P1 | Public-presence wording and a roster-less default | A2 | wording |
| P1 | Passphrase-mixed root option; recommend per-site export only | A5 | forgetting risk |
| P1 | Link statements not public by default; per-site revocable same-identity | A6 | UI |
| P1 | Widget self-hosting with SRI; delay announces at sign-in | A7 | owner effort, seconds |
| P2 | Private-file size buckets; salted public hashes | A9 | space, dedupe |
| P2 | Wire caps per IP prefix; members-only lane id option | A4 | invite flow |
| Measure | Sybil connection count; PoW time by device; WebRTC candidates; DoH poll when hidden | A3, A13, A14, A11 | lab time |

## 6. Assumptions and limits of this review

- Nothing in the lab was run; the text of the design was the target. Where the doc is silent (hop counter format, widget host, directory) I marked it "needs measurement" or attacked the stated requirement.
- A global passive observer, a state with ISP records, and a malicious browser are out of reach of every defence here; the docs should keep saying so.
