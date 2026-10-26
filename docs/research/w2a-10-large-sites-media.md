# w2a-10 - Large sites and media over WebTorrent: piece selection, streaming, partial loading, multi-torrent sites

> **STATUS: INTERIM DRAFT (started 2026-10-17 after an interrupted run; saved incrementally so nothing is lost).**
> If you read this line, the research run did not finish. The final version replaces this file.
> Lab code and raw results: `docs/research/labs/w2a-10-lab/` (scripts + `results/`).

Wave 2A (migration), topic 10. Topic: WebTorrent piece prioritisation (file.select, torrent.critical, strategy, BEP 53 so=),
streaming media through a Service Worker with Range (Safari strictness), time-to-first-paint tactics, piece length trade-offs,
memory (in-memory store vs OPFS on mobile), core + lazy per-section torrents (PeerTube, Planktos), BEP 47 pad files,
HTTP/2 web seed behaviour with many small files, MSE/HLS from a torrent (P2P Media Loader), and size tiers
(<=5 MB, <=50 MB, <=500 MB, >500 MB).

## Run constraints (recorded at start)

- WebSearch budget for the whole workflow turn was already exhausted when this run began (shared cap of 200 calls).
  No search engine was used. Sources are direct fetches of known primary URLs (BEPs, GitHub files and release notes, vendor docs),
  the installed `node_modules` source (webtorrent 3.0.21, create-torrent 6.1.3, parse-torrent 11.0.24, magnet-uri 7.0.10,
  bittorrent-protocol 5.0.9, piece-length 2.0.1), and local experiments. Things that needed discovery by search are listed under Open questions.

## Work plan (ticked when written into the final sections)

- [ ] Source reading: webtorrent selection/critical/strategy/webconn/file-iterator/server, create-torrent + piece-length, magnet-uri so=
- [ ] Experiments: request order with web seed (sequential vs rarest vs critical vs select), BEP 47 pad files, many small files over HTTP/1.1 and HTTP/2, SW Range strictness (Chromium, WebKit, Firefox)
- [ ] Specs and precedents: BEP 3/19/47/53/52, libtorrent piece size + deadlines, PeerTube (per-video torrents, HLS, WebTorrent removal), P2P Media Loader, Planktos
- [ ] Memory: MemoryChunkStore vs OPFS vs IndexedDB on mobile (cross-check w1-08)
- [ ] Size tiers with concrete strategies; recommendations (P0-P3, S/M/L); gotchas; open questions; JSON

## Checkpoint 1 (2026-10-17, ~18:20 ET): verified so far (raw notes, will be rewritten into the final sections)

Lab: `docs/research/labs/w2a-10-lab/` (e1-selection-order.mjs, e1b-so-debug.mjs, e1c-first-request-timeline.mjs, e3-webseed/, e4-media/; raw JSON in results/).
Engines: Node 24.22 + webtorrent 3.0.21 (selection experiments), Chromium 156.0.8078.4 and Playwright WebKit 27.2 (media and web-seed experiments). Firefox cannot launch here ("Could not find profile folder", same as sibling w2a-04).

1. [X] `torrent.critical(a,b)` does NOT reorder anything: it only sets `_critical[i]=true`, which lets `_request(..., hotswap)` steal a slow peer's block (torrent.js L1278-1288, L1752/1771). Docs say "Marks a range of pieces as critical priority to be downloaded ASAP" (docs/api.md): misleading.
2. [X] Non-stream selections are MERGED (`Selections.concatenate`): a `select()` inside or adjacent to an existing selection expands to it and inherits the max priority; a covering selection inserted later DELETES the smaller one. With the default whole-torrent selection (priority 0, installed at metadata and re-installed piece by piece by `_markUnverified`), `file.select(10)` / `torrent.select(a,b,10)` change nothing (E1 S1/S1b/S2/S3b/S3c/S7: order stays "last piece, then 0..N-1").
3. [X] What does reorder: STREAM selections (`file.createReadStream()` / `file.stream()` / `arrayBuffer()` / `blob()` create a priority-1 `isStreamSelection` item, never merged): hot.css (last-but-one file) finished at 39 ms instead of 566-668 ms (E1 S4); two streams interleave round-robin (S4b). And `deselect:true` + explicit NON-adjacent selects (S3).
4. [X] `strategy:'rarest'` with only a web seed = random piece order (S6): all files finish together at the end. Keep 'sequential'.
5. [X] The first request to any new wire (web seed included) is the LAST piece of the last selection ("validateWire", torrent.js L1655-1690): the first useful piece is requested one RTT later (E1c: +32 ms tail piece, +139 ms piece 0 with 100 ms server delay).
6. [X] BEP 53 `so=` is a no-op for fresh downloads in 3.0.21: `_verifyPiecesUsingHash` calls `_markUnverified(i)` for every piece, which calls `select(i,i)` unless `deselect:true`, rebuilding the whole-torrent selection after the `so` selection (E1 S9, E1b). `torrent.so` is set after metadata. magnet-uri 7.0.10/bep53-range 2.0.1 parse `so=0,2,4-6` (no open ranges; BEP 53 defines none).
7. [X] `file.deselect()` on a middle file strands its neighbours (shared boundary pieces dropped): torrent stuck at 94.35 %, big1/big2 never finish (E1 S8). Same mechanism as upstream #3083.
8. [X] Auto piece length (`piece-length@2.0.1`, create-torrent caps at 4 MiB): 5 MiB -> 16 KiB (320 pieces), 50 MiB -> 64 KiB, 500 MiB -> 512 KiB. libtorrent RC_2_0 auto table: <=2.56 MiB 16 KiB, <=10.2 MiB 32 KiB, <=41 MiB 64 KiB, <=164 MiB 128 KiB, <=655 MiB 256 KiB, then 512 KiB..8 MiB (target hash list = 2*sqrt(total)).
9. [X] Web seed throughput is request-latency bound (E3 smoke, Chromium 156, HTTP/2, 50 ms per request, 400 files / 6.6 MB, maxWebConns 4): 16 KiB pieces 6,869 ms (803 requests), 256 KiB pieces 542 ms (425 requests); plain parallel fetch of the 400 files over h2 230 ms, over HTTP/1.1 3,585 ms. webconn.js: `cache:'no-store'`, one fetch per overlapping file, `Promise.all` per piece, any 2xx accepted.
10. [S] PeerTube dropped WebTorrent playback in v6.0.0 (2023-11-28; issue #5465 opened 2022-12-15, removal commit 2023-07-10): "many limitations", "a bigger bundle size for a bad user experience (slow start time, hacky resolution change etc.)", P2P "not really used since most of new and popular videos are using HLS now". v6.3.0 changelog: "now the player doesn't use WebTorrent anymore (which was doing a large amount of small HTTP requests)". v7.1.0: removed WebTorrent redundancy, upgraded p2p-media-loader to v2. Planktos 0.3.1 (2017-03-04) README: "Sharding into multiple torrents is not currently supported, so Planktos will be infeasible for large websites"; "No streaming support".
11. [S] P2P Media Loader 4.0.0 (npm 2026-08-19; 5.0.0-alpha.3 2026-09-17): HLS/DASH segments over HTTP first, WebTorrent trackers only for signalling, own segment protocol, "should not perform worse than a player configured without P2P"; iPhone needs iOS 17.1+ (ManagedMediaSource; BCD 8.1.6: MediaSource "Exposed in Mobile Safari on iPad but not on iPhone").
12. [X] SW media matrix, Chromium 156 (36 of 42 runs so far, all files): a SW answering Range requests with 200 + full body plays and seeks fine; moov-at-end MP4 makes Chromium request the tail range (`bytes=2392064-`) early. WebKit 27.2 smoke: sends `bytes=0-1` first; 200 full body also played.
13. [S] bittorrent-tracker 11.2.3: one shared WebSocket per tracker URL (`socketPool`) but every torrent announce generates min(numwant,5) initiator RTCPeerConnections valid for OFFER_TIMEOUT 50 s: N torrents = up to 5N pending peer connections per announce cycle.
