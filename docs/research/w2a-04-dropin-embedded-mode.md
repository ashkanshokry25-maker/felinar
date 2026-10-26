# w2a-04 - Drop-in embedded mode: precedents and constraints for injecting a P2P / Service Worker layer into an existing site

- Project: magnet-web (static loader, WebTorrent site delivery by magnet link, signed visitor-replicated site ledger). No backend of ours.
- Wave 2A (migration), topic 04. Research date: 2026-10-17 (every "today" means this date). Sources older than 2024 are flagged [OLD].
- Question: what do the closest precedents teach, which platform constraints decide the design, and what concrete embedded-mode design (tiny script tag API included) follows, for a site that adds ONE script tag and keeps its files on its static host (web seed, crawler and no-JS fallback)?
- Baseline tested here: `docs/ARCHITECTURE.md` v0.2 section 3.4 (drop-in mode), 5.1, 5.9, 7.1, 8 and `docs/review/DESIGN-REVIEW.md` item 23 / section 5. That spec was written before this study. This file is an evidence review of it: what holds, what must change, what is missing.
- Evidence tags: **[EXP]** my own measurement (Chromium 156.0.8078.4 and Playwright's WebKit build, which reports 27.2; WebKit here is NOT Safari: no ITP, no Lockdown Mode, no page cache); **[CODE]** source code read (local packages and engine sources); **[DOC]** vendor/standards page read (the fetch tool returns a small-model extraction, so quotes are "as extracted"); **[BCD]** MDN browser-compat-data 8.1.6 (built 2026-10-15), computed locally; **[PROBE]** live HTTP probe on 2026-10-17; **[REPO]** an earlier file of this project; **[SNIP]** search-result snippet only.
- Confidence: **High** = measured, or primary source plus a second independent source. **Medium** = one primary source, or measured in one engine only. **Low** = inference, snippet, or unverified assumption (labelled).
- **[DC]** marks a design-critical item: wrong means a different architecture or a different compatibility promise.
- Related: `04-service-worker-serving.md` (SW lifetimes, Planktos/IPFS internals), `01-webtorrent-browser.md`, `02-wss-trackers.md`, `03-webrtc-nat-privacy.md`, `06-browser-chain-vs-crdt.md` (F24), `w1-10-static-hosting-bootstrap.md`, `w2a-02-cms-export.md` (F26), `w2a-05-seo-crawlers.md`.

---

## 1. Summary

1. **The v0.2 skeleton is right and matches the strongest precedents.** One script tag, HTML left on the host, a root-scope SW that serves only what a stamped pointer vouches for, fail-open everywhere, `importScripts` coexistence, a same-URL kill switch, and HTTP-first behaviour are what Planktos (2017-18), SwarmCloud/CDNBye, OneSignal, Partytown, Workbox and every commercial P2P-CDN SDK converge on (F1-F7). Seven of its rules need an edit and a set of additions is missing (section 3 and section 7).
2. **No reload and no "first-visit dance" are needed in drop-in mode** [DC]. The first page view is served entirely by the host; after `clients.claim()` only later requests use the SW; resources already loaded are never retro-controlled. Measured in Chromium 156 and WebKit 27.2 (F8). The reload-once pattern (coi-serviceworker, v0.2 shell mode, the IPFS gateway's forced navigation) is a cost that drop-in avoids.
3. **A Service Worker over every navigation is cheap on desktop, and statelessness is cheap too.** 15 forced cold starts per cell: dispatch 1.5 to 4.3 ms median, `responseStart` +0.2 to +2.3 ms over warm; reading a 50 KB / 400-entry manifest from IndexedDB or Cache Storage inside a cold SW costs about 1 ms (F9). Desktop lower bound only, mobile unmeasured. So v0.2's rule "never delay a request to decide; pass through right after a cold start" is too cautious: MPAs cold-start the SW constantly (Chromium idle limit 30 s, [REPO] 04 F13) and the rule would make the SW miss most subresources of the first page after an idle gap. Use a bounded await (F10).
4. **bfcache: v0.2's `pagehide` cleanup is right for ordinary pages; the sharp edge is `Cache-Control: no-store` HTML** [DC]. In Chromium 156 a page with a live, connected `RTCPeerConnection` (ICE connected, data channel open) is excluded from the back/forward cache (reason `WebRTC`), and closing it in `pagehide` or earlier restores eligibility (also with references dropped and GC forced). Open WebSockets, unanswered offers, held Web Locks, open IndexedDB connections, and a real WebTorrent client announcing with no peers all stay eligible. But on a document served `Cache-Control: no-store`, any WebRTC use (`WebRTCUsedWithCCNS`) or WebSocket use (`WebSocketUsedWithCCNS`), even closed, excludes the page for life. Firefox's source blocks only while a PeerConnection is unclosed (closing helps there too); WebKit's source suspends a PeerConnection for its page cache (F20, F21). So keep 3.4.6, make the close reliable and tested, and run host-only on `no-store` documents.
5. **CSP: the exact minimum is measured** [DC]. The unmodified WebTorrent 3.0.21 bundle runs under `default-src 'none'; script-src 'self'; connect-src 'self' ws://TRACKER; worker-src 'self'` and under `require-trusted-types-for 'script'` (Chromium; WebKit shows no violations). STUN/TURN is not governed by `connect-src` and `webrtc 'block'` is an unrecognized directive in both engines, so a site CSP can neither allow nor block our WebRTC. `blob:` is needed only when WebTorrent's default OPFS store runs on a browser without native `createWritable` (Safari before 26): v0.2 already avoids that store. **Do not insert a CSP `<meta>` into host pages**: a script-inserted meta CSP restricts the host's later requests immediately and can never loosen a header policy (F27, F30).
6. **The same-origin web-seed rewrite (3.4.7) is a strong design and needs one safeguard** [DC]. It removes the CORS preflight, the Range-over-compressed-bytes bug and Cloudflare Pages' Range-ignoring behaviour (200 with the full body) in one stroke. But WebTorrent asks for one HTTP Range per piece (up to 256 KiB), so a naive "fetch the whole file with `force-cache` per request" re-downloads the file per piece whenever the HTTP cache does not keep it: measured, files of 10 MB and up were NOT retained in ephemeral Playwright contexts (in-memory cache; I did not test a real private window) and `Cache-Control: no-store` defeats the cache everywhere; with a persistent profile 120 MB files were retained. Coalesce per file in the SW and cap size (F34).
7. **Sub-path hosting is a gap** [DC]. A SW's default scope is its own directory; scope `/` needs `Service-Worker-Allowed`, which GitHub Pages cannot send (SecurityError reproduced in both engines). GitHub project sites (`user.github.io/repo/`) are therefore viable only with the SW placed in the sub-path, and then they are a shared origin with the user's other project sites (F17). v0.2 only supports origin-root deployments.
8. **Host byte fidelity is a silent failure mode** [DC]. If the host or CDN alters bytes (image optimisation such as Cloudflare Polish, edge minify, Accept-dependent formats), pieces fail SHA-1 and BEP 19 says the client must discard that URL. `publish.mjs --dropin` needs a `--verify-host` step comparing live host bytes with the torrent (F15).
9. **A site that already has a SW is a documented, solvable case.** v0.2's `owns()/handle()` recipe matches OneSignal's and SwarmCloud's; Workbox `generateSW` has an `importScripts` option and `navigationPreload`, so the recipe is one config line for Workbox sites (F4, F33). Keep the SW URL permanent.
10. **Script-tag details that break naive implementations:** `document.currentScript` is `null` in module scripts (both engines), so data attributes must be read by selector; `requestIdleCallback`, `document.prerendering` and `navigator.connection` do not exist in WebKit 27.2; Cloudflare Rocket Loader needs `data-cfasync="false"` before `src` (F26, F29, F7).
11. **Mode detection should be a build-time constant plus a handshake, not runtime sniffing** (section 5.5).
12. **SharedWorker is not a mitigation** for per-navigation engine restarts: `RTCPeerConnection` is Window-only, and SharedWorker is missing in Samsung Internet and reached Chrome Android only in 148 [BCD]. Web Locks + BroadcastChannel (v0.2 5.9) work: leader hand-off 1 to 8 ms in both engines, and a lock held by a page in the back/forward cache did not starve another tab (F22, F23).
13. **What will not work** is listed in section 6 (hosted builders without a root file, Cloudflare Pages as a Range web seed, byte-altering edges, `strict-dynamic` CSP without a nonce or hash for our tag, personalised pages, sustained seeding on multi-page sites).
14. **Priorities:** P0 (before build): bounded-await index, web-seed coalescing, no CSP meta, tag reading and Safari fallbacks, `--verify-host`, spec edits. P1: sub-path (`--base`), `no-store` host-only rule and a tested close-on-pagehide, mode handshake, foreign-SW docs and Workbox config, E2E fixtures. P2/P3: optional visit budget and tracker etiquette, navigation preload, offline-HTML hygiene, rollback docs, size thresholds, opt-in soft navigation.

---

## 2. Method and limits

What I did: read `ARCHITECTURE.md` v0.2, `INTERFACES.md`, `DESIGN-REVIEW.md` section 5 and the sibling research files; read about 50 primary pages, sources and probes (listed in section 10); read engine sources (Chromium Blink, Firefox, WebKit) and the local `webtorrent@3.0.21` / `fsa-chunk-store@1.3.0` code; computed browser support from the compiled MDN browser-compat-data; probed six hosts with real `Range` GETs; and ran a Node + Playwright lab (code and raw JSON in `docs/research/labs/w2a-04-experiment/`).

Engines: Chromium 156.0.8078.4 (Playwright build; headless shell for WebRTC across pages, full Chromium in new headless for bfcache) and Playwright's WebKit (reports 27.2). **Firefox was not run**: Playwright's Firefox 157 exits with "Could not find profile folder" in this environment. No real iOS or Android device, no Safari proper, no Samsung Internet. Playwright WebKit does not enable the page cache (even a plain page was not restored), so WebKit bfcache behaviour is read from source only.

Known harness limits: (1) cross-page WebRTC in full Chromium (new headless mode) did not connect here (signalling worked, ICE stayed at `checking`; the headless shell connects but disables bfcache), so a true two-peer WebTorrent transfer under bfcache was NOT measured: I measured `RTCPeerConnection` primitives (connected loopback pairs inside one page) and a real WebTorrent client announcing with no peers; (2) two WebTorrent clients inside one page do not connect to each other, so that fallback also failed; (3) SW timing is localhost on an Apple-silicon Mac with a 300-byte worker, a lower bound; (4) the HTTP-cache test used one Chromium build and two profile types.

**Method correction (important).** The first version of my bfcache experiment awaited the data channel before calling `close()`. In some full-Chromium runs the in-page loopback pair stayed at ICE `checking`, so the `close()` calls never executed, and I wrongly concluded that closing does not restore eligibility. I caught it while re-checking (a probe showed ICE `checking` and no `dc-open`), fixed the test (negotiate, then close regardless of connection state; record `setupCompleted`, ICE states and data-channel open for every case) and re-ran everything, including a `Cache-Control: no-store` variant. All bfcache numbers in this file come from the corrected runs; the invalid cases are retired in the lab code (`INVALID-*`).

Search budget: the shared 200-call WebSearch budget ran out mid-run; I did not work around it. After that only direct fetches of known primary URLs were possible. Consequences, stated where they bite: no Cloudflare-published "service worker on an existing site" guide was found (absence unverified), HTTP `Link: rel=serviceworker` registration could not be verified (not in MDN BCD and not in the spec's index; treat as unavailable), and Googlebot's current service-worker handling is unverified (the Search Central JavaScript page updated 2026-03-04 does not mention it; a 2018-era statement said the renderer did not support service workers). GitHub's API was rate-limited, so Chromium commit history could not be read; I relied on the current `main` source text and on my own experiments, and where they disagree I say so (F20).

Scratch hygiene: the scratchpad is shared between agents. I once wrote four files into another agent's generically named `exp/` directory (a helper module, a `package.json`, a `www/` folder and a `node_modules` symlink), noticed within minutes, moved my files to `w2a04/`, and touched none of theirs. The `node_modules` symlink there points at this project's `node_modules` and was left in place.

---

## 3. Verdict on ARCHITECTURE v0.2 section 3.4 (rule by rule)

| v0.2 rule | Verdict | Evidence | Action |
|---|---|---|---|
| 3.4.1 One module script tag; HTML stamped with `<meta name="mw-pointer">`; HTML not in the torrent | **Holds** | F13, F8; Planktos precedent F1 | Add tag-reading and fallback details (R4); add `integrity`/CSP hash output (R3) |
| 3.4.2 SW "decides synchronously from in-memory state, never delays, passes through when unsure e.g. after cold start" | **Change** [DC] | F9, F10: cold-start index read about 1 ms; MPAs cold-start constantly | Bounded await (cap 40 ms) and persisted client map (R1) |
| 3.4.2(a) navigations "untouched" but body is `tee()`d to Cache Storage and the first 4 KiB parsed | **Clarify** | F9: to tee the body the SW must respond; cost measured 1 to 4 ms; preload helps mobile | Say "answered by the SW with the network response"; enable navigation preload (R9); hygiene rules (R10) |
| 3.4.3 First load not controlled; register after `load`; `claim()`; no forced reload | **Holds** | F8 [EXP] both engines | Replace `requestIdleCallback` with a Safari-safe scheduler (R4) |
| 3.4.4 Foreign SW: do not register; `importScripts('/_mw/sw-core.js')` + `owns()/handle()` | **Holds** | F4, F33: OneSignal, SwarmCloud, Workbox `importScripts` | Document Workbox config; require a permanent path (R7) |
| 3.4.5 Per-document btih pin; previous deploy kept 7 days; upload non-HTML before HTML | **Holds, with a caveat** | F13, F14 | State that same-name files overwritten in place cannot be preserved on the host; pin protects only files already in IndexedDB |
| 3.4.6 "On pagehide close sockets and peers so the site keeps its back/forward-cache eligibility" | **Holds for ordinary HTML** [DC]; **needs a `no-store` rule** | F20, F21 [EXP] + Chromium, Firefox, WebKit sources: closing restores eligibility; on `Cache-Control: no-store` documents any WebSocket or WebRTC use blocks for life | Host-only on `no-store` documents; make the close reliable (`pagehide` and hidden) and test it with CDP (R5) |
| 3.4.6 Announce only after 3 s visible; one engine per origin (Web Locks); ledger delta on start | **Holds** | F22, F24 | Make the delay configurable; an optional visit budget for tracker load (R13) |
| 3.4.7 SW web-seed rewrite, `force-cache` full-file fetch, slice | **Holds, needs safeguard** [DC] | F19, F34 | Per-file coalescing, size cap, no-store guard (R2) |
| 3.4.8 Fails open; crawlers see the host | **Holds** | w2a-05; F13 | none |
| 3.4.9 CSP: allow `worker-src 'self'`, `connect-src` trackers and DoH | **Incomplete** | F27, F28 [EXP] | Print the full measured set, nonce/hash guidance; add `script-src` (R3) |
| 5.1 step 6 "insert the CSP meta" | **Must not apply to drop-in** [DC] | F30 [EXP] | Skip in drop-in (R3) |
| 5.1 (3) "non-root deployment: stop" | **Gap for drop-in** | F17 | `--base` support for drop-in (R6) |
| 5.9 One engine per origin via Web Locks + BroadcastChannel | **Holds** | F22 | Fallback when `navigator.locks` is missing (Lockdown Mode) |

---

## 4. Findings

Source IDs [S1]..[S25] are listed in section 10. Experiment IDs refer to files in `docs/research/labs/w2a-04-experiment/results/`.

### 4.1 Precedents

**F1. Planktos is the closest drop-in precedent, and v0.2 already answers each of its documented failures.** Confidence: High (README), Medium (issue statuses, via 04). Source dates: README fetched 2026-10-17; project last commit 2018-09-18, npm 0.3.1 published 2017-03-04 [OLD: 2017-18].
- Owner steps (README): `npm install -g planktos`; run the CLI "at the root of your website"; it copies `planktos.sw.js` to the root; add `<script src="/planktos/install.js"></script>` to the pages; "After updating your website's files you have to run the Planktos CLI again". Where the APIs are missing "Planktos falls back to ordinary HTTP loading". Stated blockers: "No streaming support", no sharding, "not recommended for production use yet" [S1].
- Internals (04 F1, source read): the origin host is the initial web seed; the SW falls back to plain `fetch(event.request)` on any miss or exception; the actual download runs in a page because "service workers cannot use WebRTC". Open design bugs: stale content after update (#4), sub-path hosting (#55), content-type (#30/#56) [S24-04].
- Mapping to v0.2: stale content -> per-document stamped btih (3.4.5); content types -> a MIME map plus fail-open; fall back to HTTP -> 3.4.8. **Sub-path hosting is still open (F17).**

**F2. Commercial P2P-CDN SDKs are "one script, one key, HTTP first", and none documents tab or navigation coordination.** Confidence: High on the quotes, Medium on the absence claim (documentation not found is not proof).
- Peer-assisted delivery networks (Peer5, Streamroot, Viblast): a site "simply needs to subscribe to a PDN service and embed the respective PDN Javascript SDK"; the study found 3 providers, 134 websites and 38 apps, customers authenticating with a static API key embedded in their pages plus a domain whitelist, and reported free riding, segment pollution, IP exposure and resource squatting as risks (arXiv 2212.02740, December 2022) [S5] [OLD: 2022].
- P2P Media Loader describes an HTTP-first start (README, fetched 2026-10-17; paraphrase as extracted by the fetch tool): segments are first downloaded over HTTP(S) so playback starts quickly, it falls back to HTTP(S) when no peers are available, and random peers periodically fetch new segments over HTTP(S) to share them over P2P. npm `p2p-media-loader-core`: 2.3.2 (2026-06-01), 3.0.0 (2026-06-07), 4.0.0 (2026-08-19), 5.0.0-alpha.3 (2026-09-17): three majors in eleven weeks, so no stable surface to copy [S2].
- SwarmCloud/CDNBye: the service is activated per registered domain and, per the docs, "Localhost is always whitelisted"; the config page lists `token`, `swFile`, `swScope`, `proxyOnly` and cache limits but no option for tabs or windows [S3]. Peer5's P2PXHR (README, no date, Chrome 26+ / Firefox 23+) is a constructor swap, "search and replace XMLHttpRequest with peer5.Request()", with a coordinator service and HTTP Range for the blocks peers do not have [S4] [OLD: about 2014-2016].
- Lessons that carry over: (1) the origin stays on the critical path and P2P is an assist; v0.2 3.4 does this by construction. (2) Keys and whitelists exist because third parties free-ride; our signed pointer plus per-piece SHA-1 and per-file SHA-256 cover pollution, and there is nothing to free-ride on. (3) IP exposure to other peers is the headline risk in the literature, so the consent notice is not optional (v0.2 section 8).

**F3. SwarmCloud ships a Service Worker engine into existing sites, with the same placement and merge rules as v0.2 3.4.4.** Confidence: Medium-High (fetch-tool extraction of an undated page, 2026-10-17) [S3].
- The SW engine is used when MSE is unavailable, when no `hlsjsInstance` is passed, or when `proxyOnly` is set (paraphrase as extracted); it is started with `engine.registerServiceWorker()`; defaults `swAutoRegister: true`, `swFile: './sw.js'`, `swScope: './'`.
- Placement and merge rules (paraphrase as extracted): copy `sw.js` to your own server so it is served at the site root; if the site already has a worker, add `self.importScripts(...)` for `hls-proxy.js` at the top of its root file and set `swFile`; a service worker must be hosted under the same domain as the page, so the SDK has to be self-hosted rather than loaded from a public cloud.
- Disk cache: `useDiskCache` default true (IndexedDB), `diskCacheLimit` 1500 MB desktop / 1000 MB mobile, `memoryCacheLimit` 400 / 100 MB. v0.2's 512 MiB / 128 MiB storage budget is the same order of magnitude.

**F4. Every vendor that needs a Service Worker on a site that may already have one converges on the same four rules.** Confidence: High (docs fetched 2026-10-17).
- One worker per scope: OneSignal, "Only one service worker can be active at a given scope"; "Keeping service workers in separate files with separate scopes is simpler to maintain and avoids conflicts. Only combine them if your setup requires a single service worker file." Merge recipe: `importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js"); importScripts("https://yoursite.com/your-other-service-worker.js");` [S7].
- Permanent path: choose a permanent path, because changing it later requires a migration (paraphrase as extracted) [S7]. For PWAs OneSignal recommends a subdirectory that never serves pages; that option does not exist for us, because we must control the site's pages.
- Same-origin hosting: Partytown, "Hosting from the same origin is a requirement of the service worker scope" [S8]; SwarmCloud, same (F3).
- Build-tool hook: Workbox `generateSW` has `importScripts: string[]`, "A list of JavaScript files that should be passed to importScripts() inside the generated service worker file", and `navigationPreload: boolean` (default false; when enabled a `runtimeCaching` route that matches navigation requests and uses the preloaded response must also be set up, paraphrase as extracted) [S9].
- Consequence: v0.2's `importScripts('/_mw/sw-core.js')` + `owns()/handle()` is the industry pattern; for Workbox sites it is one config line (F33). Partytown's "not async or defer, inline it" requirement exists because it must run before other third-party scripts; ours is the opposite (low priority, `async` is right).

**F5. PeerTube shows the accepted shape of a per-embed and per-visitor P2P switch and of the privacy statement.** Confidence: High (docs, undated, fetched 2026-10-17) [S6].
- Embed parameters: `p2p` ("Enable/Disable P2P", 0 or 1; if unset the player uses the user's setting and then the instance setting, paraphrase as extracted), `mode` (`p2p-media-loader` or `web-video`), `warningTitle`.
- Privacy guide: "the IP address is stored in the platform's BitTorrent/WebTorrent tracker" while a user watches or downloads; "Anonymous and registered users can disable P2P in their settings"; admins can disable it instance-wide. The embed is a cross-origin iframe, so unlike a first-party drop-in it cannot share storage with the embedding site.
- Lesson: ship an owner-level off switch (`data-mw-engine="off"`) and a visitor-level setting (v0.2 section 8 has the latter).

**F6. Google and Workbox guidance supports exactly the split v0.2 uses: cache-first for versioned assets, network-first for HTML, no precaching of documents, same-URL removal.** Confidence: High on quotes; numbers marked [OLD].
- Strategies: Cache First is "a great strategy to apply to all static assets (such as CSS, JavaScript, images, and fonts), especially hash-versioned ones"; Network First is "great for HTML or API requests when, while online, you want the most recent version of a resource" [S9].
- Navigation preload exists "for developers who can't precache their HTML"; those who serve precached HTML "do not need to enable navigation preload"; startup is "usually around 50ms" and "more like 250ms" on mobile; calling `fetch(event.request)` instead of using `event.preloadResponse` gives "double requests" (web.dev, last updated 2017-02-15) [S11] [OLD].
- Jake Archibald (2016-04-27) [S10] [OLD but still the reference]: hashed URLs with `max-age=31536000`; mutable HTML with `no-cache`; "max-age on mutable content is often the wrong choice"; mismatched HTML/CSS/JS "broke things"; a service worker can make this worse (paraphrase).
- Removal: deploy a no-op worker at the SAME URL ("be certain that the service worker URL remains unchanged!"); `Clear-Site-Data: "storage"` only as an addition ("This header is not supported in all browsers"); if the URL is unknown, key off the `Service-Worker` request header [S9].
- I found no Cloudflare-published guide for adding a service worker to an existing site (search budget exhausted; absence unverified). The Cloudflare facts that matter are in F7.

**F7. Cloudflare features that sit in front of an injected script and a byte-for-byte web seed.** Confidence: High on the page text; the module-script effect is unknown.
- Rocket Loader: exclude a script with `data-cfasync="false"`; "The `data-cfasync` attribute must be added before the `src` attribute"; "Adding this attribute within JavaScript will not work"; scripts that depend on other scripts need it too. The page does not say how `type="module"` scripts are treated: **unknown, test** [S13].
- Polish: "strips metadata from images and reduces image size through lossy or lossless compression"; "keeps the same image URLs" (page updated 2026-08-14). The bytes at the URL differ from the origin's (F15) [S13].
- Pages: `/contact.html` is redirected to `/contact`, `/about/index.html` to `/about/`; "Pages currently returns 200 responses for HTTP range requests; however, the team is working on adding spec-compliant 206 partial responses" (page updated 2026-10-10). Confirmed by probe: `cloudflare-pages-demo.pages.dev`, GET with `Range: bytes=0-9` -> `200`, 4502-byte body, no `Accept-Ranges` [S13] [S23].

### 4.2 First load, control and per-navigation cost

**F8 [DC]. Drop-in needs no reload and no first-visit dance.** Confidence: High (Chromium 156 and WebKit 27.2 agree).
- [EXP] Page with `app.css`, `app.js` and a script that registers a `claim()`-ing SW: `navigator.serviceWorker.controller` is `null` at start; after `ready` and `controllerchange` it is non-null; resources loaded before activation show `workerStart` 0 (never SW-handled); a `fetch()` after claim carries the SW's marker header. Results `sw-chromium.json`, `sw-webkit.json`.
- A hard reload (shift+reload) bypasses the SW for that navigation (spec; 04 F10), so "hard reload loads entirely from the host" in 3.4.3 is right.
- Contrast: shell mode must reload once (v0.2 5.2), coi-serviceworker reloads once with a sessionStorage guard, the IPFS gateway forces a navigation and in 2026 shipped loop guards after Safari and stale-CDN failures (04 F6, F19, F20) [S24-04]. Drop-in should never call `location.reload()`.

**F9. The Service Worker tax per navigation is small on desktop, including a stateless worker that rereads its manifest.** Confidence: High for desktop Chromium; Low for phones (not measured).
- [EXP] Chromium 156, localhost, emulated origin latency 40 ms and 150 ms, 15 navigations per cell, SW stopped through CDP before each cold navigation (boot timestamp changed on 15/15, `runningStatus` stopped/starting/running seen). Network-first worker (`respondWith(fetch(request))`): fetch-event dispatch median 1.5 to 4.3 ms over three runs (1.7, 3.5, 4.3); `responseStart` cold minus warm +0.2 to +2.3 ms (e.g. 44.2 vs 43.3 ms at 40 ms latency; 155.8 vs 153.9 ms at 150 ms); worst cold navigation 50.6 ms vs 45 ms warm. With no SW the median `responseStart` was 43.0 and 42.6 ms (two sets of 15); a worker with no fetch handler or an observe-only handler added nothing (42.3 to 43.4 ms); an uninstrumented network-first worker measured 43.5 ms cold and 43.6 ms warm (`sw-chromium.json`).
- Reading a 49,611-byte, 400-entry manifest inside a cold worker: IndexedDB (structured-clone object) 1 ms, IndexedDB (JSON string + parse) 1 ms, Cache Storage 1 ms median; dispatch 2.1 to 2.8 ms. Files `sw2-delay40.json`, `sw2-delay150.json`, `sw2-delay40-nf-i_idb-i_idbs-i_cache-i.json`.
- Navigation preload (used on 15/15) gave no measurable desktop gain (43.8 vs 44.2 ms).
- Lower bound only: Apple-silicon Mac, 300-byte worker, localhost. The older web.dev figures (about 50 ms desktop, about 250 ms mobile, "can be over 500ms") [S11] [OLD] bracket the unknown real cost; the DESIGN-REVIEW "5% LCP" target has to be measured on a phone.

**F10 [DC]. v0.2's cold-start pass-through rule is too cautious.** Confidence: High on the numbers, Medium on the proposed cap.
- Worker lifetime is short and engine-specific: Chromium 30 s idle, Firefox 30 s + 30 s, WebKit ends workers when no client page remains ([S24-04] F13, source-read plus [EXP]). In a multi-page site the reading gap between navigations is usually longer than 30 s, so the worker is often cold at the next navigation.
- v0.2 3.4.2 "never delays a request to decide, and passes the request through when unsure (for example right after a cold start, before its index is loaded)". With an index read of about 1 ms (F9) the pass-through costs more than the wait: the subresources of the page the visitor just opened bypass IndexedDB. The in-memory client -> btih map is also lost at every restart, so lazy images on a page opened two minutes ago pass through.
- Proposed: inside `respondWith(async ...)` await the index/map with a hard cap (suggested 40 ms), then fall back to `fetch(event.request)`; persist the client map in IndexedDB keyed by `clientId` (stable for the document's life) or recover it with `clients.get(id)` + a message. The cap is a design choice, not a measured phone value.

**F11. `FetchEvent.resultingClientId` works in both engines, which closes a DESIGN-REVIEW "not verified" item for the WebKit engine.** Confidence: High (engines), Medium (iOS devices).
- [EXP] 4/4 trials in each of Chromium 156 and WebKit 27.2: in a navigation fetch event `resultingClientId` is non-empty, equals the later `MessageEvent.source.id` of the new document, and `clients.get(id)` finds it. Files `rc-chromium.json`, `rc-webkit.json`. [BCD]: Chrome 72, Firefox 65, Safari 16 [S24-04].
- DESIGN-REVIEW section 6 lists "Safari support for FetchEvent.resultingClientId" as unverified; the document-URL fallback in 3.4.2 can stay as a safety net.

**F12. Navigation preload is available everywhere above the declared floor, and it is the right tool for drop-in's network-first path, not for shell mode.** Confidence: High.
- [BCD] `ServiceWorkerRegistration.navigationPreload`: Chrome 59, Firefox 99, Safari 15.4. Workbox's "Chrome is the only browser" text is outdated [S9].
- Drop-in always wants the network response for a navigation (it copies and stamps it), so preload removes SW boot from the critical path; shell mode answers navigations from the precache and should not enable it (04 F12). Mandatory discipline: use `event.preloadResponse` on every navigation the worker handles, otherwise "double requests" [S11].
- Desktop gain is unmeasurable (F9); the case rests on the mobile numbers in [S11] [OLD]. Ship it behind the measurement, priority P2.

### 4.3 Same URLs, versions and bytes

**F13 [DC]. A per-document pin (the stamped btih) is the right answer to "hashed filenames versus same-name updates"; it should be documented as a naming matrix.** Confidence: High (reasoning over [S9], [S10], F1 and the v0.2 design).

| Asset naming on the host | What goes wrong with a plain URL-keyed SW cache | With v0.2's per-document pin |
|---|---|---|
| Content-hashed filename (`app.3f2a1c.js`) | Nothing: the URL is immutable | Safe to serve from IndexedDB at any time; old files stay on the host for the keep window (7 days, 3.4.5) |
| Versioned query (`site.css?v=12`) | A cache that ignores the query serves a wrong version; one that keeps it duplicates | The SW matches on path only; the pin decides the version, so the query is irrelevant |
| Same name edited in place (`/css/site.css`) | After a deploy: stale file under new HTML, or new file under stale HTML | Consistent for files already in IndexedDB under the page's btih; otherwise pass-through, i.e. today's behaviour (new bytes). The host cannot preserve the old bytes of an overwritten file |
| HTML | A cached document pins old assets | Never from the torrent; network-first; its own stamp supplies the pin; offline copy only when the network fails |

Consequence: "same-name updates" are safe only for pages whose pinned copy is complete; the README must say that hashed filenames give the strongest guarantee and that `publish.mjs --dropin` should warn when more than a threshold of non-HTML files are not content-hashed.

**F14. Stale HTML under the host's own freshness policy is the original skew source, and the SW must not "fix" it by forcing revalidation.** Confidence: High (probe + [REPO] w1-10) for the header, Medium for the recommendation.
- [PROBE] GitHub Pages (`mdn.github.io`, a `.js` asset) answered with `cache-control: max-age=600`; w1-10 measured the same fixed value and no custom headers for the host [S23] [S24-w1-10]. HTML can therefore be reused by the browser for 10 minutes while a deploy replaced same-name assets (Jake Archibald's mismatch scenario [S10]).
- The SW's navigation `fetch()` uses the default cache mode and so honours the host's freshness. Do not switch it to `cache: 'no-cache'` or `'reload'`: that would make repeat navigations slower than the same site without our layer (every navigation would revalidate), which breaks the "Lighthouse within 5%" acceptance of DESIGN-REVIEW item 23. With the default mode a stale document carries a stale pin, and the old copy is still in IndexedDB while any client maps to it (3.4.5): consistent.

**F15 [DC]. Host byte fidelity: if the public host alters bytes, the web seed silently fails.** Confidence: High on the mechanism; Medium that typical image-optimising edges change bytes (the Polish page does not mention WebP/AVIF conversion).
- BEP 19: if a downloaded piece fails its SHA check the client must close the connection and discard that URL (paraphrase as extracted) [S17]. v0.2 3.4.7 fetches the public `/<path>` through the host's edge, so anything the edge rewrites (image optimisation such as Polish, minification or injection at the edge, `Accept`-dependent formats, transformed responses with a different length) breaks piece verification and the symptom is "no web seed, no peers".
- Cloudflare Polish keeps the URL while "strips metadata from images and reduces image size through lossy or lossless compression" [S13].
- The same mismatch makes SW-served bytes (verified against the torrent) differ from host-served bytes, which matters for pages carrying `integrity=` attributes.
- Proposed: `publish.mjs --dropin --verify-host https://example.com` fetches every listed path from the live URL with browser-like `Accept` and `Accept-Encoding`, compares SHA-256 with `/.mw/files.json`, and reports mismatches, `Content-Encoding` and `Vary: Accept` before it prints the pointer (same gate idea as `--verify-ws`). Disable the transform for the zone/paths or exclude those files.

**F16. The offline HTML copy (3.4.2a) needs hygiene rules for partly dynamic sites.** Confidence: Medium (reasoning; the Fetch redirect rule is carried from 04 gotcha 11 and was not re-verified).
- Skip responses with `Set-Cookie`, `Vary: Cookie` or `Vary: *`, `Cache-Control: private` or `no-store`; never store `response.redirected === true` (a redirected response cannot answer a navigation); never cache pages for requests that carried session cookies unless the owner opts in; cap the LRU and drop entries at `deleteSite`. Without these an offline copy can show another visitor's personalised banner on a shared device.

### 4.4 Scope, sub-paths and URL mapping

**F17 [DC]. A Service Worker's maximum scope is its own directory on header-less hosts; sub-path deployments need the worker inside the sub-path and become a shared origin.** Confidence: High (rule), Medium (consequences).
- [EXP] Chromium 156 and WebKit 27.2: `/blog/sw.js` registers with default scope `/blog/`; `register('/blog/sw.js', {scope:'/'})` throws `SecurityError` (Chromium: "...The path of the provided scope ('/') is not under the max scope allowed..."; WebKit: "Scope URL should start with the given script URL"); with `Service-Worker-Allowed: /` on the script it registers at `/`; `/blog/sub/` registers. Files `sw-chromium.json`, `sw-webkit.json`. [BCD] `Service-Worker-Allowed`: Chrome 42, Firefox 40, Safari 11.1.
- GitHub Pages cannot send custom headers (w1-10, measured) [S24-w1-10]; hosted builders show no known way to serve a worker file at the origin root, so w2a-02 F26 concludes "export first" for Ghost(Pro), Squarespace and Wix [S24-w2a-02].
- v0.2 supports origin-root deployments only (5.1 step 3 stops for non-root shells; the drop-in tag is `/_mw/mw.js`, the worker `/mw-sw.js`). GitHub project sites (`user.github.io/repo/`) are one of the most common homes for existing static sites; they work if `mw-sw.js` and `_mw/` live under the base, the stamped paths are base-prefixed and the SW maps `pathname.slice(base.length)`.
- All project sites of one GitHub user share ONE origin: IndexedDB, Cache Storage and localStorage are shared, so any project page's JavaScript can read another's stored data. That is v0.2 3.3 "shared origin" semantics; the README must say so and the ledger/identity keys must be namespaced by ledger id (they are, per 3.2).

**F18. URL -> torrent path mapping is trivial for subresources and hostile for documents; keep documents out.** Confidence: High (host rules), Low (NFC/NFD risk).
- Subresources carry explicit paths: `rel = decodeURI(pathname).slice(base.length)`, exact, case-sensitive match against `/.mw/files.json`, query and fragment ignored (the pin replaces `?v=`), reject `..`, empty segments and `//`, NFC-normalise at publish time and warn when HTML references differ in normalisation (macOS file names can be NFD; not tested here).
- Documents differ per host and the SW must not emulate them (v0.2 3.4.2 already says it never synthesises redirects/404s): the S3 website endpoint answers a folder URL without a trailing slash with `302 Found` to the slash form and has no `/about` -> `about.html` mapping [S18]; Cloudflare Pages redirects `.html` to extensionless URLs and `/dir/index.html` to `/dir/`, and treats a site without `404.html` as an SPA [S13]; GitHub Pages answers its 404 fallback with HTTP 404 [S24-w1-10]. Trailing-slash semantics change how relative URLs resolve, which is why a worker that "helpfully" serves `/blog` as `blog/index.html` breaks pages.
- 5.1 step 3 ("non-root: stop") and F17 together imply `--base`.

**F19. BEP 19 addressing, per-piece requests and the same-origin advantage.** Confidence: High ([CODE] + [DOC] + [REPO]).
- [CODE] `webtorrent@3.0.21 lib/webconn.js`: for multi-file torrents the URL is `url + '/' + file.path` where `file.path` starts with the torrent name; every request is `fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-store', 'user-agent': ..., range: 'bytes=a-b' }, signal: AbortSignal.timeout(60000) })`. Cross-origin that is a CORS preflight (01 F10, w1-10 F2); same-origin there is none.
- [CODE] `lib/torrent.js` `_request`: for web seeds `chunkLength = piece.chunkLengthRemaining(reservation)`, pipelined up to `maxWebConns` (4 by default, 01): one Range request per remaining piece (up to the 256 KiB piece), split per file when a piece spans files.
- [DOC] BEP 19: for multi-file torrents the url-list value must be a root folder and the client appends the torrent `name` and then each `path/file` (paraphrase as extracted); so a root-hosted site is not BEP 19-addressable without a rewrite, which is what 3.4.7 provides [S17].

### 4.5 Engine lifetime on multi-page sites

**F20 [DC]. In Chromium, a page with a live `RTCPeerConnection` is excluded from the back/forward cache and closing it restores eligibility; on `Cache-Control: no-store` documents any WebRTC or WebSocket use excludes the page for life.** Confidence: High for Chromium 156.0.8078.4 (measured, and it matches current `main` source), Medium for other versions and for Firefox/WebKit (source only).
- [EXP] full Chromium 156 (new headless, bfcache enabled with `ignoreDefaultArgs: --disable-back-forward-cache`), cross-site navigation `127.0.0.1` -> `localhost`, then `history.back()`; reasons from CDP `Page.backForwardCacheNotUsed`. Every case records that its setup completed; in the connected cases the loopback pair reached ICE `connected` and the data channel opened. Files `bfcache-chromium.json`, `bfcache-chromium-nostore.json`, `wt-bfcache-nopeers.json`:

| State when navigating away | Ordinary HTML | HTML with `Cache-Control: no-store` |
|---|---|---|
| Plain page | restored | restored |
| WebSocket open / closed in `pagehide` | restored / restored | **blocked** / **blocked** (`WebSocketUsedWithCCNS`) |
| `RTCPeerConnection` constructed only; constructed and closed at once | restored; restored | not run |
| Offer created, no answer (pending), left open / closed in `pagehide` | restored / restored | restored (open case) |
| Connected pair, data channel open, left open | **blocked** (`WebRTC`) | **blocked** (`WebRTC`, `WebRTCUsedWithCCNS`) |
| Connected pair closed in `pagehide` | restored | **blocked** (`WebRTC`, `WebRTCUsedWithCCNS`) |
| Connected pair closed 0.8 s earlier; closed and references dropped; plus `gc()` forced | restored; restored; restored | **blocked** (`WebRTCUsedWithCCNS`) in all three |
| Web Lock held; IndexedDB connection open | restored; restored | not run |
| Real WebTorrent client seeding and announcing to the tracker, no peers: left running / `destroy()` in `pagehide` | restored / restored | not run |

- [CODE] Chromium `main` (fetched 2026-10-17), `rtc_peer_connection.cc`: `DisableBackForwardCache()` runs from `setRemoteDescription` when the SDP contains a candidate and from `addIceCandidate`; it registers `kWebRTC` ("a non-sticky feature that will disable BFCache for any page. It will be reset after the `RTCPeerConnection` is closed") and `kWebRTCSticky` ("will only disable BFCache for the page containing 'Cache-Control: no-store' header. It won't be reset even if the `RTCPeerConnection` is closed"); `CloseInternal()` ends with `feature_handle_for_scheduler_.reset()` [S21]. `web_scheduler_tracked_feature.cc` also lists `kWebSocketSticky`. The experiment matches the source on every row, including the sticky reason names.
- WebTorrent signals with `trickle: false` (01 F7, 02), so every SDP it exchanges already contains candidates: the first remote description a page applies starts the block, whether or not the connection then succeeds; unanswered offers (WebTorrent's normal state when nobody answers) do not.
- Consequences: (1) v0.2 3.4.6's rationale is correct for ordinary HTML. A live peer connection blocks the page, so cleanup is what keeps eligibility, and it must run on every exit path: `pagehide` for navigations, `visibilitychange` to hidden and `freeze` on mobile where `pagehide` may not fire (01, web.dev [S12]). (2) On `no-store` HTML even the tracker WebSocket alone excludes the page for life; run host-only there. The worker sees the navigation response headers and can tell the page in its stamp message, and `publish --verify-host` can detect it at deploy time. (3) A first-load race exists: peers established before the page learns the document is `no-store` already cost the page its eligibility; the page should wait for the stamp message (or default to host-only until it arrives) before opening a tracker socket.
- Not measured: Firefox and Safari; a two-peer WebTorrent transfer across pages (harness limit, section 2); other Chrome versions (this build lets a plain `no-store` page into the cache, older builds do not).

**F21. Other engines and other connection types.** Confidence: High (web.dev + source), Medium (Firefox and WebKit were read, not run).
- web.dev (updated 2026-10-16): "some browsers won't attempt to put a page in bfcache ... Pages with an open WebSocket or WebRTC connection. Chrome (as of 149) and Safari do no [sic] block on open WebSockets but other browsers do. ... we strongly recommend closing connections ... during the `pagehide` or `freeze` event"; reopen in `pageshow`/`resume` [S12]. [EXP] confirms Chromium 156 does not block on an open WebSocket.
- Firefox [CODE] `Document::CanSavePresentation`: `if (win && win->HasActivePeerConnections()) { ... "Save of %s blocked due to PeerConnection" ... ret = false; }`; `AddPeerConnection()` runs in `PeerConnectionImpl::Initialize`, `RemovePeerConnection()` on close with the comment "Uncount this connection as active on the inner window upon close". So in Firefox any unclosed PeerConnection blocks (even unconnected) and closing restores eligibility [S21].
- WebKit [CODE] `RTCPeerConnection::suspend(reason)`: for `ReasonForSuspension::BackForwardCache` it sets `m_shouldDelayTasks = true` and calls `m_backend->suspend()`; no page-cache blocker found in `RTCPeerConnection.cpp` or `RTCDataChannel.cpp`. WebKit therefore caches such a page with the peer connection suspended, and peers are likely dead on restore, which is why `pageshow` with `persisted` must rebuild the client (v0.2 8) [S21]. Playwright's WebKit did not cache even a plain page, so this is source-only.
- Policy that follows: always close tracker sockets and peers on every exit path (required for ordinary pages in Chromium and Firefox, tidy for WebKit), rebuild on `pageshow` with `persisted`, and run host-only on `no-store` documents (F20). A visit budget (R13) is about tracker load and battery, not about the back/forward cache.

**F22. Web Locks leader election works across full navigations and does not starve other tabs; it needs a fallback when Web Locks is absent.** Confidence: High (engines), Medium (devices).
- [EXP] `navigator.locks.request('mw-engine', async () => new Promise(() => {}))` on every page: single tab page1 -> page2: the new page becomes leader a median 8 ms after the old page's `pagehide` (2 ms after its `load`) in both Chromium 156 and WebKit 27.2; two same-origin tabs: the waiting tab acquires the lock 1 ms (Chromium) / 4 ms (WebKit) median after the leader's `pagehide`, and the leader's own next page waits (0/8 took it). Files `locks-chromium.json`, `locks-webkit.json`.
- [EXP] A tab holding the lock navigated cross-site (eligible for bfcache): another tab acquired the lock 1 to 9 ms after loading in 5/5 trials; whether the cached page was evicted or released is not known. `lock-bfc-chromium.json`.
- [BCD] `LockManager.request`: Chrome 69, Firefox 96, Safari 15.4, Samsung 10; `BroadcastChannel`: Chrome 54, Firefox 38, Safari 15.4, Samsung 6. Safari Lockdown Mode disables Web Locks and the Cache API (WebKit 16.4 notes via 03/04) [S24-03/04]: feature-test `navigator.locks` and fall back to "one engine per page" or host-only.
- Failover is instant but the new leader starts from zero (F24): the lock serialises engines, it does not carry peers over.

**F23. SharedWorker cannot host the engine, and it is no better supported than Web Locks.** Confidence: High.
- [BCD 8.1.6, built 2026-10-15] `SharedWorker`: Chrome 5, **Chrome Android 148**, Edge 79, Firefox 29 (Android 33), Safari 16 and iOS Safari 16, **Samsung Internet removed in 5.0 (unsupported)**, WebView Android 148. The premise that iOS Safari lacks SharedWorker is outdated; [EXP] `typeof SharedWorker` is `function` in WebKit 27.2.
- But `RTCPeerConnection` is `[Exposed=Window]`: no worker type has it ([S24-03] summary 12, [S24-06] F24 measured in Chromium 155, [S24-04] F16; BCD has no worker-exposure entry). A SharedWorker could hold only non-WebRTC state (ledger DAG, manifest, IndexedDB handle) and lives only while it has clients (not tested across a navigation). The Samsung and Chrome-Android gaps make it unusable as a baseline.
- Alternatives that cannot work: a hidden iframe engine (a document's child frames are destroyed with it), and popups or Picture-in-Picture windows (hostile UX; not researched).

**F24. Cost model for an engine start per page view.** Confidence: High for the loopback numbers, Low for real-network totals.
- [EXP] loopback, no STUN, 300 KB file, Chromium 156 (`csp-chromium.json`, the four runs that connected): module import 11 to 17 ms; first wire 161 to 169 ms after page start; metadata 164 to 171 ms; done 240 to 252 ms (an earlier run of the same scenarios gave 151 to 167 ms and 222 to 240 ms). A fresh client per page therefore costs about 150 to 170 ms of CPU/JS even with zero network distance.
- Network additions per start ([REPO] 02, 01): WebSocket connect to each tracker; announce -> offer relay measured 40 to 118 ms on four public trackers; up to 5 offers per announce per tracker; trickle off so ICE gathering must finish (simple-peer `ICECOMPLETE_TIMEOUT` 5 s); WebRTC connect and handshake timeouts 25 s; trackers close idle sockets after about 125 to 185 s and expect an announce about every 120 s.
- No rate limit is published by openwebtorrent, webtorrent.dev or novage; ftorrent publishes a circuit breaker (24 h `503` after 200 M relayed offers) [S24-02]. A click-through visitor makes N announce rounds per minute; that is the abuse pattern a "start the engine on every page" design produces at scale.

**F25. Soft navigation is now possible in all three engines, and the precedent shows its compatibility price.** Confidence: High (facts), Medium (suitability).
- [BCD] Navigation API: Chrome 102, Edge 102, Firefox 147, Safari 26.2 / iOS 26.2, Samsung 19; `NavigateEvent.intercept` Chrome 105, Firefox 147, Safari 26.2. [EXP] `window.navigation` is an object in Chromium 156 and WebKit 27.2.
- Turbo Drive (handbook, fetched 2026-10-17): intercepts link clicks and forms, replaces `<body>`, merges `<head>`; changed head assets need `data-turbo-track="reload"`; third-party scripts not built for page swaps "may need" `turbo-visit-control reload`; paths whose last segment contains a "." are skipped unless `.htm/.html/.xhtml/.php`; opt-out per link with `data-turbo="false"`; its own progress bar after 500 ms [S14].
- It is the only way to keep the engine (and the bfcache-costly connection) alive across navigations inside one tab. DESIGN-REVIEW already defers "opt-in soft navigation". Risks for an injected layer: analytics page views, inline scripts and `DOMContentLoaded` handlers, per-page CSS/JS, forms, focus and scroll. Opt-in only, per link or per region, never default.

### 4.6 The script tag, CSP, analytics and third-party scripts

**F26. A module script cannot find its own tag through `document.currentScript`; read the attributes by selector.** Confidence: High (both engines).
- [EXP] Chromium 156 and WebKit 27.2 (`tag-api.json`): inside `<script type="module" src="/tag-mod.js?v=3" async data-mw-engine="landing" data-mw-sw="off">`, `document.currentScript === null`; `import.meta.url` is the script URL including `?v=3`; `document.querySelector('script[type=module][src*="tag-mod.js"]').dataset` returns `{mwEngine, mwSw}`; in a classic script `document.currentScript.dataset` works; the module+async script ran with `document.readyState === "interactive"` on a tiny page.
- v0.2 3.4.4 puts `data-mw-sw="off"` on the tag, and the pointer lives in a `<meta>` (no `currentScript` needed). The loader must find the tag with a selector on its own `import.meta.url` path. Under Rocket Loader add `data-cfasync="false"` before `src` (F7); behaviour with `type="module"` is unverified.

**F27 [DC]. The measured CSP minimum for the stock WebTorrent bundle, and what is NOT needed.** Confidence: High (Chromium 156), Medium (WebKit: no violations, but the transfer could not complete in headless WebKit).
- [EXP] Chromium 156, headless shell, one seeder page and one leecher page in separate contexts, 300 KB file, no STUN (`csp-chromium.json`):

| # | Policy | Result |
|---|---|---|
| 1 | none | done in 240 ms (import 14, first wire 169) |
| 2 | `default-src 'none'; script-src 'self'; connect-src 'self' ws://TRACKER; worker-src 'self'` | done in 240 ms, 0 violations |
| 3 | same without the tracker in `connect-src` | `connect-src` violation on `ws://TRACKER`, never connects ("Error connecting to ws://...") |
| 4 | policy 2 plus `require-trusted-types-for 'script'` | done in 240 ms, 0 violations |
| 5 | policy 2 with `createWritable` and `FileSystemWritableFileStream` deleted before import (Safari before 26 simulation) | 18 `worker-src` violations for a `blob:` worker; seeding fails |
| 6 | policy 5 with `worker-src 'self' blob:` | done in 252 ms; `createWritable` absent before import, present after |

- WebKit 27.2 (`csp-webkit-1234.json`): native `createWritable` present; policies 2 and 4: 0 violations; policy 3: the same `connect-src` violation; transfers did not complete in any WebKit run including the no-CSP control (headless WebKit mDNS candidates), so only the absence of violations is evidence there.
- [CODE] The shipped bundle contains no `WebAssembly`, no `eval(`, no `new Function`; one `new Worker(URL.createObjectURL(blob), {type:'module'})` inside the `createWritable` polyfill; `fsa-chunk-store` imports that polyfill and wipes the OPFS `chunks` directory at import. `lib/torrent.js` lines 95-96 compute `SUPPORTS_FSA` after those imports, so on Safari before 26 the default store becomes the OPFS+Blob-worker store (consistent with `docs/review/browser-mobile.md` M7). v0.2 always passes its own `MemoryChunkStore`, so `blob:` is NOT needed.
- [EXP] ICE is not governed by `connect-src`: a loopback UDP server saw 5 STUN binding requests with no CSP and 5 with `connect-src 'none'`, in both Chromium and WebKit (`ice-chromium.json`, `ice-webkit.json`). `Content-Security-Policy: ... webrtc 'block'` logs "Unrecognized Content-Security-Policy directive 'webrtc'" and STUN is still sent, in both engines. So a site CSP can neither allow nor block our WebRTC (matches 03 summary item 12), and STUN/TURN hosts never go into `connect-src`.
- Minimal additions for a site that has a CSP: `script-src` must allow `/_mw/mw.js` and the modules it imports (same origin, `'self'`); `worker-src 'self'` (PoW worker, SW registration); `connect-src` the tracker `wss:` URLs plus the DoH endpoints when DNS pointers are used (Cloudflare, dns.sb and Google per v0.2 section 4). Not needed: `blob:`, `data:`, `'unsafe-inline'`, `'unsafe-eval'`, `'wasm-unsafe-eval'`, STUN/TURN origins. [MDN] `worker-src` governs `Worker`, `SharedWorker` and `ServiceWorker` and falls back to `child-src`, `script-src`, `default-src` [S15].

**F28. Sites with `strict-dynamic`, nonces or hash-based CSP need the tag itself to be trusted.** Confidence: High (docs), Unverified for module-script behaviour.
- MDN: with `'strict-dynamic'`, "any allowlist or source expressions such as 'self' or 'unsafe-inline' will be ignored"; trust comes from a nonce or hash on the root script; a nonce "has to be unique for each HTTP request"; an external script under a hash policy must carry `integrity` and every valid hash in `integrity` must also be in `script-src` [S15].
- A static host cannot mint per-request nonces. For such sites `publish.mjs --dropin` should stamp `integrity="sha384-..."` on the tag and print the hash to add to `script-src`; dynamic sites add their nonce to our tag in their template. Whether a hash-trusted module root propagates trust to its static and dynamic imports under `strict-dynamic` was not tested.

**F29. Safari lacks three APIs v0.2 leans on, and Chrome's prerender needs a guard.** Confidence: High ([BCD] + [EXP]).
- `requestIdleCallback`: Chrome 47, Firefox 55, Safari behind a flag, iOS no; WebKit 27.2 `typeof requestIdleCallback === "undefined"`. v0.2 3.4.3 starts the engine "at requestIdleCallback": add a `setTimeout` fallback (WebTorrent itself guards its use).
- `Document.prerendering`: Chrome 108+, absent in WebKit. MDN: use `prerenderingchange` to delay "activities that previously would be started by default on page load" until the page is actually viewed [S15]; otherwise a Speculation-Rules prerender starts a P2P session for a page the visitor may never open.
- `navigator.connection`: Chrome only (Firefox removed, Safari none); `saveData` Chrome 65 and Samsung 9 only. v0.2 section 8 already treats unknown as cellular on mobile; do not read `saveData` unguarded.
- Present in both engines: `SharedWorker`, `navigator.locks`, `BroadcastChannel`, `navigator.storage.getDirectory`, transferable `ReadableStream`, `AbortSignal.timeout`, `Promise.withResolvers`, `structuredClone`, and in WebKit 27.2 `Uint8Array.prototype.toHex` (`tag-api.json`).

**F30 [DC]. Never inject a CSP `<meta>` into a host page.** Confidence: High (both engines).
- [EXP] (`csp-meta.json`) with no header CSP, a script-inserted `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">` made the page's very next `fetch()` fail (it was allowed before the insertion); with a header `connect-src 'none'`, inserting a meta `connect-src *` did not loosen anything (still blocked). Chromium 156 and WebKit 27.2 agree. MDN: the meta route "does not support all CSP features" [S15].
- v0.2 5.1 step 6 inserts the CSP meta in `boot.js`; that is right for the shell page we own and wrong for a drop-in page: the host's own scripts, fonts, analytics and fetches would be restricted by our policy as soon as it is inserted. In drop-in, `mw.js` must not touch the host's CSP at all; publish prints the additions (F27) for the owner to put in their own policy.

**F31. Analytics, tag managers and other third-party scripts keep working; the measurements change.** Confidence: Medium-Low (reasoning over the v0.2 design; no site was instrumented).
- 3.4.2(d) leaves cross-origin, non-GET, worker-script and manifest requests untouched, so Google Analytics, tag managers, chat widgets and web fonts load as before. Page views still reach the host (navigations are network-first), so page-view analytics are unchanged; subresource requests and egress fall for repeat visitors (the goal), so CDN dashboards and server logs will show less traffic than visits.
- `PerformanceResourceTiming` for worker-served requests carries `workerStart > 0` and a small `transferSize` (standard behaviour, not measured here), which RUM tools may display as cache hits.
- Consent-management platforms: the engine writes IndexedDB and Cache Storage and opens connections that expose the visitor's IP address to peers (03). Whether that needs consent under ePrivacy/GDPR is a legal question I did not research (open question 9). The hook already exists: v0.2's `mw.consent.accept()`; keep the engine OFF until the host's CMP calls it when the site requires that.

### 4.7 Coexistence, rollback and the web seed

**F32. Rollback needs the worker replaced at the same URL, not just the tag removed.** Confidence: High.
- Workbox: deploy a no-op worker at the same URL ("be certain that the service worker URL remains unchanged!"); `Clear-Site-Data: "storage"` only as an addition [S9]. MDN: `"storage"` removes "service worker registrations" together with IndexedDB, localStorage and the rest of the origin's DOM storage, secure contexts only; [BCD] `Clear-Site-Data`: Chrome 61, Firefox 63, Safari 17 [S15]. It wipes ALL origin storage including the site's own, so use it only on a dedicated path.
- v0.2 7.1 already ships `kill-switch.js` as `/mw-sw.js`. Additions: (1) removing the script tags first leaves controlled browsers with a live worker; leave the kill switch deployed until the longest return interval has passed (the browser checks for a changed worker on navigation, and a registration is stale after 24 h for functional events, [S24-04] F13), a month is a reasonable floor; (2) the kill switch should also `indexedDB.deleteDatabase` the `mw-*` databases, not only delete caches; (3) Workbox's `Service-Worker` request-header trick is useful when the previous URL was versioned (ours is permanent, so not needed).

**F33. Foreign-worker integration is right but has one synchronous-versus-asynchronous trap.** Confidence: High (recipe), Medium (trap, by reasoning from the fetch event rules).
- Detection and recipe as in F4: `getRegistration('/')`, compare `scriptURL`, `importScripts('/_mw/sw-core.js')`, `if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event))`. For Workbox: `generateSW` `importScripts: ['/_mw/sw-core.js']` is one config line; `injectManifest` needs the two lines added to `swSrc` by hand [S9]. Keep the path permanent (F4).
- The trap: `respondWith()` must be called synchronously while the event is dispatched, so `owns()` has to decide synchronously, but after a cold start the index is asynchronous (F9/F10). Resolution: in OUR worker, claim optimistically (same-origin GET subresource from a mapped client under the base, not excluded) and await the index inside `handle()` with the cap, falling back to `fetch(event.request)`. In a FOREIGN worker an optimistic claim would steal requests the foreign worker's own routes (for example a Workbox precache entry) should serve, so `owns()` must return true only when the index is already loaded; the first requests after a cold start fall through to the site's routes. Document foreign mode as best-effort.

**F34 [DC]. The web-seed rewrite needs per-file coalescing, because a full-file fetch per piece can multiply host egress.** Confidence: High (one engine measured, source read), Medium (other engines).
- [CODE] one Range request per remaining piece (F19). v0.2 3.4.7 answers each with a `fetch('/<path>', {cache: 'force-cache'})` of the whole file and slices it.
- [EXP] Chromium 156, a page fetching the same file 5 times with `cache: 'force-cache'`, server GETs counted (`hcache-chromium.json`, `hcache-chromium-persistent.json`):

| Profile | Header | 1 MB | 10 MB | 50 MB | 120 MB |
|---|---|---|---|---|---|
| Ephemeral Playwright context (in-memory cache) | `no-cache`+ETag, `max-age=600`, `max-age=31536000, immutable` | 1 GET | **5 GETs** | **5 GETs** | **5 GETs** |
| Ephemeral context | `no-store` | 5 | 5 | 5 | 5 |
| Persistent profile (disk cache) | `no-cache`+ETag, `max-age=600`, `immutable` | 1 | 1 | 1 | 1 |
| Persistent profile | `no-store` | 5 | 5 | 5 | 5 |

- So the HTTP cache only saves the host from re-download in a persistent profile and when the host does not send `no-store`; with an in-memory cache (what an ephemeral context uses; whether a real private window behaves the same was not tested) or a small cache, every piece request re-downloads the file. A 10 MB file at 256 KiB pieces is 40 piece requests, up to 400 MB of egress for one visitor in that situation. Even on a cache hit each request reads and copies the whole entry before slicing.
- The rewrite is still the best available design: because it reads the decoded full body it is immune to the Range-over-compressed-bytes bug (w1-10 F4: GitHub Pages returned `206` with `Content-Range` against the gzip size) and to hosts that ignore Range (Cloudflare Pages, F7).
- Fix: coalesce in the worker (`Map<btih/path, Promise<Blob>>`, LRU of 2 to 3 files, bounded to a memory cap such as 32 MiB); for larger files either stream once into Cache Storage as a full `200` response and slice from there, or exclude them from the rewrite (peers only) and say so in `publish`. Never fall back to per-piece full-file fetches. Add a per-session egress counter and stop the host web seed when it exceeds `maxSiteBytes`.

---

## 5. Recommended embedded-mode design (concrete, tested against v0.2 3.4)

This keeps v0.2's architecture and changes only what the evidence demands. Items marked (new) are not in v0.2.

### 5.1 The script tag and its options

Minimum, one line per HTML page, in `<head>`:

    <script type="module" src="/_mw/mw.js" async></script>

Full form (every attribute optional; defaults are safe):

    <script type="module" src="/_mw/mw.js" async data-cfasync="false" integrity="sha384-..."
            data-mw-engine="on" data-mw-sw="on" data-mw-ledger="on" data-mw-consent="notice"
            data-mw-delay="3000" data-mw-budget="0"></script>

| Attribute | Values (default first) | Meaning |
|---|---|---|
| `data-mw-engine` (new) | `on`, `host`, `off` | `on`: v0.2 behaviour (engine after the dwell time, peers when consented). `host`: serving, offline copy and the HTTP-side fill only; no tracker socket, no WebRTC (keeps back/forward-cache eligibility in every engine, and is what the engine falls back to on `no-store` documents, 5.4). `off`: the script is a no-op and registers nothing |
| `data-mw-sw` (v0.2) | `on`, `off` | `off`: never serve from the torrent (ledger and seeding only) |
| `data-mw-ledger` | `on`, `off` | `off`: no ledger node, no gossip |
| `data-mw-consent` | pointer's value, `notice`, `gate`, `custom` | `custom`: the site renders its own notice and calls `mw.consent.accept()`, for example from a CMP callback. May only be stricter than the signed pointer's `consent=` |
| `data-mw-delay` (new) | `3000` | Milliseconds of continuous visibility before the first announce (v0.2's 3 s) |
| `data-mw-budget` (new) | `0` (unlimited) | Optional cap on peer-connected page views per visit session, for high-traffic sites that want to limit tracker load and battery (5.4, F24); with a positive number, further pages run host-only unless the copy is incomplete |
| `data-cfasync` | `false` | Cloudflare Rocket Loader opt-out; must appear before `src` (F7) |
| `integrity` | `sha384-...` | Stamped by `publish --dropin` when a CSP hash or `strict-dynamic` is in use (F28) |

Rules: attributes can only REDUCE capability relative to the signed pointer (cannot override `consent=gate`, `max`, trackers or expiry, because the tag is unsigned HTML); unknown attributes are ignored; the loader finds its tag with `document.querySelector('script[type=module][src*="/_mw/mw."]')` from its own `import.meta.url`, never through `document.currentScript` (F26). Build-time options are NOT attributes; they are `publish.mjs --dropin` flags stored in `/.mw/site.json`: `--base`, `--exclude`, `--min-bytes`, `--max-file`, `--keep-days`, `--verify-host`, `--csp`, `--integrity`. Placing site-level exclusions in the signed torrent keeps the unsigned tag from widening what the worker may serve.

### 5.2 What `publish.mjs --dropin` must emit or check

1. The tag (with `integrity` when requested) and the stamped `<meta name="mw-pointer">` as the first child of `<head>`; all reserved paths base-prefixed when `--base /repo/` is given (R6).
2. `--verify-host <url>`: fetch each listed path from the live host with browser-like `Accept` and `Accept-Encoding`, compare SHA-256 with `/.mw/files.json`, report `Content-Encoding`, `Vary: Accept`, status and size differences; refuse to print the pointer on mismatch (F15, R12).
3. A CSP report for the site's current policy, printing exactly what to add: `script-src` (the tag; hash or nonce notes), `worker-src 'self'`, `connect-src` trackers and DoH hosts, and the statement "STUN/TURN hosts, `blob:`, `data:`, `unsafe-inline`, `unsafe-eval` are not needed" (F27). Never change the site's CSP itself (F30).
4. A naming audit: share of non-HTML bytes without content hashes in the filename, with the F13 table's consequences.
5. A warning when `Cache-Control: no-store` is sent on non-HTML files (defeats the HTTP cache the web-seed rewrite relies on, F34) and when the host is Cloudflare Pages without a separate seed (Range is ignored, F7; the rewrite makes this workable, but say so).
6. Upload order and the keep window of v0.2 3.4.5 (non-HTML first, previous deploy kept 7 days).

### 5.3 What the worker does with each request

| Request | Policy |
|---|---|
| Navigation (any) | Network-first with the default cache mode (honour the host's freshness, F14); optionally enable navigation preload (R9) and, if enabled, always consume `preloadResponse` (F12); on network failure serve the stored copy (F16 rules); read the stamp from the first 4 KiB of a `tee()`; never synthesise redirects, 404s or headers |
| Same-origin GET subresource, client mapped to a btih, path listed, copy complete and verified | Serve from IndexedDB (honour `Range`, 206) |
| Same, copy incomplete | Pass through to the host; the engine fills the copy in the background |
| Same-origin GET subresource, client NOT yet mapped (cold start) | Await the persisted map/index up to 40 ms inside `respondWith`, then decide; on timeout pass through (F10, R1) |
| `/_mw/ws/*` | Web-seed rewrite with per-file coalescing and a size cap (F34, R2) |
| `/_mw/t/*` | Pass through, never cached. Rest of `/_mw/*`: precache |
| Cross-origin, non-GET, worker scripts, manifests, `<embed>`/`<object>` (never reach the SW) | Not touched |
| Anything uncertain | Pass through (fail open). A navigation is never left unanswered or rejected, because Firefox unregisters a worker whose navigations fault three times ([S24-04] F13) |

The client -> btih map is persisted in IndexedDB (key `clientId`, LRU, deleted with the site record) so it survives worker restarts; `mw-map-client` messages refresh it.

### 5.4 Engine policy: what runs on which page view

Start the engine only when ALL hold:
- Top-level window, secure context, not prerendering (`document.prerendering` false, or after `prerenderingchange`) (F29).
- `data-mw-engine` is `on`; consent satisfied (v0.2 section 8).
- The page has been continuously visible for `data-mw-delay` (default 3 s), scheduled with `requestIdleCallback` when it exists and `setTimeout` otherwise (WebKit has none).
- The engine lock is won (`navigator.locks.request('mw-swarm-<ledgerId>', ...)`); otherwise this page is a follower that talks to the leader over `BroadcastChannel`. If `navigator.locks` is undefined (Lockdown Mode) run host-only.
- The document is not `Cache-Control: no-store`: the worker reads that header from the navigation response and tells the page in its stamp message, and the page opens no tracker socket until it has heard (or has waited a short cap and assumes ordinary). On `no-store` documents run host-only, because in Chromium any WebSocket or WebRTC use then excludes the page from the back/forward cache for life (F20).
- Optional visit budget (`data-mw-budget`, default unlimited): positive values cap peer-connected page views per visit session, tracked in `localStorage` with a `sessionStorage` fallback, both in try/catch; a session ends after 30 minutes of inactivity. Overrides: incomplete copy, a pending ledger write, or an active `mw.db.subscribe` (the ledger needs peers by definition).

Otherwise run host-only: no tracker socket, no `RTCPeerConnection`. On every exit path close tracker sockets and peers and flush: `pagehide`, `visibilitychange` to hidden and `freeze` (on mobile `pagehide` may not fire); on `pageshow` with `persisted` rebuild only if the conditions above hold (F20, F21). Start-up work per page is cheap by design: `seedFromCache` without re-hashing (v0.2 3.4.6), ledger opened from IndexedDB with a HELLO/SYNC delta.

Cost to state in the README: a fresh client takes about 150 to 170 ms of JS before the first wire even on loopback (F24), then one announce round per tracker per page view that gets past the dwell time. That, not the back/forward cache, is the reason for the optional budget; whether a default budget pays off needs real traffic (open question 3).

### 5.5 Detecting embedded mode versus shell mode

Do not sniff at runtime. Use three layers:
1. **Build time.** Two entry points and two worker bundles, each with a `MODE` constant baked in: `/_mw/mw.js` + drop-in `/mw-sw.js`, or `/_mw/boot.js` + `/_mw/loader.js` + shell `/mw-sw.js`. Only one mode's files are published for a given site.
2. **Handshake.** The page's first message to the worker carries `{ proto: 1, mode, buildId }` (v0.2 already versions messages with `proto`); the worker stores `mode` in its IndexedDB meta and replies with its own. On a mismatch the worker stops serving (no `respondWith`), the page stays inert, and a console line says "mode mismatch: redeploy `mw-sw.js` and `/_mw/` together". This is what makes a drop-in -> shell migration safe despite the permanent `/mw-sw.js` URL.
3. **Guards.** Do not start in a frame (`window.top !== window`): storage is partitioned in frames in current browsers (not tested here), so the engine would re-download per embedding site. Do not register over a foreign worker (3.4.4). Never touch the host's CSP (F30).

### 5.6 Rollback and removal (a migration promise)

1. Replace `/mw-sw.js` with the kill switch at the same URL (no-op worker that clears `mw-*` caches, deletes the `mw-*` IndexedDB databases, unregisters and navigates clients). Keep it deployed for at least a month (browsers check for a changed worker on navigation; a registration is stale after 24 h, F32).
2. Then remove the tags and `/_mw/`. Removing the tags first leaves controlled browsers with a live worker.
3. Optional belt and braces: a dedicated path that sends `Clear-Site-Data: "storage"` (Chrome 61, Firefox 63, Safari 17); it wipes ALL origin storage, so never site-wide.
4. The host's files were never moved: the site is exactly as before, which is the strongest argument for drop-in as the migration default (w2a-05).

---

## 6. What will not work (state this in the README and DEPLOY.md)

1. **Hosted builders without a root file** (Ghost(Pro), Squarespace, Wix, Webflow as of w2a-02 F26): no way to serve `/mw-sw.js` at the origin root, so no drop-in. Export first.
2. **Sub-path hosting in v0.2 as written**: root-absolute `/_mw/...` and `/mw-sw.js` only. Works for GitHub project sites only after R6, and then as a shared origin (F17).
3. **Cloudflare Pages as a stand-alone Range web seed**: it answers Range with `200` and the full body (docs updated 2026-10-10, probe 2026-10-17). It works only through the same-origin rewrite, with the egress caveat of F34.
4. **Hosts or CDNs that alter static bytes** (image optimisation such as Polish, edge minification, `Accept`-dependent formats): web-seed pieces fail SHA-1 and the URL is discarded (F15). Disable the transform for those paths or exclude them.
5. **A CSP that uses `strict-dynamic` or nonces** unless the tag carries the nonce or an `integrity` hash allowed in `script-src` (F28). A page with `sandbox` CSP or in a cross-origin frame cannot run the engine.
6. **Personalised or cookie-dependent HTML** cached offline without the F16 rules; **authenticated or per-user subresources** (exclude them in `site.json`).
7. **`<embed>`/`<object>` resources, shift-reload navigations and cross-origin requests**: never go through the worker (04 F10).
8. **A site whose own Service Worker cannot be edited** (for example a third-party plugin that rewrites it on every build): our worker cannot coexist (one registration per scope); ledger and seeding still run, serving does not (3.4.4).
9. **Sustained seeding on multi-page sites**: every navigation destroys the engine ([S24-03] summary 12, F23), and iOS suspends data-only WebRTC when backgrounded ([S24-03] summary 11); contributions are page-view-sized bursts. Sustained seeding needs shell mode or `pin.mjs`.
10. **Keeping the engine alive across navigations in one tab** without soft navigation: impossible (hidden iframe, SharedWorker and worker-hosted WebRTC are all ruled out, F23).
11. **Back/forward cache on `Cache-Control: no-store` documents**: in Chromium any WebSocket or WebRTC use excludes such a page for life, even after closing (F20); those pages must run host-only, and the README should say so.
12. **Restricting WebRTC through the site's own CSP**: no enforced directive exists in the engines tested (F27), so a site owner cannot block our peer connections that way.
13. **Server-side logs as the source of truth for asset traffic**: repeat visitors' subresources are served from IndexedDB and peers (F31).
14. **Safari Lockdown Mode, Tor Browser, WebViews without Service Workers, Firefox private windows before 140**: no Service Worker; the site works from the host, which is the fail-open design ([S24-04] F15).
15. **Hosts that cannot keep the previous deploy's hashed files for the keep window**, or that overwrite same-name files in place: consistency guarantees shrink to files already in the visitor's IndexedDB (F13).

---

## 7. Concrete recommendations for magnet-web

Priority P0 = fix before building the drop-in path; P1 = needed for the migration promise; P2 = important hardening; P3 = later. Effort S = under a day, M = a few days, L = a week or more.

| ID | What to build or change | Pri | Effort | Why (evidence) |
|---|---|---|---|---|
| R1 | Replace "never delay, pass through after cold start" (3.4.2) with a capped await (40 ms) for the index and persisted client -> btih map; claim optimistically in our own worker, foreign mode stays best-effort | P0 | S | Cold SW starts are the norm in MPAs; manifest read is about 1 ms (F9, F10, F33) |
| R2 | Web-seed rewrite: per-file in-flight coalescing, LRU of 2 to 3 files within a memory cap, stream larger files into Cache Storage or exclude them, egress counter per session; never one full fetch per piece | P0 | S-M | One Range per piece; ephemeral contexts re-download files of 10 MB and up; `no-store` defeats the cache (F19, F34) |
| R3 | CSP: skip the CSP `<meta>` in drop-in; print the measured additions; stamp `integrity` and print the hash for `strict-dynamic`/hash policies; document that STUN/TURN/`blob:`/`unsafe-*` are not needed | P0 | S | A script-inserted meta restricts the host page immediately; ICE is outside `connect-src` (F27, F28, F30) |
| R4 | Tag and platform guards: find the tag by selector, `setTimeout` fallback for `requestIdleCallback`, `prerenderingchange` guard, no unguarded `connection.saveData`, `data-cfasync="false"` in the generated tag, `Uint8Array` polyfill self-test stays | P0 | S | `currentScript` is null in modules; WebKit 27.2 lacks rIC, prerendering, `connection` (F26, F29, F7) |
| R12 | `publish.mjs --dropin --verify-host <url>`: compare live host bytes with the torrent before printing the pointer | P0 | M | BEP 19 discards the URL on a hash mismatch; Polish and similar alter bytes silently (F15) |
| R17 | Edit ARCHITECTURE v0.2: 3.4.2 cold-start text, 3.4.6 add the `no-store` rule and the extra cleanup events, 3.4.7 safeguard, 3.4.9 CSP set, 5.1(6) "not in drop-in", the `data-mw-*` table | P0 | S | Sections 3 and 4 |
| R5 | Back/forward-cache safety: (a) close tracker sockets and peers on `pagehide`, `visibilitychange` hidden and `freeze`; (b) the worker reads `Cache-Control` of each navigation response and tells the page; on `no-store` documents run host-only and open no tracker socket before the page has heard; (c) a Chromium E2E that connects a pair, navigates away and asserts no `WebRTC`/`WebSocket` not-restored reason | P1 | S | Live peers block bfcache, closing restores it on ordinary pages, `no-store` pages are blocked for life by any WebSocket/WebRTC use (F20, F21) |
| R6 | `--base /repo/` for drop-in: worker and `_mw/` under the base, default scope (no header needed), base-prefixed stamps, path mapping `pathname.slice(base.length)`, "shared origin" notice and ledger keys already namespaced | P1 | M | Scope rule reproduced in both engines; GitHub project sites (F17, F18) |
| R7 | Foreign-SW kit: detection, Workbox `generateSW` `importScripts` snippet and `injectManifest` lines, permanent-path rule, foreign mode documented as best-effort, a fixture with a Workbox worker | P1 | S | OneSignal, SwarmCloud, Workbox (F4, F33) |
| R8 | Mode handshake: build-time `MODE` in both entry points and both worker bundles; worker stops serving on mismatch | P1 | S | Permanent `/mw-sw.js` URL makes silent mode mixing possible (5.5) |
| R16 | E2E fixtures: strict-CSP site, sub-path site, edge-transform host (altered image bytes), own Workbox worker, `no-store` HTML (host-only expected), private-window web-seed egress, bfcache probe with connected peers, Rocket Loader-style async reordering | P1 | M | Items above; DESIGN-REVIEW item 23 acceptance list |
| R9 | Navigation preload in the drop-in worker's navigation path (always consume `preloadResponse`), enabled after a phone measurement shows a gain | P2 | S | Supported everywhere above the floor; no desktop gain measurable; mobile numbers are [OLD] (F9, F12) |
| R10 | Offline HTML hygiene: skip `Set-Cookie`, `Vary: Cookie`/`*`, `private`/`no-store`, redirected responses; opt-in for cookie-bearing requests | P2 | S | F16 |
| R11 | Rollback docs and kill switch also deletes `mw-*` databases; keep-window of at least a month; dedicated-path `Clear-Site-Data` recipe | P2 | S | F32 |
| R13 | Optional visit budget (`data-mw-budget`) and tracker etiquette: one tracker for non-first starts, jitter, no re-announce within 120 s of the last in the visit session, honour `Retry-After`; decide the default from real traffic | P2 | S | A fresh client costs 150 to 170 ms of JS and one announce round per page view; trackers publish no rate limits (F24) |
| R14 | Optional `--min-bytes`/`--exclude`: serve small text assets from the host (HTTP-first), peers for larger files | P3 | M | HTTP-first precedent (F2); compression asymmetry (open question 6) |
| R15 | Opt-in soft navigation (`data-mw-nav="soft"`) on the Navigation API with a per-link opt-out | P3 | L | Only way to keep the engine alive in one tab; real compatibility price (F25) |

---

## 8. Gotchas

1. A SW's default scope is its own directory; `Service-Worker-Allowed` is needed for anything broader and static hosts like GitHub Pages cannot send it (F17).
2. `document.currentScript` is `null` in module scripts in both engines; `import.meta.url` includes the query string (F26).
3. WebKit 27.2 has no `requestIdleCallback`, `document.prerendering`, `navigator.connection` or `scheduler.postTask` (F29).
4. A script-inserted CSP meta takes effect for later requests and can only tighten (F30). Never inject one into a host page.
5. `connect-src` does not cover ICE/STUN; `webrtc 'block'` is an unrecognized directive in Chromium and WebKit (F27).
6. The bundle's `fsa-chunk-store` import installs a `createWritable` polyfill that needs `worker-src blob:` and wipes the OPFS `chunks` directory at import; always pass your own store (F27).
7. In Chromium a live WebRTC connection blocks the back/forward cache and closing it (in `pagehide` or earlier) restores eligibility on ordinary pages, but on `Cache-Control: no-store` documents any WebRTC or WebSocket use blocks it for life (F20). Close on `pagehide`, `visibilitychange` hidden and `freeze`.
8. Unanswered offers, open WebSockets (ordinary HTML), held Web Locks, open IndexedDB connections and a real WebTorrent client announcing with no peers did not block bfcache in Chromium 156; web.dev says other browsers block open WebSockets (F20, F21).
9. Web Locks leader failover takes 1 to 8 ms but starts a fresh client (F22, F24). Lockdown Mode disables Web Locks.
10. SharedWorker exists on iOS Safari 16+ and Firefox, is missing in Samsung Internet and reached Chrome Android in 148, and cannot create `RTCPeerConnection` anyway (F23).
11. WebTorrent issues one Range request per piece (up to 256 KiB), so a full-file fetch per request amplifies egress unless coalesced (F19, F34).
12. Cloudflare Pages ignores Range (`200` with the full body); GitHub Pages sends `max-age=600` and no custom headers; the S3 website endpoint redirects a folder without a trailing slash with `302` (F7, F14, F18).
13. Do not force revalidation of navigations in the SW: it makes repeat navigations slower than the site without the layer (F14).
14. A redirected response cannot answer a navigation; never store `response.redirected` HTML (F16; carried from 04).
15. `navigationPreload` without consuming `preloadResponse` doubles every navigation request (F12).
16. `async` on `type="module"` runs the script as soon as fetched; register the SW after `load` and start the engine after the dwell time, not at execution (F26, v0.2 3.4.3).
17. `Cache.put` rejects 206 responses (04): store full `200` responses only.
18. A removed tag does not remove the worker: replace `/mw-sw.js` at the same URL first (F32).
19. `Clear-Site-Data: "storage"` also wipes the site's own IndexedDB/localStorage; use it on a dedicated path only (F32).
20. Project sites on one GitHub user share an origin; any of them can read another's IndexedDB (F17).
21. The `createWritable` version split differs between sources: v0.2 and `browser-mobile.md` say Safari 15.2 to 18.1, MDN BCD 8.1.6 says Safari/iOS 26 (open question 5).
22. Playwright's WebKit is not Safari (no ITP, no Lockdown Mode, no page cache); Firefox could not be run; every browser statement here is Chromium 156 or WebKit 27.2 unless stated.
23. Full Chromium (new headless) did not connect WebRTC between two pages here and its in-page loopback was intermittent; the headless shell connects but disables bfcache. The first version of the bfcache experiment was invalid because of this (section 2); verify `setupCompleted` and ICE state in any future lab.
24. The fetch tool paraphrases; quotes marked "as extracted" were not verbatim page text.

---

## 9. Open questions

1. **Real-device cost.** Phone numbers for SW cold start, manifest read, navigation preload and the 40 ms cap; the DESIGN-REVIEW "within 5% LCP" target is unmeasured. Needs an Android mid-range device and an iPhone.
2. **Firefox and real Safari.** bfcache behaviour with connected peers (source says Firefox blocks until closed, WebKit suspends), Web Locks and Lockdown Mode behaviour, `resultingClientId` on iOS, Safari private browsing with a Service Worker.
3. **Budget default.** Is 1 peer-connected page per visit the right default? Needs real traffic: seeding contribution lost versus back/forward restores kept, and a bfcache hit-rate measurement (CDP in tests; in the field the Not Restored Reasons API was not verified here).
4. **Real peers under bfcache.** A two-peer WebTorrent transfer across pages (real connected peers, tracker, answers) was not measured; the primitives and the Blink source agree. Also open: Firefox and Safari with peers (source only), other Chrome versions (the sticky `no-store` rule and the plain-`no-store` allowance are recent behaviour), and how reliably `pagehide`/`freeze` run on mobile before navigation.
5. **`createWritable` in Safari.** v0.2 says the polyfill applies to Safari 15.2 to 18.1; BCD says native support starts at 26. Which versions need `worker-src blob:` if the default store is ever used? (Not needed while `MemoryChunkStore` is always passed.)
6. **Compression asymmetry.** Torrent pieces carry uncompressed bytes while the host serves brotli; for small text files P2P is larger than the CDN. Where is the size threshold (R14)? Not measured.
7. **Rocket Loader and `type="module"`.** Does it rewrite or reorder module scripts? Not documented on the page read. Test on a Cloudflare zone.
8. **`strict-dynamic` with a hash-trusted module root.** Does trust propagate to the static and dynamic imports (`loader.js`, `webtorrent.min.js`)? Not tested.
9. **ePrivacy/GDPR.** Do IndexedDB/Cache Storage writes and IP exposure to peers need consent on EU sites, and how does that interact with a CMP? Legal question, not researched (EDPB guidance exists but was not read).
10. **HTTP `Link: rel=serviceworker` registration.** Not in MDN BCD or the spec index; could not be verified (search budget). Treat as unavailable.
11. **Googlebot and Service Workers today.** The Search Central JavaScript page (updated 2026-03-04) is silent; a 2018-era statement said the renderer did not support them. Irrelevant to a fail-open design, but the SEO file may want it.
12. **Frames.** Whether current browsers give a framed drop-in page partitioned storage in practice (assumed in 5.5); affects whether to stay inert in frames.
13. **Edge byte alteration.** Which Cloudflare Polish/Mirage/other settings alter bytes of which formats; `--verify-host` will tell per site, but a catalogue would help the migration guide.
14. **Soft navigation.** Is a Navigation API router worth building (R15) or is "upgrade to shell after the first page" simpler for MPAs? DESIGN-REVIEW defers both.

---

## 10. Source index (every URL below was fetched, downloaded or executed in this run)

Dates are the source's own where it has one; otherwise "fetched 2026-10-17". Fetch-tool pages are extractions by a small model: figures that drive a decision were cross-checked against a second source or a local measurement, and paraphrases are marked "as extracted" in the text.

**Precedents and vendor guidance**
- S1 https://raw.githubusercontent.com/xuset/planktos/master/README.md (Planktos README; project last commit 2018-09-18 per 04).
- S2 https://github.com/Novage/p2p-media-loader (README); https://registry.npmjs.org/p2p-media-loader-core and https://registry.npmjs.org/p2p-media-loader-hlsjs (release dates computed from the registry JSON). A first guess, `https://registry.npmjs.org/@p2p-media/core`, returned 404.
- S3 https://www.swarmcloud.net/web-hls and https://www.swarmcloud.net/web-hls/API (undated).
- S4 https://github.com/Peer5/P2PXHR (README, undated; Chrome 26+ / Firefox 23+ [OLD]).
- S5 https://arxiv.org/abs/2212.02740 and https://arxiv.org/pdf/2212.02740 (Tang et al., "Stealthy Peers", submitted 2022-12-06; PDF read with `pdftotext`) [OLD: 2022].
- S6 https://docs.joinpeertube.org/api/embed-player and https://docs.joinpeertube.org/admin/privacy-guide (undated).
- S7 https://documentation.onesignal.com/docs/en/onesignal-service-worker (undated).
- S8 https://partytown.qwik.dev/distribution/ (undated; `partytown.builder.io` refused the connection).
- S9 https://developer.chrome.com/docs/workbox/remove-buggy-service-workers ; https://developer.chrome.com/docs/workbox/caching-strategies-overview ; https://developer.chrome.com/docs/workbox/modules/workbox-navigation-preload ; https://developer.chrome.com/docs/workbox/reference/workbox-build/ (undated).
- S10 https://jakearchibald.com/2016/caching-best-practices/ (2016-04-27) [OLD, still the reference].
- S11 https://web.dev/blog/navigation-preload (last updated 2017-02-15) [OLD].
- S12 https://web.dev/articles/bfcache (last updated 2026-10-16; read from the raw HTML).
- S13 https://developers.cloudflare.com/speed/optimization/content/rocket-loader/ignore-javascripts/ ; https://developers.cloudflare.com/pages/configuration/serving-pages/ (updated 2026-10-10) ; https://developers.cloudflare.com/images/polish/ (updated 2026-08-14) ; https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/ (read; no script-injection example on the page).
- S14 https://turbo.hotwired.dev/handbook/drive.
- S15 MDN: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src ; .../connect-src ; .../script-src ; https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP ; https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data ; https://developer.mozilla.org/en-US/docs/Web/API/Document/prerendering (all undated).
- S16 https://unpkg.com/@mdn/browser-compat-data/data.json (MDN browser-compat-data 8.1.6, timestamp 2026-10-15; support values computed locally, mirrors resolved).
- S17 https://www.bittorrent.org/beps/bep_0019.html.
- S18 https://docs.aws.amazon.com/AmazonS3/latest/userguide/IndexDocumentSupport.html.
- S19 https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics (updated 2026-03-04; silent on service workers).
- S20 https://w3c.github.io/ServiceWorker/ (Editor's Draft; first 100,000 and last 30,000 characters read; the `Link` registration section was not found).

**Engine and package sources (raw `main`, fetched 2026-10-17)**
- S21 Chromium: https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/peerconnection/rtc_peer_connection.cc ; .../rtc_data_channel.cc ; https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/common/scheduler/web_scheduler_tracked_feature.cc. Firefox: https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/base/Document.cpp ; .../dom/base/nsGlobalWindowInner.cpp ; .../dom/media/webrtc/jsapi/PeerConnectionImpl.cpp. WebKit: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/mediastream/RTCPeerConnection.cpp ; .../RTCDataChannel.cpp. (`content/browser/renderer_host/back_forward_cache_impl.cc` returned 404 at that path; the GitHub commits API was rate-limited.)
- S22 Local: `node_modules/webtorrent` 3.0.21 (`lib/webconn.js`, `lib/torrent.js`, `dist/webtorrent.min.js` string scans), `node_modules/fsa-chunk-store` 1.3.0 (`index.js`, `createWritable.js`).

**Live probes and local measurements**
- S23 GET with `Range: bytes=0-9`, 2026-10-17: https://mdn.github.io/dom-examples/service-worker/simple-service-worker/app.js (206, `max-age=600`) ; https://gohugo.io/ (206, Netlify) ; https://nextjs.org/favicon.ico (206, Vercel) ; https://cloudflare-pages-demo.pages.dev/ (200, 4502 bytes) ; https://developers.cloudflare.com/favicon.ico (200, 908 bytes) ; an `d1.awsstatic.com` asset (206).
- S24 Earlier files of this project (read in full or by section): `docs/ARCHITECTURE.md` v0.2, `docs/INTERFACES.md`, `docs/review/DESIGN-REVIEW.md`, `docs/review/browser-mobile.md`, and research `01`, `02`, `03`, `04`, `06`, `w1-07`, `w1-10`, `w2a-02`, `w2a-05` (cited as S24-xx).
- S25 This run's lab: `docs/research/labs/w2a-04-experiment/` (section 12).

**Searched but not opened (snippets only, not relied on for claims)**
Sansec and a plannotator pull request on the CSP `webrtc` directive (superseded by my own test, F27); Bugzilla 1783489 and MDN content issue 19218 (CSP `webrtc`); DeepWiki pages on P2P Media Loader; Chromium issue 40251342 (WebRTC in Service Workers); W3C webrtc-extensions issue 77 (RTCPeerConnection in workers).

**Not done because the search budget ran out**
HTTP `Link: rel=serviceworker` status; a Cloudflare-published guide for service workers on existing sites; Netlify and Vercel clean-URL behaviour; Peer5/Streamroot/CDNBye tab-handling documentation beyond the pages read.

---

## 11. Corrections to earlier files (for the editor)

1. `docs/research/04-service-worker-serving.md` R4/F14b says iOS/Safari below 26 run the memory store. The bundle installs a `createWritable` polyfill at import, which makes `SUPPORTS_FSA` true, so the default store becomes the OPFS+Blob-worker store ([S22] code; simulation in F27; the same point is already in `docs/review/browser-mobile.md` M7 and ARCHITECTURE v0.2 section 1). The Safari version boundary is disputed (open question 5).
2. ARCHITECTURE v0.2 3.4.6: the rationale holds for ordinary HTML; add the `Cache-Control: no-store` host-only rule and require cleanup on `visibilitychange`/`freeze` as well as `pagehide` (F20).
3. ARCHITECTURE v0.2 3.4.2: cold-start pass-through (F10); 3.4.7: coalescing (F34); 3.4.9: CSP set (F27); 5.1 step 6: no CSP meta in drop-in (F30).
4. DESIGN-REVIEW section 6: `resultingClientId` verified in WebKit 27.2 (F11).
5. The task premise "SharedWorker: not in iOS Safari?" is outdated: iOS Safari has it since 16 (F23).

---

## 12. Artifacts

All under `docs/research/labs/w2a-04-experiment/` (about 0.5 MB; `README.md` explains how to run). Chromium 156.0.8078.4 and Playwright WebKit 27.2, macOS arm64, 2026-10-17.
- Harness: `lab.mjs` (static server with header hooks, ws tracker, report sink), `browsers.mjs`.
- Runners and results (`results/*.json`): `run-csp` -> `csp-chromium.json`, `csp-webkit-1234.json`; `run-ice` -> `ice-chromium.json`, `ice-webkit.json`; `run-cspmeta` -> `csp-meta.json`; `run-bfcache` -> `bfcache-chromium.json`, `bfcache-chromium-nostore.json` (corrected runs; `NOSTORE=1` for the `no-store` variant); `run-wt-bfc2` -> `wt-bfcache-nopeers.json`; `run-locks` -> `locks-chromium.json`, `locks-webkit.json`; `run-lock-bfc` -> `lock-bfc-chromium.json`; `run-sw` -> `sw-chromium.json`, `sw-webkit.json` (scope, first-load, navigation overhead); `run-sw2` -> `sw2-delay40.json`, `sw2-delay150.json`, `sw2-delay40-nf-i_idb-i_idbs-i_cache-i.json`; `run-rc` -> `rc-chromium.json`, `rc-webkit.json`; `run-tag` -> `tag-api.json`; `run-hcache` -> `hcache-chromium.json`, `hcache-chromium-persistent.json`.
- `run-wt-bfc.mjs` is the unsuccessful two-peer WebTorrent-over-bfcache attempt (the leecher never connected in full Chromium; no result kept). `www/bf.js` keeps the first, invalid bfcache cases under the names `INVALID-*` as a record of the mistake (section 2).
- Not run: Firefox, real Safari, any phone.
