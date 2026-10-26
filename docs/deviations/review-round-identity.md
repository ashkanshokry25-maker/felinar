# Review round: identity fixer (2026-10-24)

Area: identity. Brief: fix the confirmed findings of the v0.3 design review round
(`.orchestration/reports/all-findings-2026-10-22.json`, verifier notes in `verdicts-2026-10-23.json`) in the files this fixer
owns: `src/identity/**`, `src/idp/**`, `packages/verify/**`, `src/dropin/**`, `src/widget/**` (not `redress.js`),
`docs/specs/mw-signin-v1.md`, their unit tests and `test/e2e/scenarios-identity.mjs`. No wire, storage or vector format
changed: the escrow copies keep the blob shapes `acceptEscrow` takes (`src/idp/store.js:208`), the vault copy only
gains trailing spaces inside its JSON (`src/identity/vault.js:272-288`), and `test/vectors/` is untouched.

## Results (2026-10-24, 04:00 to 04:36 EDT, Apple M3, Node v24.22.0)

- Area unit files (every `test/unit/{idp,identity,signin,widget,dropin}-*.test.mjs` without the browser ones, plus
  `idp-review-round.test.mjs`): 397 tests, all pass. New file `test/unit/idp-review-round.test.mjs` (12 tests); new tests in
  `identity-client.test.mjs` (4), `identity-service.test.mjs` (3), `idp-protocol.test.mjs` (2, and two rewritten).
- `npm test`: lint floor clean (147 files); 2,266 tests, 2,246 pass, 1 fails, 19 todo. The one failure is not this
  area's: `the top level holds only what the release layout lists` (a tracked top-level `SECURITY-KEY.asc` from another
  fixer).
- e2e, every request on 127.0.0.1: E-SI-1 to E-SI-5, E-ID-1, E-ID-2, E-ID-2B, E-ID-4, E-ID-5, E-ID-6, E-ID-10, E-ID-9,
  E-ID-9B, E-ID-3, E-ID-3B, E-ID-8, E-ID-11, E-ID-13, E-ID-14, E-ID-15 passed in the first run. E-SO-1, E-SO-2, E-SO-11 and
  E-ID-7 failed there because a first version of the PTR-10 fix stopped hubs from naming their identity origin (see PTR-10);
  after the change they passed (4 of 4, 98.0 s). E-ID-4 with its new escrow assertion: pass (24.4 s). E-SI-1W, E-SI-5W,
  E-CH-R, E-CH-1, E-HD-1, E-SO-12: 6 of 6 pass (113.2 s).

## Findings

| Id | Status | What changed (file:line) | Regression test |
|---|---|---|---|
| SEC-1 | fixed | Each site gets copies made for its origin: the root copy is wrapped again under the PRF output (kept in `session.prf` only while the window is unlocked, `src/idp/idp.js:584`) with a fresh IV and no `credId`; the vault copy is encrypted again with a fresh IV, padded (`src/identity/vault.js:64`, `:272`) and named `escrowIdOf(root*, origin)` (`src/idp/store.js:181`); `escrowFor` `src/idp/idp.js:522`, used at `:1180`. A copy is recognised by opening it (`src/idp/idp.js` `openEscrowVault`), an escrow root without `credId` unlocks by a discoverable passkey call, and a copy another window took back is compared by its secrets, not its bytes. | `idp-review-round.test.mjs` "SEC-1, STALK-1, PHISH-2"; e2e E-ID-4 (the two origins' IndexedDB copies differ in id, IV and ciphertext, one length) |
| STALK-1 | fixed | Same change; the vault copy's length is one of a few buckets (16,384 bytes up to about 20 sites, then powers of two), so it no longer counts sites. | same tests |
| PHISH-2 | fixed | Same change. The origin is not bound into the copies' AAD (a format change; nothing needs it, since no two sites hold the same bytes). | same tests |
| SEC-2 | fixed | The identity origin refuses by redirect anything but a key sign-in or the record read (`redirectAllowed`, `src/idp/idp.js:1223`, applied at `:888`; the client side `redirectOk`, `src/identity/client.js:175`). A redirect sign-in is `unverified`: no approval, no hub decision, no same-identity link, no site in the vault, and a rotation notice is not marked delivered (`src/idp/idp.js:854`, `:1161`). The client starts a redirect only for what it may carry (`src/identity/client.js:553`). | `idp-review-round.test.mjs` "SEC-2, PHISH-9"; `identity-client.test.mjs` drop-in redirect test (a proof never goes by redirect) |
| PHISH-9 | fixed | Same change, and the card says "A page that says it is <origin> sent you here. Lightweb cannot confirm which page it was." with no identicon (`src/idp/cards.js` signin; string `unverifiedOrigin`). Spec: `docs/specs/mw-signin-v1.md:41`. | same tests |
| SEC-3 | fixed | `runRestore` on a device with an identity first shows a card with the current check code and unlocks that identity (`src/idp/idp.js:666`); the same words or file again keep the vault and everything in it; other words show both check codes before anything is replaced; a restore that started on an empty device never overwrites one made meanwhile (`fresh`). | `idp-review-round.test.mjs` "SEC-3, PHISH-4" |
| PHISH-4 | fixed | Same change; `#restore` and `#link` in a window a site opened draw only "open the identity page yourself" (`src/idp/idp.js:1550`); `client.openIdentity` no longer sends `restore` or `link` (`src/identity/client.js:918`); a file restore shows the file identity's check code; the post count card says "This count comes from the site." | same test |
| UX-4 | fixed | The restore card keeps the typed words (`src/idp/cards.js:623`) and names the word or the count (`phraseError`, `src/idp/idp.js:648`); a "No" at the check code says why; list numbers, dots and commas are dropped from typed words (`src/identity/derive.js:67`). | `idp-review-round.test.mjs` "UX-4" |
| UX-5 | partial | Continue is the main button and "Check the words" takes the restored identity off and opens the restore card again (`E_RESTORE_RECHECK`, `src/idp/idp.js:1073`, `dropRestored` `:1210`, `src/idp/store.js:156`); the drop-in count is null on a copy with nothing past the genesis (`src/dropin/identity.js:218`). The loader's own count (`src/loader/api.js:2059`) is another lane's: Request 1. | `idp-review-round.test.mjs` "UX-5" |
| UX-9 | fixed | Every card moves focus to its heading (tabindex -1), an untitled card to itself, an error line to the error (`focusOn`, `src/idp/cards.js:211`); never a button. | `idp-review-round.test.mjs` "UX-9"; e2e E-ID-9, E-ID-9B pass |
| UX-12 | fixed | Settings offers "Ask me again on <hub>" for a hub answered no (`hubAsk`, `src/idp/idp.js:1346`; `src/idp/cards.js:1048`), so a first unticked answer is no dead end; the box is ticked by default only for a page whose code is one of the build's hub templates and that asks for the default (`buildDefault`, `src/idp/cards.js:346`). The build flag that lists templates and the social example's sentence are Requests 2 and 7. A refusal is still remembered (R 2.3.5, as the verifier noted). | `idp-review-round.test.mjs` "UX-12, STALK-6"; `idp-protocol.test.mjs` "PHISH-1, HUB-3" (build default) |
| PRIV-4 | fixed | The sign-in window, the redirect and the identity window leave the site's page while `<meta name="referrer" content="no-referrer">` is in force (`withoutReferrer`, `src/identity/client.js:378`, used at `:560` and in `startRedirect`, `openIdentity`); the page's own policy comes back after 1 s. Documentation of the drop-in host header is Request 3. | `identity-client.test.mjs` "PRIV-4, HUB-9" |
| PRIV-6 | partial | The code follows R 2.15 (erase removes K_rec and K_own only), which both verifiers confirm; the defect is the cell `docs/PRIVACY.md:275`, not this area's: Request 4. | none (documentation) |
| SCALE-3 | fixed | A synced update writes its data items first and its index last; a record over `MAX_SYNC_RECORD_BYTES` (13 data items) stays on the device with no write; old items wait in `stale` when the throttle refuses a tombstone and go at a later sync (`src/identity/service.js:57`, `:333`, `:403`). | `identity-service.test.mjs` "SCALE-3" (a throttled node, 30 and 20 writes per 10 minutes) |
| SCALE-5 | partial | An unchanged record writes nothing (`src/identity/service.js:411`), and SCALE-3's retry leaves no live old items. Each real update still leaves stubs until an owner checkpoint: the per-visitor bytes, the checkpoint cadence and the owner warning are Request 5. | `identity-service.test.mjs` "SCALE-5" |
| SEC-4 | fixed | Up to `MAX_PARTS` (396, the vault cap) vault parts, taken for 20 minutes after the identity code arrived (`src/idp/link.js:36`, `:184`); a link whose parts did not all arrive ends with an error, never an identity without its vault (`src/idp/idp.js:790`). | `idp-review-round.test.mjs` "SEC-4" (150,000 bytes at 2 s a code) |
| STALK-5 | fixed | The create card offers the extra word, typed twice, with its warning (`src/idp/cards.js:474`); `createIdentity` passes it to `rootStar` (`src/idp/idp.js:534`). | `idp-review-round.test.mjs` "STALK-5" |
| STALK-6 | fixed | Settings draws the sites, links, hubs and check code only after an unlock in that window; "Remove my identity from this device" needs none (`src/idp/idp.js:1510`, `src/idp/cards.js:1009`); "Shared computer" saves nothing about the site in the clear state record (`src/idp/idp.js:1161`). THREAT-MODEL row: Request 6. | `idp-review-round.test.mjs` "UX-12, STALK-6" |
| PTR-10 | partial | `resolveIdp` takes `trustPointer` (`src/identity/client.js:368`) and reads `idp=` only from a signed record (`:337`); the identity service passes `trustPointer: false` when the loader sets `deps.linkPointer` (`src/identity/service.js:281`). Turning it on for every hub label at once (first version) broke E-SO-1, E-SO-2, E-SO-11 and E-ID-7: a hub has no other way to name its identity origin today. The loader must pass the operator's identity origin and `linkPointer`: Request 8. | `identity-client.test.mjs` "PTR-10, PHISH-10"; `identity-service.test.mjs` "PTR-10" |
| PHISH-1 | partial | The hub label goes only to one of the hub's own pages: a verified pointer whose derived address is this origin and whose btih is a build template (`HUB_TEMPLATES`, `src/idp/psl.js:102`) or, without a build list, the template of the page where the person turned the hub identity on (`src/idp/idp.js:933`); any other label gets its own key and the card says "This page is not one of <hub>'s own pages". A stranger's erase reaches only its own label. Open: a signed pointer's owner may claim the template btih for his own ledger, so the loader must load only template code on a hub, and `createPage` must take the template from that list: Request 9. | `idp-protocol.test.mjs` "PHISH-1, HUB-3" and "hub identity"; e2e E-SO-1, E-SO-2, E-SO-11 |
| HUB-3 | partial | Same change, and the card says "a page of <hub> that you sign in to can post as you on every page of <hub>" (`src/idp/strings.js:30`). Splitting the page-owner key from the member key and the owner hand-over are not built; with the loader and build parts: Requests 2 and 9. | same tests |
| PHISH-3 | partial | The card's lines follow the menu (`drawKeyLines`, `src/idp/cards.js:362`); the confirm card says the other site's key is handed over and what that allows (`src/idp/strings.js:91`); "Stop using the same identity" moves the shared label to a new signing key, chat epoch and record epoch with a rotation notice (`stopSame`, `src/idp/idp.js:1317`), or says it cannot for a label that owns a page. Not done: the typed confirmation (the e2e driver answers the confirm card by its button only: Request 10) and link certificates instead of shared keys (a design change). | `idp-review-round.test.mjs` "PHISH-3"; `idp-cards.test.mjs` confirm card |
| PHISH-5 | partial | `#link` in a window a site opened is refused before any passkey call (`src/idp/idp.js:1550`); the number card says what a match releases (`src/idp/idp.js:818`). Not done, because E-ID-14 (`test/e2e/scenarios-identity-rows.mjs:697`, not this fixer's) drives the exact card sequence: a card before the unlock, a fresh user verification at release and dropping typed codes on the old device. Request 10. | `idp-review-round.test.mjs` "PHISH-5, PHISH-12"; e2e E-ID-14 |
| PHISH-6 | fixed | A label is marked as a page owner only with evidence: "Create your page" confirmed under the hub key on one of the hub's own pages, or a pointer verified for the origin whose owner (or lo) is this key (`src/idp/idp.js:1047`); `create` and `owner` are refused with `purpose: 'server'`; "Replace my keys" names the sites it keeps (`keptSites`, `src/idp/idp.js:1291`). | `idp-protocol.test.mjs` "PHISH-6" and the rewritten personal-sites test |
| PHISH-8 | partial | The protocol part (rc and a rotation in a proof) needs a new format version (the verifier confirms: exact-field rule at `packages/verify/verify.js:341`). Documented now: `packages/verify/README.md:97`, `docs/specs/mw-signin-v1.md:168`. DEPLOY and the recipe: Request 11. | `signin-verify.test.mjs` (hash and README pinned) |
| PHISH-10 | partial | An unsigned pointer names no identity origin (`src/identity/client.js:337`); restore and link refuse a site-opened window (see PHISH-4, PHISH-5). The page meta keeps its rank above a pointer (the verifier: it is the operator's only override of a link-carried pointer, PTR-10). Not done: the personal verification phrase, the popup's own restore button (E-ID-3 restores through it), naming the identity host in the loader's prompt (Request 12). | `identity-client.test.mjs` "PTR-10, PHISH-10" |
| SUP-6 | partial | The card says its hash is for information and names the signed release list (`src/idp/strings.js:56`, shown at `src/idp/cards.js:224`). The live-origin check is a tool of another lane: Request 13. | none in this area |
| SUP-7 | partial | `tools/build-idp.mjs` is another lane's: Request 14. | none in this area |
| HUB-9 (minor) | fixed | Same change as PRIV-4. | as PRIV-4 |
| PHISH-11 (minor) | fixed | `validateRequest` applies mw-signin-v1 section 5 (280 characters, NFC, no control or bidi) before any card (`src/identity/client.js:144`). | `identity-client.test.mjs` "PHISH-11" |
| PHISH-12 (minor) | fixed | The identity page draws one card and stops inside a frame (`refuseFramed`, `src/idp/idp.js:1354`). An unlock for "Remove my identity from this device" is rejected: STALK-6 asks for that way out without unlock, and removing exposes nothing. | `idp-review-round.test.mjs` "PHISH-5, PHISH-12" |
| PHISH-13 (minor) | rejected | minor, deferred: a full, dated Public Suffix List needs a vendored file and a build step (`src/idp/psl.js:6` is a curated snapshot). | none |
| PRIV-7 (minor) | rejected | minor, deferred: the sentence is `src/loader/strings.js:522` (not this area's); Request 12 covers it. | none |
| SEC-8 (minor) | rejected | minor, deferred: always running the pure-JS Argon2id (64 MiB) where WebAssembly is missing needs a measured time budget on slow devices (`src/idp/idp.js:96`, docs/deviations/idp.md item 13). | none |
| SEC-9 (minor) | fixed | A full nonce store answers `store-full`, not `replay` (`packages/verify/verify.js:365`); README and spec updated, with the new sha256. | `idp-review-round.test.mjs` "SEC-9"; `signin-verify.test.mjs` |

## Requests

1. **UX-5, `src/loader/api.js:2059` (`countPostsBy`)**: return `null` while the node has not synced at least once (and from a
   follower node), as `src/dropin/identity.js:218` now does; the identity page shows nothing for `null`
   (`src/idp/idp.js` checks `Number.isSafeInteger(reply.count)`). Test: a node whose state holds no block past the genesis
   gives `null`.
2. **PHISH-1, HUB-3, UX-12, `tools/build-idp.mjs:127`**: add `--hub-template <40-hex btih>` (repeatable, part of the build
   id): `if (hubTemplates.length) define.MW_HUB_TEMPLATES = JSON.stringify(hubTemplates);`. `src/idp/psl.js:102` reads it.
   Then `test/e2e/hub-stack.mjs:43` builds with the template's btih. Test: build with one template; `HUB_TEMPLATES` lists it.
3. **PRIV-4, `examples/existing-site-dropin/_headers:4`** `Referrer-Policy: strict-origin-when-cross-origin` -> `no-referrer`;
   `docs/DEPLOY.md` (drop-in headers) and `docs/recipes/signin-widget.md:38`: say the page should send `no-referrer`
   (the client now sets it for the moment of the navigation, `src/identity/client.js:378`); `docs/PRIVACY.md:249`: add
   "and, from a page whose own policy sends one, the address of the site when the identity page's window misses its cache"
   only if a host sets a policy that overrides the meta.
4. **PRIV-6, `docs/PRIVACY.md:275`**: change the "Removed by" cell of "Chat key private halves, one per epoch" from
   `deleting a key retires it; "Remove my private data on this site"` to `deleting a key retires it; "Remove my identity from
   this device" (the copy on this device)` (R 2.15: the erase removes K_rec and K_own only).
5. **SCALE-5, `docs/OPERATIONS.md` (capacity, near the `ledger-admin capacity` text) and `src/chain/node.js`**: state the
   residue of a synced update (about 0.74 KiB of stub per replaced item, items of 1.9 KiB) against the 2 MiB reserved pool and
   a checkpoint cadence; wire the node's 80 % `E_LEDGER_FULL` warning (`onWarning`) to the owner's console.
6. **STALK-6, `docs/THREAT-MODEL.md:81`**: the "remains" cell gains "the identity page's display cache lists the sites
   signed in to (Settings shows it after an unlock; anyone with the device's storage can read the IndexedDB record)".
7. **UX-12, `examples/social/js/strings.js:66`** (HUB_IDENTITY): replace "and does not let you change the answer yet" with
   "Choose \"Ask me again on <hub>\" in its Settings, then sign in here again."
8. **PTR-10, `src/loader/app.js` (identityExtra, about line 3080)**: pass `linkPointer: A.mode.mode !== 'shell'` and the
   operator's identity origin as `idp` once the loader has one (a hub or door config field, or `configure()` from the hub's
   own `<meta name="mw-idp">`); `src/identity/service.js:281` then stops a link-carried `idp=` from choosing the identity
   origin. Until then hubs keep the pointer's `idp=` (E-SO-1 and E-ID-7 need it). Test: a hub link whose pointer names
   `idp=https://evil.example` gives `E_IDP_UNREACHABLE` and opens no window.
9. **PHISH-1, HUB-3, `src/loader/app.js:3358`**: `createPage` takes `templateBtih` from the operator's template list (or the
   scope the identity origin verified), never `A.btih`, and copies `idp=`, `tr=`, `ws=` only from that template; and on a
   hub the loader loads only template btihs (a signed pointer's owner can claim any btih for his own ledger, so the identity
   origin's check at `src/idp/idp.js:933` cannot see which code runs). `docs/DEPLOY.md:1199` and `src/idp/psl.js:14-22`
   ("one-operator hub"): say that every label is someone's page and only template pages get the hub identity;
   `docs/SECURITY-MODEL.md` and `docs/THREAT-MODEL.md` hub rows likewise.
10. **PHISH-3, PHISH-5, `test/e2e/idp-driver.mjs` and `test/e2e/scenarios-identity-rows.mjs:697` (E-ID-14)**: when the
    identity origin adds a typed confirmation to the same-identity card (the other site's host) and, for the device link, a
    card before the unlock and a fresh user verification after "The numbers match", the driver types the host and E-ID-14
    presses the extra card and unlocks again. Not built here so the forbidden scenarios keep passing.
11. **PHISH-8, `docs/DEPLOY.md:1194` and `docs/recipes/signin-server-node.md`**: after "Servers choose which identity origins
    they accept (`allowIdps` ...)" add "This filters honest identity pages only: a verified proof shows that someone holds the
    key. Keep your own way to re-bind or revoke an account; this format carries no key rotation."
12. **PRIV-7, PHISH-10, `src/loader/strings.js:522`** (`signInOpens` and the in-page hint): name the host, for example
    "Sign in opens the identity page at {idpHost}, which sees your IP address when it loads."
13. **SUP-6, `tools/check-site.mjs:26`**: add `--idp <origin> --list hashes-idp.json --sig hashes-idp.json.sig --pubkey <key>`,
    fetching every listed file with `cache: 'no-store'` and comparing bytes; `docs/OPERATIONS.md:670` and `:912`: compare the
    signed list, not the card line.
14. **SUP-7, `tools/build-idp.mjs:103-109`, `:130-132`**: build the three bundles with `metafile: true` and run
    `collectBundledPackages` and `checkPackages` (`build.mjs:409-503`) against `build.lock.json`, failing on an unpinned,
    changed or duplicated package; `--update-lock` covers both builds. Test like `tools-v03-release.test.mjs:372`.
15. **docs/INTERFACES.md:1651**: "the hub box always starts unchecked (no defaultOn)" -> "the hub box starts unchecked unless
    the identity origin's own build lists the page's template and the page asks for the default (buildDefault)".
