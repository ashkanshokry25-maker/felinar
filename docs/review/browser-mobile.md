# Review: browser and mobile compatibility (lens: browser-mobile)

Reviewed: `docs/ARCHITECTURE.md` v0.1 and `docs/INTERFACES.md` (2026-10-14). Facts in ARCHITECTURE §1 are taken as true.
Method: every library claim below was re-read from the vendored sources in `node_modules` on this machine
(`webtorrent@3.0.21` dist bundle and `lib/`, `uint8-util@2.3.2`, `fsa-chunk-store@1.3.0`, `bittorrent-tracker@11`).
Browser-version statements are from my knowledge as of 2026-10 and are marked "verify" where I am not certain.
Severity: **blocker** = fails for a whole browser family or breaks a stated requirement; **major** = fails on a
specific common platform or makes a claim to the user untrue; **minor** = degrades, or is a misleading claim.

Targets considered: iOS Safari and every iOS browser (all WebKit, including in-app WKWebViews), Android Chrome,
Samsung Internet, Firefox (incl. private windows), Brave (desktop, Android, iOS), Edge, desktop Chrome/Safari.

---

## Blockers

### B1. The vendored `webtorrent.min.js` requires `Uint8Array.prototype.toHex/toBase64` and `Uint8Array.fromHex/fromBase64`, which only exist in Chrome/Edge 140+, Firefox 133+, Safari 18.2+
**Where:** ARCHITECTURE §1 (bundle facts), §5 step 1 (boot feature list), §10 `build.mjs`; INTERFACES `src/loader/boot.js`, `config.js`.
**Evidence:** `node_modules/uint8-util/src/browser.ts` (browser entry per its `package.json` `exports.browser`):
`arr2hex = data => data.toHex()`, `hex2arr` → `Uint8Array.fromHex(str)` for strings longer than 64 chars,
`arr2base = bytes => bytes.toBase64()`, `base2arr = str => Uint8Array.fromBase64(str)`. No feature guard.
The same code is inlined in `dist/webtorrent.min.js` (`y=e=>e.toBase64()`, `ray.fromHex(e)`). webtorrent calls
`arr2hex` for the infohash, the peer id and every piece-hash comparison, so on an engine without these methods the
first `client.add()` dies with `TypeError: data.toHex is not a function` and nothing in §5's feature list predicts it.
**Who breaks today:** every iPhone/iPad on iOS 18.1 or lower (iPhone 8/X top out at iOS 16, iPhone 7 at 15, iPad 6
at iPadOS 17; every iOS 17 straggler), Samsung Internet until its Chromium base reaches 140, Android WebView-based
in-app browsers that have not updated since 2025-09, Firefox ESR 128, any Chrome/Edge/Brave not updated since 2025-09.
These engines all pass the §5 feature detect, so the user sees a generic "download failed", not the precise message G6 promises.
**Fix (apply both):**
1. `src/loader/boot.js` (classic, runs before `import('./loader.js')`): install guarded polyfills for the four
   methods, then self-test them (`new Uint8Array([1,2]).toHex() === '0102'`, `Uint8Array.fromHex('0102')[1] === 2`,
   base64 round-trip) and treat a failed self-test like any missing feature. A table-driven `toHex` is ~15 lines;
   `fromHex` must throw `SyntaxError` on odd length or non-hex (uint8-util relies on that only for >64-char input);
   `toBase64(opts)` must honour `{ alphabet: 'base64url', omitPadding }`; `fromBase64(str, opts)` likewise. Base them
   on `btoa`/`atob` plus a loop. Document in `boot.js` that these exist because of `uint8-util@2.3.2`.
2. `build.mjs`: add a gate `esbuild node_modules/webtorrent/dist/webtorrent.min.js --target=<matrix from M5>
   --log-level=warning --outfile=/dev/null` so a future vendored bundle that needs newer *syntax* fails the build
   (esbuild cannot detect new *APIs*, which is why step 1 is also needed).
   Alternative to 1 (more invasive): re-bundle webtorrent from source with `overrides: { "uint8-util": "2.2.x" }`
   (the pre-2.3 builds used hand-written hex/base64) and your own esbuild target. Record either choice in DEVIATIONS.

### B2. Degraded render mode (`iframe.srcdoc`) inherits the shell's CSP, so the site's inline `<script>`/`<style>` and every rewritten `blob:` script, stylesheet, font and fetch are blocked. Degraded mode as specified renders an unstyled, script-less page in exactly the browsers it exists for
**Where:** ARCHITECTURE §7 "Degraded mode" and §13 shell CSP; INTERFACES `render.js mountDegraded`, `index.html`.
**Why:** CSP3 makes `about:srcdoc`, `blob:` and `data:` documents inherit the CSP list of the document that created
them (meta or header, no difference). The shell policy is `script-src 'self'; style-src 'self' 'unsafe-inline';
connect-src 'self' https: wss:; img-src 'self' blob: data:` and `default-src 'self'` for fonts/media. Inside the
srcdoc document that means: no inline scripts (most static sites have them), no `blob:` scripts (the rewrite output),
no `blob:` fonts/media, `fetch('blob:...')` blocked. `img` works, nothing else does. This hits Firefox private windows,
Safari private tabs, and every iOS in-app WKWebView browser (Instagram, Facebook, Gmail, Telegram, X, LinkedIn: no
`navigator.serviceWorker`), which is a large share of mobile link traffic. There is no non-inheriting document a
page can create without a server or a Service Worker.
**Second defect in the same path:** the site's `<script type="module" src="/_mw/sdk.js">` is not rewritten; with no
SW the static host's SPA fallback answers `/_mw/sdk.js` with `index.html` (HTML, status 200 on S3/CloudFront) and the
module import fails on MIME type (`text/html` is rejected for module scripts in every browser). `window.mw` never exists.
**Fix:**
1. `src/loader/index.html`: remove the static CSP `<meta>`. `boot.js` decides `degraded = !('serviceWorker' in
   navigator)` synchronously, then inserts the CSP meta itself (dynamically inserted meta CSP is enforced from
   insertion onward in Chrome, Firefox and Safari). Normal policy = §13 as written. Degraded policy adds `blob:` to
   `script-src`, `style-src`, `font-src`, `media-src`, `connect-src` and adds `'unsafe-inline'` to `script-src`.
   State in DEVIATIONS/CRITIQUE that degraded mode trades CSP strength for working sites, and keep the degraded
   iframe `sandbox` without `allow-same-origin` where the site does not use the SDK (the SDK handshake needs the real origin).
2. `render.js mountDegraded`: in the one-pass rewrite, map `/_mw/sdk.js` (any `src`/`import` that resolves to it) to
   the real shell asset `/sdk.js`, and rewrite relative `fetch` targets is still impossible; keep the "limited mode" badge.
3. Add an e2e case: Firefox private window (`playwright firefox` with `browserContext` private) renders the example
   with CSS applied and `mw.ready()` resolving in degraded mode.

---

## Major

### M1. Safari ITP deletes all script-writable storage (IndexedDB, Cache Storage, SW registration) for a site after 7 days of Safari use without user interaction. That erases the site cache, the chain, the cached pointer, the TOFU owner pin, the consent flag and the non-extractable identity key
**Where:** §4 owner-key TOFU and pointer cache, §5 step 4 "render immediately from IndexedDB", §6.1 identity, §6.6, §8 consent, INTERFACES `cache.js` stores.
**Consequences on iOS (all browsers) and macOS Safari:** (a) the identity key is non-extractable, so after a purge
the visitor is a new author forever: their name is gone and they can no longer tombstone their own posts; (b) the
TOFU pin resets, so a changed `owner` key is accepted silently on the next visit (the exact attack §4 pins against);
(c) "instant render from cache" and §12 E2E (5) offline reload are untrue for any iOS visitor who comes back after a
week; (d) consent re-appears. Home-screen web apps are exempt, and since iOS 16.4 each home-screen app has its own
storage, so the Safari identity and the installed-app identity differ.
**Fix:**
1. Identity: generate `extractable: true`, immediately `exportPrivateJwk`, wrap it with AES-GCM under a PBKDF2 key
   derived from a user passphrase (or a random key shown once as a recovery string), store the wrapped blob in
   `identity`, and keep only the imported non-extractable `CryptoKey` in memory. Add Settings → "Back up identity /
   Restore identity". Without this the "delete-my-post" demo (§11) breaks for iOS users after a week.
2. TOFU: store the pin inside the chain itself is impossible (chain is per site, not per device), so at minimum show
   "first time on this device" whenever a pin is missing and a signed record is seen, and say in CRITIQUE that
   rollback/TOFU protection is weak on Safari.
3. Call `navigator.storage.persist()` only after a user gesture with a one-line explanation (Firefox shows a
   permission doorhanger; Chrome/Safari decide silently). On iOS add an "Add to Home Screen keeps this site offline" hint.
4. UI copy: do not promise offline availability on iOS; say "cached until Safari clears it".

### M2. The §8 lifecycle table promises background behaviour the mobile OS does not allow, and `pagehide`-destroy breaks back/forward-cache restores
**Where:** §5 step 8 lifecycle, §8 table rows "seed when hidden" and "chain gossip when hidden: yes".
**Facts (also in `docs/research/03-webrtc-nat-privacy.md` §11 and F-19):** iOS suspends the web process after a
~20 s prepare-to-suspend window once the tab is hidden or the screen locks; sockets, WebRTC and timers all stop.
Android Chrome exempts pages with an open data channel from timer throttling and freezing, but the OS can still kill
the process and screen-off ends everything. Firefox for Android delays timers to 15 min and may unload the tab.
Desktop Edge "sleeping tabs" and Chrome Memory Saver discard hidden tabs (discard = reload on return).
So "mobile hidden → gossip yes" and "pause after 30 s" are not decisions the loader gets to make; a mobile visit
contributes only while the tab is in the foreground with the screen on. That must be the sentence shown to the user,
because the project's own promise is "visitors keep the chain alive by their visit".
**Concrete failures:** (1) `pagehide → destroy client` plus a bfcache restore (`pageshow` with `persisted === true`,
common on iOS Safari and Android Chrome back-swipe) leaves a live page with a destroyed client and no re-init.
(2) After suspension every `RTCPeerConnection` is dead and the WebSocket tracker reconnects with the 10 s → 1 h
backoff; a phone that lost coverage a few times (subway, elevator) reaches minutes-to-hours of backoff and then finds
no peers after resume. (3) Anything flushed only at `pagehide` is lost when the app is killed from the switcher.
**Fix:**
1. `policy.js`/`app.js`: persist on `visibilitychange → hidden` (blocks are already written on ingest; also write
   heads/meta there). Treat `pagehide` as best-effort only. On `pageshow` with `persisted`, and on `visibilitychange
   → visible` after more than 60 s hidden, rebuild: `torrentManager.destroy()` then `seedFromCache()` (or restart the
   download), which recreates discovery and resets tracker backoff. Also do this on `online`.
2. §8 table: replace the two mobile hidden rows with "nothing runs while hidden (OS); state is flushed at hide; the
   swarm/chain resume on return". Desktop Chromium row may keep "seed while hidden" (data-channel exemption); Firefox
   desktop should expect 1/min timers after 5 min hidden.
3. `ui.js`: a plain line under the peer count on mobile: "Sharing only while this tab is open and the screen is on."

### M3. Cellular detection is blind on iOS and Firefox, so an iPhone on LTE gets the "Mobile Wi-Fi" column (256 KiB/s upload ≈ 0.9 GB per hour) with no way to know
**Where:** §8 detection (`navigator.connection` is Chromium-only) and the table.
**Fix:** `computePolicy`: if `env.cellular === undefined` (no Network Information API) and `isMobile`, use the
cellular column (uploads 0, 24 MiB cap) until the visitor turns on "Upload on this network" in Settings; store the
choice per origin; show the state in the status bar ("Downloading only, tap to share"). Keep the Android Chrome path as
designed. Mention cellular explicitly in the consent line.

### M4. Web seeds need two things the design does not state: `AbortSignal.timeout` (Safari 16+, Chrome 103+, Firefox 100+) and a successful CORS preflight
**Where:** §1 web-seed facts, §10 `publish.mjs webseed-layout.txt`, DEPLOY notes.
**Evidence:** `node_modules/webtorrent/lib/webconn.js` lines 125 to 134: `fetch(url, { cache: 'no-store', headers:
{ 'Cache-Control': 'no-store', 'user-agent': ..., range: 'bytes=a-b' }, signal: AbortSignal.timeout(60000) })`.
The `.torrent` download path uses `AbortSignal.timeout(30000)` too. `Cache-Control` is not a CORS-safelisted request
header, so every web-seed request is preflighted; if the bucket/CDN does not answer `OPTIONS` with
`Access-Control-Allow-Headers: range, cache-control`, the web seed fails in all browsers with an opaque network error
(the UI would show "no peers"). On Safari 15 the call throws `TypeError: AbortSignal.timeout is not a function`
before any request is made.
**Fix:** (1) polyfill `AbortSignal.timeout` in `boot.js` (an `AbortController` + `setTimeout` aborting with a
`DOMException('TimeoutError')`). (2) `publish.mjs` must emit a ready-to-paste S3 CORS document:
`[{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["Range","Cache-Control"],
"ExposeHeaders":["Content-Range","Content-Length","Accept-Ranges","ETag"],"MaxAgeSeconds":86400}]` and the
CloudFront note "allow OPTIONS in the cache behaviour and attach a CORS-with-preflight response-headers policy".
(3) `tools/dev-server.mjs` must answer `OPTIONS` the same way, otherwise the e2e web-seed case passes only by luck.
(4) `TorrentManager` should surface tracker/webseed `warning` events (webtorrent reports preflight failures only there).

### M5. No minimum-browser matrix, no build target, and `boot.js` cannot do its job as written
**Where:** §5 step 1, §10 `build.mjs` (ES2017 boot, ES2020 loader, no `target` stated), INTERFACES toolchain.
**Problems:** (a) `import('./loader.js')` written literally in a classic script is a parse error in browsers without
dynamic import, so those browsers get a blank page instead of the "precise static message". (b) The bundle targets
are stated as ECMAScript levels, not browsers; esbuild lowers syntax only when given browser targets, and APIs are
never lowered. (c) Without a matrix nobody can decide whether B1/M4 polyfills are enough. (d) `pow-worker.js` and
`sw.js` must be classic bundles: module workers need Safari 15+/Firefox 114+, module service workers likewise.
**Fix:**
1. Decide and write into `config.js`/README: with the B1+M4 polyfills the floor is Safari/iOS 15.4, Chromium 110
   (Chrome, Edge, Samsung Internet, Brave, Android WebView), Firefox 115 ESR. Without them it is Safari 18.2,
   Chromium 140, Firefox 133. (Floor drivers: `structuredClone`/`Array.prototype.at` 15.4, `BigInt64Array` used by
   uint8-util `equal()` for ≥128-byte buffers, `queueMicrotask`, `globalThis`.)
2. `build.mjs`: `target: ['es2020', 'safari15.4', 'chrome110', 'firefox115']` for `loader.js`, `sdk.js`, `sw.js`,
   `pow-worker.js`; `boot.js` as IIFE with `target: ['es2017']` and the dynamic import done through
   `new Function('u', 'return import(u)')` (or by appending a `<script type="module">`) inside a `try` so the parse
   never fails. Regex lookbehind (`(?<=`) is lowered to `new RegExp` by esbuild, so it fails at run time, not parse
   time; grep-ban it in `src/`.
3. Ban list for `src/` (lint grep in `npm test`): `Uint8Array.*(toHex|toBase64|fromHex|fromBase64)`,
   `Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`, `Set.prototype.(union|intersection|...)`,
   `URL.parse`, `AbortSignal.any`, iterator helpers, `using`, regex `v` flag, `Intl.Segmenter`.
4. `boot.js` feature list should add: `'serviceWorker' in navigator` (informational, selects degraded mode),
   `Blob.prototype.arrayBuffer`, `ReadableStream`, `MessageChannel`, `structuredClone`, and the B1/M4 self-tests.

### M6. "Do not block on `controller` longer than 3 s" is the wrong signal and will push slow first visits into degraded mode (and then into B2)
**Where:** §5 step 2; INTERFACES `registerServiceWorker({ timeoutMs: 3000 }) → { controlled, degraded }`.
**Why:** on a first visit the parent page is uncontrolled until `clients.claim()`, but the iframe does not need the
parent to be controlled: a new navigation is controlled as soon as the registration is *activated*. Activation waits
for `install`, and install precaches the shell list including the 223 KB webtorrent bundle; on a phone on 3G or an
iOS cold start that regularly exceeds 3 s. The loader then renders degraded (B2) although a working SW arrives a
second later, and the UI shows "limited mode" on a healthy browser.
**Fix:** `registerServiceWorker`: if `!('serviceWorker' in navigator)` → degraded immediately; else `await
navigator.serviceWorker.ready` with a long timeout (15 s, the torrent download runs in parallel anyway) and treat
only `register()` rejection or that timeout as degraded. Create the iframe only after `ready`. In `sw.js`, precache
only `index.html`, `boot.js`, `loader.js`, `sdk.js`, `pow-worker.js` during install and cache `webtorrent.min.js`
on first fetch (cache-first afterwards), so install stays small. Add e2e: throttled network first visit renders in SW mode.

### M7. The default chunk store wipes other tabs' data, and on Safari 15.2 to 18.1 it is a polyfilled OPFS path that spawns a module Worker per write
**Where:** §1 chunk-store fact, §5 step 4 downloader, INTERFACES `torrent.js download()`.
**Evidence:** `fsa-chunk-store/index.js` top level: `navigator.storage.getDirectory().then(d =>
d.removeEntry('chunks', { recursive: true }))` runs on every module evaluation, i.e. every loader tab on the origin
(the author's own comment: "this can be bad when multiple instances of this app are running"). Per-domain mode with
two tabs of the same site, or hub mode with two sites, deletes the first tab's in-progress chunks. Separately,
`fsa-chunk-store/createWritable.js` installs `FileSystemFileHandle.prototype.createWritable` on Safari when it is
missing, and ES module order evaluates it before `torrent.js` computes `SUPPORTS_FSA`, so §1's "otherwise
memory-chunk-store" is not what happens on Safari before 18.2: every `put` opens `new Worker(blobURL, { type:
'module' })` plus a sync access handle (slow worker churn, exclusive-lock errors if two writes hit one file, needs
`worker-src blob:`). Firefox private windows expose `getDirectory` but may reject at use time (verify), which would
fail the torrent instead of falling back.
**Fix:** never use the default. Pass an explicit in-memory store on download: `client.add(magnet, { store:
MemoryChunkStore, storeCacheSlots: 0 })`, where `MemoryChunkStore` is a 25-line abstract-chunk-store in
`src/loader/` (memory-chunk-store is not exported by the bundle; you already write `BlobChunkStore`). Sites are
capped at 24 to 128 MiB, so memory is fine; to avoid a 2× peak on phones, build each file's Blob from
`file.on('done')` as files complete instead of all at `torrent.on('done')`. Seeding already uses `preloadedStore`.
Correct the §1 sentence accordingly.

### M8. The LAN demo cannot run on any phone: `http://<lan-ip>` is not a secure context, and a `ws://` tracker from an `https://` page is blocked mixed content
**Where:** §11 "prints the hub URL to open in any browser on the LAN", §13 dev CSP `ws://127.0.0.1:* ws://localhost:*`, §10 `dev-server.mjs`/`tracker.mjs`.
**Why:** without a secure context `crypto.subtle`, `navigator.serviceWorker` and `navigator.storage.getDirectory`
are undefined; the bundle itself hashes pieces with `crypto.subtle.digest` (`uint8-util` `hash()`), so webtorrent
fails even before the chain does. `localhost` is secure only on the machine itself. From a phone the tracker URL is
a LAN IP, so `ws://` is mixed content on Chrome, Firefox and Safari; iOS has no "treat as secure" flag.
**Fix:** `dev-server.mjs` and `tracker.mjs` get `--tls <cert> <key>` (mkcert; README step "install the mkcert root
CA on the phone, iOS: Settings → General → About → Certificate Trust Settings"), the demo prints `https://` and
`wss://` URLs, and the dev CSP adds `wss://<lan-ip>:*`. Android-only alternative to document:
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`. Keep the e2e on `localhost` as is.

### M9 (cross-lens, verified here). With zero peers online a magnet-only start never gets metadata, even with `ws=`; web seeds attach only after metadata. The pointer needs `xs=`
**Where:** §0/§2 "reachable when no visitor is online", §4 grammar (no `xs` key), INTERFACES `magnetFromRecord` ("merges tr/ws, dn").
**Evidence:** `webtorrent/lib/torrent.js`: web seeds are added inside `_onMetadata` (line 579); BEP 19 cannot supply
the info dict. But webtorrent does implement `xs` (line 375, `_getMetadataFromServer` lines 484 to 550): a plain
`fetch` of the `.torrent`, status must be 200, infohash is checked. It needs only `Access-Control-Allow-Origin: *`.
**Fix:** add `xs=<https url of site.torrent>` to the §4 grammar and signing input, have `magnetFromRecord` emit it,
have `publish.mjs` write `site.torrent` into the web-seed layout (`<ws base>/<name>.torrent`) and set `xs` by default
when `--ws` is given. This also enables the no-WebRTC fallback in m5. (Flagging for the torrent/protocol lens; it is
a requirement failure on every browser, so it belongs in the first fix batch.)

---

## Minor

### m1. Hashcash "sub-second on phones" is not a safe claim
`crypto.subtle.digest` is one async native call per attempt; 2^14 is only the mean, the tail is geometric (1 in 20
posts needs more than 49k attempts). On a mid-range Android, in Edge "enhanced security" (no JIT) or any JIT-less
mode, posts take several seconds and the UI must not look hung. **Fix:** mine with a synchronous pure-JS SHA-256 in
`pow-worker.js` (faster per hash for 1 KB inputs than the WebCrypto round trip), verify the winner with `subtle`,
show progress and a cancel button (`E_POW_ABORTED` already exists). Keep `bits` at 14 but measure on a real low-end device.

### m2. No-WebRTC browsers are a hard stop in `boot.js` but could work web-seed-only
Brave Tor windows throw on `new RTCPeerConnection`, Tor Browser and some enterprise policies remove it, Safari
Lockdown Mode removes it together with Service Workers and IndexedDB (research 03 F-21, so Lockdown is a dead end:
show the per-site exclusion steps; the owner of this repo runs Lockdown Mode and can test the message on his own
devices). For the others: `bittorrent-tracker/client.js` line 82/112 skips `ws(s)://` trackers with a `warning` when
`Peer.WEBRTC_SUPPORT` is false, and `simple-peer` only throws when a peer is created, so with `xs=` + `ws=` (M9) a
download completes with no WebRTC at all. **Fix:** make `RTCPeerConnection` a soft check: absent → "web-seed only,
not sharing" badge, skip chain gossip, continue.

### m3. Mobile viewport: the bottom status bar will sit under Safari's and Chrome's toolbars
`100vh` includes the area behind the dynamic URL bar on iOS Safari and Android Chrome; the keyboard resizes the
visual viewport differently per browser. **Fix:** `index.html` viewport meta `width=device-width, initial-scale=1,
viewport-fit=cover, interactive-widget=resizes-content`; layout with `position: fixed; inset: 0` (iframe) and
`height: 100dvh` with a `100vh` fallback; status bar padding `env(safe-area-inset-bottom)`.

### m4. IndexedDB write path will hit Safari/Firefox auto-commit if any `await` sits inside the transaction
`saveSite(manifest, blobs)` must build every Blob before opening the `readwrite` transaction and issue all `put`s
synchronously; an `await file.blob()` or `await crypto.subtle...` inside the transaction gives
`TransactionInactiveError` on Safari and Firefox (Chrome is more forgiving, so the spike would not show it). Also:
handle `onversionchange` (close) and `blocked` because the SW and the page both hold connections; on Safari retry
once on `UnknownError` (memory pressure); `QuotaExceededError` is the `DOMException.name` in all three engines.

### m5. Safari media elements are strict about Range from a Service Worker
iOS Safari sends `Range: bytes=0-1` probes and refuses to play unless the SW answers `206`, exact `Content-Range`,
`Content-Length` of the slice and `Accept-Ranges: bytes`; any `200` to a ranged request stalls `<video>`/`<audio>`
silently. The §7 design covers this; add unit vectors for the `0-1` probe, suffix ranges (`bytes=-500`) and
out-of-range (`416`) in `sw/lib.js parseRange`, and an iOS manual test with a short mp4 in the example site.

### m6. Storage containers are not shared: identity and cache differ per container
Same user, different identity and empty cache in: Safari vs. a home-screen web app (iOS 16.4+), Safari vs. Chrome iOS
vs. an in-app WKWebView, Android Chrome vs. an Instagram/Facebook WebView (Chrome Custom Tabs do share Chrome's).
Say so in Settings ("identity lives in this browser"), and make the M1 backup/restore the answer.

### m7. Two shell claims are browser-limited and should be worded precisely
(a) §13 SRI: `integrity` is enforced only on the `<script type="module" src>` tags; the `import()` of `loader.js`
and the static import of `webtorrent.min.js` carry no SRI (import-map `integrity` is Chromium 127+ only). Either load
`loader.js` via a module script tag with `integrity` and let it import webtorrent, and state that webtorrent is
covered only by same-origin + immutable caching, or drop the SRI sentence. (b) `manifest.webmanifest
protocol_handlers: magnet` works only for installed PWAs on desktop Chromium; Safari and Firefox ignore it, and Brave's
built-in WebTorrent extension claims `magnet:` itself. Do not advertise "magnet links open the loader".

### m8. Tracker hostnames must be checked against ad-block lists before `config.js` is frozen
Brave Shields, Samsung Internet content blockers, uBlock Origin and Edge strict tracking prevention block by hostname.
Public WebTorrent trackers have appeared on community lists in the past. Before finalising `CONFIG.trackers`, grep
each hostname against EasyList, EasyPrivacy and Brave's lists; prefer hostnames you control for the self-hosted path.

---

## Corrections to ARCHITECTURE text (not new issues)
- §1 bullet 3: on Safari 15.2 to 18.1 the default is the fsa store with fsa-chunk-store's own `createWritable`
  polyfill, not memory-chunk-store (M7 explains why and makes it moot).
- §5 step 2: the iframe is controlled by an activated SW whether or not the parent has a `controller` (M6).
- §8 table: hidden-tab rows for mobile are OS-determined (M2).
- §13 SRI sentence (m7a).

## Device test matrix the e2e suite cannot cover (do by hand before calling G6 done)
| Platform | What to confirm |
|---|---|
| iOS Safari 18.x and one iOS 16/17 device | B1 polyfill path; SW mode first visit over cellular (M6); `<video>` Range (m5); Lockdown Mode message (m2); 7-day purge simulated via Settings → Safari → Advanced → Website Data (M1) |
| iOS Chrome or Brave (WKWebView with entitlement) and Instagram/Telegram in-app browser | SW presence per container; degraded mode renders styled page with `mw.ready()` (B2); identity differs per container (m6) |
| Android Chrome on LTE and on Wi-Fi | `navigator.connection.type` path (M3); background → resume rebuilds peers (M2); two tabs of the same site (M7) |
| Samsung Internet current stable | B1 (Chromium base version); ad-block list hits on tracker hosts (m8); dark-mode forcing does not break the status bar |
| Firefox desktop private window and Firefox Android | degraded mode (B2); `persist()` doorhanger timing (M1); IDB in-memory behaviour |
| Brave desktop with Shields "aggressive" and a Tor window | WebRTC policy actually in effect (research 03 F-24); m2 web-seed-only path |
| Edge desktop with sleeping tabs on | discard/restore of a seeding tab (M2) |

## Strengths worth keeping
- ECDSA P-256 with raw 64-byte signatures is the one WebCrypto identity that works in every target engine and in Node; `src/chain/crypto.js` already guards for a missing `crypto.subtle` with a precise message.
- Persistence by Blob in IndexedDB plus `preloadedStore` + `skipVerify` for re-seeding sidesteps the OPFS-is-not-persistent trap; keep it.
- A separate ES2017 classic `boot.js` with feature detection and a degraded render mode is the right shape; it only needs the fixes in B1/B2/M5/M6 to be true to its promise.
- Policy table with an explicit cellular column and visitor-overridable settings is the right model; it needs the unknown-network default (M3) and honest hidden-tab rows (M2).
- `parseMagnet` already carries `xs`; the fix in M9 is small.
- `docs/research/03` already settles Lockdown Mode, mDNS, data-channel limits, background exemptions and the Brave policy ambiguity; this review relies on it rather than repeating it.
