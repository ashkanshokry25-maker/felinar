# mw-signin-v1: sign-in proofs from a felinar identity origin

Status: **v0.3**. The code landed with this text: `src/identity/signin.js` (builder, strict
parser, local proofs), `packages/verify/verify.js` (`@felinar/verify`, the verifier for
servers and browsers) and the vectors `test/vectors/signin.json`. Source of the design:
[V03-DESIGN-REVIEW.md](../review/V03-DESIGN-REVIEW.md) ("R") 2.3.2, 2.3.7 and 2.4.2;
ARCHITECTURE 15.2. The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Parties and flow

- **Identity origin (IdO):** the person's identity web origin. It holds the root and signs every
  `mw-signin-v1` proof. It runs only as a top-level window (popup or redirect round trip).
- **Page:** a page on the site origin. It asks for a proof and passes it on. It never chooses
  `domain`, `origin`, `ledger`, `pub`, `keyMode`, `iat`, `idp` or `build`.
- **Verifier:** the site's server (or page code, for a local check) running `@felinar/verify`.

Server flow (R 2.3.1 (c)): the page fetches a challenge from its server; the page passes it to
the IdO popup in a sign-in request; the IdO shows the statement verbatim on its card, signs, and
posts the proof to the opener's `event.origin`; the page posts the proof text to its server,
which verifies it and mints its own session.

## 2. The request (page to IdO)

Sent after the IdO popup posts `{ t: 'mw-idp-ready' }` to `window.opener`:

```
{ v: 1, t: 'mw-signin-req',
  requestId: <16 to 32 bytes, base64url>,
  purpose: 'site' | 'server',
  pointer?: <signed MW-PTR/1 record text>,
  challenge?: { nonce: <16 to 64 bytes, base64url, issued by the verifier>,
                statement: <section 5>, exp?: <ms>, nbf?: <ms>, resources?: [<https URL>, at most 4] },
  want: ['keys'] | ['proof'] | ['keys', 'proof'],
  epk: <p256: page ECDH public key for the key bundle> }
```

The IdO takes the requester's origin from `event.origin` of that message and MUST check
`event.source === window.opener`. `purpose: 'server'` without `challenge.nonce` MUST be refused
with `E_NONCE_REQUIRED`.

Proofs travel by the popup transport only. The redirect transport (`IdO/signin#<request>`, used where
no popup keeps its opener) names its origin in page text that any page can write, so the IdO MUST
refuse a redirect request that wants a proof, a `purpose: 'server'` sign-in, an erase, an owner
action, a page creation or a legacy key (`E_BAD_REQUEST`), MUST say on its card that it cannot
confirm which page sent the person, and MUST NOT record anything about that origin (review round
2026-10-24, SEC-2 and PHISH-9). A redirect carries only a key sign-in or the record read, sealed to
the named origin and delivered there.

## 3. The signed object `c`

| Field | Type | Value | Set by |
|---|---|---|---|
| `v` | number | `1` | IdO |
| `t` | string | `'mw-signin'` | IdO |
| `domain` | string | host of `origin`, lowercase, with the port when it is not the scheme default (`new URL(origin).host`) | IdO, from `event.origin` |
| `origin` | string | `event.origin`, serialised (`scheme://host[:port]`, no path) | IdO, from the browser |
| `ledger` | string or null | the ledger id when `keyMode` is `'ledger'`, else `null` | IdO |
| `pub` | string | `p256:` + base64url of the 65-byte uncompressed point of the label's signing key | IdO |
| `keyMode` | string | `'pairwise'`, `'ledger'`, `'hub'` or `'linked'` (R 2.2.3) | IdO |
| `nonce` | string | `challenge.nonce`; for `purpose: 'site'` without a challenge, 16 random bytes from the IdO | verifier (server) or IdO (site) |
| `statement` | string | `challenge.statement` or `''` (section 5) | page, shown verbatim |
| `resources` | array | `challenge.resources` or `[]`; at most 4 strings starting `https://` | page |
| `iat` | number | ms since the epoch, IdO clock | IdO |
| `nbf` | number | `challenge.nbf`, else `iat` | page or IdO |
| `exp` | number | `min(challenge.exp, iat + 300000)` | IdO |
| `requestId` | string | echo of the request, 16 to 32 bytes base64url | page |
| `idp` | string | the IdO origin | IdO |
| `build` | string | the IdO build id, 1 to 64 printable ASCII characters | IdO |

All 16 fields MUST be present; no other field is allowed. Numbers are non-negative safe integers.
`exp` MUST be after `iat` and after `nbf`; the IdO refuses a challenge whose window is already over.

## 4. Signature and proof

```
signing input = UTF-8("mw-signin-v1\n" + JCS(c))        JCS = RFC 8785
sig           = ECDSA P-256 with SHA-256 over the signing input, raw r || s (64 bytes, IEEE P1363)
proof         = { c, alg: 'ES256-P1363', sig: base64url(sig) }   (no padding)
```

The prefix `mw-signin-v1\n` is used for no other purpose (R 2.10.3), so a sign-in signature can
never be replayed as a block, a chat-key record or a link. A proof MUST have exactly the keys
`c`, `alg` and `sig`. `alg` other than `'ES256-P1363'` is refused (`alg`); a `sig` that is not
64 bytes, DER included, is refused (`sig`). A high-S signature (`s > n / 2`) is valid ECDSA and is
accepted: replay protection never relies on the signature bytes.

Transport: the proof travels as JSON text of at most **4,096 bytes** (UTF-8). Verifiers MUST parse
the text themselves, MUST refuse duplicate object keys, and MUST use only the object they parsed
and verified (never a second parse of the same text by other code).

## 5. Statement rules

A statement is a string of 0 to 280 characters (Unicode code points) that:

- is in NFC (`s.normalize('NFC') === s`);
- contains no control character: U+0000 to U+001F, U+007F to U+009F, U+2028, U+2029;
- contains no bidi control: U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069;
- contains no lone surrogate.

The IdO shows it verbatim on its card. A statement that breaks a rule is refused (`E_STATEMENT`
at the IdO, reason `statement` at the verifier).

## 6. Nonces

- A server proof's nonce MUST be issued by the verifier and MUST be consumed at most once.
  Proofs made for a page's own use carry a nonce the IdO chose, so a verifier refuses them by
  construction (reason `nonce`).
- **Store contract:** `put(nonce, expMs, meta)` records an issued nonce with the statement and
  resources it was issued for; `consume(nonce, expMs, origin)` returns the metadata (or `true`)
  exactly once, `'used'` afterwards, and `false` for a nonce never issued or expired. Several
  instances behind a load balancer MUST share one store whose `consume` is atomic.
- **Stateless nonces** (servers without per-nonce storage at issue time):
  `nonce = base64url(t (8 bytes, big-endian ms) || r (8 random bytes) || HMAC-SHA-256(secret,
  "mw-nonce-v1|" + origin + "|" + t + "|" + base64url(r))[:16])`, 32 bytes. The verifier checks
  the MAC and `t` (not more than 300,000 ms in the future, not older than its TTL) before touching
  any store, then marks the nonce used in a store of used nonces kept until `t + TTL`. The MAC
  alone does not stop a replay inside the TTL; the used store does.

## 7. Verification (normative order)

Checks run cheap first; the first failure is the result `{ ok: false, reason, at }`, where `at`
is the verifier's clock.

1. **Parse and size:** text over 4,096 bytes, bad JSON, a duplicate key, a missing or unknown
   field, or a field of the wrong type: `parse`. A statement breaking section 5: `statement`.
2. **Version and type:** `c.v !== 1` or `c.t !== 'mw-signin'`: `version`; wrong `alg`: `alg`;
   `sig` not 64 bytes: `sig`.
3. **Origin and binding:** `c.origin` differs from the configured origin (exact string, from
   configuration, never from request headers): `origin`; `c.domain` differs from that origin's
   host: `domain`; `c.ledger` differs from the expected ledger (`null` when none is expected):
   `ledger`; `keyMode` not allowed: `keymode`; `idp` not in the allow-list when one is set: `idp`.
4. **Age and skew** (`now` = verifier clock, `skew` at most 300,000 ms, default 120,000;
   `maxAge` at most 300,000 ms): `exp - iat > maxAge` or `exp <= iat`: `too-long`;
   `iat > now + skew` or `nbf > now + skew`: `not-yet-valid`; `exp + skew <= now` or
   `iat + maxAge + skew <= now`: `expired`.
5. **Nonce consumption** (stateless MAC first): never issued, wrong origin or expired: `nonce`;
   already consumed: `replay`; the used store is full of unexpired entries: `store-full`. The nonce
   is consumed here, before the signature check: a forged proof that carries a stolen nonce burns it.
6. **Signature** over the signing input with `c.pub`: `sig`.
7. **Statement and resources** equal what the nonce was issued with (or the verifier's configured
   statement for stateless nonces): `statement`.

On success: `{ ok: true, pub, keyMode, ledger, iat, exp, requestId, statement, idp, build }`.
The verifier never returns roles or any ledger state: scope is a request, never a grant.

## 8. Local proofs (`mw-local-v1`, R 2.4.2)

For site code that asks "is the visitor signed in" in the same tab:

```
c = { v: 1, t: 'mw-local', origin, pub, epoch, nonce: <16 random bytes>, iat, exp }   exp - iat <= 900000
proof = { c, alg: 'ES256-P1363', sig }   over UTF-8("mw-local-v1\n" + JCS(c))
```

Kept in memory only, never written to storage. `epoch` is the per-origin revocation counter that
sign-out increments; a proof from an earlier epoch is refused (`revoked`). Reasons: `parse`,
`version`, `origin`, `revoked`, `epoch`, `too-long`, `not-yet-valid`, `expired`, `sig`. A local
proof is never a sign-in proof (other type, other prefix) and `@felinar/verify` refuses it.

## 9. Guidance for verifiers

- Bind an account to `pub` only after contact data verified separately (pre-hijack).
- Deduplicate on the nonce, never on the signature (ECDSA signatures are malleable; vector
  `si-015` is a high-S copy that verifies, `si-016` the same copy refused as a replay).
- Use only the object the library returned.
- The server sees the IP address and user agent at sign-in; two servers joining their logs by IP
  and time can link a person whatever the keys say (R 2.3.9).
- A verified proof shows that the signer holds the key. `keyMode`, `idp` and `build` are written by
  the signer, so `allowIdps` and `allowKeyModes` filter honest identity pages only; they do not stop
  a holder of a shared or leaked key (review round 2026-10-24, PHISH-8). This version carries no
  recovery commitment (`rc`) and no rotation: a server that needs continuity after "Replace my keys"
  keeps its own re-bind path. A rotation the verifier can check (`rc` in `c`, a `mw-rotate-v1`
  object signed by the label's recover key) needs a new format version and is not part of
  `mw-signin-v1`.
- Rate-limit challenges and failed verifications per client: forged proofs with fresh stateless
  nonces fill the used store, and a full store answers `store-full`.

## 10. Vectors

`test/vectors/signin.json` (append only) holds every case of R 2.3.2: a valid proof for each
`keyMode`, and negative cases for a foreign origin, a foreign domain with the right origin, an
`exp` 1 ms over 5 minutes, a future `nbf`, a reused nonce, a high-S signature (accepted, then
refused as a replay), a DER signature, duplicate JSON keys, a non-NFC statement, an unknown field,
`ledger` present when none is expected, and a `keyMode` the verifier did not allow; plus size,
algorithm, version, identity origin, expiry, skew, statement and check-order cases. Each vector
gives the proof text, the verifier options with its clock, and the nonce state before
verification (`issued`, `used` or `unknown`) with what it was issued for.

## 11. Reference verifier

`packages/verify/verify.js`, one ES module with no imports, 389 lines. SHA-256 of the file as it
landed: `eda60c70d9607fd02b8a4869c00b4c69327149892d1b65a53965622744b42bbf`
(`test/unit/signin-verify.test.mjs` checks that this hash and the README's match the file).

## 12. Changes from R 2.3.2 and 2.3.7

- R lists `too-long` without saying what is too long. Here it means a lifetime over `maxAge`
  (`exp - iat`); a proof text over 4 KiB is `parse`.
- Statement format rules are checked in step 1 (reason `statement`) so a malformed statement never
  consumes a nonce; step 7 compares the statement with the issued one.
- The store contract gains `put(nonce, expMs, meta)` (the issued statement and resources) and
  `markUsed(nonce, expMs)` (stateless nonces); `consume` may return `'used'` so that `nonce` and
  `replay` can be told apart. A store that returns only booleans reports both as `nonce`.
  `markUsed` may return `'full'` (the store holds no more unexpired entries), reported as
  `store-full` rather than `replay`.
- `issueChallenge` takes `origin` (required for stateless nonces) and `now`.
- `createVerifier` takes an optional `statement` for stateless nonces, whose MAC does not bind it.
