# Deviations and notes: wire-ui (v0.3 C2)

Lane: loader, SDK and UI wiring: the seed budget and dock mode in app.js, `mw.calls` and the seeding side of `mw.net`, the
call panel, labels and the carry meter ([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](../research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md),
"SZ", 3.1.3 to 3.1.5, 3.3 and 3.5; [review/V03-DESIGN-REVIEW.md](../review/V03-DESIGN-REVIEW.md) 2.11 and 2.14; ARCHITECTURE 8
and 8.1). The computed task text carried `BRIEF: undefined`; the brief was read from `.orchestration/args/c2/wire-ui.md`
and the integration notes from `.orchestration/args/c2/integration-notes.md`. Built contract-first against lanes
seed-policy (landed: `docs/deviations/seed-policy.md`), docs-strings (landed: `SEED_TEXT`, `CALL_TEXT`, `C2_ERROR_CODES`),
seed-engine (in progress: `torrent.js` `setSeedBudget`, `setSeedMeters`, `seeding`, the `'wire'` and `'evidence'` events,
the files and media list fields) and calls (in progress: `src/calls/service.js` and the chat `sig` seam, read at
17:00 to 17:50 ET).

## Files written

- `src/loader/api.js`: the method tables (below), `featuresOf().calls`, `plainOnly()`, drop-in refusal of calls,
  `MwApi.setNet()` and `dropin()`, `seedingSnapshot()`, `createNetControl()`, `ipSentence()`, the calls mount in
  `mountV03Services()`, `CALL_CARD_KINDS`, `UI_CARD_KINDS += 'dock'`, fallback call cards in `cardFor()`, `callName()`,
  `callNames()`.
- `src/loader/bridge.js`: `portSafe()` reduces every `calls.*` result to plain JSON (a second guard after MwApi).
- `src/sdk/sdk.js`: `mw.calls` (nine methods and `on`), `mw.net.seeding()`, `dock()`, `keep()`, the `calls` push, the six
  codes in `ERROR_CODES`, the argument table.
- `src/sdk/sdk-static.js`: the same paths as stubs (`calls.state` null, `calls.list` [], the rest `E_NO_HOST`;
  `net.seeding` reads nothing shared; `features.calls: false`).
- `src/dropin/binding.js`: `mw.calls` and `calls.on` (every method goes through MwApi, which answers `E_UNSUPPORTED` in
  drop-in mode), `mw.net.seeding`, `dock`, `keep`, the `calls` push.
- `src/loader/call-ui.js` (new): the call panel and every call card (below).
- `src/loader/ui.js`: `capText`, `ageText`, `clockText`, `lastSentence`, `labelText`, `carryMeter`, `meterText`,
  `trackerText`, `createSeedUi` (upload card, keeper line, carry meter, dim page of dock mode), the Settings controls
  (declarations, keeper toggle, dock button, counter line), the `dock` card kind; `createUI` returns `setMeter`,
  `setUploads`, `setKeeper`, `setDock`.
- `src/loader/ui.css`: the `.mw-uploads`, `.mw-keeper`, `.mw-meter`, `.mw-dock` and `.mw-call-*` rules and the call host's place.
- `src/loader/app.js`: the insertion points below (each marked `// C2 wire-ui`) and one block of functions at the end.
- `docs/SDK.md`: the sections "Calls: mw.calls", "Seeding: mw.net.seeding, dock and keep", "Availability labels on files
  and media items", and the rows of the tables (modes, methods at a glance, conditional UI, host-only, push events, error
  codes, tabs, versions).
- Tests (new): `test/unit/sdk-c2-calls.test.mjs` (12), `sdk-c2-seeding.test.mjs` (15), `call-ui.test.mjs` (16),
  `ui-c2-cards.test.mjs` (8). Updated: `test/unit/ui-v03-cards.test.mjs` (a sample for the `dock` card kind).
  `test/unit/sdk-v03-wiring.test.mjs` needed no change and stays green.

## Tests run

- My six files: 83 of 83 pass (`node --test test/unit/sdk-c2-calls.test.mjs test/unit/sdk-c2-seeding.test.mjs
  test/unit/call-ui.test.mjs test/unit/ui-c2-cards.test.mjs test/unit/sdk-v03-wiring.test.mjs test/unit/ui-v03-cards.test.mjs`).
  `call-ui.test.mjs` also drives a real call with lane calls' service and fixtures (`test/fixtures/calls/peers.mjs`, real
  chat sealing over fake wires, its fake WebRTC): the ring shows on the callee's panel, its Accept connects, the panel
  shows "Direct", Mute reaches the service, Hang up ends the call on both sides, and the callee makes no connection before
  the click.
- `node tools/lint-floor.mjs` on the nine source files: clean. `test/unit/lint-contrib.test.mjs` (SZ 3.1.9 over src/): 4 of 4
  pass with `call-ui.js` in the tree (no capture, no Wake Lock, no audioSession; `typeof` feature detection only).
- An in-memory esbuild bundle (dist/ untouched) of `src/loader/app.js`, `src/sdk/sdk.js`, `src/sdk/sdk-static.js` and
  `src/dropin/mw.js` at the floor targets, and a transform of `ui.css`: no warnings; the loader bundle includes
  `src/calls/service.js` and `src/loader/call-ui.js`.
- Read-only runs of 29 other test files that import my files or lane seed-policy's (not changed by me): 412 of 423 pass;
  the 11 failures, in 5 files, are the exact-surface assertions the brief's contract changes, listed under "Requests to
  the C2 integrator" with the edit each needs. With those edits applied to copies in a scratch mirror, the 5 files pass
  52 of 52. No browser was launched; no e2e suite was run; dist/ was not rebuilt; nothing was pushed.

## Exports (for the integrator to fold into INTERFACES, part "v0.3 C2")

```
src/loader/api.js
  C2_CALL_METHODS = ['calls.start', 'calls.accept', 'calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera', 'calls.screen', 'calls.state', 'calls.list']
  C2_NET_METHODS = ['net.seeding', 'net.dock', 'net.keep'];  CALL_EVENTS = ['ring', 'state', 'peer', 'ended']
  READ_METHODS  += 'calls.state', 'calls.list', 'net.seeding'
  WRITE_METHODS += 'calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera'
  UI_METHODS    += 'calls.start', 'calls.accept', 'calls.screen', 'net.dock', 'net.keep';  CONDITIONAL_UI['net.keep'] = 'on'
  HOST_ONLY_METHODS += 'calls.start', 'calls.accept', 'calls.decline', 'calls.camera', 'calls.screen', 'net.dock', 'net.keep'
  PUSH_EVENTS += 'calls';  NAMESPACE_SERVICE.calls = 'calls';  SERVICE_EVENTS.calls = { push: 'calls', events: CALL_EVENTS }
  ERROR_CODES   += C2_ERROR_CODES (appended after the 29 of R 2.11.2);  METHOD_ARGS for the twelve methods
  UI_CARD_KINDS += 'dock';  CALL_CARD_KINDS = ['call.start', 'call.incoming', 'call.group', 'call.metered', 'call.screen']
  featuresOf(cfg).calls = (cfg.calls === 'contacts')
  plainOnly(value) -> plain JSON only (functions, streams, tracks and class instances left out; Infinity and NaN -> null)
  MwApi#setNet(control); MwApi#dropin() -> info().mode === 'dropin'
  MwApi#request: calls.* on a drop-in page -> E_UNSUPPORTED before validation, host-only and gesture checks;
    calls.* results and 'calls' events -> plainOnly
  seedingSnapshot({ budget, seeding, meters, dock, keeper }) -> { lanes: { H, K, E: { rate, used } }, month: { used, cap }, dock: { on, until }, keeper }
  createNetControl({ budget, seeding, meters, dock, keeper, setKeeper, canKeep, isMobile, follower, declareNeeded, prompt,
    lang, now, dockDefaultMs, dockCapMs }) -> { seeding(), dock(params, ctx), keep(params, ctx) }
  ipSentence(lang) -> the last sentence of SEED_TEXT 'seed.ask';  callName(name, pub);  callNames(names, pubs)
  mountV03Services: modules.calls mounted right after chat, with deps.{ mode, policy, stun, turn, callPrefs,
    RTCPeerConnection, mediaDevices, wakeLock, mediaSession, callPrompt, onSeedYield }; never on a drop-in page
src/loader/bridge.js   portSafe('calls.*', result) -> plainOnly(result)
src/loader/call-ui.js  createCallUi({ win, doc, nav, lang, cssHref, now, setTimeout, clearTimeout, setInterval, clearInterval,
                         MediaStream, AudioContext, strict, minVisibleMs, MutationObserverCtor, log })
                         -> { attach(service), detach(), prompt(kind, data), inspect(), rectOf(label), destroy() }
                       CALL_UI_KINDS, PANEL_PEER_STATES, callName, durationText, endText, noticesOf, peerStateText, maySound, canShareScreen
src/loader/ui.js       capText, ageText, clockText, lastSentence, labelText, carryMeter, meterText, trackerText, createSeedUi;
                       CARD_KINDS += 'dock'; createUI() -> + setMeter, setUploads, setKeeper, setDock; Settings model `seed`
src/loader/app.js      networkProofOf, seedEnvOf, seedPrefsOf, staticTurnOf, callPolicyOf (pure), __c2WireUi (tests only)
window.__mwShell       rectOf(label) also finds the buttons of the call panel; inspect() gains `seeding` and `calls`
```

## Insertion points in shared loader files (each marked `// C2 wire-ui`)

`src/loader/app.js` (shared with lane doors, which comes after this lane):
1. imports: `createSeedMeters`, `createDock`, `createCallUi`, `seedText`, the ui.js helpers, `createNetControl`;
2. `run()`, after `A` is made: `A.prefs` gains `declaredWifi`, `declaredPlugged` (this page only), `seedAsked`, `keeper`;
   `A.callYield`; `A.callUi`;
3. `run()`, the `__mwShell.rectOf` fallback to the call panel;
4. `run()`, after `detectEnvironment`: `await setupSeeding(A)` (battery manager, dock controller, `api.setNet`);
5. `inspectShell()`: `seeding` and `calls`;
6. `loadPrefs()`: `seedAsked:<origin>` and `keeper:<origin>`;
7. `recomputePolicy()`: `computePolicy(seedEnvOf(...), Object.assign({...}, seedPrefsOf(...)))` and `applySeedBudget(A)`;
8. `ensureTorrentManager()`: `attachSeeding(A, tm)` (meters on the per-origin store, budget, carry meter, evidence);
9. `renderSite()`: `refreshCarry(A)` after the site shows;
10. `installLifecycle()`: no battery timer while the keeper tab is on; `callsVisible`, `callsNetwork`; `flushSeedMeters` on pagehide;
11. `buildSettingsModel()`: `seed: seedModel(A)`;
12. `changeSetting()`: `shareOnNetwork` off also answers seed.ask; new actions `dock`, `declareWifi`, `declarePlugged`, `keeper`;
13. `loadV03Modules()`: `out.calls = await import('../calls/service.js')`;
14. `mountLeaderServices()`: `...callDeps(A)` in the deps, `afterServices(A)` after the mount;
15. the block of functions before `export { lifecyclePlan }`.

`src/loader/ui.js`: the helper block after `shortText`; `seedUi` after the notice box; the Settings controls after
`networkT`, the Sharing section's children, the model in `setModel`; the returned setters; `CARD_KINDS`; the `pressed`
attribute in `show()`; the `dock` case of `specFor`.

## Mocks at contract boundaries (to reconcile when the lanes land)

- Lane calls: a recorder of the nine methods and four events (`sdk-c2-calls`); a fake service with `answer()`, `media()`
  and the events (`call-ui`); plus one test on the real service through lane calls' fixtures. The panel reads, of the
  call state: `id, role, state, connectedAt, operator, notice, platform, paused, local.{ mute, camera, screen, videoPaused },
  participants[].{ pub, name, state, path }`; of the ring: `id, from, name, kind, group, roster, expiresAt`; of 'ended':
  `reason, code, duration`; and `answer(id, { video })`, `media(id) -> { local: { audio, camera, screen }, remote: [{ pub,
  audio, camera, screen }] }`, `setVisible(bool)`, `setNetwork()`.
- Lane seed-engine: `tm.setSeedBudget(budget)`, `tm.setSeedMeters(meters)`, the getter `tm.seeding` ({ lanes: { L: { used } },
  month: { used } }), `tm.diagnostics().swarm` ({ reported, others, at? }), the `'wire'` event `{ wire, kind }` and the
  `'evidence'` event; list items with `evidence`, `label`, `labelParams`, `handoff` (read from `src/files/lane.js` and
  `src/media/lane.js` as they stood at 17:30 ET). All are called only when present (`typeof ... === 'function'`).
- Lane seed-policy: the real `seedBudget`, `computePolicy`, `createSeedMeters`, `createDock` (with a fake Wake Lock).

## Readings and deviations

1. **HOST_ONLY_METHODS is a subset of the calls methods**, not "every calls.* method" (INTERFACES C2): start, accept,
   decline, camera and screen answer `E_HOST_ONLY`; hangup, mute and the two reads do not, exactly as
   `src/calls/service.js` guards them (`network: false`), so a call can always end. `net.dock` and `net.keep` are host-only
   too (nothing is shared host-only).
2. **`net.keep` is UI only to turn keeping on** (`CONDITIONAL_UI['net.keep'] = 'on'`, like `chat.presence.set` and
   `public`); `keep(false)` lowers what the tab shares and needs no click. `keep()` without a boolean is `E_LIMIT`, so
   leaving `on` out cannot skip the click.
3. **Drop-in mode refuses calls in MwApi**, from the page's site info (`mode: 'dropin'`), before validation, host-only and
   the gesture check, so every `mw.calls` method of the binding answers `E_UNSUPPORTED` and the binding keeps one table
   with the shell. `calls.on()` returns `unsubscribe()` and never fires there. `mountV03Services` never mounts calls on a
   drop-in page, whatever the engine passes.
4. **The six call codes are appended after the 29 of R 2.11.2** (sdk.js has the same list).
5. **`features.calls` is true only for `_mw.cfg.calls === 'contacts'`**, the one value the calls service accepts.
6. **`mw.net.seeding()`**: `used` is the lane's bytes on wires that count toward the caps (a local wire's bytes do not);
   `month.cap` is `null` for no cap, so Infinity never depends on the transport (seed-policy's question); `rate` 0 means
   off; a follower tab answers `E_POLICY`; a page without the control `E_UNSUPPORTED` (drop-in today).
7. **Dock mode is for phones, the keeper tab for computers.** `net.dock` on a computer and `net.keep` on a phone answer
   `E_UNSUPPORTED`. `hours` runs from 0 (stop, no card) to 8, at least 1 minute; the `dock` card's button says "Keep this
   screen on and share for 2 hours" only for exactly two hours, otherwise "Continue", and its text is `dock.on` with the
   end time, so the card never names a duration it will not keep. A refused start keeps the card open with
   `dock.refused.<reason>`; `net.dock` resolves `{ on, until, reason, declared }`.
8. **The keeper tab** keeps sharing while hidden (no battery timer in `installLifecycle`), shows `keeper.on` with the site's
   name and the month counter, and needs Share on (`E_POLICY`). It changes no budget: a desktop tab already has row 1.
9. **The call panel owns every call card.** The service's prompt kinds go to `call-ui.prompt()`; a site's
   `mw.calls.accept(id)` binds to the incoming card the ring opened (the person's click answers it, and the panel does not
   answer a second time). `cardFor()` maps the five kinds to plain confirm cards with the CALL_TEXT sentences for a loader
   without a panel. The panel is a closed shadow root that loads `/_mw/ui.css`, above the dim page of dock mode (so a ring
   on a docked phone is seen); a ring never takes the keyboard focus; a card the site asked for focuses its safe button;
   the panel takes the focus on Mute when the person started or accepted the call. Accept buttons and the confirm buttons
   pass the redress checks; the panel never rewrites `hidden`, `class` or `style` while a card is open (the guard's
   MutationObserver would cancel it). M and V toggle mute and the camera while the focus is in the panel.
10. **The ring tone** is a 440 and 480 Hz burst every 3 s from an AudioContext, only where `getAutoplayPolicy` allows it or
    the page has sticky activation; the title flashes `call.ringTitle` (keeping a title the site sets meanwhile);
    `navigator.vibrate` runs where it exists. All stop on answer, decline, end or the 45 s expiry.
11. **The seed.ask card's moment of value is an own upload** (the `shared` push of files `{ ref }` or media
    `{ kind: 'own' }`), only when `budget.ask === 'consent'` (row 2 with SZ-1 on, not yet answered). Yes turns on Share on
    this network; either answer stores `seedAsked:<origin>`. Turning Share on this network off in Settings also stores it
    (seed-policy's request). "Keeps something" has no event to watch, so it is not a trigger yet.
12. **The carry meter counts the site torrent itself**, from the TorrentManager's `'wire'` event: bytes of web seed wires
    (the host) and of peer wires (visitors), and `n` = distinct peer ids that sent at least one byte (a reconnect is the same
    visitor). It is frozen after load ("This visit"); a copy from the cache downloaded nothing and shows no visit line. The
    tracker figure is `swarm.others + 1` (the trackers' own count, which includes this browser), with the time this page
    first saw that figure unless seed-engine adds `swarm.at`.
13. **The upload card** reads the services' own lists (`files.list()` by `ref`, `media.list({ from: 'mine' })` by `id`)
    for each own upload of this page, at most 4, on every `evidence` event and every 2 s while one is in hand-off; an item
    that is kept or delivered stays a minute. `avail.noPin` is added when `_mw.cfg.pin` is unset. Private files are not in
    any list of the files lane, so they get no line yet.
14. **Calls get** the site's own STUN list from `/.mw/site.json` (`publish --stun`, MF-44; at most 4); TURN only with static
    credentials (R 2.7.8 option a, from `_mw.cfg.turn` or the site config); option (b), a credential endpoint, is not
    fetched (owner decision SZ-5); "same local network" and "Hide my IP from people I call" are off (no switch or string
    yet); the browser's own `RTCPeerConnection`, not the offer-timeout wrapper WebTorrent gets; the call yield
    (`onSeedYield`) recomputes the budget at once (SZ 3.1.3 row 7).
15. **Texts outside SEED_TEXT and CALL_TEXT**: generic buttons from UI_TEXT (Continue, Cancel, OK), error sentences from
    ERROR_TEXT, units of `capText` (B, KiB, MiB, GiB, kB, MB, GB; French o, Kio, Mio, Gio, ko, Mo, Go) and the words of
    `ageText` (English and French) in ui.js; the keeper card's text is `keeper.on` followed by the last sentence of
    `seed.ask` (`ipSentence`). A count of 1 uses `avail.heldByOne` or `meter.visitOne` when they exist, else the plural
    sentence (true, not grammatical).

## Requests to the C2 integrator

The brief's contract changes the exact-surface assertions of five existing test files that this lane does not own (the
"unassigned existing tests" of the integration notes). Each needs one edit; a patch that `git apply --check` accepts at the
repository root is at
`/private/tmp/claude-501/-Users-owner/a69aa364-28fd-4795-9307-1b393b2fc924/scratchpad/c2-integrator-tests.diff`
(13 hunks; verified on copies: 52 of 52 pass):

- `test/unit/sdk-v03-tables.test.mjs` (6 tests): add a C2 list beside `AMENDMENT`, `{ read: ['calls.state', 'calls.list',
  'net.seeding'], write: ['calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera'], ui: ['calls.start', 'calls.accept',
  'calls.screen', 'net.dock', 'net.keep'] }`, and union it into the three class assertions (or parse the INTERFACES C2
  block "src/loader/api.js, bridge.js, src/sdk/sdk.js, sdk-static.js, src/dropin/binding.js (lane wire-ui)", whose `+=`
  lists the same regex reads); add those twelve methods to the expected `minus(API_METHODS, R_METHODS)`; add `'calls'` to
  the expected PUSH_EVENTS and `'calls.on'` to `LOCAL_PATHS`; check the 29 codes at
  `ERROR_CODES.slice(ERROR_CODES.length - 35, ERROR_CODES.length - 6)` and `C2_ERROR_CODES` at the end; widen the
  host-only regex to `/^(chat|files|media|report|calls|net)\./`.
- `test/unit/sdk-v03-gating.test.mjs` (2 tests): `paramsFor('net.keep')` must return `{ on: true }` (as `chat.presence.set`
  returns `public: true`); `calls: false` in the three `features` objects.
- `test/unit/dropin-binding.test.mjs`: `net: ['peers', 'on', 'seeding', 'dock', 'keep']`, and a `calls` group
  `['start', 'accept', 'decline', 'hangup', 'mute', 'camera', 'screen', 'state', 'list', 'on']`.
- `test/unit/dropin-v03.test.mjs`: `features` keys gain `'calls'`.
- `test/unit/integration-v03-reconcile.test.mjs`: `calls: false` in the expected `ready.features`.
- INTERFACES and ARCHITECTURE 8.1: fold in the exports above and readings 1 to 3 and 6 to 9.
- E2E (E-CL-1 to E-CL-3, E-PS-4 and the seeding rows): `window.__mwShell.rectOf(label)` now finds the call panel's buttons
  ("Accept with audio", "Accept with video", "Decline", "Continue", "Share screen", "Mute", "Hang up") for a real mouse
  click; `__mwShell.inspect().calls` and `.seeding` show the panel's and the budget's state; the panel needs
  `/.mw/site.json` `stun` (publish `--stun`) and `_mw.cfg.calls = 'contacts'` on the test site.
- The drop-in engine (`src/dropin/engine.js`) could give its MwApi a seeding control (`api.setNet(createNetControl(...))`)
  when the owner wants `mw.net.seeding()` there; until then drop-in answers `E_UNSUPPORTED` for the three methods.

## Requests to other lanes

- **seed-engine:** `diagnostics().swarm.at` (the time of the trackers' last report) would let `meter.tracker` print the
  report time instead of the time this page first saw the figure. Confirm the `seeding` getter keeps `lanes[L].used` and
  `month.used` (both read here); the carry meter needs nothing from torrent.js.
- **calls:** `calls.screen(id, false)` (stop sharing) asks for a click in the service; the API keeps `calls.screen` a UI
  method to match. If stopping should need no click, make the service guard it like `calls.mute` and the API can mark it
  `CONDITIONAL_UI['calls.screen'] = 'on'`. The ring event names only the caller: the names of the roster (from the
  contacts) would let the group card name everyone instead of short ids.
- **docs-strings:** keys for: a singular of `avail.heldBy` and `meter.visit` (`avail.heldByOne`, `meter.visitOne`; used at
  once when present); a keeper card sentence (`keeper.card`, today `keeper.on` plus the last sentence of `seed.ask`); the
  month counter (`seed.month`, "Shared this month: {used} of {cap}."); dock mode for other lengths (`dock.startFor` with
  `{hours}`); a call button ("Call") and "Join"; the two call switches ("Hide my IP address from people I call", "We are on
  the same local network"); and the age words of `ageText` (less than a minute, minutes, hours) in both languages.

## Open items

1. Owner decisions SZ-1, SZ-2, SZ-4 and SZ-5 are not signed; the shipped flags keep today's behaviour (no seed.ask card, no
   hand-off while hidden, audio-only default on metered and unknown networks in the calls service, no relay).
2. Nothing here is measured on a phone: the dock card, the dim page, the call panel on iPhone and Android, the ring tone's
   autoplay answer and vibration (gate rows G-PS-1 to G-PS-14, G-CL-2, G-CL-3, G-CL-9).
3. The keeper tab shows the site's name and the month counter; a list of the items it keeps waits for a string and a list
   of kept items from seed-engine.
4. Private own files get no upload line until the files lane lists them for their uploader.
