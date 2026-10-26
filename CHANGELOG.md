# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Version 0.3.0 is the first public release and a pre-1.0 release (0.2.1 was never published; see its entry): the release gate on real devices has not run
([docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md)), so felinar is not called production-ready. The formats that
the golden vectors in `test/vectors/` cover (the pointer, the block and the gossip HELLO frame) are frozen from
this release: vectors are added, never edited, so a change that breaks one is a new format version and is listed
under "Breaking". What comes next is in [docs/ROADMAP.md](docs/ROADMAP.md).

Item codes in brackets point into two lists. A letter and one digit (A1, B3, F4) is an item of
[docs/review/DIGEST-AMENDMENTS.md](docs/review/DIGEST-AMENDMENTS.md) (codes A to G). A letter and two digits (F13,
F36) is a finding of code review round 1, in the table of section 7 of
[docs/review/DESIGN-REVIEW.md](docs/review/DESIGN-REVIEW.md) (F01 to F58).

## [Unreleased]

## [0.3.0] - 2026-10-26

Pre-release, and the first public release: 0.2.1 was never published, because the red team of the v0.3 design review found seven defects in it that work today (MF-27, MF-28, MF-30 and MF-73 to MF-76). 0.3.0 fixes MF-27, MF-28 and MF-73 to MF-76, and fixes MF-30 in part: its signed `minSeq` is proposed, and the withdrawal expiry and two-source disagreement cover the cold-device replay meanwhile. The review round of the v0.3 design review (Part 5.3, the judges and the red-team attackers against the built code) ran on 2026-10-24, and its blockers are fixed. Of the other steps a release needs, the release gate on real devices has not run beyond the desktop parts of six rows, in a Brave browser on loopback ([docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md)), Firefox ran only in the automated harness, and the outside review of the new cryptographic code that R 2.19 asks for before 1.0 has not happened. No lawyer has reviewed the privacy texts (the cards, the v0.3 sections of [docs/PRIVACY.md](docs/PRIVACY.md) and the safe harbour of [SECURITY.md](SECURITY.md)): the owner decided against it, and AI research agents checked them against the code and against published law and regulator guidance in its place, in a review that ended on 2026-10-24. That review is research, not legal advice. Every test below ran on loopback only (Apple M3, Playwright Chromium 156, WebKit 27.2 and Firefox 157.0).

How this release was made:

- One maintainer made it: the person who pushed the tag also approved the environment "release" that the attest and release jobs wait for, and no second person reviewed the lock files, so the two-person rule of R 2.19 is not met ([SECURITY.md](SECURITY.md), "The security program for 1.0").
- `felinar` and `@felinar/verify` were published to npm by hand, so neither carries npm provenance: no workflow publishes to npm ([docs/ROADMAP.md](docs/ROADMAP.md), release provenance).
- No hub runs for this release: without one, `examples/social` runs as personal sites with a hub-less follow lane.
- The signed per-file hash lists are the check of this release: `node tools/verify-release.mjs verify`, offline and under the release key built into the tools, accepts a copy of these files from any mirror, door, torrent or USB stick just as it accepts a download from GitHub, and the build provenance attestation is extra evidence for a copy that came from GitHub ([SECURITY.md](SECURITY.md), "Checking a release"). The checksums below give the sha256 of each zip and of the package, and the build id and bundle sha256 of the identity page. The project holds no domain: reports go through private vulnerability reporting on GitHub, and the places to compare the release key with are the tag message, `release-key.txt` with its OpenPGP signature and an archive copy of SECURITY.md. They protect against a takeover of the GitHub account after the release, not against the owner, who controls all of them.
- The zero-setup route (`felinar ship` with a nip.io or sslip.io name; [docs/DEPLOY.md](docs/DEPLOY.md), "Zero-setup: a server without a domain") is not a domain of your own: the name changes if the IP address of the server changes, visitors who already opened the site keep their saved copy if the DNS service stops, and the box is one server, not a backend. It is a stepping stone to a domain you own, where the pointer can also live in DNS. Its rows G-ZS1 to G-ZS4 have not run.

The source of truth is [docs/review/V03-DESIGN-REVIEW.md](docs/review/V03-DESIGN-REVIEW.md) ("R"). Its contracts are in
section 15 of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the v0.3 part of [docs/INTERFACES.md](docs/INTERFACES.md),
marked v0.3 where the code landed and "(proposed)" where it did not. The lanes' notes are in `docs/deviations/`, the
integrators' in [docs/deviations/integration-v03.md](docs/deviations/integration-v03.md).

### Renamed to felinar

- **The project is now felinar** (Romanian for a street lamp; tagline "the light web", a play on the dark web: sites in plain sight,
  visible by design, no backend). It was magnet-web until v0.3, then Lightweb for one day (2026-10-21 to 2026-10-22), a name that was
  never published and was dropped because a preliminary search found a pending US trademark application for LIGHTWEB in class 42
  (software services). The package is `felinar` and the command is `felinar` (`bin/felinar.mjs`); `magnet-web` stays as an
  alias command for one release and is removed in the next, and the `lightweb` alias went with the name (nothing was published under it). The server-side sign-in package is `@felinar/verify` (it was never
  published under an earlier name). The documents, the examples, the workflows, the Docker image names, the release file names
  (`felinar-<version>-dist.zip`, `-idp.zip`, `.tgz`) and the box directory (`/opt/felinar`) use the new name.
- **Unchanged for compatibility:** the SDK global `mw`, every `mw-` prefix, the `/_mw/` routes, the wire extension names (`mw_chat1`,
  `mw-signin-v1` and the rest), the pointer, block and key formats, the golden vectors, the `~/.config/magnet-web/` key directory, the
  `magnet-web-identity-backup.json` backup file name, the `Symbol.for('magnet-web.sdk.facade')` key and the `magnet-web-idp` manifest
  name ([docs/deviations/rename-felinar.md](docs/deviations/rename-felinar.md)). Every other on-disk and on-wire format reads and
  writes as before.
- **Renamed with the project:** the `web+lightweb:` link scheme and the `lightweb-door` and `lightweb-doors` kinds of the door files
  are now `web+felinar:`, `felinar-door` and `felinar-doors`. They were never published under the old name, so no old form is read.

### Breaking

- **Ledger operations a 0.2.1 peer does not know.** A 0.2.1 peer treats `unban`, `keyinfo`, `rotate` and the defined
  `checkpoint` as an unknown operation and rejects the block. The freeze-group release has to ship before any public
  ledger carries one of them, and a pointer's `ml=` floor makes older loaders refuse to mount the site.
- **`rot=` v1 is removed.** A pointer record that rotates the owner with the old unscoped `rot=` is no longer accepted as
  a silent rotation. The frozen vector `ptr-010-rotation` now verifies as owner-changed; the new vector
  `ptr-023-rot-v1-refused` supersedes it.
- **`nx=` is sticky under one owner.** A record of the same owner whose `nx=` differs from the previous record's is
  refused, and withdrawals carry `nx=` forward.
- **Web seeds from unsigned magnet links are filtered.** An unsigned magnet link whose `ws=` or `xs=` names a private,
  loopback or link-local host (other than the page's own origin), or more than 4 and 2 of them, loses those web seeds.
- **Writing needs a sign-in.** Posts and moderation actions are signed with keys that the identity origin derives for the
  site. A guest's first write opens the sign-in prompt instead of failing (docs/SDK.md, "The implicit sign-in"). A second
  tab of the same site holds no keys and cannot start a sign-in; it follows the first tab. A 0.2.1 posting key is offered
  at the first sign-in ("Keep posting as <name>") and moves into the identity origin's vault; the site deletes its copy
  only after a backup file exists.
- **The backup moved to the identity origin.** In a build with the identity service the shell's Settings no longer carry
  the 0.2.1 export and import fields (the drop-in panel's v0.3 Settings never did); the recovery phrase and the backup
  file live at the identity origin.
- **SDK.** `mw.mod.ban` needs a click (it is a UI method). `mw.ready()` answers again on every call once the loader has
  answered once, so `auth`, `identity`, `role` and `features` follow the sign-in; in shell and hub mode it used to keep
  its first answer. The rest of the 0.2.1 surface keeps its names, parameters and results.

### Added

- **The identity origin** (`src/idp/`, built by `tools/build-idp.mjs` into `dist-idp/`). A static origin of its own that
  holds a person's root: 16 random bytes shown as 12 words, with an optional extra word. It derives a key per site
  (pairwise by default; "Same as on <the other site>" with a deliberate second press; a visit-only key on a shared-origin
  hub), unlocks with a passkey (PRF) or a passphrase (Argon2id in plain JavaScript, PBKDF2 named on the card as the
  fallback), and draws its own cards. The recovery phrase, the backup file and the device link by QR code are there and
  nowhere else (no site origin has such a field; checked end to end, E-ID-10).
- **Sign-in for any site.** The `mw-signin-v1` proof format with test vectors
  ([docs/specs/mw-signin-v1.md](docs/specs/mw-signin-v1.md)), `@felinar/verify` (`packages/verify`: one file, no
  dependencies; on npm, published by hand), the page-side identity client (`src/identity/client.js`) and the `<mw-signin>`
  element (`publish --signin-widget` copies it and prints its tag with the SRI hash).
- **The person's record** (`mw.me`): sealed items of a fixed size that only the person's keys open.
- **Messages** (`mw.chat`, `src/chat/`). A chat lane on its own wire extension (`mw_chat1`): a Noise XX handshake on
  P-256 on every wire, frames with a relay stamp, a sealed box for direct messages, replay protection, holders and a
  mailbox protocol, groups with an epoch chain, rooms, presence, and an outbox with a delivered state; `<mw-chat-panel>`
  for drop-in pages. Messages are never written to a ledger (checked end to end, E-CH-8).
- **Files and private media** (`mw.files`, `mw.media`; `src/files/`, `src/media/`, `src/sw/media-route.js`). Public file
  listings and private files fetched by infohash; private media in a chunked, padded and encrypted format with an upload
  pipeline (type sniffing, metadata removal, faststart, a poster), an IndexedDB chunk store, the inert download route
  `/_mw/f/` and the Range-capable media route `/_mw/media/<sid>` in the Service Worker; grants sent as sealed direct
  messages, revocation, and offer cards that are never accepted on the person's behalf.
- **Hub mode: personal pages and the follow lane** (`mw.hub`; `src/loader/personal-site.js`, `src/chain/multi.js`,
  `recent.js`). "Create my page" makes a personal ledger in the browser (the genesis in the link's fragment, a pointer with
  `nx=` signed by the person, a label `<32 base32>.<hub>`); followed ledgers sync over `mw_chain2` in recent windows, with
  follow caps.
- **SDK 0.3.0** ([docs/SDK.md](docs/SDK.md)). The namespaces `auth`, `me`, `chat`, `files`, `media`, `report` and `hub`;
  `identity.current`, `identity.backupStatus` and `identity.openIdentity`; `db.setMine`, `db.getMine`, `db.listBy` and
  the `ledger` option; `mod.unban`, `mod.tombstoneMany`, `mod.queue` and `mod.decide`; the push events `auth`, `chat`,
  `files`, `media`, `mod`, `keychange` and `hub`; 29 error codes. A UI method (one that opens a card, the identity page
  or a file dialog) needs the person's click, counted by the loader for 5 s, and the methods that would reach a key, the
  root or a consent do not exist in the SDK.
- **Loader and ledger hardening that ships with v0.3.** Wire caps counted by wire, ignored wires closed, a `ut_metadata`
  limiter, clamps on DNS lifetimes and timers, pins and refusals signed by a per-device key, one wire budget across all
  swarms, bounds on the ledger HELLO frame (a HELLO with `d = Number.MAX_SAFE_INTEGER` is refused before any work; E-HD-1),
  and the pointer fields `org=`, `nx=`, `ml=` and `idp=`.
- **The ledger freeze group.** `unban`, `ban.until`, `keyinfo`, `rotate`, a defined `checkpoint` with pruning behind it, a
  bulk `tombstone`; the policy fields `modAllowPerDay`, `modActionsPerHour`, `reservedPool` and `voided`; owner-protected
  entries, author-scoped `@` keys, moderator caps, and schemas for `mw.*` lists and `_mw.*` keys as state rules that never
  affect validity; new vectors.
- **Tools.** `ledger-admin` for the freeze group and `ledger-admin cfg` (the site's `_mw.cfg`: chat off, for members or
  open; files and media off or for members; sealed records; requests); `publish --org`, `--next-key`, `--ml`, `--idp`,
  `--prev-pointer`, `--signin-widget`, `--chat-panel`, `--chat`, `--files` and `--media` (these three require
  `--tracker` and `--stun`: the features never use the public default trackers), `--turn` (a relay, off by default) and
  `--cfg-from`; `npm run init` (prints the owner's commands in order and runs nothing); `npm run build:idp`;
  `tools/verify-release.mjs` (a signed per-file hash list); `tools/webseed-file.mjs`; `pin --mailbox`, `--files` and
  `--quarantine`; seeded fuzzers (`npm run test:fuzz`); `build.lock.json`, which pins every bundled package; CI,
  release (it stops at a draft) and rebuild workflows, none of which had run on GitHub before 0.3.0 was pushed.
- **Examples.** `examples/social`, the hub template of R 3 (timeline, profiles, follows, comments, reactions, groups,
  messages, media and settings; the directory ships off, behind a flag marked "pending counsel", and no lawyer is engaged for 0.3.0); the guestbook's v0.3
  pages (sign-in, a profile with the private record, members with chat, files and media); and the Example Forum with
  `<mw-signin>` and `<mw-chat-panel>` (`examples/existing-site-dropin/with-widgets/`, checks 11 to 20 of its EXPECTED.md).
- **Documents.** [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md); v0.3 sections in [docs/PRIVACY.md](docs/PRIVACY.md),
  [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md), [docs/OPERATIONS.md](docs/OPERATIONS.md), [docs/WHY.md](docs/WHY.md),
  [docs/FAQ.md](docs/FAQ.md), [docs/DEPLOY.md](docs/DEPLOY.md), [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) and
  [docs/ROADMAP.md](docs/ROADMAP.md); the 40 real-device rows of the v0.3 gate in [docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md),
  all "not yet run"; the owner steps of [docs/PUBLISH-CHECKLIST.md](docs/PUBLISH-CHECKLIST.md), section 16; three recipes
  ([sign-in on a Node server](docs/recipes/signin-server-node.md), [the sign-in widget](docs/recipes/signin-widget.md),
  [a pin node for a hub](docs/recipes/hub-pin.md)); and the security program for 1.0 in [SECURITY.md](SECURITY.md), whose
  code parts exist and whose people parts have not happened.
- **Tests**, as run in the final integration on 2026-10-20: `npm test` 1,533 tests (lint-floor clean over 127 files),
  `npm run test:browser` 37 (36 pass, 1 skipped: the v0.1 worker test), `npm run test:example` 170,
  `node test/e2e/run.mjs` 60 scenarios and `node test/e2e/run.mjs --webkit` 63, all passing, with the network policy check
  passing in both runs. Of the 64 end-to-end rows of R 4.2, 33 ran in a browser and passed (9 of them only in part) and 31
  are open, each with its reason ([docs/deviations/integration-v03.md](docs/deviations/integration-v03.md)).

### Fixed in the final integration

- A page made with "Create my page" could not load the template: its pointer had no `tr=`, `ws=` or `xs=`, and a signed
  record is announced and fetched only from its own lists. The personal pointer now repeats the template's `tr=`, `ws=`,
  `xs=` and `idp=`, signed by the person (F-1; ARCHITECTURE 15.13).
- `mw.ready()` kept its first answer in shell and hub mode, so a page that had signed in still read `auth: 'guest'` (F-2).
- The hub follow lane's clock was never started: a followed page showed its first window and never a later post (F-3).
- Every file and media item fetched by infohash failed its torrent check, because WebTorrent builds a `torrentFile`
  without an info dictionary as soon as a magnet is added (F-4).
- `<mw-signin>` on a page published with `--idp` could not find the identity origin (F-5).
- `<mw-chat-panel>` asked for the chat consent twice (F-6).
- The shell's 0.2.1 export and import fields were in the DOM of every v0.3 page, hidden (F-7).
- Loopback test builds of the loader read the same Public Suffix List test entries as the identity origin (F-8); the
  development CSP allows a web seed on another loopback origin (F-9); the test browsers treat `*.localhost` as loopback
  (F-10).
- The social template: "Follow by link" refused an address that escapes only its spaces, "Create my page" could not open
  the new page once the identity cards had used up the tap, and the README's publish command lacked `--spa`, so a deep
  link did not reload (F-11).
- The Example Forum's documented `ledger-admin cfg --chat members` refused every visitor (they are readers, not writers);
  it is `--chat open` (F-12).
- docs/SDK.md described a `mw.files.preview` result that does not exist (F-13). `dist-idp/` and `dist-idp-test/` are
  ignored by git (F-14).

### Added in phase C2: smart seeding, the pin node's proof, zero-setup hosting, calls and doors

Phase C2 was built by eight lanes from [the C2 design](docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) ("SZ") and
[S4](docs/research/v03/S4-doors.md), and integrated on 2026-10-20 ([docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md),
"v0.3 C2 integrated"; [docs/deviations/integration-c2.md](docs/deviations/integration-c2.md)). Browser only: nothing asks a member to
install anything, an installed web app counts as the browser, and the pin node is infrastructure the owner or a hub runs. It ran on
loopback only; no C2 row of the release gate has run on a real phone, server or network.

- **Smart seeding** (ARCHITECTURE 8.1; `src/loader/seed-budget.js`, `seed-meters.js`, `seed-planner.js`, `localwire.js`, `dock.js`,
  `availability.js`, `superseed.js`, `torrent.js`). Three lanes in spending order: H (a member's own new items, until a pin receipt or two
  complete peer copies), K (what the person chose to keep, and the site) and E (items already held, by copy deficit, never fetching what
  the person did not open). Budgets by device, network proof, charging, battery, visibility, session and UTC month (the SZ 3.1.3 table;
  every rate and cap is chosen, not measured), choke locks instead of a zero throttle, local wires (host-to-host pairs) outside the month
  cap, and calls ahead of every lane. Counters stay on the device and are never sent or ranked.
- **Honest availability labels.** Evidence tiers E0 to E4 decide every label ("Only on this device", "Kept by you and at least {n} others
  online now (reported)", "Kept by the site (checked {age} ago)"); a count is "at least" and "reported"; "Kept by the site" needs a pin
  receipt or a signed heartbeat at most 15 minutes old. `mw.files.list()` and `mw.media.list()` keep `available` and add `evidence`,
  `label`, `labelParams` and, for own items, `handoff`.
- **The pin node's proof** (`src/pin/frames.js`, `src/pin/heartbeat.js`, `src/loader/pinwire.js`, `tools/pin.mjs`). The `mw_pin1` wire
  extension (a challenge, a hello and a receipt, ECDSA P-256 under the prefixes `mw-pin1-hello` and `mw-pin1-receipt`), a signed heartbeat
  with hashed item ids (`mw-pin-status-v1`) at `<ws base>/pin-status.json`, `_mw.cfg.pin` naming the node's own key, a Node signer that
  signs only those two forms (the key never enters a page), `pin --pin-key`, `--status`, `--auto-accept owner` and `--month-cap`, and the
  pin's own page answering as the pin (`window.__mwPinHost`). New vectors `test/vectors/pin.json`.
- **Dock mode and the keeper tab.** "Keep this screen on and share for 2 hours" on a phone (a Screen Wake Lock taken inside the click, a
  dim page, it ends when the page is hidden, the phone is unplugged, the battery falls under 20% or at the cap of 8 hours; no audio or other
  keep-alive), and "Keep this site" on a computer. `mw.net.seeding()`, `mw.net.dock({ hours })` and `mw.net.keep(on)`.
- **The carry meter** in Settings, "Sharing": "This visit: {p}% of the bytes came from {n} visitors, {h}% from the host." and the tracker's
  count, labelled as a tracker report.
- **Peer-to-peer calls** (ARCHITECTURE 15.14; `src/calls/`, `src/loader/call-ui.js`, `mw.calls`). Audio, video and screen sharing between
  signed-in contacts, 1:1 or a mesh from a chat group (caps, chosen: 6 with audio only, 4 with video); offers and answers only inside SIG
  frames sealed with the pair key, so the DTLS fingerprints are authenticated end to end and checked against the certificate stats; the
  callee makes no connection before accepting, so a declined or ignored call shows nobody's address; a loader-owned call panel; per-class
  bitrates with a 2 s adaptation ladder; `_mw.cfg.calls = contacts` (off by default); six error codes (`E_BUSY`, `E_DECLINED`,
  `E_NO_ANSWER`, `E_MEDIA_DENIED`, `E_NO_DEVICE`, `E_CALL_FAILED`). No server in the media path unless the owner runs a relay; the
  SDK never returns a `MediaStream`. New vectors `test/vectors/calls.json`.
- **The zero-setup ladder** (QUICKSTART "Start without a domain", DEPLOY "Zero-setup"). `npx felinar ship` (`npm run ship`): a folder to a
  site on a rented server named `a-b-c-d.nip.io` (sslip.io after a name check), behind one Caddy box with automatic HTTPS
  (`deploy/one-box/`, with a `pin` profile); the owner key never leaves the computer. `tools/name-check.mjs`; the loader and `check-site`
  never ask a DNS resolver about a `nip.io` or `sslip.io` name; `dev-server --tracker-proxy` for the LAN rung; `publish --calls`,
  `ledger-admin cfg --calls` and `--pin`.
- **Doors** (ARCHITECTURE 15.15; `src/loader/doors.js`, `src/common/pointer.js`). Light links that open a site at any door that serves the
  loader (`/_mw/open.html#<record>`), signed `dr=` doors and the owner's `_doors` ledger item, a sandboxed door view, the byte fallback
  across doors checked by infohash, a "not answering" banner that offers the other doors (it never navigates by itself), the installed
  door app; `publish --door` and `--door-kit`, `check-site --door`, `ledger-admin doors`. New pointer vectors `ptr-027` to `ptr-034`.
- **Strings and documents.** `SEED_TEXT`, `CALL_TEXT` and `DOOR_TEXT` in English and French (the French not yet read by a French speaker);
  C2 parts in ARCHITECTURE, INTERFACES, PRIVACY, SECURITY-MODEL, THREAT-MODEL, COMPATIBILITY, ROADMAP, WHY, DEPLOY, QUICKSTART, FAQ and
  DEMO-RESULTS (rows G-PS-1 to G-PS-14, G-ZS1 to G-ZS4, G-CL-1 to G-CL-9 and G-DR-1 to G-DR-4, all "not yet run").
- **Tests.** New unit files for every C2 module (seed policy, meters, planner, dock, local wires, availability, super-seeding, mw_pin1,
  the heartbeat, calls, the call panel, the SDK's C2 surface, ship, name-check, one-box, doors, the integration seams) and the contribution
  lint of SZ 3.1.9 (no keep-alive media, no `navigator.audioSession` writes, Wake Lock only in `dock.js` and `src/calls/session.js`, capture
  only under `src/calls/`). End to end on loopback: E-PS-1 (a 5 MiB hand-off to a pin node, "Kept by the site" 5.1 s after the approval),
  E-PS-2 (lying bitfields stay "reported"), E-PS-3 (the month cap stops K and E, not H), E-PS-4 (dock mode's Wake Lock taken and
  released), E-ZS-1 (no DNS-over-HTTPS query for a nip.io name), E-CL-1, E-CL-2, E-CL-3 (Chromium with fake media devices), E-CL-1W
  (WebKit, with screen sharing), DOOR-DOWN, DOOR-HASH, DOOR-GUEST and DOOR-GUEST-W. As run on the final tree on 2026-10-20: `npm test`
  1,967 tests, all passing (lint-floor clean, 146 files); `npm run test:browser` 40 tests, 39 passing and 1 skipped; `npm run
  test:example` 170 tests, all passing; `node test/e2e/run.mjs` 71 of 71 in 487.1 s and `node test/e2e/run.mjs --webkit` 76 of 76 in
  494.8 s, each with its network policy check passing (every request stayed on 127.0.0.1).

### Changed in phase C2

- **Own uploads and sharing follow the budget.** A phone's own uploads (H) can go up to 1 MiB/s on Wi-Fi while charging (v0.3 sent at
  128 KiB/s); K on a metered network is 0 even after "Share on this network"; an iPhone that opted in sends no K until the person says "I
  am on Wi-Fi"; a desktop can send up to 2.25 MiB/s in total when all three lanes are busy (arithmetic). Phones still keep K and E off by
  default (owner decision SZ-1 unsigned).
- **`available: 'kept'` needs evidence** (E3 or E4): a `ws` field alone no longer counts. The end of the hand-off clears the upload
  exception. A phone upload shows the MF-45 card first.
- **A public file being fetched is lane E and incomplete, so it is not shared while the fetch runs** under a budget; the sentence "Fetching
  also shares it with others while this page is open" overstates this (open, owner and seed-policy).
- **`_mw.cfg` accepts `calls`** (`off` | `contacts`), a state rule of the freeze group.

### Fixed in the C2 integration

- No page used `mw_pin1`: `pinwire.js` was imported nowhere, so no receipt could arrive and the pin's own page offered no pin host
  (C2-7); `tools/pin.mjs` offered pinned files to the page only after a reload (C2-8). The pin page's host now starts only files the
  node lists as pinned, so site code on that page cannot make the node join a swarm nobody approved (C2-22).
- `_mw.cfg` naming `calls` was hidden whole by every reader (C2-5).
- Two browsers on one machine could never connect a call (the "same local network" choice has no switch in C2): a development build
  (loopback or `<meta name="mw-dev">`) has `window.__mwShell.setCallPrefs` for its tests; a production page has no such hook (C2-9).
- The call panel could not be used: its first card was cancelled by its own redress guard while its stylesheet loaded, it overlapped the
  loader cards (each overlay cancelled the other's buttons), and in WebKit its stylesheet never loaded (C2-11 to C2-13).
- The carry meter's lines in the loader bar covered the site's own controls while a notice kept the bar open (C2-10).
- The door view's SDK, the loader import on a second door, and a cross-origin target in the activation tracker (C2-4, C2-6).
- The e2e media lab no longer loaded after the files and media lanes imported the availability labels (C2-14); two flaky unit tests
  (C2-16).
- The tests and the repository: the 45 new golden vectors (pin 15, calls 22, pointer `ptr-027` to `ptr-034`) are locked in
  `test/vectors/LOCK.json` (C2-1); docs-links also searches `docs/research/v03` (C2-2); the five tests that assert the SDK's exact
  surface include the C2 surface (C2-3); a rejection left behind by a failed step no longer ends the whole e2e run (C2-15);
  `dist-ship/` is ignored and `npm run ship` exists (C2-17); the door view's browser test moved to a file `npm run test:browser` runs
  (C2-20); each e2e site publishes a ledger of its own, since one owner key and one scope are one ledger by design (C2-23); and the
  social template's error table has the six call codes, so it equals the SDK's table again and `npm run test:example` passes (C2-24).

### Known gaps of phase C2

- **The release gate on real phones has not run:** none of G-PS-1 to G-PS-14, G-ZS1 to G-ZS4, G-CL-1 to G-CL-9 or G-DR-1 to G-DR-4.
  What phones do in the background, dock mode on a real phone, calls on iPhone and Android, a Let's Encrypt certificate for `ship`, nip.io
  from a phone and a relay are not measured. Every rate, cap and window of the seeding budget is chosen. The review round (R 5.3) had
  not looked at the C2 code when this was written; the round of 2026-10-22 to 2026-10-24 read it with the rest (its seeding,
  pin node and one-box findings are under "Changed in the review round").
- **No pin request path:** nothing in a member's page sends a pin request (`files.pinRequest` and `media.pinRequest` answer `E_POLICY`,
  SZ-6 requests nothing from a browser), so a pin node keeps the site and what an operator enters at its queue. Since code review round 2
  the pinned page's bridge takes only a request its author signed (`src/pin/frames.js` `makePinRequest`); a member's page that signs and
  sends one is proposed for v0.4.
- **Owner decisions SZ-1 to SZ-6 are unsigned;** the build ships each behind a flag or default that keeps the earlier behaviour.
- **Calls:** "same local network" and "Hide my IP from people I call" have no switch or strings (only a development build has a hook
  that sets them, for tests); a ring reaches a contact who is not a direct neighbour only through desktop relays; above 6 people (4 with
  video) a call needs a mixing server, which v0.3 does not have; plan for 10% to 30% of pairs needing a relay (a planning range, not a
  measurement). Two WebKit browsers on one machine connected the swarm only after a capture had started (measured on loopback: before it
  WebKit offers only an mDNS candidate).
- **Drop-in mode** answers `E_UNSUPPORTED` for every `mw.calls` method (a page load would end a call) and, until the drop-in engine gets
  a net control, for `mw.net.seeding`, `dock` and `keep`. The keeper tab shows the site's name and the month counter, not the list of
  what it keeps; a private own file gets no line on the upload card; keeping something does not ask the `seed.ask` question; the
  call cards have no `call.call` or `call.join` button strings (they say "Continue").
- **Zero-setup:** the CI job that checks the one-box Caddyfile pins Caddy by tag (`CADDY_IMAGE: caddy:2.11.7`), not by digest, and the
  Compose file runs `caddy:2.11`; the job prints the digest it pulls, to be copied into `CADDY_IMAGE`, and it had not run before 0.3.0 was pushed. Dependabot does not watch the images of `deploy/one-box/docker-compose.yml`.
- **Seen, not fixed:** super-seeding stays off (`CONFIG.seed.superSeed`) until G-PS-8; two lying complete bitfields end the hand-off early
  (the label still says "reported"; spot-checks are v0.4); the signed-in header card covers the bottom centre of a site while shown; the
  strings `avail.heldBy` and `meter.visit` have no singular form; the French C2 strings are unreviewed; Firefox was not run (since 2026-10-22 it runs in the
  harness, which does not cover calls in Firefox: E-CL-1F is held out, docs/deviations/firefox.md).

### Changed in code review round 2 (v0.3, 2026-10-20 to 2026-10-21)

Four reviewers (security, correctness, browser, conformance: [docs/review/code-review-v03-security.md](docs/review/code-review-v03-security.md),
[correctness](docs/review/code-review-v03-correctness.md), [browser](docs/review/code-review-v03-browser.md),
[conformance](docs/review/code-review-v03-conformance.md)) reported 84 findings on the v0.3 and C2 code, 9 critical and 29 high. Four area
fixers fixed them, none was rejected, and the integrator applied the requests they left for other areas; the record, with every file, is
[docs/review/DESIGN-REVIEW.md](docs/review/DESIGN-REVIEW.md), section 8, and what waits is on [docs/ROADMAP.md](docs/ROADMAP.md).

- **Site ledger.** Recovery (MF-20): a `keyinfo` counts only as a key's first block, a rotation revokes the old key like a hand-over, bans
  cover a key's rotation family, and ChainNode writes the keyinfo before an identity's first other block. One peer of the hub follow lane can
  no longer wipe a followed page (the view keeps only blocks that have an effect, trims by depth, and strikes junk). Every copy applies the
  checkpoint in effect and prunes, and a pruned ledger exports and imports with a checkpoint header (`tools/pin.mjs`, `snapshot.mjs`,
  `live.mjs`, `ledger-admin`). A block that claims a time more than 5 minutes ahead waits or is refused, and a live moderator block must claim
  a time within 15 minutes of its arrival, so a claimed time no longer defeats `ban.until` or the hourly cap. An expired temporary ban no
  longer counts. `_mw.cfg` takes `blockTiers`, `wall` and `requests: 'introduced'`. Vectors `lg-021` to `lg-025` are appended.
- **Identity origin.** A site's escrow copy is merged on every sign-in, never adopted whole (a removed key leaves a tombstone); a root
  wrapped by a passphrase is never escrowed; every vault change runs under a Web Lock, so two windows cannot overwrite each other; "Replace
  my keys" writes the recover rotation on each site and keeps the key of a label that owns a page; a proof is never given without the
  card; one site's record and the vault have size caps; the hub label is offered only for hub suffixes the build names
  (`tools/build-idp.mjs --hub-suffix`, `--shared-origin`, new), and the page no longer decides "this visit only"; an expired pointer gives
  no ledger label and seq floors travel in the vault; the passkey ceremony is the press's first await, with "Tap to finish" for a fast
  refusal; the backup file downloads from its own button with its URL kept 60 s; Argon2id runs in slices; the iOS Home Screen promise is
  gone; fields are 16 px. The weak-passphrase message names the rule, and the removal card states that an older backup still holds the key.
- **Loader and worker.** Chat, group, file and private media swarms gather ICE only through the site's own STUN list; doors ask only owner
  doors, the last good door and the record's `ws=` and `xs=` hosts for a site's bytes; the upload card says details were removed only when
  some were; "Continue in this tab" starts the redirect sign-in when the popup is blocked; a seek's pieces come first and a cancelled range
  lets go of them; personal pointers are signed again before they expire; follows open on memory stores in batches; `100.64.0.0/10` is not a
  local address; on a phone the signed-in header folds into a chip; the recovery kit card follows the first meaningful action; a deny matches
  a reported public file or media item; the pin key counts only from an owner-written `_mw.cfg`; the DNS badge says "resolver says
  validated" and `#host:<name>@<fp>` links are wired. **Premoderation** (MF-53): a new key's first public listing waits in the moderators'
  queue, is listed only for its author (`pending: true`) and cannot be fetched by anyone else until a moderator accepts it, or the owner
  offline with `ledger-admin listed --ih <infohash>` (new). `mw.hub.createPage()` needs the person's hub key.
- **Chat, calls and media.** Group rekeys: removals win and the tie-break cannot be ground by a removed admin; private media and file keys
  survive a reload in a device vault; grants are typed and a Blob fallback is typed only when its bytes sniff as an allowed type; contacts'
  chat keys persist; held mail is taken within the 7-day hold; a lost ACK is sent again and invites are ACKed; a removed member cannot post
  through the previous epoch; MP4 timed-metadata and subtitle tracks are stripped; image decoding falls back when the orientation option is
  missing; posters come from muted playback; the replay guard is saved soon after each accept; one sealed copy per message per day; a revoke
  with re-encryption moves the item to its new id; a HOLDING counts once per wire and the (flagged) delivery string says "N peers reported
  holding it"; the chat keys of a key that the ledger shows as rotated away are refused; call notes for phones wait for their gate rows,
  and phones say "Keep this page open during the call."; own media kept on a device join their swarms again after a reload; the worker
  reports a message it could not read, so a media session retries at once; a SIG or a message a new neighbour sends right behind its
  chat-key frame is read with the tags that key brings (the lane reads a wire's next frame once the CK frame is handled; found when a
  call's first ring was lost under load).
- **Tools, deploy and sign-in for any site.** A pin request counts only with its author's signature; a browser that may reach the internet
  runs with Chromium's sandbox (the pin image sets `MW_CHROMIUM_NO_SANDBOX=1`, and the one-box pin service drops every capability);
  `tools/lint-floor.mjs` checks the post-floor APIs v0.3 detects; `ledger-admin` and `publish` warn when a policy opens writing;
  `<mw-signin>` opens the identity window inside the click; `@felinar/verify` builds the signing input before it uses the nonce (its
  sha256 is now `a579df9db488009c4a91a541f7cb6fa0b21ed04c852263cb2224a76ca5f04b78`).
- **Examples and documents.** "Create my page" in the social template stops unless the identity is the hub key; reports follow R 3.5;
  "Delete my page" deletes your keys too and promises only what runs; the directory checks its signatures; `PRIVACY.md` names where each
  right is exercised; background APIs, the per-author byte quota, the pin mailbox, `minSeq` and members' pin requests are marked
  (proposed); `SYB A10` is open (persisted peers cannot be built in a browser as stated).
- **Tests**, as run on 2026-10-21 by 02:40 ET, before the verify fix round 2 changed code, by the integrator and again by the
  independent verifier ([docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md), "v0.3 code review round 2 integrated"): `npm test` 2,074 tests, all passing
  (lint-floor clean, 147 files); `npm run test:browser` 42 tests, 41 passing and 1 skipped (the v0.1 worker test), after `npm run build`
  (before a build, `tools-v03-pin-browser` skips too); `npm run test:example` 177 tests, all passing; `node test/e2e/run.mjs` 72 of 72 and
  `node test/e2e/run.mjs --webkit` 77 of 77, each with its network policy check passing (every request stayed on 127.0.0.1).
  The one full end-to-end run after the verify fix round 2 passed 69 of 72: E-MD-4 failed with "no loadeddata", and E-MD-3
  and E-MD-5 with it, because they need it.

### Fixed in the verify fix round 2 (2026-10-21)

- **The demo's guestbook takes posts again.** Writing needs a sign-in (see "Breaking"), and `felinar demo` served no
  identity page, so every post failed with "The identity page could not be reached" (found with a loopback browser run
  of the demo). The desktop tier now builds the identity page next to `dist/` and serves it on its own loopback port
  (`--idp-port`, default 8081), and the pointer names it (`idp=`); the post opens it, and a second browser shows the
  entry. The LAN tier (`--tls`) still has no identity page.
- **Repository files for the release program:** `.github/CODEOWNERS` (the lock files and `.github/`, one code owner
  until there is a second) and a 14-day `cooldown` for Dependabot's version updates.
- **Documents:** they describe 0.3.0 as the release and the v0.3 and C2 code as what runs; the claims the verifier found
  untrue were corrected (docs/deviations/v03-fix.md).

### Changed in the review round (R 5.3, 2026-10-22 to 2026-10-24)

The review round of [the v0.3 design review](docs/review/V03-DESIGN-REVIEW.md) (Part 5.3) ran against the built code: 16
reviewers (the judges, the red-team attackers and the conformance reviewers) reported 203 findings (199 distinct ids), 136 of them
blockers or majors. Two refuters checked each of the 136: they confirmed 121, refuted 1 (STALK-4), and 14 were not verified
before the session limit. Ten area fixers then worked through the findings; their notes
(`docs/deviations/review-round-*.md`) record, by distinct id as section 5.4 of the review counts them, 121 findings fixed,
62 fixed in part and 15 rejected as minor or deferred, each with its files, its regression test and, for a part left to another area, a request. The integrator of the
round then applied the requests that are fixes ([docs/deviations/review-round-integration.md](docs/deviations/review-round-integration.md)),
which finished 19 more ids, so the counts are 140 fixed, 45 fixed in part and 13 rejected (R 5.4.1). The results are collected in
[docs/review/V03-DESIGN-REVIEW.md](docs/review/V03-DESIGN-REVIEW.md), section 5.4. Each line below names a defect the round
found and its fixer fixed, with its id, its severity as reported and the fixer area.

- **HUB-1** (blocker, chain): Any key can get any other key banned and its history deleted: a self rotation hands the rotator's ban to a key that never agreed.
- **HUB-2** (blocker, chain): A moderator ban or bulk tombstone deletes values at once: the 24 hour grace covers single tombstones only, so voiding or unbanning cannot restore content.
- **MP-1** (blocker, chain): One peer in a sync session can stream unlimited INV hashes: wants, queued lists and seen sets grow without bound and every frame costs O(all wants), so the tab freezes and runs out of memory.
- **SYB-1** (blocker, chain): A banned key can ban any other key by writing a self rotate to it; the victim's history is hidden and its values dropped.
- **SYB-2** (blocker, chain): Moderator hourly and daily caps are defeated by building on old parents and claiming old hours; the live-clock check never runs for solicited blocks.
- **DS-1** (blocker, chat): One WANT-TAGS neighbour captures every relayed and self-sent DM: routed targets replace flooding instead of adding to it.
- **PHISH-2** (blocker, identity): Every site gets the same escrow blobs and a stable vault id, which correlates a person's 'unlinkable' keys across sites without any consent.
- **SEC-1** (blocker, identity): Escrow blobs handed to every site are a stable cross-site identifier.
- **STALK-1** (blocker, identity): The identity page hands every site origin the same per-person constants (passkey credId, vault id, wrapped-root bytes) plus a vault copy whose size counts the person's sites, so per-site keys do not make sites unlinkable.
- **PTR-1** (blocker, loader-pointer): lo= plus chain= squat: a stranger's record mounts attacker code at the victim's own hub address and gets the visitor's keys there (PTR A1 is not blocked).
- **PTR-2** (blocker, loader-pointer): '#host:name@<fp>' link accepts any record that merely claims lo=<the fingerprinted key>, so first-use DNS trust (PTR A3) is not closed.
- **PTR-3** (blocker, loader-pointer): nx= (MF-28) is not enforced on the page-tag and DNS update checks, so a stolen current key still moves the site on every returning visitor's device.
- **MAL53-1** (blocker, loader-ui): Premoderation of a new key's first public files is defeated in two writes: an accepted infohash credits whoever re-lists it.
- **MAL53-2** (blocker, media): The 24-megapixel header cap is bypassed by a GIF whose logical screen is 1x1: Chromium decodes the first frame at its own, unbounded size.
- **SCALE-1** (blocker, media): File listing caps are uploader-side only; one listing with a huge declared len blocks every public upload on the site.
- **DS-3** (major, chain): Hub follow lane re-downloads every followed ledger's whole window every 5 minutes; phones never become idle.
- **HUB-4** (major, chain): modActionsPerHour and modAllowPerDay do not bound a moderator: a block forked from an old parent claims past hours, the live clock check never sees it, and a checkpoint removes even the floor.
- **HUB-6** (major, chain): A moderator can lift the owner's takedown (_deny entry) and replace the owner's _mw.cfg with one put; owner-protected payload covers tombstones only and voided never reaches payload.
- **HUB-7** (major, chain): rotate blocks from keys that may not write are admitted on owner-only and allow ledgers: about 2 MiB of strangers' control blocks per personal site, carried in every follower's window.
- **MP-2** (major, chain): A fresh root in every HELLO restarts a sync session at once: each 323-byte HELLO makes the victim send 22 KB or more of unpaced SYNC frames (70x measured, about 430x on a 100,000-block ledger).
- **MP-6** (major, chain): The parents of one paid orphan skip the writer fee: a single 12-bit post admitted 584 zero-bit blocks (up to about 2,000 per peer through the 256 orphan slots), so the fee no longer prices ledger fill.
- **SCALE-8** (major, chain): Lifetime block bound: a ledger past 358,876 blocks, pruned ones included, becomes unsyncable, and vetted authors are never stopped before it.
- **STALK-8** (major, chain): A new block is announced at once to every ledger peer: no jitter, no random subset, so the first announcer is the author (the 'mitigated' status of STALK A3 is false for blocks).
- **SYB-4** (major, chain): A rotate block needs no writer rights: any key writes permanent, unremovable blocks on owner-only and allow-only ledgers.
- **DS-5** (major, chat): A forged HOLDING from any relay stops all further held retries of a DM: an offline recipient never gets it.
- **DS-6** (major, chat): Replay Bloom false positives drop a new sender's message permanently; one group member can saturate the day's filter.
- **DS-7** (major, chat): Holder per-source quota is keyed by wire id, so reconnecting or opening more wires resets it and honest mail is evicted.
- **MP-3** (major, chat): WANT-TAGS route entries (tagRoutes) are unbounded: 32 random tags per 271-byte frame, about 29 bytes of victim heap per attacker byte, no strike, no expiry until the wire closes.
- **MP-4** (major, chat): Routing on unauthenticated WANT hints is exclusive: one neighbour that advertises all 256 prefixes black-holes every ENV/SIG frame it could carry, and honest decoy prefixes alone already strand part of non-direct sends.
- **MP-5** (major, chat): Any key can fill the chat-key cache: 4,100 throwaway CKs evict every contact's chat key, so contacts' messages are silently ignored and sends fail with E_NO_CHAT_KEY; each CK frame also costs a signature check and a full interest rebuild with no budget.
- **MP-7** (major, chat): One forged HOLDING stops a sender's held (offline) copies for good: HOLDING is unauthenticated yet the outbox treats the first report as proof and never sends another held copy.
- **MP-8** (major, chat): No per-wire ingress budget for the unstamped chat frames (ICHAL, PRES, WANT, CK, IRESP): each costs the victim an ECDH, an ECDSA verify, a table scan or an interest rebuild and costs the attacker nothing.
- **PRIV-1** (major, chat): Own chat frames leave at hop 0, at once, to every neighbour; with the two-way contact tag and the public stranger tag, a neighbour links sender and recipient addresses.
- **SEC-7** (major, chat): Relays freeze chatBits at lane start while senders read it live, so honest relays get struck.
- **SYB-10** (major, chat): Frames that need no stamp (CK, PRES, ICHAL, WANT, HELD) and ROOM have no per-wire rate or verify budget; several cost a signature check or a full interest rebuild.
- **SYB-14** (major, chat): The 200-entry message-request inbox fills with throwaway senders and then drops every later request silently.
- **SYB-15** (major, chat): A holder wipe: one neighbour is handed the whole store with 8 WANT frames, then deletes it with COLLECTED and a random 32-byte proof (reopens O-1).
- **SYB-3** (major, chat): One neighbour that sends WANT-TAGS for all 256 prefixes becomes the only route for every routed frame, at the sender and at every relay it touches.
- **SYB-5** (major, chat): Fresh-signer chat-key records evict every contact's key from the 4,096-entry FIFO cache.
- **SYB-6** (major, chat): One shared 8 KiB-per-day Bloom filter saturates under accepted spam and then drops the first message of every new sender.
- **SYB-7** (major, chat): A neighbour can stop a frame propagating by resending it first with the hop byte at the limit.
- **SYB-8** (major, chat): Per-neighbour relay queues are fair only on drain; one hostile source keeps a queue full and honest sources are dropped at admission.
- **SYB-9** (major, chat): tagRoutes grows without bound from unstamped WANT frames.
- **UX-14** (major, chat): Chat is off again after every page load, so the person must re-consent each visit and receives nothing until then.
- **UX-6** (major, chat): Drop-in chat panel shows '?' as the author of every Lobby message. (the service side)
- **HON-3** (major, docs): PRIVACY says sites declaring an EEA, UK or Quebec audience turn chat and records on only after both assessments; nothing enforces or checks this.
- **HON-4** (major, docs): FAQ says the project publishes an identity page and a per-release hash; no default identity origin exists and nothing publishes the hash. (one checklist search is a request)
- **PHISH-4** (major, identity): Restore replaces the person's identity with no unlock, no warning and no check; any page can open the restore screen (IdO/#restore); an attacker's backup file also gives the attacker the vault key.
- **PHISH-6** (major, identity): Any site can mark its own key as 'owner' with create:true, which exempts it from 'Replace my keys on all sites' for good.
- **PHISH-9** (major, identity): In the redirect transport the origin on the card, in the signed proof and in the approval record is whatever the page wrote into the URL fragment.
- **PRIV-4** (major, identity): The sign-in popup from a drop-in page sends the site's origin as Referer to the identity origin's operator, and the register does not say so.
- **SCALE-3** (major, identity): A record sync writes up to 32 appends plus 32 tombstones against the 30-per-10-minute author throttle; records within the advertised 31,403-byte limit never sync.
- **SEC-2** (major, identity): Redirect transport lets any page drive state-changing IdO flows for any origin, erase included.
- **SEC-3** (major, identity): Restore overwrites an existing identity and its vault, reachable from any site through #restore.
- **SEC-4** (major, identity): Device link cannot carry a vault that the vault cap allows.
- **STALK-5** (major, identity): The optional 'extra word' that every document names as the defence against a leaked phrase cannot be set when an identity is created.
- **STALK-6** (major, identity): The identity page's home (Settings) lists every site, same-identity link, hub choice and the check code to anyone who opens it, with no unlock.
- **UX-12** (major, identity): The hub-identity box starts unchecked on social hubs, and an unticked first sign-in is recorded for good.
- **UX-4** (major, identity): A rejected recovery phrase wipes what was typed, and the error says to check words that are no longer shown.
- **UX-9** (major, identity): Identity page cards move no focus: each step drops keyboard and screen-reader users at the top of the document.
- **GATE-1** (major, loader-pointer): A refused publisher-key change is permanent: no way to accept the key later except Forget this site.
- **PTR-4** (major, loader-pointer): Downgrade by link: on hubs and doors the seq floor and pin are per version, DoH is first-answer-wins, and the stated cover for the missing minSeq ('withdrawal expiry and two-source disagreement') does not exist. (in the code; the document claim is a request)
- **PTR-5** (major, loader-pointer): The first-visit rotation delay (MF-28) is unreachable: presentOwnerChange runs only when r.rotated or r.keyChanged, both false on a first visit.
- **PTR-9** (major, loader-pointer): Signed hub and door links contact their ws=/xs=/org= hosts before the visitor clicks the gate.
- **MAL53-6** (major, loader-ui): A fetched file torrent accepts up to 10 MB of metadata from any peer and WebTorrent builds 500,000 pieces before validateFileTorrent can refuse it. (the lane wiring is request R6)
- **SCALE-14** (major, loader-ui): Moderator approvals past modAllowPerDay or the 1,000-key allow cap are written and reported as accepted, but have no effect.
- **UX-1** (major, loader-ui): Header Sign out and Remove stop working for the session once any card has shifted the header.
- **UX-11** (major, loader-ui): SDK error codes with no sentence reach visitors as 'Something went wrong (E_CAP).'.
- **UX-13** (major, loader-ui): The privacy consent card, notice and settings panel are English-only while the sign-in cards are French. (the boot copies are request R7)
- **UX-2** (major, loader-ui): Retrying any card after an error status is always cancelled as a redress attack.
- **UX-3** (major, loader-ui): The redress 'Cancelled' notice never goes away and covers the bottom of the site.
- **MAL53-4** (major, media): Takedown is evaded by re-listing the same bytes under another name without a sha256: the infohash contains the display name and the content hash is optional and never computed.
- **MAL53-5** (major, media): Listing caps are enforced only by the uploader's own client: one state-valid forged listing makes every honest upload fail with E_LIMIT.
- **MAL53-7** (major, media): The second-confirmation tier is a deny-list with gaps: LNK, ISO, CAB, OneNote, CHM, AppleScript, HTML and SVG save with no confirmation and unchanged names.
- **PRIV-5** (major, media): TIFF, DNG and other camera RAW files, AVI and MP3 files are published with their metadata untouched.
- **SCALE-13** (major, media): The files storage budget (50% of what remains, LRU) is not enforced: mw-files grows without bound, and own public uploads are orphaned after a reload.
- **STALK-10** (major, media): MP4/MOV metadata removal is a deny-list: vendor uuid boxes (inside moov or top-level), free/skip payloads and all recording times survive into public and private uploads.
- **SYB-13** (major, media): The per-author listing cap exists only in the uploader's own client, and premoderation lets one accepted listing or one accepted infohash unlock the rest.
- **PTR-7** (major, tools): publish --withdraw signs withdrawals without nx=, so a site that committed to a next key cannot be taken down on returning visitors' devices.
- **SCALE-10** (major, tools): The open tracker's 10,000-swarm limit is one shared pool that a single socket can fill; v0.3 needs open mode (SCALE-2) and then every new file, group or lane swarm is refused.
- **SCALE-2** (major, tools): The tracker setup DEPLOY recommends refuses every v0.3 lane, file and media infohash; only an open tracker works, and e2e tests only that.
- **SEC-5** (major, tools): Door-kit verification with --allow-extra accepts host configuration files that change what is served.
- **SEC-6** (major, tools): verify-release accepts an older signed release (rollback) and never shows the version. (the checklist part is request R-SEC-6)
- **SUP-5** (major, tools): The signed release list is consumed only by door kits; publish, ship and the CI template never verify the loader they serve.
- **MAL53-13** (minor, chain): The mw.files schema accepts a ws web-seed URL from any writer over plain http and at private or loopback hosts; no reader uses it yet, but the web-seed rules for unsigned sources will not cover it.
- **MP-11** (minor, chain): Fast-path wants made from a HELLO have no per-peer cap: one wire keeps the 8,192-want table full and honest announcements are dropped.
- **DS-8** (minor, chat): Clock skew: a sender a few minutes ahead loses everything sent just before UTC midnight; fullDay maps day+1 to yesterday; calls accept only +/-60 s.
- **DS-9** (minor, chat): 30 s ACK timeout is shorter than the worst-case ACK round trip (20 s delay plus relay jitter), so live-delivered messages also get held.
- **HUB-8** (minor, chat): COLLECTED deletes held mail on any 32-byte proof: one wire wipes a holder by asking for the 256 prefixes and collecting what it is handed.
- **MP-13** (minor, chat): Room messages are not deduplicated by (author, id) at the service, so once the 20,000-entry relay seen-set is flushed a signed message can be replayed into every lobby for its 5-minute window.
- **SEC-10** (minor, chat): Privacy decoys and jitter default to Math.random.
- **SYB-16** (minor, chat): Group invites from any accepted contact are adopted without a prompt and without a cap on groups.
- **SYB-17** (minor, chat): One forged HOLDING makes the outbox mark a message 'handed' and never send its hold copy.
- **CONF-4** (minor, docs): ARCH 15.12, the list of new signing prefixes, leaves out prefixes the built code signs with.
- **CONF-5** (minor, docs): Domain prefixes missing from the 15.12 list (mw-vault-gone-v1 recorded nowhere but INTERFACES).
- **HON-10** (minor, docs): Sharing rates and caps in FAQ and WHY are from before C2 (128 KiB/s phones, 1 MiB/s desktop, 'no cap on bytes per day').
- **HON-11** (minor, docs): PRIVACY's device-storage table still says a posting key is created at ledger open and exported from Settings; 0.3.0 makes no key for a guest.
- **HON-13** (minor, docs): PRIVACY says the Echo lane re-shares files you opened; SECURITY-MODEL says fetched files are never re-seeded. The code does each for a different lane.
- **HON-14** (minor, docs): README used a word the project's wording rule excludes as a heading; it now says "site ledger".
- **HON-8** (minor, docs): 'An offer or an answer uses the 16,000-byte bucket' is wrong: SIG frames use the smallest bucket that fits. (fixed in the docs fixer's files)
- **HON-9** (minor, docs): Held envelopes are documented as stored in IndexedDB for up to 7 days; the Holder is memory-only and empties when the tab closes.
- **SCALE-16** (minor, docs): WHY.md's 'the default 8 MiB ledger holds about 8,000 to 14,700 likes' ignores the v0.3 reserved pool, so open sites hold a quarter of that from visitors.
- **SEC-11** (minor, docs): Prefix registry misses several signing and AAD purposes in use.
- **UX-19** (minor, docs): 'npx felinar seed' failure tells the owner to run npm install node-datachannel, which npx cannot use.
- **UX-15** (minor, examples): Guestbook shows developer error messages for codes missing from its table.
- **UX-16** (minor, examples): Guestbook and members chat show a self-chosen name without the short id.
- **HUB-9** (minor, identity): The identity origin's host receives the opener's origin as Referer on a cache-miss popup load from a widget page; the privacy register says it sees only IP address and time.
- **PHISH-11** (minor, identity): The statement is shown on the genuine identity card before it is validated: 1200 characters, newlines and bidi controls appear, and the passkey prompt comes before the refusal.
- **PHISH-12** (minor, identity): The identity page has no runtime frame check, and its Settings screen wipes the identity with one confirm and no unlock.
- **SEC-9** (minor, identity): verify: forged proofs can fill the used-nonce store, after which valid sign-ins fail as 'replay'.
- **PTR-13** (minor, loader-pointer): PTR A10 is marked mitigated ('not used for a device's first lookup') but the page's mw-doh override is passed to every lookup, the first included.
- **PTR-14** (minor, loader-pointer): The 'not answering' banner says 'The owner lists:' over doors that came from a link's unsigned #mwd= hints and from the last-good memory, and offers them as navigation.
- **MP-10** (minor, loader-ui): Every bitfield, have-all or have-none message recounts the remote's pieces (O(pieces)) with no rate limit.
- **MP-14** (minor, loader-ui): Unverified 'complete' bitfields drive the copy deficit that orders the echo and keep lanes, so lying peers can push an item to the back of every honest seeder's plan.
- **MP-15** (minor, loader-ui): Super-seeding (flag off by default) starves every real wire while a never-completing 'pin wire' is connected.
- **UX-17** (minor, loader-ui): Loader cards do not return focus to where it was after they close.
- **UX-18** (minor, loader-ui): The iOS settings hint tells v0.3 visitors to 'export your identity here', and no such control exists.
- **HUB-10** (minor, media): A moderator's _deny entry stops new fetches and seeds only; a tab that is already seeding the file keeps serving it until it is closed.
- **MAL53-11** (minor, media): No storage budget for file and media stores: the 50 percent / LRU rule of the caps table is not built.
- **MAL53-12** (minor, media): Name cleaning lets invisible filler characters and trailing dots through, so the claimed extension can be pushed out of view or hidden.
- **MAL53-9** (minor, media): stripMp4 keeps every box it does not know: GPS text in uuid, free or skip boxes survives while the card says location was removed.

- **Finished by the integrator of the round** (the fixers left them in part or rejected them because the files were not
  theirs; [docs/deviations/review-round-integration.md](docs/deviations/review-round-integration.md), section 2): STALK-3
  (private follows reach the lane, and a page holds only its signed-in owner's ledger in full), UX-5, UX-7, UX-8, UX-10,
  UX-20, SUP-7, DS-4, SCALE-6 (the hub lane joins as swarm kind `'hub'`), SYB-12, HON-5, SCALE-15, MAL53-10, STALK-12, CONF-1,
  HUB-12, PTR-12, DS-10 and SYB-18.
- **Fixed in part** (each note says what is left and where it went; an id counts here when any part of it is open): HON-2,
  HON-6, HON-7, HON-12, SCALE-9, SYB-11, CONF-2, CONF-3, HUB-5, SCALE-11, DS-2, PRIV-2, PRIV-3, STALK-2, STALK-7, STALK-9,
  HON-1, STALK-11, PRIV-6, SCALE-5, PTR-10, PHISH-1, HUB-3, PHISH-3, PHISH-5, PHISH-8, PHISH-10, SUP-6, PTR-6, PTR-8, PTR-11,
  PHISH-7, SCALE-7, SCALE-12, MAL53-3, SUP-1, SUP-2, SUP-3, SUP-4, SUP-9, SUP-10, SUP-11, SUP-8, SUP-12 and SUP-14 (45; the CK
  policy of STALK-2 and PRIV-2 is the loader's default since the integration, and their stable Noise static is left; the pin
  page host and the pin node's queue check MAL53-3's `_deny/` since the extra wave after verifier round 1, and the pin node's
  own process check is left).
- **Rejected as minor or deferred** (each note gives the reason): MP-12, SCALE-4, SYB-19, CONF-6, GATE-2, HUB-11, PHISH-13,
  PRIV-7, SEC-8, MP-9, STALK-13, MAL53-8 and SUP-13.
- **Tests**, as run on 2026-10-24 by the integrator of the review round
  ([docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md), "Review round R 5.3 (2026-10-24)"): `npm test` 2,281 tests, 2,272
  passing and 9 `todo`, none failing (lint-floor clean, 147 files; the 9 `todo` cases become tests when the tools requests
  R-SUP-* for `.npmrc`, the workflows and the documents land); `npm run test:browser` 42 tests, 41 passing and 1 skipped (the
  v0.1 worker test) after `npm run build`, on a second run (the first had one WebKit failure, the door view reading
  `module: undefined`, which did not come back); `npm run test:example` 186 tests, all passing; `npm run test:fuzz` 30,000
  inputs, no violation. The three end-to-end suites ran at the same time: `npm run test:e2e` 101 of 102 scenarios in
  Chromium 156, `npm run test:e2e:webkit` 106 of 107 (the 102 and 5 in WebKit 27.2) and `npm run test:e2e:firefox` 137 of 140
  (the 102 and 38 in Firefox 157.0, all 38 passing). Run alone after them, E-SO-7, E-MD-6 and E-CH-5 passed and E-SO-9 failed
  again, so the counts are 101 of 102, 107 of 107 and 139 of 140. E-SO-9 (ADA's post written offline is in the app's data,
  but the timeline shows "1 new post" instead of it) failed in the Chromium and Firefox runs and alone, and passed in the
  WebKit run; its cause is not found. Every end-to-end run ended with its network policy check passing (every request
  stayed on 127.0.0.1).
- **Tests after verifier round 1** (2026-10-24, 08:28 to 09:30 ET;
  [docs/deviations/review-round-verify-1.md](docs/deviations/review-round-verify-1.md)): E-SO-9's cause was found and fixed (the
  social app's timeline kept its old top when an offline write resolved before the data layer's change), and so was E-SO-2's
  intermittent miss (a hub lane that joined while the consent card was open never started). `npm test` 2,286 tests, 2,277
  passing and 9 `todo`, none failing; `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-9` passed 5 of 5 three
  times in a row and `--only E-CH-7` 3 of 3, each run ending with the network policy check passing. A fresh clone installed
  with `npm ci` (install scripts off, so no native WebRTC binding) runs `npm test` with no failure: 2,281 tests, 2,272 passing,
  9 `todo`. No full end-to-end suite and no `npm run test:browser` ran after these fixes.
- **Extra wave after verifier round 1** (2026-10-24, 09:39 to 09:44 ET;
  [docs/deviations/review-round-verify-1.md](docs/deviations/review-round-verify-1.md), "Extra items"): the link scheme and
  the door kinds took the new name (the section "Renamed to felinar" above), and MAL53-3 gained its pin side: the pin page
  host leaves an item it already holds when a later `_deny/` entry names it, and the pin node's queue quarantines a denied
  item when it accepts or restores it; the left item's bytes leave the pin's browser profile. MAL53-3 stays fixed in part:
  the pin node's own process has no deny check (it asks the page host). `npm test` 2,290 tests, 2,281 passing and
  9 `todo`, none failing; the door rows in Chromium and WebKit (4 of 4) and in Firefox (4 of 4), each run ending with the network policy
  check passing.
- **Tests after verifier round 2** (2026-10-24, 10:16 to 10:47 ET;
  [docs/deviations/review-round-verify-2.md](docs/deviations/review-round-verify-2.md)): test changes only. The example composer
  test waits for the composer to clear, since the own post now shows before the write resolves; E-SO-4 makes the follows it
  needs when E-SO-3 is not in the selection; and E-SO-9B, a post written offline reaching a follower once the network returns,
  passes now that its author signs in again after the offline reload (a signed-out page holds nothing on the hub lane), so
  E-SO-9 counts as written. `npm test` 2,291 tests, 2,282 passing and 9 `todo`, none failing; `npm run test:example` 186 tests,
  all passing; `node test/e2e/run.mjs --only E-SO-1,E-SO-2,E-SO-3,E-SO-4,E-SO-9` 5 of 5 three times in a row,
  `--only E-SO-1,E-SO-2,E-SO-4` 3 of 3 three times and `--only E-SO-9,E-SO-9B` 2 of 2 three times, each run ending with the
  network policy check passing. No full end-to-end suite and no `npm run test:browser` ran after the fixes of either verifier
  round until the final full runs below.
- **Final full runs** (2026-10-24, 17:29 to 18:02 ET, verifier round 3, on the final tree;
  [docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md), "Final full runs"): `npm test` 2,291 tests, 2,282 passing and
  9 `todo`, none failing (lint-floor clean); `npm run build` and `node build.mjs --check-lock` passing; `npm run test:browser`
  42 tests, 41 passing and 1 skipped (the v0.1 worker test); `npm run test:example` 186 tests, all passing; `npm run test:fuzz`
  30,000 inputs, no violation; `npm run build:idp` passing. The three end-to-end suites ran at the same time: `npm run test:e2e`
  101 of 102 scenarios in Chromium 156, `npm run test:e2e:webkit` 105 of 107 (the 102 and 5 in WebKit 27.2) and
  `npm run test:e2e:firefox` 140 of 140 (the 102 and 38 in Firefox 157.0). E-MD-6 (in the Chromium and WebKit runs) and E-CH-5 (in the WebKit run) missed a 30 s or 20 s wait under
  that load and passed when run alone right after, so the counts are 102 of 102, 107 of 107 and 140 of 140. E-SO-9 passed
  in all three runs. Every end-to-end run ended with its network policy check passing (every request stayed on 127.0.0.1).

### Changed for domain independence (2026-10-25)

- **No DNS-over-HTTPS lookup for hosting-platform names** (IND-10): the loader and `check-site` no longer ask Cloudflare, dns.sb
  and Google for `_magnet.<name>` when the name is, or is under, `github.io`, `gitlab.io`, `codeberg.page`, `pages.dev`,
  `workers.dev`, `netlify.app`, `vercel.app`, `surge.sh`, `trycloudflare.com` or `ts.net` (`NO_TXT_SUFFIXES`,
  `src/loader/doh.js`): no user can publish a TXT record there, so the lookup only sent the site's name and the visitor's IP address
  (for `ts.net`, a private machine name). The page tag is the only pointer on those names. The consent recipients are unchanged.
  The list is an inference; the owner checks each zone with `dig` before the release.
- **Guard on the vendored WebTorrent defaults** (IND-11): `test/unit/bundle-defaults.test.mjs` fails if `private: true` or the
  explicit `rtcConfig` (or `tracker: false`) leaves `src/loader/torrent.js`, and records the Google and Twilio STUN servers and the
  trackers the bundle carries, so a vendor update that changes them fails until reviewed.
- **`init` derives no contact address** (IND-12): with `writers=open` on a nip.io, sslip.io or IP-address scope the abuse-contact
  question has no `mailto:abuse@<scope>` default (nobody receives mail there, and it would be signed into the pointer); the owner
  types an https: page or a mailto: address. Named scopes keep the default.
- **The project owns no name and runs no service** (IND-1, IND-4): owner decision N-2 is decided as "none" for 0.3.0, so
  by design the project hosts no identity page (the release carries it as `felinar-0.3.0-idp.zip`; run your own or use one
  you trust), and 0.3.0 runs no hosted homepage demo (`DEMO_DOMAIN` is empty in the checklist; the free route, a repository
  named `<owner>.github.io`, is an option of its section 12). HON-4 (`test/unit/docs-review-round.test.mjs`) now pins the
  "by design" wording in six documents and refuses the old "yet" wording.
- **Security reports without a mailbox** (IND-2): [SECURITY.md](SECURITY.md) sends reports to GitHub's private
  vulnerability reporting, with a public issue that asks only for contact as the fallback; `SECURITY-KEY.asc` was
  regenerated with a user id that names no address (fingerprint `4C44 C2A8 D935 27B7 4C88 1E20 A46F 0FB0 E1F8 0C26`).
- **The release key is pinned in the tools, and no DNS record carries it** (IND-3): step 3b of the checklist writes the key
  into `PINNED_RELEASE_KEYS` of `tools/verify-release.mjs` before the squash, and the places to compare it with need no
  domain: the annotated tag message, `release-key.txt` with its OpenPGP signature, and an archive copy of SECURITY.md.
  `verify-release`'s own messages and the workflow comments now name those places.
- **No project domain can come back** (IND-5): `test/unit/docs-domain-free.test.mjs` and the gate line of step 5b refuse
  any tracked text that names a felinar domain at a top-level domain (the `felinar.mjs` file names do not count).
- **The signed hash lists are the anchor** (IND-6): `verify-release verify` accepts a copy from any mirror, door, torrent or
  USB stick, offline, just as it accepts a download from GitHub; `gh attestation verify` is extra evidence for a GitHub copy.
  The release notes carry the sha256 of each zip and of the package and the identity page's build id and bundle sha256. The
  owner signs only a list that equals his own build of the tag (`sign --rebuilt`) and verifies with `--expect-version`
  (request R-SUP-3 of the review round, applied).
- **Who a site depends on, each with its replacement** (IND-7): the "What you need" table of
  [docs/DEPLOY.md](docs/DEPLOY.md) gains a "Replace it with" column and rows for the identity origin, the name, the
  certificate authority and the code at deploy time. `ship` (string Z1) says the name is free but the server is rented
  under an account; an identity page on an IP address keeps identities through the passphrase card and loses only
  passkeys; a subdomain hub needs a domain its operator owns.
- **Doors first** (IND-8): the README, QUICKSTART, FAQ and DEPLOY ("Doors without a domain") lead with the light link and
  its QR code, and name three doors that need no purchase; a guest door gives a per-visit identity only.
- **Identity hosting without a purchase** (IND-9): DEPLOY ("Hosting it without buying a domain") lists free identity hosts
  with their costs and the rule for moving: passkeys stay with the old host, the 12 words restore the public identity and
  the backup file restores everything. SZ-3 is accepted: the signed address record lives 399 days, and a reminder file is
  planned for 0.3.x.
- **`check-site` gives the right reason for a hosting-platform name** (the integration): "is on a hosting platform where no
  user can publish a TXT record" instead of "is not a public DNS name".
- **Tests**, as run on 2026-10-25 by the integrator of the independence round (10:00 to 10:30 ET;
  [docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md), "Independence round"): 23 new unit tests (9 for the code rows, 14
  in `test/unit/docs-domain-free.test.mjs` and `test/unit/verify-release-anchor.test.mjs`), and HON-4, MF-09, Z1 and the
  check-site case extended. `npm test` 2,314 tests, 2,306 passing and 8 `todo`, none failing (lint-floor clean); `npm run build`
  and `node build.mjs --check-lock` passing; `npm run test:browser` 42 tests, 41 passing and 1 skipped, on a second run (the
  first run's WebKit door view read the module result too early once and passed alone three times); `npm run test:example`
  186 tests, all passing; `npm run test:fuzz` 30,000 inputs, no violation; `npm run build:idp` and `npm pack --dry-run`
  passing; a fresh clone passes `npm ci`, `npm test` and `npm run build`. The three end-to-end suites ran at the same time:
  `npm run test:e2e` 102 of 102 in Chromium 156, `npm run test:e2e:webkit` 106 of 107 in WebKit 27.2 and
  `npm run test:e2e:firefox` 140 of 140 in Firefox 157.0. E-MD-6 missed a 30 s wait in the WebKit run and passed alone right
  after, so the counts are 102 of 102, 107 of 107 and 140 of 140. Every end-to-end run ended with its network policy check
  passing (every request stayed on 127.0.0.1).

### Known gaps

- **The screen-share step of the WebKit calls test runs only on macOS.** On the Linux CI runner, Playwright's headless WebKit refuses
  `getDisplayMedia` even from a trusted click, so that test checks the whole call there and skips the share (`test/unit/calls-browser.test.mjs`). The same runner's WebKit asks for a video
  without a Range header first and seeks with Range after; the two media checks of the example tests accept that pattern on Linux only.
- **Not run:** every real-device row, 0.2.1 and v0.3 (iOS Safari and Home Screen apps, Android Chrome, passkey PRF across
  synced devices, media playback on an iPhone, the device link by camera, the comprehension test G-ID-9); Firefox, Safari
  and Edge outside the automated harness; any public network. Only the desktop parts of G11, G12, G13, G14, G19 and G-CH-8
  ran, in a Brave browser on loopback ([docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md)). In Firefox, the harness leaves
  out F:E-SO-2 (its "Follow by link" click does not complete within 30 s in Firefox 157.0), and the identity, chat, media
  and social rows lanes are Chromium only ([docs/deviations/firefox.md](docs/deviations/firefox.md),
  [docs/deviations/review-round-integration.md](docs/deviations/review-round-integration.md)).
- **New cryptographic code without the outside review** that R 2.19 requires before 1.0: Noise XX, the sealed box,
  `p256.js` and the plain JavaScript Argon2id. `p256.js` is not constant time (it runs at the identity origin, on the
  person's device). Argon2id at 64 MiB took 1,286 to 2,541 ms on an Apple M3 in the idcore lane's runs, where R assumed
  about 0.1 s.
- **4 of the 64 end-to-end rows of R 4.2 are open, and 12 ran in part**
  ([docs/deviations/integration-v03.md](docs/deviations/integration-v03.md), the R 4.2 table): E-FI-4 (a phone's memory
  bound is not measurable in the harness; real-device row G-MD-5), E-SO-5 (no browser holds the tool-made ledgers on the
  hub lane: a page holds only its signed-in owner's ledger in full, and the scenario's seeders open those pages as readers;
  it failed again when run alone on 2026-10-24), E-SO-10
  (`mw.hub.withdrawPage()` does not exist) and E-SO-13 (the directory stays off pending counsel; no lawyer is engaged for 0.3.0). A post written offline reaches a follower
  once the network returns only after its author signs in again, when "Stay signed in" was off (E-SO-9B; a signed-out page
  holds nothing on the hub lane). Among the partial rows: the keyboard-only direct message of E-SO-12 is not scripted; the hub lane's merged
  first screen (E-SO-6) and `mw.mod.requestJoin` (E-SO-7 runs over direct-message grants) have no complete contract.
- **Not built** (marked "(proposed)" in the specification): the reader for durable grants (`durable: true` sends over chat
  only), the hub's first screen from `cs=` snapshots, shards above 1 for the hub lane (it joins with a swarm kind of its own,
  `'hub'`, since the review round), and the kill switch's purge mode. The social template names four SDK gaps:
  `mw.hub.withdrawPage()`, `mw.mod.requestJoin(group)`, `mw.site.info().pointer`, and a way for a followed page to say
  "withdrawn" or "removed by the hub"; `files.fetch` with `{ ledger }` is missing too.
- **Stalking mitigations of the design that are not built** (review round, 2026-10-24): a new ledger block, a visitor's own or
  relayed, goes to every ledger neighbour, after a random delay since the review round's STALK-8 fix (0.5 to 3 s for a
  local block, up to 1 s for a relay) but with no random subset (STALK A3 for blocks; chat frames have both); wire caps count wires, not address prefixes, and the chat lane id is public, with no members-only option (A4); no
  announce delay follows a sign-in, only the 0 to 1.5 s join jitter of the ledger rendezvous (A7); the page tag's DNS-over-HTTPS
  check keeps its interval (the record's TTL, at least 5 minutes) while the tab is hidden (A11); nothing hints that a display
  name is reused on other sites (A12).
- **Left open by the review round** (2026-10-24; every partial and rejected finding, with its reason, is in its fixer's note
  in `docs/deviations/review-round-*.md`): 14 of the 136 blockers and majors were not verified by the refuters before the
  session limit; in shell mode the device key that signs the saved pointer record stays usable by same-origin code, so
  its pins catch accidental edits only (PTR-11, an architecture change); a hub page you sign in to can post as you on
  every page of that hub, because the page-owner key and the member key are not split yet (HUB-3, PHISH-1); after an owner
  checkpoint, copies prune covered blocks at once and the wire has no frame that carries the checkpoint state (DS-2); the
  seeding month cap counts per site, not per hub (SCALE-12); of the supply-chain findings, SUP-1 to SUP-4, SUP-6 to SUP-12 and SUP-14
  are fixed in part (install scripts, the release checks and the second pin of the release key among them). Measured in E-CH-10: the 5 s bound for a contact
  message under a relay flood holds once the relay has the recipient's WANT-TAGS route; a first message before that
  reaches a random half of the relay's neighbours and otherwise waits for the 30 s acknowledgement timeout or the 60 s
  outbox retry ([docs/deviations/rows-chat.md](docs/deviations/rows-chat.md)).
- **Fuzz targets** exist for the ledger, pointer, sign-in, files and chat-frame parsers only (`test/fuzz/targets/`). The Noise
  handshake, the sealed box and sealed items, the media chunk format, MP4 and WebM rewriting and image sniffing have none.
- **Settings that change nothing yet:** `_mw.cfg.age` is written by the tools and checked for shape, but no code reads it, so an
  age method changes no default; a declared EEA, UK or Quebec audience (`--aud`) changes only the consent gate, and no tool
  asks for the impact assessments before chat or synced records are turned on.
- **The hub pin** keeps one site (the URL it is given) and writes that site's `cs=` snapshot; it does not follow a hub's members
  or keep their ledger windows, and it holds at most 2 GiB of approved files in all by default (`PIN_LIMITS.maxTotalBytes`;
  `pin --max-total` changes it since the review round's integration).
- **Seen end to end, not fixed:** on a hub label the identity origin's sign-in card says "This address is not one of this
  site's addresses."; "Create my page" right after signing in is refused for 10 s (the card cooldown); "Follow by link" is
  offered only while the timeline is empty; a second tab's sign-in shows the `E_POLICY` sentence; block times are rounded
  down to the minute, so posts within one minute are ordered by hash. E-MD-4 (a private video played with a seek) fails
  now and then with "no loadeddata", and E-MD-3 and E-MD-5 with it because they need it: in two of the full end-to-end
  runs of 2026-10-21 (once in a `--webkit` run, once in a Chromium run while another build ran), each time passing again right after;
  the cause is not found. With three end-to-end suites running at once on one machine, E-MD-6 and E-CH-5 can miss a wait E-CH-5 also missed once when run right after E-CL-1 in a single `--only` run (2026-10-26), and passed 3 of 3 by itself.
  (the final full runs of 2026-10-24: E-MD-6 in the Chromium and WebKit runs, E-CH-5 in the WebKit run; the independence
  round of 2026-10-25: E-MD-6 in the WebKit run) and pass alone.
- The drop-in bundle `_mw/mw.js` was 738,816 bytes in the sdk lane's build and 859,284 bytes (275,547 with `gzip -9`) in
  the build of 2026-10-21 (the services are inlined; no code splitting).
- The social directory stays off until a lawyer has looked at it (none is engaged for 0.3.0), and the owner's sign-off of the decisions of R 1.5 is not
  recorded (docs/PUBLISH-CHECKLIST.md, section 16.1).
- The LAN tier of the demo (`felinar demo --tls`) serves no identity page, so a post there fails: phones on that tier
  read and share, and post through the desktop tier over USB.
- **Domain independence** (2026-10-25, [docs/deviations/independence-integration.md](docs/deviations/independence-integration.md)):
  the places to compare the release key with (the tag message, `release-key.txt` with its OpenPGP signature, an archive
  copy of SECURITY.md) protect against a takeover of the GitHub account after a release, not against the owner, who
  controls all of them, and the OpenPGP key comes from the same repository; 0.3.0 is the first release, so no earlier
  release carries the key. The two `gpg` lines of step 10b have not run. Private security reports depend on GitHub alone
  until a second, project-only route exists (owner decision O2). The list of hosting-platform names that skip
  DNS-over-HTTPS is an inference until the owner checks each zone with `dig`. `tools/seeder.html`, an owner-side page, still
  builds its WebTorrent client with the bundle's default STUN servers and trackers (0.3.x, L-14).
- By design, the project hosts no identity page: owner decision N-2 is decided for 0.3.0 as "none"
  (docs/PUBLISH-CHECKLIST.md, section 16.6). The release carries the page as `felinar-0.3.0-idp.zip`; run your own or use
  one you trust. Until a site names one (`publish --idp`, `<meta name="mw-idp">`), sign-in on it fails with
  `E_IDP_UNREACHABLE` ("no identity page is configured for this site"), so its visitors cannot sign in to write.
- `felinar` and `@felinar/verify` are on npm, published by hand, so neither carries npm provenance (no workflow
  publishes to npm). `build` and `demo` still need a clone of the repository, and a server can copy
  `packages/verify/verify.js` instead of installing the package ([docs/recipes/signin-server-node.md](docs/recipes/signin-server-node.md)).

## 0.2.1 - never published; superseded by 0.3.0

Never tagged or published. The red team of the v0.3 design review found seven defects in it that work today (MF-27,
MF-28, MF-30 and MF-73 to MF-76; docs/PUBLISH-CHECKLIST.md, section 0), so 0.3.0 is the first public release: it fixes
MF-27, MF-28 and MF-73 to MF-76, and MF-30 in part (its signed `minSeq` is proposed). This entry stays as the record
of what the 0.2.1 work added and changed; 0.3.0 carries all of it except what the 0.3.0 entry above lists as breaking.
The release gate on real devices never ran for it.

### Added

- Shell mode (per domain): a static loader that resolves a signed pointer, downloads the site by infohash over
  WebTorrent from other visitors and from an HTTP web seed, and serves it through a Service Worker at the
  site's own URLs, inside a same-URL iframe. Returning visitors load saved sites from their browser.
- Drop-in mode: one script tag under an existing static site's own pages. The host keeps serving every HTML
  page; after the first page view the other files come from the visitor's copy.
- The pointer: a signed record (MW-PTR/1) read from a `<meta>` tag, a DNS TXT record over DNS-over-HTTPS, the URL
  fragment or the cache, with the site key remembered on the first visit.
- Seeding while a page is open, under a consent card and a bandwidth policy the visitor controls. Phones are
  download-only unless the visitor opts in.
- The site ledger and the `mw.db` SDK: a signed, hash-linked log that every visitor copies and verifies, with
  owner and moderator control, a hashcash spam fee on each entry, and snapshots on the host. No mining, no
  consensus, no finality.
- A kill switch (`mw-sw-kill.js`) that removes the Service Worker from returning visitors.
- Command-line tools in `tools/`: `keygen`, `publish`, `ledger-admin`, `tracker`, `dev-server`, `demo`,
  `check-site`, `check-webseed`, `pin`, `seed` and `snapshot`, plus `build.mjs`. The `felinar` command
  (`bin/felinar.mjs`) starts any of them with the arguments unchanged: `publish`, `keygen`, `ledger`, `tracker`,
  `dev`, `demo`, `check-site`, `check-webseed`, `pin`, `seed`, `snapshot` and `build`.
- Examples: a shell-mode guestbook (`examples/peer-guestbook/`), an existing multi-page site for drop-in mode
  (`examples/existing-site-dropin/`) and the project homepage (`examples/landing/`), published through felinar
  itself. Each folder holds only its site; the checks live in `test/example/` and `test/fixtures/`.
- Documentation, starting at [docs/README.md](docs/README.md), and a test suite (results below). The architecture and
  the module contracts are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/INTERFACES.md](docs/INTERFACES.md).
- Project files: the MIT License, a security policy, a code of conduct, contribution and governance guides, issue forms
  and a pull request template.
- Deployment templates in `deploy/` (a WebSocket tracker behind Caddy, a pin node image and a GitHub Actions workflow
  for site owners) and the repository's own workflows in `.github/workflows/`: CI on Node 22 and 24 (the suites, the
  reproducible-pack check and the `deploy/` files), a release workflow (it checks the tag, runs the tests and attaches
  the built loader, the npm package and `SHA256SUMS` to a GitHub Release) and a workflow that publishes the project
  homepage to GitHub Pages.

Last run on 2026-10-20 from 00:35 to 00:40 ET, after the last change to the code and the tests (the post-wave fix),
on one development machine (macOS, Node 24.22, loopback networking only;
[docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md)): `node build.mjs` succeeds; `npm test` passes 938 of 938
unit tests after a clean browser-floor lint of 62 files; `npm run test:e2e` passes 25 of 25 scenarios in Chromium in
127.5 s and `npm run test:e2e:webkit` 26 of 26 (with W7, a cold start in WebKit) in 129.5 s, and in both runs no
request left 127.0.0.1; `npm run test:browser` passes 31 and skips 1; the example site's own checks
(`npm run test:example`) pass 29.

### Breaking

Formats were frozen in this release, so data from the internal 0.2.0 build does not carry over (identity files
exported by it carry an untagged key and don't import).

- Public keys are written `p256:` plus base64url everywhere (blocks, the pointer's `owner=`, lists, HELLO, the
  SDK); untagged keys are refused. Ledger ids change, because they hash the tagged owner key. (A2)
- Payload blocks carry a salt `z`, and `vh = sha256("mw-vh-v1\n" + z + "\n" + canonical(v))`, so a deleted entry's
  stub reveals nothing guessable. Unknown operation names are rejected at ingest and not relayed; `checkpoint`,
  `vanish` and `grp` are reserved. (A1, A2)
- `window.mw` no longer has `identity.export`, `identity.import` or `consent.accept`. `mw.consent.request()` opens
  the loader's own card and resolves with the visitor's choice (`pending` if the card is closed without one).
  Export and import live only in the shell's Settings and the drop-in panel's Settings, and both ignore clicks made
  by script. (A4)
- Consent is a versioned record per origin, and v0.2 choices are asked again. Both modes show a first-run card with
  "Share and load" and "Load from host only". An `aud=` that declares personal data or an EEA, UK or Quebec
  audience (or `consent=gate`) forces the gate, and no DNS-over-HTTPS lookup happens before a choice: a page tag
  or a cached pointer loads the site without one, and a site known only through DNS shows the card first. (C1)
- The ledger swarm is the bare rendezvous infohash `sha1hex("mw-ledger/1/" + ledgerId)`. `summary.json` from
  `publish` names it `rendezvousBtih`; `anchorBtih` stays one release as a deprecated alias with the same value. (B2)
- Removed: the v0.1 shared-origin hub flags (the shared-origin hub is a localhost demo or a single-publisher mode),
  the `magnet:` protocol handler in the web manifest, and the one-piece anchor torrent. (C4, F48)

### Deprecated

- `anchorBtih` in the `summary.json` that `publish` writes. It carries the same value as `rendezvousBtih` for this
  release only, so a tracker started from an older summary still admits the ledger swarm. Read `rendezvousBtih`. (B2)

### Changed in the v0.2.1 hardening

Pointer (MW-PTR/1):

- `st=` is fail-closed. Anything but `ok` is a withdrawal: the loader stops sharing the site, deletes every stored
  version and shows the owner's `why=` text. `publish --withdraw` writes one. (A3)
- New signed keys: `aud=` (audience tokens), `ct=` (abuse and legal contact), `lg=` (privacy and terms page) and
  `why=`. A record should stay at or under 450 bytes and must stay at or under 900; `publish` warns and refuses.
  (A3, F4)

Network:

- Tracker connections: an offer-free keepalive announce replaces `scrape` (one public tracker closes the socket on
  `scrape`), a fast reconnect (500 ms plus up to 1 second of jitter, growing on repeated failures) instead of the
  stock 10 seconds to 5 minutes, and a re-announce when the page becomes visible, is shown again or comes back
  online. (B1)
- Web seeds: a circuit breaker (3 failures in 30 seconds mean a 5 minute backoff and a visible message) and a patch
  of the vendored WebTorrent bundle that stops it sending the request headers that force a CORS preflight on most
  hosts. The patch is hash-asserted, so the build fails if the bundle changes. (B3, B4)
- Connections: a length guard on every wire (messages above 256 KiB are dropped before they are buffered), soft and
  hard connection caps per swarm, TURN off, two STUN operators with a probe, and a 1.5 second offer timeout. (B5 to B7)
- Phones: a four-class network classifier, uploads off by default on every mobile class with a per-origin opt-in,
  and a lifecycle plan for hidden pages. (C2)
- Nothing that arrives by fragment, share target or paste loads without an explicit click. (C3)

Serving:

- Every navigation is answered within about 25 seconds (an interstitial while waiting), a reload-loop guard, a
  keep-alive while streaming, and a versioned page and worker protocol. (D1)
- The Service Worker installs atomically (`Request.integrity` for scripts and styles), and navigations fail open to
  the host. (D2)
- Drop-in rule edits: a 40 ms cold-start wait, pages served with `Cache-Control: no-store` run host-only, concurrent
  web-seed downloads are coalesced, no CSP `<meta>` is injected, and the tag is guarded with
  `data-cfasync="false"` and safe to include twice. (D4)

Publishing:

- One verification gate for web seeds with three modes (`check-webseed --mode seed|origin|host`), also used by
  `publish --verify-ws`, `publish --verify-host` and `check-site`. (B3, B4)
- A path policy, budget gates with a printed size report, a lint for secrets and personal data, and `--from-wxr` to
  import approved WordPress comments without e-mail or IP addresses. (E1 to E3)
- Deterministic packing (`--date`, `--double-pack`) with a CI job that publishes each example twice and compares the
  infohashes, a warning for an open ledger without a contact (`--ct`), the `--aud` token list, the drop-in egress
  note, a static `/_mw/sdk.js` stub and `data-nosnippet` on the loader's status elements. (E4, E5, F4, F7)

Documentation:

- A kill switch runbook with the measured recovery time, `Clear-Site-Data` as the last resort, and a drill for every
  release. The review notes on `allowScripts` and the wire test value `0x7FFFFFFF` were corrected. (D3, F8)

### Changed in code review round 1

Four reviews produced 58 findings: 2 critical, 8 high, 22 medium and 26 low. 54 are fixed, 4 are fixed in part and
none was rejected; the open parts are in [docs/ROADMAP.md](docs/ROADMAP.md).

- Site ledger: an owner hand-over now revokes the old key (blocks it signs beside or after the hand-over have
  no owner standing); a second hand-over by the old key is settled by the new owner's endorsement
  (`ledger-admin accept`). At the size cap, gossip remembers refused blocks instead of fetching them again, and
  owner and moderator blocks are still taken. One gossip peer per wire. A local write that IndexedDB refuses leaves
  nothing behind.
- Writes report the progress of the spam fee and can be cancelled: `onProgress` and `signal` on every SDK
  write, the `pow` event, and `write.cancel` when the SDK gives up (`E_TIMEOUT`).
- Pointer: `lo=` names the ledger owner, so a key rotation keeps the ledger; `rot=` v2 is bound to the scope;
  `seq` more than a day ahead is refused; an empty `st=` is a withdrawal; hub labels are domain-separated.
- Loader: hub keyless withdrawals cannot delete signed sites; the gate decision is kept; two tabs across a
  publish both move to the new version; limited mode reloads into its own CSP, supports module cycles and
  keeps `location.pathname`; the site's own viewport on phones; the network class is re-evaluated; gzip
  snapshots are readable without `DecompressionStream`; the web seed probe and the first `.torrent` fetch
  run in parallel.
- Service Worker: `/_mw/ws/` serves the engine only; BEP 47 pad files are answered with zeros; the vendored
  bundle is hash-checked before it is cached; the install precaches only the files of its mode.
- Build and tools: no OPFS cleanup or File System Access polyfill from the vendored bundle; `boot.js` parses
  in pre-ES2015 browsers; no `magnet:` protocol handler in the manifest; tools never launch a remote-capable
  browser for loopback URLs; `check-site` reports a non-root deployment.
- The per-finding table, with the files and regression tests, is in `docs/review/DESIGN-REVIEW.md` (section 7).

### Changed in the post-wave fix

What the release check of the documentation wave found and this release fixes
([docs/deviations/post-wave-fix.md](docs/deviations/post-wave-fix.md)):

- `progress.uploaded` counts only file data sent to other visitors. It used WebTorrent's own counter, which also
  counts the protocol messages a page writes to its web seed's in-memory connection: before any choice, with no
  tracker, peer or STUN contact, the guestbook said "178 B passed on to others". `inspect()` reports `uploaded` in
  both modes.
- The first-run card and the gate name the DNS-over-HTTPS service on every shell or hub page that will ask it for
  updates after the choice, not only on a site found through DNS; a `<meta name="mw-doh">` resolver is named instead
  of the defaults.
- `demo` gives each site folder its own ledger (a chain label kept in `.tools/demo/sites.json`); before, every
  `localhost` demo site had the same ledger id.
- `publish --dropin` writes no `webseed-layout.txt`, and its `csp.txt` names no DNS-over-HTTPS resolver (drop-in pages
  never query DNS). The shell mode `webseed-layout.txt` says the patched client sends only `Range` and no longer
  recommends a managed CloudFront policy that sends no `Access-Control-Allow-Headers`.
- `publish --prev-key` no longer tells the owner to upload `genesis.json` over the snapshot that holds the owner
  hand-over; shell-mode `publish` names the `_redirects` lines the Service Worker cannot apply.
- `ledger-admin` writes a gzip ledger file back as gzip; `snapshot` no longer says gzip needs Safari 16.4 (every loader
  reads it since code review round 1, F20).
- The 13.3x drop-in egress figure is called what research w2a-07 F21 calls it, a model, everywhere.
- Consent (round 3, N1): on a page-tag site, "Load from host only" chosen after a re-ask (the recipients changed) no longer inherits the earlier record's DNS-over-HTTPS permission, so the update checks stop. On a site found only through DNS either choice still allows the lookup that resolves the pointer. Test: `loader-app-consent`.

### Known gaps

- The release gate on real devices has not run. No result is recorded for iOS, Android, Samsung Internet, Firefox
  or any other row of `docs/DEMO-RESULTS.md`. Phone behaviour was checked in Chromium emulation and by CSS checks.
- Firefox did not launch in the test environment. The navigation deadline and keep-alive (D1) are unit-tested and
  tested in Chromium only, and how the floor browsers treat a simple `Range` header is unmeasured, so the web-seed
  gate requires the Range preflight until it is measured.
- Open questions that need a real device: Safari's `FetchEvent.resultingClientId`, first-visit control of the
  iframe in Firefox and WebKit (settled only for Playwright's WebKit 27.2), the iOS `DataCloneError` path for ECDSA
  keys, and 7-day storage persistence on iOS.
- Block keys and list names take any non-empty string (up to 256 and 64 bytes) and stay readable after a delete,
  because they sit in the signed block header. Don't put personal data in them.
- Uploads are rate limited and can be switched off, but there is no byte budget per visit or per day.
- A visitor's posting identity lives in the browser's storage. There is no recovery phrase; the export in Settings is
  the only backup, and storage that the browser clears takes the identity with it.
- No relay (TURN) servers: some visitors, often on mobile data, can't reach peers and load from the host.
- The package is not published to npm (`package.json` has `"private": true`). The `felinar` command runs from a
  clone of the repository, or from the package attached to the GitHub Release (`npm install -g
  ./felinar-0.2.1.tgz`); `build` and `demo` still need a clone.
- The workflows in `.github/workflows/` and the template in `deploy/github-actions/` have not run on GitHub yet, the
  Docker images in `deploy/` were not built, and Node 22 was not tested locally: the first CI run after the push is
  the first real run. Their action pins were set without network access; the owner checks them against the actions'
  release tags before the push (`docs/PUBLISH-CHECKLIST.md`, section 6).
- The product has been run end to end only on one machine with loopback networking. No site has been deployed on a
  real domain with a DNS pointer and opened on real devices. The research probed public trackers, resolvers and hosts
  on their own, and its offload, consent and connection-rate figures are model outputs, not measurements.
- Findings fixed in part in code review round 1 (F13, F36, F39, F53) and the other open items are on
  `docs/ROADMAP.md`.

## 0.2.0 - 2026-10-19

Internal integration milestone. It was never tagged or published. It was the first build in which the unit tests
and the end-to-end scenarios of the v0.2 specification passed together: 675 unit tests, 14 of 14 scenarios (15 of 15
with WebKit), 28 browser unit tests with 1 skipped, and 29 example-site checks (`docs/INTEGRATION-STATUS.md`, 12:30
ET). It replaced the v0.1 design draft (`docs/review/ARCHITECTURE-v0.1.md`), which the design review rewrote.
Data from this build does not carry over to 0.2.1 (see "Breaking" above).

[Unreleased]: https://github.com/ashkanshokry25-maker/felinar/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ashkanshokry25-maker/felinar/releases/tag/v0.3.0
