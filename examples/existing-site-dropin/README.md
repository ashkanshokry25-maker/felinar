# existing-site-dropin: a site that already exists

A small multi-page static site, written the way most existing sites are written, used to test drop-in
mode (ARCHITECTURE section 3.4): the one script tag a site adds, `<script type="module"
src="/_mw/mw.js" async></script>`, and nothing else. Every page already carries that tag. The host
keeps serving every file as a plain static file; `tools/publish.mjs --dropin` stamps the pointer into
each page and lays out the runtime. The pages keep this minimal tag on purpose, so `publish` warns that it
lacks `data-cfasync="false"`; a real site uses the full tag from [MIGRATION.md](../../docs/MIGRATION.md), which
keeps Cloudflare's Rocket Loader from rewriting it.

Nothing here is a mock of felinar. The fixture is plain HTML, CSS and JavaScript plus the two host
files (`_redirects`, `_headers`) a Netlify or Cloudflare Pages site has, so what it proves about drop-in
is what a real migration would see.

**v0.3.** The folder `with-widgets/` is the same kind of site after its owner added the two widgets of the v0.3
design (V03-DESIGN-REVIEW 2.3.6 and 3.8): the **`<mw-signin>`** button, whose proof the forum's own server checks, and the
**`<mw-chat-panel>`**, a Lobby and direct messages for signed-in visitors. See [The widgets variant](#the-widgets-variant-v03)
for the owner steps.

## What each file proves

| File | What it proves |
|---|---|
| `index.html` | Root-relative assets (`/css/...`, `/js/...`, `/img/...`), a `fetch('/data.json')`, an image used twice (an `<img>` and a CSS `url()`), a lazily loaded chunk behind a button, `<noscript>` text for JS-off comparisons, nav links of every kind (page, SPA route, redirect). |
| `about.html` | A second page that asks for the same URLs: the second page view must find them in the local copy. |
| `blog/post-1.html` | A page two levels deep: root-relative assets still resolve, a page-relative link (`../about.html`) still works, `location.pathname` is `/blog/post-1.html`. |
| `app.html` | A History-API router (`/app/`, `/app/settings`, `/app/items/<n>`) that needs the host's SPA fallback: `_redirects` rewrites `/app/*` to `app.html` with status 200. A deep link, a reload and back/forward must all keep working, and `location.pathname` must be the address-bar path. |
| `404.html` | The host's 404 page: drop-in leaves a 404 status alone. |
| `css/app.3f2a1b.css`, `js/app.9c0d2e.js`, `js/chunk.5e7f1a.js` | Content-hashed file names: unchanged files keep their URL across deploys (so the HTTP cache and a new copy can reuse them). |
| `data.json` | The un-hashed file that really changes between deploys (`Cache-Control: no-cache`): it is the case where a stale HTTP-cache entry could poison a new version's copy. |
| `img/logo.png` | A binary asset requested from HTML and from CSS. |
| `_redirects` | `/app/*  /app.html  200` (SPA fallback) and `/old-about  /about.html  301`. |
| `_headers` | `X-Fixture-Host` on every response (documents keep the host's headers), immutable caching on `/css/*` and `/js/*`, `no-cache` on `/data.json`. |
| `with-own-sw/` | A site root whose own hand-written Service Worker (`sw.js`) has a cache-first route for `/css/*` and a stats endpoint (`/__own-sw/stats`). Drop-in must not register `/mw-sw.js` over it. |
| `with-own-sw-integrated/` | The same worker with the two-line integration of ARCHITECTURE 3.4.4: `importScripts('/_mw/sw-core.js')` first, `if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event))` at the top of the fetch handler. |
| `with-widgets/` | The Example Forum (v0.3): `index.html` carries the drop-in tag, the two self-hosted widget tags with their `integrity=` hash, `<mw-signin>` and `<mw-chat-panel>`; `js/forum.js` mirrors what the button reported on `window.__forum`; `_headers` sends `Cross-Origin-Opener-Policy: same-origin-allow-popups`. The page is a template: the hashes are filled in by `stage()`. |

`window.__fixture` mirrors what the page script did (`page`, `jsRan`, `pathname`, `data`, `route`,
`routeId`, `chunk`, `errors`), so end-to-end tests assert on values instead of scraping text.
`window.__ownSw` does the same for the Service Worker variants.

## The widgets variant (v0.3)

A site that already has accounts (or none) can offer "Sign in with felinar" and a chat among its signed-in visitors
without leaving its host. Both parts are files the owner serves from the site's own address, each with a hash; no
shared widget host sees which sites use them (R 2.3.6, SC-7).

**Owner steps** (the commands in V03-DESIGN-REVIEW 3.8):

```sh
node build.mjs                                     # builds dist/_mw/signin.js and dist/_mw/chat-panel.js
node tools/publish.mjs <your site> --name forum --scope forum.example.com --key owner.jwk \
  --dropin --chain forum-chat --signin-widget --chat-panel \
  --tracker wss://tracker.example.com --stun stun:stun.example.com:3478 --out dist-forum
```

1. `--dropin --chain forum-chat` publishes the pages as drop-in pages and gives the site a ledger of its own (the panel's chat lane
   needs one; on a drop-in site without a ledger the panel says it is unavailable). Chat is also off in that ledger until you switch it on, with the
   owner key and offline: `node tools/ledger-admin.mjs cfg --key owner.jwk --file dist-forum/genesis.json --chat open`, then pass the URL of that
   file as `--cs` when you publish again, so a visitor who finds nobody online still gets it. (`--chat-panel` only checks that you named your own
   tracker and STUN servers; it does not write the switch.) Use `open`, not `members`: the forum's visitors read its ledger but do not write
   to it (its posts live on the forum's own server), and `members` lets only the ledger's writers chat, which here means its owner and moderators.
2. `--signin-widget --chat-panel` (add `--signin-statement "Sign in to Example Forum"` to get the sentence of this page; the default is "Sign in to <scope>") copy the two files into `dist-forum/site/_mw/` and print, and write to
   `dist-forum/widget/tags.html`, the tags to paste into your pages. They look like the ones in
   `with-widgets/index.html`, with the real hash:

   ```html
   <script type="module" src="/_mw/signin.js" integrity="sha384-..." crossorigin></script>
   <mw-signin statement="Sign in to Example Forum" challenge-url="/auth/mw/challenge" proof-url="/auth/mw/verify"></mw-signin>
   <script type="module" src="/_mw/chat-panel.js" integrity="sha384-..." crossorigin></script>
   <mw-chat-panel></mw-chat-panel>
   ```

   Update the `integrity=` value whenever you update a widget file. `--tracker` and `--stun` are required whenever chat is on
   (`--chat-panel` implies the chat check): publish refuses without the site's own servers, because the shared public trackers would
   learn which sites chat.
3. Add the lines of `dist-forum/csp.txt` to your Content-Security-Policy, if the site sends one: `script-src 'self'` (both
   widgets are module scripts on your own origin), `worker-src 'self'`, and your tracker in `connect-src`. Send
   `Cross-Origin-Opener-Policy: same-origin-allow-popups` on the pages with the button, never `same-origin`, or the identity
   window cannot reach the page that opened it (`with-widgets/_headers` does).
4. The button needs two routes on your server, `GET /auth/mw/challenge` and `POST /auth/mw/verify`, that check the proof with
   [`@felinar/verify`](../../packages/verify/README.md): [signin-server-node.md](../../docs/recipes/signin-server-node.md) has the
   code. A static site with no server has nobody to check a proof; the chat panel does not need one, because it signs
   the visitor in with `mw.auth.signIn()` and uses the key the visitor has for this site, not a proof for your server.
5. Tell your visitors what the button's card says: "Scripts on this page can act as you on this site while you are signed in. They
   cannot reach your other sites." ([signin-widget.md](../../docs/recipes/signin-widget.md) is the page-by-page recipe.)

What a visitor sees: one button inside a closed shadow root and that sentence under it; the identity page opens in its own window
and shows your `statement` word for word; the panel offers Sign in, then "Turn on chat" (a card the loader shows, not the panel,
names the tracker and what it can see), then the Lobby and Messages. The widgets never hold, ask for or show a recovery phrase,
a passphrase or a file, and neither does the page script.

**In a test**, `stage('with-widgets', dir, { widgets: { dist: 'dist', tracker: '127.0.0.1:8000', stun: '127.0.0.1' } })`
fills the placeholders with the hashes of the built files, exactly as `publish` computes them, and
`startSigninServer({ staticDir })` from [`test/fixtures/signin-server/server.mjs`](../../test/fixtures/signin-server/server.mjs) is the
forum's server: it serves the published `site/` folder with the opener-policy header and answers the two routes with
`@felinar/verify`. The end-to-end assertions are items 11 to 20 of `EXPECTED.md`.

## Try it by hand

Everything stays on this computer. From the repository root, after `npm ci` and `npm run build`:

```sh
node tools/keygen.mjs --out .tools/preview-owner.jwk
node tools/publish.mjs examples/existing-site-dropin --name existing-site --scope localhost \
  --key .tools/preview-owner.jwk --dropin --tr ws://127.0.0.1:8000 --out .tools/preview
node tools/tracker.mjs --port 8000 --allow .tools/preview/summary.json &
node tools/dev-server.mjs --root .tools/preview/site --port 8080 &
node tools/check-site.mjs http://localhost:8080/ --headless --consent
```

Then open `http://localhost:8080/` in two browsers (use `localhost`, not `127.0.0.1`: the pointer is signed for
the hostname) and follow [QUICKSTART.md, step B5](../../docs/QUICKSTART.md#b5-check-it). The dev server doesn't
read `_redirects`, so `/app/...` and `/old-about` answer 404 there; the test host below honours them. Stop
the two background processes with `kill %1 %2`.

## Using it in a test

The helpers live in `test/fixtures/existing-site-dropin/`, outside this folder, so this folder holds only the
site. From a file in `test/unit/` or `test/e2e/`:

```js
import { stage } from '../fixtures/existing-site-dropin/stage.mjs'
import { createHost } from '../fixtures/existing-site-dropin/host.mjs'
import { publish } from '../../tools/publish.mjs'

const v1 = stage('main', dir1)                          // the site root, ready for publish
const v2 = stage('main', dir2, { version: 2 })          // the same site after a redeploy
const plain = stage('main', dir3, { plain: true })      // without the /_mw/mw.js tag (the "before" site)
const own = stage('with-own-sw', dir4)                  // or 'with-own-sw-integrated'
const forum = stage('with-widgets', dir5, { widgets: { dist: 'dist' } })   // the Example Forum with the real widget hashes

const pub = await publish({ dir: v1.dir, name: 'existing-site', scope: '127.0.0.1', key, dropin: true, dist: 'dist', out, tr: [trackerUrl] })
const host = await createHost({ root: join(pub.outDir, 'site') })     // http://127.0.0.1:<port>/
host.requests                       // [{ method, path, status, range }]: the network log
host.redeploy(join(pub2.outDir, 'site'), { keepOld: true })           // a newer deploy; old files stay (hosts keep them for days)
host.down(true)                     // an outage
```

- `stage.mjs` copies the files of a site root (never the variants or the notes)
  and applies the options. `version: 2` renames `css/app.3f2a1b.css` to `css/app.8d1e44.css` and
  `js/chunk.5e7f1a.js` to `js/chunk.b63d90.js`, changes `data.json` under the same URL, and leaves
  `js/app.9c0d2e.js` and `img/logo.png` byte for byte the same.
- `host.mjs` is a small static host: `_redirects` (including the SPA rewrite), `_headers`,
  `404.html` with status 404, `Range`, `Cache-Control: no-cache` by default, a request log, outages and
  redeploys. `tools/dev-server.mjs` serves files but does not read `_redirects`, which `app.html` needs.
- `widgetIntegrity(distDir)` in `stage.mjs` is the hash `publish --signin-widget` prints for a built widget file (sha384 of the
  bytes, base64). Without `dist`, `stage('with-widgets')` leaves the placeholder `sha384-REPLACE-WITH-THE-HASH-PUBLISH-PRINTS`
  in the page, and a browser would refuse to run the widget until it is filled.
- `README.md` at this level is ignored by `publish.mjs`; `EXPECTED.md` is not copied by `stage()`.

## Checked by

`test/unit/dropin-fixture.test.mjs` (no browser): the staged layouts, every root-relative reference of
every page, the router and data script in a sandbox, both worker scripts in a fake worker scope, the
host emulator, and the whole chain fixture, `publish --dropin`, stamped pages, `src/dropin/stamp.js`.
The assertions that need a browser are listed in `EXPECTED.md`.

`test/example/dropin-widgets.test.mjs` (no browser) checks the widgets variant: the staged layout, the hashes against the files they
name, the tags against what `publish` prints, the page's server routes against `@felinar/verify` (the real `<mw-signin>` flow, run with
a fake identity page, against `startSigninServer`), the headers, and that `EXPECTED.md` lists items 11 to 20.
