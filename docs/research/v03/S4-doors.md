# S4: Doors for Lightweb: the site lives at its key, domains are doors

- **Date:** 2026-10-20 (ET). **Status:** research and design proposal; nothing is built until the owner signs off. **Applies to:** magnet-web 0.2.1 plus the v0.3 build (becoming Lightweb; names are today's).
- **Question (owner):** the first door, an HTTPS origin serving the loader, can be blocked by name or by outage. How domain-independent can a browser-only system be?
- **Method:** read ARCHITECTURE 3, 4, 5.3, 7; V03-DESIGN-REVIEW 2.1, 2.2.3, 2.10, 2.16, 2.19; R1; S2; S3; DEPLOY; the code and workflows. Web pages were fetched 2026-10-20 through a summarising tool (Medium confidence). Labs ran in Chromium 156.0.8078.4 and WebKit 27.2 (Playwright) on 127.0.0.1, file: and data: only; scripts and raw output: `docs/research/labs/s4-doors-lab/`. Firefox 157 would not launch under Playwright (as in `w1-09-lab`), so its values come from documentation. No phone was used.
- **Labels:** *documented*, *measured* (lab), *reported* (one source), *inference* (mine), *chosen* (the owner can change it). [Keys] are in Sources.

## Summary

1. **A link cannot move itself.** If door 1 does not answer, the browser shows its own error page and no Lightweb code runs; the platform's fallback works per host name, not per site. Only a runner already on the device can fall back: a Service Worker or installed app from an earlier visit, a `web+lightweb:` handler, a file, or a person with a list (F0).
2. **Multi-door links are cheap** (Matrix `via`, Nostr relay hints, magnet `tr`/`ws`). Signed doors go in the pointer (`org=` exists, at most 4; add `dr=`), unsigned hints in a second fragment segment, plus a text card with plain fallback URLs. Measured: a signed hub record is 457 bytes; 4 owner doors add 129; 8 guest doors add 144; the largest case (730 bytes) fits QR version 19 at level L (F1).
3. **Every site can be a door, at reduced strength.** A plain host gives all its sites one origin. Measured: a sandboxed frame has no storage and no worker but keeps network, WebRTC and crypto, so a foreign site can be shown there. Full mode needs its own origin: the owner's address or a wildcard hub (F2).
4. **Doors in the ledger** fit the rules: an owner-only `_doors` key, at most 2,048 bytes, a state rule. It tells an open page or cached copy where else the site lives; it cannot navigate for the visitor. `org=` shares identity, so third-party doors stay out of it (F3).
5. **The installed web app is the strongest lasting door where it exists:** it serves from the worker's cache with the origin blocked (measured for a Chromium tab). iOS gives it separate storage (first launch must be online) and no launch by link; Android opens in-scope https links; desktop Chromium and Firefox can take `web+lightweb:` links, WebKit and phones cannot (F4, F6).
6. **Door kits are checkable:** the v0.3 tree builds 18 files, 2.1 MiB, 606 KB with brotli, twice byte-identical (measured); the release workflow already packs `dist` and a signed hash list. Three free providers can host the loader (F5).
7. **Loader through the swarm:** publish the kit as a site; a visitor with no code cannot use the swarm, and the worker script cannot come from peers (F7).
8. **Signed Exchanges and Web Bundles: no** (Chromium only, special certificate, 7-day signatures, Mozilla negative, managed ChromeOS only) (F8).
9. **data: and file: pages are desktop last resorts:** file: keeps IndexedDB, WebRTC, WebSocket and crypto but no worker; data: loses `crypto.subtle` and all storage (F9).
10. **A door is trusted on first use.** SRI stops partial swaps, not a hostile first page; signed updates and `ml=` protect later. Browser-enforced transparency (WAICT) is a Firefox Nightly prototype (F10).

## Findings with sources

### F0. What blocking does, and what a link can do

- **Blocking in 2025-2026** works by name, address, SNI and, in Russia, whitelist: announced August 2025, first list September 2025 (later extended to banks, shops, taxis), and users said listed resources at times still would not load [hrw]. China has blocked QUIC by SNI since 2024-04-07 [usenix]. *Inference:* doors help against name or address blocks and outages, not a whitelist or shutdown.
- **The platform falls back per host name:** RFC 9460 clients try higher-priority alternatives, then non-SVCB modes; Happy Eyeballs starts the next attempt after 250 ms by default (minimum 100 ms, maximum 2 s) [rfc9460][rfc8305]. No HTML or HTTP feature lets a URL name a second origin (*inference*).
- **Runners that exist:** a Service Worker cache (*measured*, repo e2e 5: host down and browser offline, shell and site render), an installed app, a protocol handler, a file, a person.
- **The fragment never leaves the browser** ("dereferenced solely by the user agent", RFC 3986 3.5 [rfc3986]); a door sees IP, time and `/_mw/*` paths, not the record or the other doors.

### F1. Multi-door links

| Precedent | What it does | Source |
|---|---|---|
| Matrix | `https://matrix.to/#/!room:server?via=a.org&via=b.org`: several `via` parameters allowed | [matrix] |
| Nostr NIP-19, NIP-65 | relay hints optional and repeatable; a signed replaceable relay list, "2-4 relays of each category" | [nip19][nip65] |
| IPFS | `@helia/verified-fetch` "offers automatic fallback across multiple providers" | [ipfs] |

**Measured on the repo's code** (`link-sizes.mjs`, `dr-roundtrip.mjs`). A signed hub-form record (scope `btih:<hex>`, 2 trackers, 1 web seed, 1 torrent URL, chain, name) is **457 bytes**, over the 450 SHOULD and under the 900 MUST (ARCHITECTURE 4). With `org=`: 2 doors 525, 4 doors (the `ORG_MAX` cap) 586. With `dr=` as one comma list: 4 hosts 538, 8 hosts 601. Both (4 + 8): 730. The link adds 30 bytes of `https://<door>/#`. QR byte capacities [thonky] put URL lengths 487, 616 and 760 at version 15, 17 and 19 (level L) or 17, 19 and 22 (level M). An unknown `dr=` key is kept and signed by the existing code. A record signed for scope `btih:<hex>` verifies on any door; under a hostname scope it fails (`bad-sig`), so a per-domain page-tag record cannot move to another door; removing one door from the text also fails (`bad-sig`), so a link-rewriting intermediary cannot strip signed doors.

**What the browser shows.** Door 1 dead, nothing cached: its own error page. Door 1 up but serving altered site files or an old loader: the loader refuses them (piece hashes, `ml=`). Cached copy, door dead: the shell and site from the worker, then the loader's banner.

### F2. Every site is a door

- A worker's scope is its script directory unless the host sends `Service-Worker-Allowed`, and the script needs a JavaScript media type [mdn-sw]. Storage is per origin, not per path [mdn-quota], so path scoping isolates nothing. ARCHITECTURE 3.3: the shared-origin hub is demo only and claims no isolation; V03 2.2.3: it gets no persistent key.
- **Measured (Chromium 156, WebKit 27.2):** a frame with `sandbox="allow-scripts"` has origin `null`; Service Worker, IndexedDB, localStorage and Cache Storage are denied; blob Workers, blob modules, WebAssembly, WebSocket, CORS fetch, SubtleCrypto and a WebRTC data channel work (same shape as `w1-11-opaque-frame-lab`). This is the existing limited mode (ARCHITECTURE 7.4) in a safer frame, with the Bridge for ledger and SDK; relative `fetch` by site code does not work in it.
- **Cache cost:** each door a visitor uses holds its own loader copy, 2.1 MiB raw (F5). Safari deletes script-written data per origin after seven days of Safari use without interaction [wk-itp]; Chromium and Safari allow an origin about 60% of disk [mdn-quota].
- **Full per-site isolation needs a wildcard host** (hub labels, DEPLOY "Hubs"); GitHub Pages and Cloudflare Pages cannot give it.

### F3. Doors in the ledger

- V03 2.10.2: `_` keys are owner and moderator only; `maxValueBytes` is 2,048; an item that fails its schema is hidden and its block stays valid (MF-21). So `_doors` needs no change to the freeze group.
- `org=` is the identity mirror list, at most 4 origins (V03 2.2.3): an origin listed there receives the ledger's shared identity label, so a third-party host there could take the visitor's key for that site. Guest doors go in `dr=` and `_doors` only.
- Holders learn it from the `cs=` snapshot and the rendezvous swarm (ARCHITECTURE 5.5). Precedents: NIP-65 [nip65]; atproto's DID record names the user's PDS (R1 3.3).
- Open: hub-form links pin one version (scope = that `btih`), so no update channel crosses doors yet (D5).

### F4. The installed web app as a lasting door

| | iOS, iPadOS (Home Screen) | Android Chrome (WebAPK) | Desktop Chrome, Edge | Firefox desktop |
|---|---|---|---|---|
| Install | Share, Add to Home Screen; from iOS 16.4 also via Chrome, Edge, Firefox; no `beforeinstallprompt` [mdn-inst] | Chrome on devices with Google Mobile Services mints a WebAPK, else a browser-badged shortcut [mdn-inst][owa] | all desktop systems [mdn-inst] | not supported [mdn-inst] |
| Storage | its own, not Safari's, "by design" [wk-bug]; first launch must be online (*inference*) | the Chrome profile's; clearing site data clears the app [webapks] | the browser's | n/a |
| Origin blocked | cached shell served (a Chromium tab *measured*, e2e 5; installed apps unmeasured; no offline promise on iOS, DESIGN-REVIEW 4.3) | same | same | n/a |
| Update | a failed update leaves the current worker (non-OK answer [webdev-sw]; network failure *inference*) | same | same | n/a |
| Eviction | seven-day rule does not apply (own day counter) [wk-itp][webdev-st]; LRU under pressure unless persistent; `persist()` heuristics include Home Screen [wk-st] | LRU unless persistent; `persist()` auto-granted to installed, bookmarked, engaged sites [webdev-ps] | same | asks the person [mdn-quota] |
| Launch by link | no source found; unverified | in-scope https links open the app [webapks] | `web+` via manifest after a permission dialog, Chrome 96 [chrome-ph] | `registerProtocolHandler` only |

The manifest has one SVG icon; Chromium 156 reports no installability errors (*measured*); Android minting and iOS icons are unmeasured.

### F5. Door kits

- **Measured** (`kit-size-repro.mjs`, working tree 0.3.0, 2026-10-20): `node build.mjs --out` gives 18 files, 2,194,331 bytes (2.09 MiB); gzip-9 per file sums to 720,514, brotli-11 to 606,477; two back-to-back builds were byte-identical. The committed `dist/` is the older 0.2.1 build (16 files, 1,106,440 bytes, brotli 312,091); the tree is still moving.
- **Parts that exist:** `tools/verify-release.mjs list|sign|verify` (signed per-file list, pinned key, offline); `release.yml` packs `magnet-web-<version>-dist.zip` and `hashes-dist.json` for the owner to sign offline; `rebuild.yml` compares Linux, macOS and Windows builds (written, not yet run on a public repository).
- **Host must provide** (DEPLOY "What the host must do"): HTTPS at the root of a host name; `/mw-sw.js` 200, JavaScript type, `Cache-Control: no-cache`, no redirect; `/_mw/*` with real types and no byte-changing transforms (SRI and the worker refuse changed bytes); real 404s. A full door adds `Range` answered 206. Reading a door's files from another origin (health check, SRI) needs CORS [mdn-sri].
- **Cheapest hosts** (S2 F14, F15; DEPLOY; fetched 2026-10-20):

| Host | Door address | Free limits | Loader door | Full door (web seed) |
|---|---|---|---|---|
| GitHub Pages | `<user>.github.io` | 1 GB, 100 GB a month soft, no commercial use | yes | yes; no custom headers; `max-age=600` |
| Cloudflare Pages | `<project>.pages.dev` | 25 MiB a file | yes | no (`Range` gives 200) |
| Netlify | `*.netlify.app` | free plan in credits | yes | yes; CORS via `_headers` |
| Rented server | nip.io name or own domain | $4.00 a month, 500 GiB (DigitalOcean) | yes | yes (S2 Caddy template) |
| A person's computer | `http://localhost:8000` | free | one person | yes; needs a helper (not browser-only) |

Spread doors over providers, registrars and countries; free tiers end (Glitch 2025-07-08, S3; IPFS gateways 2026-08-25 [ipfs]).

### F6. `web+lightweb:`

| | Chrome | Edge | Firefox desktop | Safari, all iOS | Chrome Android | Firefox Android |
|---|---|---|---|---|---|---|
| `registerProtocolHandler` | 13 | 79 | yes | no | no | no [caniuse-rph][bcd-nav] |
| manifest `protocol_handlers` | 96 | 96 | no | no | no | no [bcd-ph] |
| manifest `share_target` | 89 | 89 | no | no | yes | no [caniuse-sh] |

Rules [mdn-rph]: `web+` plus lowercase letters; handler URL https, same origin, with `%s`; the browser may ask on registering or on use. *Measured* (`w1-09-lab`, 2026-10-17): Chromium 156 accepts `web+magnetweb`, rejects `web+magnet2` and a cross-origin handler; WebKit 27.2 has no method. Limits: one handler origin per profile, so that door is a single point unless its worker is cached; an installed app's handler shows a permission dialog with the app name and origin on first launch, and a refusal makes the handler ignored [chrome-ph]. The project keeps `protocol_handlers` out of ordinary manifests (a shop PWA would claim links and show only itself: code review 11, `build.mjs`): door deployments only.

### F7. The loader through the swarm

- A visitor with no code cannot speak WebTorrent, so the swarm cannot serve a first load. It can serve (a) the kit published as a site that anyone can export and re-host, and (b) later, page code to a visitor who already has a loader.
- The worker script cannot come from peers: updates fetch `/mw-sw.js` from the origin [webdev-sw], and the spec forbids importing new scripts after install (Chrome allowed it historically) [wk-188495]. Page modules can come from Cache Storage if their bytes match a signed list.
- Cost: one more key to trust, a rollback rule and a revocation list. Verdict: kit as a site now; swarm update of page code P2.

### F8. Signed HTTP Exchanges and Web Bundles in 2026

- SXG: Chrome 73+, Edge 79+; none in Firefox or Safari [caniuse-sxg]. Mozilla: position negative, re-added 2024-09-13 ("origin substitution") [moz-sxg]. No WebKit position found.
- The certificate needs the `CanSignHttpExchanges` extension and at most 90 days of validity; signatures last at most 7 days (expired draft 09) [ietf-sxg]; DigiCert was the only CA in 2018 [chrome-sxg]. "Only Google and Cloudflare embraced SXG"; Cloudflare plans to deprecate it [pokrywka].
- A page loaded from an SXG has the signer's origin, but its worker script is fetched from that origin; the loading spec does not say a worker can register from an SXG [wicg-load]. *Inference:* not with the origin blocked.
- Web Bundles: Isolated Web Apps use `isolated-app://`, a `.swbn` bundle and an id from the signing key (our idea) but are "only available to Chrome Enterprise administered ChromeOS devices and select development partners" (page of 2026-02-06) [iwa].
- **Verdict: no.** Revisit if Firefox and Safari ship and a free CA issues the certificates.

### F9. data: and file: pages as emergency viewers

*Measured*, Chromium 156 and WebKit 27.2 alike except where noted (`run-capability.mjs`); baseline is `http://127.0.0.1`.

| | localhost | file:// | data: (top level) | sandboxed frame |
|---|---|---|---|---|
| origin; `isSecureContext` | http origin; true | `file://`; true | `null`; false | `null`; true (inherited) |
| `crypto.subtle` | yes | yes | **no** | yes |
| Service Worker | registers | `register()` rejects | API absent | API throws |
| IndexedDB, localStorage, Cache Storage | yes | yes, except Cache Storage rejects file requests | SecurityError; Cache Storage absent | SecurityError |
| blob Worker, `import()` blob, WebAssembly | yes | yes | yes | yes |
| WebRTC data channel (loopback) | yes | yes | yes | yes |
| WebSocket and CORS fetch to 127.0.0.1 | yes | yes (`Origin: null`) | WebKit yes; Chromium blocked | yes (`Origin: null`) |

Chromium's data: block is its local-network check: with those features off the fetch and WebSocket succeed (`lna-check.mjs`); public hosts are not covered by it (*inference*). Script-started navigation to a data: URL stayed on the page in both engines (MDN: blocked in all modern browsers; "unique opaque origins" [mdn-data]); a typed address was not tested. Firefox was not run (MDN: file: origins are generally opaque [mdn-sop]). **Read:** a viewer can fetch, hash (pure JS on data:), join peers and render in limited mode; it keeps no copy, identity or worker. The built pages name `/_mw/` by absolute path, so a file: copy needs relative paths (*inference*).

### F10. Integrity of a door never used

- SRI covers `script` and `link` elements and needs CORS across origins; MDN does not mention documents [mdn-sri]. `index.html` pins `boot.js` and `loader.js` with SHA-384 and the worker refuses a precache that does not match its integrity map (ARCHITECTURE 7.1). Both sit inside the first page, which a hostile door controls: **first load is trust on first use** (the link's sender, then the host).
- After a good first load the worker serves its cached build, and `ml=` makes an older loader refuse (`loaderFloorOk`, SC-6). Out of band, `verify-release.mjs verify` checks a copy of a door against the signed list. Missing: a signature check on the update itself (D7).
- Browser-enforced: WAICT (Cloudflare 2025-10-16; Mozilla 2026-05-05) binds a site's code to a logged manifest; first visits rely on a browser-shipped preload list; an early prototype exists in Firefox Nightly only [waict-cf][waict-moz].
- Kill switch: `mw-sw-kill.js` as `/mw-sw.js` (DEPLOY) needs a host the operator controls (*inference:* an immutable host has none).

## Design

All limits below are *chosen* unless a source is named.

**D1. Door classes.** *Owner door:* the page-tag host and `org=` origins; full mode; shared identity label. *Guest door:* any host serving the loader; foreign sites show in the sandboxed view with no persistent key (V03 2.2.3). *Hub door:* wildcard labels, full mode per site. *Emergency viewer:* file:, data:, localhost.

**D2. Light link v2** (additive; old loaders ignore unknown parts): `https://<door>/#<signed record>[#mwgen=<blocks>][#mwd=<host>,<host>]`, and the same record behind `web+lightweb:`. The record has scope `btih:<hex>` so any door verifies it, and may carry `org=` (existing, at most 4) and `dr=` (new: one key, comma list of lowercase hosts, at most 8, https port 443 implied, no path). `#mwd=` is unsigned sharer advice: at most 4, tried last, only for hash-checked bytes; it cannot change which site opens. `publish` also writes `link-card.txt`: the primary link, two plain fallback links, a QR. A `#host:<name>` link names one DNS name, so it is one more door, not a way around.

**D3. Page-side fallback.** Order: current, last good, signed (`org=`, `dr=`), ledger `_doors`, hints; at most 12. The loader code must come from its own origin (the worker script must be same-origin [mdn-sw]), so cross-door fallback is for *bytes*: web-seed and torrent files by hash, trackers, health probes. Probe `/_mw/door.json` (new, in every build) with `no-cors` (reachable or not), then read it with CORS when sent and compare its hashes (a block page also answers 200). Constants (*chosen*): 4 s to first byte, 12 s per door, 250 ms stagger [rfc8305], 3 in flight, 10 minutes of back-off. The page never changes origin by itself when it holds state here; the visitor chooses.

**D4. Every site is a door.** Reserved file `/_mw/open.html` (a copy of the shell, so it works on a plain host and from the precache); `resolveMode` gets mode `door`. Flow: the existing gate (C3: nothing loads before a click), then the limited view in a `sandbox="allow-scripts"` frame, ledger through the Bridge, "this visit only" identity. Files are stored flagged `viaDoor` and evicted first. The host's worker serves the page from its precache and never maps a foreign site to its own `meta.current`; hub mode stays a configuration (`mw-hub` meta), the door route needs none. Card: "This address can show the site but cannot store anything for it." with buttons to open it at its own addresses.

**D5. `_doors`.** `put('_doors', { v: 1, d: [host, ...] })`: at most 24 hosts, owner-authored only (a moderator entry is hidden), one accepted update an hour, 2,048-byte cap. Use: a banner when the current door stops answering, in a cached copy too ("This address is not answering. The owner lists: ..."). *For the owner:* an optional `ptr` field with the latest signed record would be the update channel across doors; it changes the resolution order of ARCHITECTURE 4.

**D6. Installed app.** Door deployments only: `protocol_handlers` `web+lightweb` to `/_mw/open.html#%s`, `share_target` (GET) to the same page, `launch_handler` `navigate-existing`; an "Open a link" paste box for iOS and Firefox; copy "Open the app once from your Home Screen while you are online"; Settings show the loader build and the last update check.

**D7. Kit and update trust.** `door.json` (per-file sha256 and SRI, build id; the build writes it to `/_mw/`) sits beside the release's signed `hashes-dist.json`. The page can export its cached files as a zip after checking each hash (directory picker only on Chromium 105+ [caniuse-fsa]; elsewhere a download). P2: the worker verifies a signed release manifest before it accepts a new build; a signed revocation list; immutable hosts marked "no kill switch".

**D8. Order.**

| P0 (doors lane) | P1 | P2 | Not doing |
|---|---|---|---|
| link v2, `dr=`, link card, byte fallback, Doors panel and banner, `_doors`, guest-door view, kit CLI, `check-site --door`, door manifest, docs, e2e | zip export from the page, share target, kit as a site | `light-viewer.html` (one file: limited renderer, fetch, web seed, WebRTC, pure-JS hashes; FAQ only), swarm update of page code, signed update continuity | Signed Exchanges, Web Bundles, an extension, promoting data: URLs |

## Lane brief

Goal: the site lives at its key; domains are doors. Browser only (an installed web app counts as the browser). The wording rules of DESIGN-REVIEW 4 bind. Read F0 to F2 and D1 to D6 first.

**Files and changes**
1. `src/common/pointer.js`: add `dr=` (single key, comma list, at most 8 lowercase hosts, optional port, no scheme or path). Unknown keys are already kept and signed, so old verifiers stay valid. Add `parseDoors(record, hints)` returning owner, guest and hint hosts, deduplicated, capped at 12. Append golden vectors. Leave `org=` alone. Add `formatLightLink` and `parseLightLink` here or in `src/common/magnet.js`.
2. `src/loader/app.js`: generalise `parseFragment` to any number of `#name=value` segments after the record (`mwgen` today; add `mwd`, at most 4 hosts, others ignored); strip the percent-encoded `web+lightweb:` prefix. `resolveMode`: `/_mw/open.html` gives mode `door`.
3. New `src/loader/doors.js`: candidate list and order, health memory in prefs, the probe, staggered fetch of web-seed and torrent bytes across doors (D3 constants).
4. Door view: gate, then limited mode in `sandbox="allow-scripts"`, Bridge for ledger and SDK, "this visit only" identity, `viaDoor` files evicted first. Doors panel in Settings (current, owner, guest, last good; copy link with doors) and the not-answering banner. Do not switch origin by itself when the visitor has state here.
5. Ledger `_doors`: read through the existing key API, owner-authored only, 24 hosts, one update an hour, 2,048 bytes; invalid items hidden, blocks stay valid (MF-21). No change to block validity.
6. `tools/publish.mjs` (it refuses `btih:` scopes today; `personal-site.js` already signs them in the browser): a link mode with `--door <host>` (repeatable) signs a hub-scope record with `dr=` and writes `link.txt`, `link-card.txt`, `doors.json` (size warnings as today). `--door-kit <dir>`: copy `dist` unchanged, add the release `hashes-dist.json` and signature, `.nojekyll`, `_headers`, `vercel.json`, a Caddyfile, `README-DOOR.txt`; refuse if any loader byte differs from the signed list.
7. `tools/check-site.mjs --door`: HTTPS root, `/mw-sw.js` 200 with a JavaScript type and no redirect, every `/_mw/*` byte equal to `door.json`, CORS on `/_mw/door.json`.
8. `build.mjs`: write `_mw/open.html` and `_mw/door.json`; only door manifests get `protocol_handlers`, `share_target`, `launch_handler`.
9. Docs: README one line, "the site lives at its key; domains are doors"; DEPLOY "Doors" (host contract, free hosts, kit, check); FAQ "My domain is blocked: what now?" in plain words (a link cannot reroute itself; what helps); SECURITY-MODEL "trust on first door"; PRIVACY (doors see IP and time, not the site); DEMO-RESULTS rows: iOS first launch offline, WebAPK offline launch, desktop `web+` prompt, file: and data: on phones.

**Tests.** Unit: link round trip, caps, bad hosts, order, `_doors` owner-only and 2,048 cap, `bad-sig` when a door is removed. E2E on 127.0.0.1 ports: DOOR-DOWN (load from door A, stop A, reload renders from the worker, the banner lists door B, a click opens B and the site loads from B's web seed with the same ledger id); DOOR-HASH (B serves one flipped byte, refused, C serves); DOOR-GUEST (a link opened at a plain loader host shows the sandboxed view with no worker and no storage, Bridge working, Chromium and WebKit).

**Do not:** list a third-party host in `org=`; promise that a link reroutes itself; auto-load anything from `web+lightweb:`, share target or paste (C3: explicit click); add a protocol handler to ordinary site manifests; fetch the loader from another origin.

**Open for the owner:** `ptr` in `_doors` as an update channel; doors for the identity origin (a passkey is bound to its RP ID; a phrase or file restore works at another instance); the kit signing key holder.

## Cannot

- A link cannot reroute itself: with door 1 down and nothing cached the visitor sees the browser's error page.
- A door cannot be proven good on first use. A hostile or altered door can serve a hostile loader; checks help only after a good first load or when someone verifies the door out of band.
- Doors do not beat a whitelist or a shutdown: one door must be reachable and not intercepted by a certificate the device trusts.
- `web+lightweb:` does nothing on iOS, Chrome Android or Firefox Android. For iOS no way was found to open an installed web app from a link (unverified; test on a device).
- A foreign site at a guest door runs reduced: no storage, no worker, no relative `fetch`.
- A signed doors list cannot reach someone who never loaded the site, or recall a link already shared.
- The kill switch needs a host the operator controls; an immutable host has none.
- data: and file: pages keep nothing, are desktop-only as far as tested, and data: has no `crypto.subtle`.
- A phone cannot be made to keep a site: Safari deletes script data after seven days unless the app is on the Home Screen, and Android clears it with the browser's site data.
- Human-readable names still need DNS, and a network observer still sees which door hosts a visitor contacts.
- Not measured or verified: Firefox 157 on file: and data:; any phone (iOS first launch, WebAPK minting with an SVG icon, file: and data: on mobile); whether a worker can register from an SXG (spec silent); whether messengers make `web+` text clickable.

## Sources

Fetched 2026-10-20 unless dated. Repo: R1, S2, S3, ARCHITECTURE, V03-DESIGN-REVIEW, DEPLOY, `.github/workflows`, `docs/research/labs/` (`w1-09-lab`, `w1-11-opaque-frame-lab`, `s4-doors-lab`).

- [hrw] hrw.org/news/2026/03/31/russia-internet-shutdowns-escalate ; [usenix] usenix.org/conference/usenixsecurity25/presentation/zohaib
- [rfc9460], [rfc8305], [rfc3986] rfc-editor.org/rfc/rfc9460.html, .../rfc8305.html, .../rfc3986.html
- [matrix] spec.matrix.org/latest/appendices/ ; [nip19] raw.githubusercontent.com/nostr-protocol/nips/master/19.md ; [nip65] .../65.md ; [ipfs] blog.ipfs.tech/2026-08-beyond-sponsored-gateways/ (2026-08-25) ; [thonky] thonky.com/qr-code-tutorial/character-capacities
- MDN (developer.mozilla.org/en-US/docs/): [mdn-sw] Web/API/ServiceWorkerContainer/register ; [mdn-sri] Web/Security/Defenses/Subresource_Integrity ; [mdn-quota] Web/API/Storage_API/Storage_quotas_and_eviction_criteria (modified 2026-01-05) ; [mdn-inst] Web/Progressive_web_apps/Guides/Making_PWAs_installable ; [mdn-rph] Web/API/Navigator/registerProtocolHandler ; [mdn-data] Web/URI/Reference/Schemes/data ; [mdn-sop] Web/Security/Defenses/Same-origin_policy
- WebKit: [wk-itp] webkit.org/blog/10218/ (2020-03-24) ; [wk-st] webkit.org/blog/14403/ (2023-08-10) ; [wk-bug] bugs.webkit.org/show_bug.cgi?id=181849 ; [wk-188495] bugs.webkit.org/show_bug.cgi?id=188495
- [webdev-sw] web.dev/articles/service-worker-lifecycle (2016-09-29) ; [webdev-ps] web.dev/articles/persistent-storage (2020-05-12) ; [webdev-st] web.dev/articles/storage-for-the-web (2024-09-23) ; [webapks] web.dev/articles/webapks (2017-05-21) ; [owa] open-web-advocacy.org/blog/google-must-share-the-ability-to-install-web-apps-in-android/ (2024-09-19)
- caniuse.com: [caniuse-rph] registerprotocolhandler ; [caniuse-sh] mdn-manifests_webapp_share_target ; [caniuse-sxg] sxg ; [caniuse-fsa] native-filesystem-api ; [bcd-nav] raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json ; [bcd-ph] .../manifests/webapp/protocol_handlers.json
- Chrome: [chrome-ph] developer.chrome.com/docs/web-platform/best-practices/url-protocol-handler (2021-05-11) ; [chrome-sxg] developer.chrome.com/blog/signed-exchanges (2018-11-01) ; [iwa] developer.chrome.com/docs/iwa/introduction (2026-02-06)
- [ietf-sxg] datatracker.ietf.org/doc/html/draft-yasskin-http-origin-signed-responses (draft 09) ; [moz-sxg] github.com/mozilla/standards-positions/issues/29 ; [wicg-load] wicg.github.io/webpackage/loading.html ; [pokrywka] pawelpokrywka.com/p/my-conclusions-after-using-signed (2025-10-09) ; [waict-cf] blog.cloudflare.com/improving-the-trustworthiness-of-javascript-on-the-web/ (2025-10-16) ; [waict-moz] hacks.mozilla.org/2026/05/trustworthy-javascript-for-the-open-web/ (2026-05-05)
