# R3: Identity and authentication landscape for magnet-web v0.3

Date: 2026-10-20 (all web sources accessed 2026-10-20 unless a row in section 9 says otherwise).
Scope: self-owned visitor identity, backend-free login through the site ledger, an encrypted per-visitor record (the "auth block"), cross-device login and recovery, site-scoped keys, and what each costs.
Builds on, and does not repeat: `docs/research/w2c-03-identity-ux.md` (cited as ID, finding numbers F1 to F31, recommendations R1 to R21) and `docs/research/w2c-03-identity-ux-VERIFY.md` (cited as IDV, claims 1 to 8), `docs/ARCHITECTURE.md` sections 6 and 9, `docs/PRIVACY.md`, `docs/ROADMAP.md`.

Wording used throughout: "no backend", "site ledger". Where this report says a thing cannot be done, it means it cannot be done by the technology described, not that nobody has claimed it.

---

## 1. Summary (10 bullets)

1. **Login without a backend is a statement about keys, not about gating.** The SDK signs a challenge bound to origin, ledger id and time; site code and peers verify it in the browser; the session stays local. Nothing secret can be gated this way, because every site file is public to the swarm and the host. Login is useful for write rights, roles, attribution and unlocking the visitor's own encrypted data (5.1).
2. **The strongest honest identity differentiator is a visitor-held key that is pairwise by construction.** One recovery root yields an unrelated P-256 key per ledger through HKDF, matching WebAuthn's rule that relying parties cannot see credentials scoped to other relying parties. Linkability by IP, timing, name reuse and swarm membership remains and must be stated (5.5).
3. **Passkeys protect the seed; they are not the foundation.** WebAuthn Level 3 is a W3C Recommendation (2026-08-25) and PRF ships in Chromium and WebKit, but provider support is uneven, a capability flag is not a guarantee, and no source proves a synced passkey returns the same PRF output on every device (F4). PRF wraps the seed; the phrase stays the master backup.
4. **A passkey assertion is an origin-bound login proof the browser itself stamps** (`clientDataJSON.origin`), better than any software challenge, at the price of a biometric prompt per login and one more public key. It cannot sign ledger entries today (ID F18).
5. **The auth block collides with a written rule.** `docs/PRIVACY.md` says "No personal data in the ledger, even encrypted". The design can honour it only if the block is opt-in, minimal, tombstonable and shreddable, and whether key destruction counts as erasure is unsettled in the sources I could read (F20). The owner and counsel must decide (Q1).
6. **Per-visitor records must use `append` plus tombstone, not `put`.** In ARCHITECTURE 6.5 `put` is last-writer-wins on the key across authors and `_` keys are owner/moderator-only. This is my reading of the spec, untested (A6).
7. **"Nobody else can decrypt" holds for other visitors, peers, relays and hubs, not for the site's own JavaScript.** Same-origin code can use a non-extractable key (ID F1, confirmed). The record needs tiers: public, site-readable on consent, and a vault only loader UI opens (5.2).
8. **Recovery is where key login loses users.** CHI 2025: only 43% of 643 respondents could identify an image of a seed phrase and many thought a lost one could be reset. Safari can clear script-writable storage after 7 days without interaction. Offer several routes at first value: phrase, encrypted file, passkey-wrapped, QR hand-off, optional Shamir cards (5.4).
9. **Copy selectively from other ecosystems.** Nostr: signer separation (optional adapter), not its lack of rotation. AT Protocol: the signing-key versus rotation-key split. SIWE: the challenge message shape. Solid-OIDC: not a fit (needs identity provider servers). DID and VC: `did:key` as display format only.
10. **Costs are small in bytes and moderate in taps:** a tagged key is 93 characters, a signature 86, a wrapped 16-byte seed 44 bytes, a sealed auth block 300 to 1,500 bytes under the 2,048 default cap. Login is 0 taps with a local key, 1 with a passkey-unlocked seed. Tap counts and timings are design estimates, not measurements.

---

## 2. Method and limits

Web sources fetched or searched 2026-10-20; primary sources (W3C, atproto.com, EIPs, nostr-protocol/nips, WebKit, SLIP-39, MDN) were fetched where possible, otherwise only search summaries were available and the source table says so. Repo facts come from ARCHITECTURE 6 and 9, PRIVACY, ROADMAP, ID, IDV and the `src/chain/state.js` header comment; no code was run. Items from general knowledge are flagged "(not fetched)". No browser was launched.

---

## 3. Findings

Each finding has a confidence tag (H, M, L) and sources by number in section 9.

### 3.1 WebAuthn passkeys and the PRF extension

**F1 (H). WebAuthn Level 3 is a W3C Recommendation dated 2026-08-25.** The W3C header says so, with no substantive change since the 2026-05-26 Candidate Recommendation Snapshot. Credentials are scoped to an RP ID; "user agents and authenticators jointly enforce" the scoping. Credential IDs are either 16 or more bytes with 100+ bits of entropy or encrypted forms only the authenticator can decrypt. [S1]

**F2 (H). What PRF gives.** A pseudo-random function tied to a credential: any input salt maps to 32 random-looking bytes that are the same every time for that credential and RP ID. Salt is hashed as `SHA-256("WebAuthn PRF" || 0x00 || input)`; two salts (`first`, `second`) per call allow rotation; `enabled` is reported only at registration; results at registration are optional; `evalByCredential` is used at `get()`. Only the with-user-verification PRF is exposed. [S2 (MDN), IDV claim 8 quoting S1 section 10.1.4]. I did not obtain the section 10.1.4 text from the W3C page itself this session (the fetch tool truncated it), so the salt-prefix and UV statements rest on IDV claim 8, which quotes it. Confidence M-H.

**F3 (M). Support matrix (October 2026).** Condensed from IDV claim 7, which already cross-checked Corbado against first-party sources; new items marked.

Apple Passwords/iCloud Keychain: works on Safari 18+, Chrome 132+, Firefox 139+ (macOS) and iOS 18.4+ (18.0 to 18.3 had a hybrid-flow mismatch; a 2026-04 recurrence report on iOS 26.3.1 is unanswered). Google Password Manager: reported default-on on Android Chrome, Edge, Samsung Internet (Corbado only). Windows Hello: returns PRF on current Windows 11 builds via Chrome/Edge 147+ and Firefox 147/148+ (the KB attribution is unverified). 1Password works; Bitwarden partial; Dashlane returns nothing to third-party sites. Security keys on iOS need 26.4+ with open WebKit bugs 311099 and 314934. Sources: [S3], IDV claim 7.

**F4 (M). Unresolved: does a synced passkey return the same PRF output on every device it syncs to?** Chromium matches Safari on one Mac; Apple confirmed a hybrid mismatch bug on iOS 18.0 to 18.3 and said "the PRF values returned over hybrid should match the ones returned locally for the same input" (IDV claim 7). The FIDO Credential Exchange Format review draft (2025-03-13) requires that the operation generating the symmetric key "MUST provide the same output regardless of the provider" and lets a new provider import the hmac-secret material, so provider migration need not destroy the key (IDV claim 8, point 4). I found no 2026 primary source that proves equality across devices. Consequence: never make the passkey the only way to open a seed.

**F5 (H). Related Origin Requests (ROR).** One RP ID can serve a list of origins from `https://{RP ID}/.well-known/webauthn` (`origins` array; Chrome limit 5 registrable-domain labels). web.dev says Chrome and Safari support it and Firefox was "still considering" in January 2026; one secondary source claims Firefox 152 (May 2026). Unresolved: treat Firefox as unsupported. [S4, S5]

**F6 (H, repo).** Each site in per-domain mode is its own origin, so its passkey is its own credential (pairwise by the RP ID rule). Mirrors and hub subdomains get a different credential unless ROR is configured. In shared-origin hub mode a passkey would be shared across sites; ID R7 already forbids persistent identity there.

**F7 (H). Passkeys do not sign arbitrary bytes.** Already established as ID F18: the `sign` extension is an unmerged draft and Yubico's `previewSign` is early access. An assertion signature covers `authenticatorData || SHA-256(clientDataJSON)`, where the client data holds the challenge, the origin and the type. A verifier that has the credential's public key (COSE, stored from registration) can check the signature in the browser with WebCrypto, including `origin === expected` and `challenge === expected`. (WebAuthn assertion verification procedure, W3C L3 section 7.2; not re-fetched, fetch truncated.)

### 3.2 DIDs and verifiable credentials

**F8 (H).** VC Data Model 2.0 became a W3C Recommendation on 2025-05-15 with the Data Integrity family. DID Core 1.1 was at Candidate Recommendation Snapshot (comments to 2026-04-05); I found no Recommendation. [S6]

**F9 (M).** The repo already uses canonical JSON and P-256. A `did:key` rendering is a display and interop format (ID R18), not a trust anchor. A role grant is conceptually a small credential (issuer, subject, claim), but W3C VC adds context handling the ledger does not need: keep ledger-native signed ops and export VC-shaped JSON later if asked.

### 3.3 Nostr key UX

**F10 (M). NIP-07 and NIP-46.** NIP-07 is the extension interface `window.nostr` (not fetched). NIP-46 (fetched): a remote signer ("bunker") holds the key; the client uses a disposable keypair; `bunker://` tokens come from the signer, `nostrconnect://` from the client (`relay`, `secret`, optional `perms`); kind 24133 events carry NIP-44 encrypted JSON-RPC (`connect`, `sign_event`, `get_public_key`, `nip44_encrypt`, `nip44_decrypt`, `switch_relays`, `logout`); permissions use `method[:params]`. The page has no status label and its examples are inconsistent. [S7]

**F11 (L-M).** Extensions such as Bark expose NIP-07 and forward to a NIP-46 signer with per-site allow-once, trust or deny. A third-party guide (D-Central, July 2026, single source) says a compromised Nostr key cannot be rotated and no merged spec exists; verify before quoting. [S8] Lessons: per-method approval in a signer-owned prompt matches A4; one global key reused everywhere is the linkability magnet-web avoids; visitor keys need a rotation story (R6 in 5.4).

### 3.4 AT Protocol identity and portability

**F13 (H).** From the atproto account-migration guide: the signing key (in the DID document) signs records; rotation keys authorise DID-document changes; users who can store a private key should add a self-controlled rotation key; an "adversarial" migration with the old host offline needs such a key. Migration needs a service-auth token, repo and blob transfer, and an emailed token for the identity update; the guide warns of lock-out and a 72-hour recovery window after deletion. [S9]

**F14 (M).** Copy the two-level model: a rarely used recovery-level key plus replaceable operational keys. Do not copy did:plc's dependence on a directory service.

### 3.5 Solid WebID-OIDC and SIWE

**F15 (H). Solid-OIDC is not a fit.** It assumes an OIDC identity provider server that issues DPoP-bound tokens. The WebID-OIDC repository was archived 2022-04-13; the Solid-OIDC document is a Community Group report (draft modified 2024-06-22, not on the W3C Standards Track). [S10] A visitor-held key plus a ledger has no place for an identity provider.

**F16 (H). SIWE (ERC-4361) is Final.** Message fields: `domain`, `address`, `uri`, `version`, `chain-id`, `nonce` (8+ alphanumeric), `issued-at`, optional `expiration-time`. Wallets must check the request origin against `domain`; both sides must implement this for phishing protection. The spec itself lists "using the same address across services allows correlation" and "there is no account recovery". [S11] The same shape (domain, uri, nonce, issued-at, expiry) is the right template for magnet-web's login challenge. MetaMask and Brave warn on domain mismatch [S12]. Adoption figures: none found; the Ethereum Magicians thread says non-technical users find the message more intimidating than plain text. SIWE needs secp256k1 plus EIP-191 hashing, neither in WebCrypto, so supporting it means a library and a wallet; keep it as an optional linking statement at most.

### 3.6 Recovery patterns

Routes: recovery phrase (master; fails when lost or misunderstood); encrypted file (needs a strong passphrase; Argon2 is not in WebCrypto, IDV claim 5); Shamir shares (SLIP-39; collusion at threshold, no versioning, English-only) as P3; device sync by QR (no rendezvous without a backend, needs confirmation against MITM); passkey provider sync (PRF equality unproven, F4). Social recovery by smart contract needs a chain and custodial reset needs a backend: neither fits.

SLIP-39 facts: Final status, up to 16 groups of up to 16 members, passphrase printable ASCII only, a wrong passphrase yields a different valid secret with no error [S13]. This is a usability trap for casual users.

### 3.7 End-to-end encrypted user data patterns in browsers

**F17 (M, not fetched).** Standard construction: HKDF-SHA-256 with distinct `info` per purpose and per ledger; AES-256-GCM with a 96-bit nonce and associated data binding ledger, author and version (NIST SP 800-38D caps random-nonce use at 2^32 invocations per key; not fetched). Because PRF output is constant per credential, "it's vitally important to ensure the nonce used when encrypting is unique" (explainer via IDV claim 8). Never use raw PRF output as the key; run it through HKDF with a context label (MDN, S2).

**F18 (H). Non-extractable CryptoKey is not a confidentiality boundary against same-origin code.** Confirmed in IDV claim 1: a same-origin iframe opened the loader's IndexedDB, took the non-extractable key and signed as the visitor; the key object can even be structured-cloned to another origin. Therefore any key that must be hidden from site code has to live behind a boundary that site code cannot cross: a separate origin or a closed shadow root with only loader-owned UI that acts on `isTrusted` gestures (A4's pattern), or not be in the page at all.

**F19 (H). Storage durability.** WebKit's tracking-prevention page: ITP deletes "all cookies created in JavaScript and all other script-writeable storage after 7 days" without user interaction; IndexedDB is in the list; Home Screen web apps are exempt [S14]. IDV claim 2 qualifies the clock: it counts days of Safari use, applies while Prevent Cross-Site Tracking is on, and the unit is the registrable domain. IDV claim 3 documents a live report of iOS Safari failing to persist ECDSA `CryptoKey`s (an unverified hypothesis about cause), and the repo already has a seed-fallback self-test (ARCHITECTURE 6.1).

**F20 (M). Crypto-shredding.** Destroying all copies of the key makes ciphertext unreadable "until the algorithm is broken or the decryption technique advances" (Bitkom response, summarised in search). The EDPB adopted Guidelines 02/2025 on 2025-04-08 for consultation to 2025-06-30. The repo's PRIVACY.md and MIGRATION-DIGEST L3 read them as: encrypted personal data is still personal data. Industry responses ask the EDPB to accept key destruction as erasure; one commentary quotes a passage that properly encrypted data "may be considered erased once the keys are securely destroyed", which I could not verify against the EDPB text. I found no final adopted text. Conclusion: crypto-shredding is a mitigation, not a legal guarantee, and must not be described as erasure in user-facing copy. The ledger's existing tombstone (drop `v` and `z`, keep `{e, h, s}`) is the first line of erasure; shredding is the backstop for peers who keep the old bytes. [S15, repo]

### 3.8 Unlinkability

**F21 (H). Pairwise by derivation.** WebAuthn gives pairwise credentials via RP-scoped credential generation. magnet-web can match this with `siteKey = P-256(HKDF(root, salt="mw/id/v1", info="p256|" + ledgerId))` with a counter on the rare scalar out of range (ID R2 already specifies the seed to per-chain key path; the new part is the root being shared across sites). What stays linkable: IP address to peers and trackers, WebRTC ICE candidates, timing, a reused display name, a reused avatar seed, writing style, and any voluntary link statement. A root-signed link statement lets a visitor choose to prove two site keys are the same person; absent that, an observer holding two ledgers cannot link them by key.

**F22 (M).** One phrase restores every site key: phrase compromise hits all sites, while one site key reveals neither the root (HKDF is one-way) nor other site keys. Say so in the UI.

### 3.9 UX research on key-based login

**F23 (H, partly secondary).** What loses users: misunderstanding the secret (CHI 2025: 43% identified an image of a seed phrase; many think a lost one can be reset [S16]); untested recovery (a vendor-cited 15% figure, original not found [S17]); silently vanishing storage (F19); per-use friction. FIDO Alliance 2025 (1,389 self-reporting consumers, five countries): 74% aware of passkeys, 69% had enabled one, 48% had abandoned a purchase over a forgotten password [S18]; it shows demand, not recovery behaviour. Repo: ID F13 and R12 (comprehension test still to do).

**F24 (L).** I found no 2025 to 2026 controlled studies of PRF-wrapped keys or QR key transfer. Those are test items (A11), not claims.

---

## 5. Design options for magnet-web

All options keep the existing rules: the owner's private key never enters a browser (no "owner login"); site code cannot export or import the identity or grant consent (A4); only loader-owned UI shows security prompts.

### 5.1 How a site authenticates a visitor with no backend

**What login proves.** That a key holder controls the site key now. It does not prove a legal name, an email, or uniqueness (one person can hold many keys); it can be tied to a DNS-verified name later (ID R14).

**Option C (challenge signed by the site key; default).**
1. Site code calls `mw.auth.login({ scope, ttl })`. The loader opens its own card ("Sign in to example.org as Quiet-Heron 3f9a1c20?") and acts only on `isTrusted` input.
2. Challenge (SIWE-shaped, text): `domain`, `ledger` (ledger id), `pub` (visitor key), `nonce` (16 random bytes from the loader, never from site code), `iat`, `exp` (default 12 hours, max 7 days), `scope` (list of operations the site may do, e.g. `post`, `read-profile`), `aud` (the page origin as the loader sees it). Signed as `"mw-login-v1\n" + canonical(challenge)` with the existing block signature scheme so no new primitive is added.
3. Result `{ challenge, sig }` goes to site code. Verification is local: `verifyLogin(challenge, sig)` checks signature, `aud === location.origin`, `ledger === current`, time window, and that the key's role in the current ledger state matches. Nobody else needs to see it. For a peer-visible login (chat presence, file sharing), the same object is sent to peers who verify it identically.
4. Session: `{ challenge, sig }` kept in memory and optionally `sessionStorage`; `mw.auth.logout()` deletes it, and for sites that keep signed-in presence, publishes nothing. There is no server session to invalidate; a stolen session object is usable by whoever holds it until `exp`, so scope it and keep `exp` short.
5. Replay: the nonce is chosen by the signer, so replay protection is by `aud`, `exp` and the fact that the proof is only accepted by verifiers who generated or negotiated the challenge. For peer-to-peer verification, the verifier supplies a nonce in a two-message exchange (challenge-response); a one-message self-issued proof is a bearer token and must be labelled so.

**Option P (passkey assertion as login proof).** Registration stores the COSE public key and credential id in the auth block. Login: `navigator.credentials.get` with `challenge = SHA-256(canonical(challenge))`, `rpId` = site domain, `userVerification: "required"`; the verifier checks the assertion with WebCrypto and `clientDataJSON.origin`, which the browser set, so a page at another origin cannot obtain it. Costs: one prompt per login; mirrors need ROR (F5); the passkey is not the author key, so the author key signs a binding statement.

**Option W (external signer).** A NIP-07/46 or wallet adapter signs the same challenge; the site key stays the ledger author, linked by an author-signed statement. P3.

**Recommendation.** C as the default for everything, P as the protected-login upgrade, W as an optional adapter. Do not ship a login that claims to protect content. Every file of a site is public to the swarm and the host; "logged in only" content must be encrypted to keys, which is what the auth block and private sharing do.

**Roles.** Source of truth is the ledger policy: owner (succession chain, ARCHITECTURE 6.2), moderators (up to 50), allow list (up to 1,000); `mw.ready()` returns `role`. Further roles: (a) advisory, no format change: owner or moderators `put` `_roles/<hash(pub)>` (allowed, `_` keys are owner/moderator-only) and site code treats it as authoritative; the ledger does not enforce it. (b) Enforced: a `role` control op needs a block version bump because unknown ops are invalid in v1; `grp` is reserved for a later control op, so confirm intent before reusing it. Role grants can be exported later as VC-shaped JSON (F9).

### 5.2 The auth block: an encrypted per-visitor record only the visitor can decrypt

**Contents (visitor's choice, minimal by default).** Display name and avatar seed, settings, a list of linked statements (passkey public key, external key links), a pointer to private data (file hashes, chat keys), notes. No email, no real name by default.

**Keys (all derived, none stored beyond the root).**
```
root            16 or 32 random bytes (recovery phrase)
siteSeed        HKDF-SHA256(root, salt="mw/id/v1",   info="seed|"  + ledgerId)
signKey         P-256 scalar from HKDF(siteSeed, info="sign|1")   // counter on out-of-range
authKey (K_a)   HKDF(siteSeed, info="auth|1")                      // AES-256-GCM, record key
vaultKey (K_v)  HKDF(siteSeed, info="vault|1")                     // loader-only tier
```
**Sealed record (JSON, canonical).**
```
{ v:1, ver:<uint>, tier:"site"|"vault", iv:<12 B random, b64url>, ct:<AES-256-GCM(plaintext), tag appended> }
AAD = utf8("mw-auth-v1\n" + ledgerId + "\n" + authorPub + "\n" + tier + "\n" + ver)
```
AAD binding stops a record being replayed under another ledger or author. A fresh random `iv` per write is enough for the expected write count (far below 2^32 per key), but a monotonic counter in the plaintext is cleaner (not fetched: NIST SP 800-38D).

**Where it lives in the ledger.** Not `put` (F6 in the summary): under `writers: 'open'` any writer can overwrite a `put` key, and `_` keys are owner/moderator-only. Use `append` to a list named `auth.<first 22 chars of base64url(SHA-256(authorPub))>`; the item already carries `author`, and readers take "newest item by that author that verifies". A new version is `append(new)` then `tombstone(old.h)` (own entries; drops `v` and `z`, keeps the stub). Spec limits: 2,048 bytes default `maxValueBytes`, 4,096 bytes per block, 8 MiB default per-ledger cap. A plaintext of about 1,000 bytes seals to about 1,030 bytes (12 B iv + 16 B tag + base64url overhead 4/3 => roughly 1,400 characters in JSON). Larger private data goes to separate encrypted files, not the block.

**Who can decrypt.**
| Party | Public tier | Site tier | Vault tier |
|---|---|---|---|
| Other visitors, peers, trackers, relays | ciphertext absent | ciphertext only | ciphertext only |
| Site owner (out of band) | sees same ciphertext | no key | no key |
| Site JavaScript while visitor is signed in | reads | reads on visitor consent (`mw.auth.readProfile()` loader card, per session) | cannot: loader UI only |
| The visitor on a new device | full after restore | full | full |
This answers "nobody else can" truthfully: no one but the visitor and, for the site tier, the code the visitor is running at their request. It does not hide from the site's own code in the site tier, and nothing in a browser can.

**Update conflicts.** Two devices may write concurrently; the newest by total order wins and `ver` lets the client merge field by field.

**Erasure.** (1) `tombstone` removes the ciphertext from honest peers. (2) Deleting the root and every backup destroys the keys, so remaining copies cannot be read; this is crypto-shredding. (3) A `vanish` op is reserved but not defined. Section 8, Q1 on the legal status.

### 5.3 Hostile cases

Another visitor, a relay or a hub holds ciphertext at most and lacks `K_a`. A malicious owner who swaps the site code can read the site tier only after the visitor consents in the loader card; the vault stays closed, but only if `K_v` and the root are kept out of page-reachable memory (derived on demand inside loader-owned code, not a long-lived key object in IndexedDB). That is a requirement, not today's behaviour (ID F1). A weak passphrase on an exported file is the weakest link; Argon2id 64 MiB, t=3 costs about 0.1 s in WASM on an M3 (ID F7), so parameters are cheap and the passphrase matters.

### 5.4 Cross-device login and recovery

Four routes, from cheapest to most protective:

- **R1: Recovery phrase (master).** 12 BIP-39 words encode 128 bits plus a 4-bit checksum. Print, store or QR. Restore on any device, any browser, with no provider. Bytes: 16. Taps: type 12 words (the words, not taps). Browser support: all. This is ID R3.
- **R2: Encrypted file.** `mw-identity-v1` JSON with Argon2id or scrypt, salt, AEAD of root. About 150 bytes plus overhead. Offers machine-to-machine transfer through any channel.
- **R3: Passkey-wrapped seed.** Create a passkey with PRF; `get()` with a fixed per-site salt (e.g. `"mw/wrap/v1|" + ledgerId`); HKDF the 32-byte result to `wrapKey`; AES-GCM seal the root; store `{ credId, iv, ct }` in IndexedDB and in the auth block's outer wrapper (a 16-byte root yields 12 + 16 + 16 = 44 bytes, about 59 base64url characters; a 32-byte root, 60 bytes). Unlock on a new device needs that device to have the same passkey with an equal PRF output (F4); if it fails, the phrase is the fallback. Taps: create 1 prompt (plus 1 more when create-time PRF is unavailable, F3), login 1 prompt per unlock.
- **R4: QR hand-off (device to device).** New device B shows a QR with its ephemeral ECDH P-256 public key (65 bytes) and a 6-digit confirmation code derived from the key hash. Device A (signed in) scans, derives an AES-GCM key via ECDH + HKDF, seals `siteSeed` (16 or 32 bytes; sending only `siteSeed` rather than `root` limits exposure to one site), and returns the sealed blob as a QR or as an `append` in the ledger addressed to B's ephemeral key (costs one PoW fee, only works if B is already a peer of the ledger). Sealed blob about 12 + 32 + 16 = 60 bytes. Both screens show a 4-digit short authentication string; the user confirms they match to defeat a substitution by whoever sits between. Taps: scan, confirm, accept. Browser support: needs camera permission and BarcodeDetector or a JS decoder (not fetched; support varies by browser). No backend is needed, but two QR codes in sequence are the realistic no-signalling fallback.
- - **R5: Shamir cards (optional).** SLIP-39 shares of the root, 20 words per share for 128 bits [S13]. Not on the default path.
- **R6: Rotation (new idea, not in prior docs).** A `rotate` statement signed by the old site key naming the new key, or, if the old key is lost, signed by a recovery-level key `HKDF(root, info="recover|"+ledgerId)` announced at first write. This copies the AT Protocol key split (F13) and answers the Nostr gap (F11). It needs a new op; decide before the block format freezes.

**Same key on many devices.** The ledger tolerates a cloned key (`seq` is informational; ID F9, IDV claim 6). Keep one site key; skip device sub-keys unless the format enforces per-author chains.

### 5.5 Linkability

Other sites cannot link by key (F21), but can by reused name, avatar seed, style or a voluntary link statement. Peers see IP and infohash; trackers and STUN see IP, infohash and timing (network track, not here). The phrase holder can restore every site key.

### 5.6 Cost summary

Public key 93 characters (65 raw bytes); signature 86 characters (64 raw); login challenge about 330 characters (1 loader-card tap, then 0 per session); passkey proof about 250 bytes plus a 70-byte DER signature (1 biometric per login, 2 prompts first time); passkey-wrapped seed 44 to 60 bytes (PRF providers only); phrase 12 words (16 bytes); encrypted file 150 to 250 bytes; QR hand-off about 65 + 60 bytes (camera, 3 steps); sealed auth block 300 to 1,500 bytes in a 2,048-byte cap; default write fee `bits: 16`, 2^16 expected hashes. Sizes are my arithmetic; Argon2id 64 MiB t=3 about 0.1 s on an M3 is from ID F7; nothing else was timed.

---

## 6. What this means for magnet-web

### Today (true of the code now)
One P-256 key per ledger id with a self-test and JWK fallback; passphrase-wrapped export and import only in loader UI (ARCHITECTURE 6.1, 9). Keys in blocks are `p256:` tagged; `put` is last-writer-wins; `append` items carry the author; `_` keys are owner/moderator-only; `tombstone` drops `v` and `z`. The SDK has `mw.identity.setName` and `mw.ready().identity`; there is no `mw.auth`, login challenge, encrypted record, recovery phrase or PRF code. The roadmap lists the recoverable identity under 1.0 and PRF seeds under Identity v2 (ROADMAP lines 47, 103, 123).

### Upgrade (feasible with the current format)
Shared-root per-ledger keys, phrase and encrypted file; `mw.auth` login as a loader card plus pure verification; the auth block as sealed `append` items; advisory roles; passkey-wrapped seed and Option P; QR hand-off.

### Cannot (by the technology, stated plainly)
- Gate public content: nothing served by the swarm or the static host is secret from anyone who fetches it.
- Make site code unable to act as the visitor once it runs with loader privilege in the same origin (ID F1). The prompts and tiers reduce the harm; they do not remove it.
- Make PRF equal across devices, or make passkeys the only recovery path (F4).
- Erase an arbitrary peer's copy of a block. Tombstones only work with honest peers; crypto-shredding makes the old bytes unreadable but is not proven to be legal erasure (F20).
- Guarantee unlinkability against network observers (IP, timing, swarm membership). The key layer is unlinkable; the transport layer is not.
- Provide account recovery by a third party without either a backend or trusted friends holding shares.
- Provide "forgot password". If the root and every backup are lost, the identity is gone; the site can re-admit a new key only through the owner or a moderator (allow list change).
- Prevent one person holding many identities (no proof of uniqueness; hashcash is a rate fee, not a person check).

---

## 7. Recommendations (P0 to P3, effort S/M/L)

S = up to 2 days, M = 3 to 8 days, L = more than 1.5 weeks (same scale as ID section 5). Existing ID recommendations are referenced, not repeated.

| ID | Pri / effort | What | Why | Test |
|---|---|---|---|---|
| A1 | P0 / S | Decide the auth-block vs "no personal data, even encrypted" conflict (PRIVACY.md) and write the decision in PRIVACY.md and DEVIATIONS: either the block is opt-in, minimal, user-chosen content with tombstone and key-destruction steps, or it stays local-only in v0.3 | F20; summary bullet 5 | Counsel-reviewed sentence in PRIVACY.md; UI copy never says "erased" for shredding |
| A2 | P0 / M | `mw.auth.login/logout/verify` (Option C): loader-owned card, SIWE-shaped challenge with `domain`, `ledger`, `pub`, `nonce`, `iat`, `exp`, `scope`, `aud`; site-callable surface only returns the signed object | F16, F7, A4 | Wrong `aud`, wrong ledger, expired and replayed-nonce challenges all fail verification; site code cannot call it without a user gesture |
| A3 | P0 / S | Mark every login proof as a bearer token in docs; require short `exp` and per-use scope; two-message challenge-response for peer-verified features (chat, files) | F16 | Docs review; unit test that a self-issued proof is rejected where a challenge-response is required |
| A4 | P0 / M | Shared-root key derivation: `root -> siteSeed -> signKey, K_a, K_v` with distinct `info` strings and a counter for out-of-range scalars; golden vectors | F21, F17; ID R2 | Same phrase on Chromium and WebKit gives the same `p256:` key per ledger; two ledgers give unrelated keys |
| A5 | P0 / M | Auth block as sealed `append` items with AAD binding and tombstone-on-update; reject `put` for per-visitor records; size caps and errors | F17, 5.2 | Another writer cannot replace my record; wrong ledger/author AAD fails; old versions lose `v` and `z` |
| A6 | P0 / S | Verify (test, not read) that under `writers: 'open'` a second author can overwrite a `put` key and that an `append` list item is filterable by author, then add the result to ARCHITECTURE 6.5 | summary bullet 6 | Test in `test/` with two keys |
| A7 | P1 / M | Tiered decryption: loader-card-gated `mw.auth.readProfile()` for the site tier; vault tier only from loader UI; keep `K_v` and the root out of page-reachable memory | F18 | Site-origin iframe cannot read vault; site tier requires a gesture each session |
| A8 | P1 / M | Passkey-wrapped seed (ID R13) with PRF detect-and-fallback, per-credential `credId` stored, phrase remains master; include `previewSign`-free Option P as an experiment | F2 to F5 | Chromium virtual authenticator; real-device checklist (iOS Safari, Android Chrome, Windows Hello, Firefox) from ID R11 |
| A9 | P1 / M | Cross-device: QR hand-off with ephemeral ECDH, SAS confirmation, one-use expiry; manual two-QR fallback | 5.4 R4 | Two physical devices; MITM test with a substituted key shows mismatched SAS |
| A10 | P1 / S | Roles: `_roles/<hash(pub)>` advisory convention and `mw.ready().role` extension; document that the ledger does not enforce it | 5.1 | Moderator can write, visitor cannot; site code reads role |
| A11 | P1 / S | Comprehension test (5 to 8 people) of: key-loss copy, phrase backup, QR hand-off, login card | F23; ID R12 | Recorded results, copy revised |
| A12 | P2 / M | Rotation statements and a recovery-level key (R6 in 5.4); needs a new op, decide before the block format is frozen even if implemented later | F13, F14 | Lost-device test: new key accepted, old key's later writes rejected |
| A13 | P2 / L | `role` control op enforced at ingest, golden vectors, wire version bump | 5.1 | Non-owner role op is invalid |
| A14 | P2 / M | ROR support: serve `.well-known/webauthn` on the RP ID origin when a site has mirrors; document the 5-label limit and browser coverage | F5 | Chrome and Safari cross-origin passkey use |
| A15 | P3 / M | NIP-07/46 adapter (Option W) for login with an author-signed link statement | F10 to F12 | Works with one extension and one bunker |
| A16 | P3 / S | SLIP-39 cards; `did:key` display and role-grant VC export | F6, F8, F9; ID R18 | 2-of-3 restore; did:key resolves |

---

## 8. Open questions

1. **Auth block vs PRIVACY.md and the EDPB position (decision needed).** Does the owner accept an encrypted per-visitor record in a replicated ledger, given the repo's reading that encrypted personal data is still personal data? Does counsel treat destroying the key plus tombstoning as acceptable erasure? I could not read the final EDPB text; confirm paragraph references before relying on them.
2. **PRF equality across a passkey's synced devices.** No primary source proves it. Needs a two-device lab (iCloud Keychain, Google Password Manager, Windows Hello, 1Password).
3. **Firefox ROR status.** web.dev says undecided as of January 2026; one secondary source says Firefox 152 in May 2026. Check Mozilla's bug tracker.
4. **Does a normal author (non-moderator) have any write path that is safe for "my record"?** Section 5.2 assumes `append` lists are open to authors under the policy. Confirm with a test (A6).
5. **Is `grp` the right reserved name for roles?** It reads as "group". If the owner wants roles, groups for chat, and capability tokens, the control-op design should be decided once.
6. **Should the owner be able to log in from a browser?** Today the owner's private key never enters a browser. A scoped, short-lived owner delegation key (owner signs a delegation to a browser key) would allow admin from the example site without exposing the owner key, but it is a new trust object.
7. **How much of the auth block should be local only?** A local-only profile with an exportable file avoids Q1 entirely at the cost of cross-device sync.
8. **DID Core 1.1 final status** and whether `did:key` P-256 multicodec text should be cited from the DID spec registry before any copy string ships.
9. **NIST SP 800-38D, multicodec table, WebAuthn section 7.2, NIP-07 text**: cited from knowledge; fetch before quoting.

---

## 9. Sources (accessed 2026-10-20 unless noted)

| # | Source | Used for | Status |
|---|---|---|---|
| S1 | https://www.w3.org/TR/webauthn-3/ (Recommendation 2026-08-25) | status, RP ID scoping, credential id and privacy notes | fetched; body beyond first 100,000 characters not read |
| S2 | https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions | PRF create/get semantics, rotation, HKDF advice | fetched |
| S3 | https://www.corbado.com/blog/passkeys-prf-webauthn ; https://mera.category.xyz/authenticator-support/ ; https://bugs.webkit.org/show_bug.cgi?id=311099 | PRF support | search summaries; cross-checked in IDV claim 7 |
| S4 | https://web.dev/articles/passkey-related-origin-requests | ROR format, 5 labels, browser support | fetched |
| S5 | https://passkeys.dev/docs/advanced/related-origins/ ; https://ppc.land/webauthn-level-3-lets-one-passkey-cover-at-least-five-related-domains/ | ROR; Firefox 152 claim (single secondary) | search summaries |
| S6 | https://www.w3.org/TR/2026/NOTE-vc-overview-20260610/ ; https://www.w3.org/ja/news/2025/the-verifiable-credentials-2-0-family-of-specifications-is-now-a-w3c-recommendation/ | VC 2.0 Rec 2025-05-15, DID 1.1 CR | search summaries |
| S7 | https://github.com/nostr-protocol/nips/blob/master/46.md | NIP-46 | fetched |
| S8 | https://d-central.tech/nostr/key-management/ ; Bark add-on page https://addons.mozilla.org/de/firefox/addon/bark-nostr/ | signer UX, key rotation gap | search summaries; single third-party guide |
| S9 | https://atproto.com/guides/account-migration | signing vs rotation keys, migration | fetched |
| S10 | https://solidproject.org/TR/oidc ; https://github.com/solid/webid-oidc-spec | Solid-OIDC status | search summaries |
| S11 | https://eips.ethereum.org/EIPS/eip-4361 | SIWE fields and security considerations | fetched |
| S12 | https://brave.com/blog/1.60-siwe-cow/ ; https://ethereum-magicians.org/t/eip-4361-sign-in-with-ethereum/7263?page=2 | wallet domain checks, UX concern | search summaries |
| S13 | https://github.com/satoshilabs/slips/blob/master/slip-0039.md | SLIP-39 | fetched |
| S14 | https://webkit.org/tracking-prevention/ | 7-day cap, IndexedDB, Home Screen exemption | fetched |
| S15 | https://www.edpb.europa.eu/sites/default/files/webform/public_consultation_reply/gbbc-edpb-draft-guidelines-02_2025.pdf ; https://www.mondaq.com/fin-tech/1617044/blockchain-and-gdpr-edpb-guidelines-022025-adopted | EDPB 02/2025 context | search summaries; EDPB text not read |
| S16 | https://www.ece.cmu.edu/news-and-events/story/2025/03/researchers-present-at-acm-chi.html ; https://dblp1.uni-trier.de/pid/h/JasonIHong.html | CHI 2025 "Of Secrets and Seedphrases" | search summaries; paper not read |
| S17 | https://www.spark.money/research/self-custodial-wallet-ux-barriers | recovery-testing statistic (secondary, unverified) | search summary |
| S18 | https://fidoalliance.org/fido-alliance-champions-widespread-passkey-adoption-and-a-passwordless-future-on-world-passkey-day-2025/ | FIDO 2025 survey | search summary |
| Repo | `docs/ARCHITECTURE.md` 6.1, 6.2, 6.5, 9; `docs/PRIVACY.md` (impact assessments); `docs/ROADMAP.md`; `docs/research/w2c-03-identity-ux.md` (ID); `docs/research/w2c-03-identity-ux-VERIFY.md` (IDV); `src/chain/state.js` header comment | current-code claims; earlier findings | read |

Not fetched, cited from general knowledge and flagged in the text: NIST SP 800-38D, multicodec registry, NIP-07 text, WebAuthn L3 section 7.2.
