# idcore lane (v0.3 I1 + S1): identity core crypto, sealed items, mw-signin-v1, @magnet-web/verify

Brief: R 2.2.1 to 2.2.4, 2.2.6, 2.3.2, 2.3.7, 2.4.2, 2.6.2, 2.10.3; MF-01, MF-02, MF-04, MF-07, MF-11,
MF-15 to MF-19, MF-72; ARCHITECTURE 15.1 to 15.3 and 15.5; INTERFACES v0.3 (proposed).

Files written (nothing else): `src/identity/{derive,p256,bip39-english,argon2,wrap,vault,check,sealed,signin}.js`,
`packages/verify/{verify.js,package.json,README.md}`, `docs/specs/mw-signin-v1.md`,
`test/vectors/{identity,signin}.json`, `test/fixtures/signin-server/server.mjs`,
`test/unit/{identity-core-derive,identity-core-wrap,identity-core-vault,identity-core-browser,sealed-items,signin-format,signin-verify,signin-browser}.test.mjs`,
this file. No npm package added, no network used, nothing pushed, `LOCK.json` untouched.

## Results (2026-10-20, Apple M3, macOS 27.0.1, Node v24.22.0)

- `node --test` on the six Node files: 50 tests, 50 pass, 0 fail.
- `MW_BROWSER=1 node --test` on the two browser files: 2 tests, 2 pass (Chromium 156.0.8078.4 with
  `chromiumArgs()`, WebKit 27.2 on `http://127.0.0.1` only). Firefox: not run (not in the brief's engines).
- `node tools/lint-floor.mjs`: clean (103 files); `node tools/lint-floor.mjs packages`: clean.
- BIP-39 list: written from memory (no list on disk, no network). It matches all 19 published BIP-39
  English vectors tried (the four required ones 00..00, 7f..7f, 80..80, ff..ff, plus the 24- and 32-byte
  forms and seven random-entropy vectors), is 2048 unique sorted words with unique 4-letter prefixes,
  and its english.txt form (LF, trailing newline) hashes to
  `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`, the published SHA-256 of
  bip-0039/english.txt. No stop condition hit.
- Argon2id RFC 9106 section 5.3 vector: matches. BLAKE2b-512 "abc" and empty input: match.

### Measured

| What | Node 24.22 | Chromium 156 | WebKit 27.2 |
|---|---|---|---|
| Argon2id m = 65536 KiB, t = 3, p = 1, pure JS | 1,875 ms and 1,896 ms (two runs) | 1,924 ms and 1,903 ms | 1,286 ms and 2,528 ms |
| root* with the extra word (same Argon2id) | 1,870 ms | 1,879 ms and 1,924 ms | 1,293 ms and 2,541 ms |
| PBKDF2-SHA-256 600,000 iterations (WebCrypto) | 57 ms | not measured | not measured |
| BigInt P-256 public point | 0.7 ms each (20 runs) | not measured | not measured |

Two runs each; other lanes' tests were running on the same machine, which may explain the WebKit spread. Mobile: not measured (G-ID-6).

## Deviations

1. **`p256.js` replaces `@noble/curves`** (INTERFACES derive.js: "public point via @noble/curves"). The
   package is not installed and the build adds none. `p256.js` is a small BigInt Jacobian double-and-add
   used only to compute the public point of a derived scalar so WebCrypto can import the JWK. It is
   **not constant time**; it runs at the identity origin on the person's device, once per derived key, and
   signing stays in WebCrypto. Cross-checked against `node:crypto` ECDH for 70 scalars (random and edge).
2. **Argon2id runs as plain JavaScript, not WebAssembly** (R 2.2.4, MF-17). No Argon2 package exists here.
   Measured above: about 1.3 to 2.5 s at m = 64 MiB on this machine, against "about 0.1 s on an M3" in R
   for the WebAssembly build. The PBKDF2 fallback still exists and is named in the header. Consequences:
   the IdO does not need `'wasm-unsafe-eval'` for this code; the passphrase card should say unlocking
   takes a couple of seconds (UX, lane idp); a WebAssembly build is a later swap behind the same
   `argon2id()` signature. Lanes are run one after another (p = 1 is what the IdO uses).
3. **`labelFor` is async and takes injected checks**: `labelFor({ origin, pointer?, hubScope?, links?,
   verifyPointer, isPublicSuffix }) -> Promise<{ label, keyMode, ledger?, reason? }>` (INTERFACES shows a
   sync call without the two functions). `verifyPointer(pointerText, origin) -> Promise<{ ok, ledgerId,
   owner, lo, rotVerified, host, org }>` is supplied by the IdO lane on top of `src/common/pointer.js`
   (which is changing in H1b: `org=`, `nx=`, rot v1 removal). Lineage holds when `lo` is absent, `lo ==
   owner`, or `rotVerified` is true. `org` longer than 4 origins is refused. Precedence: shared-origin hub
   (`keyMode: 'visit-only'`, `label: null`) > linked > hub (opt-in, host exactly `<32 base32>.<suffix>`, PSL
   check true) > ledger > origin. `reason` on an origin fallback is one of `no-verifier`, `unverified`,
   `lineage`, `org-too-long`, `not-listed` (the last drives "This address is not one of this site's
   addresses"). Request to lane idp: build `verifyPointer` and `isPublicSuffix` and pass them in.
4. **Unnamed HKDF parameters, chosen and pinned by the vectors**: `root* = HKDF(ikm, salt "mw/id/v2", info
   "", 32)`; `sign`, `recover`, `name`, `vault-id` use an empty salt (RFC 5869 default) with the info R
   gives; `labelSeed` uses salt `"mw/id/v2"` as R says. The extra word is NFKD-normalised (as BIP-39
   passphrases); wrapping passphrases are NFC-normalised. An empty extra word means none.
5. **New prefixes** (R 2.10.3 says a new purpose gets a new prefix): `mw-vault-v2` (vault blob AAD),
   `mw-identity-v3` (backup file AAD), `mw-nonce-v1` (stateless nonce MAC in `@magnet-web/verify`),
   `mw-selftest-v1` (the self-test message; nobody verifies it). `mw-idp-wrap-v1` is used both as the HKDF
   info for K_unlock (R) and as the wrap AAD prefix (same purpose). `mw-identity-v1` is the 0.2.1 AAD, read
   only. Request to the review owner / D1: add these to the R 2.10.3 list.
6. **Wrap blob details**: `{ v: 2, kind: 'prf' | 'pass', credId?, salt?, kdf?, iv, ct }` as R, with `kdf` an
   object `{ name: 'argon2id', m, t, p }` or `{ name: 'pbkdf2-sha256', iter }`, and the whole header bound
   as AAD (`"mw-idp-wrap-v1\n" + JCS(header)`), so swapping `credId`, `salt` or `kdf` fails AEAD. Header
   bounds are checked before any KDF runs (m at most 1 GiB, t at most 16, p at most 8, iter 1,000 to
   10,000,000). `packSecrets({ rootStar, kVault })` gives the 64-byte payload (80-byte ciphertext).
7. **Backup file** `mw-identity-v3` is `{ type: 'mw-identity', v: 3, kdf, params, salt, iv, ct }`: R lists
   six fields; `type` is added so the loader tells it from the 0.2.1 export by `type` + `v` as before.
   `kdf` is `'argon2id'` (params `{ m, t, p }`) or `'pbkdf2-sha256'` (params `{ iter }`). The stated
   strength floor for a chosen passphrase: at least 12 characters and an estimate of at least 60 bits
   (11 bits per distinct BIP-39 word, else half of length x log2(alphabet)); `generatePassphrase()` gives
   6 distinct words (about 66 bits) and always passes.
8. **Vault shape and methods**: `{ v: 2, labels: { <label>: { i, chat: [{ e, jwk, exp }], rec: [{ r, key }],
   own, local, contacts, links: [{ origin, t }], sites: [{ origin, t }] } }, legacy }` (R's shape plus
   `local` = K_local from ARCHITECTURE 15.1). Vault blob `{ v: 2, kind: 'vault', id?, iv, ct }`. Added
   methods beyond INTERFACES: `Vault.create()`, `currentChat`, `bumpSignIndex`, `linkOrigin`,
   `unlinkOrigin`, `links()` (the map `labelFor` takes), `addSite`, `addLegacy`, `toJSON`; `toBlob(kVault)`
   and `Vault.open(kVault, blob)` take K_vault explicitly. Chat epoch keys are random scalars
   (`scalar(48 random bytes)`) with public points from `p256.js`, so `label()` is synchronous.
9. **check.js**: `selfTest(cryptoApi, { indexedDB })`; the IndexedDB store is injectable (false in Node).
10. **sealed.js** (not listed in INTERFACES; the lane brief owns it): kinds 4 and 5 call an injected
    `sealTo(theirChatPub, plaintext1024, { aad, iv }) -> Promise<Uint8Array>` and are opened with
    `openFrom(ct, { aad, iv }) -> Promise<Uint8Array | null>`. Request to lane chat: wrap the sealed box
    of R 2.7.4 in these two calls (the 12-byte IV in the value is passed through for the box to use or
    ignore). A self key never opens kinds 4 and 5 and a box never yields kinds 1 to 3. The reader counts
    the newest 32 items per author (by `ts`, then `h`) whether or not they open.
11. **mw-signin-v1 details** (all written into `docs/specs/mw-signin-v1.md` section 12): `too-long` means a
    lifetime over maxAge, an oversize proof is `parse`; statement format is checked at parse time (reason
    `statement`) so it never consumes a nonce; the nonce store contract gains `put(nonce, exp, meta)` and
    `markUsed(nonce, exp)` and `consume` may return `'used'` (so `nonce` and `replay` differ);
    `issueChallenge` takes `origin` (stateless) and `now`; `createVerifier` takes an optional `statement`
    for stateless nonces; the stateless nonce is `t (8) || r (8) || HMAC[:16]`, bound to the origin.
    `buildChallenge` also takes `purpose`; it refuses `ledger` unless `keyMode` is `'ledger'`.
    `verify.js` also exports `jcs` (its RFC 8785 serialiser, for the byte-equality test). 382 lines.
12. **Local proofs**: `{ c: { v: 1, t: 'mw-local', origin, pub, epoch, nonce, iat, exp }, alg, sig }` over
    `"mw-local-v1\n" + JCS(c)`; reasons include `revoked` (earlier epoch) and `epoch` (later epoch).
13. **Fixture server**: the shared nonce store is a directory (`--nonce-dir`), one file per nonce, consumed
    by an atomic rename (exactly one of several processes wins; tested with 8 concurrent consumers), not a
    single file. Extra flags: `--static <dir>` (serves a site page for E-SI-*, with
    `Cross-Origin-Opener-Policy: same-origin-allow-popups`), `--allow-idp`, `--key-mode`. Exports
    `startSigninServer()` and `FileNonceStore` for tests.

## Requests to other lanes

- **Integrator (LOCK and formats-vectors FILES):** `test/unit/formats-vectors.test.mjs` fails until
  `identity.json` and `signin.json` are added to its `FILES` list and the 71 lines below are appended to
  `test/vectors/LOCK.json` (it reports "vector files are listed in FILES" first).
- **idp:** pass `verifyPointer` and `isPublicSuffix` to `labelFor`; show the KDF name from
  `describeKdf(blob)` on the card; Argon2id takes about 1.3 to 2.5 s here (item 2).
- **chat:** `sealTo` / `openFrom` adapters for sealed kinds 4 and 5 (item 10).
- **Review owner / D1:** prefixes of item 5 into R 2.10.3; INTERFACES v0.3 entries for `derive.js`
  (`labelFor` async with injected checks), `check.js` (second argument), `vault.js` (methods of item 8),
  `sealed.js` (new entry), `packages/verify` (store contract of item 11) when INTERFACES is promoted.

## Open

- Constant-time scalar multiply (or WebAssembly Argon2id) before 1.0; the outside review of R 2.19.
- Mobile timings for Argon2id (G-ID-6); Firefox rows not run.
- E-SI-1 to E-SI-5 and E-ID-12 belong to the integrator; npm publication of `@magnet-web/verify` is an
  owner step (the README carries the file hash; it changes with every edit of `verify.js`).

## LOCK lines (append to `test/vectors/LOCK.json` entries, in this order)

```
{"file":"identity.json","id":"id-001-phrase-zero","sha256":"996dd5d81ebbecf63180948713b227ce99c6c8c069998e7e8be242872dec06ba"},
{"file":"identity.json","id":"id-002-phrase-7f","sha256":"179f6a04c7a0e0a4421cc1dc259283625e1dd811dd8e2ab2358c6cd8e4113e02"},
{"file":"identity.json","id":"id-003-phrase-80","sha256":"423c9d61ca6d868fa897b0a5ec0a5a14e1c747bb6313f0c0e8dd7bf35cddb0c9"},
{"file":"identity.json","id":"id-004-phrase-ff","sha256":"930163ba8cc861ccf36a9604d94e025c18a9dbc24000853f84bb3be58cb4a1a4"},
{"file":"identity.json","id":"id-005-phrase-root1","sha256":"1177ef040aff1c03f2294c5584b4482e5d63623f6eeb242e759accc2b402d8af"},
{"file":"identity.json","id":"id-006-phrase-root2","sha256":"50d5ca05b42734ff26b0a962b8c3afe5e9651dd512156fd5a84f446216f1e083"},
{"file":"identity.json","id":"id-007-phrase-bad-checksum","sha256":"9014cb736f00b50ba940022f50246d6e97de933ad23657c097e7d7da15a2a602"},
{"file":"identity.json","id":"id-008-phrase-unknown-word","sha256":"a08a33a932bfa719c05c45586cbccb2847cf90f57796a14b56e2ffbd84b875f8"},
{"file":"identity.json","id":"id-009-phrase-eleven-words","sha256":"bb9405a1242f956bbd0bd3f57bf68bd6dbf96de3e6ec5f38ce4273bb9e4fbe2f"},
{"file":"identity.json","id":"id-009b-phrase-mistyped-passes-checksum","sha256":"c5c7ad7b8408ba334a26488710435f77c57bf8643bc9a8742eb5b272db6a813f"},
{"file":"identity.json","id":"id-010-root-star","sha256":"5126c1687dffa765ce08d15a804156e39ef204a39c181aa1034621b59d777f3a"},
{"file":"identity.json","id":"id-011-root-star-2","sha256":"61fc3dcf1a10ca0892b530545fde928b44521c3a8325e97ff04db34848a9abee"},
{"file":"identity.json","id":"id-012-root-star-extra-word","sha256":"c5a0e3f7c91710ba72ac05474918d7fafd9d79c044f3cc9d8b4c827efc8c8b33"},
{"file":"identity.json","id":"id-013-label-origin-1","sha256":"90908b4e49dc3645efb52ad693f6712c8a194941ae018be518af294a5c740119"},
{"file":"identity.json","id":"id-014-label-origin-2","sha256":"78eeaf391e00cb17a2a1e7163acad3f30a63fb7aa8dd726103f227cdabadca0c"},
{"file":"identity.json","id":"id-015-label-origin-3","sha256":"0baab466f8f8e5ebc2fa68002bdd77d2939290ba2d51c0dfc8c4a944af900a8e"},
{"file":"identity.json","id":"id-016-label-ledger-1","sha256":"009f938290a263be50a7482822008423b03ff96b50299bc1b5335c9b86015c96"},
{"file":"identity.json","id":"id-017-label-ledger-2","sha256":"eff0f228af36f0b75af9ebc9936cc56adae40cd63a1228339f8e95eae5e8f15b"},
{"file":"identity.json","id":"id-018-label-ledger-3","sha256":"155e82bd6c59dccc16c977b63014691d8e38544ffc54941ef409ca6e476d1979"},
{"file":"identity.json","id":"id-019-label-hub-1","sha256":"555e04d454f04946e9cc1547ed3516e53ba4f1afe0e78ddeef4a70096b92c1aa"},
{"file":"identity.json","id":"id-020-label-hub-2","sha256":"cc0508bb373ce3292bb0f7a9f0b56512b929f15588a646dec1473fdb8dd61088"},
{"file":"identity.json","id":"id-021-label-hub-3","sha256":"51a826d153768e28ee4c3aa7aed21516355385dfe9e95984d1e14156658290dc"},
{"file":"identity.json","id":"id-022-signature","sha256":"adcd0927d8b1ca334a89b2161d949ce0a938747a5d09c7e3e0ea705eecb2088b"},
{"file":"identity.json","id":"id-lc-001-origin-default","sha256":"09bd5032ee10f621933ea39cbe2b44934b0faf9d2f9dda74800145bf2c53654b"},
{"file":"identity.json","id":"id-lc-002-ledger-own-host","sha256":"fec9da1d1ebf721a9bec5e1deb6b8bda6f7798e0f1918f9a843ae82ac8537c13"},
{"file":"identity.json","id":"id-lc-003-ledger-org-listed","sha256":"2c4b15c0637a61cae846b76379387ad9e7439ef6a9502e1b5f364d564c5cc205"},
{"file":"identity.json","id":"id-lc-004-ledger-squat-other-owner","sha256":"97ae8f006716361eef82ba48affadd6169258cedb0d4c7468c95c8b481921cae"},
{"file":"identity.json","id":"id-lc-005-ledger-rot-chain","sha256":"57dd2a628a91d8003c45a28ba11c848db86430e54a30473f69f370dbac45b363"},
{"file":"identity.json","id":"id-lc-006-ledger-look-alike","sha256":"9e57d7a7d368d417385d5e1775421b1b6ff74047846602590c8e6e927bf3c3d3"},
{"file":"identity.json","id":"id-lc-007-ledger-org-too-long","sha256":"72003e7e95683550fbe0c130faa9f5cc776cf863edca52f886ba514916a157ba"},
{"file":"identity.json","id":"id-lc-008-ledger-unverified","sha256":"94ce83ea62569a794c0c3ad043ea5fd64bac25f4bf6e2fecbd4c6b6d8f85ca2e"},
{"file":"identity.json","id":"id-lc-009-hub-opt-in-psl","sha256":"8f2f80e0195e1ede77623ac5e126bfe4061e6f812cc6beba7632829aeca4640f"},
{"file":"identity.json","id":"id-lc-010-hub-not-psl","sha256":"30950b6aeae54fffbc2088261ce474012bada20f57019217e68d687d82619a51"},
{"file":"identity.json","id":"id-lc-011-hub-no-opt-in","sha256":"cd2b33b1c89dafcc0a6dc3033af8f86d6cd4f44d1e97304798a9b7173b2aacb4"},
{"file":"identity.json","id":"id-lc-012-hub-shared-origin","sha256":"1bd8c28d4e2d53c90c7f299641080bdede36220779160e299b5534fb594b3625"},
{"file":"identity.json","id":"id-lc-013-linked-origin","sha256":"6e4de1c7bdd10faec57758e4d649ac3ca02f803f041016ffaa3e5fbb2a76b7e4"},
{"file":"identity.json","id":"id-lc-014-linked-ledger","sha256":"df9cc021235a42bc8a9781ed55e242861aac81f11fe583b8178277cd9ea8fc1e"},
{"file":"identity.json","id":"id-lc-015-linked-hub","sha256":"14e38b7907f3d139713c1bb1f151353476fbf40b1ef6bb6d21e5b4a6fadf665c"},
{"file":"signin.json","id":"si-001-pairwise","sha256":"cbe70631f56496f53758ee5e9a4835c28dc88cd7ab39d28c9391a88336980ee3"},
{"file":"signin.json","id":"si-002-ledger","sha256":"84cd2d72a0396fc2f1d0ba0874971e90c0cf537f56898e1d1bb8745ad2160e66"},
{"file":"signin.json","id":"si-003-hub","sha256":"d219c24105b52bfffa4d85cd2d4f22841752c5a621ffd253c381337e892ce238"},
{"file":"signin.json","id":"si-004-linked","sha256":"6e0b65909cc3100705dc2ce32bcc02dcde77890a10533a1184e6bd861871de89"},
{"file":"signin.json","id":"si-005-resources","sha256":"94075d691a0a994f016aaaee09e8d4ba7badf1206c5766f7b64177e7276dcc36"},
{"file":"signin.json","id":"si-010-foreign-origin","sha256":"5d933ca69eb8028f1e3143a40083f8f63ffa1246d7f12f18187dbfb18f75040e"},
{"file":"signin.json","id":"si-011-foreign-domain","sha256":"56ea8058ff44a97befedfb527ba8853c3137f8e988b6e088a43a610bf0fa1b23"},
{"file":"signin.json","id":"si-012-exp-over-5-min","sha256":"052c89647f0814c2e5be1caee8308555fe442f4e1b3b71ace91c1902b99753de"},
{"file":"signin.json","id":"si-013-future-nbf","sha256":"534b6bd2687be0493fe3e6d5beef2a97697a0eab06efeeef651f930630948924"},
{"file":"signin.json","id":"si-014-reused-nonce","sha256":"c8f5278383546dfecaf46192ed089cda7aedd3dd602352aa47f2ccc22f0ce789"},
{"file":"signin.json","id":"si-015-high-s-accepted","sha256":"4d83ffd2a6126fdb39d413cae4b4dfef96a23058a2f8b082cefd110ec718f540"},
{"file":"signin.json","id":"si-016-high-s-replay","sha256":"cead4171ae66b6e88ae8086b11fd9eb0ef804a7af263c48a808903296d3700b4"},
{"file":"signin.json","id":"si-017-der-signature","sha256":"9f41636ba4e1e6ab6b3e34e2e57fe757e59f61a27ad989c5210fd610262b4caf"},
{"file":"signin.json","id":"si-018-alg-es256","sha256":"51f60d6a2e79dee3dad1255f67f094e34e7c2364822b0b46dc726e6210642c9b"},
{"file":"signin.json","id":"si-019-duplicate-keys","sha256":"1bc158da22a8ace0c1bab7cdf37e330c59d586af79eb10a5ada39e2f5edc67d1"},
{"file":"signin.json","id":"si-020-non-nfc-statement","sha256":"d3887c45ffe6017f564019f86ea33565e6357513c02cbff9af21ca3bb05539d4"},
{"file":"signin.json","id":"si-021-unknown-field","sha256":"9a1ea80818374e3453393c506240a05a1dc36e16a2ff8bdf5bb359fa67844a08"},
{"file":"signin.json","id":"si-022-ledger-unexpected","sha256":"aa57b13f8fea016524535165184585b4180faf0fdfb8ccbe5cb9d8b36884ea5f"},
{"file":"signin.json","id":"si-023-keymode-not-allowed","sha256":"ec66ea07b034c6aa7cf9071e48808a6f5440472051bc8968645480907c6d46c7"},
{"file":"signin.json","id":"si-024-over-4-kib","sha256":"d67035d2ab9c7f63277e69ae0578870aa4963c2b5c69e5cfe6a7a53478b7ee29"},
{"file":"signin.json","id":"si-025-bad-signature","sha256":"171dac6d515fdf9a000d7776483d0822fcd7da6d55c9a7130497d34fc51fda39"},
{"file":"signin.json","id":"si-026-nonce-not-issued","sha256":"d2201e97d4a8fc6f5f6146bdf4af2c3a1f28ab5fcce2dd799811ba6102c5bb13"},
{"file":"signin.json","id":"si-027-expired","sha256":"dc3768d6cad64e4c4a5e8bb6c55b5e78ed18594488edb70c6cbecae2b943b8ad"},
{"file":"signin.json","id":"si-028-idp-not-allowed","sha256":"fef07524f4db8663e28e7bbe555b0f1448cd0c07b386ef4f0c756dbb15ba9d16"},
{"file":"signin.json","id":"si-029-statement-mismatch","sha256":"2bb5c291eab6e0bc814126da2f548e77fdd3d921ec8e36375e9d501be9f76f6f"},
{"file":"signin.json","id":"si-030-version","sha256":"cc4f5287c03331d72c3518e38ac68b8ad4da2dfa4e031d442feed9a117ff4277"},
{"file":"signin.json","id":"si-031-control-character","sha256":"2355af0800df5ffcf147dddc674e3bd2fdb89f2815cf1a11eaebd1d8f22f2b9c"},
{"file":"signin.json","id":"si-032-bidi-control","sha256":"8ad8ba6faf812885da10fb22d510d93a6c1dab02530fa0e59192b754e88fc62a"},
{"file":"signin.json","id":"si-033-ledger-mismatch","sha256":"ebac3dc3a2d085a26877ff1c83368d4d94a3b3cfe13136456d0059a493324006"},
{"file":"signin.json","id":"si-034-order-origin-before-nonce","sha256":"de9307de49eb2cdefe1e77c76765347114876fcd6f007426cb64ea0bae40bcf2"},
{"file":"signin.json","id":"si-035-order-nonce-before-signature","sha256":"1c22ce001f490cfc23f1b1fa6fdc9d7746abeb60d440fd17f2cced98beaee395"},
{"file":"signin.json","id":"si-036-skew-inside","sha256":"d0d5173fe79c94cc9516c0074ebeefbf9b387ee0c61e43b99860cd78537ddb5c"},
{"file":"signin.json","id":"si-037-skew-outside","sha256":"d9510d5861a8f18c15908b73d83aa86543871db47ee0a321bdda6f6b0c6b89ec"},
```
