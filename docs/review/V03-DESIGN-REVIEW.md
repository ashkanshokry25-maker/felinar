# felinar v0.3 design review: identity, sign-in for any site, records, chat, files and private media

- **Status:** synthesis of the v0.3 design review, 2026-10-20, written when the project was called magnet-web; it is now felinar (the light web). Parts 1 to 4 are the design as reviewed then. The build landed on 2026-10-20, and the review round of Part 5 ran from 2026-10-22 to 2026-10-24: its results are section 5.4. The v0.3 sections of [ARCHITECTURE.md](../ARCHITECTURE.md) (section 15) and [INTERFACES.md](../INTERFACES.md) carry the normative contracts as built; what is not built keeps the mark "(proposed)" there, with the reason. Where this review and those sections differ, those sections describe the code.
- **Under review:** [IDENTITY-AUTH-DESIGN.md](../research/v03/IDENTITY-AUTH-DESIGN.md) (cited **ID**) and [REALTIME-AND-FILES-DESIGN.md](../research/v03/REALTIME-AND-FILES-DESIGN.md) (cited **RT**), against the goals in [DIFFERENTIATORS-AND-WHY.md](../research/v03/DIFFERENTIATORS-AND-WHY.md) and [PRIVACY-UPGRADES.md](../research/v03/PRIVACY-UPGRADES.md) (cited **PU**), the owner's additions of 2026-10-20 (about 08:20 ET: `examples/social`; about 08:25 ET: one identity usable as a sign-in for any site; about 08:35 ET: private media), and the v0.2.1 spec and code.
- **Findings synthesised:** 258, from six judges and eight red-team attackers in `docs/research/v03/`. Cited by file and finding id: **SEC** (judge-security-and-cryptography), **PRIV** (judge-privacy-metadata-and-law), **UX** (judge-user-experience-and-adoption), **DS** (judge-distributed-systems-and-performance), **HON** (judge-honesty-and-spec-conformance), **SCALE** (judge-scale-and-economics), **PEER** (redteam-malicious-peers-and-wire-attacks), **HUB** (redteam-hub-takeover-moderation-abuse-and-insider-threats), **MAL** (redteam-malware-and-illegal-content-through-shared-files), **PHISH** (redteam-phishing-and-account-takeover), **PTR** (redteam-poisoned-pointers-dns-and-hosts), **STALK** (redteam-stalking-doxxing-and-deanonymisation), **SC** (redteam-supply-chain-builds-and-updates), **SYB** (redteam-sybil-spam-and-flooding).
- **Numbers:** every figure carries its source. "Measured" means a cited lab or run; "arithmetic" means derived in place from cited constants; "chosen" means a design parameter this review sets and a gate row must confirm or tune. Nothing in this file was measured on a phone or a public network.
- **Wording:** "no backend", "site ledger"; straight quotes; no em dashes. No browser was launched at a non-local address and nothing was pushed.

## Contents

- Part 1. Verdict, must-fix list, decisions
- Part 2. The resolved v0.3 design (identity, cross-site sign-in, authentication, authorisation, the encrypted record, chat, files, private media, ledger ops, SDK, storage, compatibility, consent texts, erasure, threat model, anti-abuse, anonymity, security program)
- Part 3. `examples/social` specification (and the drop-in widget, and the minimal `peer-guestbook` changes)
- Part 4. Test plan
- Part 5. Build plan and review round

---

# Part 1. Verdict, must-fix list, decisions

## 1.1 Verdict

**Neither proposal ships as written, and v0.2.1 itself has release blockers that must be fixed before any public release.**

1. **The single most important change is where the identity lives.** Both proposals put the recovery root in the IndexedDB of whatever site origin the visitor is on and unwrap it in loader code served by that site's host. Combined with the 08:25 requirement (one root, any site), that turns every site, every drop-in host page and every third-party tag on them into a party that can take the person's identity on every other site (SEC B2, PRIV B1, UX B2 and B4, HON B2, HUB H1, PHISH A1 to A4, PTR A7, SC-5). The resolved design moves the root to one **identity origin**: a static, self-hostable, hash-pinned origin opened only as a first-party top-level window, which holds the root under a passkey for its own RP ID, takes the requesting origin from the browser (`event.origin`), shows every consent card the site cannot draw over, and hands each site only that site's working keys and signatures. No site origin ever sees the 12 words, the root or another site's keys.
2. **The cross-site sign-in requirement was not designed.** Part 2.3 now specifies it: the `mw-signin-v1` challenge format, a loader-owned card at the identity origin, pairwise per-site keys by default, an explicit "use the same identity here" choice that writes nothing to any ledger, the drop-in widget flow, and `@magnet-web/verify` for Node and browsers.
3. **The chat design floods with no relay-checkable cost and leaks who talks to whom.** The resolved chat lane gives every frame a clear header (hop byte outside the hash, a work stamp bound to the frame), routes by interest before flooding, holds only frames the sender flagged, never sends a publicly computable inbox tag, authenticates DMs deniably and never announces private groups or private media to trackers.
4. **Files and media needed a mechanism, not a rule.** Uploads are served only from inert reserved routes; nothing is fetched or seeded without a click; images are re-encoded to drop location data; private media is chunk-encrypted aligned to torrent pieces and played through a Service Worker route with Range support while the ciphertext stays encrypted in the swarm (Part 2.9).
5. **The ledger needs a freeze-window group of format decisions before any public ledger exists**: `unban`, `rotate`, `keyinfo`, a defined `checkpoint`, moderator `allow` with caps, owner-protected entries, ban expiry, reserved byte pools and the pointer fields `org=`, `nx=`, `ml=`. The RT schema lint becomes a state rule, never a validity rule (SEC B5, HON B3).
6. **`examples/social` is feasible only as a pull-mostly network with stated ceilings**: personal sites with browser genesis, a hub follow lane, recent-window sync, follow caps per device class, hub pins as central storage named as such, and an explicit list of what needs an index and is out of scope (Part 3).
7. **v0.2.1 works-today blockers** (fix before any public release, independent of v0.3): one HELLO frame freezes a tab (PEER A1, measured in a scratch run); open ledgers fill to the cap for the price of 2^16 hashes per block (SYB A1); moderator keys are extractable and moderation needs no gesture (HUB H2); a stolen owner key rotates silently and can freeze ownership (HUB H3, PTR A5); ledger-id squatting through `lo=` mounts attacker code over a victim's ledger (PTR A1); releases are unsigned and replaceable (SC-1).

After the fixes, the honest one-paragraph summary for WHY.md and PRIVACY.md (adapted from PRIV section 2) is: "Sites cannot recognise you by your key unless you choose to be recognised. Anyone you connect to, the connection servers and any relay can still see your IP address, when you are active and which felinar sites you open, and can link activity on several sites by that address. Your messages, private record and private media are encrypted, but the people you share with, the code of the site you are signed in to, and anyone who learns your 12 words can read them."

## 1.2 How the 258 findings were reduced

Every finding was read in its source file. Findings that describe the same defect were merged into one must-fix item and keep all their source ids. Minors are folded into the item they belong to, or listed in Part 2 where the fix lives; none was dropped silently. 1.3 lists every blocker and every major, deduplicated into 78 items, each with the decision and why. 1.4 lists the majors (or parts of majors) this review rejects or defers, with a one-line reason.

| Source | Finding ids read (all of them; minors folded into the item or section that fixes them) |
|---|---|
| SEC | B1 to B5, M1 to M14, minors |
| PRIV | B1 to B3, M1 to M12, m1 to m8 |
| UX | B1 to B6, M1 to M23, m1 to m6 |
| DS | F1 to F21 |
| HON | B1 to B3, M1 to M12, m1 to m10 (HON's own total: 3 blockers, 12 majors, 10 minors) |
| SCALE | B1, B2, M1 to M11, m1 to m4 |
| PEER | A1 to A10 (v0.2.1 code; A1 measured in a scratch run outside the repo), B1 to B11 (proposal) |
| HUB | H1 to H13 |
| MAL | A1 to A15 |
| PHISH | A1 to A18 |
| PTR | A1 to A10 |
| STALK | A1 to A15, section 4 |
| SC | SC-1 to SC-10 |
| SYB | A1 to A18 |

## 1.3 Must-fix list (every blocker and major, deduplicated)

Severity is the highest any source gave. "Decision" is what this review adopts; "Where" points to the resolved design.

### A. Identity and the cross-site sign-in

| ID | Finding (sources) | Sev | Decision | Why | Where |
|---|---|---|---|---|---|
| MF-01 | Cross-site sign-in (08:25) not designed: no server challenge, no statement, no Node library, no per-site derivation without a ledger, no "same identity" choice, nonce rule contradicts server flows (SEC B1, M3; PRIV B2; UX B1, B3; HON B1, M12; DS F15; PHISH A8, A18; STALK 4; SYB A16) | blocker | Specify `mw-signin-v1` (browser-stamped `domain`/`origin`, verbatim `statement`, verifier nonce required for anything leaving the tab, `iat`/`exp` at most 5 min/`nbf`, `requestId`, `keyMode`), RFC 8785 canonical form, P1363 signatures, vectors; ship `@magnet-web/verify` (Node 22 and browsers, zero dependencies) with a single-use nonce store contract and stateless HMAC nonces | The requirement is binding and every naive build breaks unlinkability or replay safety | 2.3 |
| MF-02 | The root is imported or unwrapped on every site origin, in host-served code; one hostile site, host or tag takes every identity (SEC B2; PRIV B1; UX B2, B4; HON B2; HUB H1; PHISH A3, A4; PTR A7; SC-5; STALK A11) | blocker | The root lives only at the identity origin. Site origins receive per-site working keys (never the root, never a seed that opens other sites, never the phrase) | The only way one compromised site does not mean every site | 2.2 |
| MF-03 | The sign-in card on a site page is not a trusted UI; restore trains phrase phishing (PRIV B3; UX B2; PHISH A1, A2; PTR A7) | blocker | Phrase entry, backup file restore and phrase display exist only at the identity origin, whose address the browser shows. Site cards never have a phrase field. Copy: "felinar never asks for your 12 words on a website." Test E-ID-10 | Makes "only type the words at one address" a rule a person can follow | 2.2, 2.14 |
| MF-04 | Keys keyed by a page-declared ledger id; look-alike origins and `lo=` squatting receive the victim site's key (SEC B3; PRIV B2.1; PHISH A10; PTR A1) | blocker | Derivation label comes from the browser-reported origin. The ledger label is used only when the identity origin verifies the site's signed pointer (lineage `owner == lo` or a verified `rot=` chain) and the origin is listed in the pointer's `org=` list | Binds keys to what the browser verifies, as WebAuthn RP IDs do | 2.2.3 |
| MF-05 | QR hand-off releases the secret before the SAS check; no commitment; malicious "device B"; ledger id visible in the QR (SEC B4; PHISH A6; HON m1; PRIV m4) | blocker | Hand-off only between identity origins; commit-then-reveal (B commits to H(eB), A sends eA, B reveals eB); SAS over the transcript, 6 decimal digits (a 32-bit value mod 10^6, bias stated); A confirms before any ciphertext exists; in person only; no network path for the root; codes accepted only within 120 s of a "Link a device" screen the person opened | Removes grinding and quishing; with the commitment an attacker gets one guess, which matches with probability 10^-6 (arithmetic) | 2.3.8 |
| MF-06 | UI redress of loader cards from the same-origin site frame, overlay on drop-in panels (PHISH A5; PEER B11) | blocker | High-risk cards (first sign-in to an origin, link a device, same identity, read private record, show phrase) run only in the identity popup. In-page cards are prompts that open it. Remaining in-page cards (consent, upload) get topmost-element, style and mutation checks and are documented as speed bumps | A page cannot draw over another top-level window | 2.3.4 |
| MF-07 | Reverse-proxy phishing: a proxy with a modified loader mints proofs for the real origin (PHISH A7) | major | Only the identity origin signs sign-in proofs; it fills `domain`/`origin` from `event.origin`; the first approval of a new origin needs a user-verified passkey assertion for the identity origin's RP ID | The browser, not page script, binds the origin | 2.3 |
| MF-08 | Passkeys: provider becomes a linking recipient; PRF wraps the root on every origin; passkey sprawl; names unspecified; orphan passkeys (SEC M12; PRIV M7; UX M2, M3, m2; HON m6; PHISH A4, A15) | major | One passkey per person per identity origin (RP ID = identity origin); random `user.id`; neutral `user.name` ("felinar identity") chosen by the person; provider named in the register and on the card; PRF salt is fixed per identity origin and never reachable from site origins; clean-up instructions on fallback | One RP ID removes sprawl and keeps PRF away from site code | 2.2.4 |
| MF-09 | "One tap" is 6 to 9 interactions with 2 or 3 biometric prompts (UX M1, m3, m4) | major | Single card; PRF requested at `create()`; `get()` only if PRF was not returned; the self-test reuses that output; "what others can see" merged into the card; a "Tap to finish" button when activation is lost (G-ID-1); signed-in header shows identicon, mode, unlock method and backup state | Brings the returning sign-in to one tap and at most one platform prompt | 2.3.4 |
| MF-10 | Cross-device by passkey sync absent; QR per site; typing about 167 characters on a laptop without a camera (UX M4; PHISH A15) | major | One device ceremony per device at the identity origin (QR between identity origins, or the phrase there); per-site seeds never travel; passkey sync is a route only where `largeBlob` (or the escrowed wrapped root, 2.2.5) is shown to work on G-ID-3; the provider's account recovery is stated as a trust root | Cross-device once per device, not once per site | 2.3.8 |
| MF-11 | Recovery traps: iOS reminder after ITP deletion; session-only vault loss; a mistyped phrase passes the 4-bit checksum about 1 in 16 times (UX M5, M6, M8) | major | iOS outside Home Screen: recovery-kit card every visit until saved and Add to Home Screen offered on the first visit; a session-only identity is never created without the phrase shown or the sentence "This identity disappears when you close this tab"; after restore the identity origin shows "This is the identity last seen on <site> as <name> <short id>" or "No activity found for these words"; test E-ID-3b | Each trap loses an identity silently today | 2.2.6 |
| MF-12 | "Use the same identity here" missing, a dark-pattern lever, and naive builds publish permanent public links (UX M16; PHISH A13; STALK A6; HUB H8, H13) | major | Choice only in the identity popup, default "Private to this site", names both sites, says "Both sites will know this is you. This cannot be undone once this site has seen it."; asked at most once per site per 30 days (chosen) and never on page load; no SDK parameter can request it; nothing written to any ledger; local list at the identity origin, revocable for the future | Linking is the person's choice, visible and not repeatable by pressure | 2.3.5 |
| MF-13 | Per-site keys defeat a social network; each personal site is its own origin (SCALE M4, M5; UX M16) | major | Hub-scoped identity: at hub sign-up the identity origin offers "Use one identity on all of <hub>", default on for social hubs, off elsewhere; people on one hub are linkable to each other by design, other hubs and sites stay unlinkable | A follow graph needs a stable key within the hub | 2.2.3, 3 |

### B. Keys, sessions and recovery

| ID | Finding (sources) | Sev | Decision | Why | Where |
|---|---|---|---|---|---|
| MF-14 | "Signed out" leaves usable private keys on disk; "lock" does not lock; sessionStorage proof copies (SEC M1; HON M1; UX M7; PHISH A9) | major | Sign out deletes this origin's working keys (the identity origin keeps the root, so signing in again is one tap). "Stay signed in on this device" is an explicit choice that keeps keys non-extractable in IndexedDB; "Shared computer" keeps them in memory only; no proof is written to sessionStorage; follower tabs lose the keys with the leader | Signed out must mean no usable key | 2.4.1 |
| MF-15 | "Non-extractable means a script cannot copy the key" is false: scalars pass through JS (SEC M2) | major | Reworded everywhere: "Code on a site you are signed in to can copy your keys for that site." Derivation runs at the identity origin, so site code never sees the root | Honest statement; the identity origin is the real fix | 2.14 |
| MF-16 | Bearer proofs last up to 7 days, are readable and unrevocable (SEC M3; PRIV m8; PHISH A8.1) | major | Bearer proofs at most 15 min (chosen), memory only, never accepted by `@magnet-web/verify` or by peers; anything leaving the tab is challenge-response with a verifier nonce and `exp - iat` at most 5 min; a local revocation epoch on sign-out | A server cannot tell a fresh bearer proof from a replayed one | 2.4.2 |
| MF-17 | Argon2id through WebAssembly is blocked by the shell CSP; `'wasm-unsafe-eval'` absent below Safari 16 (SEC M11; HON M2) | major | Passphrase wrapping runs only at the identity origin, whose CSP includes `'wasm-unsafe-eval'`; where WebAssembly is unavailable it uses PBKDF2-SHA-256 with the iteration count in the header and says so; never a silent downgrade; lab row E-ID-12 under the real CSP | Site CSPs stay unchanged | 2.2.4 |
| MF-18 | Chat keys for every epoch and the recover key derive from the root, so rotation and deletion protect nothing against phrase theft (SEC M5; PRIV M1; STALK A5) | major | Chat epoch keys and record keys are random, stored wrapped in the identity vault and the backup file; phrase-only restore cannot read old messages or records (stated). An optional extra passphrase ("extra word") can be mixed into the root derivation | Deleting a key must retire it | 2.2.2 |
| MF-19 | Offline guessing of the identity file; the v2 file holds the root; 8-character floor today (PHISH A14) | major | The backup file is made only at the identity origin, protected by a generated 6-word passphrase (or a person-chosen one above a stated strength floor), labelled "Do not email"; the 0.2.1 export keeps working for migration only | A weak file passphrase must not equal a weak phrase | 2.2.6 |
| MF-20 | Rotate and recovery races; recover key removable by a moderator tombstone; no key-change notice; no "sign out everywhere" (PHISH A11; HUB H8; UX M9) | major | Freeze-window ops `keyinfo` (non-redactable commitment to the recover key) and `rotate` (recover beats self, always; rotation inherits bans); contacts see "Ana's key changed"; identity origin offers "Replace my keys on all sites"; moderators never re-admit on a request made in chat | Recovery must not be the weakest path | 2.5.3 |

### C. Ledger format and the freeze window

| ID | Finding (sources) | Sev | Decision | Why | Where |
|---|---|---|---|---|---|
| MF-21 | RT value lint makes blocks invalid and forks v0.2.1 and v0.3 peers; stubs cannot be linted (SEC B5; HON B3) | blocker | Schemas for `mw.*` lists are a state rule: a non-matching item is hidden and has no effect; the block stays valid, stored and relayed. Bare names (`dm`, `chat`) are not reserved | Validity must stay a function of `e` only | 2.10 |
| MF-22 | `records: 'sealed'` is not a policy field and would be rejected (HON M10); owner setup has no steps (UX M14) | major | Site feature settings live in the advisory key `_mw.cfg` (owner or moderators, shown with who set it); a security setting never lives there; an owner settings table and `tools/init` questions | Keeps v1 validity untouched | 2.5.5 |
| MF-23 | Chat, records and migration need write rights default sites do not give (HON M9) | major | Chat keys travel off-ledger by default (signed `CK` frames, 2.7.2), so DMs work on `writers: 'owner'` sites; a ledger copy is opt-in; the writers x feature matrix is in 2.5.4; migrated `allow` members keep the legacy key as author until the owner adds the new key | Features must not silently fail on the default policy | 2.5.4 |
| MF-24 | Ledger fills: records, chat-key records, migration items, flooding; growth is monotonic; failure is silent (DS F10; UX M21; SYB A1, A4; SCALE M6) | blocker | Reserved byte pools (freeze window: at most 25% of `maxChainBytes` for authors who are not owner, moderator or allow-listed, chosen); `E_LEDGER_FULL` at 80%; a defined `checkpoint` op; sealed items capped at 32 per author (SDK convention) and one synced update per hour; a moderator bulk tombstone; measured per-member budgets published | The cap is today a lever for whoever mines fastest | 2.10 |
| MF-25 | The ledger keeps membership, bans and chat activity forever (PRIV M5) | major | Chat-key records off-ledger (MF-23); `ban` gains an optional `until`; `checkpoint` lets honest copies prune pre-checkpoint control history; PRIVACY.md states what stays (current allow list and bans) | Cuts the permanent record to what validity needs | 2.10, 2.15 |
| MF-26 | No erasure path for stubs; no international-transfer analysis (PRIV M6) | major | `checkpoint` (owner-signed) after which honest copies drop earlier blocks and stubs; random per-site record keys at the identity origin so one site can be shredded while the phrase exists; DPIA and PIA templates gain a transfers section; copy says "hide from copies that sync", never "delete" | Gives Art. 25 a measure to point to | 2.15 |
| MF-27 | Moderator keys extractable in IndexedDB; SDK moderation without a gesture; no undo (HUB H2) | blocker (works today) | Moderator key stored non-extractable after import; `mod.ban`, `db.tombstone` of others' items and bulk actions require a loader card with `isTrusted` input (UI method); per-moderator caps per hour as a policy field (freeze window); `unban` | Today one compromised tag erases a site | 2.5.3 |
| MF-28 | Stolen owner key: silent `rot=`, hand-over, deliberate `ownerConflict` freeze, seq race (HUB H3, H12; PTR A5) | blocker (works today) | Pointer pre-rotation commitment `nx=<sha256 of the next owner key>`; delete the rot v1 path; loaders show "owner changed N minutes ago" and delay a `rot` for first-time visitors unless `nx` matches; a test that equivocation cannot lock out the committed key | Theft of the current key no longer moves the site | 2.5.3 |
| MF-29 | Moderator tombstones the owner's entries; a removed moderator's earlier bans stand; values dropped before a revocation arrives; D-9 and D-10 open insider levers (HUB H5, H6, H7, H8) | major | Freeze-window rules: owner-standing payload cannot be tombstoned by moderators; `unban` valid from equal or higher standing; a policy field to void a removed moderator's actions since a block; values of moderator tombstones kept 24 h (chosen) before physical deletion except P0 takedowns; moderator `allow` additions capped per day | Bounds what an insider can do and makes it reversible | 2.5.3 |
| MF-30 | Loader state: withdrawal and pointer replay to cold devices, uncapped DNS TTL, first-use DNS trust and AD badge, hub PSL tricks, state poisoning by same-origin code (HUB H4; PTR A2, A3, A4, A8, A9) | major (works today) | Clamp TTL (5 min to 1 day) and timers at 2^31-1 ms; withdrawals expire at most 30 days and are re-signed; signed `minSeq` in the ledger policy; `#host:name@<fp>` links; "resolver says validated"; PSL probe that disables persistent identity on non-PSL hubs; pins and refusals signed by a per-device key and refusals expire after 7 days | Each is cheap and works today | 2.16 |
| MF-31 | Fake "credible report" forces withdrawal; ownerless hub ledgers cannot be moderated; a future denylist becomes a point of control (HUB H9, H10, H11) | major | Narrow first action (ban and tombstone the item); hub loaders show ownerless ledgers read-only; denylist rules written before the list exists (public entries, reason codes, appeal, expiry, more than one signer, no propagation) | Operations rules, no format change | 2.17 |

### D. Chat transport

| ID | Finding (sources) | Sev | Decision | Why | Where |
|---|---|---|---|---|---|
| MF-32 | Flood relay: no hop field, dedupe breaks with one, relays cannot check any cost; stamp reusable and inside the ciphertext; trial-decrypt and ROOM floods; first-relay origin inference (DS F1; PEER B1, B2; SYB A5, A6, A7; SEC M8; HON M6; STALK A3) | blocker | Clear header with a hop byte outside the hashed body; `frameId = SHA-256(type, version, tag, epk, iv, ct)` in a bounded seen-set; relay stamp bound to `frameId` and the UTC day, checked in one hash before relaying or decrypting; contacts at 10 bits, strangers at the recipient's `chatBits` (default 20, chosen, G-CH-6); per-neighbour fair queues; forward toward WANT routes before flooding; random first-send jitter 0.5 to 3 s (chosen) and a random relay subset | Every relay can refuse junk at the cost of one hash | 2.7.3 |
| MF-33 | Holders keep every envelope; poisoning and wipe; WANT/HELD amplifier; holders and anyone on the lane link IPs to chat keys through the public inbox tag (DS F2, F13; PEER B3, B4; SYB A8; PRIV M3; SEC M9; HON M5; STALK A1, A10; SCALE M3) | blocker | `hold` flag set only when the recipient is not reachable; COLLECTED deletes; per-source holder quotas and stamp-weighted eviction; HELD answered once per tag per wire per minute; the stranger inbox tag is never sent in WANT-TAGS; strangers' offline mail is collected only by proof of the chat key; recipients fetch by 1-byte tag prefix buckets; peer holders hold contact mail only | Closes the key-to-IP oracle and the "held by N" fiction | 2.7.5 |
| MF-34 | Presence reaches neighbours only; public presence is a key-to-IP beacon; unsigned PRES (DS F3; STALK A2; PEER B5; SYB A18) | major | "Who is online" relabelled "Connected to you now"; PRES signed (public) or MAC'd (contacts); one fixed-size PRES frame with padded ids; public presence card says it shows your key to everyone who can reach you | The label must match the mechanism | 2.7.6 |
| MF-35 | "Held by N peers" has no protocol message and N is not durable (DS F4) | major | HOLDING frame routed back; copy "Handed to N peers at 14:02; they may go offline"; strangers "Sent, delivery unknown"; strings ship only after G-CH-1 and G-CH-3 | No string may claim what the protocol cannot know | 2.7.5 |
| MF-36 | Replays after reload; no `t` bound; no ordering; day boundary (DS F5; SEC M13) | major | Persistent seen-set (per-sender high-water `t` plus a 7-day Bloom filter sealed in the vault); accept `t` in [now - 7 d - 5 min, now + 5 min]; per-conversation counter `n`; UTC day, recipients ask day-1, day, day+1 | Ordering and replay must survive a reload | 2.7.4 |
| MF-37 | Groups: no context in signatures, newcomers read history, concurrent rekeys fork, offline members dropped, admin authority unchecked (DS F6; SEC M7; HON m10) | major | Signed context `mw-grp-msg-v2` + ledgerId + groupId + epochId; rekey on add and remove; `epochId = SHA-256(prevEpochId, creator, commit)`, lowest id wins among concurrent children, union of removals; grace listening 7 days (chosen); admin list signed and checked on every rekey | Deterministic groups without an ordering service | 2.7.7 |
| MF-38 | The 256-byte bucket holds nothing; frames 2.7 times the stated size (DS F7) | major | Binary plaintext layout (154 bytes of overhead, DS F7 arithmetic), buckets 256 / 1,024 / 4,096 / 16,000 bytes with length vectors | Budgets were off by that factor | 2.7.4 |
| MF-39 | Chat lanes, group lanes and file torrents multiply WebRTC connections with no total cap; one swarm per person in social (DS F8; SCALE B1) | blocker | One wire budget per tab across all swarms (desktop 40, phones 8, chosen, G-SC-2); priority site > rendezvous > chat > open group > files; `mw_chat1` rides rendezvous wires and joins a separate lane only when fewer than 2 rendezvous neighbours speak it; groups ride the chat lane by tag; file torrents are left once saved | Phones have 4 to 8 content wires (ARCHITECTURE 8) | 2.7.1 |
| MF-40 | Peer challenge `chan` binding uses self-declared peer ids; the tracker can MITM the transport (SEC M4; HON M4; DS F14; PEER B7) | major | SIGMA-style wire handshake: ephemeral ECDH, both sides sign the transcript with their site keys, later frames MAC'd under the derived key; nothing is gated on wire identity alone; tracker MITM stated in 9.1 | A relay then sees two different transcripts | 2.4.3 |
| MF-41 | Every DM and group message is a transferable proof of authorship (SEC M6; PRIV M2) | major | DMs authenticated by a MAC under the static-static pairwise key `K_pair` (deniable to third parties); groups by the group key plus a per-member MAC chain; signatures only on rooms, chat-key records and reports; rooms labelled "public and signed: a recording proves what you wrote" | Users expect private chat to be deniable | 2.7.4 |
| MF-42 | Direct-channel signalling from strangers leaks IPs and probes LANs (PEER B6) | major | SIG accepted only from accepted contacts granted "connect directly" in that conversation; no `RTCPeerConnection` from an unaccepted offer; private and loopback candidates dropped | A stranger must not get an IP by sending an offer | 2.7.8 |
| MF-43 | Parser surface: unbounded fields caused PEER A1; new frames add more (PEER B8) | major | Every field has a stated maximum (2.7.3 table); HELLO at most 512 bytes; envelope length must equal a bucket plus header; every decode and crypto call in try/catch with a strike; the 2^53-1 fuzzer over every numeric field | A1 must not recur | 2.7.3, 2.19 |
| MF-44 | Trackers learn private group membership and private file pairings; the shared default trackers, STUN and DoH act as a cross-site tracker (PRIV M4, M10; SEC M10; STALK A7, A11) | major | Group lanes and private media swarms are never announced to the public default trackers; rendezvous for them runs over the chat lane or the site's own signed tracker (`tr=`); chat and files require the site's own tracker and STUN when the owner turns them on; cards name the servers | Shared infrastructure sees which sites one address opens | 2.7.1, 2.9.8 |
| MF-45 | Phones cannot seed their own uploads under the choke lock; a 10 s app switch rebuilds the client and drops transfers (DS F9; UX M11) | major | Per-upload exception card scoped to that infohash; file torrents keep their stores across `rebuild()` like `RetainedStore`; "Sent: one full copy reached Bo" only when a peer holds every piece; owner pin or hub web seed first when configured | Phone-to-phone sharing otherwise stalls at 0% | 2.8.4 |
| MF-46 | Offline DMs on phone-heavy audiences end "not delivered" with no retry; opt-in holders will rarely exist (UX M12; SCALE M2) | major | Sender outbox retries while the page is open; hub mode defaults to the hub pin mailbox (stated as a party that sees IPs, tags and sizes); strings "Will send when Bo is online while this page is open" and "Sent to the network. You will not know if it arrived until they reply." | Holders alone do not make offline delivery work (99.96% of 15.9 M default-off clients never enabled uploads, w2c-07 via SCALE M2) | 2.7.5 |

### E. Files, private media and dangerous content

| ID | Finding (sources) | Sev | Decision | Why | Where |
|---|---|---|---|---|---|
| MF-47 | Downloads held whole in memory; no streaming SHA-256; no Service Worker route; navigation catch-all swallows downloads; drop-in has no path (DS F11, F12) | major | Writable IndexedDB chunk store for file and media torrents; reserved routes `/_mw/f/<ref>` and `/_mw/media/<id>` routed before the catch-all; `files.fetch` returns a handle and a `ReadableStream`; private files authenticated by STREAM records, no plaintext digest; degraded and drop-in modes fall back to a Blob URL with `a[download]` up to the class cap | The proposal's memory claim was false for the code that exists | 2.8, 2.9 |
| MF-48 | A shared file runs as the site through the serve path, the SDK Blob or a sandbox attribute that does not travel (MAL A1, A5; HON M7) | blocker | The route answers `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, CORP same-origin, never consulting the extension map; `files.fetch` returns Blobs typed `application/octet-stream`; `files.preview()` and `media.open()` are the only render paths; header tests for every extension | One path from uploaded bytes to the origin is enough to lose every account on the site | 2.8.5 |
| MF-49 | Auto-preview makes visitors seeders of content they never chose; re-seed by default; listing floods (MAL A2; PRIV M8; SYB A14) | blocker | Nothing is fetched without a click on that row; no thumbnails from peers for public files; a fetched file is never re-seeded unless the visitor clicks "Help share this file" (off by default) with the IP sentence; owner web seed first for public files | Seeding becomes a deliberate act, which is also the better legal position (R6 P0 6) | 2.8.4 |
| MF-50 | The pin node keeps whatever a member asks; pinned files sit in tab memory and vanish on restart; no web seed for user files (MAL A3, A10; DS F16) | blocker | Pin requests go to a moderator queue (name, size, author, declared hash only); `tools/pin.mjs --quarantine <ih>`; pinned stores on disk; optional `ws` field on listings and grants when the owner copies the file (ciphertext for private) to static hosting with a `tools/` command | Durability without making the owner an unknowing host | 2.8.6 |
| MF-51 | Verified malicious executables, bidi-spoofed names, decode bombs (MAL A4; PEER B10; DS F17) | major | "Verified" means "matches what the sender listed. This does not mean the file is safe."; bidi and control characters stripped, extension shown last and separately; risk tiers by magic bytes with a second confirmation; header-first pixel cap 24 megapixels (chosen) and worker decode | Device compromise outside the browser | 2.8.5 |
| MF-52 | Takedown evasion; a tombstone erases the infohash the loader should refuse (MAL A6) | major | Moderator-signed `_deny/<hex sha256(sha256 or ih)>` written in the same step as the tombstone; checked before fetch or seed; moderator UI flags a tombstone without one; near-duplicates stated as not caught | The removal must be remembered without making the ledger an index | 2.17 |
| MF-53 | Ban evasion by unlinkable keys (MAL A7; SYB A3; STALK A10) | major | Uploads require `allow` membership or premoderation of a new key's first files; file listings and DMs to strangers may require a higher `bits`; counts described as counts of keys | Per-site unlinkability is a goal; the cost must sit on new keys | 2.17 |
| MF-54 | Unsolicited private shares; no report path that avoids handling content; reporting duties; false-report takedowns; the ledger carries content today (MAL A8, A9, A10, A11, A12) | major | Offers never auto-accept (contacts included); stranger offers show size and key only; "Report" sends metadata only (key, envelope id, plaintext digest, size, time, sender MAC or signature); OPERATIONS file-lane section with preservation steps; warning when a policy opens writing; per-author byte quota | The owner needs a signal that does not require anyone to open the material | 2.17 |
| MF-55 | Untrusted torrent metadata: length lies, piece tables, multi-file paths (PEER B9; DS F18) | major | Exactly one file; `length` equals the listing; piece length 16 KiB to 4 MiB; piece count bound; no pad files or path components; `.torrent` at most 256 KiB; own route namespace | The uploader made the torrent, so piece hashes prove nothing | 2.8.3 |
| MF-56 | Private files: exact sizes fingerprint known files; tracker sees sender-recipient pairs (SEC M10; PRIV m2; STALK A9) | major | Ciphertext padded to buckets of 1/8 of a power of two (at most 12.5% overhead, arithmetic); no public tracker announce (MF-44); public listings may omit `sha256` | Size and swarm membership are the remaining metadata | 2.9.5 |
| MF-57 | Photos keep EXIF location; HEIC has no preview; file names leak (STALK A8; UX M18, m6) | blocker | Images re-encoded on device (EXIF, ICC, thumbnails dropped) with "location and camera details removed"; MP4/MOV location boxes stripped by box rewrite, upload refused or warned when that fails; random display names; HEIC converted to JPEG where the browser decodes it, else "No preview for this format" | The most common real doxxing path | 2.8.2, 2.9.3 |

### F. Privacy copy, consent, law and honesty

| ID | Finding (sources) | Sev | Decision | Why | Where |
|---|---|---|---|---|---|
| MF-58 | Sentences that overstate privacy (PRIV M11; SEC M14; HON M8) | major | Every sentence in PRIV M11 replaced with the condition in the same sentence; RT 9.1 owner row becomes "cannot read them from the ledger or the swarm; can read them through the code visitors run" | Copy must not promise what code cannot hold | 2.14 |
| MF-59 | PRIVACY.md register, device storage, retention, controller roles and consent texts incomplete (PRIV M12) | major | All items in PRIV M12 added before any v0.3 feature ships, counsel reviewed | Recipients must be named before data flows | 2.14 |
| MF-60 | Defaults not the most private (Law 25 s. 9.1, UK children's expectations) (PRIV M9) | major | Message requests off; file and media lanes separate opt-ins; "stay signed in" visitor-only, default off on shared-computer mode; "children" defaults on every site without an age method | Most-private defaults are the law in Quebec and the expectation in the UK (R6) | 2.14 |
| MF-61 | Compatibility matrix overstates the lab and ignores the floor (HON M3) | major | Floor columns (Safari 15.4, Chromium 110, Firefox 115); "flag only" where only `getClientCapabilities` was read; activation is the identity popup's own button | Floor visitors exist | 2.13 |
| MF-62 | Test plan cannot verify its gate locally and assigns non-local work to agents (HON M11) | major | Real-device and hosted rows become owner steps in PUBLISH-CHECKLIST and DEMO-RESULTS; local forced-fallback tests delete features; Firefox rows reported "not run", never passed | Agents may not reach public networks | 4 |
| MF-63 | Mandated UI strings rest on unconfirmed sources (HON m5) and missing strings for most error codes (UX M22); `me.get` is a read method that opens a card (UX M23) | major | Strings for every code in English and French; Tor and iOS strings conditional on the RT 16 Q8 primary-source check; `me.get` moves to UI methods and returns `E_NEEDS_GESTURE` without activation | Visitors would see raw codes | 2.11 |

### G. Scale and the social demo

| ID | Finding (sources) | Sev | Decision | Why | Where |
|---|---|---|---|---|---|
| MF-64 | A browser cannot create a person's site; the person cannot post to their own site (SCALE B2; UX B5) | blocker | Personal-site class: the person's own key for their own ledger is the genesis owner, minted in the browser (on their own origin); owner actions need the identity popup; `keyinfo` and `rotate` mandatory for personal sites; hub-signed genesis rejected | Otherwise no wall exists | 3.3 |
| MF-65 | One swarm per person cannot be followed at scale; whole-ledger copies do not fit a phone; tracker load multiplies by follows (SCALE B1, M8, M9; UX B6) | blocker | Hub follow lane (`mw_chain2`, ledger id on every frame, recent-window and control-only sync); per-tab wire budget; sync 4 ledgers at a time (chosen); snapshot-first from the hub; pull then disconnect on phones; follow caps per class; G-SC-1 to G-SC-5 | The mobile tab budget is 4 to 8 connections (ARCHITECTURE 8) | 3.2 |
| MF-66 | Durability without pins is a minority case; the cost model is missing; "nothing central holds everyone's data" becomes false with pins (SCALE M1, M10; UX M20) | major | Hub pin and snapshot service is a standard, optional hub component and is called central storage the operator pays for; each item shows "Kept by the hub" or "Available only while someone who has it is online"; the SCALE 2.4 and 2.7 tables are published | People need the fraction, not the hope | 3.2 |
| MF-67 | Directory: size, Sybil, trust, and the ROADMAP holds it for counsel (SCALE M7; UX M19; HUB H11) | major | Directory code ships off by default behind a hub flag marked "pending counsel"; signed name records countersigned by the hub, append-only and visible; static shards; ledger id pinned at follow; member's own domain TXT as the strong path; links and QR work without it | Contradicting the ROADMAP is not an option | 3.4 |
| MF-68 | Honest ceiling missing: ranked feed, global search, trending, mentions from strangers, follower counts, spam fighting at scale, push (SCALE M11) | major | "Needs an index" table in the spec and in WHY.md, with the labelled optional backends that would close each row, all out of scope | Reviewers would read the gaps as bugs | 3.6 |
| MF-69 | `examples/social` has no specification (UX M15) | major | Part 3 | Builders would invent it | 3 |
| MF-70 | Self-asserted names; 32-character addresses; impersonation of admins (UX M17; PHISH A12; HUB H13; SYB A18) | major | Short id beside every name; role badges only from the ledger; "new contact" label; contact verification by a short code compared in person or by QR; domain handle where the member has one | Names are free text | 3.5 |
| MF-71 | Joining an `allow` site needs a moderator online and a CLI command (UX M13) | major | D-9(a) with per-moderator daily caps; join requests held by the pin mailbox; four screens (sent, no moderator online, approved, declined) | Sign-up must not need a terminal | 2.5.2 |
| MF-72 | The private record holds about 8 contacts (UX M10; HON m4; SEC minor) | major | Sealed items of a fixed 1,024-byte plaintext, chunked index plus data items in one neutral list `mw.s`; contacts and file keys also live in the identity vault and move with device hand-off | Capacity must match the fields | 2.6 |

### H. v0.2.1 works-today blockers and majors (fix before any public release)

| ID | Finding (sources) | Sev | Decision | Why | Where |
|---|---|---|---|---|---|
| MF-73 | One 205-byte HELLO freezes a tab: `d` unbounded (PEER A1, measured in a scratch run: d = 2e10 took 34 s and 290 MB) | blocker | Validate `n` (at most maxChainBytes over the smallest block) and `-1 <= d < n`; clamp `last` in `_startSync`; a strike; unit test with `Number.MAX_SAFE_INTEGER`; fuzz every numeric field | Remote freeze in shipping code | 2.16 |
| MF-74 | Wire caps bypassed by one reused peer id; ignored peers keep slots; eclipse by tenure ties; idle wires never closed (PEER A2, A3, A10; SYB A9) | major | Count by wire; close ignored wires; anchor slots for wires that delivered valid blocks; random eviction among ties; close wires silent 2 min after the handshake; "peers but no progress" polls `cs=` | Multiplies every other limit | 2.16 |
| MF-75 | Signature verified before policy; throttle bypassed by backdated `ts`; `ut_metadata` amplification past the choke lock (PEER A4, A5; SYB A2, A12) | major | Admit, writer and fee checks before ECDSA; per-wire verification budget; throttle by arrival time for live blocks; drop `ut_metadata` requests beyond 4 per wire per minute once metadata is complete | CPU, battery and the mobile no-upload promise | 2.16 |
| MF-76 | Web seeds from unsigned magnets: loopback and LAN probing, a reflector (PEER A9) | major | Unsigned records: at most 4 `ws=` and 2 `xs=`, https only, no loopback, link-local, private or `.local` hosts except the page's own origin; no per-URL failure reasons | One link turns visitors into a probe | 2.16 |
| MF-77 | Reaction and follow stuffing; `put` overwrite across authors; rendezvous poisoning (SYB A13, A10) | major | Author-scoped key convention (`k` starts with the author's key hash) enforced in the reducer for `@`-prefixed keys (freeze window); counts from vetted keys where a site vets; PEX bootstrap and persisted good peers | Social primitives depend on it | 2.10 |

### I. Supply chain

| ID | Finding (sources) | Sev | Decision | Why | Where |
|---|---|---|---|---|---|
| MF-78 | Unsigned replaceable releases; hostile dependency passes the lock; npm tarball installs without lockfile; verification library name squat; SW pins a hostile loader and the kill switch leaves keys; shared-CDN widget; reproducibility unmeasured; canonicalisation drift (SC-1, SC-2, SC-3, SC-4, SC-6, SC-7, SC-8, SC-10) | blocker | Security program 2.19: immutable releases, tag ruleset, reviewer environment, provenance attestation, signed per-file hash list; lock every bundled package, dependency cooldown, two-person rule on `build.lock.json`; `npm-shrinkwrap.json` and `--ignore-scripts`; reserve npm names, publish `@magnet-web/verify` with provenance, zero dependencies, vendorable, conformance vectors; `ml=` loader floor; purge mode separate from the kill switch; self-hosted widget with SRI only; cross-OS rebuild job and `tools/verify-release.mjs`; RFC 8785 normative for every signed object | The identity origin makes the build the trust root for every person's root | 2.19 |

## 1.4 Rejected or deferred (one line each)

| Finding (part) | Status | Reason |
|---|---|---|
| PRIV M5: replace the public allow list with membership credentials or salted commitments | deferred to block v2 | It replaces a validity rule every peer runs with a new trust object; `checkpoint` pruning and ban expiry cover the history part now, and PRIVACY.md states the current list stays public |
| DS F3 (b): relay PRES two hops | deferred | Battery cost on phones unmeasured (G-CH-7); v0.3 relabels the list instead |
| PHISH A3 and A6: a ledger-side device delegate op | rejected for v0.3 | Per-site working keys from the identity origin carry the same per-site exposure without a new ledger object; `rotate` from the identity origin is the recovery path |
| PHISH A6: QR login relay for another device's browser | rejected | No web API proves proximity; the feature is not offered at all |
| STALK A3 (3): send through a random relay | deferred | One more party sees size and timing; jitter and relay subsets ship first |
| RT 5.4: MLS or sender keys for groups | deferred (P3, P2) | MLS for the browser has no audit and needs commit ordering (RFC 9420); the epochId chain covers 32 members |
| RT 5.7: holders on phones | rejected | Battery, data and iOS background behaviour (RT 9.3) |
| RT option D: owner WebSocket mailbox for Tor Browser | deferred (P3) | It is a backend; it may be added later and labelled so |
| SC-2 (f): move WebTorrent into a worker that sees only ciphertext | deferred | Safari WebRTC in workers is unmeasured; the identity origin already keeps roots out of the WebTorrent realm |
| STALK A5 (1): 32-byte root and 24 words by default | deferred behind a version tag | The optional extra passphrase gives the same protection against a leaked phrase now; a larger root changes every vector |
| HUB H11 and SCALE M7: build the hub denylist and directory in v0.3 | deferred, counsel gate | ROADMAP lines 127 and 142 hold both for counsel; the rules are written now so the build cannot skip them |
| RT 9.4 (a): static TURN credentials as the recommended default | rejected as default | Open relay abuse (SYB A17); TURN stays off; option (a) is allowed with quotas and a warning, option (b) is labelled a backend |
| ID 3.6: NIP-07 or NIP-46 signer adapter | deferred (P3) | Needs an algorithm-tag decision outside this review |
| SCALE M1: send phone uploads to a hub web seed by default | accepted only where the hub offers it, never implied elsewhere | A web seed needs a host; the item shows who keeps it |

## 1.5 Decisions the owner signs off (wave 0)

The proposals' decisions D-1 to D-11, D-C1 to D-C9, PR-1 and PR-2 are resolved below; new decisions are marked **N-**. Each "Recommended" entry is what Part 2 builds; the owner may reverse any of them before wave 1, and Part 5 says which agents a reversal affects.

| Decision | Recommended | Alternative kept on file |
|---|---|---|
| N-1 identity origin | Yes, in v0.3, P0. A static bundle the project publishes, reproducible and hash-pinned, at a project origin by default; any owner, hub or person may run their own and the widget accepts a person-chosen identity origin; a browser-extension build is P2 | Root per site origin (rejected: MF-02) |
| N-2 who operates the default identity origin | The project, as a static host only (no server code), with its operator listed as a recipient of IP addresses at popup load | No default; every site names its own (fragments the "one identity" promise) |
| N-3 personal-site ownership | The person's key owns their personal site; browser genesis allowed for the personal-site class only | Hub-signed genesis (the hub would own every personal site) |
| N-4 freeze group | Adopt: `unban`, `rotate`, `keyinfo`, `checkpoint` (defined), moderator `allow` with caps, owner-protected entries, `ban.until`, reserved pools, author-scoped `@` keys, moderator voiding, pointer `org=`, `nx=`, `ml=` | Ship without and accept the listed failure modes |
| N-5 chat-key records | Off-ledger by default (`CK` frames), ledger copy opt-in | In the ledger (RT 5.2; bloat and permanence) |
| N-6 hub-scoped identity for social | Offered at hub sign-up, default on for hubs that run the social template | Pairwise only (follows break) |
| N-7 directory | Code off by default, "pending counsel" | Ship on (contradicts ROADMAP) |
| D-1 derivation | Root to per-label seed at the identity origin; labels from the browser-reported origin (2.2.3) | Per ledger id (MF-04) |
| D-2 storage | Root and vault only at the identity origin; site origins hold working keys per 2.12 | Root per origin |
| D-3 unlock | Passkey PRF at the identity origin first; passphrase there second; session-only third | Passkey per site origin |
| D-4 backup | Phrase (master) shown only at the identity origin; backup file with a generated passphrase; QR between identity origins | QR per site |
| D-5 migration | As ID 3.7, with the legacy key exported only into the identity vault | Keep legacy keys forever |
| D-6 sign-in format | `mw-signin-v1` (2.3.2) | ID 4.1 as written |
| D-7 sessions | 2.4.1 (sign out deletes working keys) | Lock that keeps usable keys |
| D-8 advisory roles | Keep `_roles/`, documented as never security; display only | Enforced role op (block v2) |
| D-9 moderator `allow` | (a) with per-moderator daily caps (policy field `modAllowPerDay`, default 20, chosen) | (b) owner only |
| D-10 `unban`, `rotate` | Adopt with `keyinfo` and the precedence rules (2.5.3) | Ship without |
| D-11 record format | Sealed items in `mw.s`, fixed 1,024-byte plaintext | `mw.r.<hmac>` lists |
| PR-1 | Local vault by default; synced sealed items only when `_mw.cfg.records` is on and the visitor opts in | |
| PR-2 | Random per-site record keys at the identity origin (shreddable per site) | Keys derived from the root |
| D-C1 swarms | `mw_chat1` on rendezvous wires, separate lane only when sparse; groups by tag on the lane | Separate lane always |
| D-C2 frames | 2.7.3 (clear header, hop outside hash, frame-bound stamp) | RT 4.2 |
| D-C3 budgets | 2.7.3 table, chosen and tunable | |
| D-C4 presence | Off by default, "Connected to you now", signed or MAC'd, padded frame | |
| D-C5 chat-key record | N-5 | |
| D-C6 DMs | Deniable sealed box (2.7.4) | Signed S1 |
| D-C7 groups | epochId chain, 32 members (chosen) | per-message wraps to 8 |
| D-C8 TURN | Off; option (a) allowed with quotas and the abuse warning, option (b) labelled a backend | |
| D-C9 file lanes | F1 public (owner turns on), F2 private and private media (separate visitor opt-ins), F3 direct (P2), F4 owner pin (moderator queue) | F2 on with chat |

---

# Part 2. The resolved v0.3 design

## 2.1 Overview and trust map

```
            person
              |  one tap, passkey prompt, phrase (only here)
              v
  +-------------------------+        top-level window only (popup, or a redirect round trip)
  | identity origin (IdO)   |        static bundle, own Service Worker, own CSP,
  | root (wrapped), vault,  |        frame-ancestors 'none', hash-pinned build
  | passkey RP ID, cards    |
  +-----------+-------------+
              | postMessage: requests in, proofs and per-site key bundles out
              | (IdO reads the requester from event.origin, never from the page)
              v
  +-------------------------+   +--------------------------+   +-----------------------+
  | site origin A (loader)  |   | site origin B (drop-in)  |   | server-backed site C  |
  | working keys for A only |   | working keys for B only  |   | gets a signed proof;  |
  | Service Worker: media   |   | page scripts can use them|   | @magnet-web/verify    |
  | decryption, inert routes|   | while signed in          |   | checks it             |
  +-----------+-------------+   +-------------+------------+   +-----------------------+
              | mw_chain1, mw_chain2, mw_chat1, file and media torrents (WebRTC)
              v
     peers, trackers, STUN, relays, the hub pin and snapshot service (each a stated recipient)
```

Rules that hold everywhere in Part 2:

1. **No site origin ever holds the root, the 12 words, the backup-file passphrase, the passkey PRF output, the vault key or another site's keys.** A site origin holds only the working keys for its own label (2.2.3).
2. **Site code is trusted for its own site and nothing else.** In shell mode the site frame is same-origin with the loader and in drop-in mode the page is the loader's realm (ARCHITECTURE 3.4.9; ID 6.5). The design therefore never claims that site code cannot use the keys of the site it runs on; it guarantees that it cannot reach anything beyond them.
3. **The A4 rule, extended.** No SDK method returns or exports a private key, a seed, the root, a playback key or a file key; no SDK method grants consent, accepts a link ("same identity"), chooses the sign-in `domain` or `origin`, or opens a card without transient activation. These live only in loader-owned UI or at the identity origin (2.11.1).
4. **Validity of a ledger block stays a function of `e` (and `v` against `vh`) only.** Schemas, caps per author and feature rules are state or SDK rules (MF-21).
5. **Every recipient is named before data flows** (2.14).

## 2.2 Identity

### 2.2.1 The root

- **Root:** 16 random bytes from the CSPRNG at the identity origin, encoded as 12 BIP-39 English words (encoding only). 128 bits stays the size (ID 15 Q6); 24 words stay a later version tag (1.4).
- **Optional extra passphrase ("extra word").** When set, `root* = HKDF-SHA-256(ikm = root || Argon2id(extra, salt = SHA-256("mw/extra/v1" || root)), salt = "mw/id/v2", L = 32)`; otherwise `root* = HKDF(root, salt = "mw/id/v2", L = 32)`. With an extra passphrase a leaked phrase alone derives nothing (STALK A5). The card says: "If you set an extra word and forget it, nobody can restore this identity."
- **Identity check code:** `checkCode = base32(SHA-256("mw-check-v1" || root*))[:8]`, printed on the recovery kit and shown after every restore (MF-11).
- **Where it lives:** only at the identity origin, wrapped (2.2.4). Never in a site origin, never in a URL, never in a ledger.

### 2.2.2 Derivation tree and random keys

Computed at the identity origin. `scalar(x) = (x mod (n - 1)) + 1` over a 48-byte HKDF output (ID 3.1; the reduction keeps bias negligible and needs no retry loop).

```
labelSeed(label) = HKDF(root*, salt = "mw/id/v2", info = "seed|" + label, L = 32)     // never leaves the IdO
signKey(label,i) = scalar(HKDF(labelSeed, info = "sign|" + i, L = 48))                 // P-256 ECDSA; i starts at 1, rotation increments it
recoverKey(label)= scalar(HKDF(root*, info = "recover|" + label, L = 48))              // P-256 ECDSA; never leaves the IdO
K_name(label)    = HKDF(labelSeed, info = "name|1", L = 32)                            // HMAC: hint tags, blinded ids
K_vaultHash      = HKDF(root*, info = "vault-id|2", L = 32)                            // names the vault, does not open it

random, per label, stored in the vault (never derived from the root):
  chatKey[e]  P-256 ECDH key pair per chat epoch e (rotation every 90 days, chosen, or on demand)
  K_rec[r]    AES-256-GCM key per record epoch r (sealed items, 2.6)
  K_own       AES-256-GCM key that wraps the person's own file and media keys (2.9.4)
```

- **Why the signing key is derived and the others are random.** The signing key is the person's public identity on a site; the phrase must restore it. Chat, record and own-media keys are random so that deleting one retires it (MF-18): a phrase thief gets the public identity on every label, and nothing of the past content unless they also get the vault.
- **Vault:** `{ v: 2, labels: { <label>: { i, chat: [{ e, jwk, exp }], rec: [{ r, key }], own, contacts, links, sites } }, legacy: [...] }`, encrypted with a random 32-byte `K_vault`. `K_vault` is wrapped twice: by the passkey PRF key and by the backup-file key (2.2.4). It is never wrapped by a key derived from the phrase alone, so **a phrase-only restore recovers every public identity but cannot read old messages, records or own media** (stated in the restore card).
- **Golden vectors:** `test/vectors/identity.json` (append only): phrase, optional extra word, root*, three labels of each kind, every derived public key, a signature, the check code. Computed in Node, checked in Chromium and WebKit (R3 A4).

### 2.2.3 Labels: what a key is scoped to

The identity origin chooses the label from what the browser reports, never from page text (MF-04).

| Label | Form | When | Effect |
|---|---|---|---|
| origin | `o|` + `event.origin` (scheme, host, port) | default for every site, including server-backed sites and drop-in hosts | pairwise: two origins never share a key |
| ledger | `l|` + ledgerId | the request carries the site's signed pointer; the IdO verifies its signature; lineage holds (`owner == lo`, or a verified `rot=` chain from `lo` to `owner`); and `event.origin` is the pointer's own host or is listed in its `org=` field (at most 4 origins, chosen to fit the 900-byte pointer limit, ARCHITECTURE 4) | mirrors the owner signed for share one identity; a look-alike origin claiming the ledger id gets its own origin label and the card says "This address is not one of this site's addresses" |
| hub | `h|` + hub suffix | the person turned on "Use one identity on all of <hub>"; the host is `<32 base32>.<suffix>`; the suffix is on the Public Suffix List snapshot bundled in the IdO build | every personal site on that hub sees one key for this person (social graph); other hubs stay pairwise |
| linked | the label of another site X | the person chose "Use the same identity as on X" (2.3.5) | this origin receives X's key; the IdO records the link locally |

A shared-origin hub (ARCHITECTURE 3.3) never receives a persistent key: one origin serves many publishers, so the IdO offers "this visit only" there (ID 3.3, R5 F19).

### 2.2.4 Unlock at the identity origin

| Method | How | Notes |
|---|---|---|
| Passkey (default where supported) | One discoverable credential, RP ID = the IdO host, `user.id` 16 random bytes, `user.name` and `displayName` a person-chosen nickname (default "felinar identity"), `userVerification: 'required'`, `extensions.prf.eval.first = SHA-256("mw-idp-prf-v1")` at `create()`; if PRF is returned there it is used at once, otherwise one `get()`; `K_unlock = HKDF(prf, info = "mw-idp-wrap-v1")` wraps `root*` and `K_vault`; the self-test reuses the same output | One RP ID: no per-site sprawl (UX M3); PRF is reachable only by IdO code (PHISH A4); the provider sees one credential for one origin (PRIV M7) |
| Passphrase | Argon2id m = 64 MiB, t = 3, p = 1 where WebAssembly runs under the IdO CSP (`script-src 'self' 'wasm-unsafe-eval'`); about 0.1 s on an M3 (ID F7 lab; mobile not measured, G-ID-6); where WebAssembly is unavailable, PBKDF2-SHA-256 at 600,000 iterations (the count the v0.2.1 export uses, `config.js` line 98 per PHISH A14) with the KDF named in the header and on the card | Never a silent downgrade (MF-17) |
| This visit only | No storage; the IdO hands out the site's keys for the tab and forgets the root when its window closes | Shared computers, browsers without storage |

`K_unlock` never leaves the IdO. The wrapped blob `{ v: 2, kind, credId?, salt?, kdf?, iv, ct }` (60 to 120 bytes) is stored in the IdO's IndexedDB.

### 2.2.5 The escrowed wrapped root (surviving storage eviction)

The passkey-wrapped blob is opaque without the PRF output, which only IdO code can obtain for the IdO's RP ID. The IdO therefore hands a copy of the blob (and of the wrapped vault) to every site origin the person signs in to, which stores it as an opaque value. When Safari's 7-day rule (https://webkit.org/tracking-prevention/, accessed 2026-10-20, ID 3.5) or a storage purge removes the IdO's own copy, the next sign-in passes the site's copy back; the IdO authenticates it with AES-GCM before use, so a forged blob fails. Where WebAuthn `largeBlob` is shown to work (lab row G-ID-3b), the blob is also written to the credential. A site that keeps the blob learns nothing it can open; it only learns that the person has a felinar identity, which it already knows.

### 2.2.6 Backup and recovery

| Route | Kept by the person | Restores | Rules |
|---|---|---|---|
| Recovery phrase (master) | 12 words, printed or written, with the check code | every public identity (every label's signing key) | shown and typed only at the IdO; 3-word re-entry check; "felinar never asks for your 12 words on a website. If a site asks, it is not us." |
| Backup file | `mw-identity-v3` JSON `{ v: 3, kdf, params, salt, iv, ct }` holding `root*`, `K_vault` and the vault | everything, including old messages, records and own media | made only at the IdO; generated 6-word passphrase by default (or a chosen one meeting a stated floor); labelled "Do not email"; legacy 0.2.1 keys travel inside |
| Passkey | the passkey in the person's provider | this device; other devices only with the escrowed blob (2.2.5) or `largeBlob` | the provider's account recovery becomes a recovery path for this identity, stated on the card (PHISH A15) |
| Device hand-off | nothing | moves the IdO state (root and vault) to a new device's IdO | 2.3.8 |

Card timing: the recovery-kit card appears after the first meaningful action (first ledger write, first message, first upload, first `mw.me.set`, first "keep history" toggle; ID 3.5 plus UX M6). On iOS outside Home Screen mode it appears on every visit until saved, and the first visit offers Add to Home Screen, with the copy "Safari deletes this site's data after 7 days without a visit unless you add it to your Home Screen" (UX M5). A "this visit only" identity is never created without either showing the phrase or the sentence "This identity disappears when you close this window."

After a phrase or file restore the IdO shows the check code and "Is this the code on your recovery kit?". When the person next signs in to a felinar site, the loader reports whether the derived key has entries in that site's ledger, and the IdO card shows "Found 14 posts by this identity on <site>" or "No posts found for these words on <site>. Check the words, or continue as a new identity." (UX M8; E-ID-3b).

### 2.2.7 Migration from 0.2.1 identities (amends ID 3.7)

0.2.1 keys are random, extractable and stored per ledger in the site origin (`app.js` line 542, ID 3.7). On the first v0.3 sign-in on a ledger that has one: the loader asks the IdO popup to take the legacy key into the vault (it is exported once into the popup over the bundle channel, sealed in the vault and in the next backup file, then deleted from the site origin after a backup exists); the card offers "Keep posting as <name> (your old key)" or "Start fresh". The default links them: the legacy key signs `append('mw.link', { from, to, t, sigTo })` on that ledger only. It is public on that site, which already shows both keys' posts, and it is never written to another site. On `allow` sites the legacy key stays the author until the owner adds the new key (HON M9).

## 2.3 Sign-in for any site

### 2.3.1 The three flows

| Site kind | What the person does | What happens | What the site gets |
|---|---|---|---|
| (a) felinar site (shell, hub, drop-in of a felinar site) | taps "Sign in" in the loader's prompt or the site's button | the loader opens the IdO popup; the IdO card shows the origin, the identity mode and one button; passkey prompt; the popup returns an encrypted key bundle and closes | working keys for its label (2.2.3), installed in the loader; `mw.auth.state()` becomes `signed-in` |
| (b) any existing site through the drop-in widget | taps the widget's "Sign in with felinar" button | the widget opens the IdO popup; same card; the popup returns a proof (and, if the site also runs the drop-in engine for chat, a key bundle) | a `mw-signin-v1` proof bound to its origin; optionally working keys |
| (c) server-backed site | taps the site's button | the page fetches a challenge from its server, passes it to the widget, the IdO card shows the statement verbatim, the proof goes back to the page, which posts it to the server; the server runs `@magnet-web/verify` | a verified public key, `keyMode`, times; the server mints its own session |

Opening: `window.open(IdO + '/signin', 'mw-idp', 'popup,width=420,height=640')` from a click. The popup posts `{ t: 'mw-idp-ready' }` to `window.opener`; the page answers with the request; the IdO takes the requester's origin from that message's `event.origin` and checks `event.source === window.opener`; the answer is posted with `targetOrigin` equal to that origin. Site pages must not send `Cross-Origin-Opener-Policy: same-origin` (use `same-origin-allow-popups`), and the shell's headers are set accordingly. Where a popup cannot open or the opener link is lost (some in-app browsers; lab row G-ID-7), the **redirect round trip** is used: the page navigates top-level to `IdO/signin#<request>` with a fresh page ECDH key and returns to `<origin>/_mw/idp-return#<response>`, the bundle encrypted to that key; the IdO accepts a return URL only on the origin it is signing for.

### 2.3.2 The `mw-signin-v1` format (normative)

**Request** (page to IdO, after `mw-idp-ready`):

```
{ v: 1, t: 'mw-signin-req',
  requestId: <16 to 32 bytes b64url, chosen by the page>,
  purpose: 'site' | 'server',
  pointer?: <signed MW-PTR/1 record text>,                 // felinar sites; enables the ledger label
  challenge?: { nonce: <16 to 64 bytes b64url, issued by the verifier>,
                statement: <0 to 280 characters, NFC, no control or bidi characters>,
                exp?: <ms>, nbf?: <ms>, resources?: [<https URL>, at most 4] },
  want: ['keys'] | ['proof'] | ['keys', 'proof'],
  epk: <p256: page ECDH public key for the bundle> }
```

**Challenge object signed by the IdO:**

```
c = { v: 1, t: 'mw-signin',
      domain:   <host of event.origin, lowercase, with port if not default>,
      origin:   <event.origin>,
      ledger:   <ledgerId> | null,                        // set only for the ledger label
      pub:      <p256: signKey of the chosen label>,
      keyMode:  'pairwise' | 'ledger' | 'hub' | 'linked',
      nonce:    <challenge.nonce>,                        // purpose 'site' without a challenge: 16 random bytes from the IdO
      statement:<challenge.statement> | '',
      resources:[...] ,                                   // echoed, at most 4
      iat:      <ms, IdO clock>,
      nbf:      <challenge.nbf or iat>,
      exp:      <min(challenge.exp, iat + 300000)>,        // at most 5 minutes after iat
      requestId:<echo>,
      idp:      <IdO origin>,
      build:    <IdO build id> }
proof = { c, alg: 'ES256-P1363',
          sig: b64url( ECDSA-P256-SHA-256( signKey, utf8("mw-signin-v1\n" + JCS(c)) ) ) }   // raw r||s, 64 bytes
```

- `JCS` is RFC 8785 (the repo's `src/chain/canonical.js` is that serialiser). The verifier recomputes the bytes from the parsed object and uses only the object it verified.
- `domain`, `origin`, `ledger`, `pub`, `keyMode`, `iat`, `idp` and `build` come from the IdO, never from the page (PHISH A18, STALK 4 "challenge farming").
- `purpose: 'server'` without a `challenge.nonce` is refused (`E_NONCE_REQUIRED`).
- Proofs made for a page's own use (`purpose: 'site'`, IdO nonce) are kind `local`; `@magnet-web/verify` rejects them by construction because their nonce was never issued by the verifier.
- The signing prefix `mw-signin-v1\n` is distinct from `mw-block-v1\n`, `mw-msg-...` and the other prefixes (2.10.3), so a sign-in signature can never be replayed as a block, a chat-key record or a link.
- **Vectors:** `test/vectors/signin.json` (append only): valid proofs for each `keyMode`; negative vectors for a foreign origin, a foreign domain with the right origin, an `exp` 1 ms over 5 minutes, a future `nbf`, a reused nonce, a high-S signature (accepted; dedupe never uses the signature), a DER signature (rejected: `alg` is P1363), duplicate JSON keys, a non-NFC statement, an unknown field, `ledger` present when the verifier expects none, and a `keyMode` the verifier did not allow (SC-10).

### 2.3.3 The key bundle (site purpose)

For `want: ['keys']` the IdO returns `{ bundle: ECIES(page epk, K) }` with `ECIES` = ephemeral ECDH P-256, HKDF-SHA-256 (info `mw-idp-bundle-v1|` + origin), AES-256-GCM, and `K = { label, keyMode, sign: { d, x, y, i }, chat: { e, d, x, y, exp }, rec: { r, key }, own, name, escrow: <wrapped root blob>, vaultEscrow: <wrapped vault blob>, rotateNotice? }`. The loader imports each scalar as a non-extractable CryptoKey and drops the JSON. A page that sent `epk` and is not the opener never receives the answer, because the IdO posts only to `event.origin` of the verified opener.

### 2.3.4 The loader-owned card (at the IdO)

One card, one button, at most one platform prompt for a returning person (MF-09).

```
+--------------------------------------------------+
|  Sign in to  shop.example                        |   <- origin from the browser; registrable part in bold
|  https://shop.example                             |
|                                                  |
|  as  [identicon]  Ana  ·  k3f9-2xq1              |
|      Private to this site                   [v]  |   <- mode menu: Private (default) / Same as on ... (2.3.5)
|                                                  |
|  "Sign in to Example Shop. Nonce 9f2c..."        |   <- server statement, verbatim, if any
|                                                  |
|  This site gets a key that works only here.      |
|  It cannot see your other sites.                 |
|  Code on this site can act as you here while     |
|  you are signed in.                              |
|                                                  |
|  [ Continue with passkey ]        Cancel         |
|  Stay signed in on this device   [ ]             |   <- off by default (MF-60)
|  What others can see  ·  Build 0.3.0 a91c...     |
+--------------------------------------------------+
```

- First visit to an origin adds one line: "First time you sign in here." The first approval of any origin requires user verification (passkey or passphrase), so a reverse proxy cannot get a silent approval (PHISH A7).
- High-risk actions show only in this window: first sign-in to an origin, "same identity", link a device, read private record (`mw.me.get` first use per session), show the phrase.
- Cards in the site page (consent, upload confirmation) are prompts and low-risk confirmations only. They keep the closed shadow root and `isTrusted`, and add topmost-element, opacity and mutation checks; the docs call these speed bumps (PHISH A5).
- The card never shows `dn=` without "name chosen by the publisher" (PTR A8).

### 2.3.5 The per-site default and the explicit linking choice

- Default: **Private to this site** (`keyMode: 'pairwise'` or `'ledger'` for listed mirrors).
- **Same as on ...:** the menu lists sites the IdO has signed the person in to (local list, never uploaded). Choosing one shows: "shop.example and forum.example will both know this is you. This cannot be undone once this site has seen it. You can stop using it here later, but the site keeps what it learned." Confirm requires a second deliberate press. The IdO records `{ origin, label }` in the vault's `links` and returns that label's key with `keyMode: 'linked'`.
- **Revoking for the future:** Settings at the IdO lists links; "Stop using the same identity here" switches the origin back to its own pairwise label for future sign-ins and tells the person the site already knows the link.
- **Hub scope** (2.2.3) is the same choice made once for a hub, with copy "Everyone on <hub> will see one identity for you."
- **Pressure limits:** the choice is offered at most once per origin per 30 days (chosen, STALK 4); it is never offered on page load; no SDK parameter can preselect it (PHISH A13); a refusal is remembered.
- Nothing is written to any ledger by linking. A public link statement on a ledger is a separate, explicit action with its own card ("public and permanent on this site").

### 2.3.6 The drop-in widget on an existing site

```html
<script type="module" src="/_mw/signin.js" integrity="sha384-..." crossorigin></script>
<mw-signin statement="Sign in to Example Forum" challenge-url="/auth/mw/challenge" proof-url="/auth/mw/verify"></mw-signin>
```

- The widget is self-hosted on the site's origin with SRI (SC-7; STALK A7: no central widget host that sees every site). `tools/publish.mjs --signin-widget` copies it and prints the tag.
- The widget renders one button in a closed shadow root. On click it fetches the challenge (server sites), opens the IdO popup, and posts the proof to `proof-url`. It never holds a phrase or a root, and it never shows a card that asks for secrets (UX B4).
- Docs sentence for site owners and the widget's info link: "Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites."
- The chat panel (Part 3.7) needs the drop-in engine (peers), so it is available only where the site also loads `/_mw/mw.js`.

### 2.3.7 `@magnet-web/verify` (Node 22 and browsers)

One ES module, zero runtime dependencies, under about 400 lines (chosen), published with provenance from a protected environment, vendorable as a single file whose SHA-256 is printed in the spec (SC-4). Uses WebCrypto (`crypto.subtle`, present in Node 22 and browsers), whose ECDSA verify takes the raw P1363 `r || s` form directly, so no DER conversion exists to get wrong (SEC minor).

```js
import { createVerifier, issueChallenge, MemoryNonceStore, statelessNonce } from '@magnet-web/verify';

const v = createVerifier({
  origin: 'https://forum.example',          // required, exact; never read from request headers
  ledger: null,                             // or the expected ledgerId for a felinar site
  allowKeyModes: ['pairwise', 'linked', 'hub', 'ledger'],
  allowIdps: ['https://id.example-project.org'],   // optional allow-list of identity origins
  maxAgeMs: 300000, maxSkewMs: 120000,      // skew capped at 300000
  nonces: new MemoryNonceStore() /* or { consume(nonce, expMs): Promise<boolean> } atomic in a shared store */ ,
  now: () => Date.now() });

const ch = await issueChallenge({ statement: 'Sign in to Example Forum', nonces, ttlMs: 300000 });
// -> { nonce, statement, exp }   (statelessNonce(secret) issues HMAC nonces for servers that cannot store state)

const r = await v.verify(proof);
// -> { ok: true, pub, keyMode, ledger, iat, exp, requestId, statement, idp, build }
// -> { ok: false, reason: 'parse'|'version'|'alg'|'sig'|'origin'|'domain'|'ledger'|'keymode'|'idp'
//                         |'nonce'|'replay'|'expired'|'not-yet-valid'|'too-long'|'statement', at: <verifier time> }
```

Order of checks (cheap first, SYB A16): parse and size (at most 4 KiB) → version and type → origin and domain → age and skew → nonce consumption (stateless MAC first) → signature → statement and resources match the issued challenge. The library never returns roles or a ledger state (PHISH A8 item 7); "scope is a request, never a grant" is in its README. It documents: bind accounts to `pub` only after separately verified contact data (pre-hijack, PHISH A8 item 8); dedupe on the nonce, never on the signature (ECDSA malleability, SEC minor); use only the returned object (parser differential, PHISH A8 item 5); a load balancer needs a shared atomic nonce store (DS F15). A loopback Node E2E test runs a two-instance server with a shared store and asserts that a replayed proof fails at the second instance (E-SI-4).

### 2.3.8 Cross-device

| Route | Steps | Moves | Notes |
|---|---|---|---|
| Passkey sync | sign in on the new device; the IdO finds the synced passkey; PRF unwraps the blob from `largeBlob` or from an escrow copy on any site the device already signed in to | root and vault | only where G-ID-3 shows equal PRF output and the blob is reachable; otherwise one of the routes below once per device |
| QR between identity origins | new device B opens IdO "Link this device"; B shows QR 1 `mwlink:2:<H(eB)>:<nonceB>`; old device A (unlocked, on its own "Link a device" screen, opened within the last 120 s) scans and shows QR 2 `<eA>`; B scans and shows QR 3 `<eB>`; both show `SAS = (uint32(SHA-256("mw-link-v2" || eA || eB || nonceB)[0..4]) mod 10^6)` as 6 digits; the person confirms on A; only then A shows QR 4 `AES-GCM(K, root* and K_vault)` with `K = HKDF(ECDH(eA, eB), info = "mw-link-v2" || transcript)` | root and vault | in person only; no network path; the commitment stops grinding, so a substituted key passes with probability 10^-6 (arithmetic); the QR never carries a site name or ledger id (PRIV m4); the most frequent codes are about 0.02 percent more likely than the others (arithmetic: 2^32 = 4,294,967,296 = 4,294 x 10^6 + 967,296) |
| Phrase at the IdO | type 12 words (and the extra word) at the IdO | public identities only | old content needs the backup file or a device link |
| Backup file at the IdO | open the file, type its passphrase | root and vault | |

Each site on the new device then needs one tap (2.3.1); per-site seeds never travel (PHISH A6).

### 2.3.9 Phishing, replay, consent and linkability risks of the cross-site sign-in

| Risk | Mitigation | What remains |
|---|---|---|
| Look-alike site asks for the 12 words | words exist only at the IdO address; site cards have no phrase field (E-ID-10); copy on the kit and the card | a person who types the words into another page loses every identity |
| Look-alike IdO address | IdO address printed on the kit; passkey RP ID binds to the real IdO host, so a fake IdO cannot use the passkey; the IdO build id and hash on every card | a person who types the phrase into a fake IdO |
| Reverse proxy of a real site | proof origin comes from the browser; first approval of an origin needs user verification at the IdO | a person who approves "Sign in to evil.example" |
| Replay of a proof | verifier nonce, single use, `exp - iat` at most 5 min, skew stated, origin exact | a proof stolen inside the 5 minutes and used before the real one, at the same verifier |
| Cross-site use of a proof | `origin` and `domain` bound and checked; `ledger` checked when expected | none known |
| Consent | one card per first sign-in per origin; statement verbatim; no silent proofs for servers (each server proof shows the card) | a person who taps through |
| Linkability by key | pairwise labels; linking only by the person's choice at the IdO; nothing in any ledger | IP address, timing, reused names, writing style (STALK A7) |
| Linkability by the IdO host | static bundle cached by the IdO Service Worker, so most sign-ins make no request to the IdO host; the opener sends no referrer (`Referrer-Policy: no-referrer` on loader pages) | the IdO host sees the IP and time of popup loads that miss the cache and of update checks; listed as a recipient |
| Linkability by colluding servers | per-site keys; library logs nothing; docs say the server sees IP and user agent at sign-in | two servers joining their logs by IP and time |
| Sign-in fatigue and dark patterns | "same identity" once per origin per 30 days, never on load, no SDK preselect; `signIn()` cooldown 10 s | pressure from a site's own page text |

## 2.4 Authentication

### 2.4.1 States and sessions (replaces ID 4.2)

| State | Meaning | Site sees | How it ends |
|---|---|---|---|
| `guest` | no working keys for this origin's label in this browser | `identity: null`; reads work; a write opens the sign-in prompt | sign in |
| `signed-in` | working keys in loader memory (and in IndexedDB only if "Stay signed in on this device" was chosen) | `identity: { pub, short, name, mode }`, `role` | sign out, "Shared computer" tab close, expiry of "stay signed in" (30 days, chosen), key rotation |

- **Sign out** deletes the working keys from memory and IndexedDB, clears any proof the loader made, stops presence and leaves chat lanes. The opaque escrow blobs stay unless the person chooses "Remove from this device", which also removes them and the cached sealed items. Because the root stays at the IdO, signing in again is one tap (MF-14).
- **Shared computer** (a choice on the card): keys in memory only; nothing written to IndexedDB on this origin.
- **Follower tabs** (ARCHITECTURE 5.9) never hold keys; writes go to the leader, and a `signed-out` broadcast on the tab channel makes followers drop their state. Test E-ID-2b.
- **Local revocation epoch:** sign-out increments a per-origin counter; `mw.auth.verify` refuses local proofs from an earlier epoch.
- **0.2.1 compatibility:** a 0.2.1 site that calls `mw.db.append` without sign-in gets the sign-in prompt on the first write (implicit sign-in, ID 4.2).

### 2.4.2 Proof kinds

| Kind | Made by | Lifetime | Accepted by | Use |
|---|---|---|---|---|
| `local` | the loader on the site origin, with the site key, `"mw-local-v1\n"` prefix | at most 15 min (chosen), memory only, never written to storage | `mw.auth.verify` in the same tab and epoch | site code checking "is the visitor signed in" |
| `server` (`mw-signin-v1`) | the IdO, through the card | `exp - iat` at most 5 min | `@magnet-web/verify` with a verifier nonce | server-backed sites, drop-in widget sites |
| peer session | the wire handshake (2.4.3) | the wire's life | the two peers | "connected to Ana" on that wire |

### 2.4.3 Peer authentication on a wire (replaces the `chan` binding)

The `mw_chat1` wire starts with a **Noise XX handshake pattern** (noiseprotocol.org, revision 34) instantiated with P-256 ECDH, HKDF-SHA-256 and AES-256-GCM, the two parties' current chat keys as static keys, and the prologue `"mw-wire-v1" || ledgerId`. Each side learns the other's chat key; the chat key is tied to a site key by its signed `CK` record (2.7.2). After the handshake every frame on that wire carries an AEAD tag under the session key, so a relaying peer that claims someone else's peer id holds a different transcript and cannot use the session (MF-40). No signature is used, so the handshake is not a transferable proof that two keys were online together (PRIV M2). The handshake is new cryptographic code: it gets vectors, the A1-class fuzzer and an outside review before it is called secure (2.19). Nothing in v0.3 is gated on wire identity alone: messages are end-to-end authenticated (2.7.4), and the wire session only labels a neighbour. Remaining exposure, stated in 2.16: the WebSocket tracker relays SDP offers and answers, so a hostile tracker can sit in the middle of the WebRTC transport; it learns both IPs and timing but cannot read or forge sealed messages.

## 2.5 Authorisation

### 2.5.1 Roles

The ledger policy is the only source of truth: `roleOf(pub, state)` returns `owner`, `moderator`, `writer` (allowed or open) or `reader` (ARCHITECTURE 6.5). Advisory `_roles/` keys (ID 5, D-8) stay display hints; SDK.md says "never gate a security decision on `_roles/`: any moderator can overwrite them" (SEC minor). Proof `scope` is a request shown to the person, never a grant (PHISH A8 item 6).

### 2.5.2 Membership on `allow` sites (D-9 resolved)

- Moderators may add keys to `allow` (add only; never remove keys the owner added), at most `modAllowPerDay` additions per moderator per UTC day by claimed `ts` (policy field, default 20, chosen; HUB H8). Additions beyond the cap have no effect (state rule).
- **Join request:** a sealed `join` item (2.6) addressed to the moderators' chat keys, carried as an ENV with the `hold` flag and held by the pin mailbox when one exists. Screens: "Request sent", "No moderator is online. Your request waits for up to 7 days.", "You're in", "Your request was declined".
- Moderators never act on a "I lost my key" request received in chat; recovery goes through `rotate` (PHISH A11).

### 2.5.3 Freeze-window format group (N-4; must land before any public ledger)

Every item here changes what v1 peers accept or compute, so all are adopted together, with vectors, in one release before any public ledger exists (ROADMAP "freeze group"). Until then they are reserved.

| Item | Exact form | Rule |
|---|---|---|
| `unban` (control op) | `{ t: 'unban', author: <p256:> }` | valid from owner standing; from a moderator in effect only if every effective ban of that author was by a moderator; owner bans are lifted only by the owner (HUB H8). Values redacted by the ban stay dropped |
| `ban.until` | `{ t: 'ban', author, until?: <ms> }` | the ban governs blocks of that author with `ts < until`; absent means permanent (PRIV M5) |
| `keyinfo` (control op) | `{ t: 'keyinfo', rc: <b64url sha256(utf8(recover pub))> }` | author is the key itself; valid only from a key that may write under the governing policy; first `keyinfo` per author in total order wins; never redactable, so a moderator cannot remove the recovery commitment (HUB H8 ii) |
| `rotate` (control op) | `{ t: 'rotate', from: <p256:>, next: <p256:>, by: 'self' | 'recover', rp?: <p256: recover pub>, rsig?: <b64url> }` | `by: 'self'`: authored by `from`. `by: 'recover'`: authored by `next`, `rp` must hash to `from`'s `keyinfo.rc`, `rsig` = ECDSA by `rp` over `"mw-rotate-v1\n" + ledgerId + "\n" + from + "\n" + next`. **A recover rotation of `from` overrides any self rotation of `from`, in any order**; among several recover rotations the lowest `(depth, h)` wins. `next` inherits `from`'s bans and `allow` membership, never moderator or owner standing. Readers show "key changed on <date>" (PHISH A11, UX M9) |
| `checkpoint` (control op, defines the reserved name) | `{ t: 'checkpoint', heads: [<h>, at most 32], snap: <hex sha256 of canonical(S)>, n: <blocks covered>, bytes }` | owner standing only. `S` = `{ v: 1, covered: <b64url of the sorted 32-byte hashes>, state: <the reduce() output at heads, values of tombstoned items absent> }`, distributed by `cs=` and peers and verified by hash. A copy that holds `S` may delete every block in the checkpoint's causal past (stubs included) and reduce from `S`; a later block whose `prev` names a covered hash is accepted as if the parent were held. Cost: 32 bytes per covered block in `S` (arithmetic). This is the erasure path (MF-26), the bloat recovery (SYB A1) and the tail sync base (Part 3) |
| policy fields | `modAllowPerDay` (uint, default 20), `modActionsPerHour` (uint, default 60, chosen), `reservedPool` (0 to 50 percent, default 25), `voided: [{ author, after: <h> }]` (at most 50) | `voided`: control blocks by `author` that are not in the causal past of `after` have no effect (HUB H6). Moderator `ban`, `tombstone` and `unban` blocks beyond `modActionsPerHour` per claimed hour have no effect (HUB H2) |
| owner-protected payload | state rule | a moderator `tombstone` whose target was written with owner standing has no effect (HUB H5) |
| author-scoped keys | state rule | a `put` key starting with `@` + the first 16 characters of b64url(sha256(author pub)) + `/` takes effect only from that author (SYB A13) |
| reserved pool | admit rule (local) | authors who are not owner, moderator or allow-listed share at most `reservedPool` percent of `maxChainBytes`; beyond it they get `E_CAP` while vetted authors still write (SYB A1) |
| moderator tombstone grace | node rule (local) | a moderator tombstone hides the value at once and deletes it physically after 24 h (chosen), unless the target is on the P0 path (`_deny/`), so a late revocation can restore it (HUB H7) |
| bulk tombstone | `{ t: 'tombstone', h: <hex> }` stays; new optional form `{ t: 'tombstone', authors: [<p256:>, at most 64], before: <h> }` | moderator or owner; hides every payload of those authors not in the causal future of `before` (SYB A4) |
| pointer fields (no validity change: unknown keys are kept and signed today) | `org=<origin>` (repeatable, at most 4), `nx=<b64url sha256 of the next owner key string>`, `ml=<minimum loader version>`, `idp=<suggested identity origin>` | `nx`: a later record's owner key is accepted only if it hashes to the previous record's `nx` (MF-28); `ml`: a loader older than `ml` refuses to mount and offers the update (SC-6); the rot v1 path is deleted before release (PTR A5) |

The unknown-op rule (ARCHITECTURE 6.1) is unchanged: until a peer runs the freeze-group release, `unban`, `keyinfo`, `rotate` and the defined `checkpoint` are `unknown-op` to it; `vanish` and `grp` stay reserved and undefined. Because v0.2.1 peers reject the new ops, the freeze-group release must ship before any public ledger carries one, and loaders older than the `ml=` floor refuse to mount (so no public ledger has two kinds of peers for long).

### 2.5.4 Writers and features (HON M9)

| Feature | `writers: 'owner'` | `writers: 'allow'` | `writers: 'open'` |
|---|---|---|---|
| Sign in, read | yes | yes | yes |
| Post to the ledger | no (`E_POLICY`) | allow-listed keys | anyone, with the fee |
| Chat (DMs, rooms, groups) | yes: chat keys are off-ledger `CK` frames | yes | yes |
| Sealed items (records, own media index, grants) in the ledger | no: vault only | allow-listed | anyone, with the fee and the reserved pool |
| Public file listings | owner and moderators | allow-listed, if `_mw.cfg.files` is on | anyone, if on (premoderated for new keys) |
| Private files and private media | yes (off-ledger grants by chat; ledger index only if the person may write) | yes | yes |
| Migration link item | not possible: the legacy key stays the active author | the legacy key stays the author until the owner adds the new key | yes |

`mw.chat.enable()` on an owner-only site works; `mw.me.sync({ on: true })` there fails with `E_POLICY` and the reason "This site does not let visitors write to its ledger, so your record stays on this device."

### 2.5.5 Owner settings (UX M14)

| Setting | Stored in | Command | Default |
|---|---|---|---|
| chat | `_mw.cfg.chat` = `off` / `members` / `open` | `ledger-admin cfg --chat members` (owner key, offline) or the moderator Settings card (advisory; shows "set by <key>") | `off` |
| public file listings | `_mw.cfg.files` = `off` / `members` | `ledger-admin cfg --files members` | `off` |
| private files and media | `_mw.cfg.media` = `off` / `members` | `ledger-admin cfg --media members` | `off` |
| synced sealed records | `_mw.cfg.records` = `off` / `sealed`, with `maxItems` (at most 32) | `ledger-admin cfg --records sealed --max-items 4` | `off` |
| message requests from strangers | `_mw.cfg.requests` = `off` / `on`, `chatBits` | `ledger-admin cfg --requests on --chat-bits 20` | `off` |
| own tracker and STUN for chat and files | pointer `tr=` and the STUN list in the site config | `publish --tracker wss://... --stun stun:...` | required when chat or files are on (MF-44) |
| pin mailbox and pin node | `_mw.cfg.pin` = node key | `tools/pin.mjs --mailbox --files` | none |
| TURN | `_mw.cfg.turn` = `{ urls, mode: 'static' | 'endpoint' }` | `publish --turn ...` | off |
| age method | `_mw.cfg.age` = `none` / `<verifier key>` | `ledger-admin cfg --age none` | `none`: children defaults apply (MF-60) |

`tools/init` (R7 wizard) asks these in one pass and prints the commands. Every `_mw.cfg` value is advisory: honest loaders enforce it, and nothing security-relevant is stored there.

## 2.6 The encrypted visitor record and other sealed items

### 2.6.1 Where it lives (PR-1)

The vault at the IdO is the default home of the record (`mw.me` fields), contacts, file keys and history. A synced copy goes to the site ledger only when `_mw.cfg.records` is `sealed`, the person may write, and the person opts in.

### 2.6.2 Format (a value convention inside `append`; no new op)

```
list name  l = "mw.s"                                     // one neutral list for every sealed kind (PRIV m1)
value      v = { enc: 'mw-seal-v1', iv: <12 random bytes b64url>, ct: <b64url>, hint?: <4 bytes b64url> }
plaintext  P = binary: kind (1) | ver (4) | seq (2) | count (2) | len (2) | data (len) | zero padding to exactly 1,024 bytes
kinds      1 rec-index, 2 rec-data, 3 media-own, 4 grant, 5 join
key        self items (1, 2, 3): K_rec[r] or K_own;   grant and join (4, 5): sealed box to the recipient (2.7.4) with
           hint = HMAC(K_pair, "hint|" + day)[:4] so the recipient finds it without trial-decrypting every item
AAD        utf8("mw-seal-v1\n" + ledgerId + "\n" + authorPub)
```

- Size: ciphertext 1,040 bytes, 1,387 base64url characters; the value is about 1,450 bytes (ID 6.2, measured 1,446 by DS section 1 for the same shape), under `maxValueBytes` 2,048. Accounted ledger cost 1,877 bytes per item at one parent (DS section 1, measured).
- **IV:** 12 random bytes per seal, never a counter (two restored devices would repeat it; SEC minor).
- **Readers** take, per author, the newest effective items whose AEAD opens; at most 32 items per author count (SDK convention, MF-24); at most one synced update per hour per author (chosen).
- **Update:** append the new item, then tombstone the old one (own entries).
- **Capacity:** one index item plus up to 31 data items of 1,013 data bytes each holds about 31 KB of fields, about 280 contacts at 110 bytes each (arithmetic on UX M10's 110 bytes per contact); contacts and file keys are also in the vault and move with device hand-off.
- **Fields:** `display`, `contacts`, `files`, `notes` (off by default), `links`. Never email, phone, legal name, birth date, documents or health; `mw.me.set` rejects reserved names (PU rule 4).
- **Owner budget, stated in owner docs:** members x items x 1,877 bytes; for example 1,000 members with 4 items each use 7.5 MB, close to the 8 MiB default (arithmetic). The ledger capacity meter in owner tools shows it (DS F10).
- **Bans:** a ban drops every payload of the author, sealed items and an opt-in ledger `mw.ck` included, and an `unban` cannot restore dropped values; ID 6.3 and the unban card say so (SEC minor).

### 2.6.3 Who can read what

| Party | Public name | Sealed item | Vault |
|---|---|---|---|
| Other visitors, peers, trackers, relays, snapshot hosts | yes | ciphertext, fixed size, author, time | never sees it |
| Site owner reading the ledger or snapshots | yes | ciphertext only | never |
| Site code while the person is signed in | yes | plaintext after the per-session card (`mw.me.get` first use) for honest code; hostile code on the origin can read the record keys of this site | never (the vault is at the IdO) |
| The person on a restored device | yes | yes after a device link or backup file; **not** after a phrase-only restore (keys are random, PR-2) | after a device link or backup file |

## 2.7 Chat

### 2.7.1 Lanes and the wire budget

- `mw_chat1` is registered on the ledger rendezvous wires whose extended handshake advertises it (ARCHITECTURE 5.5, 6.6). The separate site chat lane `sha1(utf8("mw-chat1|" + ledgerId))` is joined only when fewer than 2 rendezvous neighbours speak `mw_chat1` (chosen; DS F8).
- Groups ride the chat lane addressed by group tag; a group's own swarm is joined only while its view is open, and its id is never announced to the public default trackers (MF-44): the rendezvous for a group lane uses the site's own signed tracker (`tr=`) or, without one, the chat lane only.
- **One wire budget per tab across every swarm:** desktop 40, phones 8 (chosen; G-SC-2 measures the ceiling). Priority when over budget: site > rendezvous > chat > open group > files. `mw_chat1`-only wires score below `mw_chain1` wires in B6 scoring.
- When the owner turns chat or files on, the site must name its own tracker and STUN servers; the public default four trackers and two STUN operators (PRIVACY.md register) are not used as a fallback for chat, groups or private media (PRIV M10).

### 2.7.2 Chat-key records (`CK`), off-ledger by default (N-5)

`CK = { v: 2, ledger, signer: <p256: signKey>, ek: <p256: chat pub>, epoch, exp, sig }` with `sig` = ECDSA by `signKey` over `"mw-chat-key-v2\n" + JCS(fields without sig)`. Carried in `mw_chat1` CK frames: sent once to each new neighbour for the keys it asks about, cached by every chat peer and by the pin mailbox until `exp` (90 days, chosen). A ledger copy `append('mw.ck', CK)` is opt-in with the card "Your chat key will be public and permanent in this site's ledger, so people can message you when nobody who has it is online." On rotation the new CK supersedes the old for new messages; old private halves stay in the vault until the person deletes them, and deleting one retires it (random keys, 2.2.2).

### 2.7.3 Frames

Binary. Every frame at most 16,384 bytes; the 262,144-byte wire guard applies first (`src/loader/torrent.js`).

**Clear header (14 bytes):** `type (1) | version (1) | hop (1) | flags (1: bit0 hold, bit1 stranger, bit2 pad-only) | day (2, UTC days since 1970 mod 65536) | stampNonce (8)`.
`frameId = SHA-256(type | version | flags | day | body)` (hop excluded, so relaying does not change it). **Relay stamp:** `leadingZeroBits(SHA-256("mw-relay-v1" | frameId | stampNonce)) >= bits`, checked in one hash by every relay and every recipient before anything else; `bits` = 10 for frames without the stranger flag (1,024 hashes on average, arithmetic) and the recipient's `chatBits` for stranger frames (default 20, about 1.05 million hashes, RT 5.6; time on phones G-CH-6). Frames whose `day` is not today or yesterday (UTC) are dropped.

| Type | Name | Body (bounded) | Relayed |
|---|---|---|---|
| 0x01 | HELLO | JSON at most 512 bytes `{ v, site, owner, lanes: [<= 4 names] }`; no identity | no |
| 0x02 | XX1, XX2, XX3 | Noise XX handshake messages (2.4.3), each at most 256 bytes | no |
| 0x03 | ENV | tag (8) | epk (65) | iv (12) | ct (a bucket + 16) | yes, hop at most 4 (chosen), interest-routed first |
| 0x04 | ROOM | `{ room (<= 32 chars), id (16 B), t, text (<= 2,000 chars), author, sig }` | yes, hop at most 3 (chosen) |
| 0x05 | WANT-TAGS | count (1, at most 32) | 1-byte tag prefixes (or full pair tags to a holder the visitor chose) | no |
| 0x06 | HELD | count (1) | ENV bodies, total at most the frame cap; once per tag per wire per minute | no |
| 0x07 | CK | one `CK` record, at most 400 bytes | no (cached, re-sent on request) |
| 0x08 | HOLDING | frameId (32) | expiry (4) | routed back toward the depositor as ENV-sized padding | as ENV |
| 0x09 | COLLECTED | frameId (32) | proof (32): `HMAC(K_pair, "collected|" + frameId)` or, for inbox mail, the inbox-key proof | to holders that hold it |
| 0x0A | PRES | fixed 8 slots x 8 bytes of blinded ids (real ones plus random padding) | status (1) | MAC or signature | no |
| 0x0B | SIG | sealed WebRTC offer, answer or candidate, as ENV, contacts only (2.7.8) | as ENV |
| 0x0C | INBOX-CHAL / 0x0D INBOX-RESP | holder challenge (32 random bytes) / `ECDH`-based proof of the inbox chat key | no |

Parser rules (MF-43): every field above has its stated maximum; an ENV whose `ct` length is not one of 272, 1,040, 4,112 or 16,016 bytes is malformed; unknown type or version, a stamp below `bits`, a malformed point, or a failed AEAD is a strike against that **wire** (not peer id); 20 strikes close the wire; decrypt attempts at most 50 per wire per second and 200 per tag per second globally (chosen). Budgets: relay of others' frames at most 64 KiB/s per neighbour on desktop with per-neighbour fair queues so one neighbour takes at most 1/k of the outbound budget; phones relay nothing (iOS never; Android only after "Share on this network", then 8 KiB/s and 2 MiB per session, chosen; HON m2). First relay of a frame waits a random 0.5 to 3 s and goes to a random half of eligible neighbours (chosen; STALK A3). Seen-set: 20,000 frameIds or 10 minutes, whichever comes first (chosen, DS F1).

### 2.7.4 Messages: the deniable sealed box (D-C6 resolved)

```
K_pair   = HKDF(ECDH(myChatKey, theirChatPub), salt = "", info = "mw-pair-v2|" + ledgerId + "|" + sorted(myChatPub, theirChatPub))
tag      = contacts:  HMAC(K_pair, "tag|" + day)[:8]
           strangers: SHA-256("mw-inbox-v2|" + ek + "|" + day)[:8]   (never sent in WANT-TAGS, 2.7.5)
mk       = HKDF(K_pair || ECDH(epk, theirChatPub), salt = tag, info = "mw-dm-v2|" + ledgerId)
ct       = AES-256-GCM(mk, iv, plaintext, AAD = "mw-dm-v2" || tag || epk)
plaintext (binary) = id (16) | t (8, ms) | n (4, per-conversation counter) | kind (1) | flags (1)
                     | [stranger: sender CK record, at most 400 bytes] | len (2) | body | zero padding
buckets  = 256, 1,024, 4,096, 16,000 bytes; ENV frame on the wire = 14 + 8 + 65 + 12 + bucket + 16
           = 371, 1,139, 4,211 or 16,115 bytes (arithmetic), under the 16,384-byte cap
```

- **Authentication without a signature.** Only the two parties can compute `K_pair`, so a frame that opens came from the other party (or from oneself); either party could have made it, so it proves nothing to a third party (MF-41). A stranger's first message carries the sender's signed `CK`, which binds the chat key to the sender's site key; the recipient learns who wrote it and still cannot prove it to others.
- **Replay and ordering (MF-36):** accept `t` in [now - 7 days - 5 min, now + 5 min]; per-sender high-water `t` and a 7-day Bloom filter of `id`s, sealed in the vault even when history is off (it holds no content); display by (`t`, `n`, `id`), with "Earlier messages may still arrive" when `n` has a gap; recipients ask for day - 1, day and day + 1.
- **Rooms (public):** ROOM frames are signed: `sig` = ECDSA by the author's site key over `"mw-room-v1\n" + ledgerId + "\n" + room + "\n" + id + "\n" + t + "\n" + SHA-256(text)`. Checks in order: author role and ban from the ledger, per-author token bucket (10 messages per 10 s, chosen), `|now - t| <= 5 min`, then the signature (SYB A7). Display by arrival, not claimed `t` (PEER B5). Label: "Public and signed. Anyone connected can read this, and a recording proves what you wrote."
- **Honest limits (2.16):** no forward secrecy and no post-compromise security for retained envelopes against someone who later obtains the recipient's chat private key; P-256 envelopes recorded now could be opened by a future break of P-256 (harvest now, decrypt later; PRIV m5); records use symmetric keys and are not affected.

### 2.7.5 Delivery, holders and the mailbox (MF-32, MF-33, MF-35, MF-46)

1. If the recipient is a neighbour (by the wire handshake), send on that wire. Otherwise send toward the neighbour through which a matching WANT-TAGS prefix or a HOLDING for this conversation last arrived; flood only when no route is known.
2. Contacts return a sealed ACK (an ENV of kind `ack`, padded like any message, sent after a random 2 to 20 s delay and batched; PRIV M3). Strangers get no ACK.
3. **Hold flag:** the sender sets `hold` only when no ACK arrived within 30 s (chosen) or the person chose "Deliver later". Holders store only flagged frames; a message delivered live is never held (E-CH-9).
4. **Holders** are opt-in desktops (and the pin mailbox). They hold only contact-tag mail; stranger mail is held only by the pin mailbox, which releases it only after an INBOX-CHAL / INBOX-RESP proof that the collector holds the chat key (PEER B4; STALK A1). Quotas: 7 days, 64 frames per tag, 4 MiB per holder (RT 5.7, chosen), at most 1/8 of the store from one neighbour, eviction from the largest source first and by stamp work, not by age (PEER B3, SYB A8). Holders delete on COLLECTED. A holder answers a WANT-TAGS prefix at most once per wire per minute.
5. **Recipients ask** by 1-byte tag prefixes (k-anonymity buckets) mixed with random decoy prefixes, through a neighbour other than their most-connected one when they have one (DS F13, PRIV M3). They never send the stranger inbox tag in clear to anyone (STALK A1).
6. **States (strings ship only after G-CH-1 and G-CH-3):** "Delivered" (ACK), "Handed to 3 peers at 14:02. They may go offline." (HOLDING; *amended in code review round 2, 2026-10-21:* "3 peers reported holding it at 14:02. They may go offline.", because HOLDING frames are not authenticated and the count is one per neighbour wire), "Will send when Bo is online while this page is open" (sender outbox retrying), "Sent to the network. You will not know if it arrived until they reply." (strangers), "Not delivered: nobody who can hold it is online."
7. **Hub mode default:** the hub pin mailbox is the offline-delivery path for social hubs, stated as a party that sees IP addresses, tags, sizes and times (2.16). Opt-in desktop holders stay available; the review does not expect many (SCALE M2).

### 2.7.6 Presence (D-C4 resolved)

Off by default. When on: one fixed-size PRES frame to direct neighbours every 30 s while visible (RT 5.1), carrying 8 slots of blinded ids (real contacts' `HMAC(K_pair, "pres|" + day)[:8]`, padded with random ids; PRIV m3), "away" on hidden, nothing from hidden tabs. Public presence adds the person's own id and is signed; its card says "Everyone who can reach you on this site will see which name is online, and from which address." The list is labelled **"Connected to you now"**, never "online" (DS F3): on a 50-peer lane with 6 wires a given online contact is a neighbour about 12 percent of the time (DS F3 arithmetic).

### 2.7.7 Groups (D-C7 resolved)

- Up to 32 members (chosen; invite fan-out is 32 sealed envelopes of 1,139 to 4,211 bytes, arithmetic).
- `epochId = SHA-256(prevEpochId | creatorPub | commit)`, where `commit = SHA-256(newSecret)`; the admin list `{ admins, by, sig }` is signed by the creator or an existing admin and checked on every rekey.
- Rekey on every add and every removal (newcomers read nothing from before they joined; SEC M7). Concurrent rekeys: the child with the lowest `epochId` wins; the losing admin re-applies their removal on top; members accept the union of removals; the UI shows "Two admins changed the group at once; the group now uses the newer key."
  - *Amended in code review round 2 (2026-10-21; `src/chat/groups.js`, chat-calls-media fix 1):* "the lowest `epochId` wins" let a removed admin grind `epochId` values until one sorted first. The resolution is now: removals win (a child whose creator any known epoch below its parent removed is refused, and a child stored earlier stops counting when a later sibling removes its creator); then the largest removal set; then `SHA-256(prev | creator)`, which the creator cannot grind; then `epochId`. A sibling is accepted only while its parent is current or within 7 days (chosen) of the parent's replacement, and a second genesis is refused.
- Members keep listening on the previous epoch's tag for 7 days (chosen) to receive the rekey invite; invites carry the `hold` flag; admins see "N members have not confirmed the new key".
- Messages: AEAD under `K_g = HKDF(groupSecret, info = "mw-grp-msg-v2|" + ledgerId + "|" + groupId + "|" + epochId)` with the sender's signature inside over `"mw-grp-msg-v2\n" + ledgerId + groupId + epochId + id + t + SHA-256(body)`. Inside a group the signature stops one member impersonating another; the card says "Members can prove to others what you wrote in this group." (a stated trade-off against deniability).
- The site owner cannot see or moderate private groups; members can report (2.17).

### 2.7.8 Direct channels and TURN (P2)

Opt in per conversation with "Connect directly (shows your IP address to this person)". SIG frames are accepted only from accepted contacts granted that permission in that conversation, at most one pending offer per contact; no `RTCPeerConnection` is created from an unaccepted offer; private, loopback and link-local candidates are dropped unless both chose "same local network" (PEER B6). TURN stays off by default (ARCHITECTURE 2 and 8 B7 are amended in the same change; HON m3). With static credentials (option a): low bit rate and session quotas, `allowed-peer-ip` deny lists for private ranges, credentials rotated per release, and a consent card naming the operator and saying the relay is open to anyone who loads the site (SYB A17). Option (b), a credential endpoint, is labelled a backend. The compose file ships with peer-address logging off and a stated retention (PRIV m6).

### 2.7.9 Mobile

Chat on a phone: send and receive own messages only; no relaying, holding or seeding by default; nothing from hidden tabs; leaving the page for more than 10 s pauses chat and transfers (ARCHITECTURE 8: the client is rebuilt after 10 s hidden on phones), and the UI says "Messages arrive while this page is open." iOS behaviour after backgrounding comes from forum posts and a WebKit bug (search snippets only, RT 9.3); the string is conditional on the primary-source check (RT 16 Q8).

## 2.8 Files

### 2.8.1 Lanes (D-C9 resolved)

| Lane | What | Ledger entry | Who can fetch | Default |
|---|---|---|---|---|
| F1 public | plaintext torrent, re-encoded images, listed | `mw.files` listing | anyone on the site | off; owner turns on (`_mw.cfg.files`) |
| F2 private | encrypted torrent (STREAM records) | none, or a sealed own-index item | anyone with the infohash gets ciphertext; only grant holders get the key | off; separate visitor opt-in (MF-60) |
| M private media | 2.9 | sealed own-index item, optional sealed grants | grant holders play it | off; separate visitor opt-in |
| F3 direct send | 16 KiB chunks over a direct channel | none | one recipient, both online | P2 |
| F4 owner pin | the pin node fetches and seeds a listed or shared file | unchanged | as the lane | moderator queue (2.8.6) |

### 2.8.2 Upload pipeline (all lanes)

1. **Sniff** the first bytes; the declared name and type are never trusted (MAL A5).
2. **Strip metadata.** Images (PNG, JPEG, GIF first frame, WebP, and HEIC where the browser decodes it) are re-encoded through a canvas to JPEG or WebP, which drops EXIF, ICC profiles and embedded thumbnails; the card says "Location and camera details removed". "Send original" exists only for private shares, with the warning "The original may contain your location". MP4 and MOV: location boxes (`udta`, `meta` entries such as `©xyz`, `loci`) are removed by box rewriting without re-encoding; WebM: `Tags` elements removed; if parsing fails, public upload is refused and private upload warns (STALK A8, UX M18).
3. **Name:** a random display name by default (`photo-7f3k.jpg`), the original optional (STALK A8).
4. **Encrypt** (F2, M) and **pad** to size buckets (2.9.5).
5. **Make the torrent** on the device (`client.seed`), with the piece length rules of 2.8.3, into the writable IndexedDB chunk store (MF-47). File torrents keep their stores across `rebuild()` (MF-45).

### 2.8.3 Metadata validation (MF-55)

A file torrent must have exactly one file, `length` equal to the listing or grant (and at most the lane's per-file cap, whatever `len` says), piece length between 16 KiB and 4 MiB, at most 16,384 pieces (chosen), no pad files, no path components, and a `.torrent` of at most 256 KiB. The fetch aborts on a mismatch, the listing is hidden, and only verified lengths count toward the per-site cap (DS F18). Public file fetches fail closed if the plaintext SHA-256 in the listing does not match (`E_FILE_HASH`), computed incrementally with the repo's `sha256-sync.js` in a worker (MAL A13, DS F11).

### 2.8.4 Seeding rules (MF-49, MF-45)

- Nothing is fetched until the person clicks "Fetch" on that row, which shows the name, size, sniffed type and "Fetching also shares it with others while this page is open" when sharing is on. Public listings never show thumbnails from peers.
- A fetched file is never re-seeded unless the person clicks "Help share this file" (off by default), whose card carries "Others can see your IP address next to this file."
- **Own uploads on phones:** a per-upload exception scoped to that infohash, with the card "Sending this file uses your mobile data. Keep this page open and on screen until it says sent." The state reads "Sent: one full copy reached Bo" only after a peer holds every piece. With a pin node or hub web seed, phone uploads go there first.
- Private ciphertext is shared only with peers in its private swarm, whose id only grant holders know (2.9.8).
- Leave a file torrent once the file is saved unless the person chose to keep sharing (DS F8).

### 2.8.5 Serving rule (a property of the route; MF-48)

- `GET /_mw/f/<ref>` (files) is routed before the navigation catch-all and answers only for a ref whose bytes are complete in IndexedDB, always with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded safe name>`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`, `Accept-Ranges: bytes`. It never consults the extension map (`src/sw/lib.js` `mimeFor`).
- `mw.files.fetch` returns a handle with a `ReadableStream` and Blobs re-typed `application/octet-stream`; SDK.md: "Never pass a Blob from mw.files to createObjectURL in a frame or a navigation." `mw.files.preview(ref)` is the only preview path: it runs in the loader, sniffs, accepts only PNG, JPEG, GIF (first frame), WebP and plain UTF-8 text, reads dimensions from the header and refuses previews above 24 megapixels (chosen; DS F17, PEER B10), decodes in a worker with `resizeWidth` and `resizeHeight`, and renders text through `textContent`. SVG, PDF and HTML never preview.
- Names: control and bidi characters stripped, NFC, the extension shown last and separately, and the sniffed type shown next to the claimed one (PEER B10).
- Risk tiers by magic bytes: executables, installers, scripts, macro documents and archives need a second confirmation, "This file could harm your device. felinar cannot check what it does." "Verified" means only "The bytes match what the sender listed. This does not mean the file is safe." (MAL A4). Owners may block a tier in `_mw.cfg.files`.
- Degraded mode (no worker) and drop-in pages without the route fall back to a Blob URL with `a[download]`, up to the class cap, after the same checks (DS F12). Tests: E-FI-3 (every extension through the route), E-FI-3b (the Blob path), E-FI-3c (limited mode).

### 2.8.6 Pin node and web seed (MF-50)

- Pin requests go to a moderator queue showing name, size, author key and declared hash only; pinning is a moderator action, never automatic; the pin node never opens or renders a file; `tools/pin.mjs --quarantine <ih>` moves a pinned file to an isolated folder, stops seeding and logs the action (MAL A3, A10).
- The pin node stores file torrents on disk (its profile directory), not in tab memory, so a restart keeps them (DS F16).
- **Web seed:** an optional `ws` field on listings and grants, filled when the owner copies the file (ciphertext for F2 and M) to static hosting with `tools/webseed-file.mjs`, served under the 2.8.5 headers at a path the site's own code cannot import. Without a pin on disk or a web seed, files have no durability, and RT 6.5 says so.

### 2.8.7 Takedown

A tombstone on a listing removes it from honest copies; in the same moderator step the loader writes `_deny/<b64url sha256(utf8(ih or sha256))>` (a hash of the identifier, so the ledger does not index the content), checked before any fetch or seed; the moderator UI flags a tombstone without a denylist entry; near-duplicates and re-encodings are not caught (that needs perceptual matching on whole bytes, only a host can run it; MAL A6). Private files and media are outside the owner's reach except by member reports (2.17).

### 2.8.8 Caps

| Limit | Desktop | Phone (any class) | Source |
|---|---|---|---|
| Public file, per file | 25 MiB | 25 MiB | RT 7 (chosen there) |
| Public files, per site, lifetime of listings | 256 MiB, counted from verified lengths | same | RT 7; SCALE m3 |
| Private file or media, per file | 100 MiB until the IndexedDB chunk store is measured, then per G-FI-5 | 25 MiB | RT 7; DS F11 |
| Files in the storage budget | at most 50 percent of what remains after the site and its ledger, LRU across files | same | DS F19 (chosen) |
| Active public listings per author | 20 | 20 | chosen (SYB A14) |

## 2.9 Private media (Ash, 2026-10-20 about 08:35 ET, binding)

**Goal.** A signed-in member uploads photos and videos that are encrypted before they enter the site's swarm and can be viewed only by the uploader after sign-in, or by members the uploader shares them with. The website plays them in the page, streamed from the swarm while they stay encrypted there. Playback keys never reach site code through the SDK: the site receives an origin URL valid for the session.

### 2.9.1 What it guarantees, and what it does not

| Guaranteed | Not guaranteed (stated in the cards and 2.16) |
|---|---|
| Peers, trackers, holders, the pin node, a web seed host and the site owner reading the ledger see only ciphertext, its padded size, timing and the IPs that fetch it | Code running on the site's origin while the person is signed in can obtain playback keys (shell frame is same-origin with the loader; drop-in pages are the loader's realm). No SDK method returns them; hostile code is still trusted for this site (2.1 rule 2) |
| Plaintext exists only in memory while playing; the chunk store holds ciphertext | A recipient can keep what was delivered, record the screen, or pass the key on |
| A recipient who never accepted a grant cannot decrypt | Revocation is best effort (2.9.7) |
| Location and camera metadata are removed from images and from MP4, MOV and WebM containers at upload | Faces, backgrounds and anything visible in the picture |
| Integrity: every chunk is authenticated (AES-GCM) independently of the torrent's SHA-1 piece hashes | Availability: the media plays only while some holder of the ciphertext is reachable (2.9.8) |

### 2.9.2 Formats

Native browser formats only: MP4 (H.264 video, AAC audio), WebM (VP9 or AV1 video, Opus or Vorbis audio), and JPEG, PNG, WebP and GIF images. iPhone HEVC or MOV videos are accepted as uploaded; the viewer's browser is checked with `HTMLMediaElement.canPlayType` and, if it cannot play the format, the item shows "This video format does not play in this browser. Download it instead." **There is no transcoding: converting video needs either a server (a backend) or in-browser encoding, and v0.3 offers neither.** In-browser encoding through WebCodecs is possible in principle; its time, battery cost and browser support are unmeasured, so it is not offered.

### 2.9.3 Upload pipeline

1. Sniff the bytes (2.8.2); refuse anything outside 2.9.2 with `E_MEDIA_TYPE`.
2. Strip metadata: images re-encoded (EXIF, ICC and thumbnails dropped); MP4 and MOV location boxes removed by box rewriting; WebM `Tags` removed. If stripping fails: `E_MEDIA_STRIP` with the choice "Upload anyway (may include your location)" for private media only.
3. **Faststart:** if an MP4's `moov` box sits after `mdat`, move it to the front by box rewriting (chunk offsets in `stco`/`co64` adjusted; no re-encoding), so playback can start without first fetching the end. If the rewrite fails, upload as is; playback then first fetches the last piece (one extra piece, 2.9.6).
4. **Poster or thumbnail**, made on the device: images are resized to at most 640 px on the longest side and re-encoded; videos are loaded into an off-screen `<video>` in the loader, seeked to the smaller of 1 s and a tenth of the duration, drawn to a canvas and encoded as JPEG or WebP. Duration, width and height are read from the container. The poster is encrypted into the same torrent (2.9.5); nothing about it is in the clear.
5. Encrypt, pad and make the torrent (2.9.5) into the IndexedDB chunk store, with progress reported per chunk.
6. Write the own-index item and seed (2.9.4, 2.9.8).

### 2.9.4 Keys

- Per item: `fid` = 16 random bytes; `fk` = 32 random bytes (AES-256-GCM); `base` = 8 random bytes (nonce prefix); `swarmNonce` = 16 random bytes placed in the info dictionary as `x-mw-nonce`, so the infohash cannot be predicted from the content (2.9.8).
- **Manifest** `M = { v: 1, fid, kind: 'video'|'image', mime, len, duration?, w, h, P, base, regions: { poster: [i0, i1], media: [i0, i1] }, total, ih, info?, ws?, name, t }` (name random by default).
- **Own copy:** a sealed own-index item (`mw.s`, kind 3, 2.6) containing `M` and `fk`, under the person's random `K_own` for this site's label. Sign-in on another device opens it after a device link or backup file (K_own lives in the vault). Where the person may not write to the ledger or chose not to, `M` and `fk` stay in the vault only.
- **Grant (share):** `G = { M, fk, from, to, exp? }` sealed to the recipient's chat key with the deniable sealed box (2.7.4), carried either in an ENV of kind `grant` (with `hold` when the recipient is offline; the default) or in a sealed ledger item (`mw.s`, kind 4, with the recipient hint) when the uploader chooses "Make sure they get it later" and may write.
- `fk` is never derived from the root; deleting it from every vault retires the item for everyone who did not keep it.

### 2.9.5 Chunked encryption aligned to torrent pieces

```
P (piece length)  = 262,144 bytes when the padded size is at least 2 MiB, else 65,536 bytes
C (chunk payload) = P - 16
chunk i plaintext = the i-th C bytes of the region (poster, then media), zero-filled at the end of a region
nonce_i           = base (8 bytes) || uint32_be(i)                           // unique per (fk, i); fk is random per file
AAD_i             = "mw-media-v1" || fid (16) || 0x01 (version) || uint32_be(i) || uint32_be(total) || region (1)
chunk i on disk   = AES-256-GCM(fk, nonce_i, plaintext_i, AAD_i)              // exactly P bytes = torrent piece i
padding chunks    = encryptions of zero chunks with region = pad, indistinguishable from data
total (pieces)    = the smallest bucket >= needed: at or above 2 MiB, 2^k x (1 + j/8) for j in 0..7, so padding
                    stays below 12.5 percent and every bucket is a whole number of 256 KiB pieces; below 2 MiB,
                    powers of two from 64 KiB (arithmetic)
```

- One torrent piece is exactly one chunk, so the loader verifies the piece's SHA-1 (WebTorrent) and the Service Worker decrypts it; AES-GCM authenticates every chunk on its own, so a SHA-1 collision attack gains nothing (SECURITY-MODEL notes SHA-1 for infohashes).
- `AAD` binds the file id, the version, the index, the total and the region, so chunks cannot be reordered, moved between files, truncated or extended without failing decryption (the STREAM property RT 6.3 cites, kept).
- **Worked example (arithmetic):** a 20 MiB MP4 (20,971,520 bytes) with a 48 KiB poster: 1 poster chunk + ceil(20,971,520 / 262,128) = 81 media chunks = 82 chunks, 21,495,808 bytes; the bucket is 2^24 x 1.375 = 23,068,672 bytes = 88 pieces (6 padding pieces); padding overhead 9.7 percent; piece hashes 88 x 20 = 1,760 bytes in the info dictionary.
- **Vectors:** `test/vectors/media.json` (append only): manifest, `fk`, `base`, three chunks, each region boundary, a padding chunk, and negative cases (swapped chunks, a truncated total, a chunk from another `fid`).

### 2.9.6 Playback through the Service Worker

```
site code                 loader (engine page)                    Service Worker                     swarm
mw.media.open(id) ----->  checks signed-in, opens own copy or
                          grant, gets fk and M; registers
                          { sid, fk, M } over its private port --> keeps sid -> { fk, M } in memory
<---- { url: '/_mw/media/<sid>', poster: '/_mw/media/<sid>?part=poster', mime, duration, w, h }
<video src=url> ---------------------------------------- GET Range: bytes=a-b --> maps a..b to chunks i0..i1
                          <-- need(i0..i1, priority) -------------
                          selects those pieces first ------------------------------------------------> pieces
                          piece verified (SHA-1), read from IDB
                          --> ciphertext chunk (transferred) ---> decrypts with fk, slices, streams
<---------------------------------------------------- 206 Partial Content, Content-Range: bytes a-b/len
```

- **Route:** `GET /_mw/media/<sid>` and `?part=poster`, routed before the navigation catch-all. `sid` is 128 random bits, valid until sign-out, the engine page closes, or 12 hours (chosen). Answers: `206` with `Content-Range` for a Range request (single ranges, open-ended and suffix ranges, including Safari's `bytes=0-1` media probe; a request for several ranges gets the full body as `200`, which is what the existing `parseRange` in `src/sw/lib.js` lines 139 to 167 does for site files), `200` streamed for no Range, `416` when unsatisfiable. Headers: `Content-Type` from the sniffed allow-list only, `Accept-Ranges: bytes`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: sandbox; default-src 'none'`.
- **Who can use the URL:** only pages of this origin that the Service Worker controls; a page on another origin that embeds the URL goes to the network and the host answers 404 (`/_mw/media/` exists only in the worker). `sid` is not the file id, so the URL is useless after the session.
- **Where the key lives:** `fk` is unwrapped in the loader and held by the Service Worker for the session; it is never returned through the SDK, never written to storage in the clear, and never sent to peers. When the browser stops an idle worker, the worker asks the loader to register the session again on the next request; if the engine page is gone the answer is `410` and the page shows "Open this again to keep watching." (Structured cloning of a non-extractable `CryptoKey` into a worker is assumed for the floor engines and is a lab row, G-MD-6; the fallback posts raw bytes over the private port.)
- **Seeking:** the browser asks a new Range; the worker maps it to chunk `i = floor((offset - regionStart) / C)` and the loader moves that piece to the front of the queue. **A seek costs one or two pieces (256 to 512 KiB) plus one AES-GCM decryption per piece.** At a phone uploader's opt-in rate of 128 KiB/s (ARCHITECTURE 8) that is 2 to 4 s; from a desktop seeder at 1 MiB/s, 0.25 to 0.5 s (arithmetic, transfer time only; connection setup and peer availability come on top and are unmeasured, G-MD-4).
- **Memory:** at most 4 decrypted chunks in flight per stream (1 MiB at P = 256 KiB, arithmetic, chosen), whatever the file size; the ciphertext sits in the IndexedDB chunk store, never assembled whole. On phones the per-file cap is 25 MiB (2.8.8) until G-MD-5 measures the chunk store on a phone.
- **Images:** the same route; `<img src>` needs no Range. Posters for grids use `?part=poster`, which fetches only the poster pieces.
- **Without a Service Worker** (degraded mode, ARCHITECTURE 7.4; a drop-in page whose worker is not active): the loader decrypts the whole item into a Blob and gives a `blob:` URL, only up to the class cap (25 MiB on phones), and the item says "Played from memory on this browser." In drop-in mode with an active worker the same route works (`src/dropin/swreg.js` registers the drop-in worker).
- **iOS Safari:** Playwright WebKit 27.2 on a desktop plays MP4 with Range responses from the worker (COMPATIBILITY line 96, e2e 1). iOS Safari's behaviour for media through a Service Worker with streamed 206 responses is **not verified**; rows G-MD-2 and G-MD-3 decide whether iOS uses the worker route or the Blob fallback by default.

### 2.9.7 Sharing, revocation, deletion

- **Share:** `mw.media.share(id, { to: [pub] | groupId })` makes one grant per recipient (2.9.4). The recipient sees an offer, never auto-accepted, even from contacts (MAL A8): "Ana shared a video with you (22 MB). Accept?" Only after accepting does the loader join the private swarm and fetch the poster.
- **Revoke (best effort):** `mw.media.revoke(id, { from: [pub] })` tombstones the sealed ledger grant if there is one and sends a sealed `revoke` to each named recipient; honest loaders delete the grant, `fk` and the cached chunks and stop seeding. `{ reencrypt: true }` also makes a new `fk`, `fid`, `base` and `swarmNonce`, re-encrypts and re-seeds (a full re-upload), grants the new item to the remaining recipients, and stops seeding the old torrent. Anyone who kept the old `fk` can still decrypt any old ciphertext they can find. Card: "People you shared with may have kept a copy. Revoking stops new viewing in honest apps only."
- **Delete:** stops seeding on this device, deletes local chunks, tombstones the own-index item, revokes every grant, and asks the pin node to drop its copy. Copies on other devices remain until those devices sync or the people delete them.

### 2.9.8 Where the ciphertext lives, and when the uploader is offline

- **Swarm:** the info dictionary carries `x-mw-nonce`, so the infohash is random and known only to grant holders; it is announced only to the site's own tracker (required when `_mw.cfg.media` is on) and is otherwise found over the chat lane by a sealed "who has" query to contacts. It is never announced to the public default trackers (MF-44).
- **Holders:** the uploader's devices while a page is open; recipients only if they turn on "Help keep this available to the people it is shared with" (off by default; the card carries the IP sentence); the owner's pin node when the uploader asks and a moderator accepts (2.8.6), storing ciphertext on disk as the durability tier; a static web seed of the ciphertext when the owner copies it (`ws`).
- **Uploader offline:** playback works while any holder of the ciphertext is reachable, else `E_FILE_UNAVAILABLE` with "Nobody who has this video is online right now." The item shows "Kept by the site" when pinned and "Available only while someone who has it is online" otherwise (SCALE M1).

### 2.9.9 What each party sees

| Party | Sees | Never sees |
|---|---|---|
| Peers in the private swarm | the random infohash, padded total size, piece hashes, which pieces you ask for and when (so roughly where you seek), your IP | content, poster, name, type, duration, who else has the key |
| Site's tracker | the random infohash, IPs announcing it and when (an edge between the uploader's and the recipients' addresses) | content or anything inside the grant |
| Public default trackers, STUN | nothing about private media (not announced there); STUN sees that a WebRTC session starts | |
| Pin node, web seed host | ciphertext, padded size, IPs and times of fetches | content |
| Site owner (ledger) | that an author wrote a sealed item at a time; its fixed size | which kind, the recipient (hint is pairwise) |
| Site owner (code) | while you are signed in, whatever the site's code chooses to take on this origin, including playback keys | other sites |
| Other members | nothing unless granted | |
| Recipients | the media, its poster and manifest; your key | other recipients (each grant is separate) |
| Network observer | connections to peers, the tracker and STUN, volumes and timing | content |

### 2.9.10 Ledger ops used

No new op. `append('mw.s', sealed)` for own-index items (kind 3) and durable grants (kind 4) (2.6); `tombstone(h)` for deletes and ledger revokes; moderator `put('_deny/<hash>', ...)` for takedown of reported media by the hash of its infohash (2.8.7). Private media never appears in `mw.files`.

### 2.9.11 SDK: `mw.media`

```
mw.media.upload(file, { onProgress?, signal?, keepOriginal?: false }) -> { id, kind, mime, len, duration?, w, h }
    UI: opens the upload card (metadata removal result, size, who can see it). Progress { phase: 'strip'|'poster'|'encrypt'|'seed', done, total }.
    Errors: E_NOT_SIGNED_IN, E_POLICY (_mw.cfg.media off), E_HOST_ONLY, E_MEDIA_TYPE, E_MEDIA_STRIP, E_LIMIT, E_USER_CANCELLED, E_POW_ABORTED
mw.media.list({ from: 'mine' | 'received' | 'all' = 'all' }) -> [{ id, kind, mime, len, duration?, w, h, from, t, available: 'kept'|'online'|'unknown' }]
mw.media.open(id, { part?: 'media' | 'poster' }) -> { url, mime, duration?, w, h }      // url is /_mw/media/<sid>, valid for the session
    Errors: E_NOT_SIGNED_IN, E_DECRYPT, E_REVOKED, E_FILE_UNAVAILABLE, E_MEDIA_UNPLAYABLE (canPlayType says no), E_LIMIT (Blob fallback over the cap)
mw.media.close(id)                                   // ends the sid early
mw.media.share(id, { to: [pub] | groupId, durable?: false }) -> { granted: [pub], held: [pub] }
    UI: card names each recipient by name and short id. Errors: E_NO_CHAT_KEY, E_BLOCKED, E_POLICY, E_USER_CANCELLED
mw.media.revoke(id, { from?: [pub], reencrypt?: false }) -> { revoked: [pub], reencrypted: boolean }    UI
mw.media.delete(id) -> { deleted: true }             UI
mw.media.keepAvailable(id, on) -> { on }             UI (seeding opt-in, IP sentence)
mw.media.pinRequest(id) -> { requested }             only if the owner runs a pin node
mw.media.on('progress' | 'received' | 'shared' | 'revoked' | 'unavailable', fn) -> unsubscribe
```

### 2.9.12 Caps and costs by device class

| | Desktop | Android Chrome | iOS Safari | Source |
|---|---|---|---|---|
| Per item | 100 MiB (until G-MD-5) | 25 MiB | 25 MiB | 2.8.8 |
| Memory while playing | about 1 MiB of decrypted chunks per stream plus the page | same | same | arithmetic, chosen in-flight count |
| Seek cost | 1 to 2 pieces; 0.25 to 0.5 s from a 1 MiB/s seeder | 2 to 4 s from a 128 KiB/s phone seeder | same | arithmetic on ARCHITECTURE 8 rates |
| Upload from this device | while the page is open | per-upload exception card (MF-45) | same; leaving for more than 10 s pauses | ARCHITECTURE 8 |
| Plays via | worker route | worker route | worker route or Blob fallback per G-MD-2 | 2.9.6 |

## 2.10 Ledger ops, lists and reserved names (exact)

### 2.10.1 Ops

| Op | Class | Fields in `e.op` | Valid from | Caps | Status |
|---|---|---|---|---|---|
| `put` | payload | `k` (at most 256 bytes), `vh` | writers under the policy; `_` keys owner and moderators only; `@<authorhash>/` keys only their author (freeze group) | `maxValueBytes` 2,048 | v1 |
| `append` | payload | `l` (at most 64 bytes), `vh` | writers | same | v1 |
| `profile` | payload | `vh` (value: name, at most 48 characters) | writers | same | v1 |
| `policy` | control | `writers`, `bits`, `maxValueBytes`, `maxChainBytes`, `moderators`, `allow`, and (freeze group) `modAllowPerDay`, `modActionsPerHour`, `reservedPool`, `voided` | owner standing (personal sites: the person's key through the IdO card) | `maxChainBytes` at most 64 MiB, moderators at most 50, allow at most 1,000 | v1, fields extended by the freeze group |
| `owner` | control | `next` | owner standing | | v1 |
| `tombstone` | control | `h`; or (freeze group) `authors` (at most 64) and `before` | target's author, a moderator in effect (not on owner-standing targets, freeze group), or the owner | `modActionsPerHour` | v1, bulk form in the freeze group |
| `ban` | control | `author`, `until?` (freeze group) | moderator in effect or owner | `modActionsPerHour` | v1, `until` in the freeze group |
| `allow` | control | `add`, `remove` | owner; moderators add only, at most `modAllowPerDay` (freeze group) | 1,000 entries | v1, moderator form in the freeze group |
| `unban` | control | `author` | 2.5.3 | `modActionsPerHour` | freeze group |
| `keyinfo` | control | `rc` | the key itself, if it may write | first per author counts | freeze group |
| `rotate` | control | `from`, `next`, `by`, `rp?`, `rsig?` | 2.5.3 | | freeze group |
| `checkpoint` | control | `heads`, `snap`, `n`, `bytes` | owner standing | at most 32 heads | freeze group (defines the reserved name) |
| `vanish`, `grp` | | | | | reserved, undefined; `unknown-op` |

**Unknown-op rule (unchanged):** an `op.t` the running version does not define, reserved names included, makes the block invalid (`unknown-op`): rejected at ingest, never stored or relayed, counted as an invalid block from that peer (ARCHITECTURE 6.1). The freeze-group release adds `unban`, `keyinfo`, `rotate` and `checkpoint` as v1 ops before any public ledger exists; a block version bump is needed for anything after that.

### 2.10.2 List and key conventions (state or SDK rules, never validity)

An item on a `mw.*` list or a `_mw.*` key that does not match its schema is hidden and has no effect; its block stays valid, stored and relayed (MF-21). Bare names (`dm`, `chat`, `pres`) are not reserved; honest clients never write conversation to the ledger.

| Name | Kind | Schema | Written by | Notes |
|---|---|---|---|---|
| `mw.s` | list | `{ enc: 'mw-seal-v1', iv, ct, hint? }`, value about 1,450 bytes | any writer | sealed items (2.6); at most 32 effective per author; one synced update per hour |
| `mw.files` | list | `{ ih (40 hex), len, name (at most 96), mime (sniffed), sha256?, ws?, t }` | writers when `_mw.cfg.files` is on | public files; premoderated for new keys (2.17) |
| `mw.ck` | list | a `CK` record (2.7.2) | the key's owner, opt-in | public and permanent |
| `mw.link` | list | `{ from, to, t, sigTo }`, `sigTo` over `"mw-link-v1\n" + ledgerId + from + to + t` | the legacy key (migration) | public on this site only |
| `mw.post`, `mw.c`, `mw.re`, `mw.q`, `mw.f`, `mw.b`, `mw.n`, `mw.prof` | lists | Part 3.5 | per Part 3 | the social template |
| `mw.rep` | list | never used: reports travel sealed to moderators (2.17) | | listed so no site uses it for reports |
| `_mw.cfg` | key | object of 2.5.5 | owner, moderators | advisory, shows who set it |
| `_deny/<b64url sha256>` | key | `{ by, t, reason: 'P0'|'illegal'|'malware'|'spam'|'other', ref? }` | moderators, owner | checked before fetch or seed (2.8.7) |
| `_roles/<22 chars>` | key | `{ role, label, t }` | moderators, owner | display only (D-8) |
| `@<16 chars>/<name>` | key | per application | only the author whose key hash matches | author-scoped `put` (freeze group) |

### 2.10.3 Signing and AAD prefixes (all distinct, all followed by a newline or a separator)

`mw-block-v1`, `mw-vh-v1`, `mw-pointer-v1`, `mw-signin-v1`, `mw-local-v1`, `mw-chat-key-v2`, `mw-room-v1`, `mw-grp-msg-v2`, `mw-rotate-v1`, `mw-link-v1`, `mw-report-v1`, `mw-relay-v1` (stamp), `mw-seal-v1` (AAD), `mw-media-v1` (AAD), `mw-dm-v2` (AAD), `mw-pair-v2`, `mw-idp-bundle-v1`, `mw-idp-prf-v1`, `mw-idp-wrap-v1`, `mw-link-v2` (device link), `mw-wire-v1` (handshake prologue), `mw-check-v1`. A new purpose gets a new prefix; a prefix is never reused for another purpose (ID 3.2). The build added prefixes that this list does not name; ARCHITECTURE 15.12 lists them.

## 2.11 SDK surface (amends ARCHITECTURE 9 and INTERFACES `api.js`, `bridge.js`, `sdk.js`, `src/dropin/binding.js`)

### 2.11.1 The A4 rule, v0.3

Site code can never: export or read a private key, a seed, the root, the phrase, a file or playback key, or the vault; grant consent (`consent.accept` stays loader-only); accept a "same identity" link or preselect it; choose `domain`, `origin`, `ledger` or `keyMode` of a sign-in proof; open a high-risk card without transient activation; read another origin's identity. These methods do not exist in the SDK; over the Bridge they are unknown methods (`E_BAD_REQUEST`). `LOADER_ONLY_METHODS` = `identity.export`, `identity.import`, `identity.root`, `consent.accept`, `link.accept`, `keys.export`, `media.key`. Activation: UI methods must be called from a click in the site frame; the loader's own prompt (or the IdO window) then takes the person's `isTrusted` input; a site-supplied "activation" flag proves nothing and is ignored (HON M3).

### 2.11.2 Methods

```
mw.ready() -> { siteId, btih, mode, auth: 'guest'|'signed-in', identity: { pub, short, name, mode } | null, role, peers, height,
                owner, unmoderated, features: { chat, files, media, records, requests } }

mw.auth.signIn({ scope?: string[], stay?: false }) -> { state: 'signed-in', identity, role }           UI
     opens the IdO popup (2.3). Errors: E_USER_CANCELLED, E_POPUP_BLOCKED (call from a click), E_HOST_ONLY_IDENTITY
     (shared-origin hub: this visit only), E_UNSUPPORTED (no WebCrypto P-256), E_IDP_UNREACHABLE, E_RATE (10 s cooldown)
mw.auth.signOut({ forget?: false }) -> { state: 'guest' }                                              UI when forget: true
mw.auth.state() -> 'guest' | 'signed-in'                                                                read
mw.auth.onChange(fn) -> unsubscribe                                                                     fn({ state, identity, role })
mw.auth.prove({ ttlMs?: 900000 }) -> localProof                                                         write; in-tab only, at most 15 min
mw.auth.verify(proof) -> { ok, pub, role, exp, kind } | { ok: false, reason }                          read; local proofs of this tab and epoch only
mw.auth.signInServer({ challenge: { nonce, statement, exp?, nbf?, resources? } }) -> mw-signin-v1 proof UI (IdO card every time)

mw.identity.current() -> { pub, short, name, mode, did } | null                                         read
mw.identity.setName(name) -> { h }                                                                     write, signed-in
mw.identity.backupStatus() -> { kitSaved, fileSaved, passkey, persisted, legacy }                      read (reported by the IdO at sign-in)
mw.identity.openIdentity() -> 'done' | 'cancelled'                                                     UI: opens the IdO settings window

mw.me.get(field?) -> value | object        UI on first call per session (card), read afterwards; E_NEEDS_GESTURE without activation
mw.me.set(field, value) -> { stored: 'local'|'synced', h? }   write; E_LIMIT (over the item budget), E_FIELD (reserved name)
mw.me.del(field) -> { stored }                                  write
mw.me.sync({ on }) -> { on }                                    UI; E_POLICY when _mw.cfg.records is off or the person may not write
mw.me.erase() -> { tombstoned, shredded: true }                 UI (2.15)

mw.db.get / set / del / list / append / tombstone / subscribe    unchanged (ARCHITECTURE 9); set and del reject keys of another author's @ space (E_POLICY)
mw.db.setMine(name, value) / getMine(name) / listBy(name, author) helpers for @-scoped keys
mw.mod.ban(pub, { until? }) / unban(pub) / tombstoneMany(authors, { before })                         UI (moderator card, MF-27)
mw.mod.queue() -> [{ kind: 'pin'|'report'|'join'|'listing', ... }]                                    read, moderators
mw.mod.decide(id, 'accept'|'decline'|'deny', { reason })                                              UI

mw.chat.enable() / disable() / state()                                   enable is UI; E_HOST_ONLY, E_POLICY, E_NO_OWN_TRACKER
mw.chat.presence.set({ on, public?: false })                             UI for public
mw.chat.presence.list() -> [{ pub?, status, since }]                     "Connected to you now"
mw.chat.contacts.list() / add(pub, { nick }) / remove(pub) / block(pub) / unblock(pub) / verify(pub) -> { code }   list is UI-gated per session (card), like me.get (HON m7)
mw.chat.requests.list() / accept(id) / decline(id) / setOpen(bool)      setOpen is UI
mw.chat.dm.send(pub, { text } | { grant }) -> { id, state }              state: 'delivered'|'handed'|'outbox'|'sent-unknown'|'not-delivered'
     Errors: E_NO_CHAT_KEY, E_SYNCING (ledger still catching up, DS F20), E_BLOCKED, E_LIMIT, E_STAMP, E_RATE
mw.chat.dm.history(pub, { limit, before }) / keepHistory(pub, bool)      history is UI-gated per session
mw.chat.room.join(name = 'Lobby') / leave(name) / send(name, { text })  E_POLICY, E_BANNED
mw.chat.group.create({ name, members }) / invite / remove / leave / send   E_LIMIT (32), E_NOT_MEMBER, E_NOT_ADMIN
mw.chat.holder.set(bool)                                                 UI; refused on phones
mw.chat.direct.connect(pub)                                              UI (P2); E_PEER_UNREACHABLE, E_NOT_CONTACT
mw.chat.on('message'|'delivery'|'request'|'presence'|'room'|'group'|'state'|'keychange', fn)

mw.files.enable() / list() / received()
mw.files.share(file, { public?: false, to?, name? }) -> { ref, ih, listed }   UI; E_LIMIT, E_POLICY, E_MEDIA_STRIP
mw.files.fetch(ref, { onProgress, signal }) -> { handle, stream(), blob() }   blob() is application/octet-stream; E_FILE_UNAVAILABLE, E_FILE_TOMBSTONED, E_FILE_HASH, E_DECRYPT, E_DENIED
mw.files.preview(ref) -> { kind: 'image'|'text'|'none', url? }           the only render path (2.8.5)
mw.files.save(ref)                                                       UI; download through /_mw/f/
mw.files.keepSharing(ref, on) / stopSharing(ref) / remove(ref) / pinRequest(ref)
mw.files.on('progress'|'shared'|'received'|'removed', fn)

mw.media.*                                                               2.9.11

mw.report.send({ target: { h } | { envelope } | { media: id } | { key }, reason, note? }) -> { sent }   UI; metadata only (2.17)
mw.net.*, mw.site.*, mw.consent.request() / state()                      unchanged
```

**Push events added:** `auth`, `chat`, `files`, `media`, `mod`, `keychange`. **Error codes added:** `E_NOT_SIGNED_IN`, `E_USER_CANCELLED`, `E_UNSUPPORTED`, `E_FIELD`, `E_DECRYPT`, `E_HOST_ONLY_IDENTITY`, `E_POPUP_BLOCKED`, `E_IDP_UNREACHABLE`, `E_NEEDS_GESTURE`, `E_NONCE_REQUIRED`, `E_LEDGER_FULL`, `E_SYNCING`, `E_HOST_ONLY`, `E_NO_OWN_TRACKER`, `E_NO_CHAT_KEY`, `E_BLOCKED`, `E_STAMP`, `E_NOT_MEMBER`, `E_NOT_ADMIN`, `E_NOT_CONTACT`, `E_PEER_UNREACHABLE`, `E_FILE_UNAVAILABLE`, `E_FILE_TOMBSTONED`, `E_FILE_HASH`, `E_DENIED`, `E_MEDIA_TYPE`, `E_MEDIA_STRIP`, `E_MEDIA_UNPLAYABLE`, `E_REVOKED`. `SDK_VERSION = '0.3.0'`. Every code has an English and a French string in `strings.js` (UX M22), for example `E_NO_CHAT_KEY`: "Bo has not turned on messages on this site."; `E_FILE_UNAVAILABLE`: "Nobody who has this file is online right now."; storage evicted: "This browser deleted your sign-in for this site. Tap Sign in to get it back."

## 2.12 Key storage per browser

| Item | Where | Chromium desktop | Android Chrome | Safari macOS | iOS Safari | iOS Home Screen | Firefox | Notes |
|---|---|---|---|---|---|---|---|---|
| Wrapped root and wrapped vault | IdO IndexedDB | persistent | persistent | ITP: deleted after 7 days of Safari use without interaction with the IdO | same | exempt from the 7-day rule (webkit.org/tracking-prevention, ID 3.5) | persistent | escrow copies on site origins (2.2.5) |
| Working keys of a label | site origin memory; IndexedDB as non-extractable CryptoKeys only with "Stay signed in" | yes | untested | lab (w2c-03) | reported `DataCloneError` failures (IDV claim 3): memory only, re-fetched from the IdO with one tap | same as iOS Safari until G-ID-1 | untested | the self-test at import (put, get, sign, verify, ECDH) picks the path |
| Escrow blobs | site origin IndexedDB | yes | yes | ITP | ITP | exempt | yes | opaque |
| `K_local` caches (history if kept, seen-set, contacts cache) | site origin IndexedDB, sealed under `K_local` from the bundle | yes | yes | ITP | ITP | exempt | yes | |
| Playback keys | Service Worker memory | yes | untested | lab | untested (G-MD-6) | untested | untested | raw-bytes fallback |
| File and media chunks | site origin IndexedDB (ciphertext for private) | yes | yes | ITP | ITP | exempt | yes | inside the storage budget (2.8.8) |
| Passkey | the platform or password manager | yes | Google Password Manager | iCloud Keychain | iCloud Keychain | same | provider | the provider is a recipient (2.14) |

Firefox private windows and Tor Browser storage behaviour is untested here; both default to "this visit only" when IndexedDB is unavailable. Tor Browser does not run WebRTC (RT 9.2, to be confirmed from a primary source per RT 16 Q8), so it can sign in and read but cannot chat or fetch from peers.

## 2.13 Compatibility matrix with fallbacks

"Lab" = verified in the w2c-03 lab (Playwright Chromium 156, WebKit 27.2). "MDN BCD" figures are as the honesty judge cited them (HON M3), not re-fetched in this review; the A8 gate agent confirms them before docs quote them. Floor = Safari and iOS 15.4, Chromium 110, Firefox 115 (INTERFACES header).

| Capability | At the floor | Current Chromium | Current WebKit | Firefox | Fallback |
|---|---|---|---|---|---|
| WebCrypto ECDSA and ECDH P-256, HKDF, AES-GCM | expected, untested | lab | lab | untested (did not launch) | `E_UNSUPPORTED`; read-only |
| JWK `{d, x, y}` import non-extractable | untested | lab | lab | untested | memory-only working keys |
| Top-level popup with `opener` postMessage | untested | untested | untested | untested | redirect round trip (2.3.1); G-ID-7 |
| Third-party iframe storage | partitioned per top-level site in current engines (PRIV B2, vendor documentation, not re-checked) | | | | the reason the IdO is a top-level window, never a frame |
| Passkey PRF | absent at the floor | lab (`getClientCapabilities` prf true) | flag only (`getClientCapabilities` read; no WebKit virtual authenticator) | 139+ on macOS (R3 F3) | IdO passphrase, then this visit only |
| `getClientCapabilities` | absent (Chrome 133, Safari 17.4, Firefox 135, MDN BCD) | yes | yes | 135+ | detect PRF from `getClientExtensionResults().prf.enabled` after `create()` |
| WebAuthn `largeBlob` | untested | untested | untested | untested | escrow blobs (2.2.5) |
| Related Origin Requests | absent (Chrome 128, Safari 18, MDN BCD) | yes | yes | treat as no | not needed: one RP ID at the IdO |
| `'wasm-unsafe-eval'` | absent below Safari 16 (MDN BCD) | yes | 16+ | yes | PBKDF2 at the IdO, named on the card |
| `navigator.userActivation` | Safari 16.4, Firefox 120 (MDN BCD) | yes | yes | 120+ | the IdO's own button; no forwarded activation |
| Camera QR scan (BarcodeDetector) | absent in Safari and Firefox (MDN BCD) | yes | no | no | bundled JS decoder (gzip size stated in the bundle budget, UX m3); camera-denied string; typed code as last resort |
| Service Worker streamed 206 for media | untested | untested | desktop lab plays MP4 with Range from the worker (COMPATIBILITY line 96, e2e 1) | untested | Blob fallback up to the class cap |
| Canvas re-encode (`toBlob` JPEG) | expected | yes | yes | yes | refuse public upload of that image |
| `createImageBitmap` with resize options | untested | yes | untested | untested | decode through an `<img>` in a worker-free path with the pixel cap |
| WebRTC | yes | yes | yes | yes | Tor Browser: none (stated) |

Every untested cell is a gate row (Part 4) or a forced-fallback test that deletes the feature locally (HON M11).

## 2.14 Consent and privacy texts

### 2.14.1 Card copy (English; French in `strings.js`; counsel review before release)

| Card | Text |
|---|---|
| Sign in (IdO) | "Sign in to <origin>. This site gets a key that works only here. It cannot see your other sites. Code on this site can act as you here while you are signed in." |
| Passkey | "Your passkey may be saved by your password manager (for example iCloud Keychain or Google Password Manager), which then knows you have a felinar identity at <IdO>. Your identity itself stays on your devices." |
| What others can see (merged into sign-in) | "People connected to this site see your IP address next to the key you use here when you post or chat. Signing in sends nothing to an identity company." |
| 12 words | "These 12 words open every site you use with felinar. felinar never asks for them on a website. Type them only at <IdO>." |
| Recovery kit (iOS) | "Safari deletes this site's data after 7 days without a visit unless you add it to your Home Screen. Save your recovery kit now." |
| Same identity | "<origin A> and <origin B> will both know this is you. This cannot be undone once this site has seen it." |
| Hub identity | "Everyone on <hub> will see one identity for you. Other sites still cannot match you." |
| Stay signed in | "Anyone who uses this browser can act as you on this site until you sign out." |
| Turn on chat | "Chat connects your browser to other visitors of this site through <tracker host> and <STUN host>. They see your IP address and when you are active. Messages are encrypted between you and the people you write to. The site's own code can read your messages while this page is open. Anyone you write to can keep what you send." |
| Presence (public) | "Everyone who can reach you on this site will see which name is online, and from which address." |
| Hold messages for others | "You will store encrypted messages from other people that you cannot read, for up to 7 days, and the people who leave and collect them will see your IP address." |
| Message requests | "Strangers can send you a first message. You will not see it until you open your requests." (off by default) |
| Rooms | "Public and signed. Anyone connected can read this, and a recording proves what you wrote." |
| Groups | "Members can keep and forward anything sent here, and can prove to others what you wrote in this group." |
| Public upload | "This file will be public on this site. Location and camera details were removed. People who fetch it will see your IP address while you share it." |
| Private file or media | "Encrypted before it leaves this device. Only you, after signing in, and the people you share it with can open it. The site's own code can open it while you are signed in. People you share with can keep a copy." |
| Fetch a public file | "Fetching also shares it with others while this page is open, and they see your IP address next to it." (only when sharing is on) |
| Help share | "You will distribute this file to other visitors. Others can see your IP address next to it." |
| Direct connection | "Connect directly (shows your IP address to this person)." |
| TURN relay | "Your connection goes through <operator>'s relay, which sees both addresses and how much you send, never the content. The relay is open to anyone who loads this site." |
| Chat key in the ledger | "Your chat key will be public and permanent in this site's ledger, so people can message you when nobody who has it is online." |
| Sync private record | "An encrypted copy goes into this site's ledger, which every visitor copies. Nobody without your keys can read it. Copies kept by others stay even after you remove it." |
| Remove my private data here | "This hides your encrypted record from copies that sync and destroys the key for this site, so remaining copies can no longer be opened by you or anyone who later gets your 12 words." |
| Replace my keys on all sites | "Each site gets a new key for you, and people who know your old key see that it changed." |

### 2.14.2 Sentences replaced (PRIV M11, SEC M14, HON M8)

| Old | New |
|---|---|
| "Sites cannot match a visitor by key" | "Sites cannot match you by key unless you choose to be recognised. They can still match you by IP address, a reused name or timing." |
| "Nobody else can decrypt, including the owner reading the ledger" | "Other visitors and anyone holding a copy of the ledger see only ciphertext. The site's own code can read your record while you are signed in." |
| "Only you can read this" (profile) | "Encrypted. The site can read it while you are signed in." |
| "Nothing is sent anywhere." | the passkey sentence above |
| "Everything conversational is ephemeral in the swarm." | "Conversations are never written to the site ledger. Anyone connected can record the encrypted copies." |
| "Holders learn tag, size and arrival time, never sender or recipient" | "Holders can link the address that left a message to the address that collected it." |
| "IP and an opaque id for groups" (tracker) | "Private groups are not announced to the public trackers; the site's own tracker sees the addresses of members who join." |
| "Your IP only if they are your neighbour" | "Your IP address, unless the site is busy enough that you are not connected to them directly." |
| "Nobody sees you as online unless you turn presence on." | "Nobody sees your name as online unless you turn presence on. People connected to you can see that your address is on this site's chat." |
| "Blinded public presence" | "Public presence shows your key." |
| "Signing in tells no company that you signed in." | "Signing in sends nothing to an identity company. Your passkey provider, if you use one, stores a passkey for the identity page." |
| "Non-extractable: a script cannot copy the key" | "Code on a site you are signed in to can copy your keys for that site." |
| "Uploaded content never executes at the site origin" | "The loader never renders uploaded files at the site's address; site code that renders a file itself is responsible for it." |
| "Owner cannot read private lanes" | "The owner cannot read them from the ledger or the swarm; the owner can read them through the code visitors run." |

### 2.14.3 PRIVACY.md and notice-template additions (PRIV M12; before any v0.3 feature ships)

- **Recipients register:** the identity origin's operator (IP and time of popup loads and update checks); the passkey provider (one credential for the IdO, created when the person chooses a passkey); server-backed relying parties (key, nonce, time, IP at each sign-in); the site's tracker and STUN for chat and files; the hub tracker, pin mailbox and pin node (IPs, tags, sizes, times; ciphertext of held and pinned items); the owner's TURN relay (IP pairs, bytes, times; stated retention); external age verifiers if an owner adds one (yes/no attestation only).
- **What stays on the device:** the wrapped root and vault (IdO); working keys if "stay signed in"; escrow blobs; other people's encrypted envelopes held for up to 7 days and 4 MiB; ciphertext pieces of others' files while helping share; chat key private halves per epoch; each with how to remove it.
- **Retention:** sealed items and chat-key ledger copies until removed, stubs until an owner checkpoint; allow and ban entries in the current state until removed or expired; held envelopes 7 days; local history until deleted.
- **Who is responsible:** the owner as controller for chat lanes, holders' storage purpose, the pin mailbox, pin node and TURN; joint controllership with a hub where the hub runs them (R6 F3); visitors who hold envelopes or help share files are not "just relaying" (R6 P0 6).
- **Public by design:** membership lists, bans, public listings, opt-in chat-key records, sealed-item metadata (author, time, fixed size).
- **Your rights:** what removal reaches (honest copies that sync, after a checkpoint for stubs) and what it cannot (copies on devices that never sync, things recipients kept), and that a removed record key cannot be recovered.
- **Transfers:** peers anywhere in the world receive IP addresses, keys, sealed items and chat frames; the DPIA and PIA templates gain a GDPR and UK GDPR Chapter V and Law 25 s. 17 section for counsel (PRIV M6).

## 2.15 Erasure

| Action | Effect on this device | Effect on the ledger and peers | Limits stated in the card |
|---|---|---|---|
| Sign out | working keys deleted | none | |
| Remove from this device | working keys, escrow blobs, caches, chunks deleted | none | |
| Remove my private data on this site (`mw.me.erase`) | caches deleted | tombstones every sealed item by this author on this ledger; the IdO deletes `K_rec` and `K_own` for this label from the vault | "copies kept by peers that never sync stay, and nobody can open them any more" (the key is gone; PR-2) |
| Leave this site | as above plus local media and files | additionally tombstones every payload this key wrote, sets the profile to empty, stops seeding, revokes grants | signed public posts remain as stubs `{ e, h, s }` until the owner's next `checkpoint` |
| Owner `checkpoint` | | honest copies that apply it drop every earlier block and stub | copies on devices that never sync, and software that ignores checkpoints |
| Delete my identity (IdO, per device) | the IdO wipes the root and vault on this device | none by itself; "Replace my keys on all sites" first, if wanted | other devices and the 12 words still restore the public identities; destroying every copy of the phrase and the backup file is the only full shredding |

User copy says "hide from copies that sync" and "remove", never "erase" or "delete everywhere" (ID 10; R3 F20).

## 2.16 Threat model and residual exposure

### 2.16.1 Trust assumptions (what the design rests on)

1. **The identity origin's served code** is trusted with every root that is unlocked there. It is a static bundle with a published hash, reproducible builds, signed releases and a build id on every card; a person who wants no third party in that position runs their own IdO or (P2) the extension build. A compromise of the IdO host that serves altered code takes the roots of people who unlock there afterwards. This is the one central trust point the design adds, and it replaces the far larger one in the proposals (every site host).
2. **Each site's host** remains the trust root for that site (SECURITY-MODEL): it can take that site's working keys, read that site's sealed items and private media of people signed in there, and act as them there. It cannot reach other sites or the root.
3. **The browser** enforces origins, `event.origin`, WebAuthn RP IDs and Service Worker scope. Malicious extensions and compromised devices are out of reach (PHISH A16).
4. **Peers, trackers, STUN, relays and holders** are untrusted for content and integrity and are assumed to log everything they can see.

### 2.16.2 Residual exposure by observer, before and after

"Before" = v0.2.1 plus the two proposals as written. "After" = this design.

| Observer | Before | Mitigations in this design | After (what remains) |
|---|---|---|---|
| Ledger-swarm peers | IP next to key on every signed action; first-seen author inference | relay jitter and random subsets for new blocks (STALK A3); as built (5.4, STALK-8): each peer hears of a new local block after its own random delay of 0.5 to 3 s | IP next to key for neighbours; timing analysis by wide Sybil sets; as built (5.4, STALK-3), on a hub's follow lane the ledgers a member holds and follows, private follows included until the loader passes them as private |
| Chat-lane neighbours | IP, that you chat, sizes, timing; key-to-IP through the public inbox tag; public presence beacon; flood-origin inference | no public inbox tag on the wire; prefix buckets and decoys; jitter; padded PRES; presence off by default; as built (5.4, PRIV-1, STALK-7): own frames leave at a random hop to a random half of neighbours, stranger frames show one byte of the inbox tag | IP, that you use chat on this site, padded sizes and times; as built (5.4, STALK-2), also the chat key and the site key, because every neighbour gets the signed CK until the "reason" policy is the default, and after it a chat key that stays the same for 90 days; a first-hop neighbour can guess a frame's author by timing |
| Public default trackers (four, PRIVACY.md) | which IPs open which felinar sites, chat lanes, group lanes, private file swarms | not used for chat, groups or private media; the site's own tracker required when those are on; as built (5.4, HON-7): the separate chat lane, group lanes and private media swarms announce only to the site's own tracker, and chat also rides the ledger rendezvous wires those trackers helped set up | which IPs open which sites (ledger rendezvous and content swarms); not that a person chats |
| Site's own tracker, hub tracker | | named in the chat and media cards | IPs on the chat lane and in private swarms (edges between uploader and recipients), times |
| STUN operators | IP and session starts for every site using the defaults | site's own STUN required for chat and files | IP and session starts |
| DoH resolvers | IP and site names every 5 minutes while open | unchanged; lengthen the poll when hidden (STALK A11; not built, 5.4 HON-1: the poll keeps its interval while the tab is hidden) | IP and site names |
| TURN relay (if the owner runs one) | both IPs, bytes, times | off by default; operator named; logging off in the compose file | both IPs, bytes, times for people who choose relay-only |
| Opt-in holders | every flooded DM for 7 days; IP pairs depositor to collector; inbox oracle | hold flag; contact mail only; COLLECTED; prefix buckets; per-source quotas | that an address left padded ciphertext and another address collected something in the same bucket |
| Pin mailbox and pin node | IPs, tags and sizes of everyone; files in memory | stated recipient; inbox mail only with key proof; moderator queue for pins | IPs, tags, sizes, times; ciphertext of held and pinned items; plaintext of public pinned files |
| The site's host (loader code) | every root unlocked on that site, hence every site | root never on site origins | that site's working keys, records and media of people signed in there |
| Identity origin host | n/a (did not exist) | static bundle, cached by its own worker; no referrer; build id and hash | IP and time of popup loads that miss the cache and of update checks; with altered code, the roots of people who unlock after the change |
| Passkey provider | a credential per site origin (the list of sites) | one RP ID at the IdO | that the person has a felinar identity at that IdO |
| Server relying party | proofs replayable for up to 7 days | 5-minute challenge-response, nonce, origin | the person's key for that site, IP, user agent, time |
| Other visitors | public posts, profile names, keys | short ids and badges against impersonation | public posts, names, keys, and IPs when connected |
| Recipients and group members | everything sent, provable to third parties | deniable DMs | everything sent (can keep and forward); group messages provable inside the group's trade-off |
| Site owner reading the ledger | sealed-item metadata; permanent membership, bans, chat-key rotation history | chat keys off-ledger; ban expiry; checkpoint pruning | membership and bans in current state; sealed items' author, time, fixed size |
| Site owner through code, or a hostile same-origin script | every root, every site, while unlocked or after | per-site keys only | everything on that site while the person is signed in there |
| Hub operator | the loader for every personal site; tracker; pins | refuse persistent identity on shared-origin hubs; recipient rows; hub-scoped identity only by choice | the loader for its labels, tracker data, pinned ciphertext and public files |
| Anyone with a ledger copy, forever | stubs, membership, bans, chat-key records, record times | checkpoint pruning for honest copies; chat keys off-ledger | whatever was copied before a checkpoint, on copies that never prune |
| Network observer or ISP | connections to trackers, STUN, peers | none in a browser | that you use peer-to-peer sites, when and how much |
| Someone with your 12 words | every key, record and recorded message on every site | random content keys; extra word option | your public identities on every site (and enumeration of where you posted); not past content without the vault |
| Someone with your unlocked device | every site key after "sign out" | sign out deletes keys; shared-computer mode; as built (5.4, STALK-6): Settings at the IdO lists sites only after an unlock | sites where you stay signed in; the IdO if its window is open; the IdO's stored list of sites signed in to, for anyone who reads the device's storage |

### 2.16.3 Threats added by v0.3 and their rows

| Threat | Mitigation | What remains |
|---|---|---|
| A relying party names another site's ledger to get that key | labels from `event.origin`; ledger label only with pointer lineage and `org=` | none known |
| The IdO host as a tracker of sign-ins | worker cache, no referrer, static | popup loads that miss the cache |
| A third site replays a "same identity" link | links live only in the vault and change only which key the IdO hands to which origin | none in the ledger |
| Phishing for the 12 words | words only at the IdO; site cards have no phrase field | a person who types them elsewhere |
| Stolen working keys on one site | rotate (from the IdO), key-change notices | that site until rotation |
| Proofs replayed at a verifier | nonce, 5 minutes, origin | inside 5 minutes at the same verifier before the real use |
| Wire relay posing as a contact | Noise XX handshake | a hostile tracker in the middle of the WebRTC transport sees IPs and timing |
| Private media keys taken by site code | not in the SDK; held in the worker | hostile code on that origin |
| Media seek patterns | padding of total size | which pieces a viewer asks for (roughly where they seek) is visible to the peers serving them |

### 2.16.4 v0.2.1 hardening that ships first (works today)

MF-73 to MF-77 and MF-30 above, plus: decode only after charging the frame length to the budget, per-peer shares for the deferred pool (PEER A8); per-source want caps of 256 (PEER A6); idle sync sessions closed after 3 s without new blocks and proven peers pre-empting (PEER A7); hub loaders show ownerless ledgers read-only (HUB H10); moderator key non-extractable and moderation UI-gated (MF-27); the owner's pointer `nx=` and the rot v1 removal (MF-28).

## 2.17 Anti-abuse design

### 2.17.1 Sybil and spam

- Keys cost only the fee; the design never claims Sybil resistance (SYB A3). Controls: per-site `bits`, reserved byte pools, `allow` with moderator caps, premoderation of new keys' first files, stranger stamps bound to each frame, per-author token buckets for rooms, per-author listing caps, and "counts are counts of keys" in every count label (SYB A13).
- Open writing on a public ledger stays usable under a GPU-equipped attacker only for vetted users; the owner docs say so and recommend `allow` or vouching for any site that matters (SYB 4).

### 2.17.2 Harassment and stalking

- Message requests off by default; with them on, the requests inbox holds at most 200 entries (chosen), never auto-previews, and shows size and key only for file offers; block and mute are one tap; blocks sync through the vault.
- Requests may require an introduction (a sealed note from a mutual contact or an `allow`-listed key) where the owner sets `_mw.cfg.requests = 'introduced'`.
- "Start a new identity on this site" (a `rotate` with no link) is one tap at the IdO, for people who want to shed a history (STALK A10).
- Direct channels refuse non-contacts; presence is off by default; EXIF removal is on by default.

### 2.17.3 Malware and illegal files

- Inert routes, sniffed types, risk tiers, no auto-fetch, no peer thumbnails, seeding opt-in (2.8).
- `_deny/` entries with every takedown; pin queue and quarantine; OPERATIONS gains a file-lane section covering the three cases (a listing, a pinned copy, a private share), what to block, what to preserve unopened (listing block hash, key, the metadata report, the pin node's profile copied read-only) and whom to call, including Canada's Act respecting the mandatory reporting of Internet child pornography by persons who provide an Internet service (PRIV M8; counsel to confirm application). Counsel review is a prerequisite for turning on public uploads (RT 8).
- **Report without handling content:** `mw.report.send` sends to the moderators' chat keys a sealed report signed with `"mw-report-v1\n"` containing the reported key, envelope or item id, plaintext digest, size, time, the sender's `CK` and (for DMs) the AEAD-authenticated frame bytes the reporter received, plus a note; never the file, `fk` or name (MAL A9). It proves to moderators only what the reporter's device saw.

### 2.17.4 Moderation and takedown

- Moderator actions are UI-gated, capped per hour, reversible with `unban` and the 24-hour value grace; removed moderators' actions can be voided (2.5.3).
- First action on a report is narrow (ban and tombstone the item); site withdrawal is for the whole site (HUB H9).
- Takedown timing: the P0 one-hour clock (OPERATIONS) applies to the narrow action.

### 2.17.5 Hub safeguards

- Shared-origin hubs never hold persistent identity (2.2.3); subdomain hubs must be on the Public Suffix List or the loader disables persistent identity and passkeys there (PTR A8).
- Ownerless ledgers are read-only on hubs (HUB H10).
- The hub denylist and directory follow written rules before they are built: public entries in plain form (name, reason code, date, notice reference), appeal path, expiry, more than one signing key, no automatic propagation, "denied by this hub" shown with "open from the host" where lawful, and counsel review (HUB H11; ROADMAP).

### 2.17.6 Every red-team attack and its status after this design

"Blocked" = the design stops it; "mitigated" = cost raised or harm bounded, with the remainder in 2.16; "open" = stated and not solved.

| Attack | Status | By |
|---|---|---|
| PEER A1 HELLO freeze | blocked | MF-73 |
| PEER A2 cap bypass by a reused peer id | blocked | caps by wire, ignored wires closed |
| PEER A3 rendezvous eclipse | mitigated | anchor slots, random tie eviction, idle close, `cs=` poll on "peers but no progress"; tracker Sybil share unmeasured |
| PEER A4 signature before policy | mitigated | policy and fee checks first, per-wire verify budget |
| PEER A5 `ut_metadata` amplification | blocked | 4 requests per wire per minute after metadata |
| PEER A6 want table fill | mitigated | 256 wants per source |
| PEER A7 sync-slot squatting | mitigated | 3 s idle, proven peers pre-empt |
| PEER A8 decode before budget, shared pools | blocked | charge by length first, per-peer shares |
| PEER A9 web seeds from unsigned magnets | blocked | MF-76 |
| PEER A10 idle and slow wires | mitigated | idle close; lab check that a hash failure destroys the wire |
| PEER B1 relay flood | mitigated | frame-bound stamps, fair queues, interest routing; an attacker with enough compute still pays per frame |
| PEER B2 reusable stamp, computable tag | blocked | 2.7.3, 2.7.5 |
| PEER B3 holder poisoning and wipe | mitigated | per-source quotas, stamp-weighted eviction |
| PEER B4 WANT/HELD amplifier and oracle | blocked | rate per tag per wire; inbox key proof |
| PEER B5 presence and room spoofing | blocked | signed or MAC'd PRES, room check order and `t` window |
| PEER B6 direct-channel signalling from strangers | blocked | 2.7.8 |
| PEER B7 challenge relaying | blocked | Noise XX handshake |
| PEER B8 parser surface | mitigated | stated bounds, fuzzing |
| PEER B9 untrusted torrent metadata | blocked | 2.8.3 |
| PEER B10 decode bombs and name spoofing | blocked | pixel cap, worker decode, name rules |
| PEER B11 drop-in card overlay | blocked for high-risk cards (IdO window); mitigated in-page | 2.3.4 |
| HUB H1 hostile host takes the root | blocked | root only at the IdO; that site's keys remain exposed to its host |
| HUB H2 moderator key theft, silent mass moderation | mitigated | MF-27 |
| HUB H3 stolen owner key | mitigated | `nx=`, visible delay, rot v1 deleted; open if both the current key and the committed next key are stolen |
| HUB H4 replay of old withdrawals or pointers | mitigated | withdrawal expiry 30 days, `minSeq`, two-source disagreement shown |
| HUB H5 moderator tombstones owner entries | blocked | state rule; as built since 5.4 (HUB-6), a moderator `put` cannot replace an owner-written entry, a `_deny/` entry changes only by the owner or its author, and a voided author's `_` writes have no effect |
| HUB H6 a removed moderator's bans survive | mitigated | `unban`, `voided` |
| HUB H7 values dropped before a revocation | mitigated | 24 h grace; as built since 5.4 (HUB-2), for moderator bans and bulk tombstones too |
| HUB H8 D-9 and D-10 levers | mitigated | caps, standing rules, recover precedence, `keyinfo`; as built since 5.4: caps also per checkpoint epoch (SYB-2), a moderator acts only after its appointment (HUB-4), a self rotation passes bans and history only with the next key's signature `nsig` (HUB-1) and needs the write right (HUB-7) |
| HUB H9 fake credible report | mitigated | narrow first action |
| HUB H10 ownerless hub ledgers | blocked | read-only on hubs |
| HUB H11 denylist or directory as a point of control | mitigated by written rules; build deferred | 2.17.5 |
| HUB H12 pointer seq race | mitigated | `nx=` |
| HUB H13 impersonation, linkability levers | mitigated | badges, short ids, once per 30 days |
| MAL A1 shared file runs as the site | blocked | 2.8.5 |
| MAL A2 auto-preview seeders | blocked | 2.8.4 |
| MAL A3 pin node keeps anything | mitigated | moderator queue, quarantine |
| MAL A4 verified malicious files | mitigated | tiers, wording; open for people who run what they download |
| MAL A5 MIME confusion | blocked | sniff and allow-list |
| MAL A6 takedown evasion | mitigated | `_deny/`; open for near-duplicates |
| MAL A7 ban evasion by keys | mitigated | premoderation, `allow`; open by design; as built since 5.4 (MAL53-1), an acceptance credits only the listing's own author |
| MAL A8 unsolicited private shares | blocked | no auto-accept, hidden names |
| MAL A9 moderation blind spot for private shares | mitigated | metadata reports; open for sharing nobody reports |
| MAL A10 reporting duties without a channel | mitigated | OPERATIONS file-lane section, quarantine |
| MAL A11 takedown by false report | mitigated | narrow actions, user files on a separate path |
| MAL A12 the ledger carries content | mitigated | warning, pools, per-author quotas |
| MAL A13 hash substitution | blocked | fetch fails closed |
| MAL A14 decoder exploits in previews | mitigated | short list, click first, worker, "never preview"; open |
| MAL A15 holders store unknown ciphertext | mitigated | card text; open by design |
| PHISH A1 fake loader asks for the phrase | blocked on site origins; open for a person who types the words into another page or a fake IdO | 2.2.6 |
| PHISH A2 hostile page paints a fake panel | blocked for secrets; mitigated for overlays | 2.3.4 |
| PHISH A3 same-origin script takes the root | blocked | that site's keys remain |
| PHISH A4 passkey prompt abuse | blocked | RP ID at the IdO |
| PHISH A5 UI redress | blocked for high-risk cards; mitigated in-page | 2.3.4 |
| PHISH A6 malicious device B, quishing | blocked | commit-reveal, requested screen, in person; open for a person who links an attacker's device in person |
| PHISH A7 reverse-proxy phishing | blocked | browser-stamped origin, user verification on first approval; open for a person who approves the wrong origin |
| PHISH A8 verifier misuse | mitigated | library rules; open for server code that ignores them |
| PHISH A9 shared browser | blocked | sign out deletes keys |
| PHISH A10 key-selection spoofing | blocked | 2.2.3 |
| PHISH A11 rotate races, social engineering | blocked (races); mitigated (social engineering) | 2.5.3 |
| PHISH A12 phishing inside a site | mitigated | badges, short ids, link warnings |
| PHISH A13 same-identity dark pattern | blocked | 2.3.5 |
| PHISH A14 offline guessing of the file | mitigated | generated passphrase; open for a chosen passphrase above the floor |
| PHISH A15 provider recovery becomes identity recovery | open, stated | phrase-only mode offered |
| PHISH A16 malicious extension | open, out of scope | stated |
| PHISH A17 hostile host or loader update | mitigated for the root; open for that site | 2.16.1 |
| PHISH A18 nonce contradiction | blocked | 2.3.2 |
| PTR A1 ledger-id squatting | blocked | lineage precondition, read-only mount, labels; the loader's lineage check was missing in the build and was added in 5.4 (PTR-1, `pointerLineage`) |
| PTR A2 uncapped TTL | blocked | clamp |
| PTR A3 first-use DNS trust | mitigated | fingerprint links (matched against `owner=`, or `lo=` with proven lineage, since 5.4 PTR-2), AD wording; open without a fingerprint |
| PTR A4 cold-device rollback | mitigated | withdrawal expiry; as built since 5.4 (PTR-4), a per-ledger seq floor on each device and resolver failover on empty or older answers; the signed `minSeq` is not built |
| PTR A5 rotation without revocation | mitigated | `nx=`, rot v1 deleted |
| PTR A6 withdrawal abuse | mitigated | resolver failover on empty answers, quote frame, purge scope |
| PTR A7 compromised host, root on that origin | blocked for the root; open for that site | |
| PTR A8 hub PSL tricks | mitigated | PSL probe |
| PTR A9 state poisoning by same-origin code | mitigated in part | the floor and `nx=` come from the signed saved record (5.4, PTR-11); signed pins and expiring refusals catch accidental edits only, because same-origin code can use the device key in shell mode; open for deletion |
| PTR A10 `mw-doh` override | mitigated | not used for a device's first lookup |
| STALK A1 inbox-tag test | mitigated | 2.7.5; as built (5.4, STALK-7), a stranger frame shows one byte of the recipient's inbox tag and leaves at a random hop; a first-hop neighbour can still guess by timing |
| STALK A2 public presence beacon | mitigated | off by default, honest card; open by choice |
| STALK A3 first-seen origin inference | mitigated | as built since 5.4: a 0.5 to 3 s per-peer delay before a new ledger block is announced (STALK-8); own chat frames leave after a jitter at a random hop to a random half of neighbours (PRIV-1); open against wide Sybil sets |
| STALK A4 Sybil harvest of the swarm | open by design (IPs are visible to peers) | per-IP-prefix wire caps and a members-only lane id: not built (5.4, HON-1) |
| STALK A5 phrase leak is retroactive | mitigated | random content keys, extra word; open for public identities |
| STALK A6 public link statements | blocked | nothing in the ledger |
| STALK A7 cross-site re-linking by metadata | mitigated in part | self-hosted widget, own trackers; the announce delay after sign-in is not built, only the 0 to 1.5 s rendezvous join jitter of `src/loader/config.js` (5.4, HON-1); open for IP |
| STALK A8 EXIF | blocked for images, MP4, MOV, WebM; mitigated for other types (warning) | 2.8.2 |
| STALK A9 hashes, sizes, timing | mitigated | padding, optional `sha256` |
| STALK A10 stalker in the group | mitigated in part | requests off; `introduced` takes no requests until introductions are built (5.4, STALK-9); blocks kept in the vault and "a new identity with no link" are not built |
| STALK A11 malicious hub operator | mitigated | shared-origin rule, recipient rows; open: the hub serves the loader |
| STALK A12 profile metadata and style | open | the reused-name hint is not built (5.4, HON-1) |
| STALK A13 presence and write timing | open (needs measurement) | G-CH-7 |
| STALK A14 WebRTC address exposure | open (needs measurement) | G-CH-8 |
| STALK A15 roles as surveillance posts | open, stated | owner docs |
| SC-1 forged or swapped release | blocked | 2.19 |
| SC-2 hostile dependency | mitigated | lock everything, cooldown, two-person rule; open for a reviewed malicious upstream |
| SC-3 npm tarball without lockfile | mitigated | shrinkwrap, `--ignore-scripts` in the tools and recipes; open until every documented install line carries the flag (5.4, SUP-1) |
| SC-4 verification library name squat | mitigated | reserved names, vendorable file; no npm provenance, and the registry copy is not yet tied to the signed release (5.4, SUP-10) |
| SC-5 phrase into a hostile loader copy | blocked | no phrase on site origins |
| SC-6 worker pins a hostile loader; kill switch leaves keys | mitigated | `ml=` floor, purge mode, backup nudge |
| SC-7 shared-CDN widget | blocked | self-hosted with SRI only |
| SC-8 reproducibility | mitigated | cross-OS rebuild job, `verify-release` |
| SC-9 demo deploy on push | open | the demo environment has no required reviewer yet (5.4, SUP-14) |
| SC-10 canonicalisation drift | blocked | RFC 8785 normative, shared negative vectors |
| SYB A1 ledger bloat to the cap | mitigated | reserved pools, checkpoint, raised `bits` |
| SYB A2 backdated `ts` | blocked | arrival-time throttle |
| SYB A3 ban evasion | mitigated; open by design | `allow`, premoderation |
| SYB A4 cleanup cannot keep up | mitigated | bulk tombstone, checkpoint |
| SYB A5 one stamp, unlimited messages | blocked | frame-bound stamps |
| SYB A6 trial-decrypt flood | blocked | stamp before ECDH, per-tag cap |
| SYB A7 ROOM flood | mitigated | role first, buckets, verify cap |
| SYB A8 holder quota squatting | mitigated | per-source quotas, stamp-weighted eviction |
| SYB A9 eclipse | mitigated | as PEER A3 |
| SYB A10 rendezvous poisoning | mitigated | own tracker, persisted peers, PEX; open: public tracker behaviour unmeasured |
| SYB A11 offer and ICE flood | open (needs measurement) | drop offers at the hard cap before creating a peer connection, if measured as real |
| SYB A12 verification asymmetry | blocked | policy before signature |
| SYB A13 reaction and follow stuffing, `put` overwrite | mitigated | author-scoped keys, counts of keys |
| SYB A14 file-drop floods | mitigated | click to fetch, listing caps, verified lengths |
| SYB A15 pin node and tracker DoS | mitigated | total connection cap, egress bucket; open |
| SYB A16 signup and nonce flood | mitigated | stateless nonces, cheap-first checks, optional difficulty |
| SYB A17 TURN abuse | mitigated | off by default, quotas, option (b) |
| SYB A18 fabricated presence, look-alike names | mitigated | signed presence, badges |

## 2.18 Anonymity statement (plain words, for WHY.md, FAQ and the sign-in help)

felinar identities are **pseudonymous by design**: a key, not a person, and by default a different key on every site. They are **not anonymous**. Whenever your browser connects to other visitors, they see your IP address, and so do the connection servers (trackers and STUN) and any relay; they can see when you are active and, for the sites you open, link your activity on several sites by that address. **Host-only mode** connects to nobody but the site's own host, so other visitors see nothing of you, but chat, file sharing and private media do not work there and the host still sees your address. **Tor Browser** hides your address from the host and the connection servers for what it can carry, but it does not run WebRTC (to be confirmed from a primary source), so in Tor Browser you can read and sign in but cannot connect to other visitors. Nothing in felinar proves who you are, your age or that one key is one person.

## 2.19 Security program for a 1.0 release

| Area | What is required | Owner of the work |
|---|---|---|
| Threat model as a living document | `docs/THREAT-MODEL.md` built from 2.16 and 2.17; every release adds or closes rows; a release cannot ship with a row whose "after" column changed without review | P1 security agent; reviewed in each review round |
| Disclosure policy | `SECURITY.md`: private reporting channel (GitHub private advisories and an email with a published key), scope (loader, IdO bundle, SDK, `@magnet-web/verify`, tools), 90-day coordinated disclosure by default (chosen), safe-harbour language, credit, how fixes and advisories are published, and that the IdO and the verifier get a separate severity class because they protect every person | P1 |
| Reproducible builds and signed releases | immutable GitHub releases, tag ruleset (no force push, no delete), no `--clobber`, release job in an environment with a reviewer who is not the pusher, `actions/attest-build-provenance`, a minisign or sigstore signature over a per-file hash list whose public key is pinned in README, SECURITY.md and a second place the repo owner does not control; a cross-OS rebuild job that diffs `dist/`; `tools/verify-release.mjs`; the IdO bundle hash published per release and shown on its cards (SC-1, SC-8) | P1 |
| Dependency policy | every bundled package pinned by tarball SHA-256 in `build.lock.json` (extended beyond the vendored WebTorrent), two-person review on lock changes (CODEOWNERS), Dependabot cooldown of 14 days (chosen) with an explicit override for security fixes, no unreviewed WebAssembly blob (hash-wasm built from source with a pinned toolchain or vendored after review), `npm-shrinkwrap.json` in the CLI package and `--ignore-scripts` in the install docs (SC-2, SC-3) | P1 |
| Fuzzing | property and mutation fuzzers in CI for: bencode, torrent-file and magnet parsing, MW-PTR/1, RFC 8785 canonicalisation, `mw_chain1` and `mw_chain2` frames, `mw_chat1` frames and the Noise handshake, sealed-box and sealed-item parsing, the media chunk format, MP4 and WebM box rewriting, image header parsing, `mw-signin-v1` parsing in the verifier, the wire guard and ledger ingest (`validateBlock`, `admit`, `reduce`); every numeric field driven to 0, -1 and 2^53-1 (PEER A1) | P1 with each module's agent |
| Real-device gate | DEMO-RESULTS rows G1 to G22 plus the rows in Part 4; owner steps in PUBLISH-CHECKLIST; a row never passes from emulation | owner and volunteers |
| Independent audit (before 1.0) | scope: the IdO bundle (derivation, wrapping, passkey use, cards, postMessage handling, redirect flow, storage), the sealed box, the Noise XX instantiation, the media chunk format and Service Worker routes, `@magnet-web/verify` and the `mw-signin-v1` spec, the freeze-group ledger rules (`rotate`, `checkpoint`, `unban`, pools), the drop-in widget, the build and release pipeline; a separate privacy and legal review of the cards, PRIVACY.md and the DPIA template; findings published | owner |
| Incident response | runbook for an IdO compromise (publish the bad build hash, ship a fixed build, tell people to run "Replace my keys on all sites"), for a site-host compromise (`ml=` floor, purge mode), and for a leaked owner key (`nx=` rotation) | P1, OPERATIONS |

---

# Part 3. `examples/social` specification

Ash changed the demo on 2026-10-20 at about 08:20 ET: `examples/social` is a social network of personal sites, global in reach and scalable by sharding, built as the template an owner or a hub operator deploys. `examples/peer-guestbook` stays as the minimal example (3.9).

## 3.1 Shape

- **Hub mode on one domain** (ARCHITECTURE 3.2): `hub.example` serves the loader; the hub suffix must be on the Public Suffix List or persistent identity is disabled (2.17.5).
- **Every person and every group is its own site** with its own site ledger: the person's site is `<label>.hub.example`, where `label` = `hubLabelFor(ledgerId)` (32 base32 characters). Every personal and group site points at **the same template torrent** (`btih=<social template>`), so the site files are one hub-wide swarm and the content of each site is its ledger.
- **Home origin model (SCALE M5).** A signed-in member uses the social app on **their own** label: their timeline, messages, settings and every other person's wall render inside their own origin at `/@<label>`, from ledgers synced into that one engine and one store. Opening someone else's address directly (`<theirlabel>.hub.example`) is for signed-out readers and shared links; a signed-in member there gets "Open in your home" (one tap).
- **Hub-scoped identity (N-6):** at sign-up the IdO offers "Use one identity on all of <hub>", default on for this template; the person's key is the same on every label of the hub and unrelated to any other site.
- **Personal ledgers are owner-only** (`writers: 'owner'`). Nobody writes to anyone else's ledger: comments, reactions, shares, follows and wall posts to someone else all live on the actor's own ledger and point at their target. This keeps each wall's ledger proportional to its owner's activity, never to their popularity (SCALE M6), and removes spam writes to personal ledgers entirely.
- **Group sites:** a group ledger owned by its creator's key, with moderators (at most 50) and `writers: 'allow'` (members, at most 1,000) or `'open'` with the fee for larger public groups.
- **Transport:** a **hub follow lane** (`mw_chain2`, 3.2.2) carries every personal and group ledger of the hub over one or a few hub-wide swarms, plus `mw_chat1` for DMs and notices. A tab announces about 2 infohashes in total (the template swarm and its lane shard), not one per follow.
- **Names:** the member's own domain (`_magnet.<domain>` TXT, the strong path), links and QR invites, and the hub directory only where the operator turns it on after counsel review (N-7, 3.4).
- **Nothing central holds everyone's data unless the operator chooses to pin;** with pins on, the hub is central storage and says so (3.2.4).

## 3.2 Premises answered with numbers

### 3.2.1 What does and does not need a backend

| Premise | Answer |
|---|---|
| A chronological follow feed needs no backend processing | True. The browser merges the recent windows of followed ledgers by `(ts, h)` (3.5 timeline). |
| A global ranked feed, search across everyone, trending, spam fighting at scale | Need an index over everyone's data. **Out of scope for v0.3**, said plainly in WHY.md and the app's About page (3.6). |
| Storage is not unlimited | Content lives while its author's devices, its readers (who opt in) or a pin seed it. 3.2.4 gives the fraction. |
| "Global and scalable" | Per-identity sharding: each person's data is one ledger; a member syncs only what they follow, within per-class caps that gate rows measure (3.2.3). |

### 3.2.2 The hub follow lane (`mw_chain2`)

- Swarm id `sha1(utf8("mw-hub-lane1|" + hubSuffix + "|" + shard))`, `shard` = 0 by default; the operator raises the shard count (powers of two) when G-SC-5 shows tracker or lane load needs it, and a tab joins the shard of its own ledger id.
- Frames as `mw_chain1` (ARCHITECTURE 6.6) with a `ledger` field on every frame, plus `RECENT { ledger, fromDepth }` (blocks at or above a depth, newest first, with every control block of the ledger) and `HAVE { ledgers: [<= 256 ids>] }` (which ledgers this peer holds windows of). Budgets per wire as `mw_chain1`; at most 4 ledgers syncing at once per tab (chosen; SCALE B1).
- **Recent-window sync:** for followed ledgers a member keeps the newest 200 posts' blocks plus all control blocks and the latest `checkpoint` snapshot when one exists (chosen). Display needs only signature checks on the shown blocks plus the ledger's control state; a block whose causal past is not held is shown as "Order not yet checked" until its parents arrive.
- **Snapshot first:** where the hub pins, the first screen comes from `cs=` snapshots of each followed ledger's recent window over HTTPS, then peers fill in (SCALE M9). Signatures are verified on display, newest first.
- **Phones:** pull, then disconnect: after the windows are current the lane keeps at most 2 wires, or none when the page is hidden (SCALE 2.8, radio tail).

### 3.2.3 Measured and to-be-measured limits

| Quantity | Value | Source |
|---|---|---|
| Phone peer connections for the whole tab | 4 to 8 content wires by class | ARCHITECTURE 8 |
| Wire budget across all swarms | desktop 40, phones 8 | chosen; G-SC-2 |
| Follow cap | phones 250, desktop 1,000 | chosen; G-SC-1 and G-SC-9 confirm or lower; the UI shows "You follow 250 of 250 on this phone" |
| Bytes kept per followed ledger | about 200 KiB (200 blocks at about 1 KiB) | model: block size about 1 KiB (SCALE 2.2, from w2a-03 sizes) |
| Ledger windows on a phone at the cap | about 49 MiB (250 x 200 KiB) | arithmetic; ledgers counted in the storage budget with their own line (64 MiB phones, 256 MiB desktop, chosen; SCALE m1) |
| First merged screen | target 5 s on a mid-range phone on LTE from hub snapshots | chosen target; G-SC-1 measures |
| Signature checks for the first screen | 50 posts at 1 to 3 ms each on a phone = 0.05 to 0.15 s | arithmetic on the phone estimate in review/distributed-systems (via SCALE 2.3), not measured |
| Full window sync at the phone cap | 250 x 200 = 50,000 blocks, 50 to 150 s of verification on a phone, in the background | same estimate; G-SC-1 |
| Personal ledger growth | about 14 blocks a day (1 post, 10 reactions, 3 comments) is about 5 MB a year at about 1 KiB each, so the 8 MiB default lasts about 1.6 years and the 64 MiB ceiling about 13 years | model, arithmetic; the owner raises `maxChainBytes` from the IdO card |
| Reaction block | about 570 to 1,050 bytes | 8 MiB holds 8,000 to 14,700 reactions (w2a-03 via SCALE M6); authors who are not vetted share the 25% reserved pool, about 2,000 to 3,700 of them (arithmetic: 2,097,152 bytes / 1,039 to 570, as WHY.md) |
| Tracker load with the lane | 2 announces per tab per 120 s per tracker: 10,000 concurrent members about 167 announces/s (about 0.03 core); 100,000 about 1,667/s (about 0.34 core) | arithmetic on the measured 4,002 announces/s at 0.81 core (w2b-01 via SCALE 2.6); compare 34 cores for 100,000 members following 200 people with one swarm per person (SCALE 2.6) |
| Directory as static shards | about 300 bytes per entry; 1 million members about 300 MB in 4,096 shards of about 73 KB | model (SCALE 2.5), arithmetic |
| Public media per item | images re-encoded to at most 2,048 px on the long side (chosen); video at most 25 MiB | RT 7; sizes after re-encoding to be measured (G-SO-3) |
| Phone upload rate after opt-in | 128 KiB/s; a 25 MiB video takes at least 200 s with the page open and on screen | ARCHITECTURE 8; DS F9 arithmetic |

### 3.2.4 Durability and cost

- Without pins, for a typical person read by 20 followers three times a day, nobody who holds their ledger is online 98 percent of the time and nobody who holds their media 99 percent of the time (SCALE 2.4 model, Little's law, w2c-07 lab). That is what a member sees without a hub pin, and the app says it on each item ("Available only while someone who has it is online").
- **Hub pin and snapshot service** (optional hub component, MF-66): pins every member's ledger window and public media, writes `cs=` snapshots, and serves as the pin mailbox. It is central storage the operator pays for and can be compelled to remove, and the docs say so. Cost reference: R2 storage US$0.015 per GB-month with free egress (w2a-07 F7 via SCALE 2.7); 100,000 members x 1 GiB is about US$1,610 a month (SCALE 2.7 arithmetic).
- Private media on the hub pin is ciphertext; the hub sees sizes, times and IPs (2.9.9).

## 3.3 Accounts

| Mechanism | Ledger ops | SDK | Caps | Scale | Signed-out visitor |
|---|---|---|---|---|---|
| Sign up = create identity and personal site | IdO creates the root (hub scope); the loader on the person's new label mints the genesis `policy` (`writers: 'owner'`, `bits: 16`, `maxChainBytes: 8 MiB`) and a `keyinfo`; signs the pointer `v=mw1; btih=<template>; owner=<key>; chain=<random>; gen=<h>; nx=<sha256 of signKey(label, 2)>; seq; exp` | `mw.auth.signIn()`, then the template's "Create my page" (an IdO card: "Create your page on <hub>. Its address is public.") | one personal site per hub identity (template rule) | one ledger and one directory entry (if on) per member | can read the hub's About page and public pages |
| Sign in, sign out | none | `mw.auth.signIn`, `signOut` | 10 s card cooldown | none | n/a |
| Profile: name, bio, avatar, links | `profile` (name, at most 48 characters); `append('mw.prof', { bio <= 280, avatar: <public image ref>, links: [<= 3 https URLs] })`, newest wins | `mw.identity.setName`, `mw.db.append`, `mw.files.share({ public: true })` for the avatar (re-encoded to 512 px, at most 256 KiB, chosen) | as listed | one item per edit | reads profiles |
| Private record | `mw.s` sealed items (vault by default) | `mw.me.get/set/del/sync` | 32 items | per member | none |
| Data export | none | "Download my data": `node.exportBlocks()` of the person's ledger as JSON, the decrypted vault fields, and each own media item saved through `mw.media.open` and the browser's download | | | none |
| Delete account | tombstones every payload on the person's ledger; a withdrawal pointer `st=withdrawn` signed by the person's key; a signed directory removal (if listed); the IdO shreds `K_rec` and `K_own` for this label | "Delete my page" (IdO card) | | stubs remain until the person's own `checkpoint` (they own the ledger, so they can write one) | sees "This page was withdrawn by its owner" |
| Recovery and devices | none | `mw.identity.openIdentity()` | 2.2.6, 2.3.8 | | none |

Personal-site owner keys are held on the person's own origin like any working key, and owner actions (policy, checkpoint, withdrawal) open the IdO card. The hub serves the loader for every label, so a hostile hub could take personal-site owner keys; that row is in 2.16 and in the hub operator's docs.

## 3.4 Discovery and names

| Mechanism | How | Caps | Signed-out |
|---|---|---|---|
| Links | `https://<label>.hub.example/#<pointer>`; the pointer in the fragment never reaches the host | | opens the page |
| QR invite | the same link as a QR, shown in the person's Settings; scanning opens their page with "Follow" | | opens the page |
| Own domain | `_magnet.<domain>` TXT pointer; handle shown as `@<domain>` (strong: DNS plus the signed pointer) | | yes |
| Hub directory (off by default, "pending counsel", N-7) | name records `{ name, ledgerId, pointer, t, sig (person), hubSig }`; append-only log published as static shards `/_dir/<shard>.json` plus a log of hashes so changes are visible; names first-come, at most one per person; a follow pins the ledger id and warns "This name now points to a different page" when it changes | 1 name per person; registration rate limits need an endpoint, which is a backend, labelled | can look up names |
| Search | over what this browser holds (followed windows, profiles seen, own data), an in-browser index; no global search (3.6) | index at most 10 MiB on phones (chosen) | over what their browser holds |
| Suggestions | people followed by people you follow, from public follow lists you hold | | none |

## 3.5 Mechanisms (each mapped to ledger ops, SDK calls, caps, scale and what a signed-out visitor can do)

All lists below are on the **actor's own ledger** unless marked. `ref = { l: <ledgerId>, h: <block hash> }`.

| Mechanism | Ledger ops (schema) | SDK | Caps (bytes, fee, counts) | Scale (what grows) | Signed-out |
|---|---|---|---|---|---|
| Wall post (text, photos, video, links) | `append('mw.post', { text <= 2,000 chars, media: [<= 4 refs to public files>], link?: { url } , to?: <ledgerId> })` | `mw.db.append`, `mw.files.share({ public: true })` | value at most 2,048 bytes; owner exempt from the fee on their own ledger; media per 2.8.8 | the author's ledger, about 1 KiB per post | reads |
| Edit with history | `append('mw.post', { ..., edit: <h of the original> })`; the newest edit is shown with "edited", earlier versions are listed under "History" unless the author tombstones them | `mw.db.append` | as post | one block per edit | reads the history |
| Delete | `tombstone(h)` | `mw.db.tombstone` | | stub stays until a checkpoint | sees "removed" placeholders only in threads |
| Drafts | none: local only, sealed under `K_local` in the site origin's IndexedDB | template code | 20 drafts (chosen) | device only | n/a |
| Follow, unfollow | `append('mw.f', { l: <ledgerId>, ptr?: <pointer> })` and `tombstone` to unfollow; or a private follow kept only in the vault (sealed `mw.s` when synced) | `mw.db.append`, `mw.me.set('follows', ...)` | per-class follow caps (3.2.3) | follower's ledger | sees public follow lists |
| Followers and following lists | following: own `mw.f`; followers: follow notices received (chat ENV of kind `notice`) and public `mw.f` items seen in synced ledgers, labelled "Followers you can see" | template code | | | sees public following lists |
| Blocks | vault only (private); a blocked key's notices, DMs, comments and mentions are dropped by the blocker's client | `mw.chat.contacts.block` | 1,000 (chosen) | device and vault | n/a |
| Who may post on my wall | nobody writes to it; others' posts addressed `to` my ledger and comments appear only if my setting accepts them: everyone, people I follow (default), nobody, or approve each | `_mw.cfg.wall` on the person's own ledger plus `mw.ok` | | | n/a |
| Who may message me | message requests off by default (MF-60); contacts and people I follow can message | `mw.chat.requests.setOpen` | | | n/a |
| Timeline | merged in the browser from followed windows, newest first by `(ts, h)`; pages of 30 (chosen); "N new posts" indicator; filters: posts, replies, media, one person; **no ranking** | template code over `mw.db.subscribe` per ledger | follow caps | the follower's storage (3.2.3) | n/a (signed-out readers see one page at a time) |
| Comments and replies (threaded) | `append('mw.c', { target: ref, replyTo?: ref, text <= 1,000 chars })` on the commenter's ledger; the target author's client receives a notice and, per their setting, appends batches `append('mw.ok', { refs: [<= 20 refs>] })` to their own ledger so every viewer fetches the accepted comments | `mw.db.append`, `mw.chat.dm.send(<author>, notice)` | 20 refs per `mw.ok` item | comments grow the commenter's ledger; accepted refs grow the author's ledger by about 100 bytes per comment (arithmetic: a ref is about 100 bytes, 20 per item) | reads accepted comments |
| Edit or delete a comment | as posts (`edit`, `tombstone`) on the commenter's ledger | | | | |
| Reactions (one per member per target) | on the reactor's own ledger: `put('re/' + <target ledgerId> + '/' + <target h>, { r: '+1' | 'heart' | 'laugh' | 'sad' })`, `del` to remove (one key per target, so one reaction per member); on a group ledger: the author-scoped form `put('@<authorhash>/re/' + <target h>, ...)` (freeze group) | `mw.db.set`, `mw.db.setMine` | own ledger: no fee for its owner; group ledger: the group's fee | reactor's ledger, about 570 to 1,050 bytes each (w2a-03 via SCALE M6) | sees "liked by people you follow" counts only when signed in; signed-out sees the author-reported count if published |
| Reaction counts | counts of reactions this browser can see, labelled "from people you follow"; optional author-reported `append('mw.cnt', { target, n, t })`, labelled "as counted by the author" | template code | | | sees the author-reported count |
| Shares and quotes | `append('mw.q', { target: ref, text? <= 1,000 })` | `mw.db.append` | | sharer's ledger | reads |
| Mentions | `@<short id>` in text plus a notice ENV to the mentioned key | | 10 mentions per post (chosen) | | reads |
| Notifications in the page | replies, mentions, follows, shares: notices received as chat ENVs (live, or via the hub pin mailbox when offline) plus mentions found in synced windows; DMs from the chat lane; no push when the page is closed (Web Push needs a server, RT 7) | `mw.chat.on('message')` | requests inbox 200 (chosen) | per member | none |
| Groups (community board) | group site ledger: posts `mw.post` by members (writers `allow`), comments on the group ledger (`mw.c` there, since group members write to the group), roles: owner, moderators, members; moderation by `ban`, `tombstone`, `unban`; public groups `writers: 'open'` with the fee | `mw.db.*`, `mw.mod.*`, join request (2.5.2) | moderators at most 50, members at most 1,000 per `allow`; a group ledger is capped by `maxChainBytes` (8 MiB default, 64 MiB ceiling) | group ledger grows with members' activity; checkpoint for old content | reads public group content; **invite-only controls who can post, not who can read: anyone with the group's address can read its ledger**; private conversation uses a private group chat (2.7.7) |
| Join, leave | join request (2.5.2); leave: unfollow and ask a moderator to remove from `allow` | | `modAllowPerDay` | | |
| Realtime | "Connected to you now" among contacts; group rooms on the group's chat lane; DMs on the hub lane's `mw_chat1`; typing indicators only on direct neighbours, never relayed, off by default; private media drops (2.9) | `mw.chat.*`, `mw.media.share` | 2.7 | 2.7 | none |
| Media and files | public images and video on walls (2.8, re-encoded, EXIF removed); private photos and videos (2.9): encrypted, streamed in the page, viewable only by the uploader after sign-in or by members they share with; previews, downloads, progress, size limits (2.8.8), seeding by the author and by viewers who opt in, revocation (best effort), "Available only while someone who has it is online" when the author is offline and nothing pins it | `mw.files.*`, `mw.media.*` | 2.8.8, 2.9.12 | storage per holder; hub pin if on | sees public media; never private media |
| Report, hide, block | `mw.report.send` (metadata only) to the page or group's moderators, or for personal pages to the hub's moderation contact; hide is local; block per above | `mw.report.send` | | | can report public content through the hub's `ct=` contact |
| Hub denylist and takedown | 2.17.5 rules; `_deny/` entries on group ledgers; hub-level list deferred to counsel | | | | sees "Removed by this hub" with the reason code |

## 3.6 The honest ceiling ("needs an index", out of scope)

| Capability | In this design | What would close it (not in v0.3; each would be a labelled backend or central component) |
|---|---|---|
| Chronological feed of people you follow | yes, while their windows are reachable (3.2.4) | |
| Ranked or algorithmic feed, trending | no | a hub indexer that crawls ledgers as a peer |
| Search across everyone | no; only what this browser holds | the same indexer |
| Replies and mentions from people you do not follow when you are offline | only through notices held by the hub pin mailbox | the mailbox (already a central component) |
| Global follower counts, like counts | no; counts are of what you can see, or self-reported | an indexer |
| Spam fighting across the hub | per ledger only (bans, fee, `allow`, premoderation) | a hub reputation service |
| Push notifications when the page is closed | no | a Web Push relay |
| Durability for phone-only members | only with the hub pin | the hub pin (central storage) |

## 3.7 Plumbing

| Concern | Specification |
|---|---|
| Routes and deep links | History API routes inside the site frame: `/` (timeline), `/@<label>` (a person), `/@<label>/p/<h>` (a post), `/g/<label>` (a group), `/messages`, `/messages/<short id>`, `/notifications`, `/media/<id>`, `/settings/<section>`, `/about`. In shell and hub modes the worker serves the app for every path (ARCHITECTURE 3.1), so deep links work on reload and when shared. |
| Forms and validation | composer: text length counter, at most 4 media, sniffed type and size shown before upload, metadata-removal result, the fee progress ("Working out the spam fee for this post"); every error code mapped to a string (2.11.2); the post stays in drafts on failure. |
| Empty and 404 states | "You don't follow anyone yet. Share your QR code or open a friend's link."; unknown route: "This page doesn't exist in this app."; unknown post: "This post isn't in the copies this browser has. It may have been removed, or nobody who has it is online." |
| Loading and offline | a sync line ("Catching up: 37 of 120 pages"); when peers and host are unreachable the app works from local copies with "Showing what this device has. Last updated 14:02."; writes queue locally and send when connected (drafts and the chat outbox). |
| Responsive layout | one column up to 640 px, two columns from 1,024 px; no horizontal scroll at 320 px; touch targets at least 44 by 44 px. |
| Accessibility | keyboard-only operation of every control; visible focus; ARIA live region for "N new posts" and new messages; labelled buttons and images (alt text field on upload, required for public images); reduced-motion support; WCAG 2.2 AA contrast; axe-core checks in E2E (E-SO-12). |
| Themes | follows `prefers-color-scheme`, with a manual toggle stored locally. |
| Settings | identity (opens the IdO), privacy defaults (requests, presence, follows public or private, wall acceptance), notifications, storage (per-follow bytes, follow cap, clear cache), chat, media sharing, data export, delete account, "What others can see". |
| JavaScript off | **Hub subdomain and shell modes:** the shell needs JavaScript; with it off the page shows only a `<noscript>` notice: "This site loads from other visitors' browsers and needs JavaScript." Nothing of the social content is readable. **Per-domain drop-in mode** (a member who publishes a personal page on their own domain with `publish --dropin`): the static HTML files the member published are readable without JavaScript; ledger content (posts, comments, follows) is not. An optional hub "static export" job that renders pinned public pages to HTML would be server-side processing by the hub, labelled as such, and is not part of v0.3. |

## 3.8 The drop-in widget on an existing site (sign in plus a chat panel)

- **Sign in:** 2.3.6. Works on any site, with or without a server.
- **Chat panel:** needs the drop-in engine (`/_mw/mw.js`) and a site ledger for the chat lane (`publish --dropin --chain <label>` creates one; the panel is unavailable on sites without one). The panel is a closed shadow root with a Lobby room, DMs among the site's signed-in visitors and the consent card; all secrets and high-risk confirmations go through the IdO window. Chat keys are pairwise per origin (or the ledger label for listed mirrors).
- **Owner steps:** `publish --dropin --chain forum-chat --signin-widget --chat-panel --tracker wss://... --stun stun:...` prints the two tags and the CSP lines to add (`connect-src` for the tracker, `worker-src 'self'`); the panel says "Scripts on this page can act as you on this site while you are signed in."

## 3.9 `peer-guestbook` (the minimal example)

Kept as ID 11 specified, amended: Sign in opens the IdO popup; Sign out deletes this site's keys; the profile page uses the new copy ("Encrypted. The site can read it while you are signed in."); recovery kit and device links open the IdO (`mw.identity.openIdentity()`); the optional Members area uses 2.7 (chat off by default) and 2.8 (files off by default).

---

# Part 4. Test plan

All automated tests run locally (Node and Playwright over loopback, the existing harness; INTEGRATION-STATUS). The identity origin is served on a second loopback origin (a different port) so origin separation is real. Nothing reaches a non-local address; rows that need real devices, real providers or public networks are owner steps (HON M11). Firefox rows are reported "not run" until Firefox launches in the harness, never as passed.

## 4.1 Unit and vector tests

| Id | Covers |
|---|---|
| U-ID-1 | identity vectors: phrase, extra word, root*, labels of each kind, derived public keys, a signature, the check code; Node, Chromium, WebKit |
| U-ID-2 | scalar reduction never 0 or n; JWK import non-extractable; `exportKey` throws |
| U-ID-3 | wrap and unwrap: PRF (Chromium virtual authenticator), Argon2id, PBKDF2 fallback named in the header; a wrong passphrase fails closed |
| U-ID-4 | label choice: origin label by default; ledger label only with valid lineage and `org=`; a squatting pointer (`lo=` of a victim, other owner) gets the origin label; hub label only with the PSL snapshot and the opt-in |
| U-ID-5 | vault: random chat, record and own keys; a phrase-only restore cannot open the vault; backup file round trip; legacy key import |
| U-ID-6 | device link: commit before reveal; a substituted key changes the SAS; no ciphertext before confirmation; a code older than 120 s is refused |
| U-ID-7 | escrow blob: a forged or swapped blob fails AEAD |
| U-SI-1 | `mw-signin-v1` vectors (2.3.2), positive and negative, in Node, Chromium and WebKit |
| U-SI-2 | verifier order of checks (nonce before signature), stateless nonces, skew bounds, P1363 accepted and DER refused, high-S accepted with nonce dedupe, 4 KiB size cap |
| U-SI-3 | statement NFC and control-character rules; unknown fields refused; `ledger` present when not expected refused |
| U-AU-1 | local proofs at most 15 min, epoch revocation after sign-out |
| U-AU-2 | Noise XX vectors; a relay that swaps peer ids fails the handshake |
| U-LG-1 | freeze group vectors: `unban` standing, `ban.until`, `keyinfo` first wins and is not redactable, `rotate` precedence (recover beats self in either order, lowest recover wins), `checkpoint` (reduce of the full DAG equals reduce of S plus later blocks; pruned copies accept late blocks naming covered parents), `voided`, owner-protected payload, author-scoped keys, bulk tombstone, moderator caps |
| U-LG-2 | the `mw.*` schema rule is a state rule: a non-matching block is valid, stored, relayed and hidden, and a v0.2.1 reducer and a v0.3 reducer agree on the DAG |
| U-LG-3 | reserved pools under a flood of unvetted authors; vetted writes still accepted |
| U-LG-4 | two keys under `writers: 'open'`: B cannot replace A's sealed items (R3 A6) |
| U-SE-1 | sealed items: fixed size for 1-byte and 1,000-byte data, AAD mismatch fails, random IVs, hint lookup |
| U-CH-1 | frame codec bounds; every numeric field at 0, -1 and 2^53-1; malformed lengths strike the wire |
| U-CH-2 | `frameId` excludes hop; the stamp binds the frame; a stamp copied to another frame fails |
| U-CH-3 | sealed box v2 vectors; the recipient can produce a frame that opens as if from the sender (the deniability property) |
| U-CH-4 | WANT-TAGS never contains a publicly computable tag |
| U-CH-5 | replay window, persisted Bloom filter, day - 1 to day + 1 |
| U-CH-6 | groups: concurrent rekeys converge on one epoch; a removed member cannot decrypt the next epoch; a newcomer cannot decrypt the previous one |
| U-CH-7 | holders: only flagged frames held; COLLECTED deletes; per-source quota eviction; stranger mail released only after the inbox proof |
| U-FI-1 | torrent metadata rules (2.8.3) |
| U-FI-2 | the `/_mw/f/` route's headers for every extension in the map |
| U-FI-3 | preview sniffing and the pixel cap; SVG, PDF and HTML never preview |
| U-FI-4 | name sanitising (bidi, control characters, NFC) |
| U-FI-5 | metadata stripping: a JPEG with GPS has none after re-encoding; MP4 `udta` and location entries removed; WebM `Tags` removed; the failure path |
| U-MD-1 | media vectors (2.9.5); reordered, truncated and cross-file chunks fail |
| U-MD-2 | bucket arithmetic; padding chunks indistinguishable |
| U-MD-3 | Range mapping (offset to chunk), suffix and open-ended ranges, `416`, several ranges answered `200` |
| U-MD-4 | faststart rewrite keeps every sample offset correct |
| U-SO-1 | timeline merge order, edit history, `mw.ok` batching, one reaction per member per target |
| U-HD-1 | v0.2.1 hardening: HELLO bounds, caps by wire, `ut_metadata` limiter, web-seed filter, arrival-time throttle, TTL clamp, policy before signature |

## 4.2 End-to-end scenarios (Playwright, loopback)

| Id | Scenario |
|---|---|
| E-ID-1 | first sign-in through the IdO popup with a virtual authenticator: one prompt, keys installed, a post |
| E-ID-2 | reload with "Stay signed in": signed in; without it: guest, then one tap |
| E-ID-2b | sign out deletes the working keys from IndexedDB (inspected); follower tabs drop their state |
| E-ID-3 | restore from the phrase at the IdO: same public keys; old sealed items unreadable; the backup file restores everything |
| E-ID-3b | a mistyped phrase that passes the checksum: check code mismatch and "No posts found" |
| E-ID-4 | two sites get different keys; "same identity" gives one key; revoking for the future restores pairwise keys |
| E-ID-5 | a hostile fixture site cannot call loader-only methods; `me.get` without activation returns `E_NEEDS_GESTURE` |
| E-ID-6 | host-only mode: sign-in works, no peer traffic |
| E-ID-7 | shared-origin hub: "this visit only" |
| E-ID-8 | a look-alike origin with the victim's ledger id gets its own key and the warning |
| E-ID-9 | axe-core on the IdO card and every site prompt; keyboard-only sign-in |
| E-ID-10 | DOM scan: no origin except the IdO has a phrase or backup-file field (loader, drop-in panel, widget, social app) |
| E-ID-11 | popup blocked: the redirect round trip signs in |
| E-ID-12 | Argon2id under the real IdO CSP in Chromium and WebKit; PBKDF2 named when WebAssembly is disabled |
| E-ID-13 | forced fallbacks: no `PublicKeyCredential`, PRF off, `getClientCapabilities` absent, CryptoKey storage throwing `DataCloneError` |
| E-ID-14 | device link between two IdO contexts with injected QR payloads; a substituted key is caught |
| E-ID-15 | redress fixture: an overlay over an in-page card is refused; high-risk actions are not offered in-page |
| E-SI-1 | server-backed sign-in: a loopback Node server with `@magnet-web/verify`, the drop-in widget, success |
| E-SI-2 | replayed, foreign-origin and expired proofs refused |
| E-SI-3 | a local proof is refused by the server library |
| E-SI-4 | two server instances with a shared nonce store: a replay fails at the second |
| E-SI-5 | a loopback reverse proxy with a rewritten loader: the proof carries the proxy origin and the server refuses it |
| E-CH-1 | DMs between two members; delivered state |
| E-CH-2 | recipient offline: hold flag, a holder holds, the recipient collects, COLLECTED deletes |
| E-CH-3 | a stranger without a valid stamp is dropped by relays; with one, the message lands in requests (requests on) |
| E-CH-4 | a moderator ban hides room messages |
| E-CH-5 | group removal; concurrent rekeys converge; a newcomer cannot read history |
| E-CH-6 | host-only refuses `chat.enable`, `files.share` and `media.upload` with `E_HOST_ONLY` and no request |
| E-CH-7 | the phone class relays nothing |
| E-CH-8 | no chat data in any ledger block (scan) |
| E-CH-9 | a message delivered live is absent from every holder's store |
| E-CH-10 | a hostile sender at the relay cap does not delay a contact DM by more than 5 s (chosen bound) |
| E-CH-11 | captured WANT-TAGS frames contain no publicly computable inbox tag |
| E-CH-12 | a wire relay that swaps peer ids fails the handshake |
| E-FI-1 | public share, click to fetch, tombstone plus `_deny/` stops fetch and seed |
| E-FI-2 | private file: the recipient decrypts; a third context with the infohash gets ciphertext only |
| E-FI-3, 3b, 3c | HTML and SVG uploads download as attachments through the route; the SDK Blob is octet-stream; limited mode uses the Blob path with the checks |
| E-FI-4 | a 25 MiB phone-class file goes through the IndexedDB chunk store with bounded memory |
| E-FI-5 | a JPEG with GPS uploaded publicly is fetched without EXIF |
| E-FI-6 | a listing whose `len` lies is aborted and hidden |
| **E-MD-1** | **a 20 MB MP4 is uploaded (the reference fixture is 20 MiB with a 48 KiB poster): the chunk store and the wire carry only ciphertext (no `ftyp` box at any chunk start; the padded total equals the bucket from 2.9.5, 23,068,672 bytes for the reference fixture), a poster is made, the own-index item is sealed** |
| **E-MD-2** | **the uploader plays it with seeks: on a second profile linked by device link, `currentTime` jumps to three positions, each answered with `206` from `/_mw/media/<sid>`, and the video reaches `HAVE_CURRENT_DATA` after each seek** |
| **E-MD-3** | **a stranger context with the infohash gets ciphertext only, cannot open it, and has no route for the uploader's `sid`** |
| **E-MD-4** | **a recipient plays after a share (grant in an ENV), with a seek** |
| **E-MD-5** | **revoke: the recipient's loader deletes the key and chunks and `open()` returns `E_REVOKED`; with `reencrypt`, the old torrent stops seeding and the remaining recipient plays the new one** |
| **E-MD-6** | **uploader offline: the recipient plays from a pin-node fixture or an opted-in third context; with no holder, `E_FILE_UNAVAILABLE` and its string** |
| E-MD-7 | the worker is stopped mid-playback (Chromium DevTools protocol); playback resumes after the session is registered again |
| E-MD-8 | no worker: the Blob fallback up to the cap; over the cap `E_LIMIT` |
| E-MD-9 | a cross-origin fixture page that embeds the media URL gets a 404 |
| E-MD-10 | an MP4 with `moov` at the end is rewritten at upload and starts without fetching the tail |
| E-SO-1 | sign-up creates a personal site in the browser (genesis, pointer, `keyinfo`); a post on one's own wall without a fee |
| E-SO-2 | follow by link; the timeline merges two ledgers; the new-post indicator |
| E-SO-3 | a comment on another's post lives on the commenter's ledger; the author accepts it with `mw.ok`; a third viewer sees it |
| E-SO-4 | one reaction per member per target; counts "from people you follow" |
| E-SO-5 | the hub lane: three contexts, 20 synthetic personal ledgers, RECENT sync, the follow cap |
| E-SO-6 | the first screen from loopback `cs=` snapshots |
| E-SO-7 | a group: join request, moderator approval within the cap, post, ban |
| E-SO-8 | notifications for a reply, a mention, a follow and a DM |
| E-SO-9 | host and peers down: the app works from local copies; writes queue |
| E-SO-10 | delete account: withdrawal pointer, tombstones, keys shredded |
| E-SO-11 | deep links reload on `/@<label>/p/<h>` |
| E-SO-12 | axe-core on every social screen; keyboard-only post, follow and DM |
| E-SO-13 | directory flag off by default; with it on (loopback), a followed name that changes shows the warning |
| E-HD-1 | v0.2.1 hardening: a HELLO with `d = Number.MAX_SAFE_INTEGER` does not freeze the tab; one peer id on many wires is capped; a `ut_metadata` flood is throttled on the phone class |

## 4.3 Real-device gate rows to add to DEMO-RESULTS

All "not yet run". Owner steps in PUBLISH-CHECKLIST.

| Row | What | Device and browser |
|---|---|---|
| G-ID-1 | sign in through the IdO, close, reopen after 1 hour and after 8 days, with and without Home Screen; escrow rescue after ITP deletion | iPhone, iOS 18.x Safari and a Home Screen app |
| G-ID-2 | PRF round trip at the IdO | Android Chrome with Google Password Manager |
| G-ID-3, 3b | two-device PRF equality; `largeBlob` support and sync | iCloud Keychain, Google Password Manager, Windows Hello, 1Password |
| G-ID-4 | full flow, normal and private window | desktop Firefox |
| G-ID-5 | device link by QR, phone to laptop; decoder bundle size; camera-denied path | phone and laptop |
| G-ID-6 | Argon2id time; PBKDF2 time | low-end Android; iOS 15.4 |
| G-ID-7 | popup and opener behaviour, redirect fallback | iOS Safari, Android Chrome, two in-app browsers |
| G-ID-8 | sign-in at the floor with every fallback | Safari and iOS 15.4, Chromium 110, Firefox 115 |
| G-ID-9 | comprehension test with 5 to 8 people of the sign-in, recovery-kit, restore, link and same-identity cards (P0, UX m5) | any |
| G-SI-1 | server sign-in against a verifier on a real host | any desktop browser |
| G-CH-1 | DM delivery rate over 50 attempts, connect failures counted | phone on LTE and laptop on home Wi-Fi |
| G-CH-2 | an open conversation after 10 s, 60 s and 5 min in the background | iPhone |
| G-CH-3 | how often two members are online together on a hosted site, over a week | staging site |
| G-CH-4 | 25 MiB file from Android to iPhone with the per-upload card | Android, iPhone |
| G-CH-5 | TURN relay-only, both directions | any |
| G-CH-6 | stamp time at 10 and 20 bits | low-end Android, iPhone, desktop |
| G-CH-7 | presence: radio-active time and battery over 30 minutes | Android, iPhone |
| G-CH-8 | WebRTC candidates exposed (mDNS host candidates, IPv6) | Chromium, WebKit, Firefox |
| G-MD-1 | 20 MB MP4: time to first frame, five seeks and their latency | desktop Chrome, Firefox, Safari |
| G-MD-2 | the worker media route with streamed `206`: playback and seeking | iPhone, iOS 18.x Safari |
| G-MD-3 | the same in a Home Screen app | iPhone |
| G-MD-4 | seek latency from a phone seeder at 128 KiB/s and from a desktop seeder | phone, desktop |
| G-MD-5 | IndexedDB chunk store memory and time at 25 MiB on a phone and 100 MiB on a desktop | mid-range Android, iPhone, desktop |
| G-MD-6 | `CryptoKey` structured clone into the worker | Safari and iOS 15.4, Chromium 110, Firefox 115 |
| G-MD-7 | iPhone HEVC video on Android and desktop: `canPlayType` and the "Download instead" path | Android Chrome, desktop Chrome and Firefox |
| G-MD-8 | metadata removal on real photos and videos (iPhone HEIC and MOV, Android JPEG and MP4), checked with a desktop metadata tool | iPhone, Android |
| G-SC-1 to G-SC-11 | first-open sync for 250 follows, swarm and connection ceiling, battery of a live feed, durability without pins, tracker load per hub, directory size and squatting, holder opt-in, PoW on phones, reducer at 200 ledgers, a popular wall at the cap, a hub's monthly bill (SCALE section 4, renamed to the 250 cap) | as SCALE section 4 |
| G-SO-3 | re-encoded image sizes from real phone photos | iPhone, Android |
| G-SO-4 | screen reader pass | VoiceOver on iOS, TalkBack on Android, NVDA on desktop |

---

# Part 5. Build plan

No two agents write one file; deviations go to `docs/deviations/<agent>.md`; at most 8 agents run at once. Models per the sub-agent quota note: builders and synthesis on the strongest model, research on the faster one.

## 5.1 Wave 0: owner decisions

The owner signs 1.5 (N-1 to N-7, the resolved D-, D-C and PR decisions). A reversal of N-1 stops I1, I2, I3, S1 and U1; of N-3 stops X1; of N-4 stops F1, T1 and every later agent that uses the new ops.

## 5.2 Agents, files, order

| Wave | Agent | Owns (write only these) | Depends on |
|---|---|---|---|
| 1 | **H1a chain-net hardening** | `src/chain/gossip.js`, `src/chain/node.js`, `src/chain/wire-ext.js`, `test/unit/harden-chain*.test.mjs` | wave 0 |
| 1 | **H1b loader hardening and the wire budget** | `src/loader/torrent.js` (caps by wire, idle close, `ut_metadata` limiter, global wire budget, `addFileTorrent()` hook with retained stores), `src/loader/app.js` (TTL clamp, signed pins, expiring refusals, read-only ownerless hub ledgers), `src/common/pointer.js` (`org=`, `nx=`, `ml=`, rot v1 removal), `src/common/magnet.js` (web-seed filter), `src/loader/doh.js`, `src/loader/config.js`, `test/unit/harden-loader*.test.mjs`, `test/e2e/harden-*.spec.mjs` | wave 0 |
| 1 | **F1 format freeze** | `src/chain/block.js`, `src/chain/state.js`, `src/chain/dag.js` (checkpoint pruning), `test/vectors/block.json` and `ledger.json` (append only), `test/unit/freeze*.test.mjs` | wave 0 |
| 1 | **I1 identity core** | `src/identity/derive.js`, `wrap.js`, `vault.js`, `check.js`, `test/vectors/identity.json`, `test/unit/identity-core*.test.mjs` | wave 0 |
| 1 | **S1 sign-in format and verifier** | `docs/specs/mw-signin-v1.md`, `packages/verify/**` (the `@magnet-web/verify` single file, README, package.json), `src/identity/signin.js` (shared builder and parser), `test/vectors/signin.json`, `test/unit/signin*.test.mjs` | wave 0 |
| 1 | **C1 chat crypto** | `src/chat/frames.js`, `seal.js`, `tags.js`, `stamp.js`, `noise.js`, `test/vectors/chat.json`, `test/unit/chat-core*.test.mjs` | wave 0 |
| 1 | **M1 media and file formats** | `src/media/format.js`, `pad.js`, `strip.js` (EXIF, MP4, WebM), `faststart.js`, `poster.js`, `src/files/encrypt.js`, `test/vectors/media.json`, `test/unit/media-format*.test.mjs` | wave 0 |
| 1 | **P1 security program** | `.github/workflows/*`, `SECURITY.md`, `build.mjs` (lock extension), `build.lock.json`, `tools/verify-release.mjs`, `npm-shrinkwrap.json`, `test/fuzz/**`, `docs/THREAT-MODEL.md` | wave 0 |
| 2 | **I2 identity origin** | `src/idp/**` (page, cards, store, passkey, device link, its worker, CSP), `build-idp.mjs`, `test/unit/idp*.test.mjs` | I1, S1 |
| 2 | **I3 site identity client** | `src/identity/client.js` (popup and redirect, bundle), `src/identity/store.js` (working keys, escrow, self-test), `src/identity/migrate.js`, `src/dropin/identity.js`, identity sections of `src/loader/app.js` (after H1b lands) | I1, S1, H1b |
| 2 | **N1 hub lane and recent sync** | `src/chain/multi.js` (`mw_chain2`), `src/chain/recent.js`, `tools/snapshot.mjs` (recent windows) | F1, H1a |
| 2 | **C2 chat lane** | `src/chat/lane.js`, `holder.js`, `groups.js`, `presence.js`, `outbox.js`, `ck.js`, `test/unit/chat-lane*.test.mjs` | C1, H1b |
| 2 | **M2 file and media lane** | `src/files/lane.js`, `store-idb.js`, `serve.js`, `preview.js`, `src/media/lane.js`, `src/media/session.js`, `src/sw/media-route.js`, routes in `src/sw/core.js` and `src/sw/lib.js` | M1, H1b |
| 2 | **T1 tools** | `tools/ledger-admin.mjs` (new ops, `cfg`), `tools/publish.mjs` (`org=`, `nx=`, `ml=`, `--signin-widget`, `--chat-panel`, tracker and STUN requirements), `tools/pin.mjs` (disk store, mailbox, files, quarantine), `tools/webseed-file.mjs`, `tools/init.mjs` | F1, H1b |
| 2 | **D1 docs and privacy** | `docs/PRIVACY.md`, `docs/SECURITY-MODEL.md`, `docs/OPERATIONS.md`, `docs/WHY.md`, `docs/FAQ.md`, `docs/DEPLOY.md` (hub pin, cost table) | wave 1 |
| 3 | **A1 SDK and bridge** | `src/loader/api.js`, `src/loader/bridge.js`, `src/sdk/sdk.js`, `src/sdk/sdk-static.js`, `src/dropin/binding.js`, `docs/SDK.md` | I3, C2, M2, N1 |
| 3 | **U1 loader UI, strings, widget** | `src/loader/ui.js`, `ui.css`, `strings.js` (English and French), `src/dropin/panel.js`, `src/widget/signin.js`, `src/widget/chat-panel.js` | A1 contract (INTERFACES v0.3), I2 |
| 4 | **X1 social example** | `examples/social/**` | A1, U1, N1 |
| 4 | **X2 guestbook and drop-in examples** | `examples/peer-guestbook/**`, `examples/existing-site-dropin/**` | A1, U1 |
| 4 | **Q1 tests and gate** | `test/e2e/*` (new suites), `docs/DEMO-RESULTS.md` rows, `docs/PUBLISH-CHECKLIST.md` owner steps, `docs/INTEGRATION-STATUS.md`, `docs/DEVIATIONS.md` | all |

Concurrency: wave 1 runs 8 agents; wave 2 runs 7 (I2, I3, N1, C2, M2, T1, D1); wave 3 runs 2 (A1 and U1, U1 starting from the INTERFACES contract); wave 4 runs 3. Agents in a wave start as soon as their own dependencies land, so N1 can start when F1 and H1a finish even if wave 1 is still running others, as long as no more than 8 run at once.

## 5.3 Review round after the build

1. **Re-run the six judges and the eight red-team attackers** read-only against the built code and the updated specs, with the same lenses, and a **conformance agent** that checks every module against ARCHITECTURE 15 and INTERFACES v0.3 (proposed).
2. **Fix wave** for blockers and majors found, under the same ownership table.
3. **Gate:** all unit and E2E tests green in Chromium and WebKit; Firefox rows "not run" until it launches; G-ID-9 (comprehension) done by the owner; the freeze-group release published before any public ledger.
4. **Promote:** "v0.3 (proposed)" in ARCHITECTURE and INTERFACES becomes normative, with deviations folded in; DEMO-RESULTS rows stay "not yet run" until real devices run them; the independent audit (2.19) is scheduled before 1.0.

## 5.4 Review round results (2026-10-24)

The round of 5.3 ran from 2026-10-22 to 2026-10-24 against the built v0.3 and C2 code and the specifications as they stood
(ARCHITECTURE 8.1 and 15.1 to 15.19, INTERFACES v0.3 and v0.3 C2). Sources: the finding records
(`.orchestration/reports/all-findings-2026-10-22.json`), the refuters' verdicts (`.orchestration/reports/verdicts-2026-10-23.json`),
the ten fixer notes and the six lane notes indexed in [deviations/review-round.md](../deviations/review-round.md). Every status
below is the status a fixer recorded in its note, at the line cited. The contracts the fixes changed are ARCHITECTURE 15.20
and the INTERFACES section "v0.3 review round". Nothing was pushed or published, and no browser left loopback.

### 5.4.1 Reviewers, findings, verdicts

| Item | Count | Source |
|---|---|---|
| Reviewers | 16: the six judges (security and cryptography, privacy and law, user experience, distributed systems, honesty and conformance, scale and economics), the eight red-team attackers (malicious peers, hub insiders, malware and illegal content, phishing, poisoned pointers, stalking, supply chain, Sybil and spam) and two conformance agents (one for ARCHITECTURE 8.1 and 15 against the chain, loader, worker, common, calls, pin, SDK, tools, examples and deploy code; one for the identity, chat, files and media code and the `mw-signin-v1` spec) | the `lenses` field of the finding records |
| Finding records | 203 (199 distinct ids: CONF-1 to CONF-4 carry two records each); two of them (GATE-1, GATE-2) come from the owner-side gate run in Brave | `all-findings-2026-10-22.json` |
| Raised as blocker, major, minor | 22, 114, 67 | same |
| Serious (blocker or major) sent to two refuters | 136 | `verdicts-2026-10-23.json` |
| Confirmed by both refuters | 121 | same |
| Refuted | 1: STALK-4 (5.4.4) | same |
| Not confirmed by two (the session limit stopped a refuter) | 14: no verdict for SYB-2, SYB-4, STALK-1, STALK-3, STALK-5, STALK-8, STALK-9, SUP-10, SUP-11; one refuter only for DS-4, SCALE-4, MP-6 and GATE-1 (confirmed) and STALK-7 (confirmed in part). The fixers treated all 14 as real | same |
| Blockers confirmed as blockers | 6: HUB-1, PTR-1, PTR-2, PTR-3, MAL53-1, SCALE-1 (SCALE-1's refuters rated it major). All six are fixed | the round summary; the fixer rows below |

Outcome by distinct id (the 198 ids in the fixer notes, plus STALK-4), with the severity as raised:

| Outcome | Blocker | Major | Minor | All |
|---|---|---|---|---|
| Fixed: code and a regression test that fails on the code before | 15 | 69 | 37 | 121 |
| Partial: what is left is named, with the exact edit for its owner | 6 | 44 | 12 | 62 |
| Rejected: deferred, with the reason | 0 | 1 | 14 | 15 |
| Refuted | 1 | 0 | 0 | 1 |

An id counts as partial when its note says "partial" or "open" for any part, or when two records of it got different
answers (CONF-1, CONF-2, CONF-3). No vector or LOCK entry changed: the chain fixer appended vectors blk-023 to blk-025 and
lg-026 to lg-029 (review-round-chain.md:40 to :45), and the premoderation acceptance key is the one format change, made
before any release (review-round-loader-ui.md:5 to :7).

The table above counts the fixer notes as written. The integrator then applied the requests that named files the fixers
could not touch ([deviations/review-round-integration.md](../deviations/review-round-integration.md), sections 1 and 2, each
with a test), which finished 19 ids: 17 partial ids (STALK-3; UX-5, UX-7, UX-8, UX-10, SUP-7, DS-4, SCALE-6, SYB-12, HON-5;
UX-20, SCALE-15, MAL53-10, STALK-12, CONF-1, HUB-12, PTR-12) and 2 rejected ones (DS-10, SYB-18). By distinct id after the
integration (2026-10-24, recounted by the reconcile step of verifier round 1):

| Outcome after the integration | Blocker | Major | Minor | All |
|---|---|---|---|---|
| Fixed | 16 | 78 | 46 | 140 |
| Partial | 5 | 35 | 5 | 45 |
| Rejected: deferred, with the reason | 0 | 1 | 12 | 13 |
| Refuted | 1 | 0 | 0 | 1 |

By record, the status columns of the ten notes count 126 fixed, 59 partial and 18 rejected (203 records; the index table of
[deviations/review-round.md](../deviations/review-round.md)); the two counts differ because an id with two records counts once here, and an id counts as partial when any part of it is
open.

### 5.4.2 Fixed

The blockers, one line each:

- **HUB-1, SYB-1.** A self rotation hands bans, allow membership and history to `next` only with `next`'s own signature
  (`nsig` over `mw-rotate-self-v1`); without it the old key is only retired, so a banned key can no longer pass its ban to a
  victim (review-round-chain.md:15, :16).
- **HUB-2.** A moderator ban and a moderator bulk tombstone keep values for the 24-hour grace, as a single tombstone does;
  owner actions and P0 takedowns still drop at once (review-round-chain.md:19).
- **SYB-2.** Per checkpoint epoch a moderator has at most 24 hours of actions and 7 days of allow additions in effect,
  whatever times the blocks claim (review-round-chain.md:21).
- **MP-1.** A sync session takes at most n + c + 64 listed hashes from a peer and holds at most 8,192 queued or wanted
  (review-round-chain.md:24).
- **DS-1.** A WANT-TAGS route adds a neighbour to a random half instead of replacing the flood, so one neighbour cannot
  capture every relayed message (review-round-chat.md:28).
- **SEC-1, STALK-1, PHISH-2.** Each site gets escrow copies made for its origin: the root copy wrapped again with a fresh IV,
  the vault copy encrypted again, padded to a size bucket and named per origin, so the copies no longer link a person's
  sites (review-round-identity.md:28 to :30).
- **PTR-1.** `pointerLineage` says whether a signed record earned the ledger its `lo=` names (owner, `rot=`, carried, or
  unproven); a hub address refuses an unproven record, and a shared hub or a door mounts it read only, without sign-in or a
  moderator key (review-round-loader-pointer.md:18).
- **PTR-2.** A `#host:name@<fp>` link matches the fingerprint against `owner=`, and against `lo=` only with proven lineage
  (review-round-loader-pointer.md:19).
- **PTR-3.** Both pointer update paths run the `nx=` and owner-change checks (`updateContext`, `guardUpdate`)
  (review-round-loader-pointer.md:20).
- **MAL53-1.** A moderator's acceptance of a public listing is bound to its author: `_listed/<b64url(sha256(ih + "\n" +
  author))>` = `{ by, t, ih, author }`, so a key that re-lists an accepted infohash is not credited
  (review-round-loader-ui.md:13).
- **MAL53-2.** A GIF's size is the larger of its logical screen and its first frame, and a received private picture is checked
  before a decoder sees it (review-round-media.md:33).
- **SCALE-1.** Honest copies apply the public file caps when they read listings (25 MiB a file, 256 MiB a site, the first 20
  listings per author, one row per infohash), so one forged listing no longer blocks every upload (review-round-media.md:25).

The majors, by area (the line of each in its area's note):

- **Chain** (review-round-chain.md:17 to :30): HUB-4 (a moderator acts only with its appointment in the block's causal past),
  HUB-6 (owner-protected entries), HUB-7 and SYB-4 (a self rotation needs the write right), MP-2 (one session start per peer
  per 2 s), MP-6 (an orphan's parents do not skip the fee), STALK-8 (each peer gets a new block's announcement after its own
  random delay of 0.5 to 3 s), SCALE-8 (a lifetime block cap for every author), DS-3 (the follow lane refreshes every 30
  minutes).
- **Chat** (review-round-chat.md:21 to :46): DS-5, MP-7 and SYB-17 (HOLDING never stops the held copies), DS-6 and SYB-6
  (replay checks per sender), DS-7 (holder source is the Noise static key), SEC-7 (the recipient's `chatBits` applies to relayed
  stranger frames), MP-3, MP-4, MP-5, MP-8, SYB-3, SYB-5, SYB-7 to SYB-10 (per-wire ingress budgets, CK caches and queue
  rules), PRIV-1 (own frames leave at a random hop after a jitter; contact tags are directional), SYB-14 (one request per
  sender), SYB-15 (the COLLECTED proof is a hash lock the holder checks, closing chat O-1), UX-6 (short ids on events), UX-14
  (chat resumes after a reload).
- **Identity** (review-round-identity.md:31 to :45): SEC-2 and PHISH-9 (a redirect carries only a key sign-in or the record
  read and is marked unverified), SEC-3 and PHISH-4 (restore never replaces an identity silently; `#restore` and `#link` refuse
  a window a site opened), SEC-4 (device link takes the whole vault or fails), PHISH-6 (a label is a page owner only with
  evidence), PRIV-4 (no referrer when the identity window opens), SCALE-3 (synced records write the index last), STALK-5 (the
  extra word at creation), STALK-6 (Settings lists sites only after an unlock), UX-4, UX-9, UX-12.
- **Loader** (review-round-loader-pointer.md:21 to :28, review-round-loader-ui.md:14 to :24): PTR-4 (a per-ledger seq floor on
  each device; resolver failover on empty or older answers), PTR-5 (a first visit holds a rotation younger than 24 hours),
  PTR-9 (the gate holds every download outside shell mode), GATE-1 ("Review the key change"), MAL53-6 (a file wire's metadata
  is bounded by the listing), SCALE-14 (a join accept checks the moderator's day and the allow cap), UX-1, UX-2, UX-3, UX-11,
  UX-13.
- **Files and media** (review-round-media.md:26 to :38): MAL53-4 (every public fetch is checked against `_deny/` by its
  digest), MAL53-5 and SYB-13 (as SCALE-1), MAL53-7 (LNK, CHM, OneNote, AppleScript, CAB, VHD, VHDX, ISO and UDF named; html,
  svg, xml, pdf and unknown kinds need a second confirmation), PRIV-5 (TIFF and camera RAW re-encoded or refused; MP3, AVI and
  WAV tags removed), SCALE-13 (own public uploads survive a reload; fetched copies live under a storage budget), STALK-10
  (MP4 and MOV box allow-list, times zeroed; WebM dates and apps removed).
- **Tools** (review-round-tools.md:29 to :38): SCALE-2 (the allow-list tracker serves the chat lane and, with files or media,
  unlisted swarms under caps), SCALE-10 (256 unlisted swarms per connection; a closed socket takes its peer ids), SEC-5 (door
  kit extras), SEC-6 (`verify` needs `--expect-version`, `--min-version` or `--any-version`), PTR-7 (a withdrawal keeps
  `nx=`), SUP-5 (publish, ship and the CI template check the loader against the signed list).
- **Documents** (review-round-docs.md:21, :22): HON-3, HON-4.

The minors fixed: CONF-4, CONF-5, DS-8, DS-9, HON-8 to HON-11, HON-13, HON-14, HUB-8, HUB-9, HUB-10, MAL53-9, MAL53-11,
MAL53-12, MAL53-13, MP-10, MP-11, MP-13, MP-14, MP-15, PHISH-11, PHISH-12, PTR-13, PTR-14, SCALE-16, SEC-9, SEC-10, SEC-11,
SYB-16, SYB-17, UX-15 to UX-19 (each at its row in the area's note; [deviations/review-round.md](../deviations/review-round.md)
names the notes).

Finished by the integrator after the fix wave (review-round-integration.md, sections 1 and 2; code checked by verifier round 1):

- **STALK-3** (blocker): callers pass `private` (`src/loader/personal-site.js:349`), and the loader holds only the signed-in
  key's own page in full (`holdOwnLedger`, `src/loader/app.js:3841`).
- **Majors:** UX-5 (the loader's post count is null before the first sync, `src/loader/api.js:2092`), UX-7 and UX-8 (the chat
  panel's own line and composer focus, `src/widget/chat-panel.js:120` to `:263`), UX-10 (the sign-in cooldown does not start
  on a block or a cancel, `src/widget/signin.js:80`, `:108`), SUP-7 (`checkIdpPackages`, `tools/build-idp.mjs:120`), DS-4
  (the hand-off counts only copies this device served, `src/loader/torrent.js:2274`), SCALE-6 (the hub lane joins as kind
  `'hub'`, `src/loader/app.js:3821`; kept after verifier round 1, which found that E-SO-2's misses came from a consent race,
  not the kind), SYB-12 (a notice counted only from the key that owns its ledger, `examples/social/js/data.js:424` to `:436`), HON-5
  (the guestbook's about page and the loader's `iosHomeScreenV03` hint, `src/loader/strings.js:101`).
- **Minors:** UX-20 (the chat panel), SCALE-15 (`--mailbox-bytes`, `--mailbox-source-fraction`, `tools/pin.mjs:1601`),
  MAL53-10 (offer and grant caps, `src/media/service.js:165` to `:171`, `src/files/lane.js:805`), STALK-12 (listing time to
  the minute, `src/files/lane.js:612`), CONF-1 (both records: the bare `<mw-chat-panel>` and the upload note's pin key),
  HUB-12 (the `todo` options removed from `test/unit/hub-moderator-gaps.test.mjs`), PTR-12 (the withdrawal quote frame,
  `src/loader/strings.js:183`), DS-10 (`src/chain/recent.js:330`) and SYB-18 (`narrowNonOwnerCfg`, `src/loader/api.js:575`
  to `:592`).

### 5.4.3 Partial (what is left, one line each)

Blockers:

| Id | What is left | Where |
|---|---|---|
| HUB-3 | the card says a page of the hub can post as the person on every page of the hub; splitting the page-owner key from the member key and an owner hand-over are not built | review-round-identity.md:48, Requests 2, 9 |
| PHISH-1 | the hub label goes only to pages the identity origin takes for the hub's template; a pointer owner can still claim the template's infohash, so the loader must load only template code on a hub | review-round-identity.md:47, Request 9 |
| STALK-2 | the CK policy that sends a chat key only for a reason is the loader's default since the integration (`ckShare: 'reason'`, `src/loader/api.js:2156`); left: the Noise static is the chat key, a stable pseudonym for 90 days (owner decision) | review-round-chat.md:47, :62 to :69, R2, R4 to R6; review-round-integration.md:39 |
| SUP-1 | the tools and templates pass `--ignore-scripts`; the release notes, CHANGELOG and checklist install lines, and moving `webtorrent` out of `dependencies`, are left | review-round-tools.md:34, R-SUP-1 |
| SUP-2 | pinned and retired release keys and bound attestation flags exist; the tag-creation rule, the main-ancestry step and the second pin's DNS record are left | review-round-tools.md:35, R-SUP-2a to R-SUP-2c |

Majors:

| Id | What is left | Where |
|---|---|---|
| DS-2 | no `mw_chain1` frame carries a checkpoint's S, and no prune delay | review-round-chain.md:32, Request 6 |
| HON-1, STALK-11 | CHANGELOG lists the unbuilt STALK rows; THREAT-MODEL was corrected by the promote lane | review-round-docs.md:19, :27 |
| HON-2 | no age-keyed defaults, said in FAQ and PRIVACY and, since the integration, in `tools/init.mjs:366`; OPERATIONS and DEPLOY left | review-round-docs.md:20, Requests 2, 3, 5 |
| HON-6 | SECURITY-MODEL names the fuzz targets; SECURITY.md left | review-round-docs.md:24, Request 4 |
| HON-7 | PRIVACY, the chat card, the guestbook's members page and `tools/init.mjs:240` say chat also rides the ledger wires (the last two since the integration); DEPLOY, OPERATIONS and the CHANGELOG line of docs Request 7 left | review-round-docs.md:25 |
| HUB-5 | the first keyinfo stays final (MF-20); since the integration the loader stops retrying a rotation that a planted commitment blocks and shows a warning (`rotationBlocker`, `src/loader/api.js:1018`, used at `src/loader/app.js:3606`); the integrator counts it as the loader side in part | review-round-chain.md:23, Request 2 |
| MAL53-3 | one deny check covers every way into a files or media swarm, and since the integration the pin page host refuses a denied item; since the extra wave after verifier round 1 the page host also leaves an item it already holds when a later `_deny/` entry names it (`src/loader/pinwire.js:626` to `:653`), and the pin node's queue quarantines a denied item in `decide()` and `restore()` (`tools/pin.mjs:465` to `:486`, `:501` to `:515`); the left item's bytes leave the pin's browser profile (`discard`, `src/loader/app.js:4527`, request R4-a); left: the node's Node process has no deny check of its own, and the heartbeat can list a left item for one `--interval` (O-1, O-2) | review-round-media.md:31, R4, "R4 outcome" |
| PHISH-3 | "Stop using the same identity" is built; the typed confirmation and link certificates are not | review-round-identity.md:49, Request 10 |
| PHISH-5 | `#link` is refused in a window a site opened; a card before the unlock and a fresh user verification at release are not built | review-round-identity.md:50, Request 10 |
| PHISH-7 | the loader writes a pending rotation again until it is in the ledger; the identity origin hands the notice out once per origin | review-round-loader-pointer.md:27, Request 3 |
| PHISH-8 | documented; carrying a rotation in a proof needs a new format version | review-round-identity.md:52, Request 11 |
| PHISH-10 | an unsigned pointer names no identity origin; a personal verification phrase and naming the identity host in the loader's prompt are not built | review-round-identity.md:53, Request 12 |
| PRIV-2 | as STALK-2 (the CK policy is the default; the stable Noise static is left) | review-round-chat.md:26 |
| PRIV-3 | the tracker path does not strip host candidates from the SDP (`src/loader/torrent.js`) | review-round-chat.md:27, R3 |
| PRIV-6 | the code follows 2.15; one PRIVACY.md cell is wrong | review-round-identity.md:40, Request 4 |
| PTR-6 | the drop-in engine does not yet use lineage, the rotation delay, the withdrawal binding, the loader floor or signed refusals | review-round-loader-pointer.md:23, Request 1 |
| PTR-8 | host rules and caps for `ws=` and `xs=` are built in `filterWebseeds`; `src/loader/torrent.js` still uses a signed record's lists unfiltered, and `tr=` hosts are not filtered | review-round-loader-pointer.md:24, Request 2 |
| PTR-10 | `idp=` is read only from a signed record; a hub still takes the identity origin from a link-carried pointer until the loader passes the operator's | review-round-identity.md:46, Request 8 |
| PTR-11 | the floor and the previous record come from the saved signed text; the device key that signs pins stays reachable by same-origin code in shell mode | review-round-loader-pointer.md:26, Request 4 |
| SCALE-5 | an unchanged record writes nothing; the stub residue per update and an owner warning are left | review-round-identity.md:42, Request 5 |
| SCALE-7 | followed ledgers still open on a memory store and ask RECENT from depth -1 | review-round-loader-ui.md:22, R4 |
| SCALE-9 | the hub-pin documents say what one pin holds, and `--max-total` exists since the integration (`tools/pin.mjs:1601`); DEPLOY (docs Request 2) is left | review-round-docs.md:26, Requests 2, 6 |
| SCALE-11 | one answer per ledger per wire per minute; lane traffic is not charged to the seeding budget | review-round-chain.md:31, Request 5 |
| SCALE-12 | the card texts say the month cap is per site; a hub-wide counter is a design item | review-round-loader-ui.md:23, R5 |
| STALK-7 | stranger frames carry one byte of the inbox tag and leave at a random hop; a first-hop neighbour can still guess by timing | review-round-chat.md:48, :70 to :73 |
| STALK-9 | `introduced` takes no requests; blocks kept in the vault and "a new identity with no link" are not built | review-round-chat.md:49, R8 |
| SUP-3 | `sign --rebuilt` is required; the checklist and release workflow lines are left | review-round-tools.md:36, R-SEC-6, R-SUP-3 |
| SUP-4 | the release workflow's list comparison step is left | review-round-tools.md:37, R-SUP-4 |
| SUP-6 | the card calls its hash information only; the live check of an identity origin's files is left | review-round-identity.md:54, Request 13 |
| SUP-8 | the CI template passes `--ignore-scripts`; CODEOWNERS and the demo workflow are left (minor after verification) | review-round-tools.md:42, R-SUP-8 |
| SUP-9 | `ship` checks the remote commit; a base image digest and the Playwright download hash are left (a registry lookup is barred on this machine) | review-round-tools.md:39 |
| SUP-10 | the npm package is not in the signed set | review-round-tools.md:40, R-SUP-10 |
| SUP-11 | `--update-lock` refuses a release that lost provenance; `min-release-age`, an npm floor and `npm audit signatures` are left | review-round-tools.md:41, R-SUP-11 |
| SYB-11 | bounded moderation queues with no eviction; the report queue is not persisted | review-round-loader-pointer.md:29, Request 8 |

Minors: CONF-2 and CONF-3 (sections 7 and 3 of the sign-in spec), HON-12 (one CHANGELOG line), SUP-12 (key rotation), SUP-14
(the demo environment reviewer); each with its request in the area's note.

The partial ids the integrator finished after the fix wave are listed in 5.4.2 and no longer here: STALK-3 (blocker); DS-4,
HON-5, SCALE-6, SUP-7, SYB-12, UX-5, UX-7, UX-8 and UX-10 (majors); CONF-1, HUB-12, MAL53-10, PTR-12, SCALE-15, STALK-12 and
UX-20 (minors). PHISH-1 and HUB-3 got the identity origin's `--hub-template` (`tools/build-idp.mjs:49`); what is left above
stands. With these, 5 blockers, 35 majors and 5 minors are partial (5.4.1).

### 5.4.4 Rejected (deferred) and refuted

| Id | Reason |
|---|---|
| SCALE-4 (raised major; refuter: minor) | a per-author share inside the reserved pool refused honest single-author histories in two tests; the share is an owner decision (review-round-chain.md:37) |
| SYB-19 | the same mechanism on ownerless ledgers (review-round-chain.md:38) |
| DS-10 (applied by the integrator, now fixed: 5.4.2) | the defect is in `src/chain/recent.js`, outside the chain brief; exact edit in Request 7 (review-round-chain.md:35); applied at `src/chain/recent.js:330` |
| MP-12 | the behaviour is pinned by tests outside the chain brief; Request 8 (review-round-chain.md:36) |
| MP-9 | `src/loader/pinwire.js` is outside the loader-ui brief; MP-15's deadline bounds it (review-round-loader-ui.md:31) |
| MAL53-8 | validating the pin page host's torrent and quarantining its store is not a small change; outline R-MAL53-8 (review-round-tools.md:46) |
| SUP-13 | moving torrent creation to a keyless child process changes how `publish()` runs in-process (review-round-tools.md:47) |
| STALK-13 | moderators deny by the listed SHA-256; leaving it out needs a pin node or web seed host to compute digests first (review-round-media.md:40) |
| PHISH-13 | a full, dated Public Suffix List needs a vendored file and a build step (review-round-identity.md:59) |
| PRIV-7 | the sentence is a loader string; Request 12 (review-round-identity.md:60) |
| SEC-8 | always running the pure-JavaScript Argon2id where WebAssembly is missing needs a measured time budget on slow devices (review-round-identity.md:61) |
| SYB-18 (applied by the integrator, now fixed: 5.4.2) | `src/loader/api.js` `cfgFromNode` is outside the brief; Request 9 (review-round-loader-pointer.md:33); applied at `src/loader/api.js:575` to `:592` |
| CONF-6 | a line count in the sign-in spec, the identity lane's file (review-round-docs.md:37) |
| GATE-2 | DEMO-RESULTS is no fixer's file; Request 14 (review-round-docs.md:38) |
| HUB-11 | the rows it reopens depend on the HUB fixes of this round; re-read once they land (review-round-docs.md:46) |
| STALK-4 (refuted; raised blocker) | both refuters: a private follow's notice cannot reach the person followed in the shipped build, so the disclosure cannot happen; severity corrected to minor; the template line that sends it is unchanged (`verdicts-2026-10-23.json`, STALK-4) |

### 5.4.5 The lanes' outcomes (2026-10-22)

Six lanes ran beside the review (notes in [deviations/review-round.md](../deviations/review-round.md)):

- **Firefox.** Playwright's Firefox 157.0 runs in the harness on loopback (`npm run test:e2e:firefox`); 31 Firefox scenarios
  pass; the three-engine run passed 132 of 138, every request on 127.0.0.1, and its six failures were not Firefox's (deviations/firefox.md:61 to :71).
- **Accessibility.** axe-core 4.14.0 is a development dependency, never bundled; 60 screens, 0 violations; E-ID-9 and E-ID-9b
  pass, E-SO-12 in part (deviations/a11y.md:22 to :24).
- **Rows.** Of the 64 end-to-end rows of 4.2, 33 had run (23 as written, 10 in part) and 31 were open before the lanes
  (INTEGRATION-STATUS.md, section "v0.3 code review round 2 integrated"). The lanes ran 27 of the 31 and finished two partial rows (E-MD-3, E-MD-5): 60 rows have
  now run in the lanes' loopback runs, 46 as written and 14 in part, and 4 stay open: E-FI-4 (a phone memory bound, real-device
  row G-MD-5), E-SO-5 (the hub lane does not hold a ledger that opens after the services, rows-social D-1), E-SO-10
  (`mw.hub.withdrawPage()` is not built) and E-SO-13 (the directory stays off pending counsel). E-SO-6 runs from the page's own
  `cs=` window only, because 3.2.2 does not say where a hub publishes a followed ledger's window (rows-social C-1); E-SO-7 runs
  over chat grants, because `mw.mod.requestJoin` is not specified enough to build (C-2). The table of
  deviations/integration-v03.md counted the same then: 60 ran, 46 as written and 14 in part, and 4 open.
- **After the integration and verifier round 1 (2026-10-24).** rows-media D-1 and D-2 are fixed, so E-MD-6 counts as written:
  60 ran, 47 as written and 13 in part, and 4 open (integration-v03.md:375). rows-social D-1 is fixed (`holdOwnLedger`,
  `src/loader/app.js:3841`), but E-SO-5 stays open for another reason: since STALK-3 a page holds only the signed-in key's own
  ledger, and the scenario's seeders open the tool-made pages as readers (rerun alone 09:23 to 09:26 ET, failed at the first
  "held on the hub lane" step; network policy PASS). E-SO-9 passes since the social fixer's `timelineTop` fix; its second half,
  E-SO-9B, still fails (09:26 to 09:29 ET: ADA's page is a reader after the offline reload and holds nothing on the lane). E-SO-2's
  intermittent miss was a consent race in the torrent manager, fixed (deviations/review-round-verify-1.md).
- **After verifier round 2 (2026-10-24).** E-SO-9B passes: the offline reload had signed ADA out (the harness plan's "Stay
  signed in" is off), so the scenario now signs her in again once she is online, and her page holds her ledger and BO gets the
  post (3 of 3 with `--only E-SO-9,E-SO-9B`; `test/e2e/scenarios-social-rows.mjs:597` to `:615`). E-SO-9 therefore counts as
  written: 60 ran, 48 as written and 12 in part, and 4 open (integration-v03.md:375). E-SO-4 no longer needs E-SO-3 in the
  selection (`:238` to `:250`). E-SO-5 stays open: its seeders open the tool-made pages signed out, and holding them needs
  either the owners' keys in the seeders or a rule for holding pages one follows, a choice for the integrator or the owner
  (deviations/review-round-verify-2.md).

### 5.4.6 Gate (5.3 item 3)

Not yet met. At the fix wave the fixers' last full unit run had 2,266 tests: 2,246 pass, 1 fails (`repo-layout`, a tracked
`SECURITY-KEY.asc`) and 19 are `todo` (review-round-chat.md:136 to :139; review-round-loader-ui.md:112 to :113). After the
integration ([INTEGRATION-STATUS.md](../INTEGRATION-STATUS.md), "Review round R 5.3"): 2,281 tests, 2,272 pass, 0 fail, 9 `todo`
(the 9 wait on the tools requests R-SUP-*); the second concurrent end-to-end round, counted after the alone reruns, passed
Chromium 101 of 102, WebKit 107 of 107 and Firefox 139 of 140, the one failure in Chromium and Firefox being E-SO-9. After
verifier round 1 (deviations/review-round-verify-1.md): `npm test` 2,286 tests, 2,277 pass, 0 fail, 9 `todo`; E-SO-2, E-SO-3,
E-SO-4 and E-SO-9 passed 3 of 3 runs together with `--only`, and E-CH-7 3 of 3 alone, every request on 127.0.0.1. After
verifier round 2 (deviations/review-round-verify-2.md): `npm test` 2,291 tests, 2,282 pass, 0 fail, 9 `todo`; `npm run
test:example` 186 of 186; the five social rows 3 of 3 runs, E-SO-4 without E-SO-3 3 of 3 and E-SO-9 with E-SO-9B 3 of 3, every
request on 127.0.0.1; E-SO-5 still fails. The final full runs of verifier round 3 (INTEGRATION-STATUS.md, "Final full runs",
17:29 to 18:02 ET on the final tree): `npm test` 2,291 tests, 2,282 pass, 0 fail, 9 `todo`; `npm run test:browser` 41 pass and
1 skipped; `npm run test:example` 186 of 186; the three end-to-end suites at the same time, Chromium 101 of 102, WebKit 105 of
107 and Firefox 140 of 140, and E-MD-6 and E-CH-5, the scenarios that missed a wait under that load, passed alone, so the unit
and E2E part of the gate is green: Chromium 102 of 102, WebKit 107 of 107, Firefox 140 of 140, every request on 127.0.0.1.
The four open rows of R 4.2 (E-FI-4, E-SO-5, E-SO-10, E-SO-13) are outside these suites. G-ID-9 (the owner's comprehension check) has not run, the
freeze-group release is not published, and no real-device row of 4.3 has run.

### 5.4.7 Residual list after the round

1. **Requests to files the fixers could not touch** (each with its exact edit in the note). The integrator applied STALK-3
   (private follows passed, only one's own page held), STALK-2 and PRIV-2 (the CK policy is the default), DS-4, MAL53-3 on the
   page side, SCALE-6, SYB-12, SYB-18 and DS-10 (deviations/review-round-integration.md, section 2). Still open after the
   integration (section 3 of that note gives each reason): the drop-in skips lineage and the rotation delay (PTR-6); signed `ws=`
   and `xs=` lists reach the torrent manager unfiltered and `tr=` hosts are not filtered (PTR-8); a hub takes its identity origin
   from a link (PTR-10); a hub page owner can claim the template's infohash (PHISH-1, HUB-3: `--hub-template` exists, `createPage`
   is unchanged); host candidates reach the tracker (PRIV-3); the pin node's own process has no deny check (MAL53-3; its queue and the
   page host check `_deny/` since the extra wave); followed ledgers live in memory (SCALE-7); the e2e allow-list tracker option
   (R-SCALE-2-E2E); the release and install lines of R-SUP-1 to R-SUP-14.
2. **Known open from the fixers, as of verifier round 1:** checkpoint distribution (DS-2); the chat lane routing test's timing
   under load (review-round-chain.md:54); the 9 `todo` cases of `tools-install-scripts` and `tools-review-requests`, which become
   tests when R-SUP-1 to R-SUP-14 land (review-round-tools.md:83 to :85). Closed since the fix wave: the `repo-layout` entry for
   `SECURITY-KEY.asc` and the `todo` markers of `test/unit/hub-moderator-gaps.test.mjs` (the integrator), and E-SO-2's
   intermittent miss (review-round-chain.md:57 to :62, :109), which was a consent race in the torrent manager, fixed after
   verifier round 1 (deviations/review-round-verify-1.md).
3. **Lane defects:** open: rows-social D-2 and D-3 and clauses C-1, C-2; E-SO-5 (a reader holds no tool-made page since STALK-3;
   E-SO-9B, which failed for the same reason, passes since verifier round 2, when its author signs in again); F:E-SO-2 is left out of
   `--firefox` (its "Follow by link" click). Fixed by the integrator: rows-social D-1, rows-media D-1 and D-2, the Firefox harness
   defects, F:E-MD-1 (deviations/firefox.md:105 to :112) and the social rows run after E-HD-1 (deviations/firefox.md:98 to :103).
4. **Owner decisions the round raised:** per-session Noise statics (STALK-2); a per-author share of the reserved pool
   (SCALE-4, SYB-19); a signed time of its own for a rotation, so `--prev-key` publishes do not hold first visits for 24 hours
   (review-round-loader-pointer.md:85 to :89); moving `webtorrent` out of `dependencies` (SUP-1); link certificates instead of a
   shared key for "use the same identity" (PHISH-3); a proof format that carries rotations (PHISH-8); a page-owner key apart
   from the hub member key (HUB-3); a hub-wide month cap (SCALE-12); the single short-id format (rows-social D-3).
5. **Not built, still "(proposed)" in ARCHITECTURE and INTERFACES, each with its reason there:** the page-to-pin request path,
   durable-grant readers, the hub's recent-window first screen (C-1), hub lane shards above 1 (the loader's use of the `'hub'`
   swarm kind is built since the integration: ARCHITECTURE 15.8), the kill switch's purge mode, the hub directory format, `mw.hub.withdrawPage()`, `mw.mod.requestJoin()`,
   `mw.site.info().pointer`, the signed `minSeq`, S4's second phase and the P3 background tasks.
6. **Unchanged from 5.3:** the real-device gate (4.3, [DEMO-RESULTS.md](../DEMO-RESULTS.md)) and the independent audit of 2.19
   before 1.0.

### 5.4.8 Changes to this document

Section 2.16.2 (the rows for ledger-swarm peers, chat-lane neighbours, public trackers, DoH resolvers and an unlocked
device), the 2.17.6 rows the round changed (HUB H5, H7, H8, MAL A7, PTR A1, A3, A4, A9, STALK A1, A3, A4, A7, A10, A12, SC-3,
SC-4, SC-9), the 2.10.3 pointer to ARCHITECTURE 15.12, the reaction row of 3.2.3, and the project name (felinar; this review was
written as magnet-web, and its `@magnet-web/verify` is the verifier package under its first name). The same rows are
corrected in [THREAT-MODEL.md](../THREAT-MODEL.md), which is the living copy.
