# w2c-03 - Visitor identity UX: portability, passkeys, naming, moderation experience

- **Wave / topic:** improvements-with-precedent wave, topic 3 (identity UX).
- **Date:** 2026-10-17. **Author:** research agent w2c-03 (resumed after an interruption; no earlier output existed for this topic, so the work was redone from scratch and saved incrementally).
- **Method:** primary-source reading (specs, vendor docs, GitHub issues, papers; every URL in section 8 was opened this session unless marked snippet-only) plus four local experiments (section 9, scripts and raw results archived in `docs/research/labs/w2c-03-identity-lab/`). Prior waves were read and are cited as "06", "review", "04" (see section 8, S58).
- **Limits you should know about:**
  - The shared WebSearch budget (200 per turn, all agents) ran out mid-session. Questions that needed a search and could not be answered are listed in section 7 (Firefox Related Origin Requests status, Bluesky block visibility, Signal device linking, Session/SQRL/Keybase recovery designs, CXF contents). They are marked UNVERIFIED wherever they matter.
  - Experiments ran on an Apple M3, headless Chromium 156.0.8078.4 and a Playwright WebKit 27.2 build (macOS). Firefox 157 (Playwright build) would not launch in this environment, so **Firefox is untested**. No real iPhone or Android phone was available, so **mobile timings and iOS private-browsing behaviour are unmeasured**.
  - Sources dated before 2024 are flagged "older" in the finding.
- **Confidence scale:** High = primary source read and/or reproduced here; Medium = one primary source or vendor claim not independently cross-checked; Low = search snippet, inference, or untested.
- **(*) = design-critical:** if the claim is wrong, an architecture decision or a compatibility promise (block format, identity encoding, SDK surface) would have to change.

---

## 1. Summary

**Where the repo stands.** A visitor identity is one ECDSA P-256 key pair per origin (`identity:'me'` in IndexedDB, non-extractable), shown as the first 8 hex characters of SHA-256(pub) plus a self-chosen name of at most 48 characters (ARCHITECTURE s6.1, INTERFACES `cache.js`, `src/chain/crypto.js`). There is no export, import, backup, recovery, mute, block, report, avatar or name-collision rule. If the browser drops the origin's storage, the visitor silently loses the ability to edit or delete their own posts.

**What the evidence says (details in section 3):**

1. **(*) "Non-extractable" protects against theft, not use.** In Chromium 156 a same-origin iframe opened the loader's IndexedDB, got the visitor's non-extractable key and signed arbitrary bytes as the visitor (F1). A "sign this?" prompt in the loader is not a security boundary until site code is on a different origin (review B1, 06 s3.1.9).
2. **(*) Storage is not durable.** Safari deletes script-writable storage after 7 days without interaction (Home Screen web apps exempt), eviction is all-or-nothing, and a live bug report shows iOS Safari failing to persist ECDSA `CryptoKey`s (F2, F3). A backup path is mandatory, not a nicety.
3. **(*) Portability needs a seed, not a key object.** WebCrypto cannot export a non-extractable key. A 128-bit seed -> HKDF -> per-chain P-256 scalar -> JWK import works in Chromium and WebKit; PKCS8-without-public-key works in Chromium but **throws in WebKit** (F5, lab). BIP-39 words, NIP-49-style encrypted files and SLIP-39 shares are existing serverless formats (F10).
4. **Passphrase hardening is affordable but not native.** Argon2 is **not** in the WebCrypto set Chrome 154 is shipping (F6). Argon2id 64 MiB, t=3 costs about 0.1 s in WASM on an M3 (F7), so strong parameters are cheap on desktop; mobile is unmeasured.
5. **(*) Passkeys are viable as an upgrade, not as the foundation.** WebAuthn Level 3 became a W3C Recommendation on 2026-08-25 and PRF is shipped in Chrome, Safari and Firefox, but support still varies by provider (Dashlane no, Bitwarden partial, Windows Hello only since a Feb 2026 update), a passkey is bound to an RP ID so each mirror/hub origin gets a different one (Related Origin Requests help in Chrome and Safari only), and **no source I read confirms that a synced passkey returns the same PRF output on every device** (F14-F17).
6. **A passkey cannot sign arbitrary bytes in any browser today.** The WebAuthn `sign` extension is an unmerged draft; Yubico's `previewSign` is "Early Access Only" (F18). A normal assertion with the block hash as challenge is a valid P-256 signature, but costs a biometric prompt per signature, so it only suits root delegations.
7. **(*) Short IDs and identicons are recognition aids, not authenticators.** Eight hex characters (32 bits) can be matched by brute force in about 2 hours on this laptop's 8 cores (16.8 core-hours measured rate); a Jdenticon-style image carries about 24 effective bits (measured); user studies show people miss near-match fingerprints (F25-F27).
8. **Names should follow the petname model.** Self-asserted names are "nicknames"; the visitor's local label is the "petname"; collisions are disambiguated with a key-derived suffix (Matrix does this); domain-based verification (NIP-05, atproto handles) is a v2 add-on that reuses the DoH/TXT machinery the project already has (F22-F24).
9. **Moderation UX has settled conventions:** local mute (invisible to the target) and block, subscribable owner/moderator lists that users can override, and reports treated as signals (NIP-56 warns reports "can be easily gamed") (F28-F31).

**Recommendation in one paragraph.**
*v1 ("guest identity with a recovery phrase"):* identity is created lazily on the first write; a 128-bit seed derives a per-chain key; the loader shows a plain-language "your identity lives in this browser" card, a 12-word recovery phrase (printable, QR, optional encrypted file), a restore flow, durable-storage requests and iOS guidance; names are nicknames with safe Unicode rules and collision suffixes; IDs and avatars use at least 64 bits and are never used as proof; visitors get local mute/block and a "report to owner" action; the `author` field becomes an algorithm-tagged multikey (did:key-compatible) before the block format freezes. *v2:* optional passkey protection (PRF wraps the seed; the phrase stays the master backup), DNS-verified names, subscribable moderation lists, encrypted reports, and device sub-keys with delegation if the chain enforces per-author sequences. Section 4 gives the flows and copy, section 5 the prioritised work list.

---

## 2. Baseline in the repo (what this report builds on)

| Item | Current design | Source |
|---|---|---|
| Key | ECDSA P-256, WebCrypto-generated, non-extractable, stored as CryptoKey in IndexedDB `mw-sites.identity['me']` (one per origin) | ARCHITECTURE s6.1; INTERFACES `cache.js`; `src/chain/crypto.js` |
| Author encoding | base64url of the 65-byte uncompressed point (87 chars), no algorithm tag | `src/chain/crypto.js` (`RAW_PUBLIC_KEY_BYTES = 65`) |
| UI identity | first 8 hex of SHA-256(pub) (32 bits) + optional name <= 48 chars | ARCHITECTURE s6.1, s5 |
| Name | `profile` op, last-writer-wins per author, no normalization or collision rule | ARCHITECTURE s6.1/s6.4 |
| Moderation | owner or author `tombstone`; `writers: open/owner/allow`; no deny list; no moderators; no visitor-side mute | ARCHITECTURE s6.1/s6.4 |
| Backup/restore | block export/import (JSON) only; nothing for the identity | ARCHITECTURE s6.6 |
| Entry fields | `seq` per author (informational) + `prev` DAG heads; ordering ignores `seq` | ARCHITECTURE s6.1/s6.3 |
| Prior-wave direction | Ed25519 algorithm-tagged keys, lazy creation at first write, seed export/import, self-test with seed fallback, local mute lists, owner moderation (06 F51-F53, s3.1); per-chain identity and delegated moderators (review B1, M3); sandbox cannot isolate SW-served sites (04 F11) | docs/research/06, docs/review/security.md, docs/research/04 |

Note: the 06 draft op envelope adds a strict per-author sequence `s` and previous-op hash `p`. ARCHITECTURE s6.1 does not. That difference matters for multi-device use (F9).

## 3. Findings

Source IDs (S#) are defined in section 8. Each finding gives: claim, confidence, sources, source date.

### 3.A Where the key lives: storage, misuse, algorithm, derivation

**F1 (*) Non-extractable keys block exfiltration, not use; same-origin site code can sign as the visitor.**
In Chromium 156 the loader stored a non-extractable P-256 key in IndexedDB; a same-origin iframe (`sandbox="allow-scripts allow-same-origin"`, as in ARCHITECTURE s7) opened the same database, read the key and signed attacker-chosen bytes. `exportKey` was refused (`InvalidAccessError`) but signing was not. An `allow-scripts`-only iframe got `SecurityError` on `indexedDB.open` (it also loses Service Worker control, 04 F11).
Consequences for UX: a consent dialog in the loader is not a boundary while site code shares the origin; in hub mode on one shared origin every site can sign into every other chain as the visitor (review B1); hub identities must not be persisted unless sites are origin-isolated.
Confidence: High (reproduced; also 06 F51 and review B1). Sources: S57 (lab2 section B), S58. Date: 2026-10-17 (lab); 06/review 2026-10-14.

**F2 (*) Browser storage can vanish silently; backup is mandatory.**
WebKit: ITP "deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction" (IndexedDB, localStorage, Service Worker registrations and caches included); Home Screen web apps are exempt. MDN: when an origin is evicted "all of its data, not parts of it, is deleted"; `navigator.storage.persist()` is auto-decided by heuristics in Safari and Chromium and prompts in Firefox. In headless Chromium and WebKit `persist()` returned false (no engagement history), so it cannot be assumed granted.
Confidence: High. Sources: S53, S54, S57 (lab4). Dates: WebKit page (rule introduced 2020, older), MDN current (2026).

**F3 (*) CryptoKey persistence has live failures on iOS Safari; a seed fallback is needed.**
open-chat issue #9343: `DataCloneError` when persisting an ECDSA `CryptoKeyPair` in IndexedDB, 254 occurrences from 88 IPs over five months, "almost all iOS Safari" (example Safari 26.6.1 on iOS 18.7), 5-15 per day in Oct 2026, suspected private browsing or Lockdown Mode (maintainers: unverified), no fix shipped; they list three options (fall back to Ed25519, keep ECDSA and store a JWK, or tell the user to leave private browsing). In my test Playwright WebKit 27.2 on macOS round-tripped non-extractable P-256 and Ed25519 pairs, both as a value and as an indexed property, in a normal context. So the failure is environment-specific and not reproduced here.
Confidence: Medium (live reports, no root cause). Sources: S55, S57 (lab4), S58 (06 F52). Date: 2026-10-17.

**F4 (*) Ed25519 is now universal in WebCrypto; ARCHITECTURE's "not yet universal" is stale. Choose the algorithm deliberately and tag it.**
Firefox 129 (Aug 2024), Safari 17.0, Chrome 137 (May 2025): "Ed25519 is now supported in every major browser engine" (about 79% of users at the time). P-256 remains the curve of WebAuthn ES256, did:key `zDn...` keys and the VC `ecdsa-jcs-2019` suite (F18, F21). Ed25519 verifies about 2x faster in WebCrypto (06 F47, measured there). Either is defensible; what is not defensible is an untagged 65-byte key that cannot evolve.
Confidence: High. Sources: S18, S58 (06 F47 and F50 for the verify-speed figures), S59. Date: 2025-08.

**F5 (*) Seed -> P-256 key: use JWK import. PKCS8-without-public-key is not portable.**
Lab: 32-byte seed -> HKDF-SHA256 (salt `mw/id/v1`, info per chain) -> 48 bytes mod (n-1) + 1 -> scalar; `@noble/curves` 2.4.0 `getPublicKey` equals OpenSSL's ECDH public key; JWK `{d,x,y}` imports as non-extractable and signs/verifies in Chromium 156, WebKit 27.2 and Node 24. Hand-built PKCS8 without the optional public key imported in Node/OpenSSL and Chromium (x,y matched) but **WebKit 27.2 threw `DataError`**. The browser cannot compute `x,y` from `d` by itself, so a small audited curve library is needed (noble-curves: Trail of Bits audit of v2.3.0 in Aug 2026, Cure53 of v1.6.0 in Sep 2024, plus a thin WebCrypto wrapper).
Confidence: High for Chromium/WebKit/Node; Firefox untested. Sources: S57 (lab1, lab2, lab4), S22. Date: 2026-10-17 / 2026-08.

### 3.B Passphrases and key derivation in the browser

**F6 (*) Argon2 is not in the WebCrypto set shipping in Chrome 154; browser Argon2 means WASM or JS.**
The WICG "Modern Algorithms in WebCrypto" draft (dated 2026-09-14, "unofficial proposal", no published version) contains Argon2d/i/id. Chrome's Intent to Ship (2026-09-02, shipping Chrome 154, origin trial 151-154) lists ML-KEM 768/1024, ML-DSA 44/65/87, ChaCha20-Poly1305 and X-Wing only. Mozilla's position on the draft is "neutral" (2025-08-14) and suggests WASM for bulk primitives; the proposal's author says WebKit "resolved their standard position" with support (claim in a mailing-list reply, not checked at WebKit's tracker). Options today: `hash-wasm` 4.12.0 (Argon2id v1.3, 11 kB gzipped, Chrome 57+/Safari 11+), `@noble/hashes` 2.4.0 (pure JS; its README says "Argon2 can't be fast in JS", suggests scrypt, and the Cure53 audit excluded argon2), or WebCrypto PBKDF2 (native).
Confidence: High. Sources: S14, S15, S16, S17, S21, S23. Dates: 2026-09.

**F7 Parameter choice and measured cost.**
OWASP minimums: Argon2id 46 MiB/t=1, 19 MiB/t=2, 12 MiB/t=3, 9 MiB/t=4, 7 MiB/t=5 (p=1); scrypt N=2^17, r=8, p=1; PBKDF2-HMAC-SHA256 600,000. RFC 9106: first recommended t=1, p=4, 2 GiB; second recommended t=3, p=4, 64 MiB, "suggested as a default setting for memory-constrained environments". NIP-49 leaves scrypt `log_n` to the implementer (16 = 64 MiB about 100 ms; 20 = 1 GiB about 2 s). Measured here (M3, one thread): Argon2id WASM 19 MiB/t=2 18 ms; 46 MiB/t=1 25 ms; **64 MiB/t=3 103-119 ms** (Chromium) and 121 ms (WebKit); 128 MiB/t=1 75 ms; 256 MiB/t=1 162-172 ms; Argon2id noble-JS 19 MiB/t=2 100-113 ms; scrypt noble-JS N=2^15 66 ms, 2^16 129 ms, 2^17 257 ms; PBKDF2 600k 43 ms (native). Mobile not measured.
Confidence: High (desktop), Low (mobile). Sources: S19, S20, S24, S57 (lab2, lab4). Dates: OWASP current, RFC 2021 (older), lab 2026-10-17.

**F8 Human-chosen passphrases are the weak link, so prefer a generated phrase.**
BIP-39: entropy 128-256 bits in 32-bit steps (128 bits = 12 words, 256 bits = 24 words), checksum = first ENT/32 bits of SHA-256, 11 bits per word (2048 words), and its seed derivation is only PBKDF2-HMAC-SHA512 with 2048 iterations (not a hardening step). The `@scure/bip39` 2.4.0 test in the lab produced 12 words from 16 bytes of entropy. A passphrase should only encrypt an exported file (NIP-49 pattern: scrypt, XChaCha20-Poly1305, NFKC-normalised password, 91-byte payload, key-security byte), never be the only secret protecting a published identity.
Confidence: High (formats), Medium (recommendation is inference). Sources: S24, S25, S57 (lab). Date: spec text current.

### 3.C Portability, pairing, recovery, and what users understand

**F9 (*) The same key on two devices is a protocol question, not just a UI one.**
Secure Scuttlebutt feeds are linear: two devices posting with one identity reuse sequence numbers with different content, peers reject the feed, and clients tell users not to share the secret across devices; later designs (`sameAs`, fusion identity) give each device its own key plus consent/proof messages and a tombstone for a lost device (search snippets and 06 F34; the primary SSB pages were not opened). ARCHITECTURE s6.1 uses a DAG with an informational `seq`, so cloning a key does not break validity. The 06 draft adds `s` (strictly +1) and `p` (previous op of the same author), which **would** fork on a cloned key. If that envelope is adopted, "import the same phrase on a second device" must either create a derived device key with a root-signed delegation, or be documented as one-device-at-a-time.
Confidence: Medium. Sources: S58 (06 F34, s3.1.2), S59, S60. Date: 2026-10-14.

**F10 Serverless export formats already exist.**
NIP-49 `ncryptsec` (scrypt + XChaCha20-Poly1305, password NFKC-normalised, 91-byte payload bech32-encoded), BIP-39 12/24 words with checksum, SLIP-39 Shamir shares (1024-word list, 10 bits per word, 20-word shares for 128-bit secrets and 33 words for 256-bit, RS1024 checksum detecting up to 3 wrong words, optional passphrase with plausible deniability).
Confidence: High. Sources: S24, S25, S26. Date: current spec text.

**F11 QR / short-code hand-off precedents.**
Magic Wormhole: SPAKE2 PAKE, a one-time code such as `7-crossover-clockwork` (default 16 bits, a rendezvous mailbox attacker gets "a single guess", 1 in 65,536), WebSocket mailbox, end-to-end encrypted transit relay. Matrix QR login (MSC4108) is still an open proposal ("proposed-final-comment-period", HPKE channel, rendezvous endpoint, "no production implementations"). NIP-55's web flow returns results via callback URL or clipboard and pops a prompt for every request ("consider using NIP-46 for web applications"). For magnet-web a hand-off could ride the existing tracker/WebRTC path, but I found no precedent that does so (design idea, not evidence).
Confidence: Medium. Sources: S27, S28, S31. Dates: Wormhole docs current; MSC snapshot 2026.

**F12 Social recovery exists, mostly for money.**
Vitalik (2021, older): a signing key plus guardians who can change it by majority, guardians at least 3 (he favours 7+), guardian changes by the signing key only after a delay of 1-3 days, guardians drawn from different circles. Apple's Recovery Contact (published 2026-09-14): up to five contacts, a contact can give a six-digit code but "won't have any access to your account". For a comment-site guest identity this is probably over-engineering; keep it as an optional v2+ "recovery kit" using SLIP-39 cards.
Confidence: Medium. Sources: S51, S52, S26. Dates: 2021-01-11 (older); 2026-09-14.

**F13 There is no study of "your key lives in this browser"; adjacent research says plan for misunderstanding.**
CHI 2025 "Of Secrets and Seedphrases" (20 interviews, 643 survey respondents): 43.4% could recognise an image of a seed phrase, about 58% of those believed they could choose or reset one, and 52% thought username+password would move a wallet to a new device (figures from search snippets; the paper page returned 403, so unverified at source). Passkey studies (snippets only) report confusion about sync and worry about lost devices. Corbado, on PRF: "If the passkey is gone, the encrypted data is gone with it, permanently."
Confidence: Low-Medium. Sources: S2, S60. Date: 2025 (CHI), 2026-09-29 (Corbado).

### 3.D Passkeys and WebAuthn

**F14 (*) WebAuthn Level 3 is a W3C Recommendation (2026-08-25); PRF and Related Origin Requests are present in Chromium and WebKit builds.**
The W3C header reads "W3C Recommendation, 25 August 2026" (`REC-webauthn-3-20260825`). Corbado (status checked 2026-09-28) says a PRF hardening change "tightens an extension that Chrome, Safari and Firefox already ship". Lab: `PublicKeyCredential.getClientCapabilities()` reports `extension:prf: true` and `relatedOrigins: true` in Chromium 156.0.8078.4 and in the Playwright WebKit 27.2 build; Firefox could not be launched.
Confidence: High (spec status, two engines tested), Medium (Firefox). Sources: S5, S3, S57 (lab2, lab4). Dates: 2026-08-25, 2026-09-28.

**F15 (*) PRF support is real but uneven; treat it as an enhancement.**
Reported matrix (vendor-sourced, cross-checked only against Yubico's older table and my capability-flag lab):

| Platform / browser | Provider | PRF status | Source and date |
|---|---|---|---|
| macOS 15+, Safari 18+; Chrome 132+; Firefox 139 | iCloud Keychain (Apple Passwords) | works (create and get) | Yubico mid-2025; Corbado 2026-09-29 |
| iOS/iPadOS 18.4+ Safari (all iOS browsers use WebKit) | iCloud Keychain | works; 18.0-18.3 had bugs that could cause data loss when used as a cross-device authentication source | Corbado 2026-09-29 |
| Android Chrome/Edge/Samsung Internet | Google Password Manager | PRF by default; Firefox Android 149+ (March 2026) | Corbado 2026-09-29 |
| Windows 11 24H2/25H2 | Windows Hello | lacked hmac-secret until a Feb 2026 update; then Chrome/Edge 147+ (create) and Firefox 148+ | Yubico mid-2025 (no); Corbado (yes) |
| any | 1Password | works (Chrome 150 test); a June 2026 community thread (snippet) reports a regression returning a plain Array | Corbado; search snippet |
| any | Bitwarden | partial (no PRF on macOS 26.3 + Chrome 151; 100% get on Linux Firefox, 29% Android, 0% iOS Safari) | Corbado |
| any | Dashlane | no (tested again Aug 2026) | Corbado |
| iOS Safari + security keys | YubiKey etc. | needs iOS 26.4+; WebKit bug 314934 returns null for some keys | Yubico (no, mid-2025); Corbado |
| Safari cross-device (QR/hybrid) | any | PRF not supported in Safari's cross-device flow on 18.0.1, partly fixed 18.2 (Apple forum snippet) | search snippet only |

Corbado's own caveats: a capability flag is not a guarantee (some registrations returned no PRF result), create and get are separate capabilities, the same manager behaves differently per platform, and "treat PRF as an enhancement, not a dependency".
Confidence: Medium. Sources: S1, S2, S3, S60. Dates: 2025-06 to 2026-09.

**F16 (*) PRF semantics that shape the design.**
Per-credential 32-byte secret; evaluation points are hashed with a fixed prefix; access is enforced by RP ID; the secret is constant per credential, so nonces must be unique; two inputs (`first`, `second`) support rotation (explainer, MDN). Lab (Chromium 156, CDP virtual CTAP2 authenticator with `hasPrf`): `create({prf:{}})` returned `enabled:true` with **no results**; `get({prf:{eval:{first:salt}}})` returned 32 stable bytes; a different salt gave a different value; `second` returned what `first` returns for the same salt; a second credential with the same salt gave a different secret. So: evaluate at `get()`, never rely on create-time results, derive per-purpose keys with HKDF, and expect credential deletion to destroy the derived key.
**Not established by any source I read: whether a synced passkey (iCloud Keychain, Google Password Manager, a third-party manager) yields the same PRF output on every device.** The explainer, MDN, Yubico and Bitwarden pages do not say, and the virtual authenticator cannot test it. Any "phrase-free multi-device identity" depends on this and must be verified on real devices before it is promised.
Confidence: High (semantics, lab), UNVERIFIED (sync equality). Sources: S6, S7, S10, S57 (lab2 section D). Dates: undated specs; 2025-02-05 (Bitwarden); 2026-10-17.

**F17 (*) A passkey belongs to an RP ID, so mirrors and hubs mean different identities unless Related Origin Requests are set up.**
The RP ID is a registrable-domain suffix of the page origin. ROR lets other origins use it by publishing `https://<RP ID>/.well-known/webauthn` (no `.json`, `application/json`, `{"origins":[...]}`); Chrome counts at most 5 distinct eTLD+1 labels and ignores the rest; a browser without support throws `SecurityError`. web.dev: supported in Chrome and Safari; "As of January 2026, Firefox is still considering the feature." Firefox 152 release notes (2026-06-16) do not mention WebAuthn or related origins, so a third-party claim that Firefox 152 shipped ROR is unsupported. Treat Firefox ROR as unshipped.
Consequence: for magnet-web, where the same site can be loaded from its own domain, a hub, or a mirror, a passkey-based identity is per origin unless the owner of the RP ID domain lists the others (acceptable for a hub operator, impossible for arbitrary mirrors).
Confidence: High (Chrome/Safari), Medium (Firefox). Sources: S4, S13, S57 (lab4). Dates: web.dev page last updated 2024-08-22 with a Jan 2026 Firefox note; Firefox 152 notes 2026-06-16.

**F18 (*) No browser can sign arbitrary bytes with a passkey today, but an assertion over a chosen challenge is a valid P-256 signature.**
The WebAuthn `sign` extension is PR #2078, an open draft (milestone L4, "at risk for L3", Yubico author; Sept 2024: "No commitments from other WG participants"; comments to July 2026; no Chrome, Apple or Mozilla comments on the page). Yubico's `previewSign` (YubiKey firmware 5.8, algorithm `ARKG_P256_ESP256` id -65539) is "Early Access Only ... Do not use this in production". Meanwhile smart-contract wallets verify ordinary WebAuthn assertions on-chain: `base/webauthn-sol` takes `challenge`, `authenticatorData`, `clientDataJSON`, `r`, `s` and the P-256 public key, with the challenge embedded in `clientDataJSON` as base64url (it uses the RIP-7212 precompile when available). So a verifier can accept "passkey signed this block hash" without any new browser API, at the cost of one user-verification prompt per signature and an assertion of roughly 200+ bytes per block. That fits a one-off root delegation, not every post.
Confidence: High (API gap), Medium (design). Sources: S8, S9, S12. Dates: 2026 (Yubico page), 2024-05 to 2026-07 (PR), current (repo).

**F19 Moving passkeys between providers.**
FIDO publishes a Credential Exchange Protocol/Format (CXP/CXF) "to transfer all types of credentials" between managers, but the page I could open has no maturity, dates or scope, and I could not confirm whether PRF (hmac-secret) material is included. If it is not, a provider switch silently changes every PRF-derived key.
Confidence: Low. Sources: S60 (FIDO page fetched, no detail). Date: unknown.

### 3.E External signers and interoperable identifiers

**F20 NIP-07 ("sign in with Nostr") is a desktop-extension API with a signature-scheme mismatch; use it only as a linking statement.**
NIP-07 is labelled `draft` and `optional`: `async window.nostr.getPublicKey()` returns hex, `async window.nostr.signEvent(event)` adds `id`, `pubkey` and `sig`; `nip04` (deprecated) and `nip44` encrypt/decrypt are optional; extensions should use `"run_at": "document_end"`. The page does not name the signature scheme; Nostr events are BIP-340 Schnorr over secp256k1 (read in NIP-01 by the 06 agent), which WebCrypto does not provide, so a Nostr key cannot sign P-256 (or Ed25519) blocks. Mobile: NIP-55 (Android signer app) works from web pages only through a `nostrsigner:` URL with callback URL or clipboard, with "the user sees a popup for every request"; NIP-46 (remote signer) runs over relays (kind 24133, NIP-44-encrypted; methods `connect`, `sign_event`, `get_public_key`, `ping`, `switch_relays`, `logout`; bunker:// and nostrconnect:// URIs), which would add a third-party WebSocket dependency. `nostr-login` wraps extension, NIP-46, read-only and a locally generated key behind `window.nostr`; its TODO list still includes "Amber support". Conclusion: at most an opt-in desktop "link my Nostr identity" statement signed once (the event kind to use is not settled; I did not verify one).
Confidence: High (specs), Medium (integration idea). Sources: S29, S30, S31, S32, S58 (06 F6). Dates: current spec text; 06 2026-10-14.

**F21 (*) did:key and Data Integrity give a standards-aligned way to name and (later) attest the identity key; tag the `author` encoding now.**
did:key v0.9: multicodec `p256-pub` is `0x1200` with a 33-byte compressed key (ed25519 `0xed` 32 bytes, secp256k1 `0xe7` 33 bytes); the identifier is multibase base58-btc (`z`), which yields the familiar `did:key:zDn...` prefix for P-256; "a purely generative method, which means that updates are not supported" (no rotation, no revocation); long-term use without an HSM is "strongly discouraged"; reusing one identifier across verifiers enables correlation. DID Core 1.0 is a Recommendation (2022-07-19). The W3C Data Integrity ECDSA Cryptosuites v1.0 (Recommendation, 2025-05-15) define `ecdsa-jcs-2019`: JCS (RFC 8785) canonicalisation, SHA-256, ECDSA P-256, a 64-byte proof, base58-btc multibase proof value, and Multikey codes `0x1200`/`0x1201` only. magnet-web's block already is "JCS + SHA-256 + P-256 raw r||s"; only the wrapping differs. Cheap, compatible choices: store `author` as a self-describing multikey (so a second algorithm can coexist) and show a copyable `did:key` string in the identity panel. Because did:key cannot rotate, rotation has to be an application-level link (signed statement from the old key), not a did:key feature.
Confidence: High. Sources: S34, S35, S36. Dates: spec v0.9 (undated), 2022-07-19, 2025-05-15.

### 3.F Names, short IDs and avatars

**F22 Petnames: keep three layers and never present a nickname as if it were trusted.**
Stiegler: a key is global and unique but not memorable; a nickname is chosen by the owner, memorable, not unique, and is only "a proposal"; a petname is the user's private, unique, memorable name for a key, "a bidirectional one-to-one mapping to a key". "The security of a petname system depends on the keys to prevent forgery, and on the petnames to prevent mimicry"; the UI must separate nicknames from petnames and warn when a new petname resembles an existing one. Matrix applies the same idea: when a display name is not unique among joined or invited members it "should be disambiguated using the user id, for example display name (@id:homeserver.org)".
Confidence: High. Sources: S40, S38. Dates: 2005/2010 (older, still the standard reference); Matrix spec current.

**F23 DNS-based verification patterns to reuse in v2.**
NIP-05: `/.well-known/nostr.json?name=` returns hex keys; local part `a-z0-9-_`; CORS `*`; MUST NOT redirect; "not intended to verify a user, but only to identify them"; clients keep the public key as the primary reference and, if the address later resolves to another key, "stop displaying the address as valid". atproto handles: either a DNS TXT at `_atproto.<handle>` with `did=<DID>` or `https://<handle>/.well-known/atproto-did`; the link must be confirmed in both directions; `handle.invalid` marks "no bi-directionally valid handle"; unverified content should still display "possibly with a contextual note or warning indicator". magnet-web already resolves TXT over DoH (docs/research/05), so a `_mw-id.<domain>` record (or well-known file) that names an identity key, plus an identity-signed statement naming the domain, is incremental. ENS-style on-chain names were not researched and would add a chain RPC dependency.
Confidence: High (patterns). Sources: S33, S37, S58 (05). Dates: current spec text; 05 2026-10-14.

**F24 Display names need Unicode rules that ARCHITECTURE does not state.**
UTS #39 v18.0.0 (2026-08-27) defines restriction levels (ASCII-Only, Single Script, Highly Restrictive, Moderately Restrictive - "Latin and any one other Recommended script, except Cyrillic, Greek" - Minimally Restrictive, Unrestricted), mixed-script detection and `skeleton(X)` (NFD, remove default-ignorable code points, map to prototypes, NFD again). A skeleton is "intended only for internal use for testing confusability" and "should definitely not be used as a normalization of identifiers". ARCHITECTURE s6.1 only caps `name` at 48 characters. Names set by any anonymous visitor therefore need: normalisation, rejection of control/format characters (including bidirectional controls), a restriction-level gate, and a confusable comparison against names already in the chain and against the owner's name.
Confidence: High (spec), Medium (the gap is my reading of s6.1). Sources: S41, S59. Date: 2026-08-27.

**F25 (*) Eight-hex IDs (32 bits) are forgeable on a laptop in hours.**
Measured on the M3: OpenSSL P-256 key generation 71,140 keys/s/core (WebCrypto `generateKey` in Chromium 43,031/s; a naive pure-JS "add G, hash" loop 26,730/s). Matching a chosen 32-bit prefix of SHA-256(pub) therefore costs 2^32 / 71,140 = 16.8 core-hours (about 2.1 hours on 8 cores). At an assumed 10^9 candidates/s (GPU-class; an assumption, not measured) the costs are 4.3 s for 32 bits, 78 hours for 48 bits and 5.1 million hours for 64 bits. Birthday collisions between honest visitors reach 50% at about 77k identities (32 bits), 19.8M (48 bits), 5.06 billion (64 bits). An attacker who matches the short ID also matches any avatar derived from it.
Confidence: High (arithmetic and measured rate), Medium (attacker rate). Sources: S57 (lab1). Date: 2026-10-17.

**F26 (*) People do not reliably detect near-match fingerprints; avoid asking them to.**
Dechand et al. (USENIX Security 2016, older; 1,047 participants; attacker controls 80 of 112 bits): hexadecimal left 10.1% of attacks undetected, a numeric form detected 93.57%, generated sentences 97.97% (failure under 3%). Tan et al. (CHI 2017, older; 661 participants; a 2^60-strength attacker): sentences 6% missed, hexadecimal 21%, unicorn images 54%, "compare-and-select" 72%; graphical forms were fast (median 2.0 s for unicorns vs 8.0 s for hex) but inconsistent; the authors recommend removing the human from the loop (for example camera comparison). Implication: owner-key changes, moderator grants and ban confirmations should use copy/QR machine comparison or word-encoded IDs, not avatars or short hex.
Confidence: High (studies), Medium (transfer to this UI). Sources: S42, S43. Dates: 2016, 2017 (older).

**F27 Identicons carry about 24 bits and have friendly licences.**
Jdenticon 3.3.0 (MIT, canvas or SVG, browser and Node): 200,000 random SHA-256 inputs produced 198,564 distinct SVGs in run 1 and 198,550 in run 2 (1,436 and 1,450 collisions), which corresponds to about 23.7 effective bits; 50% collision odds among roughly 4,300 visitors, and an icon match can be brute-forced in seconds. DiceBear: library code MIT; 42 styles under CC0 (including Identicon, Shapes, Rings, Thumbs, Initials, Pixel Art), 14 under CC BY 4.0 (attribution required), 1 MIT, 4 under artist terms. Use avatars for recognition only; a tiny in-repo generator avoids a dependency and any attribution duty.
Confidence: High (measured, licence page). Sources: S44, S45, S57 (lab3). Date: 2026-10-17.

### 3.G Moderation experience

**F28 Local mute and block follow stable conventions.**
Mastodon: mute hides a user from your view, "The user has no way of knowing they have been muted", can expire; block also removes follow relations in both directions and the blocked user sees the effect. Matrix: an ignored user's events are no longer delivered "with the exception of state events", and invites from ignored users are not delivered (`m.ignored_user_list` in account data). Nostr NIP-51: a mute list (kind 10000) holds `p`, `t`, `word`, `e` items; private entries are NIP-44-encrypted in `content`. For a client-only system the natural form is a per-chain list in IndexedDB that never leaves the device, optionally included in the encrypted identity backup, and applied by the loader before data reaches site code.
Confidence: High. Sources: S46, S39, S48. Dates: current docs.

**F29 Layered, subscribable moderation beats a single authority; shared lists are imperfect.**
Bluesky (2023-04-13): network takedowns as a baseline, server-level admin filters, and user-chosen label sets ("shared mute/block lists"); "Moderation should be a composable, customizable piece that can be layered into your experience." Jhaver et al. (ACM TOCHI 2018, older; interviews with Twitter blocklist users and blocked people): users "are not adequately protected from harassment", many blocked people "feel that they are blocked unnecessarily and unfairly", and users do not agree on what harassment is; Pew 2017 figure cited there: 41% of US adults had experienced online harassment. For magnet-web: owner and delegated-moderator lists as defaults a visitor can override, with a visible "hidden because ..." reason and an undo.
Confidence: High (sources), Medium (transfer). Sources: S49, S50. Dates: 2023-04-13, 2018 (older).

**F30 Reports in a public replicated log are public unless encrypted, and are signals not triggers.**
Mastodon's report modal asks for a note ("can (and should)"), optional example posts, and offers to forward the report to the remote server's moderators. Nostr NIP-56 reports are public kind-1984 events with types `nudity`, `malware`, `profanity`, `illegal`, `spam`, `impersonation`, `other`, and the NIP says "It is not recommended that relays perform automatic moderation using reports, as they can be easily gamed." In magnet-web a report appended to the chain is visible to every peer; with free Sybil keys (review M1) report counts are cheap to fake. Encrypting a report to the owner is possible with WebCrypto ECDH P-256 + HKDF + AES-GCM, but needs a separate encryption key published by the owner (an ECDSA signing key cannot be reused for ECDH).
Confidence: High (patterns), Medium (encryption design, inference). Sources: S46, S47, S58 (review M1). Dates: current docs; review 2026-10-14.

**F31 The owner side is thin today.**
ARCHITECTURE has owner or author tombstones and a `writers` mode, but no deny list, no moderator role, no queue and no way for a visitor to see why something is hidden. The review already asks for `Policy.moderators` (M3) and a new-author cost (M1: first block from an unknown author must meet `bits + 6`); 06 proposes `mod.*` ops with owner-sequence precedence. Identity UX work should plug into those rather than add parallel mechanisms.
Confidence: High (reading of the repo docs). Sources: S58, S59. Date: 2026-10-14.

---

## 4. Recommended identity UX

### 4.1 Options considered

| Option | Mobile | Serverless | Survives clearing data | Survives provider loss | Site-code theft resistance | Effort | Verdict |
|---|---|---|---|---|---|---|---|
| A. Device-bound non-extractable key only (today) | yes | yes | no | n/a | use yes, theft yes (F1) | done | replace; fails F2/F3 |
| B. Random seed + recovery phrase / encrypted file | yes | yes | yes, if backed up | n/a | low (seed readable by same-origin code) | M | **v1** |
| C. Identity derived directly from passkey PRF | iOS/Android yes, Windows partly | yes | yes (while the passkey exists) | no: credential loss = identity loss | good (prompt per use) | M | not as sole path (F15, F16) |
| D. Seed wrapped by a PRF-derived key, phrase kept | same as C | yes | yes | yes (phrase) | good | M | **v2** |
| E. External signer (NIP-07/46/55) | desktop only; relays for NIP-46 | no for NIP-46 | yes | depends | good | M | link statement only (F20) |
| F. Device sub-keys + root delegation | yes | yes | yes | yes | medium | L | only if per-author chains are enforced (F9) |

### 4.2 v1: "guest identity with a recovery phrase"

States (each is a visible, labelled state in the identity panel):
1. **Reader.** No key exists. No prompts. Reading, seeding and viewing never create an identity (matches 06 s3.1.1 and review recommendation).
2. **Guest.** Created on the first write attempt. The visitor sees a one-line inline step ("Posting as a new guest. Name (optional)"), not a modal wall. Behind it: 16 random bytes -> HKDF -> per-chain scalar -> JWK import (non-extractable) -> write to a dedicated key store -> read back and sign/verify a probe (the 06 F53 self-test); on any failure keep the seed only and import per session.
3. **Backed up.** After the first successful post a non-blocking card appears. Suggested copy to test: *"Your identity is a secret key kept in this browser. It is not stored on any server. If this site's data is cleared (Safari does this after a week without a visit), you will not be able to edit or delete your posts. Save a recovery phrase to keep control. [Save recovery phrase] [Later]"*
4. **Save flow.** Show 12 words (BIP-39 English list used only as an encoding, checksum included), with Copy, Print, QR, and "Download encrypted file" (optional passphrase; Argon2id 64 MiB, t=3, p=1 in WASM, or scrypt N=2^16 in noble; XChaCha20-Poly1305 or AES-GCM; NIP-49-shaped payload). Then a 3-word re-entry check. The warning text: *"Anyone with these words can post as you. Do not reuse them anywhere else. We cannot recover them for you."* The SDK and site code never see the phrase; this UI runs in the loader frame after a user gesture.
5. **Restore.** "Use an existing identity": paste phrase, scan QR, or load file. Result is the same public key for that chain. Copy: *"Use one device at a time unless the site says otherwise."* (see F9).
6. **Manage.** Identity panel: avatar, name, short ID (compact), full 64-bit ID and copyable `did:key` (details), "Last saved: never/date" (a local flag), "Storage: protected / not protected" from `navigator.storage.persisted()`, "Forget this identity on this device" with a destructive confirmation that says what is lost.

Durability behaviour: request `navigator.storage.persist()` at identity creation from a user gesture (Firefox prompts); on iOS Safari outside a Home Screen app show the 7-day warning and, once the visitor has posted, suggest Add to Home Screen; never claim durability; show `persisted` truthfully.

Identity scope: one derived identity per chain id (review recommendation), one phrase restores all of them; shared-origin hub mode does not create persistent identities (F1, review B1). Because the seed has to stay recoverable for a later "Save recovery phrase", it lives in the loader origin's IndexedDB and is readable by any script in that origin. In per-domain mode that origin belongs to the site's publisher, so the exposure is to the publisher and to XSS; say so in the privacy copy ("the site you are on can act as you"). Option D in v2 (passkey-wrapped seed) is what removes silent access.

Naming and display:
- The visitor's chosen name is a **nickname**; a local **petname** ("rename for me") overrides it on this device and keeps the original visible in a secondary line.
- Identical nicknames render with a key-derived suffix, Matrix-style: `Alex (7F3A)`. The owner and moderators get an owner-signed badge, which is the only authoritative marker.
- Compact UI shows name + avatar + 4-character suffix (20 bits; disambiguation only). Details view shows 64 bits (13 base32 characters) and the full multikey/did:key with a copy button and QR. Avatars derive from the 64-bit hash and are labelled "for recognition".
- Name input rules: normalise (NFC), reject control, format and bidirectional-control characters, cap by code points and bytes, apply a restriction-level gate and a skeleton comparison against names already in the chain (UTS #39); show "looks like <existing name>" instead of silently accepting.

Moderation for visitors:
- Per-post menu: **Mute** ("You won't see this person on this device; they aren't told"), **Block** (mute + hide replies to them), **Report** (category from the NIP-56 list + optional note up to a few hundred characters), **Copy author ID**.
- Hidden items leave a placeholder ("1 post hidden: you muted this author. Show once / Undo"). Lists are per chain in IndexedDB, never gossiped, included in the encrypted backup file.
- Reports in v1 are appended to a reserved `reports` list on the chain (public to peers, counted as signals). Owner Settings -> Moderation shows reports grouped by target with reporter count, and offers Tombstone, Hide author (when a deny/ban op exists) and Make moderator (when delegated moderators exist). The UI says reports are visible to other visitors.

### 4.3 v2: "passkey-protected, verifiable, shareable moderation"

1. **Protect with passkey (optional, feature-detected).** If `getClientCapabilities()` reports `extension:prf`, create a passkey (RP ID = site host or hub), run a `get()` with a fixed salt to obtain 32 bytes, derive a key-encryption key with HKDF, and wrap the seed with AES-GCM. The phrase stays the master backup (F15, F16: capability flags are not guarantees, deletion destroys the key). Benefit: a hostile same-origin script can no longer sign silently, because unlocking needs a visible user-verification prompt (inference from the WebAuthn model; not tested).
2. **Phrase-free restore on a new device (only after real-device verification).** Publish the wrapped seed as an encrypted record in the chain, found via the passkey's discoverable `userHandle`; a new device with the synced passkey reads it, evaluates PRF, unwraps. This depends on the unverified assumption that a synced passkey returns the same PRF output on every device (F16) and on identical RP ID across origins (F17). Treat as a prototype, not a promise.
3. **Device sub-keys with delegation** if the final chain enforces per-author sequences (F9): each device holds its own key; the root (phrase-derived or passkey assertion over the block hash) signs a delegation; lost devices are revoked by a root-signed tombstone.
4. **Verified names**: identity-signed statement plus `_mw-id.<domain>` TXT (or well-known file) naming the key, checked bidirectionally through the existing DoH path, shown as "verified: example.com" with an explicit "no longer verified" state (atproto/NIP-05 patterns, F23).
5. **Subscribable moderation lists**: owner and moderators publish signed lists; visitors subscribe by default for the site they are on, can unsubscribe, and always see "hidden by <list>" with undo (F29).
6. **Encrypted reports**: owner publishes an ECDH P-256 encryption key in the policy; reports become ciphertext only the owner can read (F30).
7. **Optional recovery kit**: SLIP-39 shares as printable cards for people who want social recovery (F12).
8. **Interop extras**: `did:key` export, an opt-in desktop "link my Nostr key" statement (F20), and VC-style signed attestations using the same JCS + P-256 primitives (F21).

---

## 5. Concrete recommendations for magnet-web

Effort: S = up to 2 days, M = 3-8 days, L = more than 1.5 weeks. Priority: P0 = before a public v1, P1 = v1.x, P2 = v2, P3 = later or optional. "Test" is the acceptance check.

| ID | Priority / effort | What to build or change | Why (findings) | Test |
|---|---|---|---|---|
| R1 | P0 / M | Make `author` a self-describing multikey (multibase `z` + multicodec varint + compressed key, `did:key`-compatible) and keep the `v` field; decide P-256 vs Ed25519 explicitly and document why (P-256 if passkey roadmap is real); lengthen displayed IDs to 64 bits in details, 20-bit suffix only for disambiguation | F4, F21, F25 | Unit: encode/decode round trip for both algorithms; a block with an unknown algorithm tag is rejected with a stable reason |
| R2 | P0 / M | Replace bare `generateKey` with seed-derived identity: 16-byte CSPRNG seed -> HKDF-SHA256 (salt `mw/id/v1`, info with chain id) -> scalar -> JWK `{d,x,y}` import via an audited curve library (noble-curves) -> dedicated key store (not a property of an indexed record) -> read-back sign/verify self-test -> seed fallback. Create lazily at the first write | F3, F5, 06 F53 | Lab1/lab4 pass in CI on Chromium and WebKit; kill the key store and confirm restore from the phrase reproduces the same public key |
| R3 | P0 / L | Backup and restore: 12-word phrase (BIP-39 list as encoding), print, QR, optional encrypted file (Argon2id 64 MiB t=3 p=1 via hash-wasm, or scrypt N=2^16 via noble; authenticated encryption; NFKC-normalised passphrase; NIP-49-shaped payload), re-entry check, restore from phrase/QR/file | F2, F7, F8, F10 | Round-trip on three devices; a wrong word is caught by the checksum; the file decrypts on a second browser |
| R4 | P0 / S | Durability UX: call `navigator.storage.persist()` at identity creation from a user gesture, show `persisted()` truthfully, "last saved" local flag, iOS 7-day warning and Add-to-Home-Screen hint after the first post | F2 | Manual iOS Safari tab vs Home Screen 7-day run; UI never says "safe" when `persisted()` is false |
| R5 | P0 / M | Name and ID hygiene: NFC, reject control/format/bidi characters, code-point and byte caps, UTS #39 restriction-level gate and skeleton comparison against names already in the chain, petname override, `Name (xxxx)` suffix, tiny in-repo avatar generator seeded from at least 64 bits, "for recognition" label. Never use name/avatar/short ID in a security decision | F22, F24, F25, F26, F27 | Fuzz names with mixed scripts and bidi controls; two keys with equal names render distinct suffixes |
| R6 | P0 / M | Local mute/block per chain: IndexedDB store, SDK `mw.identity.mute/unmute/isMuted/mutes`, `db.list` hides muted authors by default with a placeholder and Undo, never gossiped, included in the encrypted backup | F28 | Muted author's items never reach site code unless "Show once"; list survives restore |
| R7 | P0 / S | Gate persistent identities on origin isolation: no persistent identity or export in shared-origin hub mode; per-domain mode and wildcard-subdomain hubs are fine; show the reason in the UI | F1, review B1 | Hub on a shared origin offers read-only plus a pointer to an isolated URL |
| R8 | P1 / M | Reporting and owner queue: `mw.report(hash, category, note)` appends to a reserved list (NIP-56 categories), per-author rate limit, grouped view in Settings -> Moderation (unique reporters, not raw counts), actions Tombstone / Hide author / Make moderator as the chain gains deny and moderator ops; copy says reports are visible to other visitors | F30, F31, review M1/M3 | Reports never auto-hide content; 100 reports from fresh keys do not change visibility |
| R9 | P1 / S | Decide multi-device semantics now: keep `seq` informational and drop any per-author linear chain, or adopt device sub-keys. Document "one device at a time" if cloning is allowed | F9 | Import the phrase on a second profile, post from both, confirm no rejected blocks |
| R10 | P1 / S | Doc fixes: ARCHITECTURE s6.1 "Ed25519 not yet universal" is stale; `identity` store per chain id; SDK surface additions; record deviations in DEVIATIONS | F4, review | Docs diff reviewed |
| R11 | P1 / S | Tests: add WebKit to the identity unit/e2e matrix (labs 1-4 are ready), a Chromium virtual-authenticator PRF test, and a real-device checklist: iOS Safari normal/private/Home Screen/Lockdown, Android Chrome, Firefox desktop and Android, same-PRF-on-two-devices | F3, F14, F16 | CI green on Chromium and WebKit; checklist results appended to this file |
| R12 | P1 / S | Comprehension test of the key-loss copy and the backup flow with 5-8 people; define targets before launch (for example: share of identities with 2+ posts that have a saved backup, restore success rate) | F13 | Findings recorded; copy revised |
| R13 | P2 / M | "Protect with passkey": feature-detect PRF, create passkey, `get()` with fixed salt, HKDF, AES-GCM-wrap the seed; phrase remains master backup; fall back silently when PRF is absent | F15, F16 | Works in Chromium virtual authenticator; graceful on Dashlane/Bitwarden-style no-PRF |
| R14 | P2 / M | Verified names via DoH: `_mw-id.<domain>` TXT or well-known file plus identity-signed statement, bidirectional check, "no longer verified" state | F23 | Stubbed-resolver tests mirroring 05's matrix |
| R15 | P2 / M | Subscribable owner/moderator lists with "hidden by <list>" and undo | F29 | A visitor can opt out and sees the reason |
| R16 | P2 / M | Encrypted reports: owner publishes an ECDH P-256 key in the policy; reporter encrypts (ECDH + HKDF + AES-GCM) | F30 | Only the owner key decrypts |
| R17 | P2 / L | Device sub-keys with root-signed delegation and revocation, only if R9 chooses per-author chains | F9, F18 | Lost-device revocation test |
| R18 | P3 / S | `did:key` display/export; hooks for VC-style attestations using the same JCS + P-256 primitives | F21 | Copy string resolves in a did:key resolver |
| R19 | P3 / M | Opt-in desktop "link my Nostr key" statement via NIP-07 (not a block signer) | F20 | Works with one extension; hidden on mobile |
| R20 | P3 / M | Optional SLIP-39 recovery cards | F10, F12 | 2-of-3 restore from paper |
| R21 | P3 / L | Phrase-free restore via passkey plus an encrypted record in the chain - prototype only after the sync-equality test passes | F16, F17 | Two physical devices, same salt, same output |

---

## 6. Gotchas

1. **WebKit rejects PKCS8 private keys without the optional public key** (`DataError`, WebKit 27.2); Chromium and OpenSSL accept them. Use JWK with `x,y` computed by a curve library.
2. **PRF at creation usually returns no result.** Create with `prf:{}`, read `enabled`, then evaluate in a separate `get()`. Yubico's guide also notes a `get()` is needed right after `create()` to obtain the first secret.
3. **A PRF output is constant per credential.** Never use it directly as an AES key for many messages; derive per-purpose keys with HKDF and use unique nonces (explainer).
4. **Deleting or switching the passkey provider can destroy the derived key** (Corbado). Keep the phrase.
5. **A capability flag is not a result.** Chrome reported PRF support while some registrations returned nothing (Corbado). Detect, try, verify, fall back.
6. **RP ID mismatch.** `localhost`, the site host, a hub host and a mirror are different RP IDs. ROR needs the `/.well-known/webauthn` file on the RP ID host, supports at most 5 distinct eTLD+1 labels in Chrome, and unsupported browsers throw `SecurityError`.
7. **Safari's 7-day rule counts only click, tap and keyboard input** (scrolling does not count), and eviction removes the whole origin at once.
8. **`persist()` returned false in both headless engines.** Never gate behaviour on it; display it.
9. **Argon2 memory on phones.** The lab only measured desktop. Do not exceed 64 MiB in the default profile; a killed tab during a save flow is a bad failure.
10. **noble-hashes' Argon2 is JS, about 6x slower than WASM in my run, and was outside the Cure53 audit.** Prefer hash-wasm for Argon2 or noble scrypt.
11. **Normalisation must match across devices.** NIP-49 requires NFKC for the password; BIP-39 uses NFKD. Pick one rule, include test vectors with accented and CJK input, and test on-screen keyboards and IME input.
12. **BIP-39 words are only an encoding here.** Tell users not to paste them into wallets; do not derive keys with BIP-39's PBKDF2 step (it is not a hardening step).
13. **Cloned keys.** If any code treats `seq` or an author chain as strict, importing a phrase on a second device will fork or reject blocks (F9). ECDSA signatures are malleable: keep deduplicating on the block hash `h`, never on the signature.
14. **Spoofable UI.** A same-origin full-viewport iframe can draw a fake "Save your phrase" or "Key changed - confirm" screen. Keep security prompts in a loader-owned, visually distinct frame and never accept a phrase typed into site-controlled UI.
15. **Avatar and ID licence and security traps.** DiceBear's CC BY styles need attribution; identicon equality proves nothing (about 24 bits for Jdenticon); an 8-hex ID is forgeable in hours (F25).
16. **Mute is cosmetic.** Muted content still replicates, is stored and costs CPU; the Sybil and PoW controls (review M1) still matter.
17. **Public reports can enable retaliation** and are cheap to fake with free keys. Say so in the UI and never auto-act on report counts.
18. **did:key cannot rotate or revoke.** If a `did:key` string is shown, state that rotation is a magnet-web feature, not a did:key one.
19. **Do not store the phrase, seed or backup status in places the SDK can read** (SDK responses, `postMessage`, localStorage). Export and restore run in the loader UI only.

---

## 7. Open questions

1. **Does a synced passkey return the same PRF output on every device** (iCloud Keychain, Google Password Manager, 1Password, Bitwarden)? Not documented in anything I read; gates R13 and R21. Needs two physical devices per provider.
2. **Firefox:** Related Origin Requests status (unshipped as far as I can verify), PRF coverage on macOS/Linux, and non-extractable `CryptoKey` persistence on Firefox 157 (the Playwright build would not launch here).
3. **iOS Safari in the wild:** does the open-chat `DataCloneError` come from private browsing or Lockdown Mode? Does a Home Screen web app avoid it? How often does the 7-day cap actually delete a visitor's data when the tab is never reopened?
4. **Mobile KDF cost:** Argon2id 64 MiB t=3 and scrypt N=2^16 on a mid-range Android phone and an older iPhone; WASM memory ceilings in iOS in-app browsers.
5. **P-256 or Ed25519?** If passkey roadmap items R13/R17/R21 are real, P-256 keeps WebAuthn and VC alignment; if not, Ed25519 is faster. A tagged `author` (R1) makes this reversible; the decision still needs an owner.
6. **Per-author sequence chain or not?** Resolve 06 versus ARCHITECTURE before building multi-device (R9).
7. **CXF/CXP:** does the credential exchange format carry hmac-secret/PRF secrets? What happens to PRF-derived keys when a visitor moves providers?
8. **Reporting duties:** do site owners in some jurisdictions have notice-and-action obligations (for example under the EU Digital Services Act)? Not researched; needs legal review before promising a moderation process.
9. **Not read or not confirmed this session:** Bluesky's block visibility (documentation fetch returned nothing), Matrix report API details (page 404), Signal linked devices (403), Session recovery password, SQRL per-site key derivation, Keybase paper keys, ENS-style naming, the exact NIP-01 event kind for a Nostr link statement.
10. **Comprehension of "your key lives in this browser":** no published study found; run R12 before launch.
11. **Reputation across sites:** per-chain identities are unlinkable by design; is any owner-issued cross-site badge wanted, and who would issue it?
12. **QR scanning:** which decoder library and size, and how camera permission behaves in iOS in-app browsers (BarcodeDetector support was not verified).

---

## 8. Sources (every URL below was opened this session unless marked otherwise)

**Passkeys, WebAuthn**
- S1 https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html - support table "as of mid-2025", 32-byte output, `prf.enabled` at create, derive in `get()`.
- S2 https://www.corbado.com/blog/passkeys-prf-webauthn - published 2025-04-16, last modified 2026-09-29; platform and provider matrix, caveats. Vendor source.
- S3 https://www.corbado.com/blog/webauthn-level-4 - published 2026-09-21, modified 2026-09-30, status checked 2026-09-28.
- S4 https://web.dev/articles/webauthn-related-origin-requests - page updated 2024-08-22, with a Jan 2026 note on Firefox.
- S5 https://www.w3.org/TR/webauthn-3/ - header: W3C Recommendation, 25 August 2026 (only the first 100k characters read; the PRF section body was not read).
- S6 https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md - undated explainer.
- S7 https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions - `prf` input and output shapes (no version table in the extract).
- S8 https://developers.yubico.com/Passkeys/Passkey_concepts/Security_key_capabilities/Signing_Extension_Preview.html - `previewSign`, early access.
- S9 https://github.com/w3c/webauthn/pull/2078 - "Add 'sign' extension", open draft, comments to July 2026.
- S10 https://bitwarden.com/blog/prf-webauthn-and-its-role-in-passkeys/ - 2025-02-05; says nothing on cross-device equality.
- S12 https://github.com/base/webauthn-sol - WebAuthn assertion verifier with RIP-7212 precompile.
- S13 https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/152 - Firefox 152 released 2026-06-16; no WebAuthn items.
- (read, no usable statistics) https://webauthn-passkeys-prf-demo.explore.corbado.com/ ; https://developers.google.com/identity/passkeys/supported-environments (updated 2025-05-19, no PRF mention); https://fidoalliance.org/specifications-credential-exchange-specifications/ (no maturity or scope detail).

**WebCrypto, algorithms, KDFs**
- S14 https://wicg.github.io/webcrypto-modern-algos/ - Draft CG Report dated 2026-09-14 (first 100k characters; the Argon2 section body was not read).
- S15 http://www.mail-archive.com/blink-dev@chromium.org/msg17349.html - Intent to Ship, 2026-09-02 (Chrome 154).
- S16 http://www.mail-archive.com/blink-dev@chromium.org/msg17363.html - reply thread, 2026-09-03.
- S17 https://github.com/mozilla/standards-positions/issues/1282 - Mozilla position "neutral", 2025-08-14.
- S18 https://blog.ipfs.tech/2025-08-ed25519/ - Ed25519 in every major engine (Aug 2025).
- S19 https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html - undated.
- S20 https://www.rfc-editor.org/rfc/rfc9106.html - RFC 9106, Sept 2021 (older).
- S21 https://github.com/paulmillr/noble-hashes - audit scope, Argon2 warning, M4 benchmarks.
- S22 https://github.com/paulmillr/noble-curves - audits (Trail of Bits v2.3.0 Aug 2026; Cure53 v1.6.0 Sep 2024; Kudelski v1.2.0 Sep 2023; Trail of Bits v0.7.3 Feb 2023).
- S23 https://github.com/Daninet/hash-wasm - Argon2id, 11 kB gzipped.
- S24 https://github.com/nostr-protocol/nips/blob/master/49.md - NIP-49.
- S25 https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki - BIP-39.
- S26 https://github.com/satoshilabs/slips/blob/master/slip-0039.md - SLIP-39.

**Pairing, external signers, interoperable identifiers**
- S27 https://magic-wormhole.readthedocs.io/en/latest/welcome.html
- S28 https://github.com/matrix-org/matrix-spec-proposals/pull/4108 - MSC4108 QR login, open PR snapshot.
- S29 https://github.com/nostr-protocol/nips/blob/master/07.md - NIP-07 (draft, optional).
- S30 https://github.com/nostr-protocol/nips/blob/master/46.md - NIP-46.
- S31 https://github.com/nostr-protocol/nips/blob/master/55.md - NIP-55.
- S32 https://github.com/nostrband/nostr-login
- S33 https://github.com/nostr-protocol/nips/blob/master/05.md - NIP-05.
- S34 https://w3c-ccg.github.io/did-key-spec/ - "The did:key Method v0.9".
- S35 https://www.w3.org/TR/did-core/ - Recommendation, 2022-07-19 (older).
- S36 https://www.w3.org/TR/vc-di-ecdsa/ - Recommendation, 2025-05-15.
- S37 https://atproto.com/specs/handle

**Names, IDs, avatars**
- S38 https://raw.githubusercontent.com/matrix-org/matrix-spec/main/content/client-server-api/modules/instant_messaging.md - display-name disambiguation.
- S40 http://www.skyhunter.com/marcs/petnames/IntroPetNames.html - Stiegler, Feb 2005, updated Jun 2010 (older).
- S41 https://www.unicode.org/reports/tr39/ - UTS #39 v18.0.0, 2026-08-27.
- S42 https://www.usenix.org/system/files/conference/usenixsecurity16/sec16_paper_dechand.pdf - Dechand et al., 2016 (older); read via PDF text extraction.
- S43 https://users.ece.cmu.edu/~lbauer/papers/2017/chi2017-fingerprints-author.pdf - Tan et al., CHI 2017 (older); read via PDF text extraction.
- S44 https://github.com/dmester/jdenticon - Jdenticon (MIT); measurements in S57 (lab3).
- S45 https://www.dicebear.com/licenses/ - DiceBear licence structure.

**Moderation and recovery**
- S39 https://raw.githubusercontent.com/matrix-org/matrix-spec/main/content/client-server-api/modules/ignore_users.md
- S46 https://docs.joinmastodon.org/user/moderating/
- S47 https://github.com/nostr-protocol/nips/blob/master/56.md - NIP-56.
- S48 https://github.com/nostr-protocol/nips/blob/master/51.md - NIP-51.
- S49 https://bsky.social/about/blog/4-13-2023-moderation - 2023-04-13.
- S50 Jhaver, Ghoshal, Bruckman, Gilbert, "Online Harassment and Content Moderation: The Case of Blocklists", ACM TOCHI 25(2), art. 12, March 2018 (older), doi 10.1145/3185593; read via the PDF at https://courses.cs.umbc.edu/graduate/691/spring21/pdf/3185593.pdf.
- S51 https://vitalik.eth.limo/general/2021/01/11/recovery.html - 2021-01-11 (older).
- S52 https://support.apple.com/en-us/102641 - "Set up a recovery contact for your Apple Account", published 2026-09-14.

**Storage and platform behaviour**
- S53 https://webkit.org/tracking-prevention/ - 7-day cap section (introduced 2020, older).
- S54 https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- S55 https://github.com/open-chat-labs/open-chat/issues/9343 - updates through 2026-10-17.
- S56 https://arxiv.org/html/2602.15135v2 - passkey census, 2026-03-19 (read; little relevance beyond adoption figures).

**Repo and prior waves**
- S57 This session's experiments: `docs/research/labs/w2c-03-identity-lab/` (section 9).
- S58 `docs/research/06-browser-chain-vs-crdt.md` (F6, F34, F47-F53, s3.1.1-3.1.9), `docs/review/security.md` (B1, M1, M3, M8), `docs/research/04-service-worker-serving.md` (F11), `docs/research/05-doh-dns-txt.md`.
- S59 `docs/ARCHITECTURE.md` (s5-s9), `docs/INTERFACES.md` (`cache.js`, bridge, SDK), `src/chain/crypto.js`, `docs/deviations/chain-base.md`.
- S60 Search-result snippets only (not opened; confidence Low, used for context and flagged in the text): CHI 2025 "Of Secrets and Seedphrases" (doi 10.1145/3706598.3713209; page returned 403) and passkey usability studies (USENIX SOUPS 2025 Lassak et al.; IEEE S&P 2026 field study; CHI 2026 digital nudges); Secure Scuttlebutt multi-device guidance and the `sameAs`/fusion-identity proposals; Apple Developer Forums thread 774112 (PRF in Safari's cross-device flow); Windows update KB5077181 (Windows Hello PRF, via a Corbado/Bitwarden-forum snippet); the 1Password community PRF-regression thread (June 2026); atproto cryptography page (did:key `zDn...` examples); MojoAuth claim that Firefox 152 shipped ROR (contradicted by S13).

---

## 9. Experiments run for this report (archived in `docs/research/labs/w2c-03-identity-lab/`)

Environment: Apple M3 (8 cores), macOS 27, Node 24.22.0, Playwright 1.64.1, Chromium 156.0.8078.4 (headless), WebKit 27.2 (Playwright build, headless, normal context), `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0, `hash-wasm` 4.12.0, `@scure/bip39` 2.4.0, `jdenticon` 3.3.0. Firefox 157 (Playwright build) failed to launch ("Could not find profile folder", file `lab4-firefox-launch-failure.txt`).

| Lab | Question | Result |
|---|---|---|
| lab1 (Node) | Can a seed deterministically produce a P-256 identity that WebCrypto accepts non-extractable? | Yes. HKDF-SHA256 -> 48 bytes mod (n-1) + 1; noble public key equals OpenSSL's; JWK import non-extractable signs 64-byte raw signatures, verifies, and `exportKey` throws `InvalidAccessError`. Per-chain info string yields a different key. PKCS8 without public key imports in OpenSSL (x,y match). |
| lab1 | How fast can short IDs be forged? | OpenSSL keygen 71,140/s/core; noble incremental loop 26,730/s/core. 2^32: 16.8 core-hours (keygen) or 44.6 (JS loop). At an assumed 1e9/s: 32 bits 4.3 s, 48 bits 78 h, 64 bits 5.1e6 h. Birthday 50%: 77,162 / 19,753,494 / 5,056,894,494 identities for 32 / 48 / 64 bits. |
| lab2 (Chromium) | Can same-origin site code use the visitor's stored non-extractable key? | Yes: found the key in IndexedDB, `extractable:false`, signed attacker bytes (64-byte signature), export refused. `sandbox="allow-scripts"` iframe: `SecurityError`, IndexedDB denied. |
| lab2 | PKCS8-without-public-key in Chromium? | Works (x,y match). |
| lab2 | KDF cost (one thread) | Argon2id WASM: 19 MiB t2 18 ms; 46 MiB t1 25 ms; 64 MiB t3 103 ms; 128 MiB t1 75 ms. Argon2id noble-JS 19 MiB t2 100-113 ms. scrypt noble-JS 2^15 66 ms, 2^16 129 ms, 2^17 257 ms. PBKDF2-SHA256 600k 43 ms. WebCrypto P-256 `generateKey` 43,031/s. |
| lab2 | WebAuthn PRF flow (CDP virtual CTAP2.1 authenticator with PRF) | `getClientCapabilities`: `extension:prf` true, `relatedOrigins` true, `hybridTransport` true. Create: `enabled:true`, no results. Get: 32 bytes, stable, salt-separated, `second` works, a second credential gives a different secret. This validates the API flow only; platform authenticators and sync were not tested. |
| lab3 (Node) | Effective entropy of a common identicon | Jdenticon: 200,000 random inputs -> 198,564 (run 1) and 198,550 (run 2) distinct SVGs; about 23.7 bits. |
| lab4 (Chromium vs WebKit) | Portability of the primitives | JWK import non-extractable: both OK. **PKCS8 without public key: Chromium OK, WebKit `DataError`.** IndexedDB round trip of non-extractable ECDSA P-256 and Ed25519 pairs, as value and as indexed property: both OK. `getClientCapabilities`: `prf` true and `relatedOrigins` true in both. `persist()`: false in both (headless). Argon2id WASM 64 MiB t3: 119 ms vs 121 ms; 256 MiB t1: 172 ms vs 162 ms. |

Not tested: real iPhones and Androids, private browsing, Lockdown Mode, Firefox, platform authenticators, synced passkeys, hybrid (QR) flows, mobile KDF timing, any network behaviour.
