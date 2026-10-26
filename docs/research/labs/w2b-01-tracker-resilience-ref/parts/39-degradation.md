### F10. Graceful degradation: with `ws=` **and** `xs=` in the magnet, every tracker failure mode leaves the web-seed path untouched; without `xs=` nothing loads `[DESIGN-CRITICAL]`

**Claim.** The headline promise "the site is reachable when no visitor is online" holds only if the pointer carries both a web seed (`ws=`, BEP 19) and the `.torrent` URL (`xs=`, "exact source"). Measured with the project's real `webtorrent.min.js` 3.0.21 in Chromium 156.0.8078.4 (`e2e/degrade.mjs`); the 473,645-byte, 3-file test site and its `.torrent` are served from a **different origin** (CORS `Access-Control-Allow-Origin: *`, `Allow-Headers: range, cache-control, user-agent`, `Expose-Headers: Content-Range, Content-Length, Accept-Ranges`, Range support), the tracker is whatever the row says; timings are loopback (the review estimates 0.3-0.6 s on a real network):

| Magnet carries | Tracker state | Result in 15 s |
|---|---|---|
| A `tr` only | connection refused | **no metadata, no download** (only the `warning` "Error connecting to ws://..." at 3 ms) |
| B `tr` + `ws` | connection refused | **no metadata, no download**: the web seed cannot supply the info dict |
| C `tr` + `ws` + `xs` | connection refused | metadata 5 ms, web-seed wire 6 ms, **done 23 ms** |
| D `tr` + `ws` + `xs` | TCP black hole (accepts, never answers the upgrade) | metadata 5 ms, wire 6 ms, **done 19 ms** |
| E `tr` + `ws` + `xs` | WebSocket handshake completes, announces never answered | metadata 5 ms, wire 6 ms, **done 22 ms** |
| F `tr` + `ws` + `xs` | tracker alive, no other peers | metadata 4 ms, wire 5 ms, **done 20 ms** |
| G `ws` + `xs`, no `tr` at all | - | metadata 5 ms, wire 6 ms, **done 18 ms** |
| H `ws` + `xs` + `wss://tracker.invalid` | NXDOMAIN | **done 20 ms**; the `warning` "Error connecting to wss://tracker.invalid" arrived at 105 ms |
| I `tr` + `xs`, **no `ws`** | refused | metadata 4 ms, then **nothing**: no data source |

(B and I together show why both keys are mandatory: `xs=` gives metadata, `ws=` gives bytes. This confirms review items B1/M9 empirically.) The tracker never blocks the web seed: WebTorrent starts the `xs` fetch immediately and attaches the web seed in `_onMetadata`, in parallel with whatever the trackers do. The web-seed host served 67 HTTP requests for the 9 scenarios (Range GETs plus the `.torrent`).

**Cross-engine check (the same nine scenarios; the extra rows isolate WebTorrent's default chunk store from the network path):**

<!--DEGRADE_ENGINES-->


**Consequences for the loader.**
1. `publish.mjs`/`magnetFromRecord` must always emit `ws=` and `xs=` for production sites, and `docs/DEPLOY.md` must state that the web-seed host needs CORS for **both** the site files and `<ws base>/<name>.torrent` (`Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: range, cache-control`, `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges`; M4 of the mobile review).
2. A loader state "all trackers unreachable" must not be an error while a web seed works: show "Peers unavailable - loading from the web seed" (the `E_NO_PEERS` timeout of 60 s must only apply when there is neither `xs` nor `ws`). Tracker failures surface only as `warning` events (and `trackerAnnounce`/`noPeers` when they work), never as a rejection.
3. Do not wait for trackers before starting the HTTP path (it already does not).
4. Production precedent: PeerTube keeps playing over HTTP when its tracker/P2P is off ("If you disable the tracker, you disable the P2P on your PeerTube instance").
5. Test it: add the C/D/E scenarios to the end-to-end suite (`e2e/degrade.mjs` is a ready starting point).
**Confidence:** high (reproducible, all combinations run, three failure modes distinct). Not tested: slow (not dead) web seed, Range-less hosts (the review's B11), Safari's `AbortSignal.timeout` limits on old iOS.
**Sources:** `e2e/degrade.mjs`, `e2e/lib.mjs`; `docs/review/distributed-systems.md` B1, `docs/review/browser-mobile.md` M4/M9; webtorrent 3.0.21 `lib/torrent.js` (`_getMetadataFromServer`, `_onMetadata`); PeerTube `config/production.yaml.example`.
**Source date:** 2026-10-17.

