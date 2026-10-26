# example agent: notes and deviations (examples/peer-guestbook/, v0.2)

Agent: `example`. Owned paths: `examples/peer-guestbook/*`. Date: 2026-10-17. Supersedes the v0.1 notes that were in
this file (the v0.1 site used relative URLs, the `notice` key and a 404 page that parsed `/_mw/s/` paths).

## Files

| File | State |
|---|---|
| `examples/peer-guestbook/index.html` | Rewritten: Live card (peers, posts, ledger line, sharing line, how the page arrived), You card (id, role badge, display name), owner notice (`_notice`), guestbook, moderation panel, files card with the MP4 |
| `examples/peer-guestbook/about.html` | Rewritten: second page, v0.2 explanation using DESIGN-REVIEW section 4 strings |
| `examples/peer-guestbook/404.html` | Rewritten: plain static page, no script, root-relative stylesheet and links |
| `examples/peer-guestbook/css/app.css` | Updated: badges, facts list, media, bidi isolation of visitor text, touch-screen toast and footer rules |
| `examples/peer-guestbook/js/app.js` | Rewritten for the section 9 SDK: 347 lines, `textContent` only |
| `examples/peer-guestbook/data/about.json` | Updated (v2.0.0, section 4 wording) |
| `examples/peer-guestbook/media/clip.mp4` | New: 18,833 bytes, sha256 `81045124d22c374964a3746d88e7c15231391378e1587ccbda29ffb0f3245b92` |
| `examples/peer-guestbook/img/peer.png` | Unchanged from v0.1 (validated by the tests) |
| `examples/peer-guestbook/README.md` | Rewritten, with the publish note |
| `examples/peer-guestbook/.dev/check-html.mjs` | New: dependency-free HTML checker (CLI and library) |
| `examples/peer-guestbook/.dev/site.test.mjs` | New: static test suite (14 tests) |
| `examples/peer-guestbook/.dev/browser.test.mjs` | New: Playwright smoke suite (14 tests, Chromium and WebKit) |
| `examples/peer-guestbook/.dev/mock-sdk.js` | New: in-memory section 9 SDK used only by the browser suite |
| `examples/peer-guestbook/.dev/make-media.mjs` | New: regenerates or checks `media/clip.mp4` with a locally installed ffmpeg |

## Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test "examples/peer-guestbook/.dev/*.test.mjs"        # 29 pass, 0 fail, 0 skipped (about 4 s):
                                                       # 14 static + 14 browser + the browser suite node
    node examples/peer-guestbook/.dev/check-html.mjs              # 3 pages, 209 elements, 0 errors

HTML checker counts: `index.html` 113 elements, 36 distinct tags, 41 ids, 8 URLs; `about.html` 78 elements,
28 tags, 10 ids, 7 URLs; `404.html` 18 elements, 11 tags, 0 ids, 4 URLs; no inline scripts or styles. The
checker's own negative cases (24 broken documents: misnesting, block in `<p>`, duplicate id, missing alt,
inline handler, `&mdash;`, non-ASCII, single quotes, dangling `for`, stray tags, unclosed elements,
`target=_blank` without noopener, untyped button, bare `<` and `&`, style attribute, `javascript:` URL,
two `<h1>`, unlabelled input, button inside a link, `<div/>`, missing doctype) are part of the suite.

Two browser assertions were mutation-checked against a scratch copy: removing the render de-duplication
makes "an unrelated snapshot must not reset a half-confirmed button" fail, and removing the malformed-item
filter makes the list freeze in the writer test. The tests also pass when copied to `test/unit/` next to
`examples/peer-guestbook/` (they locate the site from either place; `MW_EXAMPLE_DIR` overrides).

## Deviations, with reasons

1. **Tests and tools live in `examples/peer-guestbook/.dev/`, not `test/unit/`.** My ownership is `examples/peer-guestbook/*`
   only. A dot-directory keeps them out of the torrent under ARCHITECTURE section 10's ignore list
   ("dotfiles"), provided `publish.mjs` treats dot-directories as dotfiles (see notes). The integrator can
   leave them there or copy them to `test/unit/`; both layouts work unchanged.
2. **The MP4 was made with a locally installed ffmpeg (Homebrew 9.0.2, libx264), not by a Node script.**
   The brief allowed a WAV substitute only if no valid MP4 could be produced; none was needed. Nothing was
   installed into the repository, and the clip is committed. `.dev/make-media.mjs` records the exact
   arguments and regenerates it bit for bit on the same ffmpeg (verified twice: identical sha256);
   `--check` probes and fully decodes it. Validation: ffprobe and a full ffmpeg decode (48 of 48 frames),
   Apple AVFoundation, the media stack Safari uses (scratch Swift tool: playable, 4.0 s, 320x180, 48 frames
   decoded), and Playwright Chromium 156 and WebKit 27.2 (metadata, then a seek to 2.5 s, every request a
   206). Clip: H.264 Constrained Baseline level 3.0, 320x180, 12 fps, 4 s, a keyframe every second, `moov`
   before `mdat`, no audio track, SEI removed so no encoder banner or URL is inside the file.
3. **Role is refreshed after `ready()`.** The notice editor shows for `owner` and `moderator` as the brief
   says, but the role is re-evaluated on every snapshot: `snap.role` if the SDK ever adds it, otherwise
   `ready().role` adjusted by `snap.policy` (this identity in `moderators` makes it a moderator, in `banned`
   a reader; `writers: 'owner'` turns a writer into a reader and `'open'` a reader into a writer). A missing
   `role` (an older SDK) counts as `writer`, because the ledger enforces the policy anyway and the
   alternative locks the forms. Reason: a policy block can arrive while the page is open.
4. **Ledger line format.** `Ledger: 1,204 entries, in sync with 3 peers` with en-US thousands separators and
   singular forms (`1 entry`, `1 peer`). `inSync` is read as a count; a boolean means all connected peers
   (true) or none (false); when the snapshot has no `inSync` the "in sync" part is left out instead of
   claiming zero. A `sync` push event with `height`, `peers` or `inSync` updates the line too.
5. **Notice limit** is 1,000 characters and 2,000 bytes of JSON (v0.1 allowed 2,000 characters, which can
   exceed v0.2's `maxValueBytes` of 2,048 bytes with non-ASCII text). The key moved from `notice` to
   `_notice` as specified; old `notice` values are not read.
6. **Re-render only on visible change.** The list is rebuilt only when posts, names, role or moderators
   change, so an unrelated snapshot (peer count, ledger height) does not reset a half-confirmed
   Remove/Ban button or steal focus. Destructive actions keep the v0.1 two-tap confirm instead of
   `confirm()` (no `allow-modals` in the shell sandbox).
7. **No drop-in script tag.** The pages do not include `/_mw/mw.js`: the example is a shell-mode site, and
   that script inside the shell's frame would start a second engine. Drop-in is covered by the dropin
   agent's fixture.

## Notes for the integrator and the other agents

- **Imports and URLs.** The only loader path the site uses is `import('/_mw/sdk.js')` (dynamic; takes
  `default`, falls back to `globalThis.mw`). Site URLs: `/`, `/about.html`, `/css/app.css`, `/js/app.js`,
  `/img/peer.png`, `/media/clip.mp4`, `fetch('/data/about.json')`. Nothing under `/_mw/`, `/mw-sw.js`,
  `/ws/` or `/.mw/` exists in the site (tested).
- **SDK surface used** (section 9): `ready()` fields `identity.{pub,short,name}`, `role`, `peers`, `height`,
  `owner`, `unmoderated`, `siteId`, `btih`, `mode`; `db.subscribe`, `db.list('guestbook', { limit: 200,
  newestFirst: true })` and `db.get('_notice')` once at start (first paint when no snapshot is replayed),
  `db.append('guestbook', { msg })`, `db.set/del('_notice')`, `db.tombstone(h)`, `mod.ban(pub)`,
  `identity.setName`, `site.info()`, `consent.state()` (sync or async), `net.on('peers'|'progress'|'status'|'sync')`.
  Tolerated: `mw.consent` or `mw.mod` absent, `net.on` throwing for unknown events, `peers` pushed as a number
  or `{ count }`, kv entries as plain values or `{ v, author, h, ts }` records, `kv`/`lists`/`profiles` as
  objects or Maps, list items oldest first (the page reverses them). `consent.state()` is called at most once
  per 500 ms (after `status` events and on becoming visible).
- **Publish** (README): `node tools/publish.mjs examples/peer-guestbook --name peer-guestbook --scope <host> --key owner.jwk
  --policy open --bits 16 ...`. Tools agent: (a) the ignore list must skip dot-directories such as
  `examples/peer-guestbook/.dev/` as well as `README.md`; the expected torrent content is exactly `404.html`,
  `about.html`, `css/app.css`, `data/about.json`, `img/peer.png`, `index.html`, `js/app.js`, `media/clip.mp4`
  (plus `/.mw/*`); (b) please default the routing manifest's `notFound` to `404.html` when that file exists
  (GitHub Pages / Netlify convention); the page has no script and works at any depth.
- **E2E hooks.** Index ids: `peers`, `posts`, `ledger`, `sharing`, `source`, `transfer`, `site-meta`,
  `role-badge`, `me-short`, `name-form`/`name`, `notice`, `notice-form`/`notice-input`/`notice-btn`,
  `post-form`/`msg`/`count`/`post-btn`/`post-note`, `entries`, `entries-empty`, `mod-card`, `role-line`,
  `role-help`, `mod-howto`, `unmoderated`, `unmoderated-note`, `pol-writers`/`pol-fee`/`pol-mods`/`pol-banned`,
  `clip`, `standalone`/`standalone-why`, `toasts`. Each post is `#entries li` with `data-h` (block hash) and
  `data-author` (pub); buttons `.act-delete` (own), `.act-remove` and `.act-ban` (moderators; no Ban on the
  owner's or moderators' posts); the first click shows "Tap again to confirm", the second acts. Newest post
  first. `h1` is exactly "Peer Guestbook" (the unmoderated badge sits outside it).
- **Exact strings** a test may match: the ledger line above; sharing line "Sharing only while this page is open
  and on screen." on touch devices, "Host only: no peer connections. Slower, and shared data won't sync.",
  and for desktop "While this tab is open your browser connects to other visitors and, unless sharing is off,
  passes on files and posts."; `#source` "The files of "<name>" arrived <how>. Each one is checked against
  infohash <12 hex>... before it is used."; standalone `#standalone-why` "The loader SDK at /_mw/sdk.js is not
  served here." or the `E_NO_HOST` sentence "This page is not running inside the magnet-web loader.".
- **MP4 in E2E (1).** Playwright's Chromium 156 on macOS reports `canPlayType('video/mp4; codecs="avc1.42E01E"')`
  as "probably" and plays the clip; Linux builds may lack H.264, so assert the Range path directly
  (`fetch('/media/clip.mp4', { headers: { Range: 'bytes=0-1' } })` gives 206 and `Content-Range: bytes
  0-1/18833`) or use WebKit for playback. iOS playback and seeking remain a manual release-gate item.
- **Node 24 and directories.** `node --test test/unit` (a directory argument) fails on Node 24.22 with "Cannot
  find module .../test/unit" (checked on this repo). Use a glob in package.json, for example
  `node --test "test/unit/*.test.mjs"`.
- If the clip is ever regenerated, update `CLIP_SHA256` in `.dev/site.test.mjs` (the test says so).

## package.json scripts requested (tools agent owns package.json)

    "test:example": "node --test \"examples/peer-guestbook/.dev/*.test.mjs\"",
    "check:example": "node examples/peer-guestbook/.dev/check-html.mjs"

`test:example` launches Chromium and WebKit for about 4 s; if `test` must stay browser-free, run only
`examples/peer-guestbook/.dev/site.test.mjs` there and the browser file under `test:e2e`.
