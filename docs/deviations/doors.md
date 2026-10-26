# Deviations and notes: doors (v0.3 C2)

Lane: doors, "the site lives at its key; domains are doors" ([research/v03/S4-doors.md](../research/v03/S4-doors.md), F0 to F10 and D1 to
D8). The computed task text carried `BRIEF: undefined`; the brief was read from `.orchestration/args/c2/doors.md` (the lane brief of S4)
and the integration notes from `.orchestration/args/c2/integration-notes.md`. Built after the lanes it depends on landed (wire-ui,
zero-setup, docs-strings), contract-first where it needs changes in their files (requests and patches below). Written 2026-10-20, 19:20 ET;
the incident note at the end was added at 19:35 ET (the tree was damaged at 19:21 ET and repaired by 19:29 ET).

## Files

| File | What changed |
|---|---|
| `src/common/pointer.js` | `dr=` (one key, a comma list of 1 to 8 door hosts, parsed into `record.dr`, signed, printed after `org=`; malformed: `bad-value`; a second key: `duplicate-key`; a record built with `extra.dr` signs the same input); `isDoorHost`, `isLoopbackDoorHost`, `doorOrigin`, `hostOfOrigin`, `doorsOf`, `parseDoors`, `parseHintList`, `parseLinkFragment`, `normalizeRecordText`, `formatLightLink`, `parseLightLink`; constants `DOOR_MAX`, `HINT_MAX`, `DOORS_TOTAL_MAX`, `DOOR_PAGE_PATH`, `FELINAR_SCHEME` |
| `src/loader/doors.js` (new) | candidates and order, `hintAllowed`, health memory, `door.json` (`doorJsonFor`, `checkDoorJson`), `probeDoor`, `fetchFirst` (RFC 8305 style), door torrent URLs and web seeds, the ledger's `_doors` (`ledgerDoorsFrom`, `readLedgerDoors`, `ledgerDoorsValue`), `enforceDoorBudget`, the panel and banner models, `doorLinkFor`, the door view (`mountDoorView`, `doorFrameHtml`, `doorFiles`, `buildDoorDocument`, `frameMain`) |
| `src/loader/app.js` | `parseFragment` generalised; `resolveMode` mode `door`; `sdkMode('door')`; the door steps (block "C2 doors" before `__c2WireUi`), insertion points marked `// C2 doors` (listed below); `__c2Doors`, `pastedFragment`, `sharedFragment` exported for tests |
| `src/loader/strings.js` | `DOOR_TEXT` (English and French, same keys) and `doorText()` (takes a language tag) |
| `src/loader/ui.js` | `createDoorsUi` (the Doors section of Settings), `doorStateText`, `showGate({ note })`, `showLinkPaste()`, `setDoors()` |
| `src/sw/core.js` | `DOOR_PAGE_PATH`, `DOOR_JSON_PATH`; a navigation to `/_mw/open.html` is answered from the precache with the shell's framing headers (`serveDoorPage`); `/_mw/door.json` is never owned (always the network); `mw-set-current` from the door page is refused (`door-page`) |
| `build.mjs` | `_mw/open.html` (the shell with the door manifest link), `_mw/door.webmanifest` (`doorManifestJson`), `_mw/door-frame.js` (an entry from `stdin`: `frameMain(self)`), `_mw/door.json` (`doorJson`, written last, not precached); `precacheList` skips door.json; `doorPageHtml`; constants `DOOR_PAGE`, `DOOR_MANIFEST`, `DOOR_JSON`; the site manifest is unchanged |
| `tools/publish.mjs` | link mode `--door <host>...` (link.txt, link-card.txt, link-qr.svg, doors.json; `summary.link`; `result.link`); `--door-kit <dir>` with `--release-list`, `--release-sig`, `--release-key`, `--door-site`; exports `doorList`, `qrText`, `qrSvg`, `linkCardText`, `doorKitFiles`, `doorKit` |
| `tools/check-site.mjs` | `--door` and `--allow-no-cors` (`checkDoor`, `DOOR_CHECK_ORIGIN`) |
| `test/unit/common-pointer.test.mjs` | 12 tests appended (dr=, hosts, parseDoors, fragments, light links, the vectors, the size) |
| `test/unit/loader-doors.test.mjs` (new) | 29 tests (one runs only with `MW_BROWSER=1`: the door view in Chromium and WebKit) |
| `test/unit/tools-publish-doors.test.mjs` (new) | 10 tests |
| `test/unit/tools-check-door.test.mjs` (new) | 5 tests |
| `test/vectors/pointer.json` | 8 vectors appended, ptr-027 to ptr-034 (key K6) |
| `README.md` | item 6 "Doors" of "How it works" (the line of the brief) and a Door row in Modes |
| `docs/DEPLOY.md` | "Doors" (classes, light links, the host contract, hosts, kits, `check-site --door`, the banner, `_doors`, the installed app, what doors cannot do) |
| `docs/FAQ.md` | "My domain is blocked: what now?"; one sentence added to "Can it be blocked?" |

## Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test test/unit/common-pointer.test.mjs test/unit/loader-doors.test.mjs test/unit/tools-publish-doors.test.mjs test/unit/tools-check-door.test.mjs
    # 89 tests: 88 pass, 0 fail, 1 skipped (the browser test)
    MW_BROWSER=1 node --test --test-name-pattern="door view in Chromium" test/unit/loader-doors.test.mjs   # 1 pass

Fakes at the contract boundary (no network; nothing leaves the process): `fetch` and `Response` (a route table keyed by URL and request
mode), windows and MessagePorts (`fakeWin`), the DOM (`FakeDocument` from the existing `dropin-fake-dom.mjs`), the shell state `A` of
app.js (`ui.setBanner`, `ui.setDoors`, the prefs of `deps.cache`, `deps.verify.verifyInfoHash`, `win.location`, `win.sessionStorage`),
the stored copies given to `enforceDoorBudget`, and a ledger node's `state.kv` for `_doors`. `check-site --door` runs against a small
server on 127.0.0.1 (one case uses a fetch that refuses every call); the publish tests run in temporary directories with a fake `dist/`
and a release list signed in the test with `keygen` and `signList` from the existing tools. cache.js (prefs and stored copies) and
`verifyInfoHash` of verify.js are the only other modules faked; the worker tests give `createCore` fakes for Cache Storage, its site
storage, clients and fetch; elsewhere the real
code runs (pointer signing, `cspString` of render.js, build.mjs, the worker core, the publish and release tools).

A read-only run of the 63 other unit files that import a file this lane changed: 878 of 889 pass, 1 is skipped, and the 10 failures are the known ones of
other lanes and the integrator (docs-links `SEARCH`, `formats-vectors` file list and LOCK, `sdk-v03-tables` and `dropin-*` and
`integration-v03-reconcile` for wire-ui's calls), none from this lane's code; `formats-vectors` will also ask for the 8 LOCK lines below.
`node tools/lint-floor.mjs` is clean on the six source files; `lint-contrib`, `repo-layout`, `tools-lint-floor`, `tools-build`, `sw-core`
and the publish suites pass. No e2e suite was run, `dist/` was not rebuilt (builds went to the scratchpad), nothing was pushed.

**Measured on loopback (local-only Chromium 156.0.8078.4 and WebKit 27.2, every URL `http://127.0.0.1:<port>`; scripts in the session
scratchpad, `doors-probe/` and `flow/`):**

1. A frame with `sandbox="allow-scripts"` cannot load `blob:` URLs its parent made ("Not allowed to load local resource", both engines);
   a classic script from the parent's origin loads under the parent's inherited policy. Hence the renderer inside the frame.
2. The door view renders a site in both engines: origin `null`; a stylesheet with a nested `@import`, an image, a classic script, an ES
   module cycle through one import map, `/_mw/sdk.js` mapped to the door page's copy; `localStorage` and `navigator.serviceWorker` throw
   `SecurityError`; a link click re-renders the next page in the same frame element; an external link is reported, not followed.
3. The real `Bridge` with `origin: 'null'` and the SDK with the patch below: `mw.ready()` resolves and writes reach the API, both engines.
   Without the patch the SDK answers `E_NO_HOST` (it treats an opaque origin as "no host").
4. The whole DOOR-DOWN path with the real built loader, both engines: a light link at door A reloads once into the limited-mode policy
   (`cspKind degraded`, flag `door`), the gate, Load, the site renders in the door view from the web seed with the `.torrent` from door
   A's `/_mw/t/`; door A stops; the reload is served by A's worker and renders the stored copy; the probe fails; the banner reads "This
   address is not answering. The owner lists: 127.0.0.1:<B>."; its button opens B; Load; the site renders from B's web seed and B's
   `.torrent`, with the same ledger id.
5. Chromium 156 resolves `new Function('u', 'return import(u)')('/m.js')` against an earlier origin of the same site in the same tab
   (door B imported door A's module); WebKit does not; an absolute URL fixes both. boot.js builds its importer that way (patch below).

## Insertion points in shared files (each marked `// C2 doors`)

`src/loader/app.js`: the imports; `parseFragment` (rewritten on `parseLinkFragment`); `resolveMode` (the door page); `sdkMode`; `run()`:
`doorCspReload` after the mode, `runDoorPaste` after the deps, `setupDoors` after `loadPrefs`, `loadDoorMemory` after the pointer,
`consentModeOf` for the stored choice, the stored copy waits for the gate on a door; `inspectShell().doors`; `readConsent` and
`saveConsentRecord` (`consentModeOf`); `needsGate` (door: until a stored choice for that site); `openGate` (details and the door note);
`presentPointer` (`showDoorViewBanner`); `presentWithdrawal` (a door purges that ledger only, see 9); `downloadSite`
(`doorDownloadPlan`); `persistSite` (viaDoor and `enforceDoorBudget`); `renderSite` (door: never the worker, never `setCurrent`,
`mountDoorFrame`); `attachBridge` (`guardActivationWatch`, `origin: 'null'`); `identityExtra.sharedHub` (a door: this visit only);
`afterRender` (`afterDoorRender`); `onLedgerChange` (`scheduleLedgerDoors`); the visible handler (`probeThisDoor`); `refreshSettings`
(`refreshDoors`); `changeSetting` (`copyDoorLink`). `src/loader/ui.js`: the import, the two helpers before `trustedOnly`, the gate note,
`showLinkPaste`, the Doors section after Storage, `setDoors` and `showLinkPaste` in the returned object. `src/loader/strings.js`: the
`DOOR_TEXT` block before `seedText`. `build.mjs`: the header, the entry, the constants, `precacheList`, the three helpers, the `stdin`
build, the door manifest, the door page, `door.json`. `tools/publish.mjs`: the header, imports, usage, `OUTPUT_FILES`/`LINK_FILES`, the
door helpers and `doorKit` before `stunList`, the `--door` check, the link record, the link files, the summary, the report, the result,
the flags and `main`.

## Readings and deviations

1. **The light link opens `/_mw/open.html`, not the root.** D2 writes `https://<door>/#<record>`. The root of a plain loader host is the
   shell, which reads only its own page tag or DNS, so that form works only on hubs; the reserved door page exists in every build.
   `parseLightLink` accepts both; the kit's `_redirects`, `vercel.json` and Caddyfile send `/` to `/_mw/open.html` (a fragment survives
   the redirect), so the root form also works on kit doors.
2. **The record travels percent-encoded once** (`encodeURIComponent`), and `parseFragment` decodes an encoded record once and uses it
   as is. A literal record now only gets the separator spaces back (`normalizeRecordText`): the loaders before this lane replaced every
   `%20`, so a record with `dn=My%20Site` (every publish encodes `dn` that way) failed `bad-sig` when it travelled in a fragment, and a
   value with a raw space (a `chain=` label may have one) cannot travel literally at all. Tested both ways.
3. **The door view has its own renderer inside the frame** (`frameMain`, built as `_mw/door-frame.js`, written into the frame inline so
   it works with the door offline: a frame without `allow-same-origin` is not controlled by the door's worker). It receives Blobs over a
   `MessagePort` and makes its own `blob:` URLs (measured 1). A page navigation reloads the same frame element with a fresh document, so
   the Bridge keeps its frame. `mountDegraded` is unchanged. Limits: no History API routing, no relative `fetch`, no forms or popups.
4. **The door page reloads once into the limited-mode policy** through the existing one-time flag of `requestDegradedReload` (reason
   `door`): the frame inherits the page's policy and needs inline and `blob:` scripts. No boot.js change. Any other page of the origin
   that inherits a `door` flag in the same tab clears it and reloads once into the normal mode. Without `sessionStorage` the reload is
   impossible: the frame's scripts are then blocked and a banner says the limited view did not start.
5. **One consent choice per site on a door** (the shared hub's key, `consent:<ledger id>`), and the gate shows until that choice exists
   (as on a hub label), so a returning visitor's stored copy renders without a second click. The first open of a link always gates (C3).
6. **`sdkMode('door')` is `'hub-shared'`**: sites keep the three values they know, and the meaning (one origin, many sites, identity for
   this visit only) is the shared hub's.
7. **Byte fallback runs on the door page only** (not on hub labels or shell pages), to keep the change where it is needed. A door's 404 on
   `/_mw/t/` is not a failure (a loader-only door); a wrong hash, a timeout or a network error puts the door in its 10-minute back-off,
   which also keeps it out of the web seeds and the banner (the banner names all doors when none answered).
8. **"One update an hour" for `_doors` is enforced by each reader** on what it accepted (the state shows only the latest item): a newer
   valid item replaces the accepted one only an hour after that one was accepted on this device. The accepted list is kept in a pref per
   ledger.
9. **A withdrawal opened at a door deletes that ledger's versions only.** `presentWithdrawal` passed `all: true` outside the shared hub,
   which on a door would have deleted every copy the door holds, its own site included, from one signed link. Tested.
10. **viaDoor eviction lives in doors.js** (`enforceDoorBudget`, before the cache's own LRU): door copies beyond 4, or over the budget,
    go first. cache.js is unchanged (it keeps the extra manifest field).
11. **The door manifest is a separate app** (`id` `/_mw/open.html`, `scope` `/_mw/`), linked only from the door page; share target
    parameters are `mw` (url) and `mwtext` (text); the door page turns a shared link into a fragment and shows the gate.
12. **`check-site --door` fails a door without CORS on door.json**, as the brief lists the check; `--allow-no-cors` makes it a warning
    for GitHub Pages, which cannot send headers.
13. **Link mode needs `--chain`** and leaves `org=` as the owner gave it. Fallback links are the second and third `--door`, or the site's
    own address when fewer doors are given. The QR code is level L (S4 measured that level), and `link-qr.svg` is an extra output.
14. **The door kit refuses without a signed release list**, as the brief says: there is no unsigned kit for development. `_redirects`
    is added beside the brief's files (reading 1).
15. **`probeDoor` follows redirects**: Chromium rejects a `no-cors` request with any other redirect mode (measured in the flow probe).
16. **`ActivationTracker.watch` throws on the door view's cross-origin window**, inside `Bridge.attach()`. In door mode app.js wraps the
    page's tracker once (`guardActivationWatch`); activation still comes from `navigator.userActivation`, which a click in the frame
    gives the page too. The same `try` belongs in api.js (request).
17. **Not built (S4 D8 P1 and P2):** zip export from the page, the kit published as a site, `light-viewer.html` (file: and data: viewer),
    swarm updates of page code, signed update continuity. Signed Exchanges and Web Bundles stay rejected (F8).

## Requests to the C2 integrator (patches in the scratchpad `integrator/`; each passes `git apply --check`)

1. **`src/sdk/sdk.js` (wire-ui), needed for "Bridge working" in DOOR-GUEST** (`integrator/sdk-door.diff`; measured 3):

        @@ function framedSameOrigin()
               const mine = docOrigin(win);
        +      if (mine === 'null' && win.__mwDoor === true) return true; // the door view: frameMain sets window.__mwDoor
               return !!mine && mine !== 'null' && docOrigin(win.parent) === mine;
        @@ function attempt()
        -        win.parent.postMessage({ mw: 'hello', proto: 1, sdk: SDK_VERSION }, origin, [ch.port2]);
        +        win.parent.postMessage({ mw: 'hello', proto: 1, sdk: SDK_VERSION }, origin === 'null' ? '*' : origin, [ch.port2]);

2. **`src/loader/boot.js`, an absolute loader URL** (`integrator/boot-import.diff`; measured 5): `importer(new URL(LOADER_URL,
   document.baseURI || loc.href).href)` instead of `importer(LOADER_URL)`. Without it, door B on the same site (every e2e door is
   127.0.0.1) first imports door A's `loader.js`; under the development policy (`http://127.0.0.1:*` in `script-src`) it would run it.
3. **`tools/ledger-admin.mjs`, a `doors` command** (`integrator/ledger-admin-doors.diff`, tried in a scratch mirror): `doors --key
   owner.jwk --file <ledger.json> --door <host>... | --clear-doors | --show`, writing `_doors` through `appendControl` with
   `ledgerDoorsValue` (`src/loader/doors.js`). The owner key never enters a browser, so no other path writes an owner-authored `_doors`.
4. **`test/vectors/LOCK.json`**: append

        {"file":"pointer.json","id":"ptr-027-doors-hub-link","sha256":"a226ada955b718ba7f3daedfe56e96a7f7cd5fe17daeea1edac65d14c2cf24fd"},
        {"file":"pointer.json","id":"ptr-028-doors-hostname-scope","sha256":"9da4a0f52bac6a2b2fb3b60cd7b0e3e94c34f36d4bc704f70e372024c104e697"},
        {"file":"pointer.json","id":"ptr-029-doors-door-removed","sha256":"249412e5db2c52dbc2178f2d4718a97a909b0ac9b8a4f9c646d31201370dd6b8"},
        {"file":"pointer.json","id":"ptr-030-dr-nine-hosts","sha256":"bc5999632dc43e38132030a27a3394866c7de44c4adf6e99019d9182278ca8d7"},
        {"file":"pointer.json","id":"ptr-031-dr-not-a-host","sha256":"c69661e10cdf4ceb6cbace4467b21ce7e3deb727044fac3ad0b9d256c514a642"},
        {"file":"pointer.json","id":"ptr-032-dr-twice","sha256":"10e9b2ef1c196bd625d2697a578857ef49d4ed2c4c03f8fee6a35db19c55852a"},
        {"file":"pointer.json","id":"ptr-033-dr-repeated-host","sha256":"70edfc59ddc7d7774cb3f8c0933e48f04efae4bceda57194d39d4f9aa4c92325"},
        {"file":"pointer.json","id":"ptr-034-dr-uppercase","sha256":"4ac16434043e26df82f163820d6f4bf65f2cba09b82dd1c16d74595d68b898be"}

5. **`src/loader/api.js` (wire-ui)**: a `try` around the property read in `ActivationTracker.watch` (reading 16), after which app.js's
   `guardActivationWatch` can go.
6. **The browser test** at the end of `loader-doors.test.mjs` runs only with `MW_BROWSER=1`; `tools/run-unit.mjs --browser` picks
   `*-browser*` files, so move it into a `loader-doors-browser.test.mjs` if `npm run test:browser` should run it.
7. **E2E scenarios** (`test/e2e`, yours). Hooks: `window.__mwShell.inspect().doors` = `{ current, portable, candidates: [{ host, kind }],
   health, probe: { state, ms, at, reason }, down, banner: [hosts] | null, view, rendered, torrentFrom, lastGood, ledgerDoors }`; the gate
   button is "Load"; the banner is `.mw-banner[data-id="doors"]` with buttons "Open at <host>"; the door view is
   `iframe.mw-door-frame[sandbox="allow-scripts"]`. Set-up as in the scratchpad `flow/flow-probe.mjs`: one build copied to two or three
   static servers on 127.0.0.1 (Range answered with 206), each a full door (`/ws/<name>/`, `/_mw/t/<btih>.torrent`, `/_mw/door.json` with
   `Access-Control-Allow-Origin: *`); the site published with `--scope 127.0.0.1 --chain <name> --door 127.0.0.1:<B>`.
   - DOOR-DOWN: open `http://127.0.0.1:<A>/_mw/open.html#<fragment of link.txt>`; expect one reload, then click Load; wait for
     `doors.rendered`; check the frame's `h1` and `window.origin === 'null'`; close A; reload; expect `fromCache`, `doors.down` and
     `doors.banner` = [B]; click "Open at 127.0.0.1:<B>"; click Load; expect the same `ledgerId` and `doors.torrentFrom` on B.
   - DOOR-HASH: list B then C in `--door`; B's `/_mw/t/<btih>.torrent` has one flipped byte; open the link at a loader-only door; expect
     `torrentFrom` on C and `health[B].until` in the future (a web seed with a flipped byte is refused by torrent.js the same way).
   - DOOR-GUEST: a loader-only host (a door kit without the site) opens the link; expect the sandboxed frame, `localStorage` and the
     worker throwing in it, no `mw-set-current` reaching the worker (`self.mw.inspect().current` stays null), and, with request 1
     applied, `mw.ready()` in the frame resolving with the link's ledger id; Chromium and WebKit.
8. **Spec text** (the docs-strings lane's files, now yours): the four sections below, under their own headings so the status flip stays
   simple.

## Ready to paste

### ARCHITECTURE: "15.15 Doors (v0.3 C2, proposed)"

The site lives at its key; domains are doors (research/v03/S4-doors.md). A door is any host that serves the loader; every build has the
door page `/_mw/open.html`, which `resolveMode` answers with mode `door` whatever the page tag or `mw-hub` says. The light link is
`https://<door>/_mw/open.html#<record percent-encoded once>[#mwgen=<blocks>][#mwd=<host>,...]`; the record is signed for the hub scope
`btih:<hex>` and may carry `org=` (at most 4 owner origins, the identity mirror list: never a third-party host) and `dr=` (one key, a comma
list of 1 to 8 lowercase `host[:port]`, https implied, http only for loopback; a malformed one is `bad-value`). `#mwd=` holds at most 4
unsigned hints, used last, only for hash-checked bytes and only for public host names. `parseFragment` takes any number of
`#name=value` segments after the record (`mwgen`, `mwd`; others ignored), removes a `web+felinar:` prefix (literal or encoded by a
handler's `%s`), decodes an encoded record once, and restores only separator spaces in a literal one. The door page reloads once into
the limited-mode policy (`requestDegradedReload`, reason `door`), shows the gate (one stored choice per site), and renders the site in
a frame with `sandbox="allow-scripts"` whose own renderer (`/_mw/door-frame.js`, written inline) receives the files over a
MessagePort; the Bridge accepts that frame with origin `"null"`; identity is for this visit only (`sharedHub`); stored copies are
flagged `viaDoor` and evicted first; the worker serves the door page from its precache, never answers `/_mw/door.json`, and never
takes a current site from the door page. Candidates, in order: the current door, the last door that served the `.torrent`, `org=`,
`dr=`, the ledger's `_doors`, the hints; at most 12. On the door page the `.torrent` comes from the record's `xs=` or a door's
`/_mw/t/<btih>.torrent`, raced with 250 ms between starts, 3 in flight, 4 s to the first byte and 12 s per door, kept when its infohash
matches; up to 3 doors join the web seeds; a failing door pauses 10 minutes. After each render a page probes its own
`/_mw/door.json` (network, no store); on failure it probes up to 3 other doors and shows "This address is not answering. The owner
lists: ..." with one button each; nothing navigates by itself. `_doors` = `{ v: 1, d: [host, ...] }`, owner-authored only, at most 24
hosts and 2,048 bytes, at most one accepted change an hour per device; invalid items are hidden and their blocks stay valid (MF-21).
Only the door manifest (`/_mw/door.webmanifest`) has `protocol_handlers` (`web+felinar` to `/_mw/open.html#%s`), `share_target` and
`launch_handler`. Tools: `publish --door`, `publish --door-kit`, `check-site --door` (DEPLOY.md, "Doors").

### INTERFACES: "src/common/pointer.js, src/loader/doors.js and the door tools (lane doors)"

    src/common/pointer.js   record.dr: string[] (dr=, 1..DOOR_MAX hosts, one key, KEY_ORDER after org)
                            DOOR_MAX = 8, HINT_MAX = 4, DOORS_TOTAL_MAX = 12, DOOR_PAGE_PATH = '/_mw/open.html', FELINAR_SCHEME = 'web+felinar:'
                            isDoorHost(h), isLoopbackDoorHost(h), doorOrigin(h), hostOfOrigin(origin), doorsOf(record)
                            parseDoors(record, hints) -> { owner, guest, hints, all: [{ host, kind, origin }] }
                            parseHintList(value), normalizeRecordText(text)
                            parseLinkFragment(fragment) -> { head, decoded, handler, segments, hints, genesis }
                            formatLightLink({ door, record, genesis, hints }) -> string; parseLightLink(link) -> { ok, door, origin, path, record, decoded, handler, hints, genesis } | { ok: false, error }
    src/loader/doors.js     DOOR_TIMING = { firstByteMs: 4000, perDoorMs: 12000, staggerMs: 250, inFlight: 3, backoffMs: 600000 }
                            doorCandidates({ current, lastGood, record, ledgerDoors, hints, pageHost, max }) -> [{ host, origin, kind }]
                            hintAllowed(host, { pageHost }), doorTorrentUrls(candidates, btih), doorWebseeds(candidates, { health, now, max, exclude })
                            createDoorHealth({ load, save, now, backoffMs, max }) -> { ready, get, ok, fail, inBackoff, order, snapshot }
                            doorJsonFor({ name, version, buildId, files }), checkDoorJson(json, own) -> { ok, sameBuild, buildId, version, reason }
                            probeDoor(origin, { fetch, own, sameOrigin, timeoutMs, signal }) -> { origin, host, state: up|other-build|opaque|bad|down, buildId, json, ms, reason }
                            fetchFirst(urls, { fetch, verify, staggerMs, inFlight, firstByteMs, perDoorMs, maxBytes, signal, onResult }) -> { ok, url, bytes, results, aborted? }
                            LEDGER_DOORS_KEY = '_doors', LEDGER_DOORS_MAX = 24, LEDGER_DOORS_BYTES = 2048, LEDGER_DOORS_INTERVAL_MS = 3600000
                            ledgerDoorsProblem(value), ledgerDoorsValue(hosts), ledgerDoorsFrom(entry, { owner, previous, now }), readLedgerDoors(node, opts)
                            enforceDoorBudget({ cache, budgetBytes, keep, maxCopies = 4 }) -> { evicted }
                            doorsPanelModel({ candidates, health, now }), doorsBannerModel({ candidates, health, now, max }), doorLinkFor(candidate, { fragment, portable })
                            DOOR_SANDBOX = 'allow-scripts'; doorFiles(parsed, blobs); doorFrameHtml(script)
                            mountDoorView({ container, files, path, routing, frameScript, sdk, base, win, onNavigate, onTitle, onBlockedNavigation, readyMs }) -> { iframe, door, degraded, rendered, navigate, currentPath, destroy }
                            frame protocol: frame -> parent { mwDoor: 'ready', v: 1 } + port; parent -> port { mwDoor: 'render', files: [[path, Blob]], path, routing, sdk, base };
                                            port -> parent { mwDoor: 'rendered', title, path } | { mwDoor: 'navigate', path } | { mwDoor: 'external', url } | { mwDoor: 'error', message }
                            frameMain(window): sets window.__mwDoor = true before it writes the page
    src/loader/strings.js   DOOR_TEXT { en, fr }, doorText(key, lang, params)
    src/loader/ui.js        createDoorsUi({ doc, lang }) -> { node, setModel, onAction, nodes }; doorStateText(state, lang); createUI(): setDoors(model), showLinkPaste({ onOpen, onCancel, lang }), showGate({ ..., note })
    src/sw/core.js          DOOR_PAGE_PATH, DOOR_JSON_PATH; mw-set-current from the door page -> mw-ack { ok: false, error: 'door-page' }
    build.mjs               DOOR_PAGE, DOOR_MANIFEST, DOOR_JSON; doorManifestJson(version), doorPageHtml(shellHtml), doorJson(outputs, { version, buildId })
    tools/publish.mjs       --door <host>... (needs --chain): link.txt, link-card.txt, link-qr.svg, doors.json; summary.link; result.link
                            --door-kit <dir> --release-list --release-sig --release-key [--dist] [--door-site <publish out>]...
                            doorList, qrText, qrSvg, linkCardText, doorKitFiles, doorKit({ out, dist, releaseList, releaseSig, releaseKey, doorSite })
    tools/check-site.mjs    --door [--allow-no-cors]; checkDoor(url, { fetch, timeoutMs, allowNoCors, log }) -> { ok, failures, warnings, results, door }
    window.__mwShell.inspect().doors (read-only), see request 7

### SECURITY-MODEL: "Trust on first door (v0.3 C2, proposed)"

A visitor trusts the first door they open a site at: a hostile or altered door can serve a hostile loader, and nothing a page does can
prove a door good on first use (S4 F10). What helps after that: the worker keeps the build it installed, `ml=` makes older loaders
refuse a site, the door page's frame has an opaque origin (the site there cannot read the door's storage, cookies or worker, and the
door gets nothing from the site but what the site sends through the Bridge), signed `dr=` doors cannot be stripped from a link, hints
from a link are used only for bytes that are checked by hash and only on public names, the `.torrent` from any door must hash to the
record's infohash and every piece is checked, and a withdrawal opened at a door deletes only that site's copies. Out of band: `node
tools/verify-release.mjs verify` against the pinned release key, and `node tools/check-site.mjs <door> --door`. Residual: a door sees
the visitor's IP address and the time; a site in the door view can hand its own API to a page it navigates its frame to (its identity
there is for this visit only); Browser-enforced transparency (WAICT) is a Firefox Nightly prototype.

### PRIVACY: "Doors (v0.3 C2, proposed)"

A door sees the visitor's IP address, the time and the requests to `/_mw/*` (the loader and `door.json`); it does not see which site,
because a link's fragment never leaves the browser (RFC 3986 3.5). A site's bytes from a full door (`/ws/<name>/`, `/_mw/t/<btih>.torrent`)
name the site to that door. When a page's own address stops answering, the page contacts up to three other doors of that site (one
`door.json` request each, no credentials, no referrer). The door page keeps, per door origin: a small health list of door hosts it
contacted, the last door that served each site's `.torrent`, the owner's accepted `_doors` list, the visitor's choice per site, and copies
flagged `viaDoor` (at most four, deleted first). Identity at a door lasts for this visit only. A network observer still sees which door
host a visitor contacts.

### DEMO-RESULTS rows (not yet run)

| Row | What to try | What to record |
|---|---|---|
| G-DR-1 | iOS: add a door page to the Home Screen, open it once online, then open it in airplane mode | whether the cached door page and a stored copy render; storage after 7 days without use |
| G-DR-2 | Android Chrome: install the door app (WebAPK), open it offline; tap an https light link to the door | whether it opens in the app; whether the SVG icon minted a WebAPK |
| G-DR-3 | Desktop Chrome or Edge: install the door app, click a `web+felinar:` link | the permission dialog's text; that the gate shows before anything loads |
| G-DR-4 | A phone: open a door page from `file:` and as a `data:` URL | whether anything runs (S4 F9 measured desktop engines only) |

## Open items for the owner (S4)

- `ptr` in `_doors` as an update channel across doors (a hub-form link pins one version today); it changes the resolution order of
  ARCHITECTURE 4.
- Doors for the identity origin: a passkey is bound to its relying party, so it does not move to another door; a phrase or a file
  restore works at another identity instance.
- Who holds the key that signs the release list a door kit must match (`release.yml` prepares the list; nothing signs it yet).
- Not measured or verified: any phone (iOS first launch, WebAPK minting with an SVG icon, file: and data: on mobile, G-DR-1 to G-DR-4);
  Firefox (it does not launch under Playwright on this Mac); whether a worker can register from a Signed Exchange; whether messengers
  make `web+` text clickable; Vercel and Caddy with the kit's files (written, not run); any real host or real network block.

## Incident at 19:21 ET (repaired)

While preparing a scratch build, this lane wrote into the session scratchpad's `mirror/` folder, which already held symlinks (`src`,
`docs`, `examples`, `packages`, dated 17:58 ET) into this repository, so the writes landed in the real tree: 32 tracked files (31 under
`src/loader/`, and `src/sdk/sdk-static.js`) became symlinks to themselves, `src/loader/boot.js` and `src/sdk/sdk.js` were overwritten
with the patched copies of requests 1 and 2, and 12 directory symlinks (`src/<dir>/<dir>`) appeared. Repair: the 12 links were unlinked
(not deleted recursively), the 34 damaged paths were checked out from checkpoint `d855aa0` (19:16 ET), and this lane's two later edits
were applied again (`probeDoor` returns `json`; app.js keeps `A.ownDoorJson`, so the other doors are compared with this door's list).
Nothing else is known to be lost: the checkpoints from 18:46 to 19:16 ET, and the file times since 19:16 ET outside the two damaged
folders, show only this lane's files changing (inside them the times were reset by the damage, so they cannot tell).

Checked after the repair: no symlink under `src/`, `tools/` or `test/`; `git diff d855aa0 -- src/loader/boot.js src/sdk/sdk.js` is
empty; `git status` lists only this lane's files; the three `integrator/*.diff` patches pass `git apply --check` again; `node
tools/lint-floor.mjs` is clean (146 files); the lane's 89 tests pass (88, and the browser test with `MW_BROWSER=1`). The read-only run of
the 63 other unit files above was made before the incident, on files that are byte-identical to the repaired ones. No auto-checkpoint ran
between 19:16 ET and the repair, so none holds the broken tree (the 19:31 ET checkpoint `ce344f0` has the repaired tree and no symlink
under `src/`, `tools/` or `test/`); squash the checkpoints before publishing as usual. The scratchpad links
this lane made were removed; `mirror/` still holds the 17:58 ET links, so anything written under it lands in this repository.
