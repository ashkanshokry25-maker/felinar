# Review round, media fixer

Written 2026-10-24 04:02 to 04:30 EDT (America/Toronto). Brief: the "media" area of the review round (R 5.3): the
serious findings PRIV-5, DS-4, SCALE-1, SCALE-13, MAL53-2, MAL53-3, MAL53-4, MAL53-5, MAL53-7, SYB-13 and STALK-10, and
the minor findings HUB-10, MAL53-11, MAL53-12, MAL53-9 and STALK-13 (`.orchestration/reports/all-findings-2026-10-22.json`,
verdicts in `.orchestration/reports/verdicts-2026-10-23.json`).

An earlier run of this fixer stopped after editing `src/files/lane.js`, `src/files/names.js`, `src/files/preview.js`,
`src/media/sniff.js` and `src/media/strip.js` (checkpoint 4e82be5..3287fbb). `lane.js` called `this._watch()` and
`this._keepPublic()`, which did not exist, so `test/unit/files-c2-handoff.test.mjs` failed. This run finished that change
rather than reverting it: both methods exist now, with the rest of the design the earlier run's header comment describes
(`src/files/lane.js:29`-`37`).

Files edited: `src/files/lane.js`, `src/files/service.js`, `src/files/preview.js`, `src/files/names.js` (earlier run),
`src/media/lane.js`, `src/media/service.js`, `src/media/sniff.js` and `src/media/strip.js` (earlier run, kept as is),
`test/unit/files-validate.test.mjs` (the GIF fixture now carries its first frame), `test/unit/media-review-round.test.mjs`
(new, 16 tests) and this note. No wire, storage or vector format changed. The listing schema is the same, and listings
without `sha256` stay valid. Own public uploads get a new entry in the device's sealed cache (`pub:<ih>`, next to the
existing `file:<ref>` entries, `src/files/lane.js:302`).

## Findings

| Finding | Status | Files | Test |
| --- | --- | --- | --- |
| SCALE-1 (blocker; verifier: major) | fixed | `src/files/lane.js:101`, `:539`, `:668`, `:812` | `media-review-round.test.mjs` "SCALE-1 / MAL53-5", "MAL53-5" |
| MAL53-5 | fixed | as SCALE-1 | as SCALE-1 |
| SYB-13 | fixed | `src/files/lane.js:539` (per-author 20, one row per infohash, the first visible name) | "SYB-13: a hand-written flood shows the author's first 20" |
| SCALE-13 | fixed | `src/files/lane.js:302`-`393`, `:602`, `:729`, `:859`; `src/files/service.js:72` | "SCALE-13: an own public upload is stored as f-<infohash>…", "SCALE-13 / MAL53-11" |
| MAL53-11 (minor) | fixed | `src/files/lane.js:354`-`393` | "SCALE-13 / MAL53-11" |
| MAL53-4 | fixed | `src/files/lane.js:859` (`_verify`), fetch and `_usable` | "MAL53-4: denied bytes relisted…" |
| MAL53-3 | partial | `src/files/lane.js:227`-`300`; `src/media/lane.js:133`-`235`; both services' `destroy()` | "MAL53-3 / HUB-10", "MAL53-3 (media)" |
| HUB-10 (minor) | fixed | as MAL53-3 (files lane) | "MAL53-3 / HUB-10" |
| MAL53-2 (blocker; verifiers: major) | fixed | `src/files/preview.js:73`; `src/media/lane.js:239`, `:732` | "MAL53-2: a GIF whose 1x1 screen…", "MAL53-2 (private media)"; `files-validate.test.mjs` U-FI-3 |
| MAL53-7 | fixed | `src/media/sniff.js:126`-`150`; `src/files/preview.js:155`, `:162` | "MAL53-7: LNK, ISO, CAB…" |
| PRIV-5 (verifiers: major and minor) | fixed | `src/media/sniff.js:60`, `:130`-`136`; `src/media/strip.js:681`, `:765`; `src/files/lane.js:517`, `:581`; `src/files/names.js:61` | "PRIV-5: TIFF and camera RAW…", "PRIV-5: stripMp3…" |
| STALK-10 | fixed | `src/media/strip.js:179`-`300`, `:344`-`345` | "STALK-10 / MAL53-9", "STALK-10: WebM…" |
| MAL53-9 (minor) | fixed | as STALK-10 | "STALK-10 / MAL53-9" |
| MAL53-12 (minor) | fixed | `src/files/names.js:23`, `:25` | "MAL53-12" |
| DS-4 | partial | none (the defect is in `src/loader/torrent.js`) | Request R5 |
| STALK-13 (minor) | rejected | none | minor, deferred (below) |

All tests named above are in `test/unit/media-review-round.test.mjs` unless another file is named.

### What changed, finding by finding

- **SCALE-1, MAL53-5, SYB-13.** The R 2.8.8 caps now hold where honest copies read, not only in the uploader's client.
  - `listingOk` refuses a `len` above 25 MiB (`src/files/lane.js:101`).
  - `_shown()` (`:539`) is the one read path. It counts the first 20 listings per author in ledger order and shows an
    infohash once, under its first visible listing, so a later key cannot rename or retype an accepted file. It leaves out
    hidden and denied listings and another author's pending ones, and it stops at 256 MiB in ledger order.
  - `list()` (`:668`), `_resolve()` (`:812`) and the site total of `share()` all read `_shown()`. A forged listing or
    another key's pending listing no longer blocks an honest upload.
  - The other half of SYB-13 (a relisting of an accepted infohash unlocking its author) was closed in `src/loader/mod.js`
    by MAL53-1 (test `test/unit/review-round-loader-ui.test.mjs`, "MAL53-1: an accepted infohash credits only its own author").
- **SCALE-13, MAL53-11.**
  - The store of a public upload is named `f-<infohash>` at creation (`:602`).
  - The upload's torrent and listing go to the sealed cache (`_keepPublic`, `:302`). After a reload, `restore()`
    (`:729`) finds the bytes again when they are all there (`_fromVaultPublic`, `:317`). The upload re-joins its swarm in
    lane K, at most 8 newest and never a denied one (`_reseedPublic`, `:339`), and `remove()` reaches it.
  - Fetched files live under a storage budget (`_budget`, `:354`). The budget is `deps.filesBudget`, else
    `storageLines().filesMax`.
  - Above the budget, `_enforceBudget` (`:373`) removes the copies least recently used, by fetch, preview or save. It never
    removes an own upload. A file larger than the whole budget is refused with `E_LIMIT`.
- **MAL53-4.** `_verify` (`:859`) always computes the plaintext SHA-256 of a public fetch, listed or not. It checks that
  digest against `_deny/` before anything uses the bytes. A denied digest ends the fetch with `E_DENIED` and deletes the
  copy. A constant `info.name` was not adopted: the verifiers showed it does not make the infohash a function of the bytes
  (`src/files/validate.js:64`-`86` accepts any piece length), and it would change the torrent format.
- **MAL53-3, HUB-10.** One check covers every way into a swarm.
  - Files lane: `_addTorrent` checks `rec.denied`, the infohash, the listed hash and the digest. `preview` and `save` check
    again (`_usable`).
  - Media lane: `_seed` (`src/media/lane.js:133`) checks before upload, open, accept, Keep available and the re-seed after
    a reload. Before, only `onGrant` checked.
  - Both lanes subscribe to the node once (`_watch`). On every ledger change, `denySweep()` checks what this device holds.
  - A denied item stops its handle. A received or fetched item also loses its copy and its kept entry. The person's own
    private media and private files keep their bytes but never seed again.
  - Partial because the pin page host and the pin node are outside this area: Request R4.
- **MAL53-2.**
  - Preview: `imageSize` for GIF walks to the first Image Descriptor and returns max(screen, frame) (`src/files/preview.js:73`).
    A head without a frame gives null, so no preview.
  - Private media: the first chunk of a received picture (the item or its poster) is decrypted and checked in the chunk path
    of the session (`_checkedChunk`, `src/media/lane.js:239`). The check runs before a decoder sees the bytes, so `open()`
    keeps its contract.
- **MAL53-7.** The sniffer now names these formats by their magic bytes: LNK, CHM, OneNote, compiled AppleScript, CAB,
  VHD and VHDX. It reads ISO 9660 and UDF from 0x8001 when it gets 0x8006 bytes; save() passes the 64 KiB head
  (`src/media/sniff.js:126`). Besides those kinds, `riskTier` asks for the second confirmation for 'unknown', html, svg,
  xml and pdf (`CONFIRM_ALSO`, `src/files/preview.js:155`). An owner can still block any of them. Not done: DMG (its
  trailer needs a tail read), and renaming html and svg to .txt on save. The confirmation card covers both.
- **PRIV-5.**
  - TIFF, BigTIFF and the TIFF-based camera RAW formats (DNG, NEF, CR2, ARW, PEF, SRW) sniff as `image/tiff`. ORF, RW2,
    RAF, CRW and CR3 sniff as `image/x-raw`. Both run the image stripper, so a public upload is re-encoded, or refused when
    this browser cannot decode the file.
  - MP3 loses its ID3v2, ID3v1 and APEv2 tags (`stripMp3`, `src/media/strip.js:681`).
  - AVI and WAV keep only the chunks a player reads. Every other chunk becomes JUNK of the same length (`stripRiff`, `:765`).
  - The `file-share` card gets `unchecked: true` when no stripper exists (`src/files/lane.js:581`). Request R2 asks for the
    card to show it.
- **STALK-10, MAL53-9.**
  - MP4 and MOV stripping is an allow-list (`TOP_KEEP`, `MOOV_ALLOW`, `src/media/strip.js:179`). Every other box becomes
    a zeroed `free` box of the same length: any uuid, free, skip, wide, udta, meta and vendor box, at the top level and
    under moov.
  - The creation and modification times of mvhd, tkhd and mdhd become 0 (`removed: 'moov/times'`).
  - WebM also voids Info DateUTC, MuxingApp and WritingApp, Attachments and Chapters, and the SeekHead entries that point at
    them (`:344`-`345`).
- **MAL53-12.** `cleanName` strips the rest of the Default_Ignorable set and the blanks that render as nothing (U+2800,
  U+3164, U+115F, U+1160, U+FFA0, U+180E and others). It drops trailing dots and spaces, and it prefixes the Windows
  device names (`src/files/names.js:23`, `:25`).
- **STALK-13: rejected, minor, deferred.** The listed SHA-256 is what a moderator can deny without opening the file:
  `denyIdsOf` names it (`src/loader/mod.js`, deny path of `decide`). MAL53-4 now relies on digests. Leaving it out by
  default needs a pin node or a web seed host to compute digests for moderators first. That is not cheap and not safe in
  this round.
- **DS-4: partial.** The defect is in `src/loader/torrent.js:2181`-`2195` (`_copies`) and `:2334`-`2350`
  (`_handoffCheck`), outside this area. Request R5 gives the fix.

## Runs

- `node --test` on the area's unit files (`files-c2-handoff`, `media-service`, `files-validate`, `media-strip`,
  `files-serve`, `sw-media-route`, `media-format`, `media-faststart`, `media-review-round`): 101 of 101 pass.
- `npm test` at 04:23 to 04:25 EDT: lint floor clean (147 files). Unit: 2,200 tests, 2,144 pass, 45 fail, 11 todo. None
  of the 45 failures is in a file this note touches. They are in the chat and calls tests (`chat-lane-*`, `calls-*`,
  `call-ui`), `strings-c2`, `docs-links` (a review-round note that THREAT-MODEL.md links to and that does not exist yet), `repo-layout` and
  `tools-install-scripts`, which other fixers are editing at the same time. The first `npm test` of this run, before my
  tests were added, failed in the same places and in the UI card tests (`src/idp/cards.js`, `src/widget/redress.js`).
- `node test/e2e/run.mjs --only E-CH-1,E-CH-8,E-CH-6,E-FI-1,E-FI-2,E-MD-4,E-MD-3,E-MD-5,E-FI-5,E-FI-6,E-MD-6`: the
  members and media-rows scenarios pass, 11 of 11, every request on 127.0.0.1. The same run listed the E-MD-1, -2, -7, -8,
  -9, -10 and E-FI-3 scenarios without their lab E-CH-6M, so they failed at once.
- `node test/e2e/run.mjs --only E-CH-6M,E-MD-1,E-MD-2,E-MD-10,E-MD-7,E-MD-8,E-MD-9,E-FI-3`: 8 of 8 pass, every request
  on 127.0.0.1.

## Requests (for the integrator)

- **R1 (SCALE-1, MAL53-5; optional, defence in depth).** `src/chain/state.js:297` (`filesOk`). Old:
  `if (!isHexN(v.ih, 40) || !isUint(v.len) || !isUint(v.t) || !textOk(v.name, 96, 1)) return false;`. New:
  `if (!isHexN(v.ih, 40) || !isUint(v.len) || v.len > 26214400 || !isUint(v.t) || !textOk(v.name, 96, 1)) return false;`.
  Test: a new freeze-schema vector `{ len: 26214401 }` is false, and the existing vectors are unchanged. This changes a
  state rule, so it belongs with the freeze group. The lane already hides such listings (`src/files/lane.js:101`).
- **R2 (PRIV-5).** `src/loader/api.js:755` (`case 'file-share'`): add `unchecked: Boolean(d.unchecked)` to `data`. In
  `src/loader/ui.js` (the upload card), when `data.unchecked`, show a new string after `uploadAsIs`.
  - `src/loader/strings.js`, after `:676`: `uploadUnchecked: 'This kind of file was not checked for location or camera
    details. Photos, audio and video in formats that are not cleaned can carry them.'`
  - French, after `:763`: `uploadUnchecked: "Ce type de fichier n'a pas été vérifié pour le lieu ou l'appareil. Les photos,
    l'audio et la vidéo dans des formats non nettoyés peuvent les contenir."`
  - Test: a card test with `unchecked: true` shows the sentence.
- **R3 (SCALE-13, MAL53-11).** `src/loader/api.js:2168` (`createFilesService`): pass `filesBudget: () =>
  storageLines({ deviceClass, siteBytes, ledgerBytes }).filesMax`, using the site cache's bytes and the ledger's bytes the
  loader already measures. Without it, the lane uses `storageLines()` with no site or ledger bytes
  (`src/files/lane.js:354`): 256 MiB on a desktop, 64 MiB on a phone.
- **R4 (MAL53-3).** `src/loader/pinwire.js:602`-`612` (`createPinPageHost(...).start`) needs an `isDenied` input. Before
  `tm.addFileTorrent`, add `if (typeof isDenied === 'function' && (await isDenied(ih))) return 'denied'`. Also have the pin
  host leave a held infohash when a later `_deny/` entry names it.
  - `tools/pin.mjs` (`decide()`, `restore()`) should quarantine an item whose infohash or listed hash its page's ledger
    denies.
  - A choke point in `TorrentManager.addFileTorrent` (`src/loader/torrent.js:3601`) would cover every caller.
  - Test: a pinwire unit test where `start` refuses a denied infohash and joins no swarm.
- **R5 (DS-4).** `src/loader/torrent.js:2334`-`2340` (`_handoffCheck`) should count a peer copy toward the hand-off only
  from evidence this device can check.
  - Track, per holder record (`_watchHolder`, near `:2155`), the pieces this device uploaded on that wire. Count the holder
    in a new `_copies(ih, now, { served: true })` only when `r.complete` and it received every piece from this device (or
    from the pin, by receipt).
  - Ignore `bitfield` and `have-all` claims made before any piece was sent.
  - `test/unit/torrent-seed-lanes.test.mjs:527` encodes the old rule and must change. New test: two fake wires with
    distinct peer ids that send `have-all` at once leave `_handoffCheck` false and the lane H. A pin receipt still ends H.

## R4 outcome (pin fixer, extra wave after verifier round 1, 2026-10-24 09:44 ET)

The two open parts of R4 (MAL53-3) are built. No end-to-end run was made for this change.

- **The pin page host leaves a held item that a later `_deny/` entry names.** `src/loader/pinwire.js:607`
  (`createPinPageHost`). The host keeps, for each held item, its infohash and the SHA-256 its pin request declared
  (`:609`-`:612`). `start()` checks the deny list again for an item it already holds and leaves it (`:651`-`:652`, returns
  `'denied'`). A new `sweep()` leaves every held item the ledger now denies (`:626`-`:637`). `status()` starts one sweep at a
  time in the background (`:687`-`:691`). `tools/pin.mjs` reads `status()` every two seconds, so the page leaves the swarm
  within about two seconds of the entry. A new optional input `discard(ih)` is called after a deny leave (`:604`, `:624`), so
  the page can delete the stored bytes. A plain `stop()` keeps them, as before. A check that throws is not a deny.
- **The pin node's own queue checks `_deny/`.** `tools/pin.mjs:349` (`FilePins` takes `isDenied`) and `:369`-`:385`
  (`_denied`, `_quarantineDenied`).
  - `decide('accept')` quarantines a denied item, by its infohash or its declared SHA-256 (`:467`-`:476`). It never pins or
    seeds it, and the size cap does not hide the deny. A seeder whose `start()` answers `'denied'` has the same effect
    (`:483`-`:486`).
  - `restore()` quarantines every pinned item the ledger now denies (`:504`-`:516`). It does this before it seeds anything,
    and also while the month cap holds.
  - The quarantine record says `quarantinedBy: '_deny/'`. The log has a `ledger-denied` line, and a new request for the item
    is refused with `'quarantined'`.
  - `pageSeeder` now passes `sha256` and `sha256Actual` to the page host (`:1266`).
  - An owner auto-accept of a denied item says so and stays out of the pin (`:984`-`:988`). An offline `--approve` reports the
    quarantine (`:1609`).
- Tests: `test/unit/pinwire.test.mjs:480`, `:490`, `:516` and `test/unit/tools-v03-pin.test.mjs:559`. `node --test` on
  those two files: 35 tests, 35 pass. `npm test`: 2,290 tests, 2,281 pass, 0 fail, 9 todo.

### Still open after R4

- **O-1: the Node process has no deny check of its own.** It learns of a deny only from the page host's `'denied'` answer.
  The run loop builds `createPinHost` without `isDenied`. `window.__mwPinHost` (`src/loader/app.js:4535`-`:4543`) exposes
  only `start`, `stop` and `status`, so `tools/pin.mjs` cannot ask the page's ledger directly.
  - An offline `--approve` of a denied item pins it on disk. The running node quarantines it at its next status tick
    (`startMissing`, once per `--interval`, 60 s by default), because the page host answers `'denied'`.
  - While the month cap holds, `restore()` starts nothing. A denied item stays pinned on disk, and is neither seeded nor
    listed in the heartbeat, until the month ends.
- **O-2: the heartbeat can list a denied item for up to one `--interval`.** This happens when the page has already left the
  item but the node has not yet quarantined it. `createPinHost` `observe()` does not drop an item from `complete` when the
  page stops listing it.
- **O-3: a denied item's bytes stay in the pin's browser profile.** They stay in the IndexedDB stores `pin-<ih>` and
  `pin-torrent-<ih>`, though no swarm is served from them, until `src/loader/app.js` passes `discard`. See request R4-a.

### Requests (for the integrator; `src/loader/app.js` is not this lane's file)

- **R4-a.** `src/loader/app.js:4517`-`:4526` (`createPinPageHost({...})` in `setupPinPage`): add
  `discard: async (ih) => { await be().deleteName('pin-' + ih); await be().deleteName('pin-torrent-' + ih) }`.
  `idbBackend` has `deleteName` (`src/files/store-idb.js:119`). This closes O-3.
  **Applied by the orchestrator on 2026-10-24 09:45 ET** (`src/loader/app.js`, `setupPinPage`, two lines after `isDenied`); O-3 is closed once the next verifier confirms.
- **R4-b (optional).** Expose a read-only deny query on `window.__mwPinHost` (`src/loader/app.js:4535`-`:4543`), for example
  `denied: (id) => isDenied(id)` with the same `denyChecker`. Then wire `isDenied` in the `createPinHost` call of
  `tools/pin.mjs` `runPin`, through `page.evaluate`, and handle a missing method. This closes O-1 for the running node.
  Offline `--approve` would still have no ledger.
