# w1-13 - Toolchain facts (create-torrent, parse-torrent, magnet-uri, bittorrent-tracker, bundling, Playwright)

> STATUS: CHECKPOINT DRAFT written 2026-10-17 while the research is still running. Sections marked (PENDING) are not finished.
> Raw experiment code and outputs are in `docs/research/labs/w1-13-lab/` (see `README.md` there). This file is overwritten by the final version.

Evidence tags: [X] executed in the lab on this machine (macOS 27, Apple Silicon, Node 24.22.0, Playwright 1.64.1 = Chromium 156.0.8078.4,
WebKit 27.2 build 2370; **Firefox build 1555 (157.0) cannot start here**, see F-PW1) - [C] read in the installed package source - [D] upstream docs/README -
[W] web source - [I] inference. Confidence: High = executed or two independent primary sources; Medium = one primary source; Low = inference.

## Checkpoint findings (verified so far)

### create-torrent 6.1.3 [C][X]
- ESM only, `engines.node >= 12` (stale), browser build excludes `get-files.js`/`is-file` => string paths throw "filesystem paths do not work in the browser".
- `info` = `{ name, 'piece length', pieces, files:[{length, path}] | length, private? }` plus anything in `opts.info` and `sslCert` (`info['ssl-cert']`). Top level: `creation date` (always), `encoding: 'UTF-8'` (always), `announce`, `announce-list`, `comment`, `created by`, `url-list`.
- Piece length = `piece-length@2.0.1`: `max(16384, 1 << floor(log2(bytes/1024)+0.5))`, then `min(.., maxPieceLength=4 MiB)`. Measured: <16 MiB => 16 KiB pieces; 24 MiB => 32 KiB; 64 MiB => 64 KiB; 256 MiB => 256 KiB; 1 GiB => 1 MiB; 8 GiB => 4 MiB (cap). A 20 MiB single file => 1280 pieces, 25,725-byte `.torrent`.
- Same ordered input + same name + same pieceLength + no `private`/`info` extras => same infohash [X]. NOT in the hash: `creationDate`, `createdBy`, `comment`, `announce*`, `urlList` [X]. In the hash: file ORDER, `name`, `pieceLength`, `private` (even `private:false` writes `private: 0` and changes the hash), `info.*`, `sslCert`, `filterJunkFiles` side effects [X].
- `creationDate` traps [X]: `new Date(0)` or `0` is falsy => silently replaced by `Date.now()` (the `.torrent` bytes become non-reproducible); a plain number is read as MILLISECONDS (`1700000000` => 1,700,000 s); `new Date(1)` and `new Date(1000)` both => `1`. Use a pinned non-zero Date.
- Directory (string) input [X]: skips EVERY dot-file and dot-directory (`.well-known/`, `.htaccess`, `.nojekyll` all dropped) and uses `fs.readdir` order (sorted on APFS here; POSIX leaves it unspecified). Array-of-File/Uint8Array input keeps `.well-known/security.txt`, drops only dot-prefixed names matched by `junk` (`.DS_Store`), keeps zero-length files.
- Default `announce` list when neither `announce` nor `announceList` is passed: 5 UDP trackers + `wss://tracker.btorrent.xyz` (dead), `wss://tracker.openwebtorrent.com`, `wss://tracker.webtorrent.dev`.

### magnet-uri 7.0.10 / parse-torrent 11.0.24 [C][X]
- Case-sensitive: `MAGNET:?XT=URN:BTIH:..` and `MAGNET:?xt=..` return no infoHash (QR alphanumeric-mode uppercase does not parse). `stream-magnet:` works.
- btih accepted as 40 hex (any case) or 32 base32 (any case). NO validation: 40 chars of `z` accepted as an infoHash; 41+ chars truncated; **39 hex chars are decoded as base32 and yield a wrong, valid-looking infoHash**.
- `dn`, `tr`, `xs`, `ws`, `as` are `decodeURIComponent`-ed; malformed `%` throws `URIError` (parse-torrent surfaces `Invalid torrent identifier`). A value containing a raw `=` or `&` (unencoded tracker URL with a query, unencoded `xs` with `?v=1`) is silently dropped. `x.pe` values are NOT decoded. `ws` and `as` both land in `urlList`. `so=0,2,4-6` => `[0,2,4,5,6]`. `urn:btmh:1220<64hex>` => `infoHashV2` only; v2-only magnets are rejected by parse-torrent; hybrid works via btih.
- `torrent.xs` is only interpreted by WebTorrent as http(s) URL(s); `xs=urn:btpk:` (BEP 46) is parsed to `publicKey` but unused.

### `xs=` / `.torrent` URL / web seed across engines [X] (lab a3, official `dist/webtorrent.min.js` 3.0.21, memory store, no trackers)
| Case | Chromium 156 | WebKit 27.2 (Safari engine) |
|---|---|---|
| `xs=` or `client.add(url)`, host sends only `ACAO:*` | works, no preflight | FAILS: preflight with `Access-Control-Request-Headers: user-agent` (WebTorrent sets a `user-agent` header; WebKit honours it) |
| same, host answers OPTIONS with `Allow-Headers` echo or `*` | works | works |
| web seed, host sends `ACAO:*` only / OPTIONS without Allow-Headers | fails (preflight asks `cache-control`) | fails (preflight asks `cache-control, user-agent`) |
| web seed, full OPTIONS answer | works, **1 preflight per GET (13/13)** despite `Max-Age: 600` | works, 9-10 preflights for 13 GETs |
| **web seed on the SAME origin as the loader** | works, 0 preflights, no CORS headers needed | works, 0 preflights |

### bittorrent-tracker 11.2.3 server [C]
(see final version; PENDING live tests)

### Environment facts [X]
- Playwright Firefox 157.0 (build 1555) does not launch on this machine: every launch prints "You are running in headless mode. Could not find profile folder." and exits 1, with or without `-profile`, with HOME redirected (also reproduced independently in `labs/w1-09-lab/exp_ff.mjs`). Playwright WebKit 27.2 and Chromium 156 launch fine.

## Checkpoint 2 (2026-10-17, still draft)

### Own esbuild bundle of webtorrent 3.0.21 [X] (lab b1-build.mjs, esbuild 0.28.2)
- Builds first try in ~0.3 s. Needed (what `scripts/browser.webpack.js` does): `resolve.aliasFields: ['browser']` + the package's own `browser` map applied GLOBALLY (net, fs, http, os, crypto, bittorrent-dht, ut_pex, @silentbot1/nat-api, load-ip-set -> empty module; `fs-chunk-store` -> `fsa-chunk-store`), `path` -> `path-esm`, `process` -> `webtorrent/polyfills/process-fast.js` (shipped in the npm package), `global` -> `globalThis`. NOT needed: Buffer, stream, crypto, zlib polyfills (those are only in the Chrome-App build). `events` (npm `events@3.3.0`) is also bundled in the official build and is NOT installed by `npm i webtorrent` (webpack devDependency), so it must be installed or aliased.
- Sizes (raw / gzip-9 / brotli-11): official dist 222,929 / 64,410 / 55,887; esbuild plain 251,709 / 74,759 / 62,334; with target [es2020, safari15.4, chrome110, firefox115] 252,059 / 75,022 / 62,345; + 4 source patches 251,931 / 74,959 / 62,405; + stubs for create-torrent, lib/server.js, fsa-chunk-store 225,719 / 66,203 / 55,153; + no-op `debug` 219,353 / 63,796 / 53,114.
- Patches that matched exactly once (build fails otherwise): bittorrent-protocol `_onMessageLength` length cap; webconn.js drop `Cache-Control` and `user-agent` request headers; torrent.js `_getMetadataFromServer` drop `user-agent`; parse-torrent `remote()` drop `user-agent`.
- Result of the header patch (Chromium 156 AND WebKit 27.2): ZERO CORS preflights for `xs=`, `.torrent` URL and web-seed requests; a host that sends only `Access-Control-Allow-Origin: *` is enough (the official bundle needs OPTIONS answers with `cache-control` (+ `user-agent` in WebKit)). Same-origin web seed needs nothing at all.
- Two real browser contexts transfer a torrent over WebRTC through a local bittorrent-tracker with BOTH bundles in Chromium (metadata ~142 ms, done ~150 ms, sha256 equal); seeder used `preloadedStore` + `skipVerify` (the planned loader seeding path) and its infohash equals create-torrent's.

### Node 24 seeder -> browser [X]
- `webtorrent@3.0.21` in Node 24.22 gets WebRTC with no extra package (`@thaunknown/simple-peer` -> `webrtc-polyfill@1.2.2` -> `node-datachannel@0.32.3`, N-API prebuilt binary already in node_modules). WebTorrent 2.3.0 (2024-05-23) "Built-in-webrtc"; the README of 3.0.21 still tells Node users to use webtorrent-hybrid (stale).
- Verified Node seeder -> headless Chromium 156 download, `wire.type === 'webrtc'`, peerId prefix `-WW0300-`, sha256 equal, 270,652 bytes uploaded. LAB CAVEAT: on this machine UDP/TCP between a process and its own LAN address (192.168.18.5) is blocked, so the test forced libdatachannel onto loopback (`rtcConfig.bindAddress: '127.0.0.1'`, passed through by webrtc-polyfill's `...init`) and Chromium needed `--disable-features=WebRtcHideLocalIpsWithMdns --allow-loopback-in-peer-connection`; the browser had to be answer-only (`getAnnounceOpts: () => ({numwant: 0})`) because WebTorrent drops the working Node-initiated connection as a "duplicate" of the stuck browser-initiated one (glare, webtorrent #401).
- Node-side signalling costs a fixed 5.0 s per offer/answer (simple-peer `ICECOMPLETE_TIMEOUT`; the polyfill reports gathering 'complete' before the listener exists); it is not configurable from WebTorrent/bittorrent-tracker options.

### Playwright facts [X]
- Firefox 157 (build 1555) cannot launch on this macOS 27 machine ("Could not find profile folder", exit 1; reproduced in w1-09-lab). WebKit 27.2 launches and runs pages and Service Workers, but WebKit produces ZERO ICE candidates (gathering never completes, with or without STUN, with camera/microphone permission granted) so no WebRTC test in WebKit was possible here.
- Service Workers work in Playwright Chromium and WebKit on `http://localhost` and `http://127.0.0.1` (registration, `clients.claim()`, fetch interception incl. the `Range` header, SW-served iframe navigation). `context.serviceWorkers()` only sees Chromium workers (WebKit: 0). With `serviceWorkers: 'block'` the API is still present, `register()` RESOLVES and `navigator.serviceWorker.ready` never resolves (both engines): degraded-mode detection must use a timeout, not "API absent / register() rejects".
- Own-LAN-IP origins (`http://192.168.18.5:port`) time out on `page.goto` here, so the insecure-context path could not be exercised.

### BEP 47 padding [X]
- create-torrent emits no `attr`; WebTorrent 3.0.21 treats `.pad/<n>` entries as ordinary files (`torrent.files` contains `site/.pad/12768`, name `12768`) and requests them from the web seed: completes in 103 ms when the host serves them (zeros), NEVER completes (63 % after 12 s, request loop) when the host 404s `.pad/*`. webconn.js also asks for ranges past a file's end (`end = min(absolute fileEnd, relative rangeEnd)`), servers must clamp per RFC 9110.
- Synthetic 200-file site (2.97 MB), 6 edited + 4 new + 2 deleted files, 25 random trials, median reuse of v1 pieces by v2 (size overhead): 16 KiB pieces: no padding 6.1 % (0), pad big files only 83.1 % (+8.9 %), pad every file 96.8 % (+73.4 %); 64 KiB: 4.3 % (0) / 48.9 % (+3.6 %) / 95.4 % (+381 %); 256 KiB: 0 % (0) / 30.8 % (+12.4 %) / 95.1 % (+1692 %).

## Checkpoint 3 (2026-10-17, still draft)

### bittorrent-tracker 11.2.3 server, executed [X] (lab d1-tracker-semantics.mjs, d2-tracker-load.mjs)
- WS announce reply `interval = ceil(intervalMs/1000/5)`: default `interval` 600000 ms => **120 s for WS clients, 600 s for HTTP clients**. `numwant` is ignored: the server forwards `min(offers.length, other peers in swarm, 82)` offers, one offer per randomly chosen peer; extra offers are dropped silently (swarm of 5 + 10 offers => 5 delivered; swarm of 120 + 120 offers => 82 delivered). An `answer` is relayed to any `to_peer_id` in the swarm even with a made-up `offer_id` (not validated).
- `filter(infoHashHex, params, cb)` runs on announce only; `cb(new Error('x'))` returns `failure reason: x` and does NOT create the swarm (so it also bounds memory growth); `scrape` is not filtered and `scrape` without `info_hash` returns every swarm that exists. `/stats` (HTML) and `/stats.json` need `stats:true`; every other HTTP path answers 200 with a bencoded failure. Default `ws` `maxPayload` accepted a 1 MB message; `ws: { maxPayload: 65536 }` closes the socket with 1009. Per-swarm LRU keeps 1000 peers (1100 connected => 1000 kept). 
- TLS without a reverse proxy works: `new Server({ http: false, udp: false, ws: { noServer: true } })` + `https.createServer({key, cert})` + `httpsServer.on('upgrade', (req, sock, head) => s.ws.handleUpgrade(req, sock, head, ws => s.ws.emit('connection', ws, req)))`; wss client with a self-signed cert is rejected unless trusted.
- Load (Node 24.22, loopback, 100 swarms x 100 peers, 5 offers/announce, shared M3 Air): idle RSS 68 MB; 1k conns 101 MB; 5k 164 MB; 10k 235 MB => 17.1 KB per connection all-in, 14.2 KB marginal 5k->10k (heap 87 MB + external 39 MB at 10k). Announce throughput at 10k conns: 198/s 4 % of one core, 981/s 13 %, 2,925/s 31 %, 5,888/s 54 % (p50 11.7 ms, p99 41 ms), 24.8k forwarded offers/s at the top rate. At the default 120 s interval 10k peers announce ~83/s (~1 % CPU).

### Deno 2.9.7 [X]
- create-torrent, parse-torrent, bittorrent-tracker server + ws client, WebTorrent seed and node-datachannel polyfill all work and give the SAME infohash as Node 24.22 (`d886fd36...`), but only after `deno install --allow-scripts=npm:node-datachannel` (Deno skips lifecycle scripts; without it `Cannot find module '../../../build/Release/node_datachannel.node'`) and with `--allow-ffi` (N-API addon: "Requires ffi access"); bare `import 'node-datachannel/polyfill'` needs the package declared in package.json.

### node-datachannel packaging [X][W]
- WebTorrent 3.0.21 -> simple-peer 10.1.2 -> webrtc-polyfill 1.2.2 -> `node-datachannel ^0.32.3` (=> 0.32.x only). 0.32.3 downloads its binary in an `install` script via the deprecated `prebuild-install@7.1.3` ("No longer maintained"); npm 11, Deno, pnpm 10 skip it by default. 0.33.x (latest 0.33.4, 2026-09-12) ships per-platform optionalDependencies (`@node-datachannel/darwin-arm64`, linux-x64-gnu/musl, linux-arm64-gnu/musl, win32-x64-msvc, win32-arm64-msvc, android-arm64) + `detect-libc`, no install script. `"overrides": {"node-datachannel": "0.33.4"}` + `npm install --ignore-scripts` => WebTorrent seeds and WebRTC echoes in 101 ms; 0.33.4 also connects to headless Chromium 156 (loopback test).

### node:test on Node 24.22 [X][D]
- `node --test test/unit` and `node --test test/unit/` => `MODULE_NOT_FOUND` (directories are no longer walked; ARCHITECTURE.md section 12 command is wrong). `node --test "test/unit/*.test.mjs"` works (186 tests, 170 pass, 14 fail in the in-flux tree); `test/unit/sw-sdk.test.mjs` hangs (3 min here, 18-21 min in other agents' runs) because default `--test-timeout` is 0 => always pass `--test-timeout` and `--test-force-exit`. Flags present in 24.22: `--test-concurrency`, `--test-isolation`, `--test-timeout`, `--test-force-exit`, `--test-shard`, `--test-randomize`, `--test-rerun-failures`, `--test-global-setup`, `--test-update-snapshots`, `--experimental-test-coverage`, `--experimental-test-module-mocks`, `--test-coverage-{lines,functions,branches}`.

### Package maintenance (npm registry, fetched 2026-10-17)
- Active: webtorrent 3.0.21 (2026-07-27), create-torrent 6.1.3 (2026-07-23), parse-torrent 11.0.24 and magnet-uri 7.0.10 (2026-07-26), bittorrent-protocol 5.0.9 (2026-07-27), bittorrent-tracker 11.2.3 (2026-05-25), fs-chunk-store 5.0.1 (2026-05-25), fsa-chunk-store 1.3.0 (2024-08-04), chunk-store-iterator 1.0.4 (2025-04-04).
- Frozen since 2021: abstract-chunk-store 1.5.0 (2021-05-19), memory-chunk-store 1.3.5, cache-chunk-store 3.2.2, immediate-chunk-store 2.2.0 (all 2021-05-19), idb-chunk-store 1.0.1 (2021-06-03). `piece-length` 2.0.1 is from 2019. Dead WebRTC-for-Node options: `wrtc` 0.4.7 (2021-01), `@koush/wrtc` 0.5.3 (2022-03); maintained fork `@roamhq/wrtc` 0.10.0 (2026-03). `webtorrent-hybrid@6.0.0` is npm-deprecated ("native WebRTC support has been added to WebTorrent >= 2.3.0").
