# existing-site-dropin: the end-to-end assertions

What `test/e2e` must check against this fixture (ARCHITECTURE section 12 item 10, DESIGN-REVIEW item
23 acceptance). Every assertion below was run by hand once against Playwright's Chromium 156.0.8078.4
and Playwright WebKit 27.2 (both on 127.0.0.1 only) while the drop-in runtime was written; the
observations are in brackets, and anything marked "unit-tested" was not run in a browser. Setup
for all of them: `stage()`, `publish --dropin` with `--scope 127.0.0.1`, `createHost()` (see README.md),
Chromium launched with `chromiumArgs()` from `test/e2e/browser-args.mjs`, WebKit only against
`http://127.0.0.1`. Diagnostics: `await page.evaluate(() => window.__mwDropin.inspect())` returns
`{ state, off, btih, leader, consent, sw: { mode, controlled }, copy: { btih, files, fromCache }, source, announce, peers, logs, ... }`.

## The five acceptance checks (item 23)

1. **JavaScript off is identical to the host.** Two contexts with `javaScriptEnabled: false`: one on the
   published drop-in site, one on `stage('main', dir, { plain: true })` served by `createHost()`. For `/`,
   `/about.html`, `/blog/post-1.html`, `/app/settings` (the SPA rewrite), `/nothing-here` (404) and `/old-about`
   (301 to the about page): same status, same `X-Fixture-Host` header, same `document.body.innerText`,
   byte-identical full-page screenshots. [All six identical.]
2. **The second page view is served from IndexedDB, and versions are never mixed.**
   - First view of `/`, wait for `inspect().copy` (about 0.5 s on loopback), `source === 'webseed'`.
     Clear the log (`host.clearLog()`), load `/about.html`: `inspect().copy.fromCache === true`, and the
     host's request log has `/about.html` and `/mw-sw.js` only, no `/css/`, `/js/`, `/img/` or
     `/data.json`. [Chromium and WebKit: exactly that.]
   - Redeploy: publish `version: 2` with a higher `seq`, `host.redeploy(..., { keepOld: true })`. A v1
     page that is still open loads its lazy chunk: `window.__fixture.chunk === 'v1'`. A new page on v2
     loads its chunk: `'v2'`, and `data.json` shows `version 2`. A page never shows a mix.
   - With the v1 tab still open it is the leader, so the v2 tab is a follower and gets no copy of its
     own (`inspect().leader === false`, `copy === null`); it works from the host. Close the v1 tab: the v2
     tab is promoted, refreshes the changed files (`logs` has "refreshed 4 changed file(s)"), downloads
     v2, and IndexedDB `mw-sites.sites` holds only the v2 infohash afterwards (v1 was deleted because no
     client renders it). [The host log in that step: `/.mw/files.json`, the new CSS, `/data.json`, the new
     chunk, `/.mw/site.json`, the new torrent; not `js/app.9c0d2e.js` or the logo.]
3. **A site with its own Service Worker keeps it.** `stage('with-own-sw')`: `__ownSw.registered`,
   `navigator.serviceWorker.getRegistrations()` has exactly one registration and it is `/sw.js`; the host
   never sees a request for `/mw-sw.js`; `inspect().sw.mode === 'foreign'`; each page load logs exactly one
   `info` line containing `importScripts('/_mw/sw-core.js')` and `self.mw.owns(event)`; the site worker keeps
   serving its own route: `/__own-sw/stats` after the first view is `{ cssHits: 0, cssMisses: 0 }` (the
   worker claims the page after load, so the first view's CSS came from the host), after the second view
   `cssMisses: 1` (the first controlled request fills its cache), after the third `cssHits: 1`. [Chromium:
   exactly those numbers, one registration (`sw.js`), no `/mw-sw.js` request.] With
   `stage('with-own-sw-integrated')`: `inspect().sw.mode === 'integrated'` on the first view, no recipe line
   in the console (the site already did the integration), and `source === 'webseed'` (the copy came through
   the site's worker). Known limit: a site worker never sees
   the navigation response, so the page's earliest subresources (those requested before `mw-map-client`
   arrives) still come from the host; later requests (lazy chunks, `fetch` calls after load) come from
   IndexedDB. [Second view on the integrated variant: css, app js, data.json and the logo still went to
   the host; see docs/deviations/dropin.md.] `data-mw-sw="off"` on the script tag: no registration,
   `inspect().sw.mode === 'off'`, an earlier registration of ours is removed and its `mw-shell-*` caches are
   deleted. (Unit-tested in `dropin-swreg` and `dropin-engine`; not run in a browser.)
4. **`location.pathname` is correct everywhere.** `/blog/post-1.html` shows `/blog/post-1.html` in
   `#path`; `app.html` at `/app/items/42` (a first request answered by the rewrite) has
   `__fixture.route === 'item'`, `routeId === 42`; clicking "Settings" gives `/app/settings` and route
   `settings` without a page load; reload keeps it; `goBack()` returns to `/app/items/42`.
   [All as listed, with a copy in IndexedDB.]
5. **The kill switch restores host-only serving, once, without a reload loop.** After the first views
   (so `sw:registered` is stored), overwrite `<root>/mw-sw.js` with `dist/mw-sw-kill.js` (the worker clears
   `mw-*` caches, unregisters itself and navigates the open pages) and load a page. Expected: exactly one
   extra navigation (the kill switch's reload), then no more: `getRegistrations()` is empty,
   `navigator.serviceWorker.controller === null`, `caches.keys()` is empty, the page renders from the
   host's plain response, `inspect().sw` is `{ mode: 'none', reason: 'kill-switch' }`, and the console has
   one `console.warn` line telling the owner to remove the `/_mw/mw.js` tag. The pages still carry that
   tag, so on every later view the engine asks the host for `/mw-sw.js` (`cache: 'no-cache'`, only when
   this browser registered ours before and no registration exists), recognises the kill switch
   (`looksLikeKillSwitch`) and does not register it again. [Chromium: 2 navigations while settling, 0 in
   the next 5 s, registrations `[]`, one extra `GET /mw-sw.js` per later view. Without the guard the page
   registered the kill switch again on every view and reloaded forever; that is the regression to catch.]
   A browser that never registered ours here (no `sw:registered`) registers the kill switch once and is not
   reloaded: since integration-2 the kill switch reloads only pages an earlier worker controlled, and this
   page came from the host already [Chromium: 1 navigation; the second view reports `kill-switch`, one
   warning, one `GET /mw-sw.js`, no registration]. The same rule stops the reload loop of a shell host that
   keeps serving the shell after deploying the kill switch (test/e2e scenario 9).
   Unit-tested in `dropin-swreg` (`looksLikeKillSwitch`, `precheck`) and `dropin-engine`;
   a `mw-reload` message (when `WindowClient.navigate` is missing) reloads the page once. Lighthouse
   LCP and CLS within 5% of `{ plain: true }` is a manual release-gate item (docs/DEMO-RESULTS.md): the
   runtime is an `async` module script and the notice is `position: fixed`.

## Consent, sockets and peers

6. **Nothing reaches a tracker before consent and 3 s of visible time.** With `--tr <local tracker>`:
   `tracker.stats()` shows 0 torrents before consent; after a real click on the card's "Share and load" and
   3 s visible, 2 (the site torrent and the ledger rendezvous swarm, v0.2.1 B2). A hidden tab never reaches the gate
   (`inspect().visible === false`). [Observed: 0 before, 2 after.]
7. **The first-run card.** After 3 s visible the card (v0.2.1 C1: [Share and load] [Load from host only]
   [Settings] on one layer; the blocking gate instead when the pointer says `consent=gate` or its `aud=`
   names personal data or an EEA, UK or Quebec audience) sits at the bottom, in a closed shadow root
   (`document.querySelector('[data-mw-ui]').shadowRoot === null`). To click inside it use
   `window.__mwDropin.rectOf('Share and load')` (the frozen public handle has `version`, `started`, `inspect()`,
   `openSettings()` and `rectOf()`; it has no `engine` since code review round 1) and
   `page.mouse.click(x + width / 2, y + height / 2)`
   (works in Chromium and WebKit; keyboard Tab works in Chromium but Safari does not Tab to buttons).
   `data-mw-consent="site"` on the script tag shows no notice until the site calls `mw.consent.request()`
   (v0.2.1: the site can only open the loader's card; the visitor decides there, `mw.consent.accept()` is gone).
8. **Peers deliver the copy.** Context A builds the copy and consents; context B with
   `navigator.connection` overridden to `{ type: 'cellular' }` (an init script) has no web seed
   (`logs` "web seed off (metered)") and, after consent, completes the copy from A: `source === 'peers'`,
   `peers >= 1`. [About 0.5 s on loopback.]
9. **Back/forward cache.** `pagehide` closes the tracker sockets, peers, ledger, channel and Web Lock
   (`inspect().suspended === true`); a persisted `pageshow` starts the engine again and announces after
   another 3 s. Headless Chromium disables the back/forward cache (`BackForwardCacheDisabledForDelegate`),
   so this is covered by unit tests and a headed manual check in the release gate.
10. **Fails open.** A page with no `<meta name="mw-pointer">` (for example `stage()` output that was not
    published): one `console.warn` mentioning `mw-pointer`, `inspect().off === 'no-stamp'`, the page works,
    `mw.db.set` rejects with `E_IDENTITY`. A stamp for another host (`--scope other.example`):
    `inspect().off === 'pointer:bad-sig'`.

## Variants and extra data

- Versions: `stage('main', dir, { version: 2 }).changes` lists `changed`, `renamed` and `unchanged`.
- `host.down(true)` after viewing `/`, `/about.html` and `/blog/post-1.html`: the two visited pages still
  load (status 200, their CSS and script from the worker's IndexedDB copy of the site, the HTML document
  from the page the worker kept in IndexedDB when it was first fetched; the worker keeps at most 100
  documents and none sent with `Cache-Control: no-store`), while `/app/settings` and `/never-visited.html`
  get the worker's own 503 "You're offline" page. [Chromium, as listed.] Drop-in does not keep the site
  up for URLs the visitor never saw.

## The widgets variant (v0.3: V03-DESIGN-REVIEW 2.3.6 and 3.8)

These are the checks for `stage('with-widgets')`, the Example Forum. They were written with the widgets and **were not run in a
browser by the example's author**: the parts that need no browser (the staged layout, the hashes, the printed tags, the server routes and
the widget's own flow against `startSigninServer`) run in `test/example/dropin-widgets.test.mjs`; the steps below that open a window are the
integrator's E-SI-1 and E-CH-* scenarios. Setup for all of them: `npm run build` (so `dist/_mw/signin.js` and `dist/_mw/chat-panel.js`
exist), `stage('with-widgets', dir, { widgets: { dist: 'dist', tracker: '127.0.0.1:8000', stun: '127.0.0.1' } })`, then
`publish --dropin --chain forum-chat --signin-widget --signin-statement "Sign in to Example Forum" --chat-panel --tracker ws://127.0.0.1:8000 --stun stun:127.0.0.1:3478 --scope 127.0.0.1`,
then chat is switched on in the ledger (`--chat-panel` only checks the tracker and STUN; the switch is `_mw.cfg.chat`): `ledger-admin cfg --chat open` on `<out>/genesis.json`, served at the `--cs` of a second publish
(`open`: the forum's visitors are readers of its ledger, and `members` would let only its writers chat). The v0.3 final integration runs checks 11, 13 to 15, 17, 18
and 19 in a browser: `test/e2e/scenarios-dropin-v03.mjs`, scenarios E-SI-1W and E-CH-R.
Then the forum's server: `startSigninServer({ staticDir: join(pub.outDir, 'site') })` from `test/fixtures/signin-server/server.mjs` (the same
origin serves the pages, the two widgets and the two routes). The identity origin is the test build of `src/idp`, on its own loopback port.
Chromium is launched with `chromiumArgs()` and WebKit only against `http://127.0.0.1`.

11. **The widgets are the owner's own files, with their hashes.** `<out>/site/_mw/signin.js` and `chat-panel.js` exist and are byte for byte
    `dist/_mw/*`. The page's two script tags carry `integrity="sha384-..."` equal to the base64 sha384 of those bytes, which is what `publish`
    printed and wrote to `<out>/widget/tags.html`. Loading the page requests `/_mw/signin.js` and `/_mw/chat-panel.js` from the page's own origin
    and from no other. Change one byte of a served widget: the browser refuses it (console: an integrity error) and
    `customElements.get('mw-signin')` is `undefined`; the rest of the page still works.
12. **JavaScript off is still the host's page.** As check 1, on `/` of the widgets variant: `javaScriptEnabled: false`, the published site against
    `stage('with-widgets', dir, { plain: true })` (no drop-in tag, no widgets): same status, same `X-Fixture-Host: example-forum`, same
    `document.body.innerText` (the two widgets render nothing; the `<noscript>` line is the same text).
13. **The button.** With JavaScript on, `document.querySelector('mw-signin').shadowRoot === null` (closed). Clicking the middle of the element
    (`page.locator('mw-signin').click()`) is a click on the button inside it. The page shows the sentence "Scripts on this page can act as you on
    this site while you are signed in. They cannot reach your other sites." under the button. (A test cannot look inside a closed root; the widget's own
    unit tests check that it holds one button and text and no field.)
14. **Sign in end to end.** One click: the host log shows `GET /auth/mw/challenge`; a popup opens (`context.waitForEvent('page')`) and is the identity
    page; its card names the forum's origin and shows "Sign in to Example Forum" word for word; after the person approves, the log shows
    `POST /auth/mw/verify` whose body is the proof text (it starts with `{"c":`), the answer is 200 with `{ ok: true, pub, keyMode: 'pairwise' }`, and
    `window.__forum.events` is `['pending', 'signed-in']`, `window.__forum.pub` is the key the card showed, and `#signin-status` begins "Signed in as p256:".
15. **One use per challenge, one click per ten seconds.** Posting the same proof text to `/auth/mw/verify` again answers 401 with `reason: 'replay'`. A second
    click within 10 seconds ends `window.__forum.events` with `error:E_RATE` and sends no new request. The same page served from a second origin (another
    port) cannot use a proof made for the first: the server answers 401 with `reason: 'origin'`.
16. **The popup is not cut off.** The staged `_headers` send `Cross-Origin-Opener-Policy: same-origin-allow-popups`, and in the popup `window.opener` is the forum page.
    Negative control: serve the same page with `same-origin` and sign-in does not complete (the popup cannot reach the opener), with no change to the forum page.
17. **Same origin only.** Before the click, set `challenge-url="https://other.example/challenge"` on the element: the click ends in `error:E_BAD_REQUEST`, and no request is made to
    any other origin (the host log is unchanged; the browser could not resolve it anyway).
18. **The chat panel's four views.** `document.querySelector('mw-chat-panel').view` is `'unavailable'` when the site was published without `--chat-panel` and `--chain` (no ledger for the chat lane, or
    chat off); `'signed-out'` for a guest on the published forum, with a Sign in button inside the panel that calls `mw.auth.signIn()`; `'off'` after sign-in, with "Turn on chat";
    `'on'` after the person accepts the loader's own card (the card is in `[data-mw-ui]`, not inside the panel), with the Lobby and Messages tabs.
19. **Two visitors, one Lobby.** Two contexts sign in (two identities) and both turn on chat. A line typed in the first appears in the second's Lobby as text (`<b>x</b>` stays
    literal) with the sender's name or short id, and nothing is added to the site ledger (`(await window.mw.ready()).height` is the same before and after). A `Connected to you now` list shows
    the other visitor only while their page is open.
20. **A policy made of the printed lines is enough.** Serve the page with a `Content-Security-Policy` built from `<out>/csp.txt`: `default-src 'self'`, `script-src 'self'`, `worker-src 'self'`,
    `connect-src 'self' ws://127.0.0.1:8000`. Run checks 11 to 19: no `securitypolicyviolation` event fires, and the widgets still run.
