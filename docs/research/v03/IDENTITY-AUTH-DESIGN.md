# Self-owned identity and authentication with no backend (v0.3 design proposal)

- **Status:** design proposal, 2026-10-20, written as amendments to [ARCHITECTURE.md](../../ARCHITECTURE.md) (6.1 identity, new 6.9 and 6.10, 9 SDK) and [INTERFACES.md](../../INTERFACES.md) (`src/loader/api.js`, `bridge.js`, `src/sdk/sdk.js`, new `src/identity/*`). Nothing here is built. Decisions are marked **D-n** with their alternatives; the owner signs each off before the build.
- **Built from:** [R3](R3-identity-auth-landscape.md) (findings F1 to F24, options C, P, W, recommendations A1 to A16), [R5](R5-weak-area-audit.md) F6 to F8, [R7](R7-ease-of-use.md) section 6, [R6](R6-legal-compliance.md), [R2](R2-privacy-failures-2026.md), and the earlier [w2c-03](../w2c-03-identity-ux.md) and its [VERIFY](../w2c-03-identity-ux-VERIFY.md) (cited as ID and IDV). Privacy decisions PR-1 and PR-2 are in [PRIVACY-UPGRADES.md](PRIVACY-UPGRADES.md) section 4.
- **Wording:** "no backend", "site ledger". Sizes are arithmetic (R3 5.6); timings are not measured unless a lab is cited.

## 1. Summary (10 bullets)

1. **Identity = one 128-bit recovery root per person, never stored in the clear; one unrelated P-256 key set per site ledger derived from it by HKDF.** Each site gets a signing key, a chat key-agreement key and two symmetric keys. Sites cannot match a visitor by key (R3 F21).
2. **Keys are non-extractable CryptoKeys imported from JWK `{d,x,y}`** (public point via `@noble/curves`; WebKit rejects PKCS8 without it, ID F5 lab). The root stays wrapped (passkey PRF, passphrase or session) and is unwrapped only in loader code.
3. **Backup is a 12-word phrase (master), an encrypted file, an optional passkey PRF wrap, and a QR hand-off between devices with a short authentication string.** The phrase is offered after the first thing worth keeping, not at sign-in (R7 6.3).
4. **"Signed in" means the visitor's browser holds an unlocked site key and the visitor agreed to be identified to this site.** Login is a SIWE-shaped challenge bound to origin, ledger id, time and a loader nonce, verified in the browser (R3 option C). Nothing is published at sign-in. Logout locks the key; "remove from this device" deletes it.
5. **Authorisation comes from the ledger policy** (owner, moderators, allow list, open). v0.3 adds advisory roles under `_roles/` (no format change) and asks the owner to decide, inside the format freeze window, whether moderators may write `allow`, whether `unban` and `rotate` ops are added (D-9, D-10).
6. **The private record ("auth block") is local first.** On sites that allow it and visitors who opt in, a fixed 1,024-byte padded record is sealed with AES-256-GCM under a derived key, bound by AAD to ledger, author and version, and written as an `append` item, never `put` (R3 A5; PR-1).
7. **"Nobody else can decrypt" is true against other visitors, peers, trackers, relays, snapshot hosts and the owner reading the ledger. It is not true against code running on the site's origin while the visitor is unlocked,** which includes code the owner ships. Only a separate identity origin changes that (design in v0.3, build later; R5 F7 fix 4).
8. **SDK:** `mw.auth`, `mw.identity`, `mw.me` (section 7). Sensitive steps run only in loader-owned UI on `isTrusted` input; site code never sees a phrase, root or private key.
9. **Migration:** 0.2.1 keys are linked to the new derived key by a signed item, sealed into the vault and backup file, and re-imported non-extractable (3.7).
10. **Build plan:** eight agents in four waves: core and vectors, auth and records, UI and SDK, example site and the real-device gate (12.4).

## 2. Goals, non-goals and what "logged in" means

**Goals (owner, 2026-10-20):** visitors own their identity; sites authenticate visitors through the site ledger with no backend; login and logout in the example site; each visitor can decrypt their own auth and profile record and nobody else can; address today's privacy failures where the design can.

**Non-goals:** gating public content (every site file is public to the swarm and the host; R3 5.1); proving a legal name, an email or uniqueness; account recovery by a third party; cross-site identity by default; owner login from a browser (the owner key never enters a browser, ARCHITECTURE 6.2).

**What "logged in" means with no backend.** Three facts, all local: (1) this browser holds the visitor's site key, unlocked; (2) the visitor agreed, in a loader card, to be identified to this origin with that key; (3) the current ledger state gives that key a role (reader, writer, moderator, owner). Other parties learn about it only when the visitor signs something for them: a ledger entry, a peer challenge, or a proof the site asked for.

## 3. Identity model (amends ARCHITECTURE 6.1, "Identity")

### 3.1 Derivation tree (D-1)

```
root         16 random bytes (CSPRNG); encoded as 12 BIP-39 English words (encoding only)
siteSeed     HKDF-SHA256(ikm = root, salt = "mw/id/v1", info = "seed|" + ledgerId, L = 32)
signKey      P-256 ECDSA scalar = (HKDF(siteSeed, salt = "", info = "sign|" + i, L = 48) mod (n-1)) + 1
chatKey      P-256 ECDH  scalar = (HKDF(siteSeed, info = "chat|" + e, L = 48) mod (n-1)) + 1   // e = rotation epoch
K_rec        AES-256-GCM key = HKDF(siteSeed, info = "rec|1",   L = 32)    // private record (site tier)
K_vault      AES-256-GCM key = HKDF(siteSeed, info = "vault|1", L = 32)    // local vault, loader only
K_name       HMAC key        = HKDF(siteSeed, info = "name|1",  L = 32)    // opaque list names, blinded ids
recoverKey   P-256 ECDSA scalar from HKDF(root, info = "recover|" + ledgerId)   // reserved for rotate (D-10)
```

- `i` starts at 1; the mod-reduce of 48 bytes makes bias negligible, so no retry loop is needed (ID F5 lab used this reduction). `e` starts at 1 and increments on chat-key rotation.
- **Per ledger id, not per origin:** the key signs into `e.site`, so mirrors of one site share an identity; passkeys stay per origin (3.4).
- **Alternatives:** random keys per ledger as in 0.2.1 (no one-phrase recovery; rejected); one global key (linkable by key; rejected, R3 F11); a 32-byte root and 24 words (later, behind a version tag).
- **Golden vectors:** `test/vectors/identity.json` (append only): phrase, root, three ledger ids, every derived public key and a sample signature, computed in Node and checked in Chromium and WebKit (R3 A4).

### 3.2 Key separation

| Key | Algorithm | Used for | Public where |
|---|---|---|---|
| signKey | ECDSA P-256 SHA-256 | block signatures (`"mw-block-v1\n" + h`), login proofs (`"mw-login-v1\n" + ...`), chat-key binding, link statements | `e.author`, `p256:` tagged |
| chatKey | ECDH P-256 | sealed chat envelopes, file-key wraps, QR hand-off replies | chat-key record in the ledger, bound by a signKey signature ([REALTIME](REALTIME-AND-FILES-DESIGN.md) 5.2) |
| K_rec | AES-256-GCM | the synced private record | never |
| K_vault | AES-256-GCM | the local vault (wrapped legacy keys, contacts, file keys, history) | never |
| K_name | HMAC-SHA-256 | opaque record list name, blinded presence ids | never |

Domain-separated message prefixes prevent a signature made for one purpose being replayed as another. ECDSA and ECDH use different scalars, so a flaw in one use does not expose the other (R8 F4).

### 3.3 Storage in the browser (D-2)

- **Root at rest:** never plaintext. One of: `wrap:prf` (passkey PRF, 3.4), `wrap:pass` (Argon2id 64 MiB, t=3, p=1 via hash-wasm, about 0.1 s on an M3 per ID F7; mobile not measured), or `session` (held in loader memory for this tab only; the visitor re-enters the phrase or uses a linked device next time). IndexedDB store `mw-id` (loader origin), object store `roots`: `{ v: 1, kind, credId?, salt?, iv, ct }` (44 to 60 bytes of ciphertext; R3 5.4).
- **Derived keys at rest:** for each ledger, store `keys:<ledgerId>`: `{ v: 1, sign: CryptoKey (non-extractable), signPub, chat: CryptoKey (non-extractable), chatPub, epoch }`. Symmetric keys (`K_rec`, `K_vault`, `K_name`) are **not** stored; they are derived when needed inside loader code from the unwrapped root and dropped after use.
- **Self-test at creation:** put, get, sign, verify, ECDH round trip; on failure (the iOS `DataCloneError` path in `src/loader/cache.js` lines 594 to 615; IDV claim 3) keep only the wrapped root and derive per session.
- **Lazy creation:** no key exists until the first write, sign-in or chat opt-in (changes `app.js` lines 2108 to 2111, where `openLedger` creates the identity on every visit; R5 F7). `mw.ready().identity` is `null` until then.
- **Shared-origin hubs:** refuse persistent identity; offer session-only (R5 F19; ID R7).
- **Alternative:** store `K_rec` as a non-extractable AES key for speed. Rejected: it would sit in page-reachable IndexedDB for any same-origin script; derivation costs one HKDF.

### 3.4 Unlock methods and passkeys (D-3)

- **Passkey PRF wrap, where supported, never the only route.** Create a discoverable credential for the current origin's RP ID with `extensions: { prf: {} }` and `userVerification: 'required'`. If PRF is enabled, immediately call `get()` with salt `"mw/wrap/v1|" + ledgerId`, HKDF the 32-byte output with info `"mw-prf-wrap-v1"`, seal the root, then **unwrap it again in the same session as a self-test** before reporting success. On any failure, fall back to passphrase or session, and say so in the card.
- **Why not passkey-first recovery:** no source proves synced passkeys return equal PRF output on every device (R3 F4; IDV claims 7, 8); provider support is uneven (R3 F3). The phrase stays the master; cross-device unwrap waits for the two-device lab (w2c-03 R21).
- **Per-origin scope:** a passkey belongs to an RP ID; mirrors need Related Origin Requests (`/.well-known/webauthn`, at most 5 registrable-domain labels in Chrome; Firefox treated as unsupported; R3 F5). The card says "this passkey works on this site's address".
- **Honest limit:** any script on the same origin can call `navigator.credentials.get` with the same salt after a user gesture; the browser's own prompt naming the site is the only signal. PRF wrapping stops silent theft from disk and casual same-origin reads, not a hostile script that can trigger a prompt.
- **Alternatives:** passkey assertion as the login proof itself (R3 option P, kept as P2 "protected login"); passkey `sign` extension (unmerged draft, not usable; R3 F7).

### 3.5 Backup, restore and device hand-off (D-4)

| Route | What the visitor keeps | Restores | Notes |
|---|---|---|---|
| Recovery phrase (master) | 12 words, print, copy or QR | every site key, every synced record | entered only in loader UI; 3-word re-entry check; "No one will ever ask you for these words" |
| Encrypted file | `mw-identity-v2` JSON: `{ v: 2, kdf: 'argon2id', m: 65536, t: 3, p: 1, salt, iv, ct }` (about 150 to 250 bytes) plus wrapped legacy keys | everything the phrase does, plus legacy 0.2.1 keys | passphrase NFKC-normalised; file never leaves the device unless the visitor moves it |
| Passkey PRF wrap | a passkey in their provider | this device; other devices only after the lab passes | 1 prompt to unlock |
| QR hand-off | nothing | one site, or the root on explicit choice | below |
| SLIP-39 cards | shares | the root | P3; a wrong passphrase silently yields another secret (R3 F13 note) |

**QR hand-off protocol (R3 5.4 R4, adopted with changes).**
1. New device B, in loader UI: generates ephemeral ECDH P-256 key `eB`, shows QR `mwlink:1:<eB pub, 65 B>:<ledgerId>`.
2. Device A (unlocked), loader UI "Link a device": scans, generates `eA`, computes `K = HKDF(ECDH(eA, eB), info = "mw-link-v1|" + ledgerId)`, shows a 6-digit short authentication string `SAS = first 20 bits of SHA-256(eA pub || eB pub)` in decimal.
3. B scans A's reply QR `mwlink:1r:<eA pub>:<iv>:<ct>` where `ct = AES-GCM(K, siteSeed)` (default) or the root (explicit "link everything").
4. Both screens show the SAS; the visitor confirms they match. A substituted key shows a different SAS.
5. Transport: two QR scans by default (no network). Optional: send the reply over the ledger's wire to B's ephemeral key if B is already a peer (no ledger write; an `mw_chat1` frame, see REALTIME 4).
6. Sending `siteSeed` rather than the root limits a stolen hand-off to one site (R3 5.4).

**Backup card timing (R7 6.3):** after the first ledger write, first chat message or first upload: "To use this identity on another device, or if this browser forgets this site, save a recovery kit." iOS: again after 7 days without a visit (WebKit ITP deletes script-writable storage after 7 days of Safari use without interaction, https://webkit.org/tracking-prevention/, accessed 2026-10-20; IDV claim 2).

### 3.6 Interop

`did:key` display of the site key (P-256 multicodec 0x1200; IDV row 4) for interop only (R3 F9). A NIP-07 or NIP-46 shaped signer adapter is P3 and needs an algorithm-tag decision before the format freezes (R1 Q6; R3 A15).

### 3.7 Migration from 0.2.1 identities (D-5)

0.2.1 keys are random, extractable, one per ledger (`identity:<ledgerId>`, `app.js` line 542). They cannot be re-derived from a phrase.

1. On the first v0.3 sign-in on a ledger that has a legacy key, the loader creates (or restores) the root, derives the new site key, and offers: "Keep posting as <name> (your old key) or start fresh."
2. **Default, link:** the legacy key signs a link item and the new key countersigns: `append('mw.link', { from: <legacy pub>, to: <new pub>, t, sigTo })` authored by the legacy key, so readers can show "same person". The new key becomes the active author. Old posts stay attributed to the legacy key and remain deletable by it.
3. The legacy private key (exportable today) is exported once, sealed under `K_vault`, stored in the vault and included in the encrypted backup file, then re-imported non-extractable for tombstoning old posts; the extractable record is deleted only after the visitor saves a backup.
4. **Alternative:** keep using the legacy key as the site key forever (no link item; the phrase cannot restore it). Allowed when the visitor declines; Settings says "this site's key is not in your recovery words, keep the file".

## 4. Authentication (new ARCHITECTURE 6.9, "Sign-in")

### 4.1 Login challenge (D-6, R3 option C)

Created by the loader, never by site code:

```
c = { v: 1, t: 'mw-login', domain: location.host, aud: location.origin, ledger: <ledgerId>,
      pub: <p256: signKey>, nonce: <16 random bytes, b64url, from the loader>, iat: <ms>,
      exp: <ms, default iat + 12 h, max iat + 7 d>, scope: ['post', 'chat', 'files', 'read-profile'] }
proof = { c, sig = b64url(ECDSA-P256-SHA256(signKey, utf8("mw-login-v1\n" + canonical(c)))) }
```

**Verification (`verifyLogin(proof, { expectNonce? })`, pure, Node and browsers):** signature valid for `c.pub`; `c.aud === location.origin`; `c.ledger === current ledger`; `iat - 2 min <= now < exp`; `exp - iat <= 7 d`; `c.pub` not banned and its role in the current state permits each scope; if `expectNonce` is given, `c.nonce === expectNonce`.

**Two kinds of proof:**
- **Self-issued** (one message, loader nonce): a bearer token for the site's own code in this tab. Labelled `kind: 'bearer'`. Short `exp`.
- **Challenge-response** (two messages): the verifier sends a nonce, the prover signs with that nonce. Required for anything peer-verified (chat sessions, file-share accept). Bind to the transport by including both sides' wire session ids in `c` (`chan: [idA, idB]`). Binding to DTLS fingerprints is better but needs access to the underlying `RTCPeerConnection` inside WebTorrent's wire; marked "verify feasibility" (R5 F8 c).

**What is never done:** publishing a sign-in event to the ledger (it would be permanent presence metadata; R2 F9); accepting a challenge whose nonce came from site code; signing a login challenge without a loader card on first use per origin.

**Alternatives:** option P (passkey assertion; browser-stamped origin; one prompt per login; P2), option W (external signer; P3), SIWE itself (needs secp256k1 and EIP-191, not in WebCrypto; rejected; R3 F16).

### 4.2 Sessions and states (D-7)

| State | Meaning | Site sees |
|---|---|---|
| `guest` | no key for this ledger in this browser, or the visitor has not signed in | `identity: null`; reads work; a write opens the sign-in card |
| `locked` | a key exists but is not unlocked in this tab (root wrapped, visitor signed out) | `identity: { pub, short, name }` only if the visitor allowed this site to remember them; writes open the unlock card |
| `signed-in` | unlocked key, visitor agreed to identify to this origin | `identity`, `role`; writes proceed with the fee |

- Session object: `{ proof, unlockedAt }` in loader memory; optional `sessionStorage` copy of the proof only (never key material) so a reload in the same tab stays signed in.
- **Sign out (`lock`)**: forget unwrapped root and derived symmetric keys, clear the session proof, stop presence, close chat lanes. One tap. Nothing is published.
- **Remove from this device**: delete `roots`, `keys:*`, vault and cached private records for this origin, after a check that a backup exists or an explicit "I accept losing this identity" (R7 6.5).
- **There is no server session to revoke.** A stolen bearer proof works until `exp` for anyone who can present it to the site's own code; that is why bearer proofs are short and never accepted by peers.
- **Compatibility:** 0.2.1 sites that call `mw.db.append` without sign-in get the sign-in card on the first write (implicit sign-in), so the example site keeps working before it is updated.

### 4.3 First sign-in flow (R7 6.2, adapted)

Site calls `mw.auth.signIn()` from a click; the loader card ("Sign in to example.org. This creates a key for this site on this device. Nothing is sent anywhere.") unlocks an existing root (passkey, passphrase or nothing for session) or offers Create or "I already have one" (phrase, file, QR). On create, PRF support adds "Protect with this device's screen lock" (3.4). Before the first networked use of the key, the "what others can see" card appears once per site (PRIVACY-UPGRADES V1); the backup card follows the first meaningful action (3.5).

## 5. Authorisation (amends ARCHITECTURE 6.2 and 6.5)

- **Source of truth:** the ledger policy. `writers: 'owner' | 'allow' | 'open'`, moderators (up to 50), allow list (up to 1,000), bans (ARCHITECTURE 6.1). `role` = owner, moderator, writer (allowed or open) or reader, as `node.role` computes today.
- **Advisory roles, no format change (D-8):** moderators and the owner `put('_roles/' + b64url(SHA-256(pub))[:22], { role, label, t })`. `_` keys are already owner/moderator-only (ARCHITECTURE 6.5). The ledger does not enforce them; site code and the loader read them as display and feature hints (for example "can pin files"). Alternative: an enforced `role` control op, which needs a block version bump (R3 A13); P2.
- **Membership requests:** v1 cannot open one list to non-members of an `allow` site, so a join request is a signed frame to online moderators over the chat lane, not a ledger entry. Approval writes `allow`, which today only the owner signs, from `tools/` (ARCHITECTURE 6.8).
- **D-9 (freeze window, owner decides): may moderators write `allow`?** Options: (a) yes, a v1 validity change (moderator standing for `allow` adds only, never removes owner-added keys); (b) no, membership stays owner-only through `tools/` and a CI job; (c) delegate by a new op `grant` (signed by the owner, naming a moderator key and the right `allow`). Recommendation: (a), decided before any public ledger exists (ROADMAP "freeze group"; R5 F8). Without it, "sign up" on an `allow` site means the owner runs a command.
- **D-10 (freeze window): add `unban` and `rotate`.** `unban { author }` (moderator or owner standing) fixes R5 F6 d; `rotate { next, by: 'self' | 'recover', sig2 }` lets a lost or compromised site key be replaced, signed by the old key or the per-ledger `recoverKey` announced at the visitor's first write (R3 R6/A12, modelled on AT Protocol signing versus rotation keys). Both are new control ops, invalid in v1 under the unknown-op rule (ARCHITECTURE 6.1), so they must be added before the format freezes or wait for a block version bump. Alternative: ship v0.3 without them and accept that a lost key means a new identity re-admitted by the owner.
- **Signed grants for chat and files** (who may upload, who may use public rooms) reuse the same policy: `writers` governs public file listings; chat lanes follow a site setting `chat: 'off' | 'members' | 'open'` stored in a `_mw.chat` owner key (advisory, enforced by honest clients).

## 6. The private record (new ARCHITECTURE 6.10, "Sealed records")

### 6.1 Where it lives (PR-1)

Local vault by default (IndexedDB `mw-id`, store `vault:<ledgerId>`, sealed under `K_vault`). Synced copy only when the site policy says `records: 'sealed'` and the visitor opts in. PRIVACY-UPGRADES 4.1 gives the reasons and alternatives.

### 6.2 Format (value convention inside `append`, no new op) (D-11)

```
list name   l = "mw.r." + b64url(HMAC-SHA256(K_name, "record|1"))[:16]          // 21 characters
value       v = { enc: 'mw-rec-v1', ver: <uint>, iv: <12 B b64url>, ct: <b64url> }
plaintext   P = canonical({ ver, fields: {...}, pad }) padded with spaces to exactly 1,024 bytes
ct          AES-256-GCM(K_rec, iv, P, AAD)   -> 1,024 + 16 bytes -> 1,387 base64url characters
AAD         utf8("mw-rec-v1\n" + ledgerId + "\n" + authorPub + "\n" + ver)
```

- **Size:** value about 1,450 bytes canonical, under `maxValueBytes` 2,048 and inside the 4,096-byte block with `e`, `z` and the signature (ARCHITECTURE 6.1). Fixed size hides how much the visitor stored (PRIVACY-UPGRADES V4).
- **Why `append`, not `put`:** `put` is last-writer-wins on the key across authors in total order, so under `writers: 'open'` another author can replace a record key; `append` items carry their author, and readers take the newest item by that author that decrypts (ARCHITECTURE 6.5; R3 A5). R3 A6 asks for a two-key test to confirm; it is test U-7 below.
- **Why an opaque list name:** a name like `profile:<pub>` reveals purpose; the author is public anyway in `e.author`, so the opaque name only hides that the item is a record. Alternative: one shared list `mw.records` (simpler; reveals purpose; acceptable if `l` charset rules make the HMAC name awkward).
- **Update:** `append(new)` with `ver + 1`, then `tombstone(old.h)` (own entries; drops `v` and `z`). Two devices writing concurrently: newest in total order wins; `ver` lets the client merge field by field.
- **Fields (minimal by default):** `display` (local display preferences), `contacts` (chat contacts: keys and local nicknames), `files` (keys of the visitor's own uploads), `notes` (off by default), `links` (passkey credential ids, link statements). Never email, phone, name, birth date, documents, health. `mw.me.set` rejects reserved field names (PRIVACY-UPGRADES rule 4).
- **Write cost:** one PoW fee per write at the site's `bits` (moderators and owner exempt); writes are rate limited by the Bridge (20 per minute per page).

### 6.3 Erasure (PR-2 and R6 F1)

"Delete my private data on this site" = tombstone every record item by this author, clear the local vault, keep or remove the key as the visitor chooses. The card says plainly that copies kept by peers that never sync stay, and that the recovery phrase can still open them (PRIVACY-UPGRADES 4.3). Full shredding = destroy the phrase and all backups (all sites). `vanish` stays reserved and undefined.

### 6.4 Who can read what

| Party | Public profile name | Chat-key record | Sealed record | Local vault |
|---|---|---|---|---|
| Other visitors, peers, trackers, relays, `cs=` snapshot host | yes | yes | ciphertext, fixed size, author, times | never sees it |
| Site owner reading the ledger or snapshots | yes | yes | ciphertext only | never |
| Site code via SDK, visitor signed in | yes | yes | plaintext after the per-session loader card (`mw.me.get`) | no SDK method |
| Hostile code on the origin while unlocked (XSS, compromised tag, a malicious code update by whoever controls the host) | yes | yes | can read | can read |
| The visitor on a restored device | yes | yes | yes (phrase or hand-off) | after hand-off or file restore |

### 6.5 The tiers are UX boundaries, not security boundaries (honest statement)

The loader gates `mw.me.get` behind a card per session and offers no SDK method for the vault. That protects against honest site code that over-asks. It does not protect against hostile code on the same origin: in shell mode the site frame is same-origin with the loader and can reach the loader's window and wrap its functions; in drop-in mode the page is the loader's realm (IDV claim 1; R3 F18). **Fix that works:** a dedicated identity origin (`id.<site>`) framed by the loader and talking over `postMessage`, holding the root and doing all decryption (R5 F7 fix 4). v0.3: design note only; build after the gate.

## 7. SDK surface (amends ARCHITECTURE 9, INTERFACES `api.js`, `bridge.js`, `sdk.js`)

All methods return promises. UI methods need transient user activation in the site frame, forwarded with the request; the loader opens its own card and acts only on `isTrusted` input there.

```
mw.auth.signIn({ scope?: string[], remember?: boolean }) -> { state: 'signed-in', identity, role }
    UI. Opens the sign-in card (4.3). Errors: E_USER_CANCELLED, E_HOST_ONLY_IDENTITY (shared-origin hub),
    E_UNSUPPORTED (no WebCrypto P-256), E_IDENTITY (self-test failed and no session fallback), E_RATE (card cooldown 10 s)
mw.auth.signOut({ forget?: false }) -> { state: 'locked' | 'guest' }
    forget: true opens the "remove from this device" card (UI). Errors: E_USER_CANCELLED
mw.auth.state() -> 'guest' | 'locked' | 'signed-in'
mw.auth.onChange(fn) -> unsubscribe            // fn({ state, identity, role })
mw.auth.prove({ scope?: string[], ttlMs?: number, nonce?: string }) -> proof
    Signed-in only. With nonce: challenge-response proof for a peer; without: bearer proof (kind 'bearer').
    ttlMs <= 7 d. Errors: E_NOT_SIGNED_IN, E_LIMIT (ttl or scope), E_USER_CANCELLED (first use per origin shows a card)
mw.auth.verify(proof, { nonce?: string }) -> { ok: true, pub, role, scope, exp, kind } | { ok: false, reason }
    reason: 'sig' | 'aud' | 'ledger' | 'expired' | 'future' | 'nonce' | 'banned' | 'scope'. Pure; no card.

mw.identity.current() -> { pub, short, name, did } | null
mw.identity.setName(name) -> { h }                                   // exists; now requires signed-in
mw.identity.backupStatus() -> { phraseSaved: bool, fileSaved: bool, passkey: bool, persisted: bool, legacy: bool }
mw.identity.openBackup() / openRestore() / openLink() -> 'done' | 'cancelled'      // UI, loader cards only

mw.me.get(field?) -> value | object            // UI on first call per session (card "Let this site read your private record?")
mw.me.set(field, value) -> { stored: 'local' | 'synced', h? }   // E_LIMIT if > 1,024 B padded, E_FIELD (reserved name)
mw.me.del(field) -> { stored }
mw.me.sync({ on: boolean }) -> { on }          // UI; only if site policy records: 'sealed'; E_POLICY otherwise
mw.me.erase() -> { tombstoned: n }             // UI; 6.3

mw.ready() -> { ..., identity: {...} | null, auth: 'guest'|'locked'|'signed-in', role }   // identity null when guest
```

**New error codes:** `E_NOT_SIGNED_IN`, `E_USER_CANCELLED`, `E_UNSUPPORTED`, `E_FIELD`, `E_DECRYPT` (record does not decrypt: wrong key, tampering or another author), `E_HOST_ONLY_IDENTITY`. Existing: `E_IDENTITY`, `E_LIMIT`, `E_POLICY`, `E_RATE`, `E_TIMEOUT`, `E_BANNED`.

**Bridge and api.js changes:** `UI_METHODS` adds `auth.signIn`, `auth.signOut`, `identity.openBackup`, `identity.openRestore`, `identity.openLink`, `me.sync`, `me.erase`; `READ_METHODS` adds `auth.state`, `auth.verify`, `identity.current`, `identity.backupStatus`, `me.get`; `WRITE_METHODS` adds `me.set`, `me.del`, `auth.prove`. `LOADER_ONLY_METHODS` keeps `identity.export`, `identity.import`, `consent.accept` and adds `identity.root` (never callable). `PUSH_EVENTS` adds `auth`. `SDK_VERSION = '0.3.0'`.

**New modules (INTERFACES):** `src/identity/derive.js` (pure: phrase, root, HKDF tree, scalar reduce, JWK build via noble-curves), `src/identity/store.js` (IndexedDB `mw-id`, self-test, fallbacks), `src/identity/wrap.js` (PRF, Argon2id, session), `src/identity/login.js` (challenge build and `verifyLogin`, pure), `src/identity/record.js` (seal, open, pad, list name, pure), `src/identity/link.js` (QR hand-off, SAS), `src/identity/migrate.js`. Owners: section 12.

## 8. Compatibility matrix and fallbacks

"Lab" = verified in the w2c-03 lab (Playwright Chromium 156, WebKit 27.2). Every untested cell becomes a gate row.

| Capability | Chromium desktop | Android Chrome | Safari macOS | iOS Safari | Firefox | Fallback |
|---|---|---|---|---|---|---|
| ECDSA and ECDH P-256, HKDF, AES-GCM | Lab | untested | Lab | untested | untested (Firefox failed to launch in lab) | none needed if present; `E_UNSUPPORTED` |
| JWK `{d,x,y}` import non-extractable | Lab | untested | Lab | untested | untested | session-only derivation |
| CryptoKey in IndexedDB | Lab | untested | Lab | reported failures (IDV claim 3) | untested | wrapped root plus per-session import |
| Storage survives 7 days without a visit | yes | yes | ITP may delete | ITP may delete; Home Screen exempt | yes | backup card; Home Screen hint |
| Passkey PRF | Lab (`getClientCapabilities` prf true) | Google Password Manager reported (Corbado only) | Lab | iOS 18.4+ per R3 F3 | 139+ on macOS per R3 F3 | passphrase or session; phrase always |
| Related Origin Requests | yes (R3 F5) | yes | yes | yes | treat as no | separate passkey per mirror |
| Camera QR scan | BarcodeDetector support varies (not fetched) | same | same | same | same | JS decoder; manual 2-QR or text code |

## 9. Threat model

| Threat | Mitigation in v0.3 | What remains |
|---|---|---|
| Phishing for the phrase on a look-alike site | phrase only in loader UI; loader never asks unprompted; card text; QR hand-off with SAS | a visitor who types the words elsewhere loses every site identity |
| Phishing a login proof to use on another site | `aud` and `ledger` bound; proofs rejected elsewhere | a proof stolen on the same origin works until `exp` (short) |
| Key theft from disk | non-extractable keys; root wrapped (PRF or Argon2id) | malware on the device; a weak passphrase on an exported file |
| Same-origin script (XSS, third-party tag, malicious update via the host) | cards for SDK reads; no SDK path to vault or root; root dropped after use | can act as the visitor and read unlocked data while the page is open (6.5) |
| Replay of a peer challenge | challenge-response nonces; `chan` binding; short `exp` | DTLS binding not yet verified feasible |
| Replay of a sealed record under another ledger or author | AAD binds ledger, author, version | none known |
| Linkability across sites | per-site derivation; no shared public key; link statements only by choice | IP, timing, reused names, writing style |
| Linkability within a site | none beyond pseudonymous keys | peers link IP to key on every signed action (PRIVACY-UPGRADES V1) |
| Recovery abuse via a stolen device | linking needs an unlocked root; SAS confirmation | an unlocked device in an attacker's hands |
| Lost device, no backup | backup card at first value; iOS 7-day reminder | identity gone; owner or moderator can re-admit a new key (`allow`) |
| Compromised site key | `rotate` signed by `recoverKey` if D-10 ships | without D-10, a new identity |
| Ledger bloat from records | one fixed-size record per visitor; updates tombstone the old; PoW fee | busy open sites reach the 8 MiB default sooner (owner may raise to 64 MiB) |
| Sybil keys | PoW fee, allow lists, moderators, bans | one person can hold many keys |
| Malicious owner | cannot decrypt records from the ledger | controls the code visitors run, so can exfiltrate after unlock |

## 10. Legal notes (from R6; not legal advice)

The owner should assume controller status for data processed through the loader and the ledger, the opt-in sealed record included (R6 F3, Russmedia C-492/23, secondary sources). Encrypted personal data stays personal data for whoever can decrypt it (EDPS v SRB, C-413/23 P, 2025-09-04, secondary; R6 F2). User copy never calls tombstoning or key deletion "erasure" (R3 F20). No owner-held recovery wrap by default, since it would make the owner controller of decrypted data with security and breach-notice duties (R6 F3, F7). A DPIA is likely for sites that enable records, chat or files, plus a Quebec s. 3.3 assessment for Quebec audiences (R6 F6). An identity is a key, not a person: never "verified adult" (R6 F10). Standard primitives plus noble-curves: keep a one-paragraph export classification note (R6 F12).

## 11. Example site: peer-guestbook login and logout specification

Applies to `examples/peer-guestbook/` (today 347 lines in `js/app.js`, using `mw.ready`, `mw.db.append('guestbook', { msg })`, `mw.db.tombstone`, `mw.identity.setName`).

| Screen or element | Behaviour | SDK |
|---|---|---|
| Header: **Sign in** (guest) | opens the loader sign-in card | `mw.auth.signIn()` |
| Header when signed in: name, short id, **Sign out** menu (Sign out, Remove from this device) | lock; or guarded removal | `mw.auth.signOut()` / `signOut({ forget: true })` |
| Reading the guestbook | works for guests, host-only and signed-out visitors | `mw.db.list` |
| **Post** | guests see "Sign in to post"; signed-in members post; the fee progress shows | `mw.db.append` |
| **Profile** page | display name (public, with the word "public" next to it), private notes and preferences (with "only you can read this"), sync toggle only if the site allows records | `mw.identity.setName`, `mw.me.get/set`, `mw.me.sync` |
| **My posts** | list items where `author === me`, newest first | `mw.db.list` filtered by author |
| **Edit own post** | append `{ msg, replaces: <h> }` then tombstone the old item; the list shows the newest version with "edited" | `mw.db.append`, `mw.db.tombstone` |
| **Delete own post** | tombstone with the existing message "Visitors stop showing it when they receive the deletion" | `mw.db.tombstone` |
| **Recovery kit** (Settings link and post-first-action card) | opens loader backup card; shows saved state | `mw.identity.openBackup()`, `backupStatus()` |
| **Protect with screen lock** | offered when PRF is available; result reported honestly | inside the sign-in or backup card |
| **Use on another device** | QR hand-off | `mw.identity.openLink()` |
| **What others can see** | static page linked from the sign-in card and the footer, with the PRIVACY-UPGRADES V1 sentence | none |
| Moderator view | unchanged ("Remove post") | `mw.db.tombstone` |

**Drop-in widget:** the drop-in panel (closed shadow root, `src/dropin/panel.js`) gains the same Sign in, Sign out, Backup, Link and Restore actions, moderator-key import (ROADMAP "Next"), and the "what others can see" link. Existing-site owners add `mw.auth` buttons in their own HTML or rely on the panel; the panel acts only on `isTrusted` input.

## 12. Test plan and build plan

### 12.1 Unit and vectors
- U-1 derivation vectors (phrase to keys for three ledgers) in Node, Chromium, WebKit.
- U-2 scalar reduce never yields 0 or n; JWK import non-extractable; `exportKey` throws.
- U-3 wrap and unwrap: PRF (virtual authenticator), Argon2id, session; wrong passphrase fails closed.
- U-4 `verifyLogin`: wrong `aud`, wrong ledger, expired, future, oversize ttl, wrong nonce, banned key, missing scope all fail.
- U-5 record seal and open: fixed size for 1-byte and 1,000-byte plaintexts; AAD mismatch fails; tampered `ct` fails.
- U-6 QR hand-off: correct SAS on both sides; substituted key yields mismatched SAS.
- U-7 (R3 A6) two keys under `writers: 'open'`: author B can overwrite A's `put` key; B's `append` to A's record list does not decrypt and is ignored. Record the result in ARCHITECTURE 6.5.
- U-8 migration: legacy key links, posts stay deletable, extractable copy removed only after backup.

### 12.2 End-to-end scenarios (Playwright, loopback, existing harness)
E-1 guest reads, signs in, posts, signs out, cannot post, signs in with a virtual-authenticator passkey, posts. E-2 reload keeps the tab signed in; a new tab is `locked`. E-3 remove from device, restore from phrase, same public key, own posts deletable. E-4 two profiles: profile B cannot read A's record; A's record syncs to A's second profile after restore. E-5 site code cannot call `identity.root` or open the vault; `me.get` without a gesture opens no card and fails `E_USER_CANCELLED`. E-6 host-only mode: sign-in works locally, no network request carries the key. E-7 shared-origin hub refuses persistent identity. E-8 drop-in panel sign-in parity. E-9 accessibility: axe-core on every new card; keyboard-only sign-in.

### 12.3 Real devices (new release-gate rows)
G-ID-1 iOS Safari: sign in, close, reopen after 1 hour and after 8 days (ITP), with and without Home Screen. G-ID-2 Android Chrome with Google Password Manager: PRF wrap round trip. G-ID-3 Two-device PRF equality lab (iCloud Keychain, Google Password Manager, Windows Hello, 1Password). G-ID-4 Firefox desktop full flow. G-ID-5 QR hand-off phone to laptop. G-ID-6 Argon2id time on a low-end Android.

### 12.4 Build plan (agents, ownership, order)

| Wave | Agent | Owns | Depends on |
|---|---|---|---|
| 0 | Owner | decisions D-1 to D-11, PR-1, PR-2, D-9, D-10 | none |
| 1 | A1 identity-core | `src/identity/derive.js`, `wrap.js`, vectors `test/vectors/identity.json` | D-1, D-2, D-3 |
| 1 | A2 format-freeze | `src/chain/block.js`, `state.js` changes for D-9 and D-10, block vectors | D-9, D-10 |
| 2 | A3 store-and-migrate | `src/identity/store.js`, `migrate.js`, changes to `src/loader/app.js` and `src/dropin/identity.js` | A1 |
| 2 | A4 auth-and-records | `src/identity/login.js`, `record.js`, `link.js` | A1 |
| 3 | A5 loader UI | `src/loader/ui.js`, `ui.css`, `strings.js` (English and French), cards | A3, A4 |
| 3 | A6 SDK and bridge | `src/loader/api.js`, `bridge.js`, `src/sdk/sdk.js`, `src/dropin/binding.js`, `docs/SDK.md` | A4 |
| 4 | A7 example and drop-in | `examples/peer-guestbook/`, `src/dropin/panel.js` | A5, A6 |
| 4 | A8 tests and gate | `test/unit/identity-*`, `test/e2e/*identity*`, DEMO-RESULTS rows, real-device runs | all |

Deviations go to `docs/deviations/<agent>.md`; no two agents write one file.

## 13. What this means for magnet-web

- **Today (0.2.1):** one random extractable P-256 key per ledger, created on every ledger open; passphrase-wrapped export and import; no login, records, key agreement or phrase.
- **Upgrade (v0.3):** everything in sections 3 to 7 and 11.
- **Cannot:** the eight items in the summary and section 6.5: gate public content, stop hostile same-origin code while unlocked, guarantee PRF across devices, erase peers' copies, shred one site while the phrase exists, reset a lost phrase, prove one key is one person, hide the IP-to-key link from peers.

## 14. Recommendations

| Pri | Effort | Item |
|---|---|---|
| P0 | S | Owner decisions D-1 to D-11, PR-1, PR-2; D-9 and D-10 before any public ledger |
| P0 | M | A1 identity core with vectors on Chromium and WebKit (R3 A4) |
| P0 | M | A4 login and sealed records; U-7 two-key test recorded in ARCHITECTURE 6.5 (R3 A5, A6) |
| P0 | M | Lazy, non-extractable keys and migration (R5 F7) |
| P0 | S | Same-origin honesty statement in SECURITY-MODEL and the sign-in card |
| P1 | M | Loader cards, SDK, example site, drop-in parity |
| P1 | M | QR hand-off (R3 A9) |
| P1 | S | Comprehension test with 5 to 8 people of the sign-in, backup and link cards (R3 A11) |
| P1 | M | Real-device rows G-ID-1 to G-ID-6 |
| P2 | M | Passkey assertion as protected login (option P); ROR for mirrors |
| P3 | L | Identity origin build; external-signer adapter; SLIP-39 cards |

## 15. Open questions

1. PR-1 or PR-1a, and PR-2: owner and counsel.
2. D-9 and D-10: will the owner reopen block v1 for `allow` by moderators, `unban` and `rotate` before any public ledger exists?
3. Does a synced passkey return the same PRF output on every device (G-ID-3)?
4. Can the wire layer expose DTLS fingerprints for challenge binding inside WebTorrent 3.0.21's wires?
5. Should the owner get a scoped, short-lived browser delegation key for admin from the example site (R3 Q6)? It would be a new trust object.
6. Is 128 bits the right root size, given that one phrase opens every site (R3 F22)?
7. Firefox: every capability is untested because Firefox did not launch in the lab (ID section 9). The first gate pass must include it.
