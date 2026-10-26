# ui agent: notes and deviations (v0.3)

Agent: `ui`. Date: 2026-10-20. Owned: `src/loader/ui.js`, `src/loader/ui.css`, `src/loader/strings.js`, `src/loader/index.html`,
`src/dropin/panel.js`, `src/widget/signin.js`, `src/widget/chat-panel.js`, `src/widget/redress.js`, and the tests
`ui-v03-cards`, `ui-v03-strings`, `widget-signin`, `widget-chat-panel`, `dropin-panel`. Source of truth: R (V03-DESIGN-REVIEW) 2.3.4,
2.3.6, 2.4.1, 2.7.5, 2.8.4, 2.11, 2.14, 2.15, 3.7, 3.8; MF-03, MF-06, MF-09, MF-27, MF-35, MF-63.
The spec sections (ARCHITECTURE 5.10 and 15, INTERFACES `src/loader/ui.js`) are outside my write list, so the contract below is what
the integrator copies into them and marks "v0.3" (request 1).

## Files

| File | What it is |
|---|---|
| `src/widget/redress.js` | `isTrusted(ev)`, `checkElement(el, ctx)` (topmost element at the button centre inside the closed root and on the page, computed opacity of the button and every ancestor, visibility, display, pointer-events, geometry), `createGuard(opts)` (MutationObserver on host, root and body, position baseline, minimum on-screen time). Speed bumps, not a lock (MF-06). |
| `src/loader/ui.js` | v0.2.1 `createUI` unchanged in shape, plus `createCards(opts)` and `CARD_KINDS`; `createUI(root, strings, uiOpts)` exposes `ui.prompt`, `ui.setIdentityHeader`, `ui.cards` (built on first use). |
| `src/loader/strings.js` | v0.3 tables appended: `ERROR_TEXT`, `CARD_TEXT`, `UI_TEXT`, `REPLACED_SENTENCES`, `DELIVERY_TEXT`, `IOS_TOR_TEXT`, `NOSCRIPT_TEXT`, `STRING_FLAGS`, helpers `errorText`, `cardText`, `uiText`, `deliveryText`, `iosTorText`, `fmt`, `pickLang`, `setStringFlag`. English and French (accents kept, straight quotes, no dashes). |
| `src/widget/signin.js` | `<mw-signin>`; `createSigninElement(deps)`, `createSigninRunner(deps)`, `sameOriginUrl`, `defineSignin()` (runs on import on a real page). |
| `src/widget/chat-panel.js` | `<mw-chat-panel>`; `createChatPanelElement(deps)`, `defineChatPanel()`. |
| `src/dropin/panel.js` | adopts the rules (below). |
| `src/loader/index.html` | noscript sentence of R 3.7; the no-referrer meta was already present and is kept (asserted by a test). Script and link tags unchanged in shape. |
| `src/loader/ui.css` | two small rules (hidden rows, reduced motion). The cards use no CSS file: they sit in a closed shadow root and are styled through the CSSOM. |

## The card API (what the sdk lane calls)

```
createCards({ win, doc, lang, actions, strict, now, minVisibleMs, MutationObserverCtor })
   actions = { signIn(options) -> Promise, openIdentity() -> Promise }       injected by the sdk lane (e.g. mw.auth.signIn)
   -> { prompt(kind, data) -> Promise, setIdentityHeader(info|null, handlers), close(), destroy(), rectOf(label), lang, host, open, kinds }
ui.prompt(kind, data) / ui.setIdentityHeader(info, handlers)           the same, on createUI(root, strings, { actions, lang })
panel.prompt(kind, data) / panel.setIdentityHeader(...)                the same, on createPanel({ win, actions, lang })
```

Behaviour common to every kind: a closed shadow root; CSSOM styling only; one card at a time (others queue, at most 8, then they resolve
`false`); buttons ignore `isTrusted === false`; before acting each button runs the redress checks and ignores a click in the first 250 ms
after the card appears; a failed check closes the card, resolves `false` and shows "Cancelled: something moved or covered this button.";
Escape resolves `false`; no card contains any input element. An unknown kind or bad data rejects with `{ code: 'E_BAD_REQUEST' }`.
The text comes from `strings.js` in `lang` (English unless the language starts with fr); `data` strings are shortened and shown with
`textContent` only.

| kind | data | resolves | notes |
|---|---|---|---|
| `signin` | `{ method?: 'signIn' \| 'openIdentity', options?, evicted? }` | the result of `actions[method](options)`, or `true`; `false` on Cancel or `E_USER_CANCELLED` | the button calls the injected function inside the click (transient activation). Errors (for example `E_POPUP_BLOCKED`) are shown on the card, which stays open for a retry. Text: "Sign in opens the magnet-web identity page...", "magnet-web never asks for your 12 words on a website.", the scripts sentence. |
| `storage-evicted` | same as `signin` | same | adds "This browser deleted your sign-in for this site. Tap Sign in to get it back." |
| `tap` | `{ text?, run?() -> Promise }` | result of `run()` or `true` | "Tap to finish" when activation was lost; `run` is called inside the tap. |
| `consent` | `{ card: key of CARD_TEXT, params?, title?, confirmLabel? }` | `true` or `false` | any R 2.14.1 card used on a site origin (turnOnChat, presencePublic, holdMessages, messageRequests, rooms, groups, helpShare, fetchPublic, directConnection, turnRelay, chatKeyInLedger, syncRecord, removePrivateData, replaceKeys, publicUpload, privateUpload, phoneUpload). The identity-origin-only cards (`signIn`, `passkey`, `twelveWords`, `sameIdentity`, `hubIdentity`, `recoveryKitIos`, `staySignedIn`) are refused with `E_BAD_REQUEST`. |
| `confirm` | `{ title, text, confirmLabel?, danger? }` | boolean | generic low-risk confirmation. |
| `upload` | `{ visibility: 'public' \| 'private', name, size, type, stripped? }` | boolean | name, size, sniffed type, the public or private text of R 2.14.1, the metadata-removal line. |
| `phone-upload` | `{ name? }` | boolean | per-upload exception (R 2.8.4): "Sending this file uses your mobile data...". The sdk lane keeps the exception scoped to the infohash. |
| `offer` | `{ kind: 'media' \| 'file', from, name, size, type }` | `true` (Accept) or `false` | never auto-accepted: no timer, Decline holds the focus; nothing is fetched here. |
| `owner-changed` | `{ minutes }` | `true` | "The owner of this site changed N minutes ago..." |
| `foreign-address` | `{}` | `true` | "This address is not one of this site's addresses." |
| `error` | `{ code, params? }` | `true` | `errorText(code)` in the card language. |
| `mod.ban` | `{ pub, name?, short?, until? (ms) }` | boolean | MF-27 moderator card; Confirm is the danger button. |
| `mod.unban` | `{ pub, name?, short? }` | boolean | |
| `mod.tombstoneMany` | `{ authors: [...], before? (ms) }` | boolean | wording "hides posts ... from copies that sync". |
| `mod.decide` | `{ id, decision: 'accept' \| 'decline' \| 'deny', kind, reason? }` | boolean | |

`setIdentityHeader({ name, short, pub, mode: 'private' \| 'same' \| 'hub', origin?, hub?, unlock: 'passkey' \| 'passphrase' \| 'visit', backup: bool }, { onSignOut, onRemove })`
draws the signed-in header: identicon (cells from a hash of `pub`), name, short id, mode ("Private to this site" / "Same as on ..." /
"One identity on <hub>"), unlock method, backup state, [Sign out], [Remove from this device]. Remove asks first with a `confirm` card, then
calls `onRemove` (R 2.15 effects are the sdk lane's). `setIdentityHeader(null)` removes it. The header carries no secret and no field.

What is NOT here, on purpose: first sign-in to an origin, "same identity", link a device, show the phrase, first read of the private
record. They open at the identity origin (lane idp). `createCards` has no way to ask for them.

## Deviations from the brief and from the current code

1. `src/loader/ui.js` shell Settings: the v0.2.1 passphrase and identity-file fields are now hidden when the model carries
   `identity.v03 === true` and replaced by an "Open identity page" button that fires settings action `openIdentity`. Without the flag the
   fields stay (old identities still have to migrate, R 2.2.7), so no existing test changed. Request 3: loader-app sets `v03: true`
   once the idp window exists.
2. `src/dropin/panel.js` Settings: the same fields now show only when `identity.legacy === true`. dropin-engine does not send it, so the
   drop-in panel shows no password or file field today and offers "Open identity page" (action `openIdentity`). Request 2: dropin's
   engine handles `openIdentity` (open the IdO) and sets `legacy: true` only for a site that still has a v0.2.1 identity to migrate.
   `dropin-engine.test.mjs` is unaffected (it drives `changeSetting` directly).
3. `src/dropin/panel.js` now imports `createCards` from `../loader/ui.js` and `createGuard` from `../widget/redress.js`. The bundler must
   tree-shake `createUI` out of the drop-in bundle (lane tools: check the size budget). If it cannot, `createCards` should move to its own
   file; I cannot create one (not on my list).
4. `src/dropin/panel.js` buttons: every button now ignores `isTrusted === false` (it already did through `h()`), runs the redress checks
   with `strict: false` and no minimum on-screen time (older prompts and e2e clicks keep working; a browser without an API skips that one
   check), and on a failed check hides the prompt and shows the "Cancelled: something moved or covered this button" message.
5. The cards use `strict: true`: a browser that lacks `getBoundingClientRect`, `elementFromPoint` or `getComputedStyle` cannot confirm,
   by design. All three exist in the floor browsers.
6. `<mw-signin>` redress check is done at click time only (no MutationObserver): the widget lives in the page all the time and a site
   may legitimately restyle its own button. The check is non-strict.
7. `src/identity/client.js` is imported lazily (`import('../identity/client.js')`) so the widget loads without it in unit tests; the
   bundler needs the file to exist (lane idp). The widget passes only `{ purpose: 'server', challenge, want: ['proof'] }`: the page cannot
   choose domain, origin, ledger or key mode. The challenge object sent on is `{ nonce, statement, exp?, nbf?, resources? }`; the
   statement is the server's, the `statement` attribute is only the fallback when the server sends none. The proof POST body is `{ proof }`
   (JSON). Request 4: if lane server/verify expects another body shape, say so.
8. `<mw-chat-panel>` takes `tracker` and `stun` attributes (shown in the "Turn on chat" card) and falls back to `mw.chat.state()` fields
   `tracker` and `stun` when present. It treats the site as having no chat when `mw.ready().features.chat` is not `true`. It reads chat
   events as `{ room?, from: { pub, name, short }, text }` (a message without `room` is a direct message). Request 5: sdk lane to confirm
   that shape for `mw.chat.on('message')`, and that `mw.chat.state()` returns `{ enabled }` or `'on'`.
9. French is written with accents; every other string rule holds (straight quotes, no dashes). The English wording of R 2.14.1 and 2.14.2
   is verbatim. "online" is avoided for presence; the three places it stays are file holders (`E_FILE_UNAVAILABLE`, spec text) and the
   two delivery strings of R 2.7.5 item 6 (spec text, behind the flag).
10. "Replace R 2.14.2 sentences wherever an old sentence exists today": none of the 14 old sentences exists in `strings.js` or the loader
    today (checked); the replacements are exported as `REPLACED_SENTENCES` and the test fails if an old sentence ever appears in any string.
    `iosHomeScreen` (v0.2.1) still tells people to export and import an identity; it needs a v0.3 rewrite when the idp lane lands
    (the v0.3 text is in `IOS_TOR_TEXT.iosHomeScreen`, behind `iosTorStrings`).
11. Flags: `STRING_FLAGS.deliveryStates` (G-CH-1 and G-CH-3) and `STRING_FLAGS.iosTorStrings` (RT 16 Q8) are false. The integrator flips them
    with `setStringFlag`.

## Test changes in dropin-panel.test.mjs

- "Settings holds identity export and import" now sets `identity.legacy: true` (title says so) and the moderator case too.
- New: no password, file or text field without `legacy`, and "Open identity page" emits `openIdentity` (script clicks do nothing).
- New: opacity 0 on a panel button cancels the click and shows the cancelled message.
- New: `panel.prompt('signin')` draws a closed-root card with no input, the button calls the injected `signIn`; an unknown kind rejects.

## Requests to other lanes and the integrator

1. Integrator: copy the card API above into INTERFACES `src/loader/ui.js` and ARCHITECTURE 5.10 and mark them "v0.3"; E-ID-9 and E-SO-12
   (axe-core), E-ID-10 (DOM scan across `data-mw-ui-cards`, the shell and the widgets) and E-ID-15 (redress fixture) are yours. The cards host
   carries `data-mw-ui-cards`; the old panel host keeps `data-mw-ui`.
2. dropin: handle settings action `openIdentity`; pass `legacy: true` only when a v0.2.1 identity needs migrating. Create the panel with
   `createPanel({ win, actions: { signIn: mw.auth.signIn, openIdentity: mw.identity.openIdentity } })` once those exist.
3. loader-app: pass `{ actions, lang }` as the third argument of `createUI`, route `mw.auth.signIn`, `mw.me.get` first use, `mw.chat.enable`,
   `mw.mod.*`, `mw.files.share` and `mw.media.upload` to `ui.prompt(kind, data)`, and send `identity.v03: true` in the settings model.
4. server/verify: confirm the `{ proof }` POST body and the challenge JSON shape (`{ nonce, statement?, exp?, nbf?, resources? }`).
5. sdk: confirm the chat event and state shapes (deviation 8).
6. tools: add `src/widget/signin.js` -> `/_mw/signin.js` and `src/widget/chat-panel.js` -> `/_mw/chat-panel.js` build entries with SRI; both
   register their element on import. `--signin-widget` and `--chat-panel` print the tags.
7. Unrelated failures seen when running the neighbouring suites (not mine): `dropin-stamp.test.mjs` ("signRotation: a scope is required",
   lane formats) and `repo-layout.test.mjs` (a `v03` directory under docs/research).
