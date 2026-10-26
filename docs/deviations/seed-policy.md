# Deviations and notes: seed-policy (v0.3 C2)

Lane: smart seeding policy: budgets, meters, planner, dock mode, local wires, contribution lint
(docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md, "SZ", 3.1.1 to 3.1.4 and 3.1.9; S1-smart-phone-seeding.md D1 to D3
and F4; ARCHITECTURE 8: the four network classes, consent before peers, no incentive layer). The brief was read from
`.orchestration/args/c2/seed-policy.md` (the computed task text carried `BRIEF: undefined`).

Files written: `src/loader/config.js` (`CONFIG.seed` added, nothing else changed), `src/loader/policy.js`
(`computePolicy` gains `seedBudget`), new `src/loader/seed-budget.js`, `src/loader/seed-meters.js`,
`src/loader/seed-planner.js`, `src/loader/dock.js`, `src/loader/localwire.js`; new tests
`test/unit/seed-budget.test.mjs`, `seed-meters.test.mjs`, `seed-planner.test.mjs`, `dock.test.mjs`,
`localwire.test.mjs`, `lint-contrib.test.mjs`; `test/unit/loader-app-policy.test.mjs` gains one test for the new
field and nothing else.

Tests: `node --test` on the seven files: 62 pass, 0 fail. `node tools/lint-floor.mjs` on the seven source files:
clean. An esbuild bundle of the new modules at the floor targets (Safari 15.4, Chrome 110, Firefox 115) builds with
no warnings (in memory; dist/ untouched). Other lanes' tests and the full suites were not run (the integrator's).

All modules are pure or take every browser global by injection, read no global at import time and run in Node 22.
None of them touches a wire: enforcement is seed-engine's (`torrent.js`), UI and strings are wire-ui's and
docs-strings'.

## Exported signatures (the contract seed-engine and wire-ui build against)

```
// src/loader/config.js (additive)
CONFIG.seed = {
  phoneDefaultOn: false,      // SZ-1, not signed
  handoffWhileHidden: false,  // SZ-2, not signed
  superSeed: false, echoTargetCopies: 3, dockDefaultMs: 7200000, dockCapMs: 28800000, dockMinBattery: 0.2,
  rows: {                     // SZ 3.1.3, bytes per second and bytes; session null = none
    desktop:       { H: 1048576, K: 1048576, E: 262144, session: null,      month: 20000000000 },
    phoneCharging: { H: 1048576, K: 262144,  E: 262144, session: 67108864,  month: 1073741824 },
    phoneWifi:     { H: 524288,  K: 131072,  E: 0,      session: 33554432,  month: 268435456 },
    phoneLimited:  { H: 131072,  K: 0,       E: 0,      session: 33554432,  month: 268435456,
                     wifi: { H: 524288, K: 131072, E: 0 } },        // after "I am on Wi-Fi"
    metered:       { H: 131072,  K: 0,       E: 0,      session: 16777216,  month: 0 },
    local:         { H: 1048576, K: 524288,  E: 262144, session: 134217728 },  // outside the month cap
    call:          { phoneH: 131072, phoneK: 0, phoneE: 0, desktopKFactor: 0.5, desktopE: 0 } } }

// src/loader/seed-budget.js
export const SEED_LANES = ['H', 'K', 'E']            // frozen, spending order
export const SEED_ROWS = ['desktop', 'phoneCharging', 'phoneWifi', 'phoneLimited', 'metered', 'hostOnly']
export const MONTH_LANES = ['K', 'E']
export function seedBudget(env, prefs = {}, config = CONFIG) → {
  row: one of SEED_ROWS,                              // SZ 3.1.3 rows 1 to 5 (or host-only)
  call: boolean,                                      // row 7 applies (additive)
  lanes: { H: { rate, session }, K: { rate, session }, E: { rate, session } },
  month: { cap, lanes: ['K', 'E'] },
  local: { H, K, E, session, on },                    // row 6; on: false = count local wires like any other (additive)
  hiddenH: boolean, defaultOn: boolean, ask: 'consent' | 'wifi' | null }
  // env: detectEnvironment() output (isMobile, networkClass, saveData, battery { charging, level } | null, online)
  //      plus networkProof ('connection' | 'declared' | 'none'), dock (boolean), call (null | { limited: boolean })
  // prefs: { share, hostOnly, shareOnNetwork, declaredWifi, declaredPlugged, seedAsked, phoneDefaultOn?,
  //          handoffWhileHidden? }   (seedAsked is additive; the last two override CONFIG.seed)
  // rates: bytes/s (0 = off; a positive rate is never below the 32 KiB/s shaping floor); caps: bytes or Infinity
export function laneRates(budget, { local = false } = {}) → { H, K, E }
export function networkOfEnv(env) → 'wifi' | 'cellular' | 'unknown' | 'saveData'   // same as policy.networkClassOf

// src/loader/policy.js
computePolicy(env, prefs, config) → { ...every v0.3 field unchanged..., seedBudget: seedBudget(env, prefs, config) }

// src/loader/seed-meters.js
export function monthKeyOf(ms) → 'YYYY-MM' (UTC)
export function createSeedMeters({ storage, now, key = 'seedMeters', persistMs = 5000 }) → {
  add(lane, bytes, { local = false }),
  sessionUsed(lane, { local = false }) → bytes this page session (local wires counted apart),
  monthUsed() → K + E bytes of the current UTC month on wires that were not local,
  remaining(budget) → { H: { session, month, local }, K: {...}, E: {...} },  // bytes left; month Infinity for H
  snapshot() → frozen { session: { H, K, E }, local: { H, K, E }, month: { key, K, E, used }, persistent, loaded },
  flush(),                                            // write the month record now (call it when the page hides)
  ready }                                             // Promise: the stored month record was read (or failed)
  // storage: { get(key), set(key, value) }, synchronous or promise-returning; stored value { v: 1, month, K, E }

// src/loader/seed-planner.js
export function planSeeding({ items, budget, now, config }) → { order: [ih], idle: [ih], share: { [ih]: fraction } }
  // items: [{ ih, lane: 'H'|'K'|'E', bytes, complete, copies: { complete, atLeast }, pinned, openedAt, own }]
  // now: ms or a function; share: each ordered item's fraction of its lane rate (a lane's fractions add up to 1)

// src/loader/dock.js
export function createDock({ nav, doc, now, setTimeout, clearTimeout, battery, config }) → {
  supported() → boolean,
  start({ ms, declared }) → Promise<state>,          // from a click; never rejects
  stop(reason = 'user') → state,
  state() → { on, until, reason, declared },
  on('start' | 'stop', fn(state)) → unsubscribe }
  // battery: a BatteryManager-like EventTarget, null (no API: start needs declared: true), or undefined
  //          (nav.getBattery() at start)
  // reasons: start refused 'unsupported' | 'hidden' | 'declare' | 'unplugged' | 'battery' | 'denied';
  //          stopped 'hidden' | 'unplugged' | 'battery' | 'cap' | 'user' | 'released'

// src/loader/localwire.js
export function isLocalPair(stats) → { local, reason }
  // reason: 'local' | 'no-stats' | 'no-pair' | 'no-candidate' | 'srflx' | 'prflx' | 'relay' | 'not-host' | 'public-address'
export function selectedPair(stats) → candidate-pair stats | null
export function addressKind(address) → 'private' | 'mdns' | 'hidden' | 'public'
```

## Readings and deviations

1. **Session caps are per lane.** The SZ table has one Session figure per row; the brief's shape gives each lane
   `{ rate, session }` and seed-engine's brief stops "a lane" on "its session cap", so each active lane may send up to
   the row's figure per page session (0 for a lane that is off). H is never starved by K and E this way (the
   per-upload card is the person's own choice). Arithmetic for the most a phone sends in one page session on wires
   that are not local, with K and E on: row 2 192 MiB (3 x 64; 64 MiB with H alone), row 3 64 MiB, row 4 64 MiB
   after "I am on Wi-Fi" (32 MiB before), row 5 16 MiB. If the owner wants the figure as a total across lanes,
   `remaining()` is the one place to change.
2. **Row precedence: the most restrictive row that applies wins.** A metered network (cellular or Save-Data, from
   the connection API) and a battery under 20% unplugged are row 5 on any phone, before rows 2 to 4; a desktop is row
   1 unless its network is metered (then row 5, as ARCHITECTURE 8 already treats a metered desktop), whatever its
   battery ("Desktop, not metered"). The table has no row for a charging phone under 20%: it gets row 4.
3. **Proof beats a declaration.** "I am on Wi-Fi" counts only when the network class is 'unknown' (never against
   connection.type); Wi-Fi proven by connection.type earns the row 4 Wi-Fi rates without a tap. Row 2 needs Wi-Fi by
   connection.type, except in dock mode, where the person's word ("plugged in, on Wi-Fi", S1 D3) stands in for what
   the browser cannot read and never for what it can (a battery the browser reads at 30% is row 4 in dock mode too).
4. **Dock mode counts as the opt-in for K and E while it runs.** The brief lists two ways K and E run on a phone
   (`shareOnNetwork`, or SZ-1 with row 2). Starting dock mode ("Keep this screen on and share for 2 hours") is a
   click-started, time-boxed choice to share, so `env.dock` is a third; without it dock mode would keep the screen on
   for the person's own uploads only. One condition in `phoneKeepOn()` if the owner disagrees.
5. **The call row stops E on every device for the whole call.** The SZ table's E cell is "0" without a condition; the
   brief's summary says "desktop: K halved and E 0 while call.limited". Implemented the table: during any call a
   desktop sends no E, and halves K only while the call is bandwidth-limited; phones send H at most 128 KiB/s and no
   K or E. Session and month caps stay those of the row underneath. The call overlay applies to local wires too
   ("calls take priority over every lane").
6. **Local wires never lift a metered network or a battery under 20% unplugged.** Carriers hand phones host
   addresses in 10/8 and 100.64/10, so a host-to-host pair can cross a carrier network. On row 5 the local rates and
   session equal the row's own and `local.on` is false (seed-engine should then count such wires like any other).
   Elsewhere a phone's local wires get row 6 (K and E still need the opt-in) and a desktop's get row 1 with no
   session cap; local bytes never count toward the month.
7. **`ask`.** 'consent' when row 2 applies, SZ-1 is on and the seed.ask card was not answered, and also only while
   Share is On, "Share on this network" is off and dock mode is off (an answered or moot card is not asked again).
   "Not answered" needs a pref the store did not have: `seedAsked` (true once the person answered the card either
   way). 'wifi' when the same budget with the declaration raises any lane rate (computed, not listed), which in
   practice is row 4 on an unknown network.
8. **`defaultOn`** describes the context, not the person's switches: true on a desktop off metered networks and, with
   SZ-1, on a phone in row 2; false under host-only.
9. **20 GB is decimal** (20,000,000,000 bytes), as the table writes GB for the Delivery Optimization figure and MiB
   or GiB elsewhere.
10. **The planner.** K is ordered like E (copy deficit, then the newest openedAt), as the brief gives no order inside
    K. Within a lane each served item gets an equal share, and a lane serves no more items than leave each at least
    the 32 KiB/s shaping floor (`floor(rate / minShapingBytes)`, at least one): 4 hand-offs at 128 KiB/s, 8 echoes at
    256 KiB/s; the rest wait in `idle`. Items at or above the echo target still echo, last. A missing budget plans
    nothing. The planner never re-lanes: an own item stays H until the engine moves it (SZ 3.1.2: H ends at a pin
    receipt or two complete peer copies). `bytes`, `copies.atLeast` and `own` do not change the plan in C2.
11. **Dock reasons beyond the brief's list:** 'released' (the browser released the lock while the page stayed
    visible), and the start refusals 'unsupported', 'hidden', 'declare' (no battery API and no declaration),
    'unplugged', 'battery', 'denied'. 'cap' is the end of the time limit (the requested duration, at most 8 hours).
    The lock is requested before any await, so it stays inside the click. A second start while the first waits gets
    the same promise; `stop()` while waiting cancels it (reason 'user'); start while on sets a new limit from now.
12. **Local addresses beyond the brief's list:** the IPv4 link-local 169.254/16 and loopback (127/8, ::1) count as
    private, like fe80::/10 already does; neither can cost internet data. IPv4-mapped IPv6, zone ids and brackets are
    read. As the brief says, a hidden address counts on a host candidate, on either end (see open item 3).
13. **The lint is stricter than the literal list, and has one recorded exception.** It also fails on bracket access
    with a string key (`navigator['audioSession']`, `md['getUserMedia']`), aliases and `Object.assign` on
    `navigator.audioSession`, `new OscillatorNode(`, `.loop = !0` and the legacy `webkitGetUserMedia`; feature
    detection with `typeof` passes everywhere. Exception: `src/idp/cards.js` (the device-link QR scanner, R 2.13)
    calls getUserMedia for the camera; the lint allows exactly that file, only for getUserMedia calls whose arguments
    say `audio: false` (a test proves asking for the microphone there fails). Without it the brief's "passes on
    today's tree" could not hold.

## Behaviour that changes once seed-engine enforces the budget (for the CHANGELOG)

v0.3 shapes a phone at one 128 KiB/s limit (`mobileOptInUploadLimit`) after "Share on this network", and shapes own
uploads with the per-upload card at the same 128 KiB/s before it. With the SZ 3.1.3 rows:
- Own uploads (H) on a phone: 1 MiB/s in row 2, 512 KiB/s in row 3 and in row 4 on Wi-Fi, 128 KiB/s otherwise.
- K on a phone that opted in: 256 KiB/s in row 2, 128 KiB/s in row 3 and in row 4 on Wi-Fi; 0 in row 4 until
  "I am on Wi-Fi" (an iPhone that opted in sent K at 128 KiB/s in v0.3; `ask` is 'wifi' there) and 0 on a metered
  network (row 5), on a desktop too.
- A desktop whose three lanes are all busy may send 2.25 MiB/s in total (1 MiB/s + 1 MiB/s + 256 KiB/s, arithmetic)
  instead of one 1 MiB/s limit, since seed-engine's client throttle is the sum of the active lane rates.
- Unchanged with the flags at their defaults: phones send no K or E until "Share on this network" (or dock mode, which
  is new), and a hidden phone locks every lane, H included.

## Requests to other lanes

- **seed-engine:** treat every wire as not local when `budget.local.on` is false; stop a lane when
  `remaining(budget)[lane].session` or `.month` is 0, and its local wires when `.local` is 0; call
  `meters.flush()` from the hidden and pagehide plans; pass `planSeeding` the `now` timestamp; H ends at a pin
  receipt or two complete peer copies, so re-lane such items before planning.
- **wire-ui:** pass `env.networkProof`, `env.dock` (from `dock.state().on`) and `env.call` into `computePolicy`;
  while `dock.state().declared` is true pass `prefs.declaredWifi` and `prefs.declaredPlugged` true; set
  `prefs.seedAsked = true` when the person answers the seed.ask card or turns "Share on this network" off in Settings;
  create the meters with `key: 'seedMeters:' + origin` on the per-origin pref store; give createDock the
  BatteryManager (from `navigator.getBattery()`) or null; call `dock.start()` inside the click handler; decide how
  `Infinity` (none) crosses the bridge in `mw.net.seeding()` (structured clone keeps it, JSON turns it into null)
  and say so in SDK.md. Feature-detect getDisplayMedia in call-ui.js only with `typeof` or `in` (a truthiness read
  fails the lint).
- **calls:** Wake Lock requests belong in `src/calls/session.js` and capture calls in `src/calls/`; never write
  `navigator.audioSession`.
- **docs-strings:** mirror the signatures above into the INTERFACES 'v0.3 C2 (proposed)' part, including the additive
  fields (`call`, `local.on`, `prefs.seedAsked`, the dock reasons), and give the dock refusal and stop reasons text
  (or one generic line) for wire-ui. The contribution rules in ARCHITECTURE 8.1 should name the one exception the
  lint carries (the device-link QR camera in `src/idp/cards.js`, video only) and the `typeof` allowance.
- **integrator:** two tabs on one machine join over a host-to-host pair on private addresses, which `isLocalPair`
  calls local, so their bytes never reach the month cap. E-PS-3 (the month cap stops K and E, not H) needs wires that
  are not local, for example an init script that wraps `RTCPeerConnection.prototype.getStats` to report the selected
  pair's candidates as 'srflx' (lib.mjs already wraps RTCPeerConnection to count connections).

## Open items

1. SZ-1 and SZ-2 are not signed; both ship off (`CONFIG.seed.phoneDefaultOn`, `handoffWhileHidden`).
2. Whether the session figure should be per lane (built) or a total across lanes (reading 1) is for the owner.
3. Whether Safari and Chromium report candidate addresses in getStats for host pairs, or hide them (which the brief
   counts as local on both ends), is unmeasured; a gate row on one iPhone and one Android phone should record what
   `isLocalPair` answers on home Wi-Fi and on mobile data.
4. Every rate and cap is chosen (SZ 3.1.3), not measured; G-PS-1 to G-PS-14 confirm or tune them.
5. Should "Share on this network" tapped on a network the browser cannot classify count as "I am on Wi-Fi"? Built:
   it does not (the table asks for the declaration in row 4), so an iPhone that opted in sends no K until it is
   declared; wire-ui can offer the declaration where `ask` is 'wifi'.
