# examples lane (X1 and X2): notes and deviations (v0.3)

Agent: `examples`. Date: 2026-10-20. Owned: `examples/social/**`, `examples/peer-guestbook/**`, `examples/existing-site-dropin/**`,
`test/example/**`, `test/fixtures/existing-site-dropin/**` and this file. Source of truth: V03-DESIGN-REVIEW ("R") 2.3.6, 2.5.4, 2.5.5, 2.6, 2.7, 2.8,
2.9, 2.11, 2.14, 3.1 to 3.9; MF-49, MF-64 to MF-70, N-6, N-7. The spec sections that describe the examples (ARCHITECTURE 11, INTERFACES) are outside my
write list, so what they need to say is in "Requests" below.

The lane was written contract-first, before the sdk, idp, chat, files and media lanes had landed. They landed while it was being finished, so every
adapter was read again against the code (`src/sdk/sdk.js`, `src/loader/api.js`, `src/loader/personal-site.js`, `src/chat/service.js`,
`src/files/*`, `src/media/*`, `src/identity/service.js`, `src/chain/state.js`) and the places where the code differs from what the lane first assumed
were fixed. Those are the items under "Found against the landed code".

## What landed

| Area | Files | What it is |
|---|---|---|
| Social template (X1) | `examples/social/` (`index.html`, `404.html`, `config.json`, `css/app.css`, `img/social.svg`, `js/*.js`, `js/views/*.js`, `README.md`) | The hub template of R 3.1 to 3.7 as plain ES modules with no build step. Pure logic is in `js/model.js` (timeline, edit history, threads, wall acceptance, reactions, follow caps, validation), `js/ids.js`, `js/router.js`, `js/notices.js`, `js/search.js`, `js/qr.js` (QR encoder, versions 1 to 40, four levels). Everything that talks to the SDK is behind `js/hub.js` (follow and read other ledgers), `js/chat.js` and `js/inbox.js` (messages), `js/data.js` (the one place that writes). |
| Guestbook (X2) | `examples/peer-guestbook/` (`profile.html`, `members.html`, `js/auth.js`, `js/profile.js`, `js/members.js`, `js/common.js`; `index.html`, `about.html`, `js/app.js`, `css/app.css`, `data/about.json`, `README.md` changed) | R 3.9: Sign in and Sign out, the profile page with the private record, recovery kit and device links, and the optional members area (chat Lobby and public files, both off until the owner turns them on). `clip.mp4` and the Range check are untouched. |
| Drop-in example | `examples/existing-site-dropin/with-widgets/` (`index.html`, `js/forum.js`, `_headers`), `README.md`, `EXPECTED.md` (checks 11 to 20), `test/fixtures/existing-site-dropin/stage.mjs` | R 2.3.6 and 3.8: the Example Forum with `<mw-signin>` and `<mw-chat-panel>`, the owner steps, and the end-to-end checks. |
| Tests | `test/example/` | `social-model`, `social-lib`, `social-site`, `social-browser`, `social-browser-people`, `social-browser-more`, `social-browser-layout`, `browser-v03`, `dropin-widgets`, `sdk-surface` (every SDK call the examples make exists on the landed facade; the two GAPs are reported), `site`, `browser`; helpers `social-helpers.mjs`, `social-browser-lib.mjs`, `serve.mjs`, `check-html.mjs`; `mock-sdk.js` now has the v0.3 namespaces. |

Results of the last run (`npm run test:example`, Node 24, Chromium with `chromiumArgs({ allowRemote: false })` and WebKit on 127.0.0.1 only): **170 passed, 0
failed, 0 skipped**; `npm run check:example`: 2 sites, 7 pages, 0 errors; `node tools/lint-floor.mjs`: clean; `node --test test/unit/dropin-fixture.test.mjs
test/unit/docs-links.test.mjs test/unit/repo-layout.test.mjs`: pass. The social pages and every new guestbook page were laid out at 320, 390 and 1,024 CSS px
in a local-only Chromium: no sideways scroll, targets of at least 44 px (the social tests also check one column up to 640 px and two from 1,024 px, both
themes at 4.5 : 1 or better, reduced motion, keyboard-only use and the focus ring). No number about speed, size on the wire, battery or peers is claimed anywhere
in the examples: none was measured.

QR codes: the encoder is checked against the Reed-Solomon vector of the standard and pinned by hash, and the symbols it makes were decoded with an independent decoder
(macOS CoreImage, 161 of 161 codes across versions and levels) when it was written. The browser tests do not decode a code (no `BarcodeDetector` in the test browsers); they
check the structure and that the page draws it.

## Adapters at the contract boundary (for the reconciliation integrator)

Each is a thin function or a short block that names an SDK entry point; a test mocks `mw` exactly there.

| Adapter | File | What it calls | State |
|---|---|---|---|
| Follow, unfollow, list followed ledgers | `examples/social/js/hub.js` | `mw.hub.follow(pointer or ledger id) -> { ledger, following, cap }`, `unfollow(ledger) -> { ledger, following, removed }`, `list() -> [{ ledger, owner, since, height, pointer }]` | **Landed**, shapes read from `src/loader/personal-site.js`. |
| Reading another person's ledger | `hub.js`, `data.js` | `{ ledger }` option on `mw.db.get`, `list`, `subscribe` (read only) | **Landed** (`src/sdk/sdk.js`). Writes always go to the page's own origin. |
| Create my page | `hub.js` `createPage()`, `views/profile.js` | `mw.hub.createPage() -> { ledgerId, label, url, pointer }` | **Landed.** The page opens `url` as it is: that address carries the pointer and the genesis in its fragment, so dropping the fragment would lose the page. `origin` is derived from `url` and remembered with `mw.me.set('home', { origin })`. |
| GAP 2, delete my page | `hub.js` `withdrawPage()`, `views/settings.js` | assumed `mw.hub.withdrawPage()` | **Not in the SDK.** Throws `NOT_AVAILABLE`; the page says the loader does not offer it. The rest of "Delete my page" (tombstones, erasing the record) runs. |
| GAP 3, this page's own pointer | `hub.js` `ownPointer()` | assumed `mw.site.info().pointer`, else the top page's fragment | `site.info()` has no `pointer`; the fragment fallback is what works today. |
| GAP 4, ask a group to let me in | `hub.js` `requestJoin()`, `views/group.js` | assumed `mw.mod.requestJoin(group)` | **Not in the SDK** (`mod.queue` and `mod.decide` exist, the request side does not). |
| GAP 5, withdrawn or removed pages | `model.js` `viewFromSnapshot` | a followed snapshot may carry `withdrawn: true` or `removed: { reason }` | **Assumed**, nothing in the landed code sets them. Without it a withdrawn page simply shows what is still held. |
| Messages | `js/chat.js`, `js/inbox.js` | `mw.chat.state/enable/disable/on('message'/'room')`, `contacts.list/add/block/unblock/verify`, `dm.send/history`, `presence.list/set`, `requests.*`, `room.join/leave/send`, `group.create/send`, `holder.set` | **Landed**; see "Found against the landed code". |
| Public pictures and videos | `views/common.js` `fetchFile`, `views/composer.js`, `views/settings.js` | `mw.files.share(file, { public: true })`, `fetch(ref, { ledger? })`, `preview(ref)`, `save(ref)` | **Landed**; `{ ledger }` is passed but the lane ignores it (request 4). |
| Private photos and videos | `views/media.js` | `mw.media.upload/list/open/close/share/revoke/delete/keepAvailable/pinRequest/on` | **Landed**; list, open, upload progress and share/revoke results match. |
| Private record | `data.js`, `views/profile.js`, `views/settings.js` | `mw.me.get/set/erase`, fields `follows`, `blocks`, `home` | **Landed**; the field names pass `fieldProblem`. |
| Sign in | `app.js`, `data.js` | `mw.auth.signIn/signOut/onChange`, `mw.identity.openIdentity/backupStatus/setName` | **Landed.** |
| Features of the page's own ledger | `data.js` `ensureFeature` | `mw.db.set('_mw.cfg', { chat/files/media: 'members' })` | See deviation D-1. |
| Guestbook v0.3 | `peer-guestbook/js/*.js` | `ready().auth/features`, `mw.auth.*`, `mw.me.*`, `mw.identity.*`, `mw.chat.*`, `mw.files.*` | **Landed**, shapes read from the services. |

## Found against the landed code (fixed in this lane)

1. **`chat.state()` is an object**, `{ state: 'on' | 'off', hostOnly, peers, ... }`, not a string. `chat.js` accepts both.
2. **A direct or room message names its sender by key**, a string (`{ id, from: <pub>, dir, t, n, text, grant, gap }` and `{ room, id, from: <pub>, t, text }`), with no name or short id.
   `chat.js` makes every sender `{ pub, name, short }` (`personOf`), the short id from the key, the name from a contact's nickname or from the page of that owner this browser
   holds (`data.ownerName`). A message with no `text` (a file grant) is ignored by the Messages page.
3. **A room message you send is not echoed back to you.** The Lobby form and the guestbook's Lobby add it themselves and drop a second copy by id.
4. **Contacts** are `{ pub, nick, blocked, verified, hasChatKey }` (no short id) and a **verification code** is eight digits; the page prints it as `4829 1305`.
5. **A first message to a stranger is a request** that most sites do not take (`_mw.cfg.requests`), so the profile page's **Message** button makes the person a contact first (`contacts.add`)
   and reads the contacts in the same tap (the first read opens a card), then opens the conversation. With messages off it opens the page that turns them on.
6. **`mw.files.preview` and `save` answer only for a file that `mw.files.fetch` fetched** (E_FILE_UNAVAILABLE "fetch the file first" otherwise), and the lane asks the person once per
   file. A tap on "Show picture" or "Save video" therefore fetches first. The handle `fetch` returns is never read: bytes reach the screen only through `preview` and the disk only
   through `save` (R 2.8.5; a test scans the template for `.blob()`, `.stream()`, `createObjectURL`).
7. **`files.share`, `media.upload` and the other UI methods are accepted only for a call that comes from a click** (`ActivationTracker`, 5 s). A file chooser closing is not one, so choosing a
   file no longer shares it: the composer shows **Share picture**, the private media page **Encrypt and upload**, the profile picture **Share this picture**, and the tap does the call.
   The guestbook calls `mw.auth.signIn()` inside the click that posts.
8. **`hub.createPage()` returns `{ ledgerId, label, url, pointer }`**, not `{ origin, label }` (see the adapter table).
9. **The delivery state of a direct message is `outbox` or `sent-unknown` when `dm.send` returns**, and the loader's delivery strings are off until their gate rows pass (MF-35), so the page says
   "Sent" and nothing about delivery.
10. **`mw.me.get(field)` returns `null` for a missing field**, and `me.set` answers `{ stored: 'local' | 'synced' }`; `me.sync` refuses with the loader's own reason ("This site has not turned on synced
    records." and others), which the guestbook shows when the message reads like a sentence.
11. **`publish --chat`, `--files`, `--media` and `--chat-panel` only check that the site names its own tracker and STUN servers.** They do not write the switch: the genesis `publish` makes holds the policy block
    only, and the switch is `_mw.cfg` in the ledger (`ledger-admin cfg --chat members`, then the file served at `--cs`). The guestbook and drop-in READMEs say so, and
    `test/example/dropin-widgets.test.mjs` runs the steps with the real tools (publish, then `setCfg`), including that `setCfg` refuses a `wall` key.
12. **A jump to an anchor fires `popstate`** in the browsers tested (the skip link does it), and the router drew the whole page again on every `popstate`, which dropped the place keyboard focus had
    reached. The router now ignores a `popstate` that only moves to an anchor of the page it is showing (a fragment that names no element, such as a pointer, still draws the page).

## Deviations (where this lane does something other than R says, or R does not say)

| Id | What R says | What the examples do | Why |
|---|---|---|---|
| D-1 | R 3.3 and 3.5 do not say who turns chat, files and media on for a personal site. | `data.ensureFeature(name)` writes `_mw.cfg = { <name>: 'members' }` to the person's own ledger, as its owner, the first time that feature is used (first picture, first private photo, "Turn on messages"). Every key the page's `_mw.cfg` already has is written back with it (a visible `_mw.cfg` passed the schema; v0.3 code review: dropping `calls` switched calls off). | A personal site starts without `_mw.cfg`, and `src/chat/service.js` (`chatAllowed`), `src/files/service.js` and `src/media/service.js` refuse every call until the switch exists. Request 6 asks the sdk lane to put the switches into the genesis instead. |
| D-2 | R 3.5: "who may post on my wall" is `_mw.cfg.wall`. | The choice is stored in the owner's newest `mw.prof` item (`wall`, one of everyone, follow, nobody, approve) and read from there; `_mw.cfg.wall` is still read first if a ledger ever carries it. | The ledger's schema for `_mw.cfg` (`src/chain/state.js` `cfgOk`, which is R 2.5.5) allows only chat, files, media, records, requests, maxItems, chatBits, pin, age and turn, and **hides the whole object** when it holds any other key. Writing `wall` there would also switch chat, files and media off. Request 5. (v0.3 code review: the chain lane's fix of the same review adds `wall` to the schema; the template still writes `mw.prof`, because a visitor whose loader predates that change would hide the page's whole `_mw.cfg`, and it reads `_mw.cfg.wall` first.) |
| D-3 | R 3.5: notices are "chat ENVs of kind notice". | Notices are ordinary direct messages whose text starts with `mwn1:` and a small JSON object (follow, reply, mention, share, wall, join); the Messages page filters them out. | The landed chat service has no notice kind. They reach contacts and, where the site takes message requests, strangers; a notice that cannot be delivered is dropped silently. Request 7. |
| D-4 | R 3.5: a batch is `mw.ok` with at most 20 refs. | At most 20 refs and at most 2,048 bytes of JSON per item (20 refs can reach about 2,230 bytes). | The value cap of the ledger (`maxValueBytes`) is the binding limit; a test splits 45 refs as 1, 18, 18 and 9. |
| D-5 | R 3.5: drafts are sealed under `K_local`. | Drafts, hidden items, alerts and the private-follow cache are in this origin's `localStorage`, plainly. | `K_local` is not exposed to site code. Settings, Storage clears them; the README says what is kept. |
| D-6 | R 3.5: public video. | A public video shows a **Save video** button; there is no inline player. | `mw.files.preview` previews images and text only (R 2.8.5); a video is played inline only when it is private (`mw.media`). |
| D-7 | R 3.5: typing indicators, private group chats. | Not built. | Typing indicators are off by default in R; private group chat needs the groups service of 2.7.7 and a screen that R does not specify. Public rooms (the Lobby) and direct messages are there. |
| D-8 | R 3.4: own-domain handles are strong (DNS plus the signed pointer). | The page shows a handle as claimed ("not checked by this app; open the page at that address to check it"). | The check needs a DNS-over-HTTPS read from a page that is not the loader's. |
| D-9 | R 3.4: the hub directory is off by default and "pending counsel". | The code ships behind `"directory": true` in `config.json`, off, labelled; it reads static shards `/_dir/<n>.json` (the first 12 bits of the SHA-256 of the lowercase name) and warns "This name now points to a different page". Since the v0.3 code review an entry is followable only when it verifies (D-17). | N-7. Registering a name needs an endpoint, which is a backend. |
| D-10 | R 3.5: pictures from people you follow. | Off by default; an opt-in "Show pictures from people I follow as soon as they appear" exists, and the loader may still ask once per file. | The landed files lane asks before it fetches a file (R 2.8.4, MF-49); the page cannot override that. |
| D-11 | R 3.9: the guestbook keeps its pages. | The guestbook index starts every visitor as a **guest** (role `guest`; on an owner-only site `reader`), keeps the forms enabled, and signs the guest in inside the click that posts. Against a loader without `mw.auth` it behaves as in 0.2.1 and the bar stays hidden. The line budget of `js/app.js` is 400 lines (was 350); `data/about.json` is version 3.0.0 with the new pages. | For a guest's first write the loader would open its own sign-in prompt (`ensureSignedIn` in `src/loader/api.js`), but only after the write was asked for. Signing in inside the click keeps the window tied to the person's tap, reports `E_POPUP_BLOCKED` where a browser blocks it, and lets the bar and the role badge show the state. |
| D-12 | R 3.8: the drop-in example. | `with-widgets/` is a variant of the fixture, kept out of `VARIANTS` (the list of the first fixture, pinned by `test/unit/dropin-fixture.test.mjs`) in its own `WIDGET_VARIANTS`. Its page is a template: the `integrity=` hashes and the panel's hosts are filled in by `stage()` from the built files. | A hash in a checked-in page would be wrong after the next build. `startSigninServer` (`test/fixtures/signin-server/server.mjs`) is the forum's server for the end-to-end run. |

## Requests

To the **integrator** (reconciliation round):

1. ARCHITECTURE 11 and INTERFACES: record `examples/social` (hub template, plain modules, `window.__social.ctx` read-only for tests), the guestbook's v0.3 pages and
   the `with-widgets` variant, and mark them "v0.3". `test/unit/repo-layout.test.mjs` already lists `social`.
2. End to end, from the brief: **E-SO-1 to E-SO-13** (E-SO-12 needs axe-core) against `examples/social`, **E-SI-1** with `stage('with-widgets')` and `startSigninServer`
   (`examples/existing-site-dropin/EXPECTED.md`, checks 11 to 20), and the **E-ID-10** scan across the social app (`test/example/social-site.test.mjs` already scans the template's own
   pages for any field that could take a phrase, a passphrase or a backup file). Useful hooks: `window.__social.ctx` (`ctx.data`, `ctx.go`, `ctx.route`), `#view-title`, `#sync-line`,
   `#feed article`, `[data-composer]`, `#chat-on`, `#follow`, and for the guestbook `#sign-in`, `#sign-out`, `#auth-state`, `#entries li`, `#lobby-log`, `#file-list`.
3. `test/e2e/lib.mjs` `postMessage()` fills `#msg` and clicks `#post-btn`. Against a v0.3 loader a first-time visitor is a guest, so the click opens the sign-in window: the harness has to
   drive the identity page (or start from a profile that is already signed in).

To the **sdk / files lane**:

4. `files.fetch`, `preview` and `save` should accept `{ ledger }` (a followed ledger) and look the listing up there. Today the lane resolves a ref against the **page's own** `mw.files` list, so a picture
   or video listed on another person's ledger answers "Nobody who has this file is online right now." from a follower's own page. The template already passes `{ ledger }`.
5. `src/chain/state.js` `cfgOk`: add `wall: ['everyone', 'follow', 'nobody', 'approve']` (R 3.5 names it), or confirm the `mw.prof` location (D-2). The template reads both. **Done in code review v0.3** (lane ledger-tools: `wall`, `blockTiers` and `requests: 'introduced'` are schema keys, and `ledger-admin cfg --wall` writes it); the template keeps writing `mw.prof` for loaders older than that (D-2).
6. `createPersonalSite` genesis: include `_mw.cfg = { chat: 'members', files: 'members', media: 'members' }` (D-1), so the first owner session does not need the extra write.
7. Decide where the entry points GAP 2, 3 and 4 live, or confirm the assumed names; add a way for a followed snapshot to say "withdrawn" or "removed by the hub" (GAP 5). The R 3.5 "notice" ENV kind, if wanted,
   would replace D-3.

To the **docs lane**: `docs/SDK.md` should say that `mw.chat.state()` returns an object, that a room message is not echoed, and that `files.preview` needs `files.fetch` first (all true of the
landed code, none obvious from R).

## Known limits

- The social app has no ranking, no global search, no push notifications, no counts across the network, and no durability for phone-only members: R 3.6, said on its About page.
- The private follow list is backed up in the private record (`mw.me`, field `follows`), which holds about 31 KB. A follow that needs its pointer takes 300 to 450 bytes, so about 70 fit; beyond
  that `mw.me.set` answers `E_LIMIT` (ignored) and the list stays in this browser's cache only, which a cleared browser loses. Public follows are items on the person's ledger and have no such limit.
- A picture on another person's ledger cannot be fetched from your own page yet (request 4). Videos and pictures on your own page, in groups you visit, and in your own private library work.
- The guestbook's members area reads the owner's switches from `ready().features`; a loader that does not send them looks like "off".
- The guestbook's `profile.html` keeps two fields in the private record (`display`, `links`); R lists more (`contacts`, `files`, `notes`), which the page does not use.
- The drop-in checks 11 to 20 were **not run in a browser**; the parts that need none run in `test/example/dropin-widgets.test.mjs` (hashes, printed tags, headers, the widget's flow against the
  forum's server, a replayed proof, a proof for another origin, other-origin URLs refused).

## Open items

- Real-device gate rows for the social app and the guestbook's members area are not run (phones, Safari, Firefox). The browser tests cover Chromium and WebKit on loopback only.
- E-SO-1 to E-SO-13, E-SI-1 and the E-ID-10 scan over the whole app are the integrator's (above).
- The French strings: the examples use the SDK's English sentences; `src/loader/strings.js` holds both languages and the pages do not switch.

## v0.3 code review fixes (2026-10-20, examples and docs)

Findings of `docs/review/code-review-v03-conformance.md` and `code-review-v03-browser.md` on the social template, fixed in the template; what needs
another lane is under "Requests from the v0.3 code review" below.

| Id | What R says | What the template does now | Why |
|---|---|---|---|
| D-13 | R 3.3, N-6, MF-13: sign-up uses the hub identity ("default on for this template"). | "Create my page" refuses unless `identity.mode` is `'hub'` and says why (`HUB_IDENTITY`), before any card opens. | `mw.hub.createPage()` signs the genesis with the key of the address you are on. With a key for one address only, the new label derives a different key, so its owner would be a reader on their own page (every post `E_POLICY`, `isHome()` false), and nothing repairs it: the identity page records the first answer per hub and offers only "Stop using one identity". The default itself is the identity page's and the loader's (requests R-1, R-2). |
| D-14 | R 3.5: reports go to the page or group's moderators, or for personal pages to the hub's moderation contact. | A post of the group on screen: `mw.report.send`, and the page reads `{ sent }` ("Report sent to 2 moderators of this group." or "Nobody received this report: ..." with the hub's contact). A personal page's post: nothing is sent through the site; the dialog names `moderationContact` and copies the details (address, author key, time, reason, note). A group's post seen from your home: the dialog offers to open the group. | `report.send` reaches the moderators of the page on screen only and skips the reporter (`src/loader/mod.js`), so from a home every report went to nobody while the page said "Report sent."; on someone else's personal page it would go to the person reported. Request R-3. |
| D-15 | R 3.3: "Delete account" tombstones every payload, writes a withdrawal pointer, removes the directory entry. | Tombstones every list item you wrote (as before), and now deletes every key you set (`re/...` reactions, your `@<scope>/` keys; the loader's `_` keys stay), tombstoning the entry too where the snapshot gives its hash. The card says the display name stays (`mw.identity.setName` takes 1 to 48 characters) and that the address keeps working where `mw.hub.withdrawPage` is missing (GAP 2); it promises the withdrawal only where that method exists. | Reactions and the name stayed public, and the card promised a withdrawal that always failed. The SDK snapshot gives a key's value, not its entry hash, so a deleted key's earlier value stays in copies (the card says so). Requests R-4, R-5. |
| D-16 | R 3.3: "Download my data" is `exportBlocks()` of the ledger, the decrypted vault fields and the own media. | The file adds the private record's fields (read in the same tap; when the person closes the identity page's card, the file says the record is not in it) and points to the loader's own "Site ledger", "Export ledger JSON" for the signed entries. | The SDK has no `exportBlocks`; the loader's Settings has the export (`exportLedger` in `src/loader/app.js`). Request R-6. |
| D-17 | R 3.4, MF-67: name records `{ name, ledgerId, pointer, t, sig (person), hubSig }`, countersigned by the hub. | `js/directory.js` verifies before an entry can be followed: the pointer is a signed record naming `ledgerId`; `sig` by the pointer's `owner=` key over `"mw-dir-v1\n" + canonical({ ledgerId, name, pointer, t })`; `hubSig` by `config.json` `directoryKey` over `"mw-dir-hub-v1\n" + canonical({ ledgerId, name, pointer, sig, t })`; ECDSA P-256, SHA-256, 64-byte base64url signatures, canonical = keys sorted, no spaces. An entry that fails shows "Not verified" with the reason and no Follow; the "moved" warning counts verified entries only. | R names the fields, not the bytes signed. The two prefixes are new purposes (R 2.10.3; ARCHITECTURE 15.12 lists them as proposed); no component signs these records yet (registration needs an endpoint). |
| D-18 | R 2.5.5 (`_mw.cfg`) and DESIGN-REVIEW S10 (mobile viewport). | `_mw.cfg` keys the template does not know survive `ensureFeature` (D-1); `.toasts` and the skip link keep the safe-area insets, because `index.html` asks for `viewport-fit=cover`. | Low findings of the same review. Whether each engine passes the page's insets into the loader's frame is a real-device row (DEMO-RESULTS, G-SO-5). |

Tests: `test/example/social-data.test.mjs` (new: `_mw.cfg` with `calls` kept, `ownKeys`, the export), `social-lib.test.mjs` (the hub adapter's
`canCreatePage` and `canWithdraw`, the directory checks with real keys from `social-directory-keys.mjs`), `social-site.test.mjs` (`directoryKey`,
the safe-area rule), and the browser tests for Create my page, the three report paths, the export and Delete my page with and without
`withdrawPage`, and the directory with a forged and a moved entry. The mock (`mock-sdk.js`) now reports `identity.mode`, returns `{ sent }` as a
number, tombstones key entries by hash and knows `calls` in `_mw.cfg`.

Results (2026-10-20, 23:30 ET, Node 24.22, Chromium with `chromiumArgs({ allowRemote: false })`, WebKit on 127.0.0.1): `npm run test:example`
177 passed, 0 failed; `npm run check:example` 2 sites, 7 pages, 0 errors; `node tools/lint-floor.mjs` clean. Two edits follow other lanes'
work of the same review in the working tree: the guestbook's `profile.html` shows the loader's new `recoveryKitIos` sentence (the page
must show the loader's card copy), and `dropin-widgets.test.mjs` refuses a key no `_mw.cfg` schema has, because `wall` (request 5) is
becoming a schema key. The new end-to-end scenario E-SI-5W (`test/e2e/scenarios-dropin-v03.mjs`) is written and not yet run.

### Requests from the v0.3 code review

- **R-1 (idp, identity service, sdk):** decide the hub default at the identity origin from something the page cannot set (the hub's signed
  pointer or config, or the template infohash), and drop `hubDefault` from `mw.auth.signIn` (R 2.3.5: "no SDK parameter can preselect it");
  give the identity page's Settings a way to turn one identity on for a hub after a "no". Then E-SO-1 should sign up without ticking the box.
- **R-2 (loader, `src/loader/app.js` createPage):** refuse `mw.hub.createPage()` unless the key mode is `'hub'` (or switch hub scope on in the
  same identity card), so no other page can make an unusable personal site either.
- **R-3 (loader `src/loader/mod.js`, sdk):** `mw.report.send({ ..., ledger })` addressed to that followed ledger's moderators, so a group's
  post can be reported from a home; for personal pages, a way to reach the hub's moderation contact through the loader. Then the template's
  group-from-home path calls it.
- **R-4 (identity service):** let `mw.identity.setName('')` clear the name (the ledger already reads an empty profile entry as no name), or
  build "Leave this site" (R 2.15) with its card: tombstone every payload of the key, empty the profile, stop seeding, revoke grants.
- **R-5 (loader, sdk):** `mw.hub.withdrawPage()` (GAP 2): the `st=withdrawn` pointer signed by the person's key.
- **R-6 (sdk):** `mw.db.exportBlocks()` (or `db.snapshot({ blocks: true })`) for the person's own ledger, so the file holds the signed entries.
