# 04 - Serving P2P-fetched sites via Service Worker

Research date: 2026-10-14 (all "current" statements are as of this date).
Scope: how a static loader can serve a website that was downloaded by magnet link (WebTorrent over WebRTC) through a Service Worker (SW); prior art; spec and browser behaviour; lifecycle and mobile caveats; recommendations for the magnet-web design.

Reference versions on 2026-10-14 (from wpt.fyi "stable" runs, npm, GitHub): Chrome 155.0.8059.79, Firefox 158.0, Safari 27.0 (macOS 27.0, released 2026-09-17), WebTorrent 3.0.21 (npm, 2026-07-27), IPFS service-worker-gateway v3.5.0 (2026-10-05), @helia/verified-fetch 8.1.2, helia 7.1.16.

How to read the evidence labels:
- Confidence HIGH = primary source (spec text, engine source code, WPT result, library source I read, or my own experiment) and at least one corroboration. MEDIUM = single primary source, or consistent secondary sources only. LOW = inference or a secondary/blog source; flagged as such.
- "[EXP]" = reproduced by me in Chromium 156.0.8078.4 (Chrome for Testing headless shell, incognito, macOS arm64, 127.0.0.1) on 2026-10-14. Chromium only: Firefox and Safari/WebKit were NOT run on a device.
- Source labels S1..S46 are defined in section 6 (every URL listed there was actually fetched or executed).

---

## 1. Summary

1. A Service Worker cannot be the BitTorrent peer. `RTCPeerConnection` is `[Exposed=Window]` only in the WebRTC spec, so no SW or SharedWorker can open peer connections. Every working design (Planktos, KayleePop/magnet-web, PeerWeb, WebTorrent's own `createServer`) therefore runs WebTorrent in a page and makes the SW a relay: SW `fetch` event -> `clients.matchAll()` -> `MessageChannel` -> page streams bytes back. The IPFS SW gateway can run its node inside the SW only because Helia there uses WebSocket/WebTransport/HTTPS, not WebRTC.
2. WebTorrent 3.0.21 ships a ready SW relay (`dist/sw.min.js`, 1297 bytes; `client.createServer({controller})`), but it is built for media streaming, not for sites: every response carries `Content-Security-Policy: base-uri 'none'; frame-ancestors 'none'; form-action 'none'`, `nosniff`, `Cache-Control: no-store`, and navigations with `destination === 'document'` are converted into file downloads. HTML cannot be rendered from it as-is. We need our own SW (reusing its relay protocol).
3. Sandboxed iframes WITHOUT `allow-same-origin` are not controlled by the parent origin's SW, and for attribute-sandboxed iframes even the iframe's own navigation request bypasses the SW. WPT `sandboxed-iframe-fetch-event.https.html` passes 29/29 on Chrome 155, Firefox 158 and Safari 27.0, and I reproduced it in Chromium 156. So a sandbox cannot be used to isolate a P2P site that is served by a SW; real isolation needs a separate origin (custom domain, or one subdomain per site plus Public Suffix List listing). IPFS removed its path gateway mode in v3.0.0 (2026-02-05) for exactly this reason.
4. Recommended shape: loader shell page at top level (hosts WebTorrent and the chain node) + a full-viewport same-origin iframe pointing at the SAME URL; the SW answers `destination === 'document'` with the shell and `destination === 'iframe'` with the site. Verified in Chromium 156, including after a hard reload [EXP].
5. SW lifetimes differ per engine. Chromium: 30 s idle, 5 min per event; a streamed response keeps the SW awake (120 s stream with 40 s gaps survived [EXP]); idle SW was killed within 85 s and lost all globals [EXP]. Firefox: 30 s idle + 30 s extended (about 1 minute total); no keep-alive for open response streams (bug 1302715 still open), hence WebTorrent's 20 s keep-alive ping. WebKit: client-based (SW lives while pages of the origin exist), 10 s termination delay, 70 s timeout for SW-handled main-document navigations. Therefore: no state in SW memory, answer navigations in under 30 s, ping to keep alive.
6. SW is not available everywhere: Safari Lockdown Mode (WebKit 16.4 notes: ServiceWorkers + Cache API disabled), Tor Browser, generic iOS WKWebView / in-app browsers, Firefox private windows before Firefox 140 (2025-06-24; ESR 128 never). It works in Chromium incognito [EXP]; Safari private browsing is supported by WebKit's design (partitioned per session) but not verified on a device. The loader needs feature detection and a degraded mode.
7. Responses: Safari probes media with `Range: bytes=0-1` and requires 206 + `Content-Range`; the Cache API rejects 206 (`Cache.put` TypeError); a string body defaults to `text/plain;charset=UTF-8`; `mime/lite` (what WebTorrent uses) returns nothing for `.ico`, `.m3u8`, `.eot`, `.flac`, `.jxl`, `.srt` and gives `.ts` -> `video/mp2t`. We need our own MIME table and RFC 9110 range handling.
8. Update lifecycle: everyone (WebTorrent, IPFS, coi-serviceworker) ships `skipWaiting()` on install and `clients.claim()` on activate. That is workable only with a versioned SW<->page protocol. A stale CDN copy of the bootstrap bricked the IPFS gateway in July 2026 (#1155) and Safari first-install flakiness needed a fix in July 2026 (#1159); reload-loop guards and a kill switch are mandatory.
9. iOS: SW since iOS 11.3 (Safari and Home Screen apps); ITP deletes Safari-tab site data including SW registrations/Cache/IndexedDB after 7 days of Safari use without user interaction, Home Screen web apps are exempt and have their own counter; Home Screen storage is not shared with Safari; since iOS 26 every Home Screen site opens as a web app by default. Safari 27 adds SW static routing and transferable `ReadableStream`.
10. Planktos was never serverless (the origin host serves `root.torrent`, `manifest.json` and acts as webseed). npm stopped at 0.3.1 (2017-03-04), last master commit 2018-09-18, issue #93 "Is there any update on this project?" (2023-12-20) has no reply. The maintainer never said why; reason = unknown.
11. Naming: a GitHub project named KayleePop/magnet-web (SW + iframe + WebTorrent, last commit 2022-12-14, a dependency bump) already exists with the same idea and name as this repo.

---

## 2. Findings

### 2.1 Prior art: Planktos and other "site over torrent via Service Worker" projects

**F1. How Planktos served a static site over WebTorrent (it was never serverless).** Confidence HIGH (source code read).
- Bootstrap: the site includes `<script src="/planktos/install.js">`, which calls `navigator.serviceWorker.register('/planktos.sw.js')` (S7 install.js).
- SW `install` event runs `planktos.update(root)`: fetches `planktos/manifest.json` and `planktos/root.torrent` from the ORIGIN server, caches `planktos.min.js` + `install.js` in Cache Storage (`planktos-<namespace>`), stores the snapshot (manifest + .torrent bytes) in IndexedDB (`idb-kv-store`, DB `planktos-snapshots-<namespace>`) (S7 index.js). The wiki states the SW context "is routinely destroyed and recreated", which is why state lives in IndexedDB (S3).
- SW `fetch` handler: ignores cross-origin and non-GET requests and the webseed path `/planktos/files/*`; for everything else asks `planktos.fetch(event)`, which maps the request path to a manifest entry (directory -> `index.html`/`index.htm`) and then to a file in the torrent; if the file is not in the torrent or anything throws, it falls back to `fetch(event.request)` (plain HTTP) (S7 sw.js, lib/snapshot.js).
- WebRTC problem: "Service workers cannot use WebRTC", so the actual download runs in a PAGE. For navigations (a `FetchEvent` without `clientId`) the `inject` middleware returns a tiny bootstrap HTML that loads `planktos.min.js` in the page, which pulls the file via `aether-torrent` (a WebTorrent wrapper) and, for HTML, assigns `document.documentElement.innerHTML = buffer.toString()`; non-HTML files are appended with render-media style `appendTo('body')` (S7 lib/middleware/inject.js). My inference (LOW): scripts inserted through `innerHTML` do not execute, which fits the README's blocking issues and the 2018-05-01 revert of "Add html injection streaming" (S4).
- Seeding: the origin web server is the initial WebTorrent webseed, so it must support HTTP Range; site updates require publishing a new torrent (S1, S2). `aether-torrent` shares ONE WebTorrent client across all pages/workers of an origin and "the actual torrent downloading must happen in a webpage since web workers do not have access to the WebRTC api" (S8).
- Self-declared blockers (README "Blocking Issues"): no streaming (whole file must be downloaded before display; README says only Chrome could stream from SW at the time), no sharding (single torrent per site, impractical for large sites), "not recommended for production" (S1, S2). Issue #29 comment of 2018-04-03 says the Mozilla streaming bug had been fixed ~5 months earlier (S6).
- Also open design bugs: stale content after update (#4), cannot handle a site served under a sub-path (#55, closed), content-type handling (#30/#56, closed) (S6).
- Dated: wiki last edited 2017-02-25; commits 2017-02-12..2018-09-18.

**F2. Why Planktos stopped: facts known, reason UNKNOWN.** Confidence HIGH for facts, reason unverified.
- npm: last version 0.3.1 published 2017-03-04, depends on `webtorrent ^0.98.0`; npm metadata modified 2022-06-24 (S5).
- GitHub: last commit on master 2018-09-18 ("adding torrent announce list configuration via convict (#80)", authored by rigelk); `pushed_at` 2020-05-10 (bot PRs); repo not archived; 537 stars; 35 open issues/PRs, mostly Greenkeeper/dependency PRs from 2018-2020 (S4, S6).
- Issue #93 "Is there any update on this project?" opened 2023-12-20, 0 comments (S6). A community list marks it "Dead project?" (search snippet only).
- No maintainer statement exists; the README disclaimers (no streaming, no sharding, early stage) and a single hobbyist maintainer are the only evidence. Do not assert a cause.
- Still listed in WebTorrent FAQ and cited in Workbox issue #1375 (2018-03-17, closed "outside scope" by Jeff Posnick 2018-05-22) (S12).

**F3. Other prior art that matters (all keep WebTorrent in a page and use a SW only as an HTTP-like front).** Confidence HIGH for what the READMEs say, MEDIUM for status.
- KayleePop/magnet-web (MIT): "View webtorrents like they're an http server using a service worker." Uses `stream-to-sw`; URL scheme `/{infoHash}/path`; README: "Unfortunately, only iframes will work ... magnet-web requires two pages to work (one to run webtorrent, and one to load requests from the SW)"; custom chunk store keeps at most 100 MB in memory; TODO lists caching torrents in IndexedDB. Last commit 2022-12-14 (a dependency bump) (S9). Same name as this repository.
- PeerWeb (Omodaka9375/peerweb, peerweb.lol): sites addressed by torrent infohash `?orc=HASH`; SW `peerweb-sw.js`; content shown in an iframe with `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"` (so NOT isolated); IndexedDB cache with 7-day expiry; README limitations: static sites only, "Sites available while browser tab is open", needs active peers; author on HN: "security is a major caveat", not a secure version; commenters: stuck on "Connecting to peers", one tab used ~15 GB RAM overnight, suggested putting the hash in a subdomain for isolation. Last commit 2025-10-07; HN item 46829582 (about January 2026; exact date not shown) (S10, S11).
- aether-torrent (xuset): shared WebTorrent client across pages/workers, one page does the downloading (S8).
- Other: retrohacker/peerweb.js (last commit 2016-02-15), Weedshaker/PeerWebSite (last commit 2024-11-02) - seen only via search results/atom feeds, not read in depth (S9, S10 notes).
- WebTorrent issue #2635 (2023-08-03) "use webtorrent in Service Worker ... distributed caching" was closed by its author with no replies (S13).

### 2.2 IPFS service-worker-gateway (Helia), 2025-2026

**F4. How it works.** Confidence HIGH (source read, repo state 2026-10-14; v3.5.0).
- Architecture: static bootstrap page + SW that implements the IPFS Subdomain Gateway spec in the browser using Helia + `@helia/verified-fetch` (8.1.2). Blocks are fetched over WebSockets, WebTransport (when `'WebTransport' in globalThis`) and trustless HTTP gateways, verified against the CID, and stored in IndexedDB (`IDBBlockstore('/@helia/service-worker-gateway/blocks')`). Routing via delegated HTTP routing; DNSLink resolved with DNS-over-HTTPS JSON resolvers (S15 verified-fetch.ts). No WebRTC transport is configured (`transports` = `webSockets()` plus `webTransport()` when available), which is what makes it possible to run the node INSIDE the SW.
- Install flow (src/index.tsx, src/lib/register-service-worker.ts): every `<cid>.ipfs.<gateway-domain>` request first gets the static bootstrap `index.html` from the CDN; it checks `isBrowserSupported()` and `'serviceWorker' in navigator`, refuses IP-address hosts, redirects `127.0.0.1` to `localhost`, applies a redirect-loop guard (error "310 Too many redirects"), registers `/ipfs-sw-sw.js` with scope `/` if no active worker, then forces a navigation (`location.href = same URL`, or `location.reload()` when there is a URL fragment, with long comments on why) so the now-active SW can serve the document. After that the SW intercepts everything for that origin (S15 index.tsx).
- SW (src/sw/sw.ts): `install` -> `skipWaiting()` + clear SW asset cache; `activate` -> `clients.claim()` + delete caches not in `CURRENT_CACHES`; `fetch` strips the URL fragment (`url.hash = ''`, because "Chromium leaks the navigation hash through to `event.request.url`" on reload), picks a handler (unregister, URI router, asset handler for `ipfs-sw-*` assets and the root `index.html`, content handler), calls `event.respondWith(promise)` synchronously and pipes the body through a `TransformStream` with abort-signal handling. Responses are cached in Cache Storage with a key that includes `request.destination` (so a media-viewer wrapper for top-level navigations never collides with the raw bytes for `<img>`/`<video>`) and 206 responses are never cached (S15 sw.ts, content-request-handler.ts).
- Unregister escape hatch: `?ipfs-sw-unregister=true` (S14, S15).
- Maintenance: Shipyard maintained it 2024-2026; "ended in Q3 2026"; now @nymd and @byo for the IPFS Foundation (S14). Public gateways ipfs.io and dweb.link began redirecting to inbrowser.link on 2026-05-11 (S18).
- Dated: repo state 2026-10-14; CHANGELOG v3.5.0 2026-10-05 (GitHub release 2026-10-06); v3.0.0 2026-02-05.

**F5. Subdomain vs path gateway isolation.** Confidence HIGH (design-critical).
- v3.0.0 (2026-02-05) BREAKING: "path gateway or access via IP addresses is no longer supported". docs/DEVELOPMENT.md: "The gateway runs exclusively in subdomain mode. Path gateway support was removed in v3, and `/ipfs/cid` now redirects to `cid.ipfs.example.com`." Warning: "Path-only gateways do not provide Origin isolation. NEVER use path-only gateways for loading dapps with sensitive information such as keys, passwords, or wallets." (S15 CHANGELOG, docs/DEVELOPMENT.md).
- Why: each CID subdomain is its own origin (own SW registration with scope `/`, own IndexedDB/localStorage/cookies). IPFS docs: on a path gateway "all pages share a single origin" and it "should only be used when site isolation does not matter"; the subdomain gateway spec says operators SHOULD set wildcard TLS for `*.ipfs.example.net` and `*.ipns.example.net` and SHOULD register `*.example.net` on the Public Suffix List (PSL) (S21, S22). inbrowser.link is on the PSL "so each CID gets proper Origin isolation" (S18, S19).
- The SW cannot be given a path-scoped isolation: the SW spec itself says path restrictions are "not considered a hard security boundary, as only origins are. Sites are encouraged to use different origins to securely isolate segments of the site" (S28 section 6.5).
- A page served from an IP address, or a host with no DNS wildcard, shows a red "Warning: Subdomain Gateway Not Available / without origin isolation" page (S15 origin-isolation-warning.tsx). `*.localhost` is used for local dev (`bafy....ipfs.localhost:3000`).

**F6. Limitations list (there is NO official "Limitations" section; this list is compiled from README, docs, code and issues).** Confidence MEDIUM-HIGH.
1. Browser floor: needs `Promise.withResolvers` (Chrome 119 / Firefox 121 / Safari 17.4) and non-special-scheme URL parsing (`new URL('ipfs://host').hostname`; Chrome 130 / Firefox 122 / Safari 18.x), else an "update your browser" page (S15 is-browser-supported.ts).
2. SW required: "This is most common in Tor Browser" - a "Service Worker Required" page links the Tor Project work item 43873 (S15 no-service-worker.tsx). IPFS roadmap: "2026-Q3 ... work starts on Service Worker support in Tor Browser" (S20).
3. Subdomain-only; requires wildcard DNS + wildcard TLS (+ PSL for production); IP hosts unsupported (F5).
4. Read-only retrieval gateway (no write path); WebSocket/WebTransport/HTTP transports only, so browser-to-browser P2P is not what it does.
5. "Save As" on a raw file saves the bootstrap HTML instead of the bytes - Chromium bug 40410035; the gateway wraps renderable media in a viewer with a Download button (workaround for crbug 400455011) (S15 about.tsx, content-request-handler.ts). IPFS roadmap says the Chromium issue was fixed 2026-Q3 (S20); the gateway's About page still described it as unfixed in main on 2026-10-14. Chromium issue pages need sign-in (not read).
6. First load costs a bootstrap + SW install + forced reload; Safari needed fixes ("Safari sometimes triggers 310 on service worker install": SW did not report active after the reload, loop repeated 4-5 times; fixed 2026-07-15 by waiting for the UI before reloading in WebKit, PR #1161) (S17 #1159). A stale CDN copy of the bootstrap/`ipfs-sw-index` script caused a cyclic reload for Chrome/Firefox/Brave users (#1155, closed 2026-07-10), recovered by purging Cloudflare cache (S17).
7. Epic #31 (closed 2024-12-05) listed: missing trailing-slash normalization for directories (breaks relative links on `index.html` pages, #62), no HTTP Range support in verified-fetch at the time, 30 MiB download on every subdomain load (#93), "inbrowser.tld being blocked" (#78) (S17 #31).
8. Centralised pieces remain: BadBits denylist enforced at the edge by a Cloudflare Worker for subdomains since v3.5.0, config page removed in v3 (S15 CHANGELOG, docs/CLOUDFLARE_SNIPPETS.md).
9. Project's own words: "This gateway is a convenience, not a replacement" (S15 about.tsx).

### 2.3 WebTorrent's own service-worker renderer (v3.0.21)

**F7. API and protocol.** Confidence HIGH (installed package source + built bundle read).
- Browser use: `const controller = await navigator.serviceWorker.register('./sw.min.js', { scope: './' }); await navigator.serviceWorker.ready; client.createServer({ controller })`. `createServer` throws unless `controller` is a `ServiceWorkerRegistration` whose active worker is `activated`/`activating`. Files are exposed at `{scope}webtorrent/<infoHash>/<filePath>`; `file.streamURL` / `file.streamTo(elem)` (S24 index.js, lib/file.js; S25 docs/api.md).
- SW code (`lib/worker.js` + `lib/worker-server.js`, built to `dist/sw.min.js`, 1297 bytes): `install` -> `skipWaiting()`; `activate` -> `clients.claim()`; `fetch`: only URLs containing `scope + 'webtorrent/'`; `webtorrent/keepalive/` -> empty Response; `webtorrent/cancel/` -> a stream whose `cancel()` flips a flag (feature test: does the browser propagate stream cancellation?). Otherwise `clients.matchAll({type:'window', includeUncontrolled:true})`, posts `{url, method, headers, scope, destination, type:'webtorrent'}` with a fresh `MessageChannel` port to EVERY window client; the first client to answer wins ("race condition for whoever controls the response stream"). The page replies `{status, headers, body:'STREAM'}`; the SW builds a `ReadableStream` whose `pull()` sends `true` on the port and enqueues each `Uint8Array` reply, closes on a `null` reply, and sends `false` on cancel. Where cancellation is unsupported (comment: "firefox doesn't support cancelling of Readable Streams in service workers") it abandons non-document streams after 5 s of inactivity (S24 lib/worker-server.js).
- Page side (`lib/server.js` `BrowserServer`): listens to `navigator.serviceWorker` `message` events, serves from `torrent.files` via the same request logic as the Node server (Range support through `range-parser`, 206 + `Content-Range`), and while any stream is open pings `fetch('{scope}webtorrent/keepalive/')` every 20 000 ms (`keepAliveTime = 20000`) to keep the SW alive (S24 lib/server.js).
- History: SW server added in v1.5.0 (2021-08-19, "add service worker server as an alternative to renderMedia"); v3.0.0 (2026-05-24) breaking change is Node 22+, 3.0.0 also "simplify service worker documentation"; latest 3.0.21 on 2026-07-27 (S24 CHANGELOG, S26).

**F8. It cannot render an HTML site as shipped (design-critical).** Confidence HIGH.
- Every response from `BrowserServer` starts with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: base-uri 'none'; frame-ancestors 'none'; form-action 'none';` (present in `lib/server.js` and in the shipped `dist/webtorrent.min.js`). `frame-ancestors 'none'` forbids embedding the document in an iframe; `base-uri 'none'` kills `<base>`; `form-action 'none'` kills forms.
- `serveFile`: `Cache-Control: no-cache, no-store, must-revalidate, max-age=0`, `Accept-Ranges: bytes`, DLNA headers, `Content-Disposition: inline`, and when `req.destination === 'document'` it sends `Content-Type: application/octet-stream` + `Content-Disposition: attachment` (forced download). CORS defaults to `Access-Control-Allow-Origin: *`.
- `File.type` comes from `mime/lite` v3.0.0 with fallback `application/octet-stream` (F18).
- Consequence: reuse its relay PROTOCOL (matchAll + MessageChannel pull stream + keep-alive), not its response headers or `dist/sw.min.js`. Fork `worker-server.js` (about 80 lines) and write our own request handler.

### 2.4 Spec and browser facts: scope, control, iframes, navigation

**F9. Registration rules; same-origin only; secure context.** Confidence HIGH.
- Register algorithm: the script URL and the scope URL must be same-origin with the registering document, otherwise a `SecurityError` (S28 "Register"). A SW can therefore only ever control clients of its own origin (registration is keyed by storage key + scope URL).
- Secure contexts: "Service workers must execute in secure contexts ... A user agent can allow localhost, 127.0.0.0/8, and ::1/128 for development" (S28 section 6.1). MDN: "Service workers are restricted to running across HTTPS ... `localhost` is considered a secure origin"; registration also fails with cookies blocked, private browsing in some browsers, or automatic cookie deletion on close (S35).
- Script must be served with a JavaScript MIME type (spec 6.6) - on Amazon S3 set `Content-Type: text/javascript` for `sw.js`. Default scope is the script's directory; widen with the `Service-Worker-Allowed` header (S28 6.5).
- Sources dated: spec Editor's Draft fetched 2026-10-14; MDN undated.

**F10. Navigations are matched by URL; subresources follow the page's controller.** Confidence HIGH (spec text + [EXP]).
- Handle Fetch: for a non-subresource request (navigation, frame, worker) the UA matches a registration by storage key + request URL and sets the new client's active worker; for a subresource request it uses the requesting CLIENT's active worker (null -> network). `<embed>` and `<object>` requests "immediately fallback to the network without dispatching fetch event". A navigation initiated with shift+reload "or equivalent" returns null (bypasses the SW) (S28 Handle Fetch, 6.7).
- Consequence 1: an iframe is controlled by the SW even if the embedding page is NOT controlled. [EXP] After a hard reload (`Page.reload ignoreCache:true`) the top-level document went to the network and `navigator.serviceWorker.controller` was `null`, yet both a script-created and a static `<iframe src=same URL>` were still served by the SW (no network hit for the iframe request).
- Consequence 2: use `<iframe>`, never `<embed>`/`<object>`, for the site.
- Consequence 3: `srcdoc`/`blob:` documents inherit the creator's active worker only if same-origin and non-opaque (S28 2.5.1).

**F11. Sandboxed iframes WITHOUT `allow-same-origin` are not controlled by the parent origin's SW (design-critical).** Confidence HIGH.
- Spec note (S28 2.5.1): "Sandboxed iframes without the sandboxing directives, allow-same-origin and allow-scripts, result in having the active service worker value of null as their origin is an opaque origin." (Browsers also deny SW to `allow-scripts`-only frames, see below.)
- WPT `service-workers/service-worker/sandboxed-iframe-fetch-event.https.html` (S29): (a) `<iframe sandbox="allow-scripts">`: SW receives 0 fetch events for the iframe navigation, the iframe is not a SW client, its `fetch()`, workers, nested iframes and sandboxed children are not intercepted; (b) same sandbox applied by a CSP `sandbox` response header: SW DOES see/serve the navigation request but the resulting page is not controlled; (c) `allow-scripts allow-same-origin` (attribute or header): fully controlled. wpt.fyi stable runs of 2026-10-13/14: Chrome 155.0.8059.79 29/29, Safari 27.0 29/29, Firefox 158.0 29/29 (S30).
- `sandboxed-iframe-navigator-serviceworker.https.html`: touching `navigator.serviceWorker` inside `sandbox="allow-scripts"` throws `SecurityError` (Chrome 4/4, Safari 3/4, Firefox 3/4; the differing subtest was not identified).
- [EXP] Chromium 156: `sandbox="allow-scripts"` iframe at a URL inside the SW scope was served by the NETWORK (server logged `sec-fetch-dest=iframe`), reported `navigator.serviceWorker` -> SecurityError, and its `fetch('/__who')` returned `network`; the normal and `allow-scripts allow-same-origin` iframes were served by the SW (`destination: "iframe"`, `controller: true`). Chromium also logs "An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing."
- Prior reports: VS Code's webview team asked for SW registration for opaque origins (w3c/ServiceWorker #1437, opened 2019-06-19, still open, last comment 2024-05-04); the vendor answer was no use case, and their workaround is wildcard subdomains (S33).
- Consequence: a sandbox cannot isolate a SW-served P2P site from the loader. Options: (1) separate origin per site (custom domain = natural; hub = `<id>.hub.example` wildcard + PSL), (2) accept same-origin and treat the loader origin as hostile territory (namespace DB per site, never trust site code). PeerWeb chose the second (sandbox with allow-same-origin = no isolation).

**F12. Navigation fallback / "serve the shell for any path", dispatch on `request.destination`, navigation preload (design-critical).** Confidence HIGH ([EXP] + docs).
- App-shell pattern: answer `request.mode === 'navigate'` with the shell for any in-scope path (Workbox `NavigationRoute` with allow/deny lists is the standard implementation; S44). `Request.destination` is supported in Chrome 65, Firefox 61, Safari 10.1; `mode: 'navigate'` Chrome 49, Firefox 46, Safari 10.1 (S34 BCD). Top-level navigations have `destination === 'document'`, iframe navigations `'iframe'`.
- [EXP] Chromium 156: top-level navigation to `/app/page1?x=1` was answered by the SW with a shell (`destination: document`); the shell's `<iframe src="/app/page1?x=1">` (same URL) was answered by the same SW with site content (`destination: iframe`, `mode: navigate`, `controller: true`). No recursion; the address bar keeps the real site URL.
- Navigation preload: `registration.navigationPreload.enable()`; Chrome 59, Firefox 99, Safari 15.4 (BCD). It exists because "service worker boot-up time can delay a network response" ("usually around 50ms", "On mobile it's more like 250ms", "can be over 500ms") and if you enable it and ignore `event.preloadResponse` "you'll end up with double requests" (S44 web.dev, an old article). Workbox docs say the preload is a waste when the SW answers navigations with precached HTML and still claim "Chrome is currently the only browser" (outdated). For us: do NOT enable it for site/shell navigations (we never want the network response); optionally enable only for the shell revalidation path.
- Static Routing API (`InstallEvent.addRoutes`, route sources network/cache/fetch-event/race): Chrome 123, Safari 27.0 (2026-09-17), Firefox no (BCD, WebKit 27.0 notes) - optional, lets loader assets bypass the SW (S34, S41).


### 2.5 Service Worker lifetime, timeouts and where to keep state

**F13. Termination rules differ per engine; the spec only says "may terminate at any time" (design-critical).** Confidence HIGH (engine source read on 2026-10-14 + [EXP] for Chromium).
- Spec 2.1.1: "The lifetime of a service worker is tied to the execution lifetime of events and not references held by service worker clients ... A user agent may terminate service workers at any time it: Has no event to handle. Detects abnormal operation: such as infinite loops and tasks exceeding imposed time limits." Update staleness: a registration is stale after 86400 s (24 h) (S28).

| Engine | Idle | Pending event / request | Open response stream | Other (relevant) |
|---|---|---|---|---|
| Chromium (main, S36) | `kServiceWorkerDefaultIdleDelayInSeconds = 30` (service_worker.mojom); idle timer re-armed after the last in-flight event ends; timeout timer interval `kTimeoutTimerDelay = 30 s` | `ServiceWorkerEventQueue::kEventTimeout = 5 min`, `ServiceWorkerVersion::kRequestTimeout = 5 min`; start-worker timeout 5 min; stop-worker timeout 5 s | `FetchLoaderClient` holds a `StayAwakeToken` while a streamed `Response` body is being produced and drops it on complete/abort, so an active stream keeps the SW alive | Chrome Developers (extension SW doc): terminated "After 30 seconds of inactivity", "single request ... takes longer than 5 minutes", "fetch() response takes more than 30 seconds to arrive" (S37, applies to extension SWs) |
| Firefox (main prefs, S38) | `dom.serviceWorkers.idle_timeout = 30000` ms | `dom.serviceWorkers.idle_extended_timeout = 30000` ms for `waitUntil`/long JS after idle -> about 1 minute total ("a total of 1 minute to finish doing something", bug 1588838, landed Firefox 73, previously 5 min 30 s) | No keep-alive once the fetch event has ended: bug 1302715 "support long running service workers with FetchEvent.respondWith() while controlled window is open" is still NEW (opened 2016) | Navigation-fault mitigations: `dom.serviceWorkers.mitigations.bypass_on_fault = true` and `navigation_fault_threshold = 3` (SW is bypassed on a navigation fault and unregistered after 3 faults); `group_usage_headroom_kb = 400 MiB` quota mitigation |
| WebKit (main, S40, S41) | Client-based: when the last client of an origin goes away a timer of `SWServer::defaultTerminationDelay = 10 s` (0 s under memory pressure) terminates its workers; after a functional event with no clients, `defaultFunctionalEventDuration = 2 s`; `terminateIdleServiceWorkers` can terminate workers idle for more than 10 s with no pending events (callers not traced); 2018 blog: terminated "when there is no service worker client in its partition after a small grace period" | A SW-handled MAIN-DOCUMENT navigation that is not handled within `NetworkProcess::defaultServiceWorkerFetchTimeout = 70 s` falls back to the network (`ServiceWorkerFetchTask::timeoutTimerFired`); "not Web-compatible" for subresources, so none there | No special rule found | 60 s heartbeat kills a blocked SW thread ("Service Worker script execution timed out"); unresponsive worker killed 10 s after a terminate request; restarts "typically in case of postMessage or fetch events" |

- [EXP] Chromium 156 (incognito, headless shell): SW boot timestamp unchanged after 20 s idle; changed after a further 65 s idle (85 s total) -> SW was terminated and restarted with fresh globals even though a controlled page was open. A single fetch whose response stream was fed by the page with 40 s gaps (3 chunks, 120 s, no other SW events) completed with all 3072 bytes and the SW boot timestamp unchanged -> an in-progress streamed response kept the SW alive well past 30 s.
- Practical limits for a P2P loader: Chrome allows 5 min for a pending `respondWith`, Firefox about 60 s, Safari 70 s for navigations. Answer every navigation within about 30 s (serve a self-refreshing "loading" page otherwise), stream bodies, and ping the SW at an interval below 30 s while streams are open (WebTorrent: every 20 s).

**F14. SW memory is not durable: keep the file map in IndexedDB or Cache Storage, never only in globals.** Confidence HIGH.
- [EXP]: globals reset when the SW is killed (boot timestamp changed).
- w3c/ServiceWorker #1558 (opened 2020-12-17 by the Construct 3 author, closed 2021-02-05): their SW held a URL->Blob map in memory and Chrome killed the SW after about 30 s of inactivity, wiping it. Chrome's mkruisselbrink agreed Cache Storage "is the way to go"; Firefox's asutherland: "in broad agreement that the right course of action is to explicitly store the data in storage" (and use `navigator.storage.persist`); wanderview: frequent requests keep a SW alive, periodic client `postMessage` pings are a workaround; no spec keep-alive API was added (S33).
- Options for us:

| Store | Pros | Cons / traps |
|---|---|---|
| Globals | zero latency | lost on any termination (Chrome >=30 s idle, Firefox 30-60 s, WebKit when no clients) |
| IndexedDB | available in SW; good for the manifest (infoHash -> path table, lengths, content-types, redirect rules) | Safari ITP 7-day cap for Safari-tab sites (F21); cold-start read adds latency |
| Cache Storage | stores `Response` objects keyed by http(s) GET URLs; serves without a live page; offline for free | `Cache.put`/`add` reject 206 and non-GET (spec: "If innerResponse's status is 206, return a promise rejected with a TypeError"); no native Range handling (slice the Blob yourself); disabled in Safari Lockdown Mode; duplicates bytes held by WebTorrent's chunk store; Firefox private mode: Cache API stores are encrypted and ephemeral, and bug 2056035 (open) describes a race that can leave an empty Cache API DB |
| OPFS (`navigator.storage.getDirectory()`) | file-like, big files, `File`/`Blob` slices | Chrome 86 / Firefox 111 / Safari 15.2; `WorkerNavigator.storage` Chrome 55 / Firefox 57 / Safari 15.2 (BCD) - SW exposure on each engine not verified by me |

- Quotas (S41 storage-policy post 2023-08-10): Safari 17/iOS 17 per-origin quota up to 60% of disk for browser apps, 15% for other apps, a cross-origin frame gets 10% of the main frame's quota, overall 80%/20%; LRU eviction; home screen web app gets the browser-app quota; `persist()` granted by heuristics such as "whether the website is opened as a Home Screen Web App".

**F14b. WebTorrent 3.0.21 in the browser: the default chunk store depends on OPFS write support (affects what the SW can read).** Confidence HIGH (package source + BCD).
- `lib/torrent.js`: `SUPPORTS_FSA = navigator.storage.getDirectory && FileSystemFileHandle.prototype.createWritable`; `FALLBACK_STORE = !process.browser || SUPPORTS_FSA ? FSChunkStore : MemoryChunkStore`; `package.json` maps `fs-chunk-store` to `fsa-chunk-store` for browsers (OPFS-backed, "filesystem-like folder structures, to allow external user manipulation of files") (S24).
- `FileSystemFileHandle.createWritable` / `FileSystemWritableFileStream`: Chrome 86, Firefox 111, Safari 26 (BCD, S34). So Safari/iOS 18 and older fall back to `memory-chunk-store`: RAM only, lost when the tab dies, and the SW must always ask the host page for bytes.
- `fsa-chunk-store` deletes the shared `chunks` directory in the OPFS root when it is imported ("this can be bad when multiple instances of this app are running") - a multi-tab hazard (S24).
- Where OPFS is used, completed files exist as real files, so a SW could read them without the host page if `navigator.storage.getDirectory()` is exposed in `ServiceWorkerGlobalScope` on that engine (not verified; open question 5).

### 2.6 Availability: private modes, iOS, Lockdown Mode, Tor

**F15. Where `navigator.serviceWorker` is (not) available (design-critical).** Confidence per row.

| Environment | Status | Confidence | Source |
|---|---|---|---|
| Chrome 45+ (40 partial), Edge 17+, Firefox 44+, Safari 11.1+, iOS Safari 11.3+, Samsung Internet 4+, Opera 32+ | supported; caniuse global usage 97.23% | HIGH | S34 (caniuse JSON, BCD) |
| Chromium incognito (Chrome/Edge InPrivate/Brave private) | Chromium incognito works with in-memory SW storage [EXP]; Edge InPrivate and Brave private windows share the code but were not tested | HIGH for Chromium, LOW for forks | [EXP], S46 |
| Firefox private windows | NOT available before Firefox 140. Firefox 140.0 (2025-06-24) release notes: "Service Workers are now available in Private Browsing Mode." Landed in 139 but disabled again there (bug 1967568 "needs some extra baking; we're going to defer to 140"); bug 1959535 enabled it on release; ESR 128 `wontfix`; ESR 140 and later inherit it (inference: the bugs carry no esr140 flag). Registrations are not persisted; scripts live in encrypted Cache API storage (pref comment). "Never remember history" (bug 1266409) was folded into the same fix. MDN BCD currently says "Before Firefox 139, the `serviceWorker` object is `undefined` in private windows" (issue closed 2026-08-14) - this conflicts with Bugzilla and the release notes; use 140. | HIGH | S39, S38, S35 |
| Safari/iOS private browsing | By design supported: "private browsing mode is enforced in a service worker by partitioning service workers according the browsing session" (WebKit 2018-02-07); ephemeral sessions run with no on-disk registration store (source log "No path to store the service worker registrations"). Not verified on a device. | MEDIUM | S41, S40 |
| Safari/iOS/macOS Lockdown Mode | DISABLED: WebKit 16.4 notes (2023-03-27): "If a user chooses to enable Lockdown mode ... Safari will now: Disable binary fonts in the CSS Font Loading API, Disable Cache API, Disable CacheStorage API, Disable ServiceWorkers, Disable SVG fonts, Disable the WebLocks API, Disable WebSpeech API". A 2026 blog (alexi.sh) claims SWs "can still register, but their powers are cut" and RTCDataChannel is blocked - secondary, not Apple; treat as unverified. Only per-site exemption works ("Turn off Lockdown Mode for this website"). | HIGH (2023 primary); LOW for 2026 claims | S41, S43 |
| iOS third-party browsers / in-app browsers (WKWebView) | Generic WKWebView has no SW (`"serviceWorker" in navigator` false). Apple engineer, Feb 2025: "There's no supported way for you to explicitly support service workers in iOS WKWebView with the APIs currently available." Dev reports: works if the domain is in `WKAppBoundDomains` (max 10 domains) or the app is the default browser; firt.dev (2020-09-16): Chrome and Edge on iOS 14 got SW through the browser entitlement (undocumented). WebKit source: registration allowed if the app holds the SW entitlement, else only app-bound domains and at most `defaultMaxRegistrationCount = 3`. Firefox/Brave iOS: not confirmed. | MEDIUM | S42, S40 |
| Tor Browser | no SW ("This is most common in Tor Browser"; IPFS expects Tor work in 2026-Q3) | MEDIUM | S15, S20 |
| Samsung Internet Secret mode, Brave Tor windows, Edge InPrivate | UNVERIFIED (no source found) | - | - |
| Any browser with cookies/site data blocked or "delete on close" | registration can fail (MDN list) | MEDIUM | S35 |

**F16. WebRTC cannot be used inside a Service Worker (or any shared worker) - the host page is mandatory (design-critical).** Confidence HIGH.
- WebRTC ED IDL (fetched 2026-10-14): `[Exposed=Window] interface RTCPeerConnection`; only `RTCDataChannel` is `[Exposed=(Window,DedicatedWorker), Transferable]` (S32). So an `RTCPeerConnection` can only be created in a window; at most an already-open `RTCDataChannel` can be transferred to a DEDICATED worker. Planktos README and aether-torrent README say the same (S1, S8).
- Consequence: when a request arrives, the SW can serve bytes only if (a) they are already in durable storage (Cache Storage/IDB/OPFS), or (b) a live window client answers over `MessageChannel`. If no window is alive (tab closed, iOS tab frozen) a not-yet-downloaded file cannot be fetched.

### 2.7 Building the response: Range, Content-Type, headers, COOP/COEP

**F17. Range requests: answer them with 206 + `Content-Range`; slice a Blob or stream the range from the host.** Confidence HIGH.
- Safari "was sending an initial request to fetch the video with a `Range` header set to `bytes=0-1`" and "requires HTTP servers that are serving video and audio to support `Range` requests"; the SW must return status 206 and a `Content-Range` header (Phil Nash, 2018-10-23) (S44). web.dev: Chrome/Edge >=87 and Safari preserve `Range` when a SW forwards `event.request` to `fetch()`, Firefox had not as of October 2020; all browsers can satisfy a range request from cache with 206 (S44).
- Reference implementation (Workbox `createPartialResponse`): parse single `bytes=` range, `blob.slice(start, end+1)`, `new Response(slice, {status: 206, statusText: 'Partial Content', headers})`, set `Content-Length` and `Content-Range: bytes start-end/size`, return `416` on failure; pass an existing 206 through unchanged. Gaps: only one range; it returns 416 when `end` > size, whereas RFC 9110 says clamp (browsers do send over-long ends) (S44 source read).
- WebTorrent's server uses `range-parser`: takes the first range only; unsatisfiable or malformed ranges fall back to a full 200 (not 416) (S24 lib/server.js).
- For torrents bigger than RAM do not build Blobs from all chunks; have the host page produce a `ReadableStream` for the requested byte range (WebTorrent `file[Symbol.asyncIterator]({start,end})`) and stream it.
- Always send `Accept-Ranges: bytes`. Media elements (`Request.destination` `video`/`audio`) normally send a `Range` header (general browser behaviour; Safari's `bytes=0-1` probe is the documented case above).

**F18. Content-Type must be set explicitly by extension; library defaults are not enough.** Confidence HIGH.
- Fetch Standard "extract a body": Blob body -> Blob's `type` if non-empty; BufferSource / byte sequence / ReadableStream -> NO content type; string -> `text/plain;charset=UTF-8` (S31). A SW that returns `new Response(htmlString)` therefore serves `text/plain`.
- `X-Content-Type-Options: nosniff` blocks a `style` request unless the type is `text/css` and a `script` request unless it is a JavaScript MIME type; ES modules always need a JavaScript MIME type ("strict MIME type checking error ... non-JavaScript MIME type") (S35 MDN). `WebAssembly.instantiateStreaming` rejects with `TypeError` unless the response is `application/wasm` (S35 MDN).
- Empirical table of what WebTorrent's `mime/lite@3.0.0` returns (executed with Deno on 2026-10-14): `.html text/html`; `.css text/css`; `.js/.mjs application/javascript`; `.cjs application/node`; `.json/.map application/json`; `.wasm application/wasm`; `.webmanifest application/manifest+json`; `.svg image/svg+xml`; `.woff/.woff2/.ttf/.otf font/*`; `.avif/.webp/.png/.jpg/.gif` ok; `.mp4/.webm video/*`; `.m4a audio/mp4`; `.mp3 audio/mpeg`; `.ogg/.opus audio/ogg`; `.wav audio/wav`; `.ts video/mp2t`; `.md text/markdown`; `.heic image/heic`. NULL (WebTorrent falls back to `application/octet-stream`): `.ico`, `.eot`, `.m3u8`, `.mts`, `.wgsl`, `.tsx`, `.srt`, `.7z`, `.sqlite`, `.db`, `.flac`, `.jxl`, `.unity3d`, `.data`.
- Recommendation: own map (text types with `; charset=utf-8`; add `.ico image/x-icon`, `.m3u8 application/vnd.apple.mpegurl`, `.eot application/vnd.ms-fontobject`, `.flac audio/flac`, `.jxl image/jxl`, `.js/.mjs text/javascript`), plus an optional per-site manifest (headers, SPA fallback, redirects) in the style of IPFS `_redirects` (supported by the IPFS SW gateway: `supportWebRedirects`, max 5 internal redirects) (S15 content-request-handler.ts).

**F19. COOP/COEP/CORP from a SW is possible (coi-serviceworker pattern) but costs a reload and has Safari limits.** Confidence HIGH.
- coi-serviceworker v0.1.7 re-wraps every `fetch()` response with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) and, for require-corp, `Cross-Origin-Resource-Policy: cross-origin`; it must be a separate same-origin file, secure context only, reloads the page once after the SW takes control, uses a sessionStorage flag to avoid loops, degrades from credentialless to require-corp when isolation fails, and notes "In some environments (e.g. Firefox private mode) this won't be available" (S45).
- Support (BCD): COOP/COEP Chrome 83, Firefox 79, Safari 15.2; COEP `credentialless` Chrome 96, Firefox 119, NOT Safari. web.dev: "The entire chain of the documents, including parent frames and child frames, must be cross-origin isolated" and COEP must be sent on all documents "including those that are embedded with iframes and worker scripts" (S44 web.dev; support numbers from S34). Under `require-corp`, cross-origin subresources loaded without CORS must send `Cross-Origin-Resource-Policy: cross-origin` (web.dev); same-origin loads need nothing, which is why a self-contained P2P site is the easy case. So if a hosted site needs `SharedArrayBuffer`, the shell, the iframe document and workers all need the headers from our SW, and the first load is unisolated until the SW controls it.
- Headers we SHOULD set on site documents from the SW regardless: `X-Content-Type-Options: nosniff`, a `Content-Type` with charset, and a CSP that does not use `frame-ancestors 'none'` (use `frame-ancestors 'self'`); consider `connect-src 'self'` style CSP only if hermetic sites are a goal.

### 2.8 Update lifecycle for a loader that must be reliable

**F20. `skipWaiting()` + `clients.claim()` is the norm and workable with a protocol handshake; the failures seen in 2026 were about caches and first install.** Confidence HIGH.
- Who does what: WebTorrent `sw.min.js` (install -> skipWaiting, activate -> claim), IPFS SW gateway (same; plus clears asset cache on install and deletes unknown caches on activate; pre-fetch after claim so the first load can be served), coi-serviceworker (same) (S24, S15, S45).
- web.dev: "`skipWaiting()` means that your new service worker is likely controlling pages that were loaded with an older version" - some fetches handled by the old worker, later ones by the new one; "if your page loads without a service worker, neither will its subresources"; update = byte-different script, checked on navigation and at most every 24 h for functional events; `updateViaCache` defaults to ignore caching headers for the main SW script (`imports` mode) (S44). BCD: `updateViaCache` Chrome 68 / Firefox 57 / Safari 11.1.
- MDN: `skipWaiting()` "takes over the pages controlled by the old version"; `clients.claim()` adopts open pages; a new SW waits otherwise (S35). Hard reload (shift+reload) bypasses the SW for that navigation (spec; F10).
- Field failures: IPFS #1155 (stale CDN copy -> cyclic reload; fix = cache purge + code fixes), IPFS #1159 (Safari did not report the SW as active after the reload; fixed with a "wait for UI before reloading in WebKit" change, PR #1161, 2026-07-15), and the shipped guard "310 Too many redirects" (S15 index.tsx, S17).
- ES-module service workers (`register(url, {type:'module'})`): Chrome 91, Safari 15, Firefox 147 only (BCD) - ship a classic-script bundle if Firefox <147 and ESR 140 must work.
- Firefox may bypass and then unregister a SW after 3 navigation faults (F13) - the fetch handler must never leave a navigation unanswered or rejected.

### 2.9 iOS Home Screen (PWA) specifics

**F21. What changes on iOS and in Home Screen web apps (design-critical).** Confidence HIGH unless stated.
- SW, Cache Storage and offline are supported since iOS 11.3 in Safari and Home Screen apps (firt.dev compat table, updated 2026-10-13). Navigation Preload since 15.4; Static Routing since 27.0; no Background Sync / Periodic Sync / Background Fetch (S42).
- ITP 7-day cap: "ITP deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction with the website" (tracking-prevention page); list includes IndexedDB, LocalStorage, Media keys, SessionStorage and "Service Worker registrations and cache" (blog 2020-03-24: the clock counts days of Safari use). "The first-party domain of home screen web applications is exempt ... ITP always skips that domain"; Home Screen apps "have their own counter of days of use" (S41). Consequence: a loader visited rarely in a Safari tab can lose its SW registration, Cache Storage, IndexedDB (including the chain/DB data!) after 7 days of Safari use; the installed Home Screen app does not.
- Storage is not shared between Safari and the installed app ("Storage shared with Browser: Unsupported"); only login cookies are copied at install since iOS 17.2 (S42).
- iOS/iPadOS 26: "every website your users add to the Home Screen opens as a web app by default" (user can switch to bookmark) (S42).
- Quotas: Safari 17 / iOS 17 origin quota up to 60% of disk for browser apps (15% for WKWebView apps), LRU eviction, `persist()` by heuristics incl. Home Screen status (S41).
- Third-party iOS browsers can install Home Screen apps since 16.4 if opted in (S42). Third-party iOS browsers and in-app browsers may lack SW entirely (F15).
- Not verified: JS suspension of backgrounded Home Screen apps and its effect on WebRTC data channels (this decides whether a SW can still reach a live host page); keep as an open question for the mobile-lifecycle research.

### 2.10 Newer platform features that help (and who has them)

**F22. Feature support table.** Confidence HIGH (BCD fetched 2026-10-14; WebKit 27.0 notes).

| Feature | Chrome | Firefox | Safari / iOS | Use for us |
|---|---|---|---|---|
| `Response` accepts `ReadableStream` | 52 | 39 (body getter 65) | 10.1 | streamed responses from the host |
| Transferable `ReadableStream` (`postMessage(stream,[stream])`) | 87 | 103 | 27.0 (2026-09-17) | optional shortcut for page->SW streaming; keep MessageChannel pull protocol for iOS <=26 |
| `FetchEvent.resultingClientId` | 72 | 65 | 16 | correlate shell/iframe clients for navigations |
| `Clients.matchAll({includeUncontrolled})` | 42 | 44 (54 for matchAll) | 11.1 | find host window even if uncontrolled |
| Navigation preload | 59 | 99 | 15.4 | not needed |
| `InstallEvent.addRoutes` (static routing) | 123 | no | 27.0 | let loader assets bypass SW |
| ES module SW | 91 | 147 | 15 | avoid; ship classic bundle |
| COEP `credentialless` | 96 | 119 | no | only if COI needed |
| `WindowClient.ancestorOrigins` | no | no | 16 | do not rely on it |
| `Request.destination` | 65 | 61 | 10.1 | shell vs site dispatch |

### 2.11 Experiments I ran (Chromium 156.0.8078.4, incognito, macOS arm64, 2026-10-14)

**F23. Chromium experiment results.** Confidence HIGH for Chromium, nothing implied for Firefox/WebKit.

Harness: a Deno static server + `chrome-headless-shell` from the local Playwright cache; a test SW and page report results by POST to the server. Files: see section 7. Results:
- A: normal iframe and `sandbox="allow-scripts allow-same-origin"` iframe -> navigation intercepted (`destination: iframe`), controlled, subresource served by SW. `sandbox="allow-scripts"` iframe -> served by network, `navigator.serviceWorker` -> SecurityError, subresource served by network.
- B: SW boot timestamp same after 20 s idle, different after 85 s idle.
- C: streamed response fed by the page with 40 s gaps (120 s) completed, SW not restarted.
- D: same-URL dispatch (`document` -> shell, `iframe` -> site) works.
- E: hard reload (`Page.reload ignoreCache:true`): top-level document bypassed the SW (page uncontrolled), iframe navigations (script-created and static) still served by the SW; no shell-in-shell recursion in Chromium.
- Earlier attempts with a profile directory inside the sandboxed scratch path failed with "AbortError: Failed to register a ServiceWorker ... Operation has been aborted" (disk cache could not be created: "Simple Cache Backend: wrong file structure on disk", "Failed to open the serviceworker diskcache"); `--incognito` (in-memory storage) fixed it. This is an environment artefact, not a Chromium defect, but it shows SW registration aborts when the browser cannot create its SW disk cache.
- NOT tested: Firefox, Safari/WebKit, mobile, real Range/video playback, >5 min streams, tab freezing.


---

## 3. Recommendations for our design

R1. Treat the ORIGIN as the only isolation boundary (do not plan on iframe sandboxing).
- Custom-domain mode (DNS TXT `_magnet.example.com` -> magnet): the loader is deployed at the site's own domain, so each site is its own origin with its own SW, IndexedDB and chain DB. This is the safe default and matches F5/F11.
- Hub mode (`hub.example/#magnet:...`) puts every site in ONE origin: shared cookies/IndexedDB/SW, and site JS can read or wipe the loader's databases, unregister the SW, or talk to the SW protocol (inference from same-origin rules). If hub mode stays, serve each site from `https://<base32 infohash>.hub.example/` (wildcard DNS + wildcard TLS + Public Suffix List listing, exactly the IPFS subdomain-gateway model; a 160-bit SHA-1 infohash is 32 base32 chars and a 256-bit v2 hash 52 chars, both under the 63-char DNS label limit), or ship hub mode as a clearly labelled "trusted/demo" mode. Namespace every DB/key per site either way and expose a narrow host API to site code.
- Never use `sandbox="allow-scripts"` for the site frame: no SW control, no navigation interception (F11). `allow-scripts allow-same-origin` is allowed but gives no isolation (Chromium warns it "can escape its sandboxing").

R2. Shape: loader shell at top level + same-origin full-viewport iframe on the SAME URL (tested, F12).
- SW `fetch` for navigations: `destination === 'document'` -> the loader shell (from Cache Storage, versioned); `'iframe'`/`'frame'` -> the site resource for that path. The address bar always shows the real site URL, so deep links, reload and sharing work. The shell must refuse to boot when `window.top !== window` (a nested shell means the SW was bypassed) and show "reload normally" instead of recursing. Chromium did not recurse after a hard reload [EXP]; Firefox/Safari untested.
- The shell owns WebTorrent, the chain node, DoH lookup and UI; it creates the iframe immediately; because the iframe is same-origin it can mirror `iframe.contentWindow.location` into `history.replaceState` on `load`/popstate without injecting scripts into site HTML.
- Use `<iframe>`, never `<embed>`/`<object>` (the SW is never consulted for them, F10).

R3. Write our own SW; reuse WebTorrent's relay protocol, not its headers or `sw.min.js` (F7, F8).
- Protocol to copy: `clients.matchAll({type:'window', includeUncontrolled:true})`, a fresh `MessageChannel` per request, pull-based chunks with `true`=pull / `false`=cancel / `null`=end, `Uint8Array` payloads, first responder wins, plus a feature-test endpoint for stream-cancel support and a keep-alive endpoint. Improve it with: protocol version in every message; a request timeout so no navigation stays pending more than about 25 s (Firefox ~60 s, Safari 70 s, Chrome 5 min limits, F13); a host registry so the SW asks only windows that announced themselves (`Client.frameType` is `'top-level'` for the shell and `'nested'` for iframes per the spec's Get Frame Type; supported Chrome 43 / Firefox 44 / Safari 11.1); a fallback interstitial ("waiting for peers", auto-retry) for navigations.
- Optional shortcut where supported: transferable `ReadableStream` (Chrome 87, Firefox 103, Safari 27) - keep the MessageChannel protocol for iOS <= 26.
- Response rules: own MIME map with charset (F18); `X-Content-Type-Options: nosniff`; RFC 9110 range semantics (F17); `Accept-Ranges: bytes`; no `frame-ancestors 'none'`; redirect `/dir` -> `/dir/` when `dir/index.html` exists (IPFS issue #62); optional per-site manifest for SPA fallback/redirect/header rules (IPFS `_redirects` model).
- Build as a classic-script bundle (IIFE) registered at `/sw.js` with scope `/` (ES-module SWs need Firefox 147+). Serve `sw.js` with `Content-Type: text/javascript` and `Cache-Control: no-cache`; register with `updateViaCache: 'none'`.

R4. State and storage (F14, F15).
- SW holds no required state in memory. IndexedDB (SW-readable) holds: DNS/TXT cache `{domain -> magnet, fetchedAt}`, per-infohash manifest `{path, length, type, redirects}`, protocol version. Cache Storage (per-infohash cache name) or OPFS holds completed file bytes so cold starts, offline use and a closed host tab still work for already-downloaded files; partial files are served by asking the host page.
- WebTorrent 3.0.21 picks `fsa-chunk-store` (OPFS) as the browser default only if `navigator.storage.getDirectory` and `FileSystemFileHandle.prototype.createWritable` exist, otherwise `memory-chunk-store` (S24 lib/torrent.js); `createWritable` is Safari 26+ (BCD), so iPhones/iPads on iOS 18 or older (Safari < 26) run RAM-only: plan for that (small sites, re-download after tab loss).
- Ask for persistence (`navigator.storage.persist()`); on iOS push users to install to the Home Screen (F21).

R5. Lifetime handling (F13).
- Host page pings `fetch('/__magnet/keepalive')` every <= 20 s while any stream or pending navigation exists (WebTorrent's interval); the SW answers immediately.
- Make every SW code path restart-safe: on any fetch event, derive everything from the URL + IndexedDB; a SW killed mid-stream simply makes the browser retry (media elements re-issue Range requests), so Range support is also the crash-recovery mechanism.
- Never leave a navigation unanswered or rejected: Firefox bypasses the SW on navigation faults and unregisters it after 3 (`navigation_fault_threshold = 3`).

R6. Update and recovery (F20).
- Keep `skipWaiting()` + `clients.claim()`, but version the SW<->page protocol and handshake on `controllerchange`; keep the SW tiny and stable so skew is rare; never auto-reload more than once per load (sessionStorage counter like IPFS's "310" guard).
- Ship a kill switch: `/?unregister` (or `/__magnet/unregister`) that unregisters, clears our caches and reloads; document it. Purge CDN caches on every deploy and make `index.html`, `sw.js` and the shell `no-cache` (IPFS #1155 was a stale CDN copy).
- Pre-flight check at start: `isSecureContext`, `'serviceWorker' in navigator`, required API floor (use IPFS's list as a model: `Promise.withResolvers`, etc.).

R7. Degraded mode and messaging (F15).
- Detect and explain: Safari Lockdown Mode (SW and Cache API disabled; tell users to use "Turn off Lockdown Mode for this website"), Tor Browser, in-app browsers/iOS WKWebView, Firefox < 140 private windows, blocked-cookie/clear-on-close settings. Offer: (a) open in Safari/Chrome, (b) a no-SW fallback renderer for simple static sites (inline assets as `blob:` URLs, `srcdoc` iframe; limits: no dynamic `fetch`/`import()` of site paths, absolute paths need rewriting) - this is a product decision, not a spec guarantee.
- Do not assume private modes work on iOS Safari until tested on devices.

R8. Cross-origin isolation only when a hosted site needs it (F19): copy the coi-serviceworker approach but apply headers per document type (shell + iframe + workers), use `require-corp` on Safari (no `credentialless`), expect one extra reload.

R9. Testing matrix (nothing below Chromium was tested by me): iOS Safari 26/27 (tab, private, Home Screen, Lockdown), Safari 27 macOS, Firefox 158 + ESR 140 (normal and private), Chrome/Edge/Brave/Samsung Internet on Android, Chrome/Firefox on iOS. Cases: sandbox bypass, destination dispatch, hard reload, idle termination, stream keep-alive, Range seeking with `<video>`, SW update while a stream is open. Start from `docs/research/labs/04-sw-experiment/` (section 7).

R10. Naming: rename the project or namespace its npm/GitHub identifiers - KayleePop/magnet-web already exists with the same approach (F3).

---

## 4. Gotchas (checklist)

1. A SW can never open `RTCPeerConnection` (`[Exposed=Window]`); only `RTCDataChannel` can be transferred, and only to DEDICATED workers. No window alive = no bytes for undownloaded files. (F16)
2. WebTorrent's shipped SW renderer sends `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`, forces download for `destination === 'document'`, and sets `Cache-Control: no-store`. It is for `<video>`/downloads, not sites. (F8)
3. `sandbox="allow-scripts"` iframes: not controlled, navigation not even offered to the SW, `navigator.serviceWorker` throws SecurityError. Same behaviour in Chrome 155, Firefox 158, Safari 27 (WPT 29/29). (F11)
4. Navigations are matched by URL, so an iframe is controlled even if its parent is not; hard reload only bypasses the top-level document (Chromium test) - but design for the opposite in Firefox/Safari until tested. (F10)
5. `<embed>`/`<object>` never reach the SW. Shift+reload bypasses the SW for the navigation. (F10)
6. SW state vanishes: Chromium killed an idle SW within 85 s; Firefox allows about 60 s total per event; WebKit ends workers when no client page remains. (F13/F14)
7. Firefox: no keep-alive for open response streams (bug 1302715), so stream pings are required; Firefox also does not propagate stream `cancel()` to the SW (per WebTorrent's source comment, not independently confirmed in Bugzilla). (F7, F13)
8. WebKit falls back to the network if a SW does not answer a main-document navigation within 70 s - with SPA fallback hosting you would get the loader shell inside the frame (inference). (F13)
9. `new Response(string)` is `text/plain;charset=UTF-8`; streams and ArrayBuffers have no Content-Type at all; `nosniff` plus wrong type blocks scripts and styles; modules and `instantiateStreaming` need exact types. `mime/lite` has no `.ico/.m3u8/.eot/.flac/.jxl/.srt`, and `.ts` is `video/mp2t`. (F18)
10. Safari probes media with `Range: bytes=0-1`; answer 206 with `Content-Range`. `Cache.put`/`add` throw on 206 and on non-GET or non-http(s) requests. Workbox's helper 416s when `end` > size instead of clamping. (F17)
11. A SW-built `Response` for navigation must not be a `redirected` response from the Cache API unless the request allows it (general Fetch rule, not re-verified here) - store final responses only.
12. Hash fragments are not sent to the server but Chromium leaks them into `event.request.url` on reload - strip `url.hash` as IPFS does; do not rely on `#magnet:` being visible to the SW. (F4)
13. Safari first-install flakiness (SW not active after reload, loops of 4-5 reloads) and CDN-stale bootstrap loops both happened to IPFS in 2026; add loop guards and no-cache deploys. (F6, F20)
14. Amazon S3/CloudFront: `sw.js` must be served from the page's own origin (spec 6.3.1: "service workers cannot be hosted on CDNs"; `importScripts()` may pull from a CDN), must have a JavaScript MIME type (spec 6.6; a `binary/octet-stream` upload default would be rejected) and must not be cached long; the SPA fallback for deep links must return HTTP 200 with the shell (S3 website error documents are served with status 404 unless CloudFront rewrites them - general AWS behaviour, not fetched here).
15. Firefox private windows: SW only from Firefox 140 (2025-06-24); MDN BCD says 139 but Mozilla's own bugs/release notes say 139 was disabled. ESR 128 never gets it. (F15)
16. Safari Lockdown Mode disables ServiceWorkers, Cache API, CacheStorage and Web Locks (WebKit 16.4 notes). Test every Safari scenario with Lockdown Mode both on and off; the only user-side override is the per-site exemption. (F15)
17. iOS: ITP deletes SW registrations, Cache and IndexedDB of Safari-tab sites after 7 days of Safari use without interaction; Home Screen apps are exempt; storage is not shared between Safari and the installed app. (F21)
18. iOS WKWebView-based browsers and in-app browsers may have no `navigator.serviceWorker`; Apple (Feb 2025) says there is no supported way to enable it. (F15)
19. WebTorrent 3.0.21 browser default store needs `FileSystemFileHandle.createWritable` (Safari 26+) else RAM; `fsa-chunk-store` deletes the shared `chunks` OPFS directory at import time ("can be bad when multiple instances of this app are running") - another reason to elect one host tab. (F14b)
20. `WindowClient.ancestorOrigins` exists only in Safari 16+; use your own handshake to find the host client. (F22)
21. `clients.matchAll()` returns nested iframe clients too; WebTorrent asks every window and takes the first answer, so decide which window is the host (announce role) to avoid the site frame or a second loader tab answering.
22. Service Worker static routing (`addRoutes`) exists in Chrome 123 and Safari 27 only; do not depend on it.
23. Extension-SW timeouts (30 s idle / 5 min / 30 s fetch) published by Chrome apply to extensions; for web SWs use the Chromium source constants (30 s idle, 5 min event) and the experiment.
24. A project named KayleePop/magnet-web already exists (MIT). (F3)

---

## 5. Open questions

1. Safari/WebKit (macOS 27 and iOS 26/27) was not run: confirm on devices (a) sandbox/SW control behaviour, (b) idle/termination while a stream is open, (c) private browsing registration, (d) Lockdown Mode behaviour in 2026 (WebKit 2023 notes vs the 2026 blog claim), (e) Home Screen app behaviour including backgrounding and WebRTC data channels, (f) behaviour of a SW-handled navigation that waits close to 70 s.
2. Firefox 158 / ESR 140 was not run: confirm the ~60 s limit for a pending `respondWith`, whether a streamed response is killed at ~30 s without keep-alive pings, whether hard reload bypasses iframe navigations, and `cancel()` propagation (WebTorrent comment).
3. Which iOS third-party browsers (Chrome, Edge, Firefox, Brave, DuckDuckGo) expose `navigator.serviceWorker` on iOS 26/27? Only a 2020 report (Chrome/Edge) and Apple's 2025 forum answer exist.
4. Samsung Internet Secret mode, Edge InPrivate, Brave private/Tor windows: no sources found; test.
5. Can a SW read OPFS on all three engines (`navigator.storage.getDirectory()` in `ServiceWorkerGlobalScope`)? BCD lists `WorkerNavigator.storage` generally; per-engine SW exposure unverified. If yes, the SW could read completed files straight from WebTorrent's `fsa-chunk-store` layout.
6. Exact WebKit SW timers when a page is open (the code shows client-based lifetime and a 10 s idle sweep); validate on iOS with a stream open for >60 s.
7. Origin strategy for hub mode: is wildcard DNS+TLS (CloudFront + ACM wildcard) and PSL listing acceptable for "static S3 only" hosting? How long does a PSL submission take?
8. Why Planktos stopped: no maintainer statement found; could be asked in issue #93 or inferred only.
9. Whether to build a no-SW fallback renderer and for which browsers (Lockdown, Tor, in-app, old Firefox private).
10. Does the 7-day ITP cap also remove the loader's chain/DB data for Safari-tab users in practice, and how do we warn them? (WebKit documents it; field behaviour not measured.)
11. Time-to-first-byte budget: how long can first load wait for tracker + peers + metadata before the 25-30 s navigation budget forces an interstitial? Needs the WebRTC/tracker research (topics 02/03).

---

## 6. Source index (every URL below was fetched or executed during this research)

Dates are the source's own date where it has one; otherwise "state on 2026-10-14".

Prior art
- S1 https://github.com/xuset/planktos - README summary (WebFetch). State 2026-10-14; 537 stars.
- S2 https://raw.githubusercontent.com/xuset/planktos/master/README.md - README (WebFetch, summarised).
- S3 https://github.com/xuset/planktos/wiki - wiki "Home", last edited 2017-02-25.
- S4 https://github.com/xuset/planktos/commits/master - commit list; latest 2018-09-18, earliest visible 2017-02-12.
- S5 https://registry.npmjs.org/planktos - versions (0.3.1 = 2017-03-04), modified 2022-06-24.
- S6 https://api.github.com/repos/xuset/planktos (+ /issues, /issues/{93,4,55,56,29}, /git/trees/master) - repo metadata, issues; #93 2023-12-20; #29 comment 2018-04-03.
- S7 https://raw.githubusercontent.com/xuset/planktos/master/{sw.js,install.js,index.js,lib/snapshot.js,lib/middleware/index.js,lib/middleware/inject.js,lib/middleware/range.js,lib/middleware/cache.js} - source.
- S8 https://github.com/xuset/aether-torrent - README.
- S9 https://github.com/KayleePop/magnet-web (+ https://github.com/KayleePop/magnet-web/commits/master.atom) - README; last commit 2022-12-14. Atom feeds also read for https://github.com/retrohacker/peerweb.js/commits/master.atom (2016-02-15) and https://github.com/Weedshaker/PeerWebSite/commits/master.atom (2024-11-02).
- S10 https://github.com/Omodaka9375/peerweb (+ https://github.com/Omodaka9375/peerweb/commits/main.atom) - README; last commit 2025-10-07.
- S11 https://news.ycombinator.com/item?id=46829582 - discussion (about January 2026; relative dates only).
- S12 https://github.com/GoogleChrome/workbox/issues/1375 - 2018-03-17 / 2018-05-22.
- S13 https://github.com/webtorrent/webtorrent/issues/2635 - 2023-08-03, no replies.

IPFS service-worker-gateway
- S14 https://github.com/ipfs/service-worker-gateway and https://raw.githubusercontent.com/ipfs/service-worker-gateway/main/README.md - README, maintenance note.
- S15 raw files under https://raw.githubusercontent.com/ipfs/service-worker-gateway/main/: CHANGELOG.md, docs/DEVELOPMENT.md, docs/CLOUDFLARE_SNIPPETS.md, SECURITY.md, src/index.tsx, src/sw/sw.ts, src/sw/handlers/{index,asset-request-handler,content-request-handler,uri-router-handler}.ts, src/sw/lib/{verified-fetch,update-redirect,sw-config}.ts, src/lib/{register-service-worker,is-browser-supported,get-subdomain-parts,constants,path-or-subdomain}.ts, src/ui/pages/{about,origin-isolation-warning,no-service-worker,unsupported-browser}.tsx. State 2026-10-14 (v3.5.0).
- S16 https://api.github.com/repos/ipfs/service-worker-gateway (+ /releases, /git/trees/main) - v3.5.0 published 2026-10-06; pushed 2026-10-13.
- S17 https://github.com/ipfs/service-worker-gateway/issues/1159 (closed 2026-07-15), /issues/1155 (closed 2026-07-10), /issues/31 (closed 2024-12-05).
- S18 https://ipshipyard.com/blog/2026-ipfs-gateways-redirect-inbrowser-link/ - 2026-05-11.
- S19 https://ipshipyard.com/blog/2025-shipyard-ipfs-year-in-review/ - 2025 (undated page).
- S20 https://raw.githubusercontent.com/ipfs/in-web-browsers/master/README.md - roadmap entries through 2026-Q3 (Chromium bug 40410035, Tor SW work).
- S21 https://docs.ipfs.tech/how-to/address-ipfs-on-web/ - path vs subdomain gateway.
- S22 https://specs.ipfs.tech/http-gateways/subdomain-gateway/ - wildcard TLS, PSL.
- S23 https://registry.npmjs.org/@helia/verified-fetch and https://registry.npmjs.org/helia - latest 8.1.2 (2026-09-22) / 7.1.16 (2026-09-29).

WebTorrent
- S24 local package `node_modules/webtorrent` in this repo (3.0.21): package.json, CHANGELOG.md, index.js, lib/{server,worker,worker-server,file,torrent}.js, dist/{sw.min.js,webtorrent.min.js}; node_modules/{fsa-chunk-store,mime}.
- S25 https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/api.md and docs/faq.md.
- S26 https://registry.npmjs.org/webtorrent - 3.0.0 = 2026-05-24, 3.0.21 = 2026-07-27.
- S27 https://github.com/webtorrent/webtorrent/commits/master/lib/server.js.atom - history of lib/server.js (last change 2026-05-28).

Specs, tests, platform data
- S28 https://w3c.github.io/ServiceWorker/ - Editor's Draft fetched 2026-10-14 (sections 2.1.1, 2.5.1, 6.1, 6.5-6.7, Register, Handle Fetch, Cache.put).
- S29 https://raw.githubusercontent.com/web-platform-tests/wpt/master/service-workers/service-worker/sandboxed-iframe-fetch-event.https.html, .../sandboxed-iframe-navigator-serviceworker.https.html and resources/sandboxed-iframe-fetch-event-iframe.{py,html}.
- S30 https://wpt.fyi/api/runs?product=chrome&product=firefox&product=safari&label=stable&max-count=1 ; https://wpt.fyi/api/search (POST) ; https://storage.googleapis.com/wptd/5bc305801de6625b39d8360fdb51b477a9c0a27f/firefox-158.0-linux-22.04-b44c1584be-summary_v2.json.gz - runs 2026-10-13/14: Chrome 155.0.8059.79, Firefox 158.0, Safari 27.0.
- S31 https://fetch.spec.whatwg.org/ - "extract a body".
- S32 https://w3c.github.io/webrtc-pc/ - IDL exposure of RTCPeerConnection / RTCDataChannel.
- S33 https://github.com/w3c/ServiceWorker/issues/1437 (opened 2019-06-19; last comment 2024-05-04) and /issues/1558 (2020-12-17; closed 2021-02-05; last comment 2024-07-03).
- S34 MDN browser-compat-data raw JSON (https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/{Navigator,Response,Clients,FetchEvent,NavigationPreloadManager,ServiceWorkerContainer,ServiceWorkerRegistration,ServiceWorker,ReadableStream,InstallEvent,Request,WindowClient,WorkerNavigator,FileSystemFileHandle,FileSystemWritableFileStream,FileSystemSyncAccessHandle,StorageManager}.json and .../http/headers/{Cross-Origin-Embedder-Policy,Cross-Origin-Opener-Policy}.json) and https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/serviceworkers.json - fetched 2026-10-14.
- S35 MDN pages: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers ; https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules ; https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Content-Type-Options ; https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static ; https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection ; https://developer.mozilla.org/en-US/docs/Web/API/InstallEvent/addRoutes ; https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/139 and /140 ; https://github.com/mdn/browser-compat-data/issues/29366 (opened 2026-03-30, closed 2026-08-14).

Engines
- S36 Chromium sources (raw GitHub mirror, main, 2026-10-14): content/browser/service_worker/service_worker_version.{h,cc}; third_party/blink/renderer/modules/service_worker/{service_worker_event_queue.h,service_worker_event_queue.cc,service_worker_global_scope.cc,fetch_respond_with_observer.cc}; third_party/blink/public/mojom/service_worker/service_worker.mojom.
- S37 https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle - extension SW lifetime (30 s / 5 min / 30 s).
- S38 Firefox sources (https://raw.githubusercontent.com/mozilla-firefox/firefox/main/modules/libpref/init/StaticPrefList.yaml and .../all.js, 2026-10-14).
- S39 Bugzilla: https://bugzilla.mozilla.org/show_bug.cgi?id=1320796 ; ...1959535 ; ...1967568 ; ...1302715 ; ...1588838 ; Firefox 140 release notes https://www.firefox.com/en-US/firefox/140.0/releasenotes/ (2025-06-24).
- S40 WebKit sources (raw GitHub mirror, main, 2026-10-14): Source/WebCore/workers/service/server/{SWServer.h,SWServer.cpp,SWServerWorker.cpp,SWServerToContextConnection.cpp}, Source/WebCore/workers/service/context/ServiceWorkerThread.{h,cpp}, Source/WebKit/NetworkProcess/{NetworkSession.cpp,NetworkProcess.h,NetworkProcess.cpp}, Source/WebKit/NetworkProcess/ServiceWorker/ServiceWorkerFetchTask.cpp.
- S41 WebKit blog/pages: https://webkit.org/blog/8090/workers-at-your-service/ (2018-02-07) ; https://webkit.org/tracking-prevention/ ; https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ (2020-03-24) ; https://webkit.org/blog/14403/updates-to-storage-policy/ (2023-08-10) ; https://webkit.org/blog/13966/webkit-features-in-safari-16-4/ (2023-03-27) ; https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ (2026-09-17).
- S42 https://developer.apple.com/forums/thread/773539 (2025-01..09) ; https://developer.apple.com/forums/thread/126923 (2019-12) ; https://firt.dev/ios-14/ (2020-09-16) ; https://firt.dev/notes/pwa-ios/ (updated 2026-10-13).
- S43 https://alexi.sh/posts/ios-lockdown-mode-4-years-later-2026 (2026-06-08; secondary, unverified).

Guides and helper code
- S44 https://web.dev/articles/service-worker-lifecycle ; https://web.dev/navigation-preload/ ; https://web.dev/articles/sw-range-requests ; https://developer.chrome.com/docs/workbox/serving-cached-audio-and-video ; https://developer.chrome.com/docs/workbox/modules/workbox-navigation-preload ; https://philna.sh/blog/2018/10/23/service-workers-beware-safaris-range-request/ ; Workbox source https://raw.githubusercontent.com/GoogleChrome/workbox/v7/packages/workbox-range-requests/src/{createPartialResponse.ts,utils/calculateEffectiveBoundaries.ts,utils/parseRangeHeader.ts} ; https://web.dev/articles/coop-coep.
- S45 https://github.com/gzuidhof/coi-serviceworker (README + coi-serviceworker.js v0.1.7).

Own experiments
- S46 Chromium 156.0.8078.4 harness and results: `docs/research/labs/04-sw-experiment/` in this repo (section 7).

Search-only (listed in results, not opened): Distribyted Gate (HN comment), Samsung Internet support pages, Brave Tor-window threads, Chromium issue 40410035 (needs sign-in), Workbox ticket on precache 206.

---

## 7. Artifacts created

- `docs/research/labs/04-sw-experiment/{sw.js,index.html,server.mjs,RUN.txt,results-chromium-156-2026-10-14.txt}` - the Chromium harness and the raw results quoted in 2.11. Test code only; Chromium-only; Firefox/Safari not covered.
