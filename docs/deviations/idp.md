# idp lane (v0.3 I2 + I3): identity origin, passkeys, device link, site identity client and service

Brief: R (docs/review/V03-DESIGN-REVIEW.md) 2.1, 2.2.3 to 2.2.7, 2.3.1 to 2.3.5, 2.3.8, 2.3.9, 2.4.1, 2.4.2, 2.5.4,
2.6.1, 2.11.2, 2.12, 2.14.1, 2.15, 3.3; MF-02, MF-03, MF-05 to MF-14, MF-17, MF-19, MF-20; R 1.5 N-1, N-2, N-6,
D-1 to D-5; ARCHITECTURE 15.1 to 15.3; INTERFACES v0.3 `src/idp/*`, `src/identity/client.js`, `store.js`,
`migrate.js`.

Files written (nothing else): `src/idp/{index.html,idp.js,cards.js,passkey.js,link.js,qr.js,store.js,sw.js,psl.js,strings.js,idp.css,_headers}`,
`tools/build-idp.mjs`, `src/identity/{client,store,migrate,service}.js`, `src/dropin/identity.js`,
`test/fixtures/idp/serve.mjs`, `test/unit/{idp-protocol,idp-cards,idp-link,idp-browser,identity-client,identity-store,identity-service,dropin-identity}.test.mjs`,
this file, and my two INTERFACES subsections (marked v0.3). No npm package added, no network used, nothing pushed,
dist/ not rebuilt, no e2e suite run.

## Results (2026-10-20, Apple M3, macOS 27.0, Node v24.22.0)

- `node --test` on the seven Node files: 77 tests, 77 pass, 0 fail (idp-protocol 11, idp-cards 15, idp-link 8,
  identity-client 10, identity-store 9, identity-service 13, dropin-identity 11: the 7 earlier tests unchanged and
  passing, 4 added).
- `MW_BROWSER=1 node --test test/unit/idp-browser.test.mjs`: 1 test, pass. Chromium 156.0.8078.4 with `chromiumArgs()`
  on `http://localhost` (WebAuthn needs a domain RP ID) and WebKit 27.2 on `http://127.0.0.1` only. Firefox: not run.
- `node tools/lint-floor.mjs`: clean (127 files); also clean on `tools/build-idp.mjs`, `test/fixtures/idp` and the browser test.
- A scratch end-to-end run (not a repo test; E-ID-1 stays with the integrator): the built bundle served by
  `test/fixtures/idp/serve.mjs` with its `_headers` on `localhost:<p1>`, a site page on `127.0.0.1:<p2>`, a real popup
  and the virtual authenticator: card shown, passkey made with PRF, bundle and a `mw-signin-v1` proof bound to the
  site origin received, the second card showed the remembered short id; no page error under the real CSP.

### Measured

| What | Value |
|---|---|
| Chromium 156 virtual authenticator (`hasPrf`) | PRF output returned by `create()`: 1 ceremony at enrolment; the same output on a later `get()` and on a discoverable `get()` |
| KDF choice under the IdO CSP (`script-src 'self' 'wasm-unsafe-eval'`) | Argon2id in Chromium 156 and WebKit 27.2 |
| KDF choice under `script-src 'self'` or with `WebAssembly` deleted | PBKDF2-SHA-256, 600,000 iterations, named on the card, in both engines |
| QR encoder and decoder (`src/idp/qr.js` alone, esbuild 0.28.2 minified) | 17,589 bytes, 7,571 bytes gzip (level 9) |
| QR decode of a 640x480 RGBA frame in Node 24 | 2.8 to 8.1 ms (versions 6, 9, 25), 2.0 ms for an empty frame (5 runs each) |
| QR decode of synthetic distortions | 108 of 108 decoded: versions 6, 11, 16; rotations 0 to 2.5 rad; perspective factor 0 to 0.3; noise 0 and +/-30 |
| IdO bundle (`dist-idp/idp.js`, minified) | 175,725 bytes, 63,389 bytes gzip (includes Argon2id, BIP-39, pointer and vault code) |
| Reproducibility | two builds of the same sources gave the same `idp.js` sha256 and build id (unit test) |

Nothing on phones, Safari or Firefox was measured (G-ID-1 to G-ID-9 are owner steps).

## Deviations and contract details (also in my INTERFACES subsections)

1. **No default identity origin is built in.** N-2 makes the project the operator, but no address exists yet (owner
   decision). The client finds the IdO from `configure({ idp })`, then `<meta name="mw-idp" content="https://...">`,
   then the pointer's `idp=`; without one it fails with `E_IDP_UNREACHABLE`.
2. **Request fields beyond R 2.3.2** (all optional; an unknown field is refused, so no parameter can preselect "same
   identity", a label, a key mode, a domain or an origin): `scope` (the scope the loader verified the pointer under:
   a mirror shows a pointer published for another name; the signature must still verify for it and the origin must
   still be that scope's host or in `org=`), `shared` (shared-origin hub), `hubDefault` (the hub checkbox's initial
   state only, R 3.1 "default on for this template"), `create` (personal site, R 3.3), `owner: { what }` (owner-action
   card), `escrow: { root, vault }` (R 2.2.5), `record` (the site's sealed copy of its private record), `legacy:
   { pub, ledger, name }` (R 2.2.7). `want` gains `record` (the `mw.me.get` first-use card) and `erase` (R 2.15).
   Redirect requests also carry `origin` and `ret`; popup requests may not.
3. **Answer and rounds**: `{ v: 1, t: 'mw-signin-res', requestId, ok, bundle?, proof?, record?, erased?, code? }`.
   Two optional rounds in popup mode only: `mw-idp-count` -> `mw-idp-count-res` (the "Found N posts" line after a
   restore; the site's answer is informational) and `mw-idp-legacy` -> `mw-idp-legacy-res` (the 0.2.1 key sealed to an
   IdO ephemeral key, asked only after the person chose keep or fresh). The ready message is `{ v, t, build }`, posted
   with targetOrigin `'*'` (it carries nothing else); every answer and round goes to `event.origin` only.
4. **Bundle fields beyond R 2.3.3**: `origin`, `pub`, `short`, `ledger`, `local` (K_local, ARCHITECTURE 15.1),
   `rc` (b64url sha256 of the label's recover public key, for `keyinfo`), `status` (`kitSaved`, `fileSaved`,
   `passkey`, `persisted`, `legacy`: what `mw.identity.backupStatus()` reports), `stay` and `sharedComputer` (the
   person's choices on the card, never the page's), `chat.pub`, and when they apply `legacy`, `owner`, `record`,
   `erased`. `rec` and `chat` are the current epochs only. `name` is K_name. Never the root, root*, K_vault, the
   phrase, the PRF output or another label's keys (tested).
5. **ECIES details**: ephemeral P-256, HKDF-SHA-256 with an empty salt and info `prefix + '|' + origin`, AES-256-GCM
   with a random 12-byte IV, AAD `prefix \n origin \n requestId \n epk`. **New prefixes** `mw-idp-record-v1` (record
   answer), `mw-idp-legacy-v1` (legacy key) and `mw-local-cache-v1` (caches sealed under K_local). Request to the
   review owner and D1: add them to R 2.10.3.
6. **Shared-origin hubs get a random key per visit** (`keyMode: 'visit-only'`, `label: null`): nothing derived,
   nothing stored, no proof (`E_HOST_ONLY_IDENTITY`), memory only on the site. The loader also sets `sharedHub` for a
   subdomain hub that is not on the PSL (lane sdk does).
7. **Pointer check** (`verifyPointerFor`): scopes tried are the request's `scope`, the origin's hostname,
   `btih:<infohash>`, then the `org=` hostnames. "The pointer's own host" is the scope's hostname without a port, so a
   non-default port (loopback tests included) is listed only through `org=`. Expired records still name their owner
   (the loader may serve a cached copy), so the label does not flip when a record expires; instead the IdO keeps a
   per-ledger seq floor and refuses a lower seq (`rollback`, origin label). Only one-step `rot=` lineage is verified
   (`lo` signed the rotation to `owner`); longer chains get the origin label.
8. **The root lives in the vault** (`vault.data.root`, b64url of the 16 bytes) so the phrase can be shown later:
   `wrap.js` packs only root* and K_vault. It travels inside the vault in the backup file and the device link. A
   phrase-only restore has an empty vault by design, so the rotation index of every label is 1 again: after "Replace
   my keys" a phrase-only restore gives the earlier keys back (stated limitation; the backup file keeps the index).
9. **User verification**: every unlock asks with `userVerification: 'required'`; `approvalAllowed` also refuses the
   first approval of an origin when the assertion lacks the UV flag (`E_UV_REQUIRED` on the IdO card, `E_USER_CANCELLED`
   to the site). A passphrase or phrase typed at the IdO counts as verification.
10. **Display cache at the IdO**: a plaintext record in the IdO's IndexedDB lists the origins signed in to, their short
    ids, links, hub choices, same-identity offers and refusals, seq floors, the check code and the backup flags. The
    card needs it before unlock. Anyone with this device's storage can read it (like browser history); "Remove my
    identity from this device" wipes it. Stated here for PRIVACY.md (request to D1).
11. **Same-identity pressure limits**: options appear only in the card's mode menu, whose default is "Private to this
    site"; choosing one opens a separate confirm card whose confirm button ignores presses in its first 800 ms (Back is
    the primary button). "Offered" means that confirm card was shown (then not again for 30 days); Back records a
    refusal, remembered until Settings changes it. Linking writes nothing to any ledger.
12. **The Public Suffix List snapshot is curated from memory** (28 private-section entries such as github.io,
    pages.dev, netlify.app; no ICANN section, so a single-label TLD is never a hub suffix). The build had no network.
    A hub that is not listed gets per-origin keys until the snapshot is updated. `tools/build-idp.mjs --test
    --test-psl <suffix>` adds suffixes for loopback tests (refused without `--test`; such a build says "Test build").
13. **KDF choice probes WebAssembly** (`new WebAssembly.Module` of an 8-byte module, which needs `'wasm-unsafe-eval'`
    under the IdO CSP). idcore's Argon2id is plain JavaScript, so it would run anyway; the R 2.2.4 rule is kept so an
    engine without WebAssembly (Safari below 16) never runs a 64 MiB JavaScript Argon2id. The card names the KDF.
14. **Device-link codes** carry a step letter: `mwlink:2:c:<H(eB)>:<nonceB>`, `mwlink:2:a:<eA>`, `mwlink:2:b:<eB>`,
    `mwlink:2:s:<iv || ct>` (AAD `"mw-link-v2\n" || H(eB) || nonceB`), then the K_vault-encrypted vault blob in parts
    `mwlink:2:v:<i>:<n>:<900 chars>` (the vault does not fit one QR). Every code is checked against the 120 s window
    of the device that receives it.
15. **QR codec**: written here (no package): byte mode, ECC level M by default, versions 1 to 40, the eight masks with
    the four penalty rules; the decoder reads numeric, alphanumeric and byte segments, skips ECI and refuses Kanji.
    `BarcodeDetector` is used where it exists, the bundled decoder elsewhere; a typed code is the last resort.
16. **Private record shape**: `{ f: { name: value }, ft: { name: ms }, t }` merged per field, newest write wins,
    removals included (`mergeRecords`), so a write on one device never drops newer fields from another. The vault keeps
    `labels[label].me[origin]`; the site keeps a copy sealed under K_local that goes back with each request. Synced
    ledger items: one kind 1 index item `{ v: 1, n, t }` and up to 31 kind 2 data items with `ver = floor(t / 1000)`.
17. **`mw.me.get` first use per session opens the IdO card** (`want: ['record']`), as R 2.3.4 lists "read private
    record" among the high-risk cards; `mw.me.sync({ on: true })` uses the loader's in-page consent card
    `prompt('consent', { card: 'syncRecord' })`.
18. **Erase** shreds K_rec and K_own of the label (origins linked to the same label lose their records too) and issues
    fresh ones, then the site tombstones its own `mw.s` items. Older vault blobs kept as escrow on other sites still
    hold the old keys under K_vault (only the person's own unlock opens them): stated limitation.
19. **Reserved field names** (`E_FIELD`): email, mail, phone, tel, telephone, mobile, legalname, fullname, realname,
    surname, firstname, lastname, birthdate, birthday, dob, dateofbirth, age, documents, document, passport, idcard,
    license, ssn, sin, nationalid, health, medical, diagnosis, address, homeaddress, plus any name containing email,
    phone, passport, birth, health, medical, legalname or ssn (case and `_ . -` ignored).
20. **Redirect in drop-in mode**: `/_mw/idp-return` is a page of its own there, so memory keys would not survive the
    way back. `completeRedirect({ defer: true })` keeps the still-encrypted answer in this tab's sessionStorage and
    the page at `returnTo` opens it (`takeDeferredAnswer`) with the pending page key. A proof answer is never kept
    there (MF-14): it is refused with `E_POPUP_BLOCKED`. The pending page key is a non-extractable CryptoKey in
    IndexedDB, or (when IndexedDB cannot hold it) a one-request JWK in sessionStorage.
21. **Promise fields**: `challenge`, `escrow`, `record`, `legacy`, `pointer` and `scope` may be promises, resolved
    after the window opened, so every UI method reaches `window.open` before its first await (tested). The cooldown
    of 10 s is per kind (sign-in, server, record, erase).
22. **Error mapping** (`siteCode`): the site sees `E_USER_CANCELLED`, `E_HOST_ONLY_IDENTITY`, `E_UNSUPPORTED`,
    `E_NONCE_REQUIRED`, `E_BAD_REQUEST`, or `E_IDP_UNREACHABLE` for an internal failure; the IdO's own reasons (wrong
    passphrase, no UV flag, a bad link code) stay on its card.
23. **Service surface for the sdk lane**: `keys()` (a method, as `api.js workingKeysOf` reads it first) and a
    `workingKeys` getter, `adopt(result)`, `restore()`, `follow(identity)`; events `auth`, `kit` (the first meaningful
    action without a saved kit: show a prompt that calls `identity.openIdentity({ intent: 'kit' })`) and `keychange`
    (a `rotateNotice`). Follower tabs get `E_POLICY` for everything but reads. `deps.node` may be the node, a live
    proxy or a function. `identity.current()` adds `keyMode` and `did` (`did:key:z...`, multicodec p256-pub 0x1200).
24. **"Replace my keys on all sites"** bumps the rotation index of every label; each origin's next sign-in returns
    `rotateNotice = { from, next, i, rp, t, ledger?, rsig? }` once, with `rsig` by the recover key over
    `"mw-rotate-v1\n" + ledgerId + "\n" + from + "\n" + next` when the request carried a verifiable pointer (the `rotate`
    op by `recover` of R 2.5.3). For personal sites `nextPubHash` (R 3.3) is `nextKeyCommitment(signKey(label, i + 1))`,
    which is exactly the key that rotation moves to (tested).
25. **The iOS recovery kit** (outside Home Screen mode, every visit until saved) is shown in the IdO window after the
    site has its answer, so the site never waits on it and closing it cancels nothing; in redirect mode it comes
    before the way back. Elsewhere the site asks for it after the first meaningful action (the `kit` event).
26. **Owner actions** show an IdO card and return `owner: { what, confirmed: true }`; the site still signs with its
    working key (R 3.3 keeps personal-site owner keys on the person's origin).
27. **`src/dropin/identity.js`**: the 0.2.1 functions stay for migration; `ensureIdentity` takes `create` (default
    true, so `ledger.js` keeps working until the integrator switches the v0.3 path to `create: false`). Added
    `createDropinIdentity`, `legacyAccess`, `countPostsBy`. Test changes: 4 tests added (create: false with legacy access
    that never offers a moderator key, the post count, the adapter's sign-in with the 0.2.1 key migration, the
    return-page hand-off); the 7 earlier tests are unchanged.
28. **IdO pages and headers**: `/signin` is served as `signin/index.html` (static hosts) with relative asset paths,
    SRI on the script and the stylesheet, and `<meta name="mw-idp-build" content="<version> <build id> <bundle
    sha256>">` shown on every card. `_headers` adds to R: `default-src 'none'`, `style-src 'self'`, `connect-src 'self'`,
    `worker-src 'self'`, `media-src 'self' blob: mediastream:` (camera for the device link), `base-uri 'none'`,
    `form-action 'none'`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(self) ...`. No
    `Cross-Origin-Opener-Policy` (the opener link must stay). The worker takes a new build only when every IdO window
    has closed (no skipWaiting).

## Requests to other lanes and the integrator

- **Integrator**: add `dist-idp/` and `dist-idp-test/` to `.gitignore` (the auto-checkpoint runs `git add -A`; I built
  only into the scratchpad). For E-ID-1 to E-ID-15: `node tools/build-idp.mjs --test --test-psl localhost --out <tmp>`,
  then `startIdpServer({ dir })` from `test/fixtures/idp/serve.mjs`; open the IdO as `http://localhost:<port>` in
  Chromium (WebAuthn needs a domain RP ID; `chromiumArgs()` keeps localhost) and the site as `http://127.0.0.1:<port2>`;
  WebKit has no virtual authenticator, so its rows use the passphrase path. A virtual authenticator must be added to
  the popup's own CDP session (it is per target).
- **Integrator (neighbour tests seen failing, not caused by this lane)**: `dropin-engine.test.mjs` "v0.2.1 A4: identity
  export and import from the panel Settings" (the engine's settings model now has `legacy`) and `dropin-mw.test.mjs`
  "createDeps: every loader yields the module the engine expects" (a new `v03` loader): both from the drop-in engine
  edits in progress at 11:18 ET.
- **ui (widget)**: `<mw-signin>` awaits the challenge fetch and `import('../identity/client.js')` before `signIn`, so
  `window.open` may run after the click's activation (Safari is strict). Import the client up front and call
  `client.signIn({ purpose: 'server', want: ['proof'], challenge: fetchChallenge() })` inside the click: the client takes
  the challenge as a promise. The page also needs `<meta name="mw-idp" content="...">` or `client.configure()`.
- **tools (T1)**: `publish --signin-widget` should print the `mw-idp` meta tag next to the script tag; publishers of
  mirrors list every serving origin in `org=` (the ledger label needs it).
- **sdk**: pass `scope` (the scope the pointer was verified under) to `createIdentityService`; forward the `kit` event
  to a loader prompt that calls `identity.openIdentity({ intent: 'kit' })`; on `keychange` with `rotateNotice.rsig`
  and `rotateNotice.ledger === ledgerId`, write the `rotate` op (`by: 'recover'`) once the freeze group lands; call
  `restore()` once in the engine tab and `adopt()` with a finished redirect (both already done in app.js and
  engine.js).
- **D1 / review owner**: the three prefixes of item 5 into R 2.10.3; PRIVACY.md: the IdO display cache (item 10) and
  the vault-rollback limitation of item 18; ARCHITECTURE 15.1 to 15.3: the `scope` hint, visit-only keys on shared
  hubs, the root kept in the vault, the deferred drop-in redirect.

## Open

- Real devices: G-ID-1 to G-ID-9 (iOS ITP and escrow rescue, Android PRF, PRF equality across synced devices,
  Firefox, the device link by camera, Argon2id time on phones, popup and opener behaviour, the floor browsers, the
  comprehension test). Firefox rows: not run.
- WebAuthn `largeBlob` is not used (G-ID-3b first). A vault blob kept as escrow on another site can bring back keys
  shredded later, after the IdO lost its storage (item 18).
- The camera scanning loop and the QR decoder were exercised on synthetic frames only; G-ID-5 measures real cameras.
- The 30-day pressure window and the 800 ms second-press delay are chosen values (UX gate G-ID-9).
