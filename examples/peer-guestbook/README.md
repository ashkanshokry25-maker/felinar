# Peer Guestbook (felinar example site)

A small static site that is loaded by magnet link, peer-to-peer, from a plain static host. No backend.
Its files travel over WebTorrent, the loader's Service Worker serves them at the site's own URLs, and
its guestbook, display names and owner notice live in the **site ledger**: a signed, hash-linked log
that every visitor copies and verifies. No mining, no consensus, no finality.

It exists to show, end to end, that a site served this way behaves like a normal website: HTML, CSS,
an image, a JSON file fetched at runtime, a short video that needs HTTP Range requests, a second page
reached by deep link, a 404 page at any depth, and a live data layer through the SDK.

**v0.3 (V03-DESIGN-REVIEW 3.9).** Visitors now sign in: **Sign in** opens the felinar identity page in its own
window and gives this site a key that works only here, and **Sign out** deletes this site's keys from the browser.
A **profile page** holds the private record ("Encrypted. The site can read it while you are signed in."), the
recovery kit and the device links, which open the identity page. An optional **members area** has chat and public
file listings, both off until the owner turns them on. Against a loader older than v0.3 (no `mw.auth`) the sign-in
controls stay hidden and the site works exactly as before.

## Files

| Path | Purpose |
|---|---|
| `index.html` | Guestbook page: Live card, You card, owner notice, guestbook, moderation panel, media |
| `about.html` | Second page (links, deep links, the Back button); explains how the site is delivered and what signing in does |
| `profile.html` | Your profile (v0.3): public name, private record, recovery kit and device links, sign out |
| `members.html` | Members area (v0.3, optional, off by default): chat Lobby and public file listings |
| `404.html` | Plain static not-found page; root-relative assets, so it renders at any depth |
| `css/app.css` | Mobile-first styles, system fonts, light and dark |
| `js/app.js` | Guestbook behaviour (under 400 lines, plain ES module, no framework, text set with `textContent` only); a guest signs in when posting |
| `js/auth.js` | The header bar of every page: Sign in, Sign out, who is signed in (hidden when the loader has no `mw.auth`) |
| `js/profile.js` | The profile page: `mw.me`, `mw.identity.openIdentity()`, `mw.identity.backupStatus()`, sign out |
| `js/members.js` | The members area: `mw.chat` Lobby, `mw.files` listings |
| `js/common.js` | Helpers the three scripts above share (element builder, toasts, the SDK's error sentences, dynamic SDK import) |
| `img/peer.png` | 64x64 RGBA PNG: binary files and `image/png` |
| `data/about.json` | Read with `fetch('/data/about.json')`: `fetch()` and `application/json` |
| `media/clip.mp4` | 4-second H.264 clip (18,833 bytes, 320x180, keyframe every second, moov first) for Range and seeking |
| `README.md` | This file. `publish.mjs` leaves it out of the torrent |

The checks and generators for this folder live in `test/example/` ([below](#checks-testexample)), so the folder
holds only the site and you can copy it as a starting point.

## URL rules the site follows

The loader serves the site at its own origin (shell mode: a same-URL iframe), so the site uses
**root-relative URLs** exactly like a normal site: `/css/app.css`, `/js/app.js`, `/img/peer.png`,
`/media/clip.mp4`, `fetch('/data/about.json')`, links to `/` and `/about.html`.

- No external resources at all (no fonts, no CDNs, no analytics).
- The only loader path the site uses is the SDK, `/_mw/sdk.js`, imported dynamically.
- The site never uses the paths a loader origin reserves: `/_mw/*`, `/mw-sw.js`, `/ws/*` and `/.mw/*`.
- `404.html` has no script. Its stylesheet and links are root-relative, so it looks right wherever
  the loader (or a static host) returns it.
- Root-relative URLs are not supported on a shared-origin hub (`/_mw/s/<btih>/...`, demo only).
  Use shell mode or a subdomain hub.

## What the page uses from the SDK (ARCHITECTURE section 9)

```js
const mw = (await import('/_mw/sdk.js')).default;   // dynamic import, see "Standalone" below
const info = await mw.ready();
// { siteId, btih, mode, auth: 'guest' | 'signed-in' (v0.3), identity: { pub, short, name } | null, role, peers, height, owner, unmoderated,
//   features: { chat, files, media, records, requests } (v0.3, the owner's switches) }
mw.db.subscribe((snap) => {});      // { height, peers, inSync, kv, lists, profiles, policy }
mw.db.append('guestbook', { msg }); // 280 characters at most, checked in the form too
mw.db.tombstone(h);                 // own posts; moderators and the owner: any post
mw.db.get('_notice') / set / del    // owner notice; "_" keys are owner and moderator only
mw.mod.ban(pub)                     // moderators
mw.identity.setName(name)           // 48 characters at most
mw.site.info()                      // { name, files, btih, source, mode }
mw.consent.state()                  // 'pending' | 'accepted' | 'host-only'
mw.net.on('peers' | 'progress' | 'status' | 'sync', fn)
```

and, when `ready().auth` exists (a v0.3 loader):

```js
mw.auth.signIn()                    // opens the identity page; call it inside a click (E_POPUP_BLOCKED otherwise)
mw.auth.signOut({ forget })         // deletes this site's keys; forget: true also removes the stored copies (UI)
mw.auth.onChange(fn)                // fn({ state, identity, role })
mw.me.get() / set(field, value) / del(field) / sync({ on }) / erase()    // the private record; the first get() of a visit opens a card
mw.identity.openIdentity()          // the recovery kit and the device links live there; 'done' | 'cancelled'
mw.identity.backupStatus()          // { kitSaved, fileSaved, passkey, persisted, legacy }
mw.chat.state() / enable() / on('room', fn) / room.join('Lobby') / room.send('Lobby', { text })
mw.files.list() / share(file, { public: true }) / fetch(ref) / preview(ref) / save(ref) / remove(ref)
```

What the page shows:

- **Ledger line**: `Ledger: 1,204 entries, in sync with 3 peers`, from `snap.height` and `snap.inSync`
  (a count of peers holding the same entries; a boolean is read as "all connected peers" or none).
- **How the page arrived**, from `site.info().source` (`peers`, `webseed`, `cache` or `mixed`).
- **Sharing line**, from `mw.consent.state()`. On phones and other touch screens it reads
  "Sharing only while this page is open and on screen."; with host only it reads "Host only: no peer
  connections. Slower, and shared data won't sync."; before consent it says that nothing connects to
  other visitors yet.
- **Role** (`ready().role`, updated when the policy names this identity a moderator or bans it):
  `reader`, `writer`, `moderator` or `owner`. The notice editor appears only for `owner` and
  `moderator`. Moderators get **Remove post** (tombstone) and **Ban author** on every post except
  posts by the owner and other moderators. Everyone gets **Delete** on their own posts. Destructive
  buttons need a second tap instead of a modal dialog.
- **unmoderated** badge when `ready().unmoderated` is true (the site was opened from an unsigned
  magnet link, so it has no owner key and no moderators).
- Entries are listed newest first in ledger order, never sorted by their timestamps, which are claimed
  by each author and shown as such. Display names come from `snap.profiles`; visitors without a name
  appear by short id (first 8 hex of `sha256(raw public key)`).

Error codes become plain sentences: `E_RATE`, `E_POLICY`, `E_LIMIT`, `E_NOT_OWNER`,
`E_NOT_MODERATOR`, `E_POW_ABORTED`, `E_IDENTITY`, `E_NO_HOST`, `E_CAP`, `E_BANNED`; the v0.3 pages use the
SDK's own sentences for `E_NOT_SIGNED_IN`, `E_USER_CANCELLED`, `E_POPUP_BLOCKED`, `E_NEEDS_GESTURE`,
`E_HOST_ONLY`, `E_NO_OWN_TRACKER`, `E_FILE_UNAVAILABLE` and the others of R 2.11.2 (`src/loader/strings.js`; a test
compares them).

## Sign in, profile and members (v0.3)

**Guests and signing in.** A visitor with no key on this site is a **guest** (`ready().auth === 'guest'`). Guests
read everything. The Post and Display name buttons ask a guest to sign in first: the page calls `mw.auth.signIn()`
inside the click, because the loader opens the identity page only for a call that comes from a tap. The header bar
shows "You are browsing as a guest." with a Sign in button, or "Signed in as Ada (5666dca3)." with a Sign out button.
The role badge reads `guest` until the visitor signs in (on an owner-only site a guest is a `reader`).

**The profile page** (`/profile.html`) shows the public name and id, then the private record (`mw.me`): a private
nickname and a link, saved with `mw.me.set('display', ...)` and `mw.me.set('links', [...])`. The record is stored
on the device; **Keep an encrypted copy on this site's ledger** (`mw.me.sync({ on: true })`) needs the owner to set
`_mw.cfg.records` to `sealed`. "Show my record" is a real tap because the first `mw.me.get()` of a visit opens a
card. **Recovery kit** and **Link another device** both call `mw.identity.openIdentity()`, which opens the identity
page in its own window; the page shows `backupStatus()` beside them. The page has no field for a recovery phrase or a
password: those are typed only on the identity page (a test scans for such a field). **Sign out** and **Remove from
this device** call `mw.auth.signOut()` and `mw.auth.signOut({ forget: true })`.

**The members area** (`/members.html`) is optional and off by default. It reads the owner's switches from
`ready().features`:

| Feature | Owner switch | What the page shows |
|---|---|---|
| Chat | `_mw.cfg.chat` = `members` or `open`, set by `--chat` when publishing or `ledger-admin cfg --chat members` | "Messages are off on this site." until then. When on: "Turn on chat" (`mw.chat.enable()`, a card), then the Lobby (`mw.chat.room.join('Lobby')`, `mw.chat.room.send`, `mw.chat.on('room')`) |
| Files | `_mw.cfg.files` = `members`, set by `--files` or `ledger-admin cfg --files members` | "File listings are off on this site." until then. When on: Share (`mw.files.share(file, { public: true })`), and for each listing Fetch, Show (`mw.files.preview`) and Save (`mw.files.save`) |

A file is fetched only when the member taps Fetch (the loader asks once per file), and its bytes reach the screen
only through `mw.files.preview` and the disk only through `mw.files.save`. Names and messages from other visitors are set as
text. Chat and files need the site's own tracker and STUN servers, so `publish` refuses `--chat` or `--files`
without `--tracker` and `--stun`; without a tracker `mw.chat.enable()` fails with `E_NO_OWN_TRACKER`.

**Standalone.** If `/_mw/sdk.js` cannot be imported (a plain static host) or `mw.ready()` rejects with
`E_NO_HOST` (the page is not inside the loader), the page keeps its static content, disables the forms
and shows "Open this site through the felinar loader".

## Publish it

```sh
export PATH=$HOME/.local/share/node/current/bin:$PATH   # Node 22 or newer

# One-time: the owner key pair. Keep owner.jwk private (mode 0600); it never goes into a browser.
node tools/keygen.mjs --out owner.jwk

# Publish note: open writing and a 16-bit posting fee, so every visitor can sign the guestbook.
node tools/publish.mjs examples/peer-guestbook --name peer-guestbook --scope <host> --key owner.jwk --policy open --bits 16 ...
```

The `...` stands for the rest of the flags in ARCHITECTURE section 10. A typical full command:

```sh
node tools/publish.mjs examples/peer-guestbook --name peer-guestbook --scope guestbook.example.com --key owner.jwk \
  --policy open --bits 16 --moderator <moderator public key> \
  --ws https://guestbook.example.com/ws/ --tr wss://tracker.example.com --exp 90 --seq 1 \
  --verify-ws --out dist-example
```

- `--name` is the torrent name. Keep it the same across versions: it is part of the infohash and of
  the web-seed layout `<ws base>/<name>/<path>`.
- `--scope` is the hostname the pointer is signed for. In shell mode the ledger id is derived from the
  owner key and the scope, so the guestbook survives every new version. For hub links signed for
  `btih:<hex>`, pass `--chain peer-guestbook` (the same value every time) or each version starts an
  empty ledger.
- `--policy open --bits 16` writes the genesis policy block: anyone may post, each post carries a
  16-bit proof-of-work fee, and owner and moderator blocks are exempt. Without `--policy open` only the
  owner and moderators could write, and the guestbook form would show the reader message.
- `--moderator <pub>` names a moderator in the genesis policy. Make a second key with
  `node tools/keygen.mjs --out moderator.jwk` and pass the public key it prints. In a browser the
  moderator uses the loader's Settings, Import moderator key; this page then shows the notice editor,
  Remove post and Ban author.
- `--ws` and `--xs` let the site load when no other visitor is online. `publish.mjs` writes
  `site.torrent` next to the web seed and signs `xs=` into the pointer when `--ws` is given.
- `--verify-ws` probes the web seed (CORS preflight and `Range: bytes=0-0`) before printing the pointer.

`publish.mjs` leaves dotfiles, dot-directories and `README.md` out of the torrent, writes
`/.mw/site.json` and `/.mw/files.json` into its publish copy, and prints `pointer.txt`, `meta.html`,
`dns.txt`, `magnet.txt` and the other outputs listed in ARCHITECTURE section 10. Use `404.html` as the
not-found page in the routing manifest, which is the same convention GitHub Pages, Netlify and
Cloudflare Pages follow.

**Turning on the members area** takes two steps, because the switches live in the ledger and the connection servers live in the pointer:

```sh
# 1. Publish with the site's own tracker and STUN servers. --chat and --files make publish check that you named them (it refuses otherwise);
#    they do not write the switch.
node tools/publish.mjs examples/peer-guestbook --name peer-guestbook --scope guestbook.example.com --key owner.jwk \
  --policy open --bits 16 --chat --files --tracker wss://tracker.example.com --stun stun:stun.example.com:3478 --out dist-example ...

# 2. Turn the switches on in the ledger with the owner key, offline, and publish the ledger file as the snapshot visitors fetch (--cs).
node tools/ledger-admin.mjs cfg --key owner.jwk --file dist-example/genesis.json --chat members --files members --records sealed --max-items 4
```

The settings are advisory: honest loaders enforce them. Sealed records cost about 1,877 bytes of ledger per item, so the
owner budget is members times items times 1,877 bytes.

Deploy order: upload the site files and `site.torrent`, run `node tools/check-webseed.mjs`, then switch
the pointer (the `<meta>` tag in the loader's `index.html`, or the `_magnet` TXT record), and keep the
previous version's files for at least 7 days.

### Try it on one machine

`npm run demo` (`tools/demo.mjs`) publishes this folder with `--policy open`, starts a local tracker
and the dev server, seeds from a headless page and prints a URL. Open it in two different browsers (or
two browser profiles: windows of one profile are one visitor) and sign the guestbook in one of them; the
entry appears in the other, and both show the same ledger line.
Phones on the same network need `npm run demo -- --tls` with the mkcert root installed on the phone.

### Preview the files without the loader

```sh
npx http-server examples/peer-guestbook -p 8081 -c-1
# open http://127.0.0.1:8081/ : the static page renders with the "Open this site through the
# felinar loader" notice, the image, the video and the about.json text
```

## Checks (`test/example/`)

| File | What it does |
|---|---|
| `test/example/check-html.mjs` | Dependency-free HTML checker: nesting, void elements, attribute quoting, ids and label targets, content-model slips, entities, ASCII text, counts per page. `npm run check:example` |
| `test/example/site.test.mjs` | Static checks (`node --test`): files, HTML, root-relative URLs, the scripts' rules (line budget, no HTML injection, browser floor), the v0.3 sentences compared with the loader's strings, no secret-entry field, wording, CSS, PNG, MP4 boxes, `about.json`, 404 page, this README |
| `test/example/browser.test.mjs` | Playwright smoke test (Chromium and WebKit) against `test/example/mock-sdk.js`, a stand-in for `/_mw/sdk.js`: roles, moderation, notice, consent copy, ledger line, standalone mode, about page, 404 at depth, MP4 playback and seeking through Range responses |
| `test/example/browser-v03.test.mjs` | The v0.3 pages in a browser: guest and signed-in states, sign in and out, posting as a guest, the profile page and its calls, the members area off and on, widths from 320 px |
| `test/example/mock-sdk.js` | In-memory implementation of the section 9 SDK surface (and, with a v0.3 scenario, of R 2.11.2), used only by the browser tests |
| `test/example/make-media.mjs` | Regenerates `media/clip.mp4` with a locally installed ffmpeg (libx264); `--check` probes and decodes it |

Run them from the repository root with `npm run test:example` (Node 22 or newer; the browser test skips itself when
Playwright is missing).

## Limits worth knowing

- A message is at most 280 characters; a display name at most 48; the notice at most 1,000
  characters and 2,000 bytes as JSON (the ledger allows 2,048 bytes per value).
- Posting computes a 16-bit proof-of-work in a worker, so the Post button shows "Signing..." for a
  moment. It is a spam fee, not security.
- The loader accepts at most 20 writes per minute from a page; going over shows "You are posting too
  fast" (`E_RATE`). Peers also throttle incoming entries per author (30 per 10 minutes by default), so
  a burst of posts takes longer to spread.
- Everything written to the guestbook is public and copied to every visitor. Deleting an entry hides
  it for visitors who receive the deletion. Copies on devices that never sync again stay where they are.

## Compatibility

Plain ES modules, `fetch`, `crypto.subtle` (for short ids, with a fallback), no `innerHTML`, no
top-level `await`, no import maps, nothing newer than the loader's floor (Safari and iOS 15.4,
Chromium 110, Firefox 115). Inputs are 16 px so iOS Safari does not zoom, tap targets are at least
44 px, and `env(safe-area-inset-*)` keeps content clear of notches. On touch screens the toasts sit at
the top and the footer keeps extra room, because the loader's status bar sits at the bottom there.
