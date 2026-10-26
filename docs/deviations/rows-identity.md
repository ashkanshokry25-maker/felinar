# Identity rows lane (R 4.2 E-ID-3, 3b, 8, 11, 13, 14, 15)

Lane: the open identity rows of the test plan's end-to-end table (V03-DESIGN-REVIEW Part 4.2; the work list is the R 4.2
table in `docs/deviations/integration-v03.md:310-323`). Run on 2026-10-22, finished 15:48 ET.

## Result

All seven rows pass in Chromium with the real identity origin, the real loader and the guestbook example. Nothing left loopback.

| Row | Status | Scenario | What the browser run shows |
|---|---|---|---|
| E-ID-3 | pass | `E-ID-3` (`test/e2e/scenarios-identity-rows.mjs:375`) | A new visitor restores with the 12 words from the kit (`#kit`) and gets the same public key. The check code matches the kit's. The "Found 1 post by this identity on <site>" card shows. The private record the old identity kept (`me.set`) reads `null` after a phrase-only restore. A third visitor restores from the backup file (made at `#backup`, with its generated passphrase), gets the same key, and the record comes back. |
| E-ID-3b | pass | `E-ID-3B` (`:421`) | One word is mistyped and the phrase still passes the BIP-39 checksum (`mistyped()`, `:268`). The restore shows a different check code from the kit's and the sentence "No posts found for these words on <site>. Check the words, or continue as a new identity." (`src/idp/strings.js`, key `noPosts`). "Continue anyway" then gives a different key. |
| E-ID-8 | pass | `E-ID-8` (`:477`) | The victim guestbook is published with `org=` set to its own origin. A look-alike origin on another loopback port serves the same signed pointer, so it has the same ledger id. The victim's sign-in card shows no warning and the site gets a ledger key (`l|<ledger id>`). On the look-alike, the card says "This address is not one of this site's addresses." (`src/idp/cards.js:291`, set at `src/idp/idp.js:841`). The card names the origin the browser reports, and the look-alike gets its own pairwise key (`o|<origin>`). The scenario reads both records from the identity origin's IndexedDB. A second identity origin on another port then sends a forged `mw-idp-ready` and a forged answer to the victim tab while a real sign-in runs. That sign-in still finishes through the pinned identity origin with the victim's key, and the second origin gets 0 messages. |
| E-ID-11 | pass | `E-ID-11` (`:554`) | An init script makes `window.open` return null in every frame. Pressing Sign in on the site brings up the loader's own Sign in card. That card's button is blocked too, so the "Continue in this tab" card appears; `window.open` was called twice. The tab then goes to the identity origin and comes back through `/_mw/idp-return` (`src/loader/app.js:68`, `:970`), signed in. The answer is gone from the address bar. |
| E-ID-13 | pass | `E-ID-13` (`:623`) | Three forced cases, run against an identity origin on `http://localhost` (WebAuthn needs a domain RP ID). (1) An init script deletes `PublicKeyCredential`: there is no passkey button, the choice card shows the noPrf line, and a passphrase identity is made. (2) A virtual authenticator without PRF: one passkey is created, it gives no PRF output, the noPrf and clean-up lines show, and the person picks a passphrase in the same window. (3) An init script deletes `getClientCapabilities`, which `src/idp/passkey.js:63` checks for: the passkey is still offered, and one create with PRF gives a private key. |
| E-ID-14 | pass | `E-ID-14` (`:696`) | Two identity-origin contexts (two profiles) link through `#link`, with each QR payload typed into the code field. Both screens show the same 6-digit number. After "They match", the identity code and the vault parts move across, and B's guestbook sign-in gives A's key. In a second run, the QR 2 key is swapped for an attacker's key on its way to C. The two numbers then differ, and after "They differ" A goes back to Settings without showing the identity code. In a third run, the reveal is swapped for another key: A refuses it with "The other device sent a code that does not match its first code." (`linkCommitBad`, `src/idp/strings.js:183`). |
| E-ID-15 | pass | `E-ID-15` (`:852`) | Popups are blocked, so Sign in uses the loader's in-page card. That card's closed root, read through DevTools with pierce, has no input and no high-risk control: only "Sign in" and "Cancel". In one run, site code puts an overlay over the card. In another, it scales the card's host and makes it nearly transparent. Each time the card is cancelled with "Cancelled: something moved or covered this button. Try again." (`src/loader/ui.js:1161`), a click on that spot does nothing, and `window.open` is not called. When the card is left alone, its Sign in works. |

## Suites run (times ET, 2026-10-22)

- `npm run build`: ok.
- `node test/e2e/run.mjs --only E-ID-3,E-ID-3B,E-ID-8,E-ID-11,E-ID-13,E-ID-14,E-ID-15`: 7 passed, 0 failed, 111.1 s, and the run ended with "PASS network policy: every request stayed on 127.0.0.1".
- `npm test` (lint floor plus unit): 2076 tests, 2076 pass, 25.7 s.
- The identity scenarios plus this lane's (`--only E-ID-1,E-ID-2,E-ID-2B,E-ID-4,E-ID-5,E-ID-6,E-ID-10,E-ID-7` plus the seven above): 15 passed, 0 failed, 190.6 s, and the run ended with "PASS network policy: every request stayed on 127.0.0.1". This was also a second green run of the seven new scenarios.

## Files

- `test/e2e/scenarios-identity-rows.mjs` (new; exports `identityRowsScenarios({ assert })` and `IDENTITY_ROWS_ORDER`).
- `test/e2e/idp-driver.mjs` (addition only): `driveIdp(..., { until })` (`:19`, `:70`, `:82`). E-ID-11 needs it because in the redirect round trip the driven page is the tab itself, which never closes.
- `test/e2e/run.mjs`: one registration line, in the self-contained group before scenario 13 (`:1893-1894`). After the edit, the scenarios-a11y (`:86`, `:1866`), scenarios-media-rows (`:1892`), scenarios-chat-rows (`:1896`) and scenarios-social-rows (`:1898`) lines and the `--firefox` flag (`:1872`) were all still there.
- `docs/deviations/rows-identity.md` (this note).

## Deviations from the brief

- E-ID-8: the look-alike is a second loopback port serving the victim's signed pointer, not a look-alike host name. On loopback the origins differ only by port. The check that matters is the same: the identity origin keys on the origin the browser reports, not on the ledger id the page claims.
- E-ID-13 runs against a second identity origin at `http://localhost:<port>`, as E-ID-1 does, because WebAuthn refuses an IP-address RP ID. `chromiumArgs()` keeps localhost on loopback.
- E-ID-15 covers the loader's in-page card, the only sign-in surface that site code can reach. When popups work, the sign-in cards are in the identity origin's own top-level window, which no site code can overlay.

## Defects found

None. No `src/**` file was edited.

## Requests

For the integrator (area: docs). These are the exact cell texts for `docs/deviations/integration-v03.md`, R 4.2 table, rows 310, 311, 316, 319, 321, 322 and 323:

```
| E-ID-3 | pass | E-ID-3 | restore at the identity origin in a browser: the 12 words from the kit give the same key, the same check code and "Found 1 post", and the old private record reads null; the backup file (made at #backup) gives the same key and the record back |
| E-ID-3b | pass | E-ID-3B | a mistyped phrase that passes the checksum: another check code and "No posts found for these words on <site>", then another key |
| E-ID-8 | pass | E-ID-8 | a look-alike origin on another loopback port serving the victim's signed pointer (the same ledger id): "not one of this site's addresses", naming the browser-reported origin, and its own pairwise key (o\|origin) while the victim keeps its ledger key (l\|ledger id); a second identity origin's forged ready and answer are ignored (0 messages reach it) |
| E-ID-11 | pass | E-ID-11 | window.open stubbed to null in every frame: the loader's Sign in card, blocked again, "Continue in this tab", the redirect round trip through /_mw/idp-return signs in and clears the address |
| E-ID-13 | pass | E-ID-13 | init scripts and a virtual authenticator: no PublicKeyCredential (no passkey button, noPrf line, passphrase); PRF off (1 create, no PRF output, noPrf and clean-up lines, passphrase); no getClientCapabilities (passkey offered, 1 create with PRF) |
| E-ID-14 | pass | E-ID-14 | two identity-origin contexts with typed QR payloads: matching numbers, the identity moves (same key on the site); a substituted key in QR 2 gives different numbers and "They differ" sends nothing; a substituted reveal is refused (linkCommitBad) |
| E-ID-15 | pass | E-ID-15 | the loader's in-page card (popups blocked): no field and no high-risk control in its closed root; an overlay and a host restyle each cancel it with the redress notice and a click there does nothing; the untouched card acts |
```

Then update the open-row count at `docs/deviations/integration-v03.md:220` and `:399` to take these seven rows off the open list.
