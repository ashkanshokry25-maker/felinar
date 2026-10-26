# Privacy upgrades for v0.3: every failure, what we do, what remains

- **Status:** synthesis, 2026-10-20. A proposal; nothing here is shipped. Applies to magnet-web 0.2.1 and the planned v0.3 (self-owned identity, sign-in, private records, chat, files).
- **Built from:** [R2 privacy failures](R2-privacy-failures-2026.md) (findings F1 to F17, all sources accessed 2026-10-20), with [R3](R3-identity-auth-landscape.md) for identity, [R6](R6-legal-compliance.md) for law and [R8](R8-realtime-chat-and-files.md) for chat and files. Repo baseline: [PRIVACY.md](../../PRIVACY.md) ("In short", "Recipients register"), [SECURITY-MODEL.md](../../SECURITY-MODEL.md) ("What is not protected").
- **How to read a row:** *Problem* (with its evidence and source), *0.2.1 today* (S solves for what it controls, M mitigates, N does not address), *v0.3 upgrade*, *Residual risk* (what remains after the upgrade), *Docs may say* (a sentence that is true once the upgrade ships; sentences true today are marked "(today)").
- **Wording:** "no backend", "site ledger". Nothing here says magnet-web is private by default. It is not.

## 1. Summary (10 bullets)

1. **Seventeen failures of today's web are mapped (R2 F1 to F17), plus eight that v0.3 itself introduces (V1 to V8).** Each row ends with a sentence the docs may use, so PRIVACY.md and WHY.md can be rewritten from this file.
2. **What 0.2.1 already solves, for itself:** no analytics, no third-party scripts in the loader, no cookies, no accounts, no passwords, no identity provider, nothing contacted before the visitor chooses (PRIVACY.md "In short"). These are claims about absence, true of the loader, not of whatever an owner adds.
3. **What v0.3 can add:** keys derived per site from one root (no cross-site key), a sign-in with no identity provider, private records only the visitor's keys open, a fixed-size padded record, opt-in presence, encrypted chat and files, a relay option, separate opt-ins for sign-in, presence, chat and uploads.
4. **What no version can add:** IP anonymity against peers, trackers, STUN and relays; deletion of copies that left; recovery of a lost phrase; protection from code on the same origin while the page is open; age verification (R2 section 5).
5. **The single most important residual:** after sign-in, a peer who sees an IP address and a signed entry can link them. Pseudonymous keys do not prevent this (R2 F16). The UI must say it before the first networked use of the key.
6. **A design conflict blocks the private record:** PRIVACY.md says "No personal data in the ledger, even encrypted" (line 158). This file recommends resolving it with a local-first vault plus an opt-in, fixed-size, sealed record that is declared as personal data (section 4), pending owner and counsel decision.
7. **New finding of this synthesis:** a private record encrypted under a key derived from the recovery root cannot be crypto-shredded per site while the phrase exists, because the phrase re-derives the key. Erasure per site is tombstone only; full shredding means destroying the root and every backup (section 4.3). R3 and R6 assumed key deletion was available; it is not, in the derived design.
8. **Same-origin code is the hard boundary.** The loader can make keys non-extractable and gate SDK calls behind loader-owned cards, but a hostile script on the site's origin can still use the key and read decrypted data while the page is open (R3 F18; w2c-03-VERIFY claim 1). Only a separate identity origin changes this (design in v0.3, build later).
9. **Default posture for v0.3:** every new feature off until the visitor opts in for that feature; guest reading never sends a key; host-only mode turns off sign-in publication, presence, chat and file sharing; phones never relay by default (R2 P0; R6 P0 4).
10. **The recipients register in PRIVACY.md gains six rows** (chat peers, holder peers, file-swarm peers, TURN relay, owner pin mailbox, the identity on every signed message), each with what it receives, when and the default (section 5).

## 2. Today's failures (R2 F1 to F17)

### F1. Third-party tracking
- **Problem:** at least one tracker on 75% of desktop and 74% of mobile pages; `_ga` on 46% of pages (HTTP Archive Web Almanac 2025, https://almanac.httparchive.org/en/2025/privacy, accessed 2026-10-20, High). The FTC staff report of 2024-09-19 described "vast surveillance" by nine platforms (High).
- **0.2.1 today:** S for the loader (no tracker, no analytics); N for scripts the owner embeds, which run with loader privilege in per-domain and drop-in modes (SECURITY-MODEL).
- **v0.3 upgrade:** a build-time audit that lists every third-party origin a built site contacts and fails a "no third-party origins" profile; the example site passes it.
- **Residual:** the owner's own embeds; browser-level tracking from other sites; tracker operators see IP plus infohash for every magnet-web site a visitor opens with sharing on.
- **Docs may say:** "magnet-web adds no tracker. It does not remove the ones you add." (today)

### F2. Fingerprinting
- **Problem:** WWW 2025 measurement found fingerprint changes altered ad bids and that fingerprinting can bypass opt-outs (search summary, Medium).
- **0.2.1 today:** N. The loader does not fingerprint, but a stable posting key is visible to every peer, and WebRTC behaviour is observable (inference, Low).
- **v0.3 upgrade:** one unrelated key per site from one root (R3 F21); private profile fields encrypted; the padded fixed-size record hides field lengths.
- **Residual:** fingerprinting by any script on the origin; IP plus key linking inside one swarm.
- **Docs may say:** "Each site sees a different key for you, so two sites cannot match you by key. They can still match you by IP address, a reused name or timing."

### F3. Data brokers and real-time bidding
- **Problem:** brokers feed platform profiles (FTC 2024); California's DROP platform opened 2026-01-01 with brokers processing from 2026-08-01 (cppa.ca.gov and Malwarebytes, Medium).
- **0.2.1 today:** M by absence: no ad call, no bid request, no email to match.
- **v0.3 upgrade:** a written rule in the SDK and docs: no email, phone, real name, date of birth, ID document or face image in sign-in, in the ledger or in file torrents by default; the example site never asks (R2 P0).
- **Residual:** brokers already hold the visitor's IP and device; peer-visible IP addresses are raw material for monitoring firms.
- **Docs may say:** "Signing in never asks for your email, phone number or name."

### F4. Breaches
- **Problem:** Verizon 2025 DBIR: 12,195 confirmed breaches, 30% with a third party, 22% starting with credential abuse (verizon.com, High).
- **0.2.1 today:** M: no backend, no user table, no password hashes. The weak point is the host and DNS as trust root.
- **v0.3 upgrade:** private records sealed to visitor-derived keys, so a copy of the ledger or a `cs=` snapshot reveals ciphertext, a fixed size and a time.
- **Residual:** device compromise, malicious extensions, a stolen owner key, a compromised host serving hostile code that reads records when a visitor unlocks.
- **Docs may say:** "There is no accounts table to breach. Your private record is stored only as ciphertext; a copy of the site ledger does not reveal it."

### F5. Consent dark patterns
- **Problem:** only 11.8% of 680 consent-platform instances met minimal legal requirements (Nouwens et al., CHI 2020, older, Medium).
- **0.2.1 today:** M: no tracking banner, but the loader's own card is a dark-pattern risk if its 0.30 planning consent rate (CRITIQUE) tempts design changes.
- **v0.3 upgrade:** a tested equal-prominence rule (same size, same layer, no pre-selection; the host-only path takes no more clicks than the share path) and separate opt-ins per feature: sign-in, presence, chat, uploads (R2 P1).
- **Residual:** whether consent is a valid basis for Service Worker storage and peer upload is an inference; counsel must confirm (CRITIQUE; R6 F4).
- **Docs may say:** "Each feature asks once, on its own, and 'not now' is as easy as 'yes'."

### F6. Cross-device identity graphs
- **Problem:** hashed-email identifiers and mixed matching (UID2, RampID, ID5) join people across devices; the FTC said in July 2024 that hashing does not anonymise (trade sources, Medium to Low).
- **0.2.1 today:** M: no email or phone; one key per ledger.
- **v0.3 upgrade:** per-site derivation from one root; the root never leaves loader-owned code; no email-based sign-in; a voluntary link statement is the only way to prove two site keys are one person (R3 F21).
- **Residual:** the IP address is the common thread across swarms (inference supported by F16 studies). Mobile carrier shared addresses blur it; home broadband does not.
- **Docs may say:** "Nothing in magnet-web ties your identities on two sites together unless you choose to link them."

### F7. Email and link tracking
- **Problem:** Apple Mail Privacy Protection inflates opens; reliable pixel-prevalence figures were not found (Low).
- **0.2.1 today:** N, out of scope: it sends no email.
- **v0.3 upgrade:** private-share links and group invites carry their key in the URL fragment (not sent in HTTP requests) and a warning that pasting them into a tracking mailer leaks the key to the mailer.
- **Residual:** outside magnet-web once a link leaves through email.
- **Docs may say:** "An invite link is a key. Anyone who sees it can use it, including your email provider."

### F8. Password databases and credential stuffing
- **Problem:** Have I Been Pwned added 1,957,476,021 unique emails and 1.3 billion passwords on 2025-11-05 (troyhunt.com, High).
- **0.2.1 today:** S by absence: no passwords; also no login and no recovery.
- **v0.3 upgrade:** key-based sign-in with a challenge bound to origin, ledger and time; a 12-word recovery phrase; optional passkey wrapping (IDENTITY-AUTH-DESIGN 3, 4).
- **Residual:** phishing for the phrase replaces phishing for a password; same-origin scripts can use an unlocked key; no help desk; no proof that one person holds one key.
- **Docs may say:** "There is no password to steal or reuse. Anyone who has your 12 words is you, and nobody can reset them."

### F9. Sign-in with a big provider
- **Problem:** an OpenID Connect provider issues a token per relying party and so can learn each login (architecture, Low); user reports of lockout after provider suspension (Low, anecdotal).
- **0.2.1 today:** S (no identity provider) but no login either.
- **v0.3 upgrade:** sign-in proven in the browser against the site ledger; no third party learns that a login happened; the example site carries no identity-provider script.
- **Residual:** peers see a key's activity when it writes or chats; the login itself is never published (IDENTITY-AUTH-DESIGN 4.1).
- **Docs may say:** "Signing in tells no company that you signed in. It happens in your browser."

### F10. Age verification and digital ID
- **Problem:** Free Speech Coalition v. Paxton (June 2025) upheld Texas age checks; Utah SB 73 (signed 2026-03-19) reaches VPN users (eff.org, High); about 70,000 Discord ID photos exposed through a vendor in October 2025 (Medium).
- **0.2.1 today:** N. PRIVACY.md advises host-only for children's sites; there is no owner switch that forces it.
- **v0.3 upgrade:** no age check is built. A reserved attestation slot (a yes or no from an external issuer, never a document) is designed, not built; chat, files and profiles are off on any site tagged for children unless the owner adds an external age method (R6 F10).
- **Residual:** a site legally required to verify visitors has no compliant path inside magnet-web alone.
- **Docs may say:** "This software cannot check anyone's age, and it never stores identity documents."

### F11. AI scraping and training
- **Problem:** Cloudflare (2025-08-29): crawls per referred visit in July 2025 were 38,065.7 for Anthropic and 1,091.4 for OpenAI; training rose to 79% of AI crawling (blog.cloudflare.com, High).
- **0.2.1 today:** N, and public posts are easier to copy than on a normal site: anyone can join the ledger swarm, and there is no robots.txt for a swarm.
- **v0.3 upgrade:** private records, private chats and private files are ciphertext to scrapers; public posts are labelled "public and copyable by anyone" in the UI; every sealed record carries an algorithm tag so it can be migrated.
- **Residual:** public means scraped. Ciphertext can be stored and read later if P-256 key agreement is broken (NIST IR 8547 draft proposes deprecating ECC by 2030, secondary source, Medium).
- **Docs may say:** "Public posts can be copied by anyone, including AI crawlers. Private records and messages are encrypted."

### F12. CDN, DNS and cloud centralisation
- **Problem:** the AWS us-east-1 DynamoDB DNS fault of 2025-10-19 to 20 (aws.amazon.com/message/101925, High); the Cloudflare outage of 2025-11-18, about 5 h 46 min (blog.cloudflare.com, High).
- **0.2.1 today:** M: cached sites and peer-copied ledgers help returning visitors (code reading; not shown on real networks). Imports its own defaults: Cloudflare and Twilio STUN, Cloudflare DoH first, four small trackers.
- **v0.3 upgrade:** a documented "no big-provider defaults" profile (own tracker, own STUN, own DoH meta); chat and files add no hosted relay by default; any relay is the owner's and named in the consent card.
- **Residual:** first visits, updates and new visitors still need the host and DNS.
- **Docs may say:** "Returning visitors can read a site they already have when its host is down. New visitors cannot."

### F13. ISP and network metadata
- **Problem:** Salt Typhoon reached call-record metadata at US carriers (disclosed December 2024, Medium to Low). WebRTC always shows the public IP to peers and STUN; Tor Browser disables WebRTC (docs/research/03-webrtc-nat-privacy.md).
- **0.2.1 today:** N. The ISP sees the host, the tracker names, STUN and DTLS to peers. DoH moves the DNS query from the ISP to the resolver.
- **v0.3 upgrade:** owner-run TURN with a relay-only visitor setting; mobile defaults stay host-only for uploads; the docs state that swarm features do not work in Tor Browser.
- **Residual:** an observer can tell that a visitor uses a WebRTC peer client, and when; chat timing and size classes remain visible.
- **Docs may say:** "Your internet provider can see that you use a peer-to-peer site and when. It cannot read encrypted messages."

### F14. Lock-in and deplatforming
- **Problem:** account moves are partial on Mastodon and still a developer task on Bluesky (secondary, Low to Medium).
- **0.2.1 today:** M: the owner can move hosts (signed pointer plus infohash); the visitor's key is theirs and exportable.
- **v0.3 upgrade:** one root with per-site keys, so a ban on one site touches no other; export of one's own decrypted records in a standard JSON file.
- **Residual:** a banned visitor loses standing on that site; the host or registrar can still remove the domain.
- **Docs may say:** "No platform can suspend your identity. A site's owner can still ban your key from that site."

### F15. The economics behind it
- **Problem:** Google, Meta and Amazon take most digital ad spend (secondary, Medium to Low).
- **0.2.1 today:** N. No ad, payment or subscription layer; the hashcash fee is paid to nobody.
- **v0.3 upgrade:** none that changes incentives; it removes reasons to hold personal data.
- **Residual:** structural.
- **Docs may say:** "magnet-web does not change how the web makes money. It makes it easier to run a site that does not need your data." (today)

### F16. Surveillance of the swarm itself
- **Problem:** monitors logged IPs in popular BitTorrent swarms within about three hours of joining (Birmingham 2008, older); Omnify saw 2.75 million swarms and 71 million IPs (2011, older, Medium). Anyone who knows an infohash can list who is online (SECURITY-MODEL).
- **0.2.1 today:** N, stated in PRIVACY.md, SECURITY-MODEL.md and WHY.md.
- **v0.3 upgrade (none gives anonymity):** host-only as an equal choice; a relay option; read the ledger snapshot over HTTPS without announcing; sign-in only after the swarm opt-in, and guest reading never sends a key; presence off by default and blinded for contacts; no cross-site key; secret-derived swarm ids for private groups (R8 Option C).
- **Residual:** peers and relays see IP addresses; trackers see infohash plus IP; STUN sees IPs; a malicious visitor can record who is online, when, and which keys post.
- **Docs may say:** "When you sign in and write, other visitors can link your IP address to your key. A relay hides your address from them and shows it to the relay's operator instead."

### F17. Permanence of the public site ledger
- **Problem:** EDPB Guidelines 02/2025 favour keeping personal data off a shared ledger and treat encrypted personal data as personal data (version 2.0 reported adopted 2026-07-07; law-firm summaries, Medium; R6 F1). Applied here by analogy.
- **0.2.1 today:** consistent: no personal data in ledger values (PRIVACY.md line 158).
- **v0.3 upgrade:** the decision in section 4.
- **Residual:** whichever option is chosen, some copy outlives a deletion; tombstone stubs keep the author key, the time and the hash.
- **Docs may say:** "Deleting an entry removes its content from every copy that receives the deletion. It does not remove who signed it and when." (R6 wording, today)

## 3. Failures v0.3 introduces (V1 to V8)

### V1. Sign-in links an IP address to a key
- **Problem:** pseudonymous keys plus visible IPs make every signed action attributable to an address by any peer (R2 F16).
- **Today:** posting already does this for posters; there is no sign-in.
- **Upgrade:** the "what others can see" card before the first networked use of the key; sign-in works locally in host-only mode; nothing is published at sign-in (no sign-in event in the ledger).
- **Residual:** every post, presence beat and message from a direct neighbour carries the IP link.
- **Docs may say:** "Signing in is local. Writing, chatting or showing yourself as online lets the people connected to you see your IP address next to your key."

### V2. Same-origin code uses the key
- **Problem:** site code runs with loader privilege; a non-extractable key is still usable from the same origin (w2c-03-VERIFY claim 1); in 0.2.1 it is extractable (`src/loader/app.js` line 546).
- **Today:** worse than v0.3: export is possible.
- **Upgrade:** non-extractable keys; root and vault keys derived on demand inside loader code and dropped after use; SDK reads of private fields behind a loader card per session (IDENTITY-AUTH-DESIGN 6.5).
- **Residual:** a hostile script, a compromised third-party tag or an XSS on the origin can act as the visitor and read what the visitor unlocks while the page is open. The cards stop honest-but-curious code, not hostile code.
- **Docs may say:** "The site you are on can act as you while you are signed in to it. Sign in only on sites you trust."

### V3. Phrase phishing and recovery abuse
- **Problem:** a fake "restore your account" page can ask for the 12 words.
- **Today:** no phrase exists.
- **Upgrade:** the phrase is only ever entered in loader-owned UI; the loader never asks for it unprompted; the backup card says "No one will ever ask you for these words"; QR hand-off uses a short authentication string (IDENTITY-AUTH-DESIGN 3.5).
- **Residual:** a visitor who types the words into a look-alike page loses every site identity at once (R3 F22).
- **Docs may say:** "Never type your recovery words anywhere except the restore screen you opened yourself."

### V4. The private record's metadata
- **Problem:** a sealed record still shows author, existence, time and size.
- **Today:** no record.
- **Upgrade:** fixed 1,024-byte padded plaintext so every record has the same size; opaque list name; written only on change.
- **Residual:** author key and write times are public forever in the stub.
- **Docs may say:** "Others can see that you keep a private record on this site and when it last changed. They cannot see what is in it or how much."

### V5. Presence
- **Problem:** "online now" is metadata about a key and an address.
- **Today:** swarm membership already reveals the address.
- **Upgrade:** presence off by default; contacts see a blinded daily-rotating id; public presence a separate toggle; no beacons from hidden tabs (R8 F3).
- **Residual:** neighbours see the IP is online on the chat swarm.
- **Docs may say:** "Nobody sees you as online unless you turn it on."

### V6. Chat metadata
- **Problem:** who talks to whom, when, and how much.
- **Today:** no chat.
- **Upgrade:** swarm-lane delivery (the recipient does not learn a non-neighbour sender's IP), power-of-two padding, rotating mailbox tags, opt-in direct channels (R8 F2, F4, F5).
- **Residual:** neighbours see frame sizes and times; direct channels show both IPs; a stranger's first message uses a public inbox tag that shows someone wrote to that key (REALTIME-AND-FILES-DESIGN 5.3).
- **Docs may say:** "Messages are encrypted. Their timing and rough size are not hidden."

### V7. File swarms
- **Problem:** seeders' IPs are discoverable by anyone with the infohash and tracker access (R8 F9).
- **Today:** no user files.
- **Upgrade:** encrypt first, then torrent; private files get no ledger entry; never auto-seed an unopened file.
- **Residual:** size and existence of a private file are visible to anyone who learns its infohash; seeders' addresses are discoverable.
- **Docs may say:** "Sharing a file lets anyone who has its link see your IP address while you share it."

### V8. Members can betray members
- **Problem:** end-to-end encryption protects against outsiders, not against the people you send to (R5 F9).
- **Today:** n/a.
- **Upgrade:** group rekey on removal; no read receipts by default.
- **Residual:** a recipient can screenshot, forward or show anything they received.
- **Docs may say:** "Anyone you send something to can keep it and pass it on."

## 4. Resolving the "no personal data in the ledger, even encrypted" conflict

### 4.1 The decision (needs owner and counsel)

**Decision PR-1. Recommended: local-first vault plus an opt-in sealed record.**
- **Default:** the visitor's private record lives in the loader's IndexedDB on each device, encrypted under the site's vault key. Nothing private is written to the ledger. A second device gets the record through QR hand-off or the encrypted backup file.
- **Opt-in, per site, per visitor:** "Keep my private record in sync through this site" writes a fixed-size sealed `append` item (IDENTITY-AUTH-DESIGN 6). Allowed only when the site's policy declares `records: 'sealed'` (owner choice) and the visitor ticks the box, after a card that says the record is personal data, is copied to every visitor, can only be hidden by tombstone, and stays readable to whoever holds the phrase.
- **Never:** email, phone, name, date of birth, ID images, health or other special-category data in any field; free text is limited to the visitor's own notes and is off by default (R6 F4 special categories).
- **Why:** it keeps PRIVACY.md's rule as the default, gives the owner's goal ("each visitor can decrypt their own record and nobody else can") on every device the visitor links, and limits ledger personal data to what visitors choose.

**Alternatives considered.**
- *PR-1a, commitment only:* the ledger holds a salted hash of the record; the record itself never leaves devices. Lowest legal risk; no cross-device sync without a hand-off. Acceptable if counsel rejects PR-1.
- *PR-1b, sealed record in the ledger by default:* best sync; puts personal data in every copy by default; conflicts with PRIVACY.md and the EDPB direction. Rejected.
- *PR-1c, record as an encrypted torrent referenced from the ledger:* the visitor can stop seeding, but copies persist and availability depends on someone holding it. Not erasure either (R2 F17). Rejected for the auth record; used for large private files.

### 4.2 What changes in PRIVACY.md

Replace the bullet at line 158 with: "**No personal data in public ledger values.** A visitor may choose to keep a private record in the ledger on a site that allows it. That record is personal data: it is encrypted to keys only the visitor's devices derive, padded to one fixed size, copied to every visitor, hidden from honest copies by deleting it, and readable to anyone who holds the visitor's recovery phrase. Everything else about it, the author key and the times, is public." Keep the EDPB citation and add "applied by analogy; counsel to confirm".

### 4.3 Erasure, honestly (new finding)

In the derived design (root, then site seed, then record key; R3 5.2), the record key is a pure function of the root and the ledger id. Consequences:

1. **Tombstone** removes the ciphertext from every honest copy that syncs (ARCHITECTURE 6.1). This is the per-site erasure path.
2. **Per-site crypto-shredding is not available** while the phrase or any backup exists: the phrase re-derives the key and opens any old copy a peer kept.
3. **Full crypto-shredding** is "destroy the phrase and every backup", which retires every site identity of that root at once.
4. **Alternative PR-2 (not recommended for v0.3):** a random per-site data key, wrapped under the vault key and kept only on devices and in the backup file, never derivable from the phrase. It allows per-site shredding but loses the record on phrase-only restore and complicates hand-off. Decide with counsel; if chosen, the UI must say "your private record on this site is not in your 12 words".

**Docs may say:** "Deleting your private record hides it from everyone who receives the deletion. Someone who kept an old copy could open it only with your recovery words. If you destroy your words and backups, nobody can open any copy, and you lose every site identity they held."

## 5. New rows for the PRIVACY.md recipients register

| Recipient | What it receives | When | Default |
|---|---|---|---|
| Other visitors on the chat swarm | IP address, that the visitor uses chat on this site, sealed envelopes they relay (sizes and times), blinded presence ids | after the visitor turns chat on, while the page is open | off |
| A person you message directly (direct channel) | your IP address, your key, the message | when you choose "Connect directly" | off |
| Holder peers (offline delivery) | a mailbox tag, envelope size and arrival time, your IP if they are your neighbour | when you send to someone offline and holders exist | holders opt in; senders see "held by N peers" |
| File-swarm peers | IP address, the file's infohash, the (encrypted or public) pieces | while you seed or fetch a file | only files you uploaded or opened |
| TURN relay, if the owner runs one | both parties' IP addresses, bytes and times; never content | when relay is enabled for a session | off; owner-run; named in the consent card |
| The owner's pin node as a mailbox, if enabled | IP address, mailbox tags, envelope sizes and times | when you choose stronger offline delivery | off |
| Everyone with a copy of the ledger | your public profile name, your chat-key record, public file listings, and (if you opt in) your fixed-size private record and its times | when written | profile name only when you set it |

Replace the sentence "Not used in 0.2.1: relay (TURN) servers ..." with a v0.3 version that names exactly which of these are on by default (none).

## 6. Rules to make testable in v0.3

1. Guest reading never sends a key: no identity material in HELLO (already true, ARCHITECTURE 6.6) and no key creation before the first write or sign-in (change from `app.js` lines 2108 to 2111).
2. Sign-in, presence, chat and uploads each require their own opt-in; each opt-in card names its recipients; "not now" is the same size and layer as "yes".
3. Host-only mode refuses `mw.chat.enable()` and `mw.files.share()` with `E_HOST_ONLY`.
4. No field named or typed as email, phone, date of birth or document is accepted by `mw.me.set` (lint plus runtime check; R2 P0).
5. Every sealed record is exactly one size; a test fails if two records of different plaintext length differ in ciphertext length.
6. No chat body, presence, receipt, envelope, recipient list or wrapped file key is ever written to the ledger (R8 P0); a validator lint rejects reserved list names carrying envelope-shaped values.
7. Uploaded bytes are never served as HTML or script at the site origin (R8 F9).

## 7. What this means for magnet-web

- **Today (0.2.1, true of the code):** solves for itself analytics, cookies, accounts, passwords and identity providers; nothing contacted before consent; everything in the ledger public; extractable key on the origin.
- **Upgrade (v0.3):** per-site keys from one root; sign-in with no identity provider; local-first private vault with an opt-in fixed-size sealed record; encrypted chat and files; relay option; separate opt-ins; register and rules above.
- **Cannot:** hide IP addresses from peers, trackers, STUN or relays; make a visitor anonymous; delete every copy; recover a lost phrase; shred one site's record while the phrase exists (derived design); protect against hostile code on the origin while unlocked; verify age; work inside Tor Browser or Safari Lockdown Mode for swarm features; change the advertising economy.

## 8. Recommendations

| Pri | Effort | Recommendation |
|---|---|---|
| P0 | S | Decide PR-1 (or PR-1a) with counsel; update PRIVACY.md line 158, WHY.md line 113, DEPLOY.md line 778, CRUD.md line 599 and MIGRATION.md line 585 together |
| P0 | S | Decide PR-2 (per-site shreddable key) and write the erasure paragraph in 4.3 into PRIVACY.md |
| P0 | S | The "what others can see" card before the first networked use of the key, with the V1 sentence |
| P0 | M | Separate opt-ins for sign-in publication, presence, chat and uploads; guest reading never creates or sends a key |
| P0 | S | The no-identity-data rule (rule 4) in SDK, docs and example site |
| P0 | S | Recipients register rows in section 5 |
| P1 | S | Equal-prominence consent rule with an automated test |
| P1 | M | Read-without-announcing: fetch the `cs=` snapshot over HTTPS without joining the swarm |
| P1 | M | Build-time third-party origin audit and "no third-party origins" profile |
| P1 | M | Owner-run TURN, relay-only visitor setting, named in the card |
| P1 | S | A plain limits page: IP exposure, scraping, no deletion, no recovery, no age check, no Tor |
| P2 | S | "No big-provider defaults" profile for tracker, STUN and DoH |
| P2 | S | Reserved attestation slot design (yes or no plus issuer), not built |
| P3 | L | Post-quantum key agreement plan before long-lived private chat history is offered |

## 9. Open questions

1. Does counsel accept PR-1, or require PR-1a (commitment only)? Is a tombstone stub with author key and time personal data that must be erasable (R6 Q1)?
2. Does the owner want PR-2 (per-site shredding) at the cost of a record that is not recoverable from the phrase?
3. Should sign-in be refused without the relay option on sites the owner flags as sensitive (R2 Q2)?
4. Should host-only be the default for any site tagged for children or for audiences under age laws (R2 Q3)?
5. Primary texts still unread: EDPB 02/2025 v2, ITRC 2025 PDF, Verizon DBIR PDF, CalPrivacy registry (R2 Q5). Re-check before quoting in public docs.
