# Code review v0.3: browser and mobile compatibility

Lens: BROWSER AND MOBILE COMPATIBILITY (`.orchestration/scripts/v03-review.js`, label `review:browser`).
Date: 2026-10-20, 21:50 to 22:45 ET. Tree reviewed: checkpoint `99d7a7c` (22:01 ET; `src/`, `tools/`, `test/`, `build.mjs`
and `examples/` are identical to `470f7ea`, the tree the C2 integration results describe).

Scope: the code written since `709feff` (`git diff 709feff --stat`: 368 files) under `src/`, `tools/`, `bin/`, `build.mjs`,
`test/e2e/`, `examples/social` and `examples/existing-site-dropin`, plus the wave 1 files the focus names and the new code
calls (`src/sw/media-route.js`, `src/media/{session,strip,poster}.js`, `src/files/preview.js`, `src/identity/{wrap,argon2}.js`:
they landed between 09:16 and 10:01 ET and are part of the v0.3 code). Floor: Safari and iOS 15.4, Chromium 110, Firefox 115.

Normative inputs, read first: [V03-DESIGN-REVIEW.md](V03-DESIGN-REVIEW.md) ("R": 1.3 must-fix list, 2.2 to 2.13, Part 3,
Part 4), [SEEDING-AND-ZERO-SETUP-DESIGN.md](../research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) ("SZ"),
[ARCHITECTURE.md](../ARCHITECTURE.md) (8.1, 15), [INTERFACES.md](../INTERFACES.md), [COMPATIBILITY.md](../COMPATIBILITY.md),
[INTEGRATION-STATUS.md](../INTEGRATION-STATUS.md), [deviations/integration-v03.md](../deviations/integration-v03.md),
[deviations/integration-c2.md](../deviations/integration-c2.md), the wording rules of [DESIGN-REVIEW.md](DESIGN-REVIEW.md)
section 4, and the previous round's [code-review-browser.md](code-review-browser.md). IP visibility to peers is the
premise of the light web and is not reported. Nothing in the repository was changed except this file.

How the findings were checked. Every finding comes from reading the code path end to end, flow by flow: sign-in from a
site, from a server page and from the widget; unlock and enrolment at the identity origin; backup and recovery; upload,
poster and playback of private media; calls; dock mode and the seed budget; the installed web app paths; the signed-in
loader on a phone; the social template on a phone. Three findings were measured with throw-away probes in the session
scratchpad (`browser-v03-probes/`), which load the real modules of this repository read-only and serve them on
`http://127.0.0.1`:

| Probe | Browsers | Finding |
|---|---|---|
| `popup-probe.mjs`: the real `src/widget/signin.js` and `src/identity/client.js`, a challenge endpoint delayed 0, 1,500 and 6,000 ms | Playwright 1.64.1, full Chromium 156 build in headless mode with `chromiumArgs()` and Playwright's default `--disable-popup-blocking` removed; Playwright's headless shell and WebKit 27.2 as controls | 1 |
| `header-probe.mjs`: the real `createCards().setIdentityHeader` of `src/loader/ui.js` over a page with a fixed bottom bar, 390 x 844 | Chromium 156 (`chromiumArgs()`, phone emulation with touch), WebKit 27.2 | 5 |
| `kdf-paint-probe.mjs`: the real `src/identity/wrap.js` with the identity origin's defaults | Chromium 156 (`chromiumArgs()`), WebKit 27.2 | 7 |

Network policy held in every probe: Chromium launched with `chromiumArgs()`, WebKit only on `http://127.0.0.1`, and the
request guard saw no request leave 127.0.0.1. Firefox does not launch on this machine, and no Safari 15.4, iPhone or
Android device was available, so every statement about them comes from the code, from vendor behaviour, or from the design
review's own risk rows (G-ID-1, G-ID-6, G-ID-7, G-MD-2, G-MD-3, G-MD-6); each such finding says so.

Severity: critical = exploitable, key or data loss, or a privacy promise broken; high = a documented behaviour is wrong in
a floor browser or a must-fix item of the design review is unimplemented; medium = edge case; low = hygiene.

## Summary

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | high | `<mw-signin>` fetches the challenge before it calls `client.signIn`, so the identity window opens outside the click: blocked on Safari before 16.4 and on every browser when the challenge takes more than about 5 s (measured in Chromium); the widget has no fallback and its "Tap Sign in again" loops | `src/widget/signin.js:58`, `:71`, `:183` |
| 2 | high | The redirect round trip (R 2.3.1) is implemented but never started: where the popup is blocked twice or opens without an opener (iOS Home Screen apps, in-app browsers) sign-in is impossible and the site says "The identity page could not be reached" | `src/identity/client.js:444`, `src/identity/service.js:421`, `src/loader/api.js:1564` |
| 3 | high | MF-09's "Tap to finish" is missing: the identity origin calls WebAuthn after IndexedDB and SubtleCrypto hops and calls `get()` right after `create()` for PRF, WebKit's gesture rule is the G-ID-1 risk, and a `NotAllowedError` ends the sign-in as a silent cancel with no passphrase offered | `src/idp/passkey.js:86`, `:154`, `:175`; `src/idp/idp.js:227`, `:287`, `:948` |
| 4 | high | The backup file can fail to save on iOS (the `blob:` URL is revoked 1 s after a script click that runs seconds after the press) and is recorded as saved before any download | `src/idp/idp.js:872`, `:1000` |
| 5 | high | On a phone the signed-in header covers the bottom 170 px of an 844 px screen for the whole session and takes every tap there: a site's own bottom bar stops working (measured: 0 of 3 taps arrived, Chromium and WebKit) | `src/loader/app.js:3133`; `src/loader/ui.js:1090`, `:1096`, `:1427` |
| 6 | medium | The identity origin tells iOS users to add the identity page to the Home Screen "to keep this identity in Safari": a Home Screen app has its own empty storage (round 1 fixed the same claim in the loader), and the card shows after every sign-in | `src/idp/strings.js:92`, `:93`; `src/idp/cards.js:81` |
| 7 | medium | Argon2id runs on the identity page's main thread in the same task as `busy()`: the busy card never paints and the page freezes 2.0 s (Chromium) to 2.7 s (WebKit) on an M3, longer on phones, on every passphrase unlock, which is the only unlock at the floor | `src/identity/wrap.js:144`; `src/idp/idp.js:247`, `:314` |
| 8 | medium | The signed-in header always says "Unlocked with a passkey" and "No backup yet": `identityHeader` hard-codes both, although the keys carry the real unlock method and backup state | `src/loader/app.js:3117` |
| 9 | medium | Metadata removal has no fallback decoder (R 2.13 names one) and passes `imageOrientation: 'from-image'`; any `createImageBitmap` refusal refuses public photos and offers "Upload anyway (may include your location)" for private ones | `src/media/strip.js:403`; `src/media/lane.js:270`; `src/files/lane.js:318` |
| 10 | medium | Video posters wait for `loadeddata` on an off-screen video that is never played; iOS loads no media data for it, so each upload waits 15 s and ships without a poster | `src/media/poster.js:84`, `:21` |
| 11 | medium | The raw-key fallback for playback runs only on a synchronous `DataCloneError`; a key that fails to deserialize in the worker (`messageerror`) costs 5 s per open and ends on the capped Blob path | `src/media/session.js:90`, `:134` |
| 12 | medium | ARCHITECTURE 8.1.8 and COMPATIBILITY say the Service Worker runs Background Sync, Periodic Sync and Background Fetch tasks; no code registers or handles any of them | `docs/ARCHITECTURE.md:989`; `docs/COMPATIBILITY.md:347` |
| 13 | low | A host-to-host pair over a VPN overlay (100.64/10, 10/8) on mobile data counts as a local wire on iOS and Firefox, outside the month cap | `src/loader/localwire.js:56`; `src/loader/seed-budget.js:157` |
| 14 | low | `lint-floor` has no rule for the post-floor APIs v0.3 depends on (getClientCapabilities, Wake Lock, getDisplayMedia, BarcodeDetector, OffscreenCanvas, requestIdleCallback, createImageBitmap option values) | `tools/lint-floor.mjs:39` |
| 15 | low | The identity page's inputs are 15 px, so iOS zooms its cards on every field (round 1 fixed this for the loader only) | `src/idp/idp.css:96` |
| 16 | low | `examples/social` asks for `viewport-fit=cover`, which the shell copies to the top page, but its fixed toasts and skip link ignore the safe-area insets | `examples/social/css/app.css:237`; `examples/social/index.html:5` |

Relation to the other reviews of this round: findings 8 and 12 are also documentation and UI honesty items (conformance
lens); findings 2 and 3 overlap the must-fix matrix of the conformance review (R 2.3.1, MF-09) and add the browser failure
paths. Fix them together.

## 1. high: `<mw-signin>` opens the identity window only after its own network round trip

**Where.** `src/widget/signin.js:58` (`await f(cUrl, ...)`, the challenge fetch), `:60` (`await res.json()`), `:68`
(`c = await c()`, the client), then `:71` (`c.signIn({ purpose: 'server', challenge, want: ['proof'] })`); `:183`
(`client: () => import('../identity/client.js')`). The client's contract is the opposite: `src/identity/client.js:429`
("Call it from a click: window.open runs before the first await"), `:375` to `:396` (`resolveLate`: the challenge and the
other late fields "may be promises (an IndexedDB read or a server fetch started in the same click), so window.open can run
before them"), `window.open` at `:450`, `E_POPUP_BLOCKED` at `:454`.

**Defect.** The widget is the one caller that awaits before `client.signIn`, so `window.open` runs outside the click's
activation whenever the challenge round trip outlasts it. Chromium and Firefox keep transient activation for about 5 s;
Safari before 16.4 has no transient activation model and keeps a user gesture only within the click's own task, which a
network response is not (the reason the client takes promise fields). There is no fallback on this path: the loader card
that rescues `E_POPUP_BLOCKED` in shell and drop-in modes (`src/loader/api.js:1564` to `:1573`) is not involved. The widget
then shows "Your browser blocked the sign-in window. Tap Sign in again." (`src/loader/strings.js:306`); a tap within 10 s
gets `E_RATE` (`signin.js:50`) and a later one repeats the fetch-then-open and is blocked again.

**Measured.** `browser-v03-probes/popup-probe.mjs` (the real widget and client, a dummy identity page on a second loopback
port), full Chromium 156 with its popup blocker on: challenge answered after 0 ms and 1,500 ms: the window opened; after
6,000 ms: no window, and the element fired `{ state: 'error', code: 'E_POPUP_BLOCKED' }`. A control button that opens
after a 6 s timer was blocked the same way. With Playwright's defaults (the headless shell with `--disable-popup-blocking`)
and in Playwright WebKit every popup opens, so no existing test (E-SI-1W included) can see this.

**Failure scenario.** A visitor of the Example Forum on Safari 15.4 taps "Sign in with magnet-web"; the forum's
`/auth/mw/challenge` answers in 300 ms; `window.open` runs after the response and is blocked; every retry fails the same
way, and nothing else on the page can sign in. On Chrome the same happens with any challenge endpoint slower than about
5 s, for example a cloud function that starts cold.

**Fix.** Call the client synchronously in the click with the challenge as a promise:
`c.signIn({ purpose: 'server', challenge: fetchChallenge(cUrl).then(normalize), want: ['proof'] })`. `resolveLate` already
awaits it after the window opened and maps a rejection to `E_NONCE_REQUIRED`. Import `src/identity/client.js` statically
(the esbuild bundle already inlines the dynamic import) so nothing is awaited before the call, and keep the cooldown check
synchronous.

**Test.** Unit: a fake `win.open` that returns null unless called while a "click" flag is set around the handler, and a
challenge fetch that resolves on a later macrotask: the widget must reach `win.open` before the fetch resolves. e2e: the
forum scenario in `chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-popup-blocking'] })` with the
challenge delayed 6 s (the probe above), expecting a signed-in event.

## 2. high: the redirect round trip exists but nothing starts it

**Where.** `src/identity/client.js:444` to `:447` (`if (opts.redirect === true) return startRedirect(...)`), `:673`
(`startRedirect`). No caller passes `redirect`: `src/identity/service.js:421` to `:424` (`auth.signIn`),
`src/loader/api.js:1564` to `:1573` (`_signIn` answers `E_POPUP_BLOCKED` with another popup from the loader card),
`src/widget/signin.js:71`. Only the return side is wired: `src/sw/core.js:1405` and `:2031` (`/_mw/idp-return`),
`src/loader/app.js:3088` to `:3101`, `src/dropin/identity.js:274`. E-ID-11 is open (`docs/deviations/integration-v03.md:319`).

**Defect.** R 2.3.1: "Where a popup cannot open or the opener link is lost (some in-app browsers; lab row G-ID-7), the
redirect round trip is used". The code has no switch to it. (a) When `window.open` returns null for the site's call and for
the loader card's (a strict popup setting, some in-app browsers), the person gets `E_POPUP_BLOCKED` with nothing else to
try. (b) When the window opens without an opener (an iOS Home Screen web app opens another origin outside the app; in-app
browsers that turn `window.open` into a navigation or a new view), the identity page says "Open this page from a site's
Sign in button." (`src/idp/idp.js:924`, `src/idp/strings.js:188`) while the site waits 20 s and reports
`E_IDP_UNREACHABLE`, "The identity page could not be reached. Check your connection and try again." (`client.js:563`,
`src/loader/strings.js:307`), which is wrong and repeats on every try.

**Failure scenario.** An iPhone user runs a hub site from the Home Screen and taps Sign in: the identity page opens outside
the app with no opener and tells them to open it from a site; 20 s later the app says the identity page could not be
reached. The same for a link opened in Instagram's or Facebook's in-app browser. There is no way to sign in from these
places. Not run on a device (G-ID-7).

**Fix.** In the identity service and the widget: when sign-in fails with `E_POPUP_BLOCKED` after the loader card, or with
`E_IDP_UNREACHABLE` because the window never posted `mw-idp-ready`, show a loader card "Continue in this tab" whose click
calls `signIn({ ..., redirect: true })`; start with the redirect directly where the opener is known not to survive
(`navigator.standalone === true`, or `display-mode: standalone` on iOS). On the identity page, a visit without an opener
should say what to do instead of "Open this page from a site's Sign in button."

**Test.** E-ID-11 as the review wrote it: an init script that makes `window.open` return null; the sign-in must complete
through `/_mw/idp-return`. A second variant nulls `window.opener` on the identity origin: the site must reach the redirect
card, never `E_IDP_UNREACHABLE`.

## 3. high: MF-09's "Tap to finish" is missing; WebAuthn runs after several async hops; `NotAllowedError` ends as a cancel

**Where.** Returning person: the card press resolves at `src/idp/idp.js:580`, then `unlock()` (`:613`) reads IndexedDB twice
(`:287`, `:288`) and calls `passkey.get` (`:305`), which first awaits a SubtleCrypto digest (`prfSalt`,
`src/idp/passkey.js:154`) before `navigator.credentials.get` (`:159`). First visit: `chooseUnlock` (`idp.js:275`), the
HKDF of `rootStar`, then `passkey.create` (`:227`; digest at `passkey.js:123`, `create` at `:127`) and, when PRF came back
as enabled without results (Safari 18 returns the PRF output only from an assertion), `prfFor` calls `get()` at once
(`passkey.js:175` to `:181`, `idp.js:228`). `NotAllowedError` becomes `E_USER_CANCELLED` (`passkey.js:86`); the window then
closes without a card for that code (`idp.js:948`, `:949`).

**Defect.** MF-09 requires "a 'Tap to finish' button when activation is lost (G-ID-1)". WebKit gates `navigator.credentials`
on a user gesture, which is why the review made it a gate row; the identity origin makes the call after at least two
IndexedDB requests and a SubtleCrypto digest following the press, and makes the PRF assertion right after the creation
ceremony with no new press. A WebKit refusal is a `NotAllowedError`, which the code cannot tell from the person's own
cancel: the site hears `E_USER_CANCELLED`, the popup closes, nothing is explained, and no passphrase is offered in its
place. Other passkey failures (`NotSupportedError` and `SecurityError` in in-app WebViews, or for an identity origin on an
IP address, S2 F8) end the sign-in with `E_UNSUPPORTED` instead of falling back to the passphrase R 2.13 names.

**Failure scenario.** iPhone, Safari: the person presses "Continue with passkey"; the identity page reads IndexedDB,
hashes the PRF label and calls `credentials.get()`; WebKit refuses it as not user-initiated; the popup closes and the site
shows nothing. On iOS 18, where PRF exists, the first sign-in creates the passkey, the immediate assertion for the PRF
output is refused, the identity is not created and an orphan passkey stays in iCloud Keychain. Not run on a device
(G-ID-1); Chromium's virtual authenticator in E-ID-1 has no gesture rule.

**Fix.** Do the work before the press: compute `prfSalt` once at boot and read the wrapped record and the vault when the
card is drawn, so the press handler's first await is the credentials call. Between `create()` and the PRF `get()`, and
whenever a credentials call rejects with `NotAllowedError` faster than a sheet could have been answered (about 1 s), show a
one-button "Tap to finish" card whose click makes the call. After a second fast refusal, or any `NotSupportedError` or
`SecurityError`, continue with the passphrase card in the same window (with the clean-up sentence when a passkey was
created).

**Test.** Unit: a fake `navigator.credentials` that rejects with `NotAllowedError` unless called while a gesture flag is
set (set by the card's click dispatch, cleared on the next macrotask): the returning sign-in and the PRF enrolment must
succeed after one "Tap to finish" press; a fake that throws `NotSupportedError` must lead to the passphrase card, not to
`E_UNSUPPORTED` at the site. Gate row G-ID-1 on iOS 18 and iOS 16.

## 4. high: the backup file can fail to save on iOS and is recorded as saved anyway

**Where.** `src/idp/idp.js:860` to `:876` (`makeBackup`: Argon2id through `makeBackupFile`, then
`state.backup.fileSaved = true` at `:872`, before anything is downloaded), `:975`, `:992` to `:1001` (`offerDownload`:
`a.click()` after the KDF, `URL.revokeObjectURL` 1,000 ms later at `:1000`).

**Defect.** The backup file is the route that restores "everything, including old messages, records and own media"
(R 2.2.6). On iOS Safari a `blob:` download first asks whether to download and reads the URL only after the answer; the URL
is revoked 1 s after the click (the loader and drop-in keep theirs 30 s: `src/loader/ui.js:925`,
`src/dropin/engine.js:1504`). The click itself runs seconds after the person's press (the KDF holds the thread, finding 7),
so an engine that ties script downloads to a gesture has none left. Whatever happens, `fileSaved: true` is already stored:
Settings shows "Backup file: saved" and every later bundle tells sites `status.fileSaved`.

**Failure scenario.** iPhone, identity page Settings, "Make a backup file", Continue; several seconds of Argon2id; Safari
asks whether to download; the person taps Download two seconds later; the URL is gone and no file is saved, while the
identity page says "Backup file: saved". When the phone is lost, the 12 words restore the public identities but not the
messages, records and private media the file was meant to keep. Not run on a device.

**Fix.** After the KDF, show a card with "Save the backup file" whose click creates the URL and clicks the link (a fresh
gesture); keep the URL until the card closes or at least 60 s; record `fileSaved` only after a second press ("I saved the
file"), or keep a "not confirmed" state; offer the text to copy where downloads are unavailable.

**Test.** Unit with fake timers: no revoke before 30 s; `fileSaved` stays false until the confirmation press. Browser test
(Chromium and WebKit): `page.on('download')` fires on the save button press.

## 5. high: on a phone the signed-in header covers the bottom fifth of the site for the whole session

**Where.** `src/loader/app.js:3133` to `:3136` (the header is set on every sign-in and removed only on sign-out),
`src/loader/ui.js:1096` to `:1106` (the host is fixed at the bottom of the viewport at z-index 2147483000), `:1090`
(`cardStyle`: `pointer-events: auto`, `width: 100%`, `max-width: 640px`), `:1427` to `:1451` (`setIdentityHeader`: an
identicon, three lines and two buttons; no close, no collapse, no safe-area padding). Recorded as "Seen, not fixed" in
`docs/deviations/integration-c2.md`, and worked around in the e2e (the calls scenario moved its test buttons to a left
column, `test/e2e/scenarios-calls.mjs`).

**Defect.** On a phone the header is as wide as the screen, its two buttons wrap to a second row, and it stays for the
whole signed-in session over the bottom of the site, taking every tap in its area. A site's own bottom controls (a bottom
navigation bar, the "Show more" at the end of a list, a message box) are covered and cannot be reached, and the page cannot
scroll its last part above the card. Unlike the loader bar (`src/loader/ui.css:343`), the card has no
`env(safe-area-inset-bottom)` padding.

**Measured.** `browser-v03-probes/header-probe.mjs` (the real `createCards`, a 390 x 844 viewport, Chromium with phone
emulation and WebKit 27.2): the header's host covers y = 674 to 844, 170 px or 20 % of the screen; three taps on a site's
fixed bottom bar (Home, Post, Me) reached the site 0 times in both engines.

**Failure scenario.** A member signs in on a phone to a shell site with a bottom tab bar: the tab bar disappears under
"Signed in as ... Sign out / Remove from this device" and stays covered until they sign out. In `examples/social` the
end of a timeline (its "Show more" button) sits under the card.

**Fix.** On a coarse pointer or a narrow viewport, show the header once after sign-in and fold it into the loader's pill
(or a 44 px chip in a corner) after a few seconds, expanding on a tap; add `env(safe-area-inset-bottom)` padding; never
keep a full-width card over the site.

**Test.** A browser test at 390 x 844 in Chromium and WebKit: after `setIdentityHeader` and 5 s, a site element in the
bottom 100 px receives a tap (the probe's assertion).

## 6. medium: the identity origin's iOS advice adds the wrong page to the Home Screen

**Where.** `src/idp/strings.js:92` (`kitIos`: "Safari deletes this site's data after 7 days without a visit unless you add
it to your Home Screen."), `:93` (`addToHomeScreen`: "To keep this identity in Safari, add this page to your Home Screen"),
French `:264`, `:265`; `src/idp/cards.js:81` to `:85` (`kitDue`), `:584` to `:587`; `src/idp/idp.js:760` (`ios` and
`standalone` of the identity page itself).

**Defect.** A Home Screen web app has its own storage and starts empty (webkit.org/tracking-prevention; COMPATIBILITY.md:
"Home Screen web app on iOS ... with its own storage: it starts empty"); round 1 removed the same promise from the loader
(`src/loader/strings.js:98`, `:99`). Adding the identity page keeps nothing of Safari's copy: the installed copy opens
`/signin` with no opener ("Open this page from a site's Sign in button."), and sites keep opening the Safari copy. The
identity page is always a Safari tab on iOS, so `standalone` is never true for it and this card follows every sign-in until
the kit is saved. The iOS lines are also not behind `STRING_FLAGS.iosTorStrings` (`src/loader/strings.js:289` to `:291`),
which MF-63 asks of iOS strings until the primary-source check.

**Failure scenario.** The person adds the identity page to the Home Screen, believes the identity is now kept and keeps
choosing "Later" on the kit; Safari deletes the identity page's data after 7 days without a sign-in; only the escrow copy on
a site they sign in to again can bring it back.

**Fix.** Replace both strings with what holds, for example "Safari deletes this page's data after 7 days without a visit.
Save your recovery kit now. The sites you sign in to keep a sealed copy for this device." Drop the Home Screen line from the
identity origin (or offer the site's Home Screen with the round 1 sentence that it starts empty), and put iOS-specific lines
behind the MF-63 flag.

**Test.** A strings test that no identity-origin string says adding to the Home Screen keeps an identity in Safari; a
cards test that the iOS recovery kit offers no Home Screen step for the identity page.

## 7. medium: Argon2id freezes the identity page; the busy card never paints

**Where.** `src/identity/wrap.js:136` to `:145` (`passphraseKey` runs the pure-JavaScript `argon2id` synchronously),
`:158` to `:162`; `src/idp/idp.js:247`, `:248` (create), `:314`, `:316` (unlock), `:359`, `:375`, `:868` (restore and
backup: `busy()` then the KDF in the same task); `src/identity/derive.js:124` (the extra word); `src/identity/vault.js:280`.

**Defect.** The KDF starts in the task that called `busy()`, so the browser cannot paint the "Unlocking..." card or react
to input until the KDF ends. Measured (`browser-v03-probes/kdf-paint-probe.mjs`, the real `wrap.js`, Apple M3): the first
animation frame after `busy()` came at 2,024 ms in Chromium 156 and 2,703 ms in WebKit 27.2, the instant the KDF finished;
with PBKDF2 (SubtleCrypto) the frame came at once. At the floor no browser has passkey PRF, so the passphrase is the
unlock on every Safari 15.4 to 17, Chromium 110 to 115 and Firefox 115; on phones the freeze is several times longer
(G-ID-6, not run) and shows no progress.

**Failure scenario.** An older iPhone on iOS 15.4 presses Continue on the passphrase card; the tab shows the pressed card
and does not respond for many seconds; the person presses again or closes the tab, believing the page hung.

**Fix.** Run Argon2id in a dedicated worker (the identity origin's CSP already allows `worker-src 'self'`); at the least,
yield a frame after `busy()` (await `requestAnimationFrame` and a `setTimeout(0)`) and run the passes in slices with a
progress line.

**Test.** Browser unit test (`npm run test:browser`, idp-browser): after the passphrase Continue, an animation frame fires
within 100 ms while the KDF runs, and the busy card is in a screenshot taken 300 ms after the press.

## 8. medium: the signed-in header always says "Unlocked with a passkey" and "No backup yet"

**Where.** `src/loader/app.js:3114` to `:3118` (`identityHeader` returns `unlock: 'passkey', backup: false` whatever
happened); the keys it receives carry the real state: `status.passkey`, `status.kitSaved`, `status.fileSaved` and
`sharedComputer` from the identity origin (`src/idp/idp.js:702` to `:704`, `:714`; `src/identity/store.js:258`, `:351`);
`src/loader/ui.js:1425`, `:1444` (the line drawn from those two fields).

**Defect.** MF-09 asks the signed-in header to show the unlock method and the backup state. At the floor no browser has
PRF, so everyone who signs in there unlocks with a passphrase or "This visit only", and the header tells every one of them
"Unlocked with a passkey"; a person on a shared computer is not told "This visit only"; a person who saved the kit and the
file is told "No backup yet".

**Failure scenario.** A library computer: the person chose "This visit only"; the header says "Unlocked with a passkey /
No backup yet", which suggests the identity stays on this machine.

**Fix.** Build the line from the keys: unlock `'passkey'` when `status.passkey`, `'visit'` when `sharedComputer` or the key
mode is visit-only, else `'passphrase'`; backup true when `status.kitSaved` or `status.fileSaved`.

**Test.** Unit test of `identityHeader` with keys whose status says passphrase and kit saved (unlock `'passphrase'`, backup
true) and with a visit-only bundle (unlock `'visit'`).

## 9. medium: metadata removal has no fallback decoder; a `createImageBitmap` refusal becomes "Upload anyway (may include your location)"

**Where.** `src/media/strip.js:398` to `:405` (`cib(blob, { imageOrientation: 'from-image' })`; every rejection becomes
`E_MEDIA_STRIP`); `src/files/preview.js:152` (`resizeWidth`, `resizeHeight`, `resizeQuality`); `src/media/lane.js:270` and
`src/files/lane.js:318`, `:319` (`E_MEDIA_STRIP`: a public file is refused, a private one gets "Upload anyway (may include
your location)"); `src/media/lane.js:291` to `:296` (HEIC refused).

**Defect.** R 2.13 gives the floor fallback for `createImageBitmap` with options: "decode through an `<img>` in a
worker-free path with the pixel cap". The code has none. The option value `'from-image'` is the later member of the
`ImageOrientation` enum (it was `'none' | 'flipY'` before), and WebIDL turns an unknown enum value into a `TypeError`;
which floor engines accept it is not verified, and the media lane exercised stripping in Chromium only (COMPATIBILITY.md,
v0.3 matrix). Wherever the call rejects, every photo stops at metadata removal: public ones are refused, and private ones
are offered the original with its EXIF location, which MF-57 (blocker) exists to prevent.

**Failure scenario.** A floor browser that rejects the option: a member adds a photo to their private media; the strip
fails; the card offers "Upload anyway (may include your location)"; the member accepts; the photo enters the site's swarm
with its GPS position, readable by everyone it is shared with.

**Fix.** On a rejection, retry `createImageBitmap(blob)` without options, then decode through an `Image` from a `blob:` URL
(an `<img>` applies EXIF orientation by default in Safari 13.1, Chromium 81 and Firefox 77 and later), under the
24-megapixel cap, and re-encode on a canvas; offer "Upload anyway" only when every decoder failed.

**Test.** Unit: a `createImageBitmap` stub that throws `TypeError` when given options and a fake `Image` decoder:
`stripImage` succeeds and the output carries no EXIF. Browser (Chromium and WebKit): an EXIF orientation 6 JPEG comes out
upright and without EXIF.

## 10. medium: video posters wait for a frame that iOS never loads

**Where.** `src/media/poster.js:73` to `:93` (an off-screen `<video>`: `muted`, `playsInline`, `preload = 'auto'`, `src`
set, `await` `loadeddata` at `:84` to `:86`, then a seek and `drawImage`), `:21` (`VIDEO_TIMEOUT_MS = 15000`);
`src/media/lane.js:315` to `:318` (a failed poster is dropped after the wait).

**Defect.** WebKit on iOS loads media data only for an element that plays, or after a user gesture; `preload` does not
start it. The poster runs seconds after the person's tap (after metadata removal and faststart), so no gesture is left,
and the code never calls `play()`. Without `loadeddata` the poster times out after 15 s and the video is uploaded without
one. Desktop WebKit honours `preload = 'auto'`, so W-MD and E-MD-2 cannot show this (G-MD-2, G-MD-3 not run).

**Failure scenario.** iPhone, Media, a 20 MB clip, "Encrypt and upload": "Making a preview" for 15 s, then the upload goes
on without a poster, and every recipient's grid shows a plain "Video" tile for it.

**Fix.** Call `video.play()` (allowed for a muted inline video), wait for `playing` (or the first `requestVideoFrameCallback`
where it exists), pause, seek, wait for `seeked`, draw; shorten the timeout; when no frame comes, keep the container's
width and height and say "No preview".

**Test.** Unit: a fake video element that fires `loadeddata` only after `play()`: `makePoster` must return a poster. Gate
rows G-MD-2 and G-MD-3 on an iPhone.

## 11. medium: the raw-key fallback for playback runs only on a synchronous `DataCloneError`

**Where.** `src/media/session.js:84` to `:101` (`_register` posts the `CryptoKey`; raw bytes only if `postMessage` throws),
`:134` to `:146` (an ack that does not come within `REGISTER_TIMEOUT_MS`, 5 s at `:23` and `:68`, sends the item to the
Blob path), `src/sw/media-route.js:107` to `:125` (`register`); neither `src/sw/core.js` nor `src/sw/sw.js` listens for
`messageerror`.

**Defect.** R 2.9.6 keeps playback keys in the worker and falls back to raw bytes when the key does not clone (G-MD-6). A
`CryptoKey` that serializes in the page but cannot be deserialized in the worker does not throw in the page; the worker
gets a `messageerror` event, which nothing handles. The page waits 5 s, closes the port and decrypts into a Blob, never
trying the raw path, and keeps `keyTransfer = 'cryptokey'`, so every later open waits 5 s again. The Blob path is capped
(25 MiB on phones), so larger items end in `E_LIMIT`.

**Failure scenario.** An engine that cannot deserialize a `CryptoKey` in its Service Worker (G-MD-6 not run): a member opens
a 40 MB private video on a phone; nothing happens for 5 s, then "too large to play from memory on this browser", although
the worker route would play it with raw bytes.

**Fix.** In the worker, handle `messageerror` by telling the window clients (or the port the event carries); in the page,
treat a register timeout or that notice while `keyTransfer` is `'cryptokey'` as one retry with raw bytes before the Blob
path, and remember the outcome for the session.

**Test.** Unit: a fake worker that never acks a message carrying a `CryptoKey` but acks raw bytes: `open()` ends with
`mode: 'worker'` and `keyTransfer: 'raw'` within one timeout.

## 12. medium: the documents describe Background Sync, Periodic Sync and Background Fetch tasks that no code implements

**Where.** `docs/ARCHITECTURE.md:989` to `:992` (8.1.8, under the status "v0.3 C2, built": "Background Sync retries
(Chromium), Periodic Sync refreshes the pointer and the `cs=` snapshot ..., Background Fetch downloads web-seed bytes");
`docs/COMPATIBILITY.md:347` to `:349` (column "What the loader does": "retries HTTP requests only", "refreshes the pointer
and the `cs=` snapshot over HTTP", "downloads web-seed bytes over HTTP"). In `src/` there is no `sync`, `periodicsync` or
`backgroundfetch*` handler and no `registration.sync`, `periodicSync` or `backgroundFetch` call (grep). SZ section 2 lists
them as P3.

**Defect.** The documents state built behaviour that does not exist, and the wording rules bind documents. There is
nothing to guard today (the focus asked for the guards): what is wrong is the text, and the guards to write when the tasks
are built (`'periodicSync' in registration`, a permission query inside `try`, `'backgroundFetch' in registration`; Safari
and Firefox have none of them).

**Failure scenario.** An owner reads COMPATIBILITY.md and tells members that the installed app on Android refreshes the site
in the background; after an owner update, members keep seeing the old pointer until they open the page.

**Fix.** Mark the three as "(proposed, P3)" in ARCHITECTURE 8.1.8 and in the COMPATIBILITY rows, or build them behind the
feature checks above.

**Test.** A docs test: a capability row that names one of these APIs under "What the loader does" fails unless `src/sw`
registers the matching event handler.

## 13. low: a VPN overlay wire on mobile data counts as a local wire on iOS and Firefox

**Where.** `src/loader/localwire.js:56` (100.64/10 counted as private), `:53` (10/8); `src/loader/seed-budget.js:157` to
`:170` (a local wire gets the local row and no month cap unless the row is `'metered'`).

**Defect.** The comment there notes that carriers hand out 10/8 and 100.64/10 host addresses and protects only the
`'metered'` row; a phone without the Network Information API (every iPhone, Firefox for Android) is never `'metered'`, it is
`'phoneLimited'`. A host-to-host pair over Tailscale (100.64/10) or a company VPN (10/8) on mobile data then gets local rates
(H up to 1 MiB/s, a 128 MiB session) outside the month cap.

**Failure scenario.** An iPhone on mobile data with Tailscale on visits a site whose other visitor is on the same tailnet;
ICE picks the 100.x host pair; the H lane runs at local rates over the cellular link and the month counter does not move.

**Fix.** Drop 100.64/10 from the private set (it is shared address space, RFC 6598, not RFC 1918), and keep `local.on` false
on phones whose network class is `'unknown'` unless the person declared Wi-Fi.

**Test.** `seedBudget` for `{ isMobile: true, networkClass: 'unknown' }` without a declaration: `local.on` is false;
`isLocalPair` with two 100.64.x host candidates: not local.

## 14. low: `lint-floor` does not know the post-floor APIs v0.3 depends on

**Where.** `tools/lint-floor.mjs:39` to `:73` (`RULES`).

**Defect.** The v0.3 and C2 code relies on APIs that are absent at the floor: `PublicKeyCredential.getClientCapabilities`
(Chrome 133, Safari 17.4, Firefox 135), PRF results, `navigator.wakeLock` (Safari 16.4, Firefox 126), `getDisplayMedia`
(absent on iOS 15.4 and Android), `BarcodeDetector`, `OffscreenCanvas` (Safari 16.4), `requestIdleCallback` (absent in
Safari), `getBattery`, `navigator.connection`, Media Session actions beyond play and pause, and `createImageBitmap` option
values (finding 9). Every current use is feature-detected; nothing would catch the next unguarded one, and the floor cells
of R 2.13 depend on those guards.

**Fix.** Add `api` rules for these names that pass only when the line (or the line before) carries a `typeof` or `in` guard
or `lint-floor-ignore`, as the `navigator.userActivation` rule works today.

**Test.** `tools-lint-floor` cases: an unguarded `navigator.wakeLock.request('screen')` and `new OffscreenCanvas(1, 1)` are
findings; their guarded forms are not.

## 15. low: the identity page's inputs are 15 px, so iOS zooms its cards on every field

**Where.** `src/idp/idp.css:36` (15 px body font), `:96` to `:105` (`font: inherit` on inputs, textareas and selects),
`src/idp/index.html:5`.

**Defect.** iOS Safari zooms the page when a focused text field's font is under 16 px and does not zoom back. Round 1 fixed
this for the loader (`src/loader/ui.css:351`, 16 px on phones) but the identity page repeats it on every passphrase, the
nickname and the 12-word restore field.

**Failure scenario.** iPhone: the passphrase card zooms in on focus; the Continue button and the KDF note are off screen
until the person pinches out.

**Fix.** `font-size: 16px` for `.mw-field input`, `.mw-field textarea` and `.mw-mode select` (at least under
`(pointer: coarse)`).

**Test.** Chromium phone emulation: the computed font size of every input on the identity cards is at least 16 px.

## 16. low: `examples/social` asks for `viewport-fit=cover`, but its fixed toasts ignore the safe area

**Where.** `examples/social/index.html:5` (`viewport-fit=cover`), `src/loader/render.js:613` to `:640` (the shell takes the
site's viewport), `examples/social/css/app.css:237` (`.toasts` at 12 px from the top, left and right), `:61`, `:62` (the skip
link at 8 px); only `.wrap` (`:65`) and `.site-head` (`:73`) use the insets.

**Defect.** The shell copies the template's `viewport-fit=cover` to the top page, so the full-viewport site frame runs under
the sensor housing in landscape and under the home indicator; the toasts, which also carry the "Open the page" link of
`openTop`, and the skip link are placed with fixed offsets. Whether each engine passes the page's insets into the frame,
which the header and wrap rely on, is not tested: the layout tests run the template outside the loader, in Chromium only
(`test/example/social-browser-layout.test.mjs`).

**Failure scenario.** iPhone in landscape: a toast's left edge and its link sit under the sensor housing.

**Fix.** Pad `.toasts` and `.skip:focus` with `max(12px, env(safe-area-inset-*))`; add a gate row (or a WebKit landscape
check inside the shell); or drop `viewport-fit=cover` from the template so the browser letterboxes it.

**Test.** `social-browser-layout`: `.toasts` uses the insets; a real-device row for the template in the shell on an iPhone
in landscape.

## Checked, no defect found

- **Calls.** `getUserMedia`, `getDisplayMedia`, the Wake Lock, Media Session (`hangup` throws in WebKit and is caught) and
  `setParameters` are all guarded; the screen button is hidden without `getDisplayMedia`; perfect negotiation keeps the
  rollback path; the certificate check tolerates engines without certificate stats (Firefox); remote media elements are
  `playsinline` and `autoplay`, the local preview is muted (`src/calls/session.js`, `src/loader/call-ui.js`).
- **Fake devices.** Every Chromium launch that captures carries both fake-media flags (`test/e2e/scenarios-calls.mjs:45`,
  `test/unit/calls-browser.test.mjs:27`); WebKit captures mock devices under context permissions; no other context grants
  camera or microphone, so no test reaches the machine's real camera or microphone.
- **Dock mode.** The Wake Lock request goes out before any await; the Battery Status API is optional; a hidden page refuses
  (`src/loader/dock.js`).
- **Network policy.** `chromiumArgs()` in every launch, including E-ZS-1's two mapped names; WebKit only on `127.0.0.1`.
- **COOP.** Loader pages send `same-origin-allow-popups` (`src/sw/core.js:145`, `tools/publish.mjs:345`); the identity origin
  sends none, so the opener link survives.
- **OPFS.** The vendored WebTorrent bundle still carries round 1's patch: `dist/_mw/webtorrent.min.js` has no
  `removeEntry("chunks")`. No v0.3 code uses OPFS.
- **IndexedDB.** The chunk store (`src/files/store-idb.js`) stores `Uint8Array` values under array keys and handles
  `onblocked` and `onversionchange`; working keys fall back to memory on `DataCloneError` (`src/identity/store.js`); the
  identity origin falls back to memory when IndexedDB does not open (`src/idp/store.js`).
- **SubtleCrypto.** Only ECDSA and ECDH P-256, HKDF, PBKDF2, AES-GCM, HMAC and SHA-256, all at the floor; keys travel as
  65-byte uncompressed points and 32-byte scalars, which WebKit requires.
- **Range.** `parseRange` handles Safari's `bytes=0-1` probe, suffix and open-ended ranges; 206 and 416 answers carry
  `Content-Range` and `Content-Length`; at most 4 decrypted chunks are in flight per stream.
- **Popups in shell and drop-in.** The identity service has no await before `window.open`, and the loader's own card
  rescues `E_POPUP_BLOCKED` when the site's activation did not survive the bridge (`src/loader/api.js:1564`).
- **Build targets.** The loader, SDK, widgets, door frame and identity origin are built for `safari15.4`, `chrome110` and
  `firefox115` (`build.mjs:56`, `tools/build-idp.mjs`); the widget bundle inlines its dynamic import.
- **Background Fetch and Periodic Sync.** Nothing to guard: neither is built (finding 12).

## Not verified

Firefox (it does not launch on this machine), Safari 15.4 and every real phone. Findings 2, 3, 4, 6 (the storage separation
itself is documented by WebKit), 9 (which engines accept the enum value), 10 and 11 rest on the code and on vendor
behaviour, and the Safari part of finding 1 on the gesture model the client itself was written for; their gate rows are
G-ID-1, G-ID-6, G-ID-7, G-MD-2, G-MD-3 and G-MD-6 in [DEMO-RESULTS.md](../DEMO-RESULTS.md). Findings 1 (Chromium part), 5
and 7 were measured on loopback as described above.
