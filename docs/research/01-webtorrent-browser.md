# 01 - WebTorrent in the browser: state of play on 2026-10-14

Research topic 01 for `magnet-web`. Scope: what `webtorrent` can and cannot do as the browser engine of a
"load a website by magnet link, seeded by other visitors" loader, with exact versions, exact APIs and measured behaviour.

- Researcher: research subagent, 2026-10-14. Package under study: **`webtorrent@3.0.21`** (npm `latest`, published 2026-07-27).
- Method: (1) read the published npm tarball (integrity-checked against the registry's sha512) and the dependency tarballs
  it pulls in; (2) read upstream docs/CHANGELOG/issues on GitHub; (3) pulled MDN browser-compat-data 8.1.5 (built 2026-10-08);
  (4) **executed 12 browser experiments** (headless Brave 155.1.97.56 = Chromium 155, macOS 27, Apple Silicon, pages served from
  `http://127.0.0.1` = secure context) against the official `dist/webtorrent.min.js` plus a local official `bittorrent-tracker@11.2.3`
  WebSocket tracker. Harness, pages and raw JSON results are in `docs/research/labs/01-webtorrent-lab/` (reproducible: `fetch-deps.sh`, `run-page.sh`).
- **What was NOT executed:** Firefox, Safari/WebKit (desktop or iOS), Android, Samsung Internet. A Firefox 158.0 DMG was downloaded and
  hash-verified but mounting it was denied by the permission system, so no Firefox run exists; the user's own Safari 27 runs with Lockdown Mode
  and was deliberately not driven. Every non-Chromium statement below comes from source code, MDN BCD, vendor blogs or issue trackers and is
  labelled as such.

Evidence tags used in the findings: **[X]** executed in the lab (Chromium 155 only) - **[C]** read in the 3.0.21 / dependency source -
**[D]** upstream docs - **[B]** MDN browser-compat-data 8.1.5 - **[W]** web source (blog, issue, forum) - **[I]** inference.
Confidence: **High** = source + executed or two independent primary sources; **Medium** = one primary source or Chromium-only execution
generalised; **Low** = inference or secondary/unverified.

---

## 1. Summary

1. **Latest is `webtorrent@3.0.21`** (2026-07-27). 3.0.0 (2026-05-24) is a Node-22-only major; diffing the 3.0.21 and 2.8.5 tarballs shows the browser-visible changes
   are tiny (`createServer` now accepts a worker in state `activating`; `file.streamURL` percent-encodes each path segment; `throttleUpload/Download` round and accept only `-1` as a negative;
   new `userAgent` option; PE/MSE rework is Node-only; `webconn.js`, `worker*.js`, `file-iterator.js`, `selections.js` byte-identical). Project is alive
   (last commit 2026-09-29, 78 open issues, npm trusted-publisher provenance) but the release cadence is dependency-bump driven.
2. **The browser build is `dist/webtorrent.min.js`: an ES module with a default export, no global, 222,929 B raw / 64.4 KB gzip / 55.9 KB brotli-11.**
   `import WebTorrent from './webtorrent.min.js'`. The README line saying it "exposes WebTorrent on the window object" is stale, and the README's
   `cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js` URL silently serves **v1.9.7's 895 KB UMD bundle**. Pin exact versions and the `/dist/` path.
3. **Browser peers are WebRTC-only.** No TCP, uTP, DHT, LSD or PEX in the browser build (excluded through the package `browser` field). The only
   discovery paths are **WebSocket (wss://) trackers**, web seeds and manually added `simple-peer` objects. Default ICE is STUN only
   (Google + Twilio), no TURN. Public WSS trackers alive on 2026-10-14: `tracker.openwebtorrent.com`, `tracker.webtorrent.dev`, `tracker.novage.com.ua`;
   dead: `tracker.btorrent.xyz`, `tracker.fastcast.nz`, `tracker.webtorrent.io` (the upstream docs' sample magnet still lists the dead ones).
4. **BitTorrent v2 / hybrid is not implemented** (BEP 52 is "not implemented" in upstream's own table; issue #1117 open since 2017, no PR).
   v1 infohash (SHA-1) only. A pure-v2 magnet (`xt=urn:btmh:...` only) fails with `Invalid torrent identifier` [X]; a hybrid magnet works because only the
   `btih` part is used [X]; hybrid padding files are not special-cased [C].
5. **Web seeds work in the browser** (BEP 19) [X], but the HTTP seed needs a real CORS preflight answer: the browser sends
   `Access-Control-Request-Headers: cache-control` (WebTorrent sets `Cache-Control: no-store`), plus `Range`. ACAO-only is not enough [X].
   A magnet with only `ws=` cannot bootstrap metadata; add `xs=<url of .torrent>` (plain CORS GET, no preflight in Chromium) or have a peer [X].
6. **The built-in Service Worker renderer (`client.createServer`) cannot render a website.** Measured on Chromium 155: every response carries
   `Content-Security-Policy: base-uri 'none'; frame-ancestors 'none'; form-action 'none'` (since v2.0.0), so an iframe of an HTML file is blocked; top-level
   navigations (`request.destination === 'document'`) are forced to download; `sandbox="allow-scripts"` (opaque origin) iframes bypass the SW; and with
   **two same-origin tabs open the stock SW answered 0 of 120 requests correctly** (it broadcasts to every window and the first reply wins - the other tab replies 404) [X].
   A custom Service Worker serving from Cache Storage/IndexedDB has none of these problems [X] (and is what `docs/ARCHITECTURE.md` already specifies).
7. **File API in 3.x:** `file.blob()`, `file.arrayBuffer()`, `file.stream()` (W3C ReadableStream), `file.createReadStream()`, `file[Symbol.asyncIterator]`,
   `file.streamURL`, `file.streamTo(elem)`. **Removed:** `getBlob`, `getBlobURL`, `getBuffer`, `appendTo`, `renderTo` (all `undefined` [X]); `client.download` is also `undefined` [X].
8. **Storage:** default browser store is OPFS (`fsa-chunk-store`) when `getDirectory` and `createWritable` exist (a Safari < 26 polyfill via a blob module Worker is bundled), else memory.
   `fsa-chunk-store` **deletes the OPFS root directory named `chunks` on every import** [X]. `idb-chunk-store@1.0.1` (2021) is CommonJS and needs a global `Buffer`; without it,
   reads **hang forever with no error callback** [X]. A 25-line Uint8Array IndexedDB store works and persists [X]. Any abstract-chunk-store class works via `store`; an instance via `preloadedStore`.
9. **`client.seed()` is deterministic** for the same ordered file list + names + `name` + `pieceLength` + `private` flag [X]; creation date, `created by`, announce list, `urlList`
   and `File.lastModified` do not change the infohash [X]. File order does [X]. Pin `pieceLength`, sort files, pass `announce: []`, and set `File.fullPath` (directory pickers' `webkitRelativePath` is ignored [C]).
10. **Wire extensions work as documented** [X]: `torrent.on('wire', (wire, addr) => wire.use(Ext))`, `Ext.prototype.name` required, optional `onHandshake / onExtendedHandshake / onMessage`,
    send with `wire.extended(name, Uint8Array)` (there is no `send`). **A single extended message is capped by the data channel: payload+1 byte <= 262,144 in Chromium; one byte more
    silently destroys the peer connection** [X]. Keep frames <= 16 KiB.
11. **Throttling traps** [X]: `uploadLimit: 0` / `client.throttleUpload(0)` freezes *all* outbound bytes of the client - including a downloader's own handshake and requests (a
    downloader with `uploadLimit: 0` never even fetched metadata) and all extension/gossip frames. Use a small non-zero rate or a choke lock. `uploads: 0` is leaky (first `interested` is unchoked immediately) [X].
12. **Mobile/other-engine risks that are documented, not executed here:** Safari Lockdown Mode disables Service Workers, Cache API and Web Locks (WebKit, 2023) and reportedly RTCDataChannel/WASM;
    WKWebView in-app browsers have no Service Worker (BCD `webview_ios: false`); Safari deletes script-writable storage after 7 days without interaction; Firefox private windows reject `navigator.storage.getDirectory()`;
    iOS suspends WebRTC when backgrounded; `unload/pagehide` do not fire reliably on mobile.
13. **Effective browser floor** of the 3.0.21 bundle (derived from syntax + APIs + BCD): Chrome/Edge 85 to parse, **Chrome/Edge 103 (124 for a non-partial `AbortSignal.timeout`), Firefox 100, Safari/iOS 16.0, Samsung Internet 27** to run web seeds; OPFS default store needs Firefox 111 / Safari 15.2.
    Upstream publishes no minimum and its CI (`.airtap.yml`) only lists "latest" with Safari commented out.

---

## 2. Findings

Source dates are given as `(fetched 2026-10-14; document date ...)`. All URLs are listed again in section 6.

### A. Version, packaging, CDN, bundle size

**F1 - Current version and release history.** `webtorrent` npm `latest` = **3.0.21**, published **2026-07-27T21:32:33Z**; it is the only dist-tag. 3.0.0 = 2026-05-24; 3.0.1-3.0.16 = 2026-05-25..29;
3.0.17-3.0.21 = 2026-07-27. Last 2.x: 2.8.5 (2025-11-30). Declared BREAKING CHANGE of 3.0.0: "Node 22+" only; other 3.0.0 items are dependency majors
(`bittorrent-protocol` 5, `bitfield` 5, `ut_metadata` 5, `ut_pex` 5, `torrent-piece` 4), a `userAgent` option, "port and connection exhaustion" and "setting throttleDownload as a float causes error" fixes.
3.0.12-3.0.16 = "pe tests", "http server encoding", "server path2", "utp speed". Repo: `webtorrent/webtorrent`, MIT, 31,442 stars, 78 open issues, last commit 2026-09-29, pushed 2026-10-08. npm shows
provenance (SLSA, GitHub Actions OIDC trusted publisher).
- Confidence: **High** [C][D]. Sources: npm registry packument (modified 2026-07-27), package `CHANGELOG.md` (3.0.21), GitHub releases page, GitHub repo API (2026-10-14).
- 2.8.5 -> 3.0.21 browser-visible diff [C]: `createServer` accepts `controller.active.state` `activating` (2.8.5 required `activated`); `file.streamURL` percent-encodes each path segment (2.8.5 did not);
  `throttleUpload/Download` now `Math.round` and return `false` for negatives other than `-1`; `client.userAgent` option; `secure` becomes a 0/1/2 number (Node-only; `bittorrent-protocol` excludes `mse.js` in browsers).
  `lib/webconn.js`, `lib/worker.js`, `lib/worker-server.js`, `lib/file-iterator.js`, `lib/selections.js` are byte-identical.

**F2 - The browser bundle is one ES-module file.** In the npm tarball: `dist/webtorrent.min.js` (222,929 B), `dist/sw.min.js` (1,297 B), `dist/webtorrent.chromeapp.js` (1,074,642 B, Chrome Apps only), plus `.map` files.
`webtorrent.min.js` ends with `export{i as default}`; there is **no** `window.WebTorrent` (0 matches) and a classic `<script src>` will fail. `package.json` is `"type":"module"`, `main: index.js`, no `exports` map, `engines.node >= 22`.
Size on the wire (measured 2026-10-14): raw 222,929 B; gzip-9 64,410 B; brotli-11 55,887 B; jsDelivr's on-the-fly brotli 66,074 B; unpkg gzip 64,405 B. (2.8.5: 218,115 / 63,645 / 54,912.)
Integrity: jsDelivr, unpkg and the tarball file are byte-identical. `sha384-IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7` (webtorrent.min.js),
`sha384-6VLZAD1S5Ya/1yPeOJ5JkR8sPSonm8x6H2Rrq5KxL/0ZH2EvJb/dHnlAkWjMJ321` (sw.min.js); sha256 hex `db4dca98cd135c732eeffdede3cf5f8febd0585a0eba4dc4d1effa1b901f4c3d` / `9aa1f71d26b4d4eb51786baa575309ca550fdfd9c96842fe25a3b643f2173da2`.
- CDN URLs that work: `https://cdn.jsdelivr.net/npm/webtorrent@3.0.21/dist/webtorrent.min.js` (ACAO `*`, `application/javascript`, immutable 1-year cache), `https://unpkg.com/webtorrent@3.0.21/dist/webtorrent.min.js` (ACAO `*`).
  `https://esm.sh/webtorrent@3.0.21/dist/webtorrent.min.js` returns a 225 B shim that re-exports esm.sh's **own rebuild** (`/webtorrent@3.0.21/es2022/dist/webtorrent.min.mjs`) plus a `/node/process.mjs` polyfill - not the official bytes.
- **Trap:** the README's `https://cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js` returns HTTP 200, 895,775 B, header `x-jsd-version: 1.9.7` (the old browserify UMD with a `window.WebTorrent` global).
  `.../webtorrent@3.0.21/webtorrent.min.js` is a 404 and so is the unpkg equivalent. Anything copied from older tutorials silently runs v1.9.7 with the legacy API.
- A Service Worker script cannot be registered from a CDN origin; `sw.min.js` (if used) must be self-hosted at the loader origin.
- Confidence: **High** [X][C]. Sources: npm tarball (sha512 verified), jsDelivr/unpkg/esm.sh responses (2026-10-14), upstream README (3.0.21).

### B. Browser support and minimum versions

**F3 - What upstream actually promises.** README: "Supports Chrome, Firefox, Opera and Safari"; `docs/api.md`: "To use WebTorrent in the browser, WebRTC support is required (Chrome, Firefox, Opera, Safari)". No minimum versions are published.
`.airtap.yml` lists `chrome`, `firefox`, `edge`, `and_chr`, `ios_saf` all at `latest`, with `safari` commented out (airtap/sauce issue #11), and the Sauce preset is annotated "Not used yet"; the CI job `test-browser` runs airtap on `ubuntu-latest`.
=> upstream gives no verifiable CI evidence for iOS Safari or Android Chrome. Confidence: **High** [D].

**F4 - Derived floors for `dist/webtorrent.min.js` 3.0.21.** The bundle is webpack + Terser only (no Babel; `scripts/browser.webpack.js`), so the floor is whatever syntax/APIs the sources use. Scan of the minified file [C] + BCD 8.1.5 [B]:

| Feature found in bundle | Chrome | Edge | Firefox | Safari / iOS | Samsung | Android WebView | iOS WebView |
|---|---|---|---|---|---|---|---|
| `??=` (1 use) | 85 | 85 | 79 | 14 | 14 | 85 | 14 |
| public class fields (2 classes) | 72 | 79 | 69 | 16 (14.1 partial: WebKit bug 236843) | 11 | 72 | 16 |
| `?.` (48) / `??` (12) | 80 | 80 | 74 / 72 | 13.1 | 13.0 | 80 | 13.4 |
| `BigInt()` (bencode ints) | 67 | 79 | 68 | 14 | 9.0 | 67 | 14 |
| `AbortSignal.timeout()` (web seed fetch, `.torrent` URL fetch) | 124 (103-123 partial) | 124 | 100 | 16 | 27 | 124 | 16 |
| ES modules / dynamic `import()` | 61 / 63 | 79 | 60 / 67 | 10.1 / 11.1 | 8.0 | 61 | 10.3 |
| `crypto.subtle.digest('SHA-1')` | 37 | 12 | 34 | 11 | 3.0 | 37 | 11 (**secure context only**) |
| `RTCPeerConnection` / `RTCDataChannel` | 56 / 24 | 15 / 79 | 44 / 22 | 11 | 6.0 / 1.5 | 56 | 11 |
| OPFS `getDirectory` (default store) | 86 | 86 | 111 | 15.2 | 21.0 | 109 | 15.2 |
| `FileSystemFileHandle.createWritable` (native) | 86 | 86 | 111 | **26** (polyfilled before) | 21.0 | 109 | 26 |
| Module `Worker` (used by the Safari createWritable polyfill) | 80 | 80 | 114 | 15 | 13.0 | 80 | 15 |

Not used by the bundle (0 matches): lookbehind regex, named groups, private `#fields`, static blocks, `structuredClone`, `Array.at`, `Object.hasOwn`, `replaceAll`, `SharedArrayBuffer`, `WeakRef`.
Verdict [I]: **parse floor = Chrome/Edge 85, Firefox 79, Safari/iOS 14.1** (class fields); **run floor with web seeds or `.torrent` URL fetches = Chrome/Edge 103 (124 to avoid the partial `AbortSignal.timeout`), Firefox 100, Safari/iOS 16.0, Samsung Internet 27**.
Where `AbortSignal.timeout` is missing every web-seed request throws inside `try { ... } catch (e) { return cb(e) }` in `webconn.js`, i.e. the seed fails silently. A sane product floor is "evergreen + iOS/Safari 16.4".
Confidence: **High** for the feature list [C], **Medium** for the derived floors (no execution on those engines).

**F5 - Secure context is mandatory.** The SHA-1 piece/infohash hashing is `crypto.subtle.digest` with **no JS fallback** in the bundle (1 match), and `SubtleCrypto` is HTTPS/localhost only (MDN). Service Workers are HTTPS/localhost only (MDN).
`bittorrent-tracker` silently skips `ws://` trackers when the page is `https://` (source comment "they throw SecurityError"); use `wss://`. Confidence: **High** [C][W]. Sources: MDN `Crypto.subtle` and `Service_Worker_API` (fetched 2026-10-14), `bittorrent-tracker@11.2.3/client.js`.

### C. Transport and peer discovery

**F6 - WebRTC only; WebSocket trackers are the only discovery mechanism.** README: "WebTorrent does **not** support UDP/TCP peers in browser"; "a browser-based WebTorrent client or 'web peer' can only connect to other clients that support WebTorrent/WebRTC".
`package.json` `browser` field maps to `false`: `./lib/conn-pool.js`, `./lib/utp.cjs`, `bittorrent-dht`, `ut_pex`, `@silentbot1/nat-api`, `net`, `http`, `fs` (->`fsa-chunk-store`), `load-ip-set`; `torrent-discovery` excludes `bittorrent-dht` and `bittorrent-lsd`; `bittorrent-tracker` excludes the HTTP and UDP tracker clients.
`docs/bep_support.md` (Browser column): DHT not implemented, PEX not implemented (webtorrent#1191), LSD "cannot be implemented", UDP tracker "cannot be implemented", uTP "cannot be implemented", BEP 19 web seeds **implemented**, BEP 53 `so=` implemented, BEP 52 not implemented.
[X] Two clients in one Chromium page connected through a local official WS tracker: `wire.type === 'webrtc'`, metadata via `ut_metadata` in 227 ms, 200 KB transferred and byte-identical, extension IDs `ut_metadata=1, lt_donthave=2` (no `ut_pex`).
`docs/faq.md`: "In the browser, WebTorrent can only download torrents that are explicitly seeded to web peers via a WebRTC-capable client."
Other peer paths: `torrent.addPeer(simplePeerInstance)` (the `Peer.createWebRTCPeer` path in `torrent._addPeer`) and web seeds. Confidence: **High** [X][C][D].

**F7 - Signalling mechanics and cost (what a mobile device pays).** [C] `bittorrent-tracker@11.2.3` WebSocket client: every announce generates **up to 5 new `RTCPeerConnection` offers** (`numwant = Math.min(opts.numwant, 5)`), `trickle: false` (waits for ICE gathering,
`simple-peer` `ICECOMPLETE_TIMEOUT` 5 s), offers expire after 50 s, tracker socket reconnect backoff = `min(2^retries * 10 s, 1 h) + random(0..5 min)`. Default announce interval constant is 30 s; the two live public trackers answered `interval: 120`.
WebRTC connect timeout 25 s, handshake timeout 25 s (`lib/peer.js`). Default ICE config in `@thaunknown/simple-peer@10.1.2`: `stun:stun.l.google.com:19302`, `stun:global.stun.twilio.com:3478`, **no TURN**; override with `new WebTorrent({ tracker: { rtcConfig: { iceServers: [...] } } })`.
Data channel send backpressure at 64 KiB `bufferedAmount`. Consequence: peers behind symmetric NAT / carrier-grade NAT with no TURN will fail to connect; blocked UDP makes first offers take ~5 s. Confidence: **High** [C]; real-world success rate **unknown**.

**F8 - Public WSS tracker liveness (probed 2026-10-14 from this network with a real WebTorrent announce/scrape over a WebSocket).**
`wss://tracker.openwebtorrent.com` LIVE (announce reply in 568 ms, `interval:120`; closes the socket on `scrape`); `wss://tracker.webtorrent.dev` LIVE (782 ms); `wss://tracker.novage.com.ua:443/announce` LIVE (scrape reply);
`wss://tracker.btorrent.xyz` DEAD (TCP connect error); `wss://tracker.fastcast.nz` and `wss://tracker.webtorrent.io` DEAD (DNS); `wss://tracker.files.fm:7073/announce` answers HTTP 403 "Request forbidden by administrative rules" to a non-browser handshake (browser behaviour unknown).
`create-torrent@6.1.3` appends by default `wss://tracker.btorrent.xyz`, `wss://tracker.openwebtorrent.com`, `wss://tracker.webtorrent.dev` plus 5 UDP trackers whenever neither `announce` nor `announceList` is passed; the upstream docs' sample magnet still lists the dead `btorrent.xyz` and `fastcast.nz`.
(A sibling report `02-wss-trackers.md` exists in this folder; it was not reviewed for this document.) Confidence: **High** for the probe date, **Low** for longevity [X].

### D. BitTorrent v2 / hybrid

**F9 - v2 and hybrid torrents are not supported in 2.x/3.x.** `docs/bep_support.md`: BEP 52 "not implemented" for Node and Browser (link webtorrent#1117). Issue #1117 ("BitTorrent v2: Transition to a new hash function, info structure and merkle trees"): open, labels `accepted`, `enhancement`,
no assignee, no linked PR; maintainer 2018-05-04 "Yep, I'd like to support BitTorrent v2... would like to see a PR"; 2025-05-26 "this is FOSS, you don't need to ask for permission, just make a PR"; last activity 2025-05-27.
Code [C]: `parse-torrent@11.0.24` requires `info.pieces` and computes the infohash as SHA-1 of the re-encoded `info` dict; `magnet-uri@7.0.10` parses `urn:btmh:1220<64 hex>` into `infoHashV2` but WebTorrent never uses it; nothing in `index.js`/`lib/` mentions `meta version`, `file tree`, `attr` or BEP 47 padding files.
Executed [X]: `magnet:?xt=urn:btmh:1220...` (v2 only) -> torrent `error: Invalid torrent identifier`; a hybrid magnet (`xt=urn:btih:H&xt=urn:btmh:1220...&ws=&xs=`) downloads normally using only `btih`.
Implications: (a) publish **v1-only** torrents (what `create-torrent` makes); (b) a hybrid `.torrent` created elsewhere would expose its `.pad/<n>` padding entries as ordinary files in `torrent.files` [C, not executed];
(c) integrity rests on SHA-1; practical chosen-prefix SHA-1 collisions exist (sha-mbles, 2020, ~45k USD) but a third party cannot substitute content for a given infohash without a second preimage - the publisher is the only party who could craft colliding content. BEP 52 itself: "For meta version 2 SHA2-256 is used"; handshake uses the 20-byte truncated v2 infohash.
Confidence: **High**. Sources: `docs/bep_support.md` (master, 2026-10-14), issue #1117 (fetched 2026-10-14), `parse-torrent`/`magnet-uri` source, BEP 52, sha-mbles.github.io.

### E. Web seeds (BEP 19), `ws=` and `xs=`, CORS

**F10 - Web seeds work in the browser build; requirements measured [X] (Chromium 155, cross-origin seed on another port).**
- Enabled by default (`webSeeds: true`); sources: `urlList` option of `client.add`, `ws=`/`as=` in the magnet, `url-list` in the `.torrent`, or `torrent.addWebSeed(url|conn)`. `maxWebConns` default **4**. Implemented with `fetch(url, { cache:'no-store', headers:{'Cache-Control':'no-store','user-agent':...,range:'bytes=a-b'}, signal: AbortSignal.timeout(60000) })`; HTTP status must be 2xx (206 expected) and the body is taken as the piece bytes, so **the server must honour `Range`**.
- **URL mapping:** single-file torrent -> the `ws` URL is requested verbatim (it must point at the file itself); multi-file torrent -> `<ws>/<file.path>` where `file.path` starts with the torrent name (`<ws>/site/index.html`). A request covers the *remaining part of one piece* (not 16 KiB blocks) and a piece that spans several files makes one request per file.
- **CORS (cross-origin seed):** measured preflight = `OPTIONS` with `Access-Control-Request-Method: GET` and `Access-Control-Request-Headers: cache-control` (Chromium does not forward the `user-agent` header WebTorrent tries to set; `range` is safelisted). Results: no CORS headers -> 0 bytes; `Access-Control-Allow-Origin: *` only (no `Allow-Headers`) -> 0 bytes;
  full answer (`ACAO: *`, `ACAH` echoing the request headers, `ACAM: GET, HEAD, OPTIONS`) -> 300,000 B in 204 ms, bytes identical. Firefox/Safari may add `user-agent` to the preflight list -> answer with `Access-Control-Allow-Headers: *` or echo the request header. `Access-Control-Expose-Headers` is not needed (only `res.ok` and the body are read).
- **Metadata bootstrap:** `magnet:?xt=urn:btih:H&ws=U` alone **never gets metadata** (6 s, 0 peers) [X]; adding `xs=<https URL of the .torrent>` fixes it (205 ms to done) [X]. The `xs` request is a simple CORS GET in Chromium (worked with `ACAO` only, no preflight observed), so `xs` + `ws` is a complete tracker-less/peer-less bootstrap from a static host. `xs` alone downloads metadata but no data [X].
- Confidence: **High** (Chromium), **Medium** for Firefox/Safari preflight header sets. Sources: `lib/webconn.js` + `lib/torrent.js` (3.0.21), `docs/api.md`, lab E3 (`results/report-e3.json` + `out/requests.log` summary in section 7).

### F. Storage: the `store` option, OPFS default, idb-chunk-store

**F11 - Chunk-store contract (3.0.21) [C][X].** `client.add(id, { store: Ctor, storeOpts, preloadedStore: instance, skipVerify, storeCacheSlots = 20, destroyStoreOnDestroy })`. `new Ctor(pieceLength, opts)` receives
`{ ...storeOpts, torrent, path, files, length, name: '<torrent.name> - <infoHash[0..8]>', addUID, rootDir, max }` (keys confirmed by execution). The object must implement the **callback-style** abstract-chunk-store API used by `chunk-store-iterator`:
`put(index, Uint8Array, cb)`, `get(index, { offset, length }, cb)` (return a `Uint8Array`), `close(cb)`, `destroy(cb)`; `chunkLength` and `length` properties help. `preloadedStore` is an **instance** (not a constructor) and is used as-is; combine with `skipVerify: true` to start seeding without hashing. Non-memory stores are wrapped in `CacheChunkStore` (20 slots) and `ImmediateChunkStore`.
A custom `MemStore` class and the IDB store of F13 both worked [X]. Confidence: **High**.

**F12 - Default browser store in 3.0.21.** `FALLBACK_STORE = (!process.browser || SUPPORTS_FSA) ? FSChunkStore : MemoryChunkStore` with `SUPPORTS_FSA = navigator.storage?.getDirectory && FileSystemFileHandle?.prototype?.createWritable`; in the browser `fs-chunk-store` is aliased to `fsa-chunk-store@1.3.0`.
`fsa-chunk-store` imports `createWritable.js`, which **polyfills `createWritable` for Safari < 26** using a module `Worker` created from a Blob URL and `createSyncAccessHandle` (so a CSP needs `worker-src blob:`), executed *before* webtorrent evaluates `SUPPORTS_FSA`, hence Safari 15.2-25 also take the OPFS path [I from module order; not executed].
Executed in Chromium [X]: layout `<OPFS root>/<torrent.name> - <infoHash8>/<pieceIndex>` (one file per piece); `torrent.destroy()` keeps the data and re-adding the same torrent in a new client completed from OPFS in 53 ms with no network; `torrent.destroy({destroyStore:true})` and `destroyStoreOnDestroy:true` + `client.destroy()` delete the directory;
**importing the bundle deletes an OPFS root directory named `chunks`** (`fsa-chunk-store/index.js` top level: `removeEntry('chunks',{recursive:true})`) - a user directory `mydata` survived, `chunks` did not. History: IDB support was dropped in v2.5.0 (2024-08-04, PR #2851; an earlier attempt #2553 shipped in v2.4.8 and was reverted the same day).
Quota/eviction: headless profile `navigator.storage.estimate()` = 2 GiB quota, `persisted()` false (best-effort). MDN: Safari deletes script-writable storage after 7 days of Safari use without interaction (WebKit ITP, 2020-03-24; Home Screen web apps exempt); Firefox best-effort group limit min(10 % disk, 10 GiB).
Confidence: **High** for Chromium behaviour, **Medium** for Safari/Firefox.

**F13 - `idb-chunk-store` and alternatives.** `idb-chunk-store@1.0.1` (published 2021-06-03, last registry modification 2022-11-08) is CommonJS (`require`, `module.exports`) and `get()` calls `Buffer.from(...)`.
[X] ESM-converted copy (only module plumbing changed) with WebTorrent 3.0.21: **without a global `Buffer`, writes succeed but every read throws `ReferenceError: Buffer is not defined` inside an un-caught async function, the callback is never invoked, and `file.arrayBuffer()` hangs forever**; with a 1-line `Buffer.from` shim reads work.
So it "works" only with a bundler-provided `Buffer`, and fails in the worst possible way. WebTorrent 2+ dropped Buffer (`uint8-util`). Recommended replacement: the ~25-line `IdbChunkStore` in `labs/01-webtorrent-lab/www/e8.html` (Uint8Array only): seed -> `client.destroy()` (data kept in DB `wt-chunks:<name> - <hash8>`) -> new client re-add completed from IDB in 52 ms, bytes identical, `destroy({destroyStore:true})` deleted the DB [X].
Alternatives: `memory-chunk-store@1.3.5` (bundled, used on engines without OPFS), `fsa-chunk-store@1.3.0` (bundled), `immediate-chunk-store@2.2.0`, `cache-chunk-store@3.2.2` (wrappers, 2021). Confidence: **High**.

**F14 - Private browsing and missing OPFS are not handled.** WebTorrent only tests that the API *exists*; MDN: `getDirectory()` throws `SecurityError`/`UnknownError` "in some browsers" in private browsing; Evolu issue #705 (about 6 weeks before 2026-10-14) reports exactly that in Firefox private windows. A failing `getDirectory()` makes the default store fail instead of falling back to memory [I from code]. Pass your own `store`/`preloadedStore`. Confidence: **Medium**.

### G. File and torrent object APIs

**F15 - File API in 3.0.21 (executed on a seeded torrent) [X][C].**
Present: `file.blob(opts?)` -> `Promise<Blob>` (type from `mime/lite`; **it buffers the whole range via `arrayBuffer()` first**), `file.arrayBuffer(opts?)`, `file.stream(opts?)` (W3C `ReadableStream` of `Uint8Array`), `file.createReadStream(opts?)` (streamx Readable),
`file[Symbol.asyncIterator](opts?)`, `file.streamURL` (string, **throws "No server created" until `client.createServer()` ran**), `file.streamTo(elem)` (sets `elem.src = streamURL`), `file.select(priority)`, `file.deselect()`, `file.includes(piece)`, properties `name, path, length, size, type, offset, downloaded, progress, done`.
`opts` = `{ start, end }`, both inclusive. **Removed (all `undefined` in 3.0.21):** `getBlob`, `getBlobURL`, `getBuffer`, `appendTo`, `renderTo`; `client.download` is also `undefined` although a JSDoc comment still says "Aliased as `client.download`". 2.0.0 changelog: "deprecate render-media", "deprecate getBuffer", "w3c-like File, file-iterator"; issue #2911 (2026-03) "file.renderTo is not a function".
`file.path` for a multi-file torrent = `<torrent.name>/<relative path>`; for a single-file torrent = the file name. `client.get(id)` is **async** (returns a Promise). `torrent.torrentFile` = `Uint8Array`; `torrent.torrentFileBlob` = `Blob` of type `application/x-bittorrent`; `torrent.magnetURI` = `magnet:?xt=urn:btih:<hex>&dn=<name>[&tr=...][&ws=...]`.
Confidence: **High**.

**F16 - Known open piece-selection bugs that matter for many-small-files sites.** #3083 (open, 2026-07): `file.deselect()` of one file drops a piece shared with an adjacent selected file, so the torrent hangs at 99 % (reporter lists v2.x/v3.x; workaround: select the wanted files again right after deselecting).
A website bundle is made of many tiny files that share pieces, so **never deselect individual files; always download the whole torrent** (`torrent.done`). #3104 (open, 2026-08, PR #3103 unmerged): `this.pieces[index]` is dereferenced while null in `downloaded` (hence `torrent.progress`), `_request`, `speedRanker`, `_hotswap`;
the reporter hits TypeErrors when polling `torrent.progress` while pieces verify and when seeking. Wrap reads of `progress/downloaded` in try/catch or derive progress from `'download'`/`'verified'` events. Confidence: **Medium** (issue reports, not reproduced here).

### H. The built-in Service Worker renderer (`client.createServer`)

**F17 - Mechanism and URL format [C][X].** `dist/sw.min.js` (1,297 B; source `lib/worker.js` + `lib/worker-server.js`) intercepts only fetches whose URL contains `<registration.scope>webtorrent/`. `/webtorrent/keepalive/` returns an empty Response; `/webtorrent/cancel/` is a stream-cancel capability probe; any other URL is forwarded with
`postMessage({ url, method, headers, scope, destination, type:'webtorrent' }, [MessagePort])` to **every** window client (`clients.matchAll({ type:'window', includeUncontrolled:true })`); the first client to answer on its port wins; bodies are streamed back chunk-by-chunk over the port.
In the page, `client.createServer({ controller: registration })` (the `controller` **must** be a `ServiceWorkerRegistration`, state `activating` or `activated` in 3.x, else "Worker isn't activated"; only one server per client: "server already created"; browser vs Node chosen by `typeof window`) creates a `BrowserServer` listening to `navigator.serviceWorker` `message` events and pinging `/webtorrent/keepalive/` every 20 s while streams are open.
**URL format is path-based:** `<scope path>webtorrent/<infoHash>/<each file.path segment percent-encoded>`, e.g. `/webtorrent/037ebdebc1d5717d1900550524f350b43156be13/site/index.html` (`file.streamURL` returns exactly that). `/webtorrent/` lists torrents, `/webtorrent/<infoHash>` lists files (HTML index pages), unknown file -> 404 HTML page.
Responses carry `Access-Control-Allow-Origin: *`, `Cache-Control: no-cache, no-store, must-revalidate, max-age=0`, `Accept-Ranges: bytes`, `Content-Disposition: inline; filename*=UTF-8''<name>`, `X-Content-Type-Options: nosniff`, DLNA headers, and Range -> 206 (single range only). The registration script must be same-origin (self-host `sw.min.js`); scope `/` needs the script at the origin root (or a `Service-Worker-Allowed` header). Confidence: **High**.

**F18 - The stock server cannot serve an HTML site (measured; Chromium 155) [X].**
1. Every response includes `Content-Security-Policy: base-uri 'none'; frame-ancestors 'none'; form-action 'none';` (present in v2.0.0, v2.1.0, v2.5.0, 2.8.5, 3.0.21). An `<iframe src="/webtorrent/<hash>/site/index.html">` fires `load` but is **blocked** (document unreadable, SecurityError on access, and the browser never requested `style.css`/`app.js`/`logo.svg`). The docs' claim "supports video, audio, images, PDFs, HTML, right out of the box" is wrong for HTML.
2. Requests with `request.destination === 'document'` (top-level navigation or `window.open`) are answered with `Content-Type: application/octet-stream`, `Content-Disposition: attachment` and the literal body `DOWNLOAD`; the popup stayed at `about:blank` [X].
3. `<iframe sandbox="allow-scripts">` (opaque origin, no `allow-same-origin`): the navigation **bypasses the Service Worker** and hits the network (the lab server saw `GET /webtorrent/<hash>/... sec-fetch-dest: iframe sec-fetch-site: same-origin` -> 404). With `allow-scripts allow-same-origin` the SW serves it [X]. (Same result with a custom SW in E7.)
4. Workaround that works without forking: wrap the instance method, `const orig = server.onRequest.bind(server); server.onRequest = (req, cb) => { if (req.destination === 'document') req = { ...req, destination: 'iframe' }; orig(req, res => { delete res.headers['Content-Security-Policy']; cb(res) }) }`. With it, a same-origin iframe (title/CSS/JS/image all applied) and a top-level popup rendered correctly [X].
   Also `frame-ancestors 'self'` instead of deletion works [X].
5. Bug: `BrowserServer.wrapRequest` begins `if (!req?.type === 'webtorrent' || !req.url) return null` (operator precedence: `!req?.type` is a boolean, so the first test is always false). Any `navigator.serviceWorker` message that has a `url` property is treated as a torrent request; other SW->page messages must not carry `url`.
Confidence: **High** (Chromium); the CSP/`destination` logic is engine-independent (source), the sandbox bypass is **Medium** (Chromium only).

**F19 - Multi-tab race (measured) [X].** With only one tab running a WebTorrent server, 40/40 fetches of a torrent URL returned 200. After opening **a second same-origin tab that merely ran `new WebTorrent()` + `createServer()` with no torrents**, 120/120 fetches from the first tab returned the 404 HTML page - the idle tab always answered first.
Any user with two tabs of the same loader origin (or a loader iframe that also boots a client) gets 404s. The same broadcast design means a site's own code must never run a second WebTorrent server on the origin. The stock SW is not viable for a loader that keeps tabs open; use a Service Worker that serves from storage it owns (F20). Confidence: **High** for Chromium, race outcome Medium (timing dependent; here 100 %).

**F20 - Custom Service Worker from Cache Storage works [X].** Prototype E7: magnet -> WebRTC download (metadata 365 ms, done 367 ms for a 4-file site) -> `cache.put('/site/<hash>/<relative path>', new Response(await file.blob(), {headers:{'content-type': file.type}}))` -> destroy **both** torrent clients -> iframe at `/site/<hash>/index.html` rendered with relative CSS/JS/SVG (title set by site JS, background colour applied, image width 10).
With a second tab open, 100/100 requests answered 200 (no race). The prototype SW ignores `Range` (returned 200 for a ranged request) - a production SW must slice Blobs and return 206 (as `docs/ARCHITECTURE.md` section 7 specifies). Sandboxed `allow-scripts` (opaque origin) iframe failed here too.
Caveats: Cache API/CacheStorage and Service Workers are **disabled by Safari Lockdown Mode** (F29) and absent in WKWebView apps (F30); ARCHITECTURE's degraded `srcdoc` mode is therefore not optional for iOS in-app browsers.
Confidence: **High** (Chromium).

**F21 - Firefox-specific limitation in the stock SW [C].** `worker-server.js`: "firefox doesn't support cancelling of Readable Streams in service workers, so we just empty it after 5s of inactivity" - when the `cancel` probe fails, every non-`document` stream is closed after 5 s without a chunk (truncated response if a piece is slow). Only relevant if the stock SW were used with incomplete torrents. Confidence: **Medium** (source comment; Firefox not executed).

### I. `torrent.torrentFile`, `torrent.magnetURI`, `client.seed()` determinism

**F22 - What changes the infohash (executed, 9 variants, same 4-file site) [X][C].**

| Variant | infohash |
|---|---|
| baseline: files in given order, `name:'site'`, `pieceLength:16384`, `announce:[]` | `037ebdebc1d5717d1900550524f350b43156be13` |
| same again (new client) | identical |
| different `creationDate` + `createdBy` | identical |
| `pieceLength` omitted (auto) | identical *for this tiny site* (auto = 16 KiB; computed by `piece-length`, can differ with size or library version) |
| `name` omitted (derived from common path prefix `site`) | identical |
| default announce list (adds 5 UDP + 3 WSS `tr=`) | identical infohash, **different magnet** (8 extra `tr=`) |
| `File.lastModified` changed | identical |
| files in reversed order | `83cac8aaf927c3fbd56a939662db55b507b8c727` (different) |
| `private: true` | `9f3131da06bf7e130a24cc27717f371554d42624` (different) |

`info` = `{ name, 'piece length', pieces, files[{length,path}] | length, private? }` (create-torrent 6.1.3); `creation date`, `created by`, `announce(-list)`, `url-list` are outside `info`. Consequently `torrent.torrentFile` **bytes** differ between runs unless `creationDate` is pinned, while the infohash does not.
Input rules [C]: file order = input order (not sorted); directory structure comes only from `file.fullPath || file.name` (a `webkitRelativePath` from `<input webkitdirectory>` is ignored); junk files (`.DS_Store`, `Thumbs.db`...) are filtered by default (`filterJunkFiles`); `opts.name` defaults to the common root folder, else the first file name, else `Unnamed Torrent <timestamp>`;
`maxPieceLength` default 4 MiB; `client.seed()` forces `skipVerify: true` and sets `created by: WebTorrent/0300`. Seeding the same infohash twice in one client logs "A torrent with the same id is already being seeded", destroys the new `Torrent` object and calls the `onseed` callback with the existing one. Confidence: **High**.

### J. Wire extension API

**F23 - Contract verified against `bittorrent-protocol@5.0.9` source and two live peers [X][C].**
`torrent.on('wire', (wire, addr) => wire.use(Ext))` where `Ext` is a **class with `Ext.prototype.name`** (throws `Extension class requires a "name" property on the prototype` otherwise); it is instantiated as `new Ext(wire)` and exposed as `wire[name]`.
Optional hooks: `onHandshake(infoHashHex, peerIdHex, { dht, fast, extended })` (both 40-char hex strings), `onExtendedHandshake(dict)` (called only if the peer's `m` map contains your name; dict = bencoded object, **byte strings arrive as `Uint8Array`**, e.g. `myflag` set via `wire.extendedHandshake.myflag = 'B-hello'`),
`onMessage(buf: Uint8Array)`. **There is no `send`**: use `wire.extended(nameOrId, Uint8Array | bencodable)`; it throws `Unrecognized extension: <name>` if the peer did not advertise it, so wait for `onExtendedHandshake` or test `wire.peerExtendedMapping[name]`.
Extension IDs are assigned in `use()` order per wire: built-ins first (`ut_metadata`=1, `lt_donthave`=2; no `ut_pex` in browsers), the user extension = 3. `wire.type` is `'webrtc'` or `'webSeed'`; `wire.peerId` hex, prefix `-WW0300-` for 3.0.x; `wire.remoteAddress` is only set when `getStats` yields it (the LAN IP in the lab).
**Timing:** `'wire'` is emitted from `Torrent._onWire` right after the remote handshake and **before** this side's extended handshake is sent (which happens in `bittorrent-protocol._onHandshake` after the `'handshake'` listeners return), and the extended handshake is never re-sent, so `use()` must happen inside that listener; the listener must be attached **synchronously on the `Torrent` returned by `client.add()`** (not in the `ontorrent` callback, which fires after metadata, i.e. after the first wire). Confidence: **High**.

**F24 - Message size limit (measured) [X].** Extended payloads of 1 KiB, 16 KiB, 64 KiB, 128 KiB, 200 KiB, 255 KiB and 262,143 B arrived intact; the next send (payload 262,144 B, i.e. 262,145 B on the data channel including the extension id byte) was accepted by `wire.extended()` without throwing but **destroyed the WebRTC connection** (`simple-peer` `_write` catches the `channel.send` error and calls `__destroy`); both wires logged `close` (run time +3,679 / +3,680 ms), `wire.destroyed` was already true when the loop reached 300 KiB, and the 300 KiB / 1 MiB sizes were never sent.
So in Chromium the hard cap per extended message = **262,144 bytes including the 1-byte extension id**, and violating it is silent. Other sources: MDN "most modern browsers support sending messages of at least 256 kilobytes"; RFC 8841 default `max-message-size` 64 KiB when the SDP attribute is absent (MDN); Mozilla (2017) Firefox receives up to 1 GiB but "keep messages at or below 64 KiB" to interoperate.
When `throttleUpload` is *enabled*, `speed-limiter` slices writes into `rate/10`-byte chunks, which would mask the cap; when disabled (-1, default) whole chunks go straight to `channel.send`. **Design rule: frames <= 16 KiB** (BitTorrent blocks are 16 KiB). Confidence: **High** (Chromium), **Medium** for Safari (a 2024-25 Japanese deck cites 256 KiB; unverified).

### K. Throttling, limits and "pause"

**F25 - Defaults and measured behaviour [C][X].** Client defaults: `maxConns` 55 per torrent, `uploadLimit`/`downloadLimit` -1 (unlimited), torrent `uploads` 10 unchoke slots (rechoke every 10 s), `maxWebConns` 4, `webSeeds` true, `seedOutgoingConnections` true, `secure` 1 (Node-only effect), `storeCacheSlots` 20.
Throttle accuracy [X]: 256 KiB at `uploadLimit: 32768` took 8,094 ms (ideal 8.0 s); `client.throttleUpload(65536)` set at runtime took 4,045 ms (ideal 4.0 s); unlimited took 294 ms.
**The upload throttle sits in the pipeline of every wire (`wire -> throttle -> conn`), so it limits *all* outbound bytes: handshakes, `request`/`interested`/`have` messages, extension frames and keep-alives, not just pieces.**
- `uploadLimit: 0` on a **downloader**: no metadata, 0 % after 10 s (a 512 B/s limit completed 128 KiB in 732 ms, 4096 B/s in 206 ms) [X]. So "0 = download only" is wrong; the smallest useful "mostly download" setting is a few hundred B/s.
- `client.throttleUpload(0)` on a seeder: 15 gossip frames sent in 3 s, **0 delivered** until `throttleUpload(-1)`; then all 15 arrived (no loss, ordering kept, wire stayed alive); a second downloader of another torrent from the same seeder did not complete during the freeze and finished after the restore [X]. `speed-limiter` polls the zero rate once per second.
- `throttleUpload(2048)` with 5 KiB/s of 1 KiB frames: 7 of 15 delivered in 3 s, the rest queued [X].
- `torrent.pause()` only stops connecting to new peers; it does **not** stop uploads and does not affect extension traffic (7/7 delivered) [X][D].
- `uploads: 0` at add time is leaky: the seeder still unchoked the first interested peer immediately (`wire.once('interested', () => wire.unchoke())`) and a downloader finished 128 KiB in <3 s; the 10-s rechoke would choke afterwards [X][C].
- A choke lock (override `wire.unchoke` with a no-op and call `wire.choke()`) is what `src/loader/torrent.js::lockWire` already does; it leaves handshakes and extension traffic untouched. Untested alternative: set the private `torrent._rechokeNumSlots = 0`.
Confidence: **High**.

### L. Destroy, cleanup and page lifecycle

**F26 - API and measured effects [X][D].** `client.destroy(cb)` destroys torrents, connections, the server and throttle groups (callback fired within 1-2 ms in the lab); it throws `client already destroyed` if called twice. `torrent.destroy({ destroyStore }, cb)` / `client.remove(id, { destroyStore })`; `destroyStoreOnDestroy` at add time. Errors: always listen to both `client.on('error')` and `torrent.on('error')` (torrent errors fall through to the client if the torrent has no listener).
`docs/api.md`: "If you don't want to retain data across sessions, make sure to manually destroy the torrent store when the page closes... on the `beforeunload` event at latest".
**Use `pagehide`, not `beforeunload`/`unload`:** Chrome's Page Lifecycle guide says `beforeunload`, `pagehide` and `unload` "are not fired" when a mobile user closes the tab/app and names `visibilitychange` (hidden) as the last reliable signal; web.dev (bfcache): close WebSocket/WebRTC/IndexedDB connections in `pagehide`/`freeze` and reopen in `pageshow` (`event.persisted`) / `resume`; some browsers refuse to bfcache pages with open WebRTC connections.
Chrome does not discard hidden pages that use WebRTC "unless resources are extremely constrained", but iOS Safari suspends WebRTC when the screen locks or Safari is backgrounded (Apple Developer Forums request, secondary). Safari 26.4 (2026-03-24) fixed "RTCDataChannel close events did not fire when RTCPeerConnection was closed" and Safari 27 beta (2026-06-08) fixed "RTCDataChannel did not check the SCTP buffered amount synchronously" - older WebKit may leave dead peers undetected until WebTorrent's own timeouts (30 s piece timeout, 25 s handshake).
Confidence: **High** for API, **Medium** for iOS behaviour.

### M. Project health and open issues (GitHub, fetched 2026-10-14)

**F27.** Open and relevant: #3083 (deselect hang, F16), #3104 (null piece, F16), #3112 "Regression of #1800: Torrent._debug throws after the torrent is destroyed" (2026-10-04), #3113 "Uncaught TypeError (this.swarm.private) when an encrypted incoming peer connects to a paused torrent" (Node PE, 2026-10-03), #401 "Fix WebRTC glare" (since 2015: simultaneous mutual connects destroy each other; no fix), #2064 "Unhandled error from simple-peer (Transport channel closed)" (2021, label area/browser),
#1931 "Client not destroying properly" (2024), #703 "maxConns ignored for incoming connections" (2026-07), #2954 "choke slow peers", #1117 BEP 52 (F9), #69 PE/MSE, #288 "WebRTC DHT", #2776 "Introduction example is broken on webtorrent.io/intro" (open since 2025-12). #3012 "Path Traversal" (open; Node `getFileModtimes`, attacker-controlled `file.path`; reporter says a PR exists; **no maintainer reply**) is Node-side - in the browser `file.path` only becomes OPFS names/URL paths.
Closed with maintainer statement: #1611 "Cannot stream on safari iOS" (opened 2019 for missing Media Source; closed 2026-06-04: "this was fixed ages ago with the introduction of the service worker server"). 8 open issues carry the `area/browser` label. Confidence: **High** for the list, **Medium** for impact.

### N. Platform gotchas for mobile and non-Chromium browsers (documented, not executed)

**F28 - Safari Lockdown Mode.** WebKit's own post (Safari 16.4, 2023-03-27): with Lockdown Mode "Disable ServiceWorkers", "Disable Cache API", "Disable CacheStorage API", "Disable the WebLocks API" (plus WebSpeech and font features). A 2026-06-08 third-party article ("hands-on testing, not official docs") additionally claims WebAssembly and `RTCDataChannel` are blocked since iOS 16 and that service workers "can still register, but their powers are cut" - this contradicts Apple's list on service workers and is **unverified**.
The project's user runs Safari 27 with Lockdown Mode; whether the loader works there is unknown (open question). Users can exclude a trusted site from Lockdown Mode.

**F29 - In-app browsers (WKWebView) have no Service Workers.** BCD: `ServiceWorkerContainer` -> `webview_ios: false`. Apple engineer on the developer forums: there is "no supported way" to enable service workers in WKWebView; developers report App-Bound Domains (max 10 domains) work unofficially; apps with the `com.apple.developer.web-browser` entitlement (Chrome/Firefox/Brave/Edge on iOS) get them. Instagram/Facebook/Gmail-style in-app browsers must be expected to lack SW/Cache API - feature-detect and fall back, or tell the user to open the page in the system browser.

**F30 - Storage and privacy modes.** Safari: script-writable storage (IndexedDB, localStorage, SW registrations and cache) is deleted after 7 days of Safari use without user interaction with the site (WebKit, 2020-03-24; Home Screen web apps exempt); MDN quota: browser apps ~60 % of disk per origin, embedded web content ~15 %. Firefox private windows: `getDirectory()` -> `SecurityError` (F14); Firefox service workers in private windows were fixed in Firefox 138/139 per Bugzilla 1320796 (ESR 128 `wontfix`) - **unverified** for release channels.

**F31 - iOS WebRTC data channels.** A 2025-11-28 post on `public-webrtc@w3.org` reports iPhone Safari file transfers of a few MB that start and stall while desktop works (no version, no repro, bugs not yet filed). WebKit fixes above (26.4, 27 beta) are related to close events and `bufferedAmount`. Plan for stalls: per-wire inactivity timeouts, small frames, retries.

**F32 - Samsung Internet / Edge / Brave** are Chromium-based; BCD maps Samsung Internet to Chromium releases (e.g. `AbortSignal.timeout` -> Samsung 27, OPFS -> 21). Brave note from the lab: two clients on one host only connected after `--force-webrtc-ip-handling-policy=default` (Brave hides host candidates by default; without STUN reachability the ICE check failed with "Connection failed" after ~15 s). Real peers use STUN, so this is a test-harness artefact, but it shows ICE depends on the browser's WebRTC IP-handling policy.

---

## 3. Recommendations for our design

### 3.1 Answers to the open `[RESEARCH-PENDING]` items in `docs/ARCHITECTURE.md` that belong to this topic

- **`[RESEARCH-PENDING: hybrid v2 torrents in webtorrent 3.x]` (section 13): not supported.** Publish **v1-only** torrents with `create-torrent` (what `tools/publish.mjs` does). Treat `btmh` as unknown; a pure-v2 pointer must be rejected with a clear message
  (WebTorrent itself says only `Invalid torrent identifier`). Hybrid `.torrent` files made elsewhere would show `.pad/<n>` entries in `torrent.files` - reject or filter them. Integrity stays SHA-1 (F9). Do not spend effort on v2.
- **`[RESEARCH-PENDING: confirm the recommended Node WebRTC shim for webtorrent 3.x]` (section 10, `seed.mjs`): no shim is needed in principle.** Since `webtorrent` 2.3.0 the Node build gets WebRTC through `@thaunknown/simple-peer` -> `webrtc-polyfill@1.2.2` -> `node-datachannel` (latest `0.33.4`, 2026-09-12; prebuilt native addon);
  `webtorrent-hybrid@6.0.0` (2024-06-02) is npm-deprecated with the message "native WebRTC support has been added to WebTorrent >= 2.3.0"; `webtorrent-cli@6.0.1` (2026-08-19) depends on `webtorrent ^3.0.0`, `engines.node >= 20`. In a browser `webrtc-polyfill` resolves to `browser.js`, i.e. the native `RTCPeerConnection` globals.
  **Not executed here** (no Node on the research machine; Deno skips native build scripts) - verify with a 10-line Node 22 script (seed a file with a `ws://127.0.0.1` tracker, fetch it from a browser tab, assert `wire.type === 'webrtc'`). If `node-datachannel` fails to load on some host, the `pin.mjs` fallback (Playwright Chromium as a durable visitor) already in the architecture is the safe default.

### 3.2 Recommendations (ordered by impact)

1. **Do not use `client.createServer()` / the stock `sw.min.js` for rendering.** Keep the planned custom Service Worker that serves from storage we own (F18-F20). Reasons, all measured: `frame-ancestors 'none'` CSP, forced download for `destination === 'document'`, broadcast-to-all-tabs race (0/120 correct with a second tab), Firefox 5-s stream timeout, the `!req?.type === 'webtorrent'` message-hijack bug, one server per client.
   If a stock-server fallback is ever wanted, wrap `server.onRequest` (F18 item 4) and guarantee a single tab (Web Locks/BroadcastChannel leader election) - but prefer not to ship it.
2. **Keep `allow-same-origin` on the render iframe.** In Chromium an `<iframe sandbox="allow-scripts">` navigation (opaque origin) is **not routed through any Service Worker** (F18.3, F20), so the SW-from-storage design cannot be combined with an opaque-origin sandbox. Real isolation between sites in hub mode needs a different *origin* (the `<btih>.hub.example` wildcard-subdomain design already in section 3 of the architecture), not a tighter `sandbox`.
   Implement `Range` (206) in the SW (the lab SW did not; ARCHITECTURE section 7 already requires it) and do not send `frame-ancestors` headers that exclude your own loader.
3. **Own the chunk store; do not rely on the default OPFS store.** Use a custom `store`/`preloadedStore` backed by IndexedDB Blobs (the planned `BlobChunkStore` + `skipVerify: true` + stored `.torrent` is the right shape; F11). Reasons: the default store (a) is OPFS and `fsa-chunk-store` wipes an OPFS directory called `chunks` at import, (b) fails or throws in Firefox private windows, (c) is evicted/ITP-capped like any storage, (d) needs a blob-Worker polyfill on Safari < 26.
   A working 25-line Uint8Array IDB store is in the lab (`www/e8.html`). **Do not use `idb-chunk-store`** (F13: needs `Buffer`, hangs silently). Never name an OPFS directory `chunks`.
4. **Magnet/pointer contents.** For static-host bootstrap use `magnet:?xt=urn:btih:<hex>&dn=<name>&xs=<https .torrent URL>&ws=<https web-seed base>&tr=<wss1>&tr=<wss2>`. `ws` alone cannot start a download (F10); `xs` is cheap (no preflight in Chromium) and removes the dependence on a tracker for metadata. Layout rules: single-file torrent -> `ws` is the file URL; multi-file -> `<ws>/<torrent name>/<path>` (matches `webseed-layout.txt` in the architecture).
   Strip nothing: `tr=` entries from the pointer must be merged, because the browser build has no other discovery.
5. **Web-seed host CORS (S3/CloudFront/GitHub Pages), minimum that worked:** `Access-Control-Allow-Origin: *`, answer `OPTIONS` with `Access-Control-Allow-Methods: GET, HEAD` and `Access-Control-Allow-Headers` that includes `cache-control` and `range` (simplest and future-proof: `*` or echo the request headers), `Access-Control-Max-Age`, honour `Range` with 206 + `Content-Range`. S3 equivalent (untested): `[{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]`.
   Behind CloudFront the preflight must reach/be answered by the edge (managed CORS-with-preflight response-headers policy, or forward `Origin`, `Access-Control-Request-Method`, `Access-Control-Request-Headers`) - **not tested here**. `Access-Control-Expose-Headers` is unnecessary for WebTorrent (it only reads `res.ok` and the body). GitHub Pages sends `ACAO: *` but its `OPTIONS` behaviour was not tested.
6. **Deterministic publishing** (so the same files always give the same `btih`, F22): sort files by path with a fixed comparator, give each `File` a `fullPath` of `<name>/<relative path>`, pass `name`, an explicit `pieceLength` (256 KiB in the architecture is fine; web-seed requests are per piece, so smaller pieces mean more, smaller HTTP requests), `announce: []` (otherwise 8 default trackers incl. dead ones are added to the torrent file/magnet), `urlList` explicitly, never `private`, and `creationDate` pinned if byte-identical `.torrent` files matter. Record `btih` in the signed pointer and have the loader reject a torrent whose parsed infohash differs.
7. **Download the whole torrent, never select/deselect files** (#3083 shared-piece hang) and do not poll `torrent.progress`/`downloaded` unguarded (#3104); drive progress from `'download'`, `'verified'`, `'done'` events or wrap reads in try/catch. Enforce `max=`/size caps on the `'metadata'` event (`torrent.length`) and `torrent.destroy()` early.
8. **Chain gossip over the wire extension (`mw_chain`)**: keep the planned frames <= 16 KiB (F24: > 262,143-byte extended payload silently kills the connection in Chromium; Firefox/Safari limits unverified, interop guidance is 64 KiB); register in the `'wire'` listener synchronously on the returned `Torrent` and also iterate `torrent.wires` (the architecture and `src/loader/torrent.js` already do);
   gate sends on `wire.peerExtendedMapping.mw_chain` (otherwise `wire.extended` throws); decode extended-handshake strings from `Uint8Array`; remember the extended handshake is sent once, so a late `use()` is invisible to the peer; unthrottled writes are passed whole to `RTCDataChannel.send`, so enforce the size cap yourself.
9. **Upload policy: never pass `0` to `uploadLimit` or `throttleUpload`.** It freezes handshake, requests, gossip and keep-alives (F25). The architecture's section 8 text "pause = `torrent.pause()` + `client.throttleUpload(0)`" and the table row "cellular: uploadLimit 0 (download only)" must be read as **choke lock**, which is what `src/loader/torrent.js::lockWire` implements correctly (it also covers wires created later and shadows `unchoke()` so the first-`interested` and 10-s rechoke paths cannot undo it).
   Edit the architecture wording so no builder passes 0 to WebTorrent. For a rate-limited (not off) mode use >= 512 B/s (measured working floor) and expect gossip frames to queue behind piece traffic. `torrent.pause()` does not stop uploads.
10. **Lifecycle:** flush chain state and call `client.destroy()` on `pagehide` (and `visibilitychange` -> hidden as the last reliable mobile signal); on `pageshow` with `event.persisted` or on `visibilitychange` -> visible, re-create the client or re-announce; add `online`/`offline` handlers; treat WebRTC data channels as dead after backgrounding on iOS and rely on timeouts + re-announce. Do not depend on `beforeunload`.
11. **Peers and NAT:** make `iceServers` configurable (`tracker.rtcConfig`); ship at least STUN from two vendors (WebTorrent's default is Google + Twilio) and plan for a TURN fallback because symmetric/carrier-grade NAT cannot connect without one (no data on real-world success rates; measure it in the e2e/field tests). Expect 5-s ICE-gather waits on UDP-blocked networks. Mobile cost: each announce creates 5 `RTCPeerConnection`s - lengthen the announce interval or lower `numwant` on cellular/background if battery matters.
12. **Trackers:** default list = `wss://tracker.openwebtorrent.com`, `wss://tracker.webtorrent.dev`, `wss://tracker.novage.com.ua:443/announce` plus the deployer's own (`tools/tracker.mjs` = official `bittorrent-tracker` server). Do not ship `tracker.btorrent.xyz`, `tracker.fastcast.nz`, `tracker.webtorrent.io` (dead 2026-10-14). Use `wss://` only on https pages. Re-probe before release (see `02-wss-trackers.md`).
13. **Boot-time feature detection** (`boot.js`): require ES modules, `crypto.subtle` (secure context), `RTCPeerConnection`, `AbortSignal.timeout`, `BigInt`, optional-chaining/`??=` parse (a dummy `import()` of a module that uses them catches parse failures), `ReadableStream`, IndexedDB; Service Worker + CacheStorage -> else degraded mode; show the floor table of F4 and a precise reason. The in-app-browser (WKWebView) and Lockdown-Mode cases land in the degraded path.
14. **Distribution of the library:** pin `webtorrent@3.0.21`, copy `dist/webtorrent.min.js` out of the integrity-checked tarball into the build (SRI `sha384-IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7`), never `@latest`, never the README URL, never esm.sh. Re-run `docs/research/labs/01-webtorrent-lab/fetch-deps.sh` to re-verify when bumping. Budget ~56 KB brotli / ~64 KB gzip for the library.
15. **Test plan additions** (project already depends on `playwright@^1.64.1`): run the e2e suite in Playwright **Firefox and WebKit** (not just Chromium) for: custom-SW rendering of CSS/JS/images, extension frames of 1/16/64/256 KiB, web-seed preflight, store persistence; Playwright WebKit is not Safari (no ITP, no Lockdown Mode) so also test on real iOS Safari (background/lock-screen, Lockdown Mode, private tab), Android Chrome and Samsung Internet. Keep `--disable-features=WebRtcHideLocalIpsWithMdns` and, for Brave, `--force-webrtc-ip-handling-policy=default`.
16. **Docs fixes to propagate:** upstream README/FAQ are stale in places (global `window.WebTorrent`, `@latest/webtorrent.min.js`, `render-media`/`videostream`, `appendTo/renderTo`, "HTML out of the box", `client.download`). Builders should trust `lib/*.js` in the pinned tarball, not the docs.
