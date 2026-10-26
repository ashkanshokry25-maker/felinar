# chain-base notes (src/chain/canonical.js, src/chain/crypto.js)

Status: implemented per INTERFACES.md, no signature or name deviations. Everything below is
either an addition or a behaviour decision the other chain agents should know about.

## Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test test/unit/chain-core-canonical.test.mjs test/unit/chain-core-crypto.test.mjs

## canonical.js

- `canonicalize` is full RFC 8785: all finite doubles are supported (the RFC vector needs
  them). The "safe integers only" rule of ARCHITECTURE §6.1 is a block-shape rule and belongs
  in `block.js`, not here.
- The RFC test vector lives in RFC 8785 §3.2.2–3.2.4 (Appendix B is the IEEE 754 number
  table); both the byte-exact vector and the whole Appendix B table are unit tests.
- Rejections (all `TypeError`): NaN/±Infinity, `undefined` anywhere (object values, array
  elements, array holes), functions, symbols, BigInt, non-plain objects (Date, Map, Set, typed
  arrays, class instances, boxed primitives; only `Object.prototype` / null prototypes pass),
  symbol-keyed properties, circular references, and lone surrogates in strings or keys. The
  last one is an RFC 8785 §3.2.2.2 MUST ("terminate with an appropriate error") and was not in
  the ARCHITECTURE list; a peer can only trigger it by sending a `\uD800`-style escape inside a
  JSON frame, in which case `block.js` should map the `TypeError` from `canonicalize` to the
  `'shape'` rejection reason. `toJSON` is never called.
- `utf8.decode(bytes, { fatal })`: lenient by default (invalid bytes become U+FFFD, like every
  browser); pass `{ fatal: true }` to throw. `encode` of a lone surrogate yields EF BF BD, the
  same as browsers.
- `b64url.decode` is strict: URL-safe alphabet only (`+` and `/` rejected), optional trailing
  `=` tolerated, non-zero trailing bits rejected, so `encode(decode(s)) === s` for every
  accepted `s`. `hex.decode` accepts either case, `hex.encode` emits lowercase.
- Extra export `asBytes(x)` normalises Uint8Array | ArrayBuffer | any ArrayBufferView to a
  zero-copy Uint8Array view; every byte-taking helper accepts those three forms.

## crypto.js

- `sha256`, `sign`, `verify` accept data as bytes (Uint8Array / ArrayBuffer / view) or as a
  string, which is UTF-8 encoded. `verify` additionally accepts the public key as an already
  imported CryptoKey and the signature as bytes or as a b64url string, and it never throws.
- `importPublicKey` keeps an in-memory cache of up to 256 imported keys (same CryptoKey object
  returned for the same string; failed imports are evicted). Verifying a few thousand blocks by
  a handful of authors therefore costs one import per author.
- `exportPrivateJwk` returns exactly `{ kty, crv, x, y, d }` (no `key_ops`/`ext`) so the
  `owner.jwk` written by `tools/keygen.mjs` is stable across engines; `importPrivateJwk` and
  `publicFromPrivateJwk` ignore any extra members.
- Extra exports: `publicKeyBytes(pubB64url)` (sync, decodes + checks 65 bytes / 0x04 prefix,
  TypeError otherwise), `isPublicKeyString(value)` (sync boolean shape check for `block.js`
  structural validation of `author`; it does not prove the point is on the curve, only
  `importPublicKey`/`verify` do), `RAW_PUBLIC_KEY_BYTES = 65`, `SIGNATURE_BYTES = 64`,
  `PUBLIC_KEY_B64URL_LENGTH = 87`.
- The signature is WebCrypto's raw r||s (IEEE P1363), verified against node:crypto in the
  tests. ECDSA signatures are malleable (for one key and message there are several valid
  `s` values), so block identity and deduplication must use `h` only and `s` must never be
  part of anything hashed; that matches ARCHITECTURE §6.1 as written.
- `block.js` decides what "bytes(h)" means for the signature input (hex-decoded 32 bytes or the
  UTF-8 of the hex string); `sign`/`verify` are agnostic, just use the same choice in
  `createBlock` and `validateBlock`.
- Browser requirements: `crypto.subtle` exists only in secure contexts (https:// or
  localhost), which `boot.js` should say explicitly in its feature-detect message; everything
  else used is ES2017 (`padStart`, typed arrays, `TextDecoder` with `fatal`/`ignoreBOM`
  options, supported since Safari 10.1 / iOS 10.3). No top-level await, no node: imports.

## Tooling note for other agents

Writing source through the agent tool layer decoded `\uXXXX` escapes for printable characters
before the bytes reached disk (a scratch script's `€` arrived as a literal euro sign).
The modules on disk were verified byte-for-byte; the unit tests build all non-ASCII and control
characters with `String.fromCharCode` and compare against the RFC's hex dump for that reason.
If you embed such escapes in fixtures, check the file bytes afterwards.
