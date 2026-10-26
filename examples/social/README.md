# Social (felinar example and template, v0.3)

A social network of personal sites, loaded by magnet link, peer-to-peer. It is the template a hub operator or a site owner
deploys: **every person and every group is its own site with its own site ledger** (a signed, hash-linked log that visitors copy and
check; no mining, no consensus), and all of them point at the same template torrent. A person's timeline is built in their own
browser from the people they follow, newest first, with no ranking. The specification is
[Part 3 of the v0.3 design review](../../docs/review/V03-DESIGN-REVIEW.md) ("R" below); the SDK it uses is in [SDK.md](../../docs/SDK.md).
Where this folder differs from the review, [docs/deviations/examples.md](../../docs/deviations/examples.md) says why.

The smaller example, [peer-guestbook](../peer-guestbook/README.md), shows the same ideas on one page. Read it first if you are new.

## What it does

| Area | What the template does |
|---|---|
| Accounts (R 3.3) | Sign in through the identity page (`mw.auth.signIn`), then "Create my page", which needs one identity on all of the hub (below); profile (name, bio, up to 3 https links, a picture scaled to 512 px, an optional own-domain handle); a private record (`mw.me`); data export with the record's fields; "Delete my page" (below: what it does and what it cannot do yet). |
| Posts (R 3.5) | Text up to 2,000 characters, up to 4 pictures or videos (each shared with its own tap, because the loader accepts a share only from a click), a link, edits with History, deletes by tombstone, drafts kept on the device (up to 20). **Every public picture needs a description** before it can be posted. |
| Timeline (R 3.5) | Merged in the browser by (time, hash), newest first, 30 to a page, an "N new posts" button instead of a feed that moves, filters (posts, replies, media, one person). No ranking, no recommendations. |
| Follows | Public (`mw.f` on your ledger) or private (your private record), people you follow (`mw.hub.follow`), "Followers you can see", suggestions from the public follow lists this browser holds, block, hide, report (below). |
| Comments, reactions, shares | Comments live on the commenter's own ledger (`mw.c`); the post's author accepts them in batches of at most 20 refs (`mw.ok`). One reaction per member per target. Shares and quotes (`mw.q`). Up to 10 mentions per post. |
| Wall setting | Who may write on your wall: everyone, people you follow (the default), nobody, or "I approve each one". R 3.5 puts it in `_mw.cfg.wall`; the ledger hides a `_mw.cfg` with a key it does not know, so it is kept in your profile item (`wall`) and `_mw.cfg.wall` is read first if a ledger carries it. |
| Messages (R 2.7) | Direct messages, requests, "Connected to you now", verification by a short code, rooms. Off until the person turns them on. |
| Photos and videos (R 2.9) | Public pictures load only when tapped. Private photos and videos are encrypted on the device and streamed in the page: a poster grid, a plain `<video src>`, share, take back access, "Kept by the hub" or "Available only while someone who has it is online". |
| Groups | A group is its own site: owner, up to 50 moderators, members who may post (an `allow` group, up to 1,000, or an `open` group with the spam fee), join requests, moderation, a Lobby room. |
| Discovery (R 3.4) | The link with the pointer in the fragment, a QR invite (a small encoder is bundled in `js/qr.js`), your own domain as a claimed handle, local search over what the browser holds. The hub directory is code that ships **off** (`/config.json`, "pending counsel"; no lawyer is engaged for 0.3.0); when it is on, only entries signed by the person and countersigned by the hub can be followed (below). |
| About (R 3.6) | The honest-ceiling table: what needs an index and is not here. |

## The home origin model (R 3.1)

A signed-in member uses the app on **their own** label (`<label>.hub.example`): their timeline, messages and settings, and every other
person's wall at `/@<label>`, all render inside their own origin from the ledgers that origin's engine follows. Every write goes to the
ledger of the page's own origin, so on your own page you write posts, comments, follows and reactions to *your* ledger, and a comment on
someone else's post is a block on yours that points at theirs. Opening someone else's address directly is for signed-out readers and shared
links; a signed-in member there gets **Open in your home**, which sends them to their own page with the link's pointer in the fragment.
A group's posts are written on the group's own address, so from your home a group is read-only with a link to open it.

## Files

| Path | What it is |
|---|---|
| `index.html` | The one page: header, nav, the `#view` that every route fills, the live regions, the About page as a `<template>`, the noscript notice. |
| `404.html` | The plain not-found page of the static files (inside the loader every address opens the app). |
| `config.json` | Operator settings read at start: `appName`, `directory` (false), `directoryNote`, `directoryKey` (the hub's public key that countersigns directory entries, empty), `moderationContact`, `hubName`. |
| `css/app.css` | Mobile-first, system fonts, light and dark with a manual override, one column up to 1,023 px and two from 1,024 px, 44 px targets, reduced motion. |
| `img/social.svg` | The logo and the icon. |
| `js/app.js` | Boot, the History API router, the page chrome (nav, sync line, identity chip, theme). |
| `js/model.js` | **Pure logic**, unit-tested in Node (`test/example/social-model.test.mjs`, U-SO-1): timeline merge, edit history, threads, `mw.ok` batching, reaction counts, wall decisions, follow caps, mentions, validation, drafts. |
| `js/data.js` | The data layer: this ledger, the followed ledgers, every write, notices, the `mw.ok` queue, export. |
| `js/hub.js` | The adapter for the hub features of the SDK (`mw.hub.*` and the `{ ledger }` reads) and the three GAPs (below). |
| `js/router.js`, `js/strings.js`, `js/config.js`, `js/ids.js` | Routes (R 3.7), every sentence the page prints (the R 3.7 strings verbatim, the SDK's error table), constants, and the identifiers the template derives (hub label, short id, author scope). |
| `js/notices.js`, `js/inbox.js`, `js/chat.js` | The notice convention, conversation state, a thin wrapper over `mw.chat`. |
| `js/search.js`, `js/qr.js`, `js/directory.js`, `js/media-prep.js`, `js/store.js`, `js/dom.js` | Local search, the QR encoder, the flagged directory, picture scaling for the avatar, device-local state, DOM helpers (nothing parses HTML). |
| `js/views/*.js` | One file per screen: timeline, profile, post, group, messages, notifications, media, settings, about, and the shared card and composer. |

## Routes and states (R 3.7)

The loader serves this page for every path, so each route works on reload and when shared.

| Route | Screen |
|---|---|
| `/` | Your timeline (on someone else's address: that person's page; on a group's address: the group) |
| `/@<label>`, `/@<label>/p/<hash>` | A person, a post and its comments |
| `/g/<label>` | A group |
| `/messages`, `/messages/<short id>` | Conversations |
| `/notifications` | Alerts |
| `/media`, `/media/<id>` | Private photos and videos |
| `/settings`, `/settings/<section>` | Profile, identity, privacy, what others can see, invite, notifications, storage, messages, pictures, appearance, export, delete |
| `/about` | What this can and cannot do |

States, in the exact words of R 3.7:

- "You don't follow anyone yet. Share your QR code or open a friend's link."
- "This page doesn't exist in this app."
- "This post isn't in the copies this browser has. It may have been removed, or nobody who has it is online."

The page also has a sync line
("Catching up: 37 of 120 pages") and, when nothing is reachable, "Showing what this device has. Last updated 14:02." JavaScript off shows only the notice
"This site loads from other visitors' browsers and needs JavaScript."

## Deploying it on a hub

1. **Run a hub**: a wildcard certificate, the built loader on the apex and on every label, an edge rule that answers only labels of 32 base32
   characters, and a Public Suffix List entry for the hub domain (without it persistent identity is switched off). See
   [DEPLOY.md, Hubs](../../docs/DEPLOY.md#hubs).
2. **Publish the template once.** It is a site like any other; the infohash it prints is the *template torrent* that every personal and group
   site points at (`btih=<template>` in each member's signed pointer), so the site files are one hub-wide swarm and the content of each site is its
   ledger:

   ```sh
   node tools/publish.mjs examples/social --name social-template --scope hub.example --key owner.jwk --tr wss://tracker.example --ws https://hub.example/ws/ --spa --verify-ws --out dist-hub
   ```

   `--spa` is what makes the routes above work on reload: the worker answers every navigation with `index.html`
   (without it a reload of `/@<label>/p/<h>` shows the 404 page). Keep `--name` the same across versions. The member's own page is created in their browser (R 3.3): the identity page asks, the loader mints the
   personal ledger (`writers: 'owner'`, 16-bit fee, 8 MiB) and signs the pointer with the member's own key. The hub never holds a member's key.
3. **Turn on what you can run.** Chat and files need the hub's own tracker and STUN servers (`publish --tracker ... --stun ...`). A hub pin and
   snapshot service is optional **central storage the operator pays for and can be made to remove**; with it on, items say "Kept by the hub"
   ([recipes/hub-pin.md](../../docs/recipes/hub-pin.md)). Without it, items say "Available only while someone who has it is online". Its pin
   mailbox for offline messages and members' own pin requests are (proposed): no page sends them yet.
4. **Edit `config.json`**: the app name, the moderation contact that reports about personal pages go to, and the directory flag. **Leave the
   directory off** until a lawyer where you operate has reviewed it (R 3.4, N-7; no lawyer has reviewed it for the project, and none
   is engaged for 0.3.0): its code is here, behind `"directory": true`, and a name that later points at a
   different page shows "This name now points to a different page" on pages followed by name. Names are served as static shards
   `/_dir/<n>.json`, where `n` is the first 12 bits of the SHA-256 of the lowercase name (`js/directory.js`). Each entry
   `{ name, ledgerId, pointer, t, sig, hubSig }` is checked before it can be followed (MF-67): `pointer` is the person's signed record and
   names `ledgerId`; `sig` is the person's ECDSA P-256 signature, by the pointer's `owner=` key, over `"mw-dir-v1\n"` and the JSON of
   `{ ledgerId, name, pointer, t }` with its keys sorted; `hubSig` is the hub's, by the key in `directoryKey`, over `"mw-dir-hub-v1\n"`
   and the JSON of `{ ledgerId, name, pointer, sig, t }` with its keys sorted (64-byte signatures, base64url). Without `directoryKey`
   nothing verifies and no name can be followed. Nothing in felinar signs these records yet: registering a name needs an endpoint,
   which is a backend (R 3.4), so this is the format the template proposes for your exporter.
5. **Tell people the limits** in your own words; [OPERATIONS.md](../../docs/OPERATIONS.md) has the hub safeguards.

## Follow caps and what grows

| Quantity | Value | Source |
|---|---|---|
| Follows on a phone, on a computer | 250 and 1,000 | chosen; real-device gate rows G-SC-1 and G-SC-9 confirm or lower them. The page shows "You follow 250 of 250 on this phone". |
| Posts kept per followed ledger | the newest 200, plus the control blocks | chosen (R 3.2.2) |
| Bytes per followed ledger | about 200 KiB | model: a block is about 1 KiB (R 3.2.3), not a measurement |
| A personal ledger | about 14 blocks a day (1 post, 10 reactions, 3 comments) is about 5 MB a year | model; the owner raises `maxChainBytes` from the identity card |
| Timeline page | 30 | chosen |
| Local search index | 10 MiB on phones | chosen (R 3.4) |

## What needs an index (R 3.6)

A ranked feed, trending, search across everyone, replies and mentions from people you do not follow while you are offline, global follower and
like counts, spam fighting across the hub, push notifications when the page is closed, and durability for phone-only members all need an
index or another central component. None is in this version, and each would be a labelled backend. The About page of the app says so.

## What the template needs from the SDK, and what is assumed

Everything uses the public SDK (`window.mw`, `/_mw/sdk.js`) of [R 2.11.2](../../docs/review/V03-DESIGN-REVIEW.md), plus the sdk lane's hub amendment, which
has landed (`src/sdk/sdk.js`, `src/loader/personal-site.js`): `mw.hub.follow(pointer | ledgerId)` -> `{ ledger, following, cap }`, `unfollow(ledger)`,
`list()` -> `[{ ledger, owner, since, height, pointer }]`, `createPage()` -> `{ ledgerId, label, url, pointer }`, and a `{ ledger }` option on `mw.db.get`,
`list` and `subscribe` (read only). The adapter is `js/hub.js`; its tests mock `mw` at that boundary. The shapes the template reads from the loader's other
services are the landed ones: a direct or room message names its sender by key (`from` is a string), `chat.state()` is an object, a room message you
send is not echoed back, contacts are `{ pub, nick, blocked, verified, hasChatKey }`, `mw.files.preview` and `save` answer only for a file that
`mw.files.fetch` fetched first (the loader asks once per file), and `files.share` opens a card that the loader accepts only for a call that comes from a click.

Three things have no method in the SDK yet. Each is one function in `js/hub.js` that throws `NOT_AVAILABLE` ("This copy of the loader does
not offer that yet.") when the method is missing, and none is faked:

| GAP | What | Assumed |
|---|---|---|
| 2 | "Delete my page": the signed withdrawal pointer | `mw.hub.withdrawPage()` |
| 3 | This page's own signed pointer, for the invite link and QR code | `mw.site.info().pointer`, else the top page's fragment |
| 4 | Asking a group's moderators to let you in | `mw.mod.requestJoin(group)` |

(GAP 1, "Create my page", landed as `mw.hub.createPage()`; the page opens the `url` it returns as it is, because that address carries the pointer and the genesis
in its fragment.) A fifth assumption: a followed ledger's snapshot may carry `withdrawn: true` or `removed: { reason }`; the page then shows "This page was
withdrawn by its owner" or "Removed by this hub". One limit of the landed files lane: it looks a file up in the listings of the page's own ledger, so a picture
listed on another person's ledger is not fetchable from your own page until the lane accepts `{ ledger }` (the template already passes it); until then the tap
says "Nobody who has this file is online right now." Notices (follow, reply, mention, share, wall, join) travel as ordinary direct messages whose
text starts with `mwn1:`; `js/notices.js` defines them and the Messages page hides them.

## Sign-up, reports, export and deleting a page

- **"Create my page" needs one identity on all of the hub** ("Use one identity on all of <hub>" on the identity page; `identity.mode` is
  `'hub'`). The new page's genesis is signed with the key of the address you are on, and only a hub identity is the same key on the new
  address; with a key for one address only you would be a reader on your own page. The page refuses before any card opens and says why.
  The identity page asks the hub question once per hub and has no way yet to turn a "no" into a "yes" (docs/deviations/examples.md).
- **Report (R 3.5).** A post of the group on screen is reported with `mw.report.send` to the group's moderators, and the page says how many
  received it (`{ sent }`), or that nobody did. A personal page's only moderator is the person it is about, and `mw.report.send` from your
  home would reach only your own page's moderators (you), so for a personal page nothing is sent through the site: the dialog names the
  hub's moderation contact from `config.json` and copies the details (the post's address, the author's key, the time, your reason and note;
  never the picture or video). A group's post seen from your home offers to open the group, where the report reaches its moderators.
- **Download my data (R 3.3)** holds your lists, keys and names as this browser has them, your device-local state, and your private
  record's fields (read in the same tap, so the identity page may ask first). The signed entries themselves are not given to the page by
  the SDK: the file and the page point to the loader's own Settings, "Site ledger", "Export ledger JSON".
- **Delete my page (R 3.3)** removes your private record and its keys (`mw.me.erase`), tombstones every list item you wrote (posts,
  comments, shares, follows, profile items), and deletes every key you set (your reactions `re/...` and your author-scoped keys; the
  loader's own `_` keys stay). It cannot yet clear your display name (`mw.identity.setName` takes 1 to 48 characters) or withdraw your
  page's address (GAP 2), and the card says so; the withdrawal is promised only where `mw.hub.withdrawPage` exists. Each removed entry
  keeps a stub (your key, the time, the list or key name), and the earlier value of a deleted key stays in copies of the ledger.

## Privacy and honesty

- Everything on a wall, a profile, a public follow list and a reaction is public and copied to every visitor. "What others can see" in Settings says so.
- Public pictures are never fetched until the reader taps them (or turns on "Show pictures from people I follow as soon as they appear", where the loader may still ask once for each file): fetching also
  shares the file with others while the page is open, and they see your IP address next to it.
- No ranking, no hidden scoring. Counts are counts of what this browser can see, labelled "from people you follow"; a group's are counts of keys.
- The page never asks for a recovery phrase or a backup file: those open only on the identity page. A test scans every screen for such a field.
- Messages are never written to a ledger. Anyone connected to a conversation can record it.
- Drafts, hidden items, alerts and a cache of private follows live in this origin's `localStorage` (the SDK keeps the sealed device key out of site
  code, so the template cannot seal drafts under it). Clear them in Settings, Storage.

## Tests

```sh
export PATH=$HOME/.local/share/node/current/bin:$PATH   # Node 22 or newer
npm run test:example      # model, libraries, static checks, browser tests (Chromium with the local-only flags, WebKit on 127.0.0.1)
npm run check:example     # the HTML checker over every page of the examples
```

| File | What it proves |
|---|---|
| `test/example/social-model.test.mjs` | U-SO-1: merge order by (time, hash), edit history, `mw.ok` batches of at most 20 refs, one reaction per member per target, wall decisions, follow caps, threads, validation, drafts |
| `test/example/social-lib.test.mjs` | identifiers against the loader's own functions, routes, notices, search, the QR encoder (published Reed-Solomon codewords, pinned symbols, every version), strings against `src/loader/strings.js`, the hub adapter at the contract boundary, the directory's signature checks with real P-256 keys |
| `test/example/social-data.test.mjs` | the data layer against a fake SDK: `_mw.cfg` written back with every key it had (calls included), the keys "Delete my page" removes, what "Download my data" holds |
| `test/example/social-site.test.mjs` | the files, the HTML checker, every route has a screen or a state, every error code used has a string, no banned word, no non-local URL, no field for a secret, alt text is enforced, the browser floor |
| `test/example/social-browser*.test.mjs` | the screens in a browser against `mock-sdk.js`: flows, settings, media, messages, groups, layout at 320, 390 and 1,024 px, keyboard, themes, contrast |
| `test/example/sdk-surface.test.mjs` | every SDK call the template makes exists on the facade of `src/sdk/sdk.js`; the GAPs are reported when the SDK gains the method |

The end-to-end scenarios E-SO-1 to E-SO-13 (a real loader, real peers; E-SO-12 runs axe-core, a development dependency) belong to the integration suite.
