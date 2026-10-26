# Code review: browser and mobile compatibility lens (v0.2.1 code)

Date: 2026-10-19. Lens: browser and mobile compatibility. Scope: the code under `src/`, `tools/`, `build.mjs` and
`test/e2e/` as it stands after the v0.2.1 hardening (checkpoint `29733c0`). Read first: `docs/INTEGRATION-STATUS.md`,
`docs/DEVIATIONS.md` with `docs/deviations/{network,serving-publishing,harden-verify}.md`, `docs/review/DESIGN-REVIEW.md`
and `docs/review/DIGEST-AMENDMENTS.md` (Status column). Nothing in the repository was changed; this file is the only
write. The previous run's browser review was lost mid-write, so this one starts from the code.

How the findings were checked. Every finding comes from reading the code path end to end. Findings 1, 2, 3, 5, 6, 7
and 11 were also reproduced in a private clone of the repository (scratchpad copy, `node_modules` linked, its own
`dist/`) with throw-away probe scripts that reuse `test/e2e/lib.mjs` (`setupStack`, `Visitor`): Playwright
Chromium 156 launched with `chromiumArgs()`, Playwright WebKit 27.2 against `http://127.0.0.1` only, the harness's
ICE-server stripping, and its request guard (no request left loopback in any probe). `npm test` in that copy: 836
pass, 0 fail. Firefox is not launchable on this machine, so Firefox statements come from the code and from
compatibility data, not from a run.

Severity: critical = exploitable or data loss; high = a documented behaviour is wrong in a mainstream browser or a
must-fix item is unimplemented; medium = edge-case bug; low = hygiene.

## Summary

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | critical | Importing the vendored webtorrent bundle deletes the origin's OPFS directory `/chunks` (recursively) in shell and drop-in mode | `build.mjs:75` (no patch), import sites `src/loader/app.js:1499`, `src/dropin/mw.js:56` |
| 2 | high | Limited mode renders under the normal CSP whenever the decision to degrade comes after boot.js fixed it (storage full, late `register()` failure, `ready()` timeout): no styles, no scripts | `src/loader/app.js:1658`, `:1678`; `src/loader/boot.js:565-576`; `src/loader/render.js:337` |
| 3 | medium | Shell mode replaces the site's own viewport (`width`, `initial-scale`, `viewport-fit`, `interactive-widget`): non-responsive sites lay out at phone width, notched iPhones lose letterboxing | `src/loader/index.html:5`, `src/loader/render.js:584-684`, `src/loader/ui.css:63-72` |
| 4 | medium | Gzip ledger snapshots (`cs=`, the default output of `tools/snapshot.mjs`) cannot be read on Safari/iOS 15.4 to 16.3, a declared floor browser | `src/loader/app.js:1961`, `src/dropin/ledger.js:221`, `tools/snapshot.mjs:97` |
| 5 | medium | The degraded CSP blocks every third-party subresource (CDN CSS, scripts, fonts, images, embeds) that SW mode loads | `src/loader/boot.js:441-457`, `src/loader/render.js:117-141` |
| 6 | medium | Limited mode breaks module graphs with a cycle (the default Rollup/Vite code-splitting shape): lazy chunks fail to load | `src/loader/render.js:777` |
| 7 | medium | Limited mode runs the site at `about:srcdoc`: `location.pathname` is `srcdoc` and `history.pushState` throws, so History-API routers cannot work | `src/loader/render.js:883` |
| 8 | medium | The network class is never re-evaluated: a phone that moves from Wi-Fi to mobile data keeps the Wi-Fi policy, and drop-in keeps completing its copy from the host | `src/loader/policy.js:59`, `src/loader/app.js:1129-1133`, `src/dropin/engine.js:1143` |
| 9 | low | `boot.js` is built with an arrow-function IIFE wrapper, so pre-ES2015 browsers never show "This browser cannot open this site" | `build.mjs:40`, `:45` |
| 10 | low | `lint-floor` misses many post-floor APIs (the `DecompressionStream` use of finding 4 went through) and never scans the vendored bundle | `tools/lint-floor.mjs:39-62` |
| 11 | low | Light mode: a site without its own page background shows the shell's `#f6f7f9` through the frame instead of white | `src/loader/ui.css:70` |
| 12 | low | iOS Home Screen hint: never shown on iPad, and it promises that adding to the Home Screen keeps this copy and identity, which iOS does not do | `src/loader/app.js:2212`, `src/loader/strings.js:86` |
| 13 | low | iOS zooms the page when a loader input gets focus (font size under 16 px) and does not zoom back | `src/loader/ui.css:213-223`, `src/dropin/panel.js:349` |
| 14 | low | The drop-in integration recipe (`importScripts`) breaks a site whose own Service Worker is a module worker | `src/dropin/swreg.js:71-76` |
| 15 | low | The SW install downloads both modes' assets with `cache: 'reload'` (743 KB raw, 248 KB gzip per install), including assets the mode never uses | `src/sw/core.js:1684-1752`, `build.mjs:124-132` |

Relation to the other reviews of this round: finding 2 extends conformance finding 6 (which covers only the
`ready()` timeout) with two more triggers, a reproduction and a raised severity; fix them together. No other finding
overlaps the security, conformance or correctness files.

## 1. critical: importing the vendored bundle deletes the origin's OPFS `/chunks`

**Where.** The minified `node_modules/webtorrent/dist/webtorrent.min.js` (3.0.21), copied to
`dist/_mw/webtorrent.min.js` after the three B3 patches, contains this module-level statement exactly once:

    globalThis.navigator?.storage?.getDirectory&&navigator.storage.getDirectory().then(e=>{e.removeEntry("chunks",{recursive:!0}).catch(()=>{})});

`build.mjs:75` (`WEBTORRENT_PATCHES`) does not patch it. The bundle is imported by the shell
(`src/loader/app.js:1499`, `ensureTorrentManager`) and by drop-in pages (`src/dropin/mw.js:56`, `createDeps().webtorrent`),
in both cases on the site's own origin.

**Defect.** This is fsa-chunk-store's start-up cleanup. It runs when the module is evaluated, whatever store the
client later uses. DESIGN-REVIEW item 18 removed the store from use ("never use WebTorrent's default store") but the
side effect stays: every page view that loads the engine recursively deletes the top-level OPFS directory named
`chunks` of the origin, which in shell (per-domain) mode is the site's origin and in drop-in mode is the existing
site's origin. A site that keeps its own data there (chunked uploads, media caches, an app's files) loses it on
every visit, with no prompt and no log line. The same statement also has no rejection handler for
`getDirectory()` itself (it rejects where OPFS is unavailable, for example in Firefox private windows; the shell then
logs `unhandled: ...`), and, where `FileSystemFileHandle.prototype.createWritable` is missing, it patches host
globals (defines `createWritable` backed by a `blob:` module Worker, wraps `FileSystemDirectoryHandle.prototype.getFileHandle`,
defines `globalThis.FileSystemWritableFileStream`), which changes a drop-in host page's own feature detection.

**Failure scenario (reproduced).**
- Node 24: importing `dist/_mw/webtorrent.min.js` with a fake `navigator.storage` records `getDirectory()` and then
  `removeEntry('chunks', { recursive: true })` during the import.
- Chromium 156: a page of the e2e origin writes OPFS `chunks/notes.txt` ("user data"); the visitor then opens the
  shell, clicks "Share and load", the site renders (the bundle was fetched): `getDirectoryHandle('chunks')` now throws
  `NotFoundError`.
- WebKit 27.2, persistent profile, consent pending (the web seed renders the site, so the bundle loads): OPFS
  `chunks/my-app-data` existed before the shell loaded and is gone after.

**Fix.** Add a fourth hash-asserted entry to `WEBTORRENT_PATCHES` that replaces that statement with `void 0;` (and,
in the same way, make the `createWritable` polyfill block's guard false so host globals are never patched), then
`node build.mjs --update-lock`. Keep it until our own bundle replaces the string patches (ROADMAP).

**Test.** `tools-build`: the patched bundle contains no `removeEntry("chunks"`; a Node test imports the patched
bundle with a fake `navigator.storage` and records zero `getDirectory()` calls. E2E (Chromium, and WebKit with a
persistent profile): write OPFS `chunks/keep.txt` on the origin, load the shell and the drop-in fixture with consent,
assert the file is still there.

## 2. high: limited mode renders under the normal CSP

**Where.** `src/loader/app.js:1658` (`A.degraded = !sw.ok || !!A.persistFailed`) then `:1678`/`:1694`
(`mountDegraded`); `src/loader/boot.js:565-576` (the CSP is fixed once `register()` settles or after the 3 s
`SW_PROBE_MS`, and a later failure leaves `boot.degraded` false: `boot.degraded = !probeDone`);
`src/loader/render.js:337` (`ready()` not within 15 s returns `degraded`).

**Defect.** The degraded renderer needs the degraded policy (`blob:` and `'unsafe-inline'` in `script-src`, `blob:`
in `style-src`, `base-uri 'self'`). A meta CSP cannot be relaxed, so boot.js chooses it once. ARCHITECTURE 7.4 says
degraded mode happens "only when `serviceWorker` is absent or `register()` rejects", but three later paths reach
`mountDegraded` with the normal policy in place:
- (a) `ready()` does not resolve within 15 s (conformance finding 6): for example a first visit during a mixed deploy,
  where D2's atomic install rejects and no previous worker exists, or a slow first visit (the install precaches 743 KB
  raw with `cache: 'reload'` while the page downloads the site, finding 15).
- (b) `persistSite()` fails although the worker is active: `QuotaExceededError` on a full phone or a small
  incognito quota, `E_IDB_BLOCKED`, a Safari `UnknownError` that survives the retry. `persistFailed` makes the page
  degrade.
- (c) `register()` settles after the 3 s probe (slow network: `/mw-sw.js` is 67 KB) and then rejects (the script
  fetch fails, or the script throws while evaluating). The normal CSP is already in place.

In each case the site renders in a `srcdoc` frame whose blob stylesheets, blob scripts and `<base>` are blocked.

**Failure scenario (reproduced, Chromium 156).** An init script makes `IDBObjectStore.prototype.put` throw
`QuotaExceededError` for the `files` store (the worker is untouched and registers normally). The site "renders" in
0.3 s: `__mwShell.inspect()` gives `degraded: true`, the frame is `about:srcdoc`, the site's `--radius` custom
property is empty (no stylesheet), and the console shows `base-uri 'none'` blocking the injected `<base>`,
`style-src` blocking the `blob:` stylesheet and `script-src` blocking the `blob:` script.

**Fix.** Never call `mountDegraded` unless `boot.csp` is the degraded policy. When the decision to degrade comes
after boot.js fixed the normal one, set a one-time `sessionStorage` flag (for example `mw:degraded`) and reload once;
boot.js reads the flag before anything else, skips `register()` and inserts the degraded policy. For (b) a better
path keeps SW mode: the active worker can ask the shell client for files it cannot find in IndexedDB (a
`MessageChannel` request answered from `A.blobs`), so a full disk does not cost a re-download. Treat a probe that is
still pending at 3 s as "unknown" and route a later rejection into the same reload.

**Test.** E2E scenario 14 variants: (b) the quota init script above: the frame's `--radius` is `14px`, the site
script ran and `mw.ready()` resolves, after at most one reload; (a) a gate route serving a `/mw-sw.js` whose install
never settles: styled limited mode within about 16 s; (c) the gate delays `/mw-sw.js` 4 s and then answers 500.
Add the DESIGN-REVIEW item 17 acceptance test that is still missing (first visit under slow-3G renders in SW mode).

## 3. medium: shell mode replaces the site's own viewport

**Where.** `src/loader/index.html:5` (`width=device-width, initial-scale=1, viewport-fit=cover,
interactive-widget=resizes-content`); `src/loader/render.js:584-684` (`mountSite` mirrors the title and the URL but
never the frame document's `<meta name="viewport">`); `src/loader/ui.css:63-72` (the frame is `position: fixed;
inset: 0`).

**Defect.** An iframe has no viewport of its own: on phones the site lays out in the shell's viewport, and its own
viewport meta, or its absence (the browsers' 980 px default for pages without one), is ignored. Item 7 promises that
shell mode runs existing sites unchanged. The same goes for the other viewport keys: the shell forces
`viewport-fit=cover` and stretches the frame to the screen edges, so on notched iPhones in landscape a site that never
opted into `cover` (most sites; Safari letterboxes them into the safe area) has content under the sensor housing and
the home indicator; and it forces `interactive-widget=resizes-content`, so in Chrome on Android the on-screen
keyboard resizes the site's layout viewport, while the site's own default is `resizes-visual`.

**Failure scenario (reproduced, Chromium 156 and WebKit 27.2, 390x844 mobile emulation).** A page without a viewport
meta has `innerWidth` 980 when loaded directly and 390 inside a shell-style frame; a page with
`<meta name="viewport" content="width=1024">` has 1024 directly and 390 in the frame. A fixed-width or desktop-only
site is squeezed into 390 CSS px instead of being zoomed out.

**Fix.** After each frame load, copy the frame document's viewport meta into the shell's (when the site has none,
drop `width=device-width` so the browser default applies), adding `viewport-fit=cover` and `interactive-widget` only
when the site declares them; or let `publish.mjs` record each page's viewport in `/.mw/site.json` so the shell sets it
before mounting. When the site does not declare `cover`, inset the frame by `env(safe-area-inset-*)`.

**Test.** E2E with `isMobile: true`, 390x844 (Chromium; WebKit where supported): fixture pages with no viewport meta,
`width=1024` and `width=device-width`; the frame's `innerWidth` equals the value measured on the plain host (980,
1024, 390).

## 4. medium: gzip snapshots cannot be read on Safari/iOS 15.4 to 16.3

**Where.** `src/loader/app.js:1961` and `src/dropin/ledger.js:221` (`if (typeof DecompressionStream !== 'function')
throw new Error('gzip snapshot needs DecompressionStream')`); `tools/snapshot.mjs:97` (gzip is the default; `--plain` is
opt-in, and the tool's header says Safari before 16.4 cannot read the default output).

**Defect.** `DecompressionStream` arrived in Safari 16.4; the declared floor is Safari/iOS 15.4 (`config.js floor`).
The snapshot is the ledger's durability floor (S2): on iOS 15.4 to 16.3, with the default gzip snapshot, a first
visitor with nobody online gets no entries. The failure is one diagnostics log line; nothing tells the owner or the
visitor. `lint-floor` does not know the API (finding 10), so the use went through the floor gate.

**Fix.** Ship a small inflate fallback (fflate's `gunzipSync` is about 8 KB) used when `DecompressionStream` is
missing, in both readers; or make `--plain` the default (static hosts compress JSON in transit anyway) and keep gzip as
an opt-in with a warning.

**Test.** Unit tests for the shell's `fetchSnapshot` and drop-in `ledger.js` with `win.DecompressionStream` deleted
and a gzip body: every block is offered to the node. A `tools-snapshot` test that the default output is readable by
that path.

## 5. medium: the degraded CSP blocks every third-party subresource

**Where.** `src/loader/boot.js:441-457` (`cspFor('degraded')`) and the copy in `src/loader/render.js:117-141`
(`cspString`): `img-src 'self' blob: data:`, `media-src 'self' blob:`, `font-src 'self' blob: data:`,
`style-src 'self' 'unsafe-inline' blob:`, `script-src 'self' 'unsafe-inline' blob:`, `frame-src 'self'`.

**Defect.** The limited-mode `srcdoc` document inherits the shell's policy. In SW mode the site's document gets only
`frame-ancestors 'self'` (plus its own manifest headers) from the worker, so CDN stylesheets and scripts, web fonts,
images on other hosts and embedded players load; in limited mode all of them are blocked. The extra restriction buys
nothing: the `srcdoc` already runs with `'unsafe-inline'` and the shell's origin. Limited mode is what iOS in-app
browsers without Service Workers, Lockdown Mode and older Firefox private windows get, which is a large share of
mobile visits that arrive from social links.

**Failure scenario (reproduced, Chromium 156).** A site with an `<img>` and a `<link rel="stylesheet">` on another
origin (a second loopback port): SW mode loads both (`naturalWidth` 1, the stylesheet's custom property set); in a
`serviceWorkers: 'block'` context the console shows "Loading the stylesheet ... violates ... style-src 'self'
'unsafe-inline' blob:" and "Loading the image ... violates ... img-src 'self' blob: data:".

**Fix.** Add `https:` (and, in dev, `http://127.0.0.1:* http://localhost:*`) to `img-src`, `media-src`, `font-src`,
`style-src`, `script-src` and `frame-src` of the degraded policy, in both builders, and amend ARCHITECTURE 7.4 and
DESIGN-REVIEW item 17. An alternative is to derive the degraded policy from the site's own CSP in `/.mw/site.json`.

**Test.** E2E 14(c) with a fixture that references a cross-origin image, stylesheet and font: all load in the
`serviceWorkers: 'block'` context.

## 6. medium: limited mode breaks module graphs with a cycle

**Where.** `src/loader/render.js:777` (`moduleUrl`: `if (stack.includes(p)) return fileUrl(p)`).

**Defect.** On an import cycle the renderer hands out the blob URL of the raw, unrewritten file. Its relative
specifiers then resolve against a `blob:` base, which fails, and where it links at all its body runs a second time
as a separate module instance. Rollup and Vite produce this shape by default: a lazily imported route chunk imports shared code back from
the entry chunk, and the entry statically imports a vendor chunk.

**Failure scenario (reproduced, Chromium 156).** `index.js` imports `./util.js` and lazily imports `./route.js`;
`route.js` imports `./index.js`. SW mode: "shared:route ok:helper (entry ran 1x)". Limited mode: the lazy import
rejects with `Failed to resolve module specifier "./util.js". Invalid relative url or base scheme isn't hierarchical.`

**Fix.** Rewrite every relative specifier to a stable bare name (for example `mw:/js/index.js`) and insert one
`<script type="importmap">` that maps the names to blob URLs before the first module script: each module then has one
instance and cycles resolve (import maps: Chrome 89, Firefox 108, Safari 16.4). On Safari 15.4 to 16.3 keep today's
path and state the limit in ARCHITECTURE 7.4.

**Test.** The three-file fixture above in a `serviceWorkers: 'block'` context: the lazy chunk renders and the entry
ran once.

## 7. medium: limited mode runs the site at `about:srcdoc`

**Where.** `src/loader/render.js:883` (`iframe.srcdoc = html`).

**Defect.** A `srcdoc` document's URL is `about:srcdoc`: `location.pathname` is `srcdoc`, and `history.pushState` to
any path throws `SecurityError` (the URL cannot be rewritten across schemes). History-API routers (React Router's
browser router, Vue Router history mode, static exports of SvelteKit and Next.js) render their not-found route at
start and throw on the first navigation. ARCHITECTURE 7.4 documents only that relative `fetch` fails.

**Failure scenario (reproduced, Chromium 156).** In SW mode `history.pushState({}, '', '/about')` works and
`location.pathname` is `/about`; in limited mode `location.pathname` is `srcdoc` and the same call throws
`SecurityError`.

**Fix.** Render into a same-origin `about:blank` frame with `document.open()`, `write()` and `close()`: the written
document takes the shell's URL (the current path), so `location`, `pushState` and relative URLs behave as on the
host; keep `srcdoc` as the fallback. Otherwise document the limit next to the `fetch` one.

**Test.** E2E 14(c): in the limited-mode frame `location.pathname` equals the address-bar path and
`history.pushState({}, '', '/about')` succeeds.

## 8. medium: the network class is never re-evaluated

**Where.** `src/loader/policy.js:59` (`navigator.connection` is read once per `detectEnvironment`);
`src/loader/app.js:1129-1133` (`refreshEnvironment` runs only from the battery listener); `src/dropin/engine.js`
`refreshEnvSync` (same) and `:1143` (the web-seed decision is taken once, when the copy starts).

**Defect.** Nothing listens to `navigator.connection`'s `change` event, and `online`, `pageshow` and visible re-runs do
not re-detect the environment either. On Android Chrome, the browser that exposes the connection type, a visitor who
walks from Wi-Fi to mobile data keeps the `mobileUnmetered` policy for the life of the page: drop-in keeps completing
its copy through the host web seed over mobile data (ARCHITECTURE 3.4.7 allows that only on unmetered networks at
idle), `maxSiteBytes` stays 48 MiB instead of 24 MiB and `leaveVersionSwarm` stays false. The opposite move never
enables the unmetered behaviour.

**Fix.** Where `navigator.connection` exists, subscribe to its `change` event and re-run `detectEnvironment` and
`recomputePolicy` (shell and drop-in), and also re-detect on `online` and on visible. Let `TorrentManager.setPolicy`
drop a web seed when the column becomes `cellular`, or have drop-in abort and restart the copy from peers only.

**Test.** Unit: a fake `connection` EventTarget flips `wifi` to `cellular`: `policy.column` becomes `cellular` and the
drop-in record loses `/_mw/ws/`. E2E 10B variant: flip the `navigator.connection` stub during the drop-in copy and
assert no further `/_mw/ws/` requests.

## 9. low: `boot.js` is not ES5, so old browsers never see the unsupported message

**Where.** `build.mjs:40` (`BOOT_TARGET = 'es2017'`) with `format: 'iife'` (`:45`): `dist/_mw/boot.js` starts with
`(()=>{`, the only ES2015 syntax in the file (the source itself is ES5, `src/loader/boot.js:1`).

**Defect.** boot.js exists to parse in old browsers and tell the visitor they are unsupported. IE11, Android 4.x
WebViews, Opera Mini and other pre-ES2015 engines throw a `SyntaxError` on the arrow and keep showing "Starting..."
forever.

**Fix.** Build boot with `target: 'es5'` (esbuild lowers the wrapper), or with `supported: { arrow: false }`, or
without the extra IIFE (the source already is one).

**Test.** `tools-build`: transforming `dist/_mw/boot.js` at `es5` changes nothing (the `syntaxGate` approach), or
the file contains no `=>`.

## 10. low: `lint-floor` misses post-floor APIs and never scans the vendored bundle

**Where.** `tools/lint-floor.mjs:39-62` (`RULES`); the default scan root is `src/`.

**Defect.** Past the floor (Safari/iOS 15.4, Chromium 110, Firefox 115) and not in the rules:
`DecompressionStream`/`CompressionStream` (Safari 16.4; finding 4), static `Response.json()` (Safari 17),
`URL.canParse` (Chrome 120, Safari 17), constructable stylesheets (`new CSSStyleSheet`, `adoptedStyleSheets`,
`replaceSync`: Safari 16.4), `Response`/`Blob` `.bytes()` (Chrome 132, Firefox 128, Safari 18), `for await` over a
`ReadableStream` (Chrome 124, not in Safari), `navigator.userActivation` (Firefox 120, Safari 16.4), the `popover`
attribute (Firefox 125, Safari 17), `Intl.Segmenter` (Firefox 125), `Element.checkVisibility` (Safari 17.4),
`Array.prototype.with` (Safari 16), `import.meta.resolve` (Safari 16.4). The vendored bundle is copied unchanged and
only its syntax is gated, so a new webtorrent release that uses a post-floor API would ship.

**Fix.** Add the rules (a guarded use carries `lint-floor-ignore`), and have `build.mjs` lint the patched bundle with
an allowlist of the names boot.js and `polyfills.js` provide.

**Test.** `tools-lint-floor` cases per rule; the unguarded `DecompressionStream` lines are reported until finding 4's
fallback exists.

## 11. low: light mode shows the shell background through sites without one

**Where.** `src/loader/ui.css:70` (`.mw-site-frame { background: transparent }`) with `:root { color-scheme: light
dark }` and `--mw-bg: #f6f7f9`.

**Defect.** A frame's canvas is transparent when the frame's color scheme matches the embedding one. In light mode a
site that sets no page background (common on simple static sites) is drawn on the shell's light grey instead of the
white it has on its own host. (In dark mode both engines paint the mismatched frame opaque white, so it is readable.)

**Failure scenario (measured, Chromium 156 and WebKit 27.2).** A pixel in an empty area of such a page inside a
shell-style frame: (246, 247, 249) in light mode, (255, 255, 255) in dark mode.

**Fix.** `.mw-site-frame { background: #fff }` for the light scheme (or `background: Canvas` with the frame element's
`color-scheme` set to what the site declares).

**Test.** Screenshot pixel check in both engines, light mode: (255, 255, 255).

## 12. low: the iOS Home Screen hint is missing on iPad and promises too much

**Where.** `src/loader/app.js:2212` (`iosHint: /iPhone|iPad|iPod/.test(ua) && !navigator.standalone`);
`src/loader/strings.js:86` ("Add to Home Screen keeps this site and your identity").

**Defect.** iPadOS Safari sends a Macintosh user agent, so iPads, which have the same 7-day storage limit, never see
the hint. And a Home Screen web app on iOS has its own storage, separate from Safari's: adding the site does not keep
this tab's copy or identity; the Home Screen app starts empty and creates a new identity.

**Fix.** Detect iPadOS (`/Macintosh/.test(ua) && navigator.maxTouchPoints > 1`). Reword the hint (it is DESIGN-REVIEW
S3's string, so the wording needs the editor) to say the Home Screen app keeps its own copy and identity, and point to
Export identity here and Import there.

**Test.** Unit for the settings model: an iPadOS user agent with `maxTouchPoints` 5 gives `iosHint: true`.

## 13. low: iOS zooms on focus of the loader's inputs

**Where.** `src/loader/ui.css:213-223` (`.mw-input` inherits 14 px; the phone media query does not raise it);
`src/dropin/panel.js:349` (the passphrase and file inputs use `all: revert`, the UA default, under 16 px).

**Defect.** iOS Safari zooms the page when an input with a font size under 16 px gets focus and does not zoom back.
The identity export and import passphrase fields and the moderator key field trigger it; the shell then stays zoomed
with the site frame partly off screen until the visitor pinches out.

**Fix.** 16 px inputs and textareas on coarse pointers (the shell's phone media query; the panel's field style).

**Test.** Manual on an iPhone (release gate); a CSS check that coarse-pointer inputs are at least 16 px.

## 14. low: the integration recipe breaks module Service Workers

**Where.** `src/dropin/swreg.js:71-76` (`foreignRecipe`), ARCHITECTURE 3.4.4.

**Defect.** The recipe tells a site to put `importScripts('/_mw/sw-core.js')` first in its worker. In a module Service
Worker (`register('/sw.js', { type: 'module' })`: Chrome 91, Safari 15) `importScripts()` throws, so following the
recipe makes the site's own worker fail to install. `/_mw/sw-core.js` works when imported as a module
(`import '/_mw/sw-core.js'`), but nothing says so.

**Fix.** Recipe and docs: `importScripts(...)` for classic workers, `import '/_mw/sw-core.js'` as the first statement
of module workers.

**Test.** A fixture variant with a module worker that imports `sw-core.js`: classified `integrated` and serves files.

## 15. low: the SW install downloads both modes' assets with `cache: 'reload'`

**Where.** `src/sw/core.js:1684-1752` (`precacheCritical`, `precacheAll`; `cache: 'reload'` at `:1691` and `:1721`);
one list for both modes from `build.mjs:124-132`.

**Defect.** Every install and every new build fetches the whole list (743 KB raw, 248 KB gzip measured on this
build), bypassing the HTTP cache the page filled seconds earlier. A drop-in install downloads the shell loader it
never uses (`loader.js` 325 KB, `boot.js`, `ui.css`) and the site's own `/index.html`; a shell install downloads
`mw.js` (300 KB) and `sw-core.js`. On mobile data this is ungoverned by the cellular policy, and the size lengthens
the time to `ready()` (finding 2(a)).

**Fix.** Decide the mode first (one fetch of `/index.html`), then precache that mode's list (shell: the shell
document, `boot.js`, `loader.js`, `sdk.js`, `pow-worker.js`, `ui.css`, icon, manifest; drop-in: `mw.js`, `sdk.js`,
`pow-worker.js`), with `cache: 'no-cache'` (a 304 when unchanged) and the existing integrity check.

**Test.** `sw-core`: an install whose `/index.html` is not a shell fetches no `/_mw/loader.js`. E2E 10: on a first
drop-in view the host log has no `/_mw/loader.js` and one download of `/_mw/mw.js`.

## Checked and found sound

- Uint8Array polyfills (`boot.js:191-374`, `src/dropin/polyfills.js`): compared with the TC39 algorithm. Receiver
  checks; `alphabet` and `lastChunkHandling` TypeErrors; `omitPadding`; ASCII-whitespace skipping; padding rules
  (`Zg=` throws, `Zg==` decodes); `stop-before-partial`; `strict` extra-bit rejection; `+` and `/` rejected in
  base64url; `fromHex` odd length and non-hex throw `SyntaxError`. Only unreachable differences: a detached buffer
  gives `''` instead of a TypeError, and `AbortSignal.timeout('100')` throws where WebIDL would convert (callers pass
  numbers). The timeout reason is a `TimeoutError` DOMException.
- Vendored bundle APIs: the only post-floor calls are the hex and base64 methods and `AbortSignal.timeout`
  (polyfilled on windows; neither the SW nor the PoW worker needs them). The bundle polyfills `ReadableStream`
  async iteration itself, guards `requestIdleCallback` and `Error.captureStackTrace`, and has no regex lookbehind.
- Classic bundles: `mw-sw.js`, `_mw/sw-core.js` and `_mw/pow-worker.js` contain no `import()`, `import.meta` or
  `export`; the PoW worker is created without `type: 'module'` and falls back inline (CSP or a dead worker).
- CSP timing: the meta is inserted before the loader import; the importer function is built before it, so no
  `'unsafe-eval'` is needed; a script-inserted meta CSP is applied by all three engines.
- Safari IndexedDB and CryptoKey: the key pair lives in the `keys` store, which has no index (WebKit bug 177350 is about
  indexed records); creation runs put, get, sign and verify, and falls back to a JWK on `DataCloneError` (shell
  `app.js:468-484`, drop-in `identity.js:91-108`). Blob storage is probed with the Blob put first; WebKit ephemeral
  sessions store ArrayBuffers and the worker wraps them.
- SW `Range`: `parseRange` handles the `bytes=0-1` probe, suffix and open-ended ranges, ignores multi-range (200) and
  answers 416; responses are Blob slices with `Content-Range`, `Content-Length` and `Accept-Ranges`; media MIME types
  are exact; the drop-in web-seed rewrite forwards `Range` for files above 32 MiB.
- `FetchEvent.resultingClientId` (Safari 16): shell falls back to `clients.get()` and `frameType`, drop-in to the
  document-URL map and the page's early `mw-map-client`.
- iOS lifecycle (shell; drop-in phones differ, conformance finding 13): hidden time from timestamps, uploads locked
  when a phone hides the page, rebuild on return after 10 s, on `online` and on `pageshow.persisted`; no `unload` or `beforeunload`; `freeze` and `resume` exist only in
  Chromium and are harmless elsewhere.
- Mobile defaults: an unknown network on a phone uses the cellular column until "Share on this network"; Save-Data
  wins; iPadOS counts as mobile through `pointer: coarse`.
- Firefox private windows before Service Worker support take the degraded path with the degraded CSP; Brave needs no
  special path (a missing `getBattery` or `navigator.connection` is handled).
- Dark mode: a site without a background is readable in the shell frame (the mismatched scheme makes the frame canvas
  opaque in both engines, measured).

## Not verified here

- Firefox (not launchable on this machine): every Firefox statement above comes from the code and compatibility
  data.
- Real devices: notch and home-indicator overlap (finding 3), input zoom (finding 13), Home Screen storage separation
  (finding 12) and the network switch (finding 8) need the DESIGN-REVIEW item 25 device gate.
- `WindowClient.navigate()` in Safari 15.x: the kill switch falls back to an `mw-reload` message that only drop-in
  pages handle; the shell recovers on the next navigation anyway.
