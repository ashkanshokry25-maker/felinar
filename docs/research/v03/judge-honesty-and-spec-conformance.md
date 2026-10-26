# Judge: honesty and spec conformance (v0.3 identity, auth, chat and files proposals)

- **Lens:** every claim in [IDENTITY-AUTH-DESIGN.md](IDENTITY-AUTH-DESIGN.md) (cited as ID) and [REALTIME-AND-FILES-DESIGN.md](REALTIME-AND-FILES-DESIGN.md) (cited as RT) checked against the current code and tests ([INTEGRATION-STATUS.md](../../INTEGRATION-STATUS.md): 938 unit, 25 e2e Chromium, 26 e2e WebKit 27.2, Firefox not launchable), the wording rules, ARCHITECTURE sections 3.4.9, 4, 6, 8, 9, INTERFACES (reserved ops, C1, C2, A4), the compatibility floor (Safari/iOS 15.4, Chromium 110, Firefox 115) and the local-only test harness.
- **Date:** 2026-10-20. Nothing else was changed.
- **Wording scan:** neither proposal uses "serverless", "blockchain", "censorship-resistant", "unstoppable", "fully decentralized", "sub-second" or "production-ready"; no em dashes; no curly quotes. One unsourced comparative claim (m8).
- **Browser-version numbers below** marked "MDN BCD" come from MDN browser-compat-data as I know it; they were not re-fetched in this review and must be confirmed by the A8/C8 gate before docs quote them.
- **Totals:** 3 blockers, 12 majors, 10 minors.

## Blockers

### B1. The 2026-10-20 08:25 requirement (one identity for ANY site) is not designed, and the design as written cannot deliver it
**Section:** ID 1, 2 (non-goals), 3.1, 3.3, 3.4, 4.1, 7; DIFFERENTIATORS line 159 and "Cannot" list.
**Problem.** The owner asked for one root per person usable (a) on every magnet-web site, (b) on any existing site through the drop-in widget, (c) on server-backed sites through a published SIWE-shaped challenge (domain, ledger id or origin, nonce, issued-at, expiry, statement) and a Node and browser verification library, with per-site keys by default, an explicit visible "use the same identity here" choice, a one-tap passkey-modelled card and stated phishing, replay, consent and linkability risks. ID predates this and still says the opposite: cross-site identity is a non-goal, DIFFERENTIATORS says "magnet-web's key is per site on purpose". Concretely:
- The wrapped root lives in IndexedDB `mw-id` of each origin (3.3), and the PRF wrap is per RP ID (3.4). A person who signed in on site A arrives at site B (another origin) with nothing: B needs the 12 words typed, a file, or a QR hand-off. "One tap, nothing to type" is impossible on the second site.
- Derivation is keyed by ledger id only (3.1). A server-backed or plain existing site has no ledger id; nothing defines the derivation label (origin? registrable domain?) for (b) and (c).
- `verifyLogin` checks `c.aud === location.origin`, the current ledger and ledger roles and bans (4.1). A Node server has no `location` and no ledger state; there is no server profile of the check, no `statement` or `uri` field, `iat`/`exp` are ms numbers rather than the RFC 3339 strings SIWE uses, and no library package is planned in 12.4.
- The "same identity here" choice does not exist; the only link mechanism is the `mw.link` migration item (3.7), which is a permanent public ledger entry, not a per-site, revocable, visible choice.
- 4.1 forbids "a challenge whose nonce came from site code", but a server-backed site's nonce can only reach the signer through site code (see M12).
**Failure scenario.** The owner signs off ID; the build ships; a person who uses two magnet-web sites and one Node-backed forum finds three unrelated sign-ups, retypes the phrase on each origin, and the forum cannot verify any proof because the verifier needs `location` and a ledger.
**Fix.** Add a section "Cross-site sign-in" before sign-off: (1) a dedicated top-level identity origin (opened as a popup or top-level redirect, never framed, see B2) that holds the root and the passkey, and returns only a per-site proof or per-site seed; (2) derivation label = ledger id for magnet-web sites, registrable domain plus origin for drop-in and server sites, with vectors; (3) a published challenge spec `mw-login-v1` with `domain`, `uri`/`aud`, `ledger` (optional), `nonce` (verifier-issued, at least 96 bits), `issuedAt`, `expiresAt`, `statement`, `version`, canonical encoding and test vectors; (4) `@magnet-web/verify` for Node 22 and browsers with a server profile (no ledger checks, single-use nonce store) and a ledger profile; (5) a "use the same identity here" control in the card that signs a per-pair link statement shown to the person, revocable locally; (6) a risk table for phishing (domain shown by the identity origin, not the requesting page), replay (single-use nonces, short expiry), consent (card per new origin) and linkability (IP, timing, link statements). Update DIFFERENTIATORS row 11 and its "Cannot" list.

### B2. The single root is exposed to every site's code, so one hostile or compromised site yields every site's keys
**Section:** ID 1 bullets 2 and 7, 3.3, 3.4, 3.5 (QR "link everything"), 6.4, 6.5, 9; ARCHITECTURE 3.4.9.
**Problem.** ID unwraps the root "only in loader code", but in shell mode the site frame is same-origin with the loader and in drop-in mode the page realm is the loader's realm (ID 6.5 admits this). The root is held in loader memory in `session` mode and is unwrapped again every time `K_rec`, `K_vault` or `K_name` is derived (3.3). Site code can replace `parent.crypto.subtle.deriveBits`/`importKey` (or the drop-in's own references) and capture the raw 16-byte root as HKDF input. It can also call `navigator.credentials.get` with the published salt `"mw/wrap/v1|" + ledgerId` after any click (ID 3.4 admits) and unwrap the stored root itself. ARCHITECTURE 3.4.9 accepted "site code is trusted with the per-site identity" because the key was per site; v0.3 turns that into "site code is trusted with the person's identity on every site". ID 6.5 and 9 state the exposure only as "can act as the visitor and read unlocked data while the page is open", which understates it: the stolen root works forever, offline, on every ledger, and links the person across all of them. Under B1's drop-in requirement every existing site that adds the widget (and every third-party tag on it) gets this power.
The fix ID offers (identity origin `id.<site>` framed by the loader) does not reach it either: the shell CSP is `frame-src 'self'` (`src/loader/boot.js` line 457, ARCHITECTURE 13), and a framed identity origin serving many sites gets partitioned storage per top-level site in Safari, Firefox and Chromium, so it cannot hold one root for all of them.
**Failure scenario.** A visitor uses a magnet-web hobby site whose owner ships a malicious update (or whose page includes a compromised analytics tag in drop-in mode). The code waits for the visitor's next unlock, copies the root, and later posts, signs login proofs and decrypts sealed records as that visitor on every other magnet-web site and every site using the cross-site sign-in.
**Fix.** Never let the root (or anything that unwraps it: PRF output under a root salt, the Argon2id key, the phrase) enter a realm site code can reach. Root entry, PRF unwrap and phrase display happen only on the top-level identity origin; a site origin receives only its `siteSeed` (or only signatures). Wrap per-site seeds, not the root, on site origins; QR hand-off sends a site seed, and "link everything" only to the identity origin. Rewrite ID 1 bullet 7, 6.5 and the threat rows to say what a hostile site gets today, and make the identity origin a precondition for the cross-site feature rather than "build later".

### B3. The RT ledger lint changes block validity inside v1 and splits state between peers
**Section:** RT 3 ("Rule and test"), 13 wave 1 (C1 ledger-rules in `src/chain/block.js`).
**Problem.** RT puts a schema lint in `block.js` that rejects `append` blocks on `mw.*` lists whose value does not match a schema, and lists named `dm`, `chat`, `pres`, `mw.env`, "as `shape`". Today `keyProblem` accepts any non-empty list name up to 64 bytes (`src/chain/block.js` lines 159 to 163, 270), so v0.2.1 peers accept these blocks and v0.3 peers reject them. Rejected blocks are never stored or relayed and their descendants orphan forever (ARCHITECTURE 6.3, 6.4), so `root` digests never match and SYNC never settles. Worse, `v` can be tombstoned: a peer holding only the stub `{e, h, s}` cannot run a value lint, so the same block is valid for one v0.3 peer and invalid for another. ID's own lists (`mw.r.<hmac>`, `mw.link`) also fall under "any `mw.*` list" without a schema in RT. ID routes its format changes through the freeze window (D-9, D-10); RT does not.
**Failure scenario.** A v0.2.1 guestbook already has a public list named `chat`. After v0.3 ships, upgraded visitors drop those blocks and every later block that references them; the ledger diverges into two views that never converge.
**Fix.** Do not make it a validity rule. Make it a state rule in `state.js` (the item has no effect and is hidden; the block is stored and relayed as a DAG node), name only `mw.`-prefixed lists (never bare `dm` or `chat`), list every schema including `mw.r.*` and `mw.link`, and if a validity change is wanted, put it in the D-9/D-10 freeze group or behind a block version bump.

## Majors

### M1. Stored site keys sign without unlock: "Logout locks the key" is false
**Section:** ID 1 bullet 4, 3.3, 4.2, 9 row "Key theft from disk"; E-2.
**Problem.** ID 3.3 stores `sign` and `chat` as non-extractable CryptoKeys in IndexedDB `keys:<ledgerId>`, unwrapped. Only the root is wrapped. Any same-origin script can open `mw-id`, read the CryptoKey and sign blocks, login proofs and chat-key bindings, and decrypt chat envelopes, with no prompt and in the `locked` state. Followers forward writes to the engine tab (ARCHITECTURE 5.9, 9), so a "locked" new tab (E-2) still writes through the leader. R3 5.4 R1 promised "a hostile same-origin script can no longer sign silently"; ID quietly drops that.
**Failure scenario.** A visitor signs out; a third-party script on the drop-in page signs a `mw.db.append` as them an hour later.
**Fix.** Either store derived keys only wrapped (re-derive or import per unlock, which the iOS fallback already does) or state that sign-out is a UI state that stops honest site code only. Define the state for follower tabs and test it.

### M2. Argon2id via hash-wasm is blocked by the shipped CSP
**Section:** ID 3.3 `wrap:pass`, 3.5 encrypted file, G-ID-6.
**Problem.** The shell CSP is `script-src 'self'` with no `'wasm-unsafe-eval'` (`src/loader/boot.js` line 449). WebAssembly compilation is blocked under that policy. `'wasm-unsafe-eval'` is not in Safari before 16 (MDN BCD), so Safari and iOS 15.4 to 15.x would need `'unsafe-eval'`, which weakens the whole shell. Drop-in sites with their own CSP must add it too, while ARCHITECTURE 3.4.9 tells them `'unsafe-eval'` is not needed. The 0.1 s figure (ID F7) was measured in a lab page, not under the shell CSP.
**Failure scenario.** A visitor on the shell picks "protect with a passphrase"; Argon2id fails to instantiate; the card falls back to session-only and the visitor retypes 12 words on every visit.
**Fix.** Add `'wasm-unsafe-eval'` to the shell `script-src` and to the `publish --dropin` CSP advice; for engines without it, fall back to WebCrypto PBKDF2-SHA-256 with the iteration count recorded in the file header (the v0.2.1 format already uses PBKDF2); add an e2e row that runs the wrap under the real shell CSP in Chromium and WebKit.

### M3. The compatibility matrix does not describe the floor and overstates the lab
**Section:** ID 8; ID 3.4; ID 7 ("transient user activation ... forwarded").
**Problem.** (1) Related Origin Requests are marked "yes" for Safari macOS and iOS and Chromium; they arrived in Chrome 128 and Safari 18 (MDN BCD, web.dev per R3 F5), far above the floor. (2) Passkey PRF on Safari macOS is marked "Lab", but the lab only read `getClientCapabilities()` in Playwright WebKit (w2c-03 lab4); there is no WebKit virtual authenticator, and R3 itself says a capability flag is not a guarantee. (3) `getClientCapabilities` is Chrome 133, Safari 17.4, Firefox 135 (MDN BCD), so PRF detection at the floor must come from `getClientExtensionResults().prf.enabled` after `create()`. (4) "Forwarded" transient activation has no mechanism; `navigator.userActivation` is Safari 16.4 and Firefox 120 or later (MDN BCD), and a site-supplied flag proves nothing. (5) BarcodeDetector is absent in Safari and Firefox, so the JS decoder is the main path, not a fallback. (6) No row covers the floor versions; every "Lab" is Chromium 156 or WebKit 27.2.
**Failure scenario.** Docs tell an iOS 16 user that the passkey works on the site's mirrors; it throws `SecurityError`.
**Fix.** Add floor columns (Safari 15.4, Chromium 110, Firefox 115) and mark each capability "absent at floor, fallback X"; relabel the WebKit PRF cell "flag only"; specify activation as "the loader's own card button, `isTrusted`" and drop the forwarded-activation claim (E-5 wording too).

### M4. Channel binding by wire ids does not stop relay, and the tracker can sit in the middle
**Section:** ID 4.1 ("Bind to the transport ... `chan: [idA, idB]`"), 9 row "Replay of a peer challenge"; RT 0x07/0x08.
**Problem.** The only per-wire id the code has is the BitTorrent `peerId` (`src/chain/wire-ext.js` line 115, `src/loader/torrent.js` line 885), which each side chooses. A relaying peer M connects to A presenting B's peerId and to B presenting A's, so both compute the same `chan` and M forwards the proofs. Separately, the WebSocket tracker carries SDP offers and answers, so a malicious tracker can swap DTLS fingerprints and terminate both connections. The threat table lists `chan` binding as a mitigation and leaves only "DTLS binding not yet verified".
**Failure scenario.** M relays A's chat-session login and B's file-share accept, then drops or delays traffic while both believe they are directly connected; with a tracker MITM it also learns both IPs and timing.
**Fix.** State that v0.3 peer authentication is end-to-end only at the sealed-box layer, that `chan` with peerIds is advisory, and that the tracker operator can MITM the transport (add to RT 9.1). Keep DTLS-fingerprint binding as an open item with a feasibility test.

### M5. Holders learn the recipient and can pair sender and recipient
**Section:** RT 5.7 ("Holders learn tag, size and arrival time, never sender or recipient"), 9.1 Holder row.
**Problem.** A recipient sends WANT-TAGS with its own inbox tag, `SHA-256("mw-inbox-v1|" + ek + "|" + day)[:8]`, which anyone can compute from the public `mw.ck` record. The holder therefore learns "this IP owns chat key ek", which maps to the member's site key and public name. Pair tags in WANT-TAGS, matched against the IP of the neighbour that delivered an envelope under the same tag, link the sender's first hop to the recipient's IP. 
**Failure scenario.** A malicious visitor enables holding on a desktop, waits, and builds a table of member key to IP plus who-talks-to-whom per day.
**Fix.** Correct both statements; mitigate by asking with short tag prefixes or by fetching every held envelope for the day (k-anonymity at a bandwidth cost) and by never sending the public inbox tag to a holder that is not the owner's pin node; add a test that a holder log cannot resolve a recipient key when the mitigation is on.

### M6. The stranger stamp is reusable and invisible to relays and holders
**Section:** RT 5.3 (strangers), 5.6 item 3, 4.2 frame layout.
**Problem.** The stamp hashes `recipient ek | day | nonce`; it binds neither the message nor the envelope, so one stamp admits unlimited messages to that recipient for the day. The ENV frame carries no stamp field, so relays and holders cannot check it; they relay and hold unstamped junk. With the public inbox tag, an attacker fills every holder's 64-envelope per-tag quota for a victim, evicting genuine first contacts.
**Failure scenario.** One 2^20-hash stamp, then 10,000 request-inbox messages to a moderator; and holders show "held by N peers" for junk only.
**Fix.** Bind the stamp to the envelope (`epk` or the ciphertext hash), carry it outside the ciphertext for strangers' inbox tags, have relays and holders verify it before relaying or holding, and keep a seen-stamp set.

### M7. "Uploaded content never executes at the site origin" is not enforced on the SDK path
**Section:** RT 1 bullet 7, 6.6, 10 (`mw.files.fetch -> { blob }`), E-FI-3.
**Problem.** The serving rule covers Service Worker responses only. `mw.files.fetch` hands site code a Blob whose `mime` the uploader chose; `URL.createObjectURL(blob)` yields a `blob:` URL at the site origin, and an `iframe` or navigation to it runs uploaded HTML as the site (in shell and drop-in modes with loader privilege). Pages without the SW (limited mode, a site with its own worker, ARCHITECTURE 3.4.4, 7.4) get no serving rule at all. E-FI-3 tests only the SW path.
**Failure scenario.** A member shares `invoice.html` with type `text/html`; the example site's "open" button renders it; it reads the recipient's unlocked record.
**Fix.** Return Blobs typed `application/octet-stream` regardless of the declared mime, give the SDK a `preview()` that implements the safe paths itself, reword bullet 7 as "the loader never renders it; site code that renders a Blob is responsible", and add E-FI tests for the Blob path and for limited mode.

### M8. User-facing chat statements omit the same-origin exposure that ID admits
**Section:** RT 9.1 owner row ("cannot read private lanes"), 9.2 statements, 1 bullet 3; ID 6.5.
**Problem.** Messages are decrypted in the site's origin (shell same-origin frame, drop-in page realm). The owner's next code update, any third-party script the site includes, and in drop-in mode any page script can read every message, contact list and private file while the page is open, and with B2 the root. The 9.2 text the UI must carry ("Messages and private files are encrypted between your keys") does not say so, and "cannot read private lanes" is wrong for an owner who controls the code. This contradicts ID 6.5's own honest statement.
**Failure scenario.** A user trusts "encrypted between your keys" for a sensitive conversation on a site whose owner is compelled to ship a logging update.
**Fix.** Change the owner row to "cannot read them from the ledger or the swarm; can read them through the code visitors run", and add to 9.2: "The site's own code, and scripts it includes, can read your messages while this page is open."

### M9. Chat, records and migration need write rights that default sites do not give
**Section:** RT 5.2 (`append('mw.ck', ...)`), ID 6.2 (record as `append`), ID 3.7 (link item, new key becomes author).
**Problem.** `DEFAULT_POLICY.writers` is `'owner'` (ARCHITECTURE 6.1). On such a site no visitor can publish a chat-key record, so no one can receive a DM; synced records are impossible; on `allow` sites, the migrated new key is not on the allow list, so after the link item the visitor cannot post until the owner runs `tools/` (owner key never in a browser). Only the `allow` sign-up case is stated (ID 5).
**Failure scenario.** An owner turns chat on for a default-policy site; every DM send fails `E_NO_CHAT_KEY`; a migrated `allow` member loses posting.
**Fix.** State the matrix (writers x feature) in both docs and the owner guide; make `mw.chat.enable` fail with `E_POLICY` and a clear reason on `owner` sites; for `allow` sites, keep the legacy key as author until the owner adds the new key, or make the link item accepted as an allow alias only through D-9.

### M10. `records: 'sealed'` is an invalid v1 policy field
**Section:** ID 6.1, 7 (`mw.me.sync` "only if site policy records: 'sealed'").
**Problem.** `validatePolicyFields` refuses any key outside `POLICY_FIELDS` (`src/chain/block.js` line 224), so a policy block carrying `records` is rejected as `op`. ID does not list it among the freeze items.
**Failure scenario.** The owner runs `ledger-admin policy --records sealed`; every peer rejects the block.
**Fix.** Put the setting in an owner `_mw.records` key (advisory, as RT does for `_mw.chat`) or add it to the D-9/D-10 freeze group.

### M11. The test plan cannot verify its own gate in the local-only harness, and assigns non-local work to agents
**Section:** ID 12.2 to 12.4 (A8 "real-device runs"), RT 12 (G-CH-1, G-CH-3 "on the hosted example site over a week"), 13 (C8).
**Problem.** Agents may not launch a browser at a non-local address; G-CH-1, G-CH-3, G-ID-2 to G-ID-5 need public networks, real providers and phones. Locally: PRF runs only in the Chromium virtual authenticator (no WebKit authenticator), Firefox does not launch (INTEGRATION-STATUS), and both engines are far above the floor, so no floor fallback is exercised. Guarantees such as "holders never learn the recipient", "nothing assembled whole in memory on a phone" (E-FI-4 is desktop Chromium emulating a class) and "sign-out locks the key" have no test that could fail.
**Failure scenario.** A8 marks the gate green from Chromium-only runs, and DEMO-RESULTS rows claim WebKit and Firefox behaviour that was never run.
**Fix.** Move every real-device and hosted row to PUBLISH-CHECKLIST as owner steps; add local tests that force fallbacks by deleting features (as e2e 14 does for polyfills): no `PublicKeyCredential`, PRF disabled, `getClientCapabilities` absent, WASM blocked by CSP, CryptoKey storage throwing `DataCloneError`; add negative tests for M1, M5, M7; report Firefox rows as "not run", never as passed.

### M12. Site-supplied nonces contradict the rule against them
**Section:** ID 4.1 ("What is never done: accepting a challenge whose nonce came from site code"), 7 (`mw.auth.prove({ nonce })` in WRITE_METHODS, card only on first use per origin).
**Problem.** `prove({ nonce })` takes the nonce from site code by definition, and after the first card it signs silently for up to 7 days of validity per proof. Either the rule or the method is wrong, and the cross-site server flow (B1) needs site-relayed nonces.
**Failure scenario.** Site code collects a challenge from another context that shares the origin's `aud` (another tab or mirror path) and gets a valid proof without any visible card.
**Fix.** Allow verifier nonces from site code but show the requesting `domain`, `statement` and expiry in the loader card on every proof for a server verifier (or per session with a visible indicator), cap `ttlMs` for site-requested proofs far below 7 days, and delete the contradictory sentence.

## Minors

### m1. SAS length and commitment
**Section:** ID 3.5 step 2. 20 bits is up to 1,048,575, a 7-digit number, not 6 digits; and with the optional networked reply an active attacker can grind `eA'` until 20 bits of `SHA-256(eA' || eB)` match (about 2^20 key generations). **Fix:** use `mod 10^6` and add a commitment to `eA` before B reveals anything on the network path, or keep the networked reply out of v0.3.

### m2. Mobile relay budgets disagree
**Section:** RT 4.2 vs RT 7. 4.2 allows 8 KiB/s on "mobile classes" after opt-in; the table gives 0 for "mobile unknown or metered", which is every iPhone (ARCHITECTURE 8). **Fix:** pick one and say iOS never relays.

### m3. TURN contradicts the v1 non-goal
**Section:** RT 9.4, 13 C9. ARCHITECTURE 2 lists "TURN relays" as a v1 non-goal and `config.js` says "no TURN in v1". **Fix:** amend ARCHITECTURE 2 and 8 B7 in the same change, and add the TURN operator to the consent `rcpt` so a change re-asks (C1).

### m4. The 1,024-byte record cannot hold its own fields
**Section:** ID 6.2 fields. Each `p256:` key is 92 characters; `contacts`, `files` (infohash plus 32-byte key) and `links` fill 1 KiB after roughly 8 to 10 entries. **Fix:** state the cap in the field list, or keep contacts and file keys in the local vault only.

### m5. Mandated UI text rests on unconfirmed sources
**Section:** RT 9.2 ("Tor Browser does not run WebRTC"), 9.3 (iOS drops), against RT 16 Q8. **Fix:** make those strings conditional on the primary-source check in Q8.

### m6. Passkey user handle and name unspecified
**Section:** ID 3.4. If `user.id` or `user.name` derives from the root or repeats across sites, the device's passkey list links sites. **Fix:** random `user.id` per site, neutral name.

### m7. SDK read tiers are inconsistent
**Section:** RT 10 vs ID 7. `mw.me.get` needs a card, but `chat.dm.history`, `chat.contacts.list` and the `message` event give plaintext and the contact graph to site code with none. **Fix:** same per-session card, or say why not.

### m8. Unsourced comparative claim
**Section:** RT 1 bullet 9 ("a cost nobody else mentions"). **Fix:** drop the comparison.

### m9. Undefined scope
**Section:** ID 4.1 `scope: ['read-profile']`. No role mapping is defined for `verify` to check. **Fix:** define the scope-to-role table.

### m10. Group message signature and vault key lifetime
**Section:** RT 5.4; ID 3.3. The group inner signature's signed fields (group id, epoch) are not specified, so replay across groups or epochs is not excluded; "keep history" needs `K_vault` for the whole session while 3.3 says it is dropped after use. **Fix:** specify `"mw-grp-v1\n" + groupId + epoch + id + t + SHA-256(body)` and the session lifetime of `K_vault`.
