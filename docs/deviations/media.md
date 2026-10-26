# Lane media (M1 + M2): files and private media

Built 2026-10-20 against docs/review/V03-DESIGN-REVIEW.md ("R") 2.8, 2.9, 2.11.2, MF-47 to MF-57, and the
INTERFACES "v0.3 (proposed)" section for src/files/*, src/media/*, src/sw/media-route.js (now marked v0.3 and
rewritten to match the code).

## What landed

- Formats (R 2.9.4, 2.9.5, MF-56): `src/media/pad.js` (buckets), `src/media/format.js` (plan, chunk crypto,
  manifest, offset to chunk mapping), `src/files/encrypt.js` (F2 STREAM records). The R 2.9.5 worked example is
  reproduced in a test: 20 MiB plus a 48 KiB poster gives 82 data chunks, 88 pieces, 23,068,672 bytes, padding
  9.7 percent of the plaintext. Vectors: `test/vectors/media.json`.
- Upload pipeline (R 2.8.2, 2.9.3, MF-57): `sniff.js`, `strip.js`, `faststart.js`, `poster.js`; fixtures from
  `test/fixtures/media/make-fixtures.mjs` (ffmpeg, into a temporary directory; nothing large committed).
- Files (R 2.8.3 to 2.8.8): `store-idb.js`, `validate.js`, `names.js`, `preview.js`, `serve.js`, `lane.js`,
  `service.js`.
- Service Worker (R 2.8.5, 2.9.6, MF-48): `src/sw/media-route.js`, registered in `core.js` before every other
  route; session messages in `protocol.js`; `RESERVED_ROUTES` / `reservedRoute()` in `lib.js`;
  `GET /_mw/idp-return`; COOP `same-origin-allow-popups` and `Referrer-Policy: no-referrer` on navigation
  responses the worker builds.
- Media: `session.js`, `lane.js`, `service.js`.

## Contract changes (also in the INTERFACES section)

1. **Manifest fields `plen` and `pmime`.** R 2.9.4's `M` has no poster length or type, but `?part=poster` needs
   both (Content-Length, Content-Type, the last poster chunk's cut). `M` gains `plen` (poster bytes, 0 when
   there is none) and `pmime` (sniffed poster type).
2. **Region bytes and ranges.** Region byte values: poster 0x01, media 0x02, pad 0x03 (R names the regions but
   not the bytes). `regions.poster` and `regions.media` are half-open chunk ranges `[i0, i1)`.
3. **`stripImage` returns `{ blob, removed, w, h, mime }`** like the other strippers (INTERFACES said `Blob`).
4. **`stripMp4` neutralises in place.** `udta` and `meta` boxes (anywhere under `moov`, and at the top level)
   and top-level XMP `uuid` boxes become `free` boxes of the same length with zeroed contents. No chunk offset
   moves, so the rewrite is safe for fragmented files too. The bytes are gone; the file length is unchanged.
   ffmpeg's own `moov/udta` (the encoder tag) goes with it. `removed` lists box paths; `location` says
   whether a removed box carried `©xyz`, `loci` or a QuickTime location key.
5. **`stripWebm` also removes `Info/Title`** (free text a camera or app may fill), besides every `Tags` element
   and the SeekHead entries pointing at one; all become EBML Void elements of the same length.
6. **F2 STREAM format.** R names STREAM records but no layout. Chosen: records of 65,536 bytes (65,520 payload
   + tag), plaintext `uint64_be(length) || file || zeros`, record count filling the R 2.9.5 bucket, nonce
   `0x00 x 7 || uint32_be(i) || last`, AAD `mw-file-v1`. **New prefix `mw-file-v1`** for the R 2.10.3 list (a
   new purpose gets a new prefix). The nonce prefix is constant because fk is random per file and never reused.
   `encryptStream(readable, fk, { length })` takes the length (needed for the padding).
7. **Route ids are session ids.** `/_mw/f/<id>` takes a 128-bit session id registered by `files.save` (like
   the media `sid`), not the file ref, so a download URL is useless after the session.
8. **Session protocol** (`src/sw/protocol.js`): `mw-session-register { sid, kind: 'media'|'file', exp, M?, fk?,
   file? }` with `event.ports[0]` as the session's private port (it also carries the ack);
   `mw-session-close { sid } | { all: true }`; worker to pages `mw-session-lost { sid }`; on the port
   `mw-chunk-need { sid, req, i }` and `mw-chunk { req, i, data } | { req, i, error }`. File sessions carry
   plaintext blocks (the engine page decrypts F2 files), media sessions carry ciphertext chunks (the worker
   decrypts). PROTO stays 1 (added types only).
9. **The 410 path.** A request for a sid the worker does not hold broadcasts `mw-session-lost` to window
   clients and waits 3 s (chosen) for a re-registration; then 410 "Open this again to keep watching." A
   session whose registering client is gone (`clients.get`) or past 12 hours also gets 410.
10. **`/_mw/idp-return` in drop-in mode** answers a minimal page (`<meta name="mw-idp-return">` and
    `<script type="module" src="/_mw/mw.js">`), since a drop-in origin has no loader document; shell mode gets
    the cached loader document.
11. **COOP.** The worker's default `same-origin-allow-popups` yields to a COOP the site's routing manifest sets
    (cross-origin isolation needs `same-origin`); such a site signs in through the redirect round trip.
12. **Incremental SHA-256** lives in `src/files/validate.js` (`createSha256()`), not in
    `src/chain/sha256-sync.js`, which has no update/finish API and is another lane's file. It runs in the loader
    piece by piece, not in a worker (a new worker entry would need build.mjs).
13. **Preview decode** uses `createImageBitmap(blob, { resizeWidth, resizeHeight })` in the loader (the browser
    decodes off the main thread) rather than a dedicated worker bundle, for the same reason.
14. **Metadata errors** are `E_FILE_HASH` with a `reason` (`length`, `piece-length`, `pieces`, `files`, `path`,
    `nonce`, `torrent-size`, `infohash`, `bencode`, `sha256`); R lists no separate code for a lying torrent.
15. **Arithmetic note on R 2.8.3:** 16,384 pieces need 327,680 bytes of piece hashes, more than the 256 KiB
    `.torrent` cap, so the cap binds first (about 13,100 pieces). Both rules are enforced.
16. **Chromium adds its own sRGB ICC profile** to every canvas JPEG. The uploaded profile is gone (tested with a
    marked profile in the fixture), but "ICC profiles dropped" means "the original profile is dropped".
17. **Owner tier blocking** reads `_mw.cfg.blockTiers` (an array of sniff kinds, e.g. `['executable']`); R 2.8.5
    says "Owners may block a tier in `_mw.cfg.files`" but `_mw.cfg.files` is `off`/`members` (R 2.5.5).
18. **`files.enable` is a UI method** (the visitor opt-in card of MF-60); INTERFACES' UI list does not name it.
    `media.pinRequest` and `files.pinRequest` are not UI methods (they only queue metadata for moderators).
19. **E_NO_OWN_TRACKER** is thrown by `media.upload` without the site's own tracker (R 2.9.8 requires it);
    R 2.9.11 does not list that code for media.

## Requests to other lanes

- **H1b (`src/loader/torrent.js`, `addFileTorrent`)**: the lanes pass `{ torrentFile | infoHash, store, announce,
  retain: true }` where `store` is a constructor (`IdbChunkStore.factory({ name, backend })`, WebTorrent's
  `store` option). They use from the returned handle, each optional: `on('verified', index)`,
  `once('done', fn)`, `metadata() -> Promise<torrentFile bytes>` (validated before any byte is used),
  `prioritize(i0, i1)` (or `torrent.critical`), `downloaded`, `numPeers`, `stopSeeding()`, `destroy({ keepStore })`.
  Private torrents carry `private: 1` and `x-mw-nonce`; announce only to the own tracker.
- **Sealed codec (`src/identity/sealed.js`, lane idp or sdk)**: assumed shape `seal({ kind, data, key, ledgerId,
  authorPub }) -> value`, `open(value, { key, ledgerId, authorPub }) -> { kind, data }`, and for durable grants
  `sealTo({ kind: 4, data, to, keys, ledgerId }) -> value`. Kind 3 data is UTF-8 JSON `{ M, fk }` (about 400
  bytes). An adapter in the wiring is fine.
- **Chat (lane chat)**: grants travel as `chat.dm.send(pub, { grant })` with `grant = { t: 'media', G }`,
  `{ t: 'revoke', id }` or `{ t: 'file', F }`; on receipt call `mediaService.onGrant(fromPub, grant)` or
  `filesService.onGrant(fromPub, grant)` (by `grant.t`). `chat.groupMembers(groupId)` resolves a group share.
- **SDK (lane sdk)**: wire `deps.swPort = { ready(), post(msg, transfer), onMessage(fn) }` to
  `navigator.serviceWorker.controller` and its message events (for `mw-session-lost`); call
  `mediaService.signOut()` on sign-out and `sessions.closeAll()` on page hide; route `deps.download(url, name)`
  to a loader-owned `a[download]` click; finish the redirect sign-in at `/_mw/idp-return` (shell: app.js sees
  that pathname; drop-in: mw.js sees `<meta name="mw-idp-return">`). `files.fetch` returns functions
  (`stream()`, `blob()`) that do not cross the Bridge: the Bridge should hand the site `{ handle, name, size,
  mime }` plus a Blob from `blob()` (typed `application/octet-stream`). Add `files.enable` to UI_METHODS.
  Push events: forward the services' `on(...)` events as `media` and `files`.
- **build.mjs / integrator**: the worker bundles now include `src/sw/media-route.js`, `src/files/serve.js`,
  `src/files/names.js`, `src/media/format.js`, `src/media/pad.js` (checked with an esbuild IIFE bundle to the
  scratchpad at the floor targets; dist/ not rebuilt).
- **ARCHITECTURE 15.7 and 3.1** (not my file): add `/_mw/idp-return` and the session messages; note the
  contract changes 1, 6 and 7 above.

## Vectors: lines for test/vectors/LOCK.json (append; also add 'media.json' to FILES in formats-vectors.test.mjs)

```
{"file":"media.json","id":"media-plan-001-worked-example","sha256":"0a26f1bc001e33e006361bc364adcfef226df6d0be53238ca35cdf8e68728b3a"},
{"file":"media.json","id":"media-plan-002","sha256":"96c3fe5b8633568d820ee8d4d9be28be6c49a88f1bcc1e6ce1b8e0dc12e18656"},
{"file":"media.json","id":"media-plan-003","sha256":"870ccfa5cb2220d2240ff5c7ec4e06c0ec7b3b7cc94644ef980f074705695719"},
{"file":"media.json","id":"media-plan-004","sha256":"1944bc23ae423f83e417a9868a8df47943981a2043dcc503b2e0291d51e05df0"},
{"file":"media.json","id":"media-plan-005","sha256":"42ffd5d322694bd99ac1dbfd939e145c82f5bc02dff9c29fa806fa1e766b04bd"},
{"file":"media.json","id":"media-plan-006","sha256":"d900f0db8c1df50ab32fccdab212c58a8553fd16bb4868ba45995eb4efbb425a"},
{"file":"media.json","id":"media-plan-007","sha256":"d3c072db1aa270af17a1fd8f7480e01d467914941896138f83fd996c04dcf323"},
{"file":"media.json","id":"media-plan-008","sha256":"33badf1dadd8f40334db1bb3d826e077c5ba718b03323e1756a6cdd547747100"},
{"file":"media.json","id":"media-bucket-001","sha256":"13fc96fe9cb3883f58bc0cdd5d78c0e52a0e958513f0717e969e5af46b474a72"},
{"file":"media.json","id":"media-chunks-001","sha256":"06e8edae79958dfeda78d18eaf814a000e46f606f7a96a5efa75b2c4acda71ff"},
{"file":"media.json","id":"media-manifest-001","sha256":"4a4c4cbccfc1a25f1faec32bac537f21bfc963cacb6c176c76af04a3716c57a2"},
{"file":"media.json","id":"media-negative-001-swapped","sha256":"d5e4f0631cb45effc151043c20637b433bf26d918bc5183b25b2053d36c6e376"},
{"file":"media.json","id":"media-negative-002-truncated-total","sha256":"23bea3bb33444f87677cdcb96d6a86e856e5f4c898fd720a5a16bfe881e079a5"},
{"file":"media.json","id":"media-negative-003-other-fid","sha256":"1afe750c9bcb2a693bf6cd464e2f42fc8c26ba9939bc165c967b106b6aacc608"},
{"file":"media.json","id":"media-negative-004-region","sha256":"f8d9edb1cdf101822a8cac5d39838524137b2c2f9eb199f5a2f0574a2c194906"}
```

## Tests run by this lane (Node 24, loopback only)

`node --test` on test/unit/media-format, media-strip, media-faststart, files-validate, files-serve,
sw-media-route, media-service, sw-core, sw-lib, sw-protocol: 112 passed, 0 failed. `MW_BROWSER=1` media-browser
(Chromium with `chromiumArgs({ allowRemote: false })`, 127.0.0.1 only): 1 passed. `node tools/lint-floor.mjs`:
clean. Neighbouring suites that load the worker (sw-sdk, dropin-sw-arraybuffer, dropin-swreg, v021-integration,
tools-build): 74 passed. Not run (integrator): the full suites, e2e E-FI-1 to E-FI-6, E-MD-1 to E-MD-10, the
media part of E-CH-6. formats-vectors fails until the LOCK lines above (and other lanes' vector files) are
appended; repo-layout fails on `packages/` (lane S1).

## Open

- The worker route answers a request with headers before the first chunk arrives; a chunk that never comes
  errors the stream after 120 s (chosen), which a `<video>` shows as a network error. Measure in G-MD-1.
- iOS Safari's handling of streamed 206 from the worker is unverified (G-MD-2, G-MD-3); `MediaSessions` takes a
  worker-ready probe from the wiring, which can force the Blob path there.
- CryptoKey structured clone into the worker is assumed (G-MD-6); a `DataCloneError` switches to raw bytes, and
  `keyTransfer: 'raw'` forces it. Node tests cover both paths.
- `stripImage` and `videoPoster` were exercised in Chromium only (WebKit not run by this lane).

## Code review v0.3 (round 2, 2026-10-21): what changed after the build

Recorded here for the media and files lanes; INTERFACES and ARCHITECTURE 15.7 and 15.19 carry the contracts, and
[review/DESIGN-REVIEW.md](../review/DESIGN-REVIEW.md), section 8, is the review's record.

- **The vault (MF-72, part):** `src/media/vault.js` `keysVault()` keeps own items (always) and accepted grants in the working keys'
  sealed per-origin cache; the media and files services restore them once per signed-in key (`ready()`). Delete and revoke forget kept
  copies. An identity-origin vault API for file keys, so they follow the person to other devices, is on [ROADMAP.md](../ROADMAP.md).
- **Revoke with re-encryption** moves the record to `idOf(new M)`, keeps the previous ids for revoke and delete, emits
  `shared { id, kind: 'own', replaces }`, and returns `{ revoked, reencrypted, id }`.
- **Grants are typed:** `checkManifest` takes only allow-listed media types that match the kind and a poster type or `''`; a Blob
  fallback is typed only when the decrypted bytes sniff as the allow-listed type (`blobType`), else `application/octet-stream`.
- **Registering a session:** a register that carried a CryptoKey and timed out is retried once with the raw key bytes; since round 2 the
  worker also reports a message it could not read (`messageerror`, pushed as `mw-message-error`), and the page retries at once.
- **Seeks (integrator):** the worker's `mw-chunk-cancel` makes the page stop answering that chunk and take its piece out of the front
  of the download (`MediaSessions.open({ cancelChunk })`, `FileTorrentHandle.deprioritize`).
- **After a reload (integrator):** own items kept on this device join their swarms again in lane K, newest first, at most
  `RESEED_MAX` (8, chosen), so the people they were shared with can fetch them; items read from the ledger's own index on another
  device are not fetched for this.
- **The pin key (integrator):** the media and files lanes take the pin key from `deps.pinKey()` (only a `_mw.cfg` written with owner
  standing names it, `api.js ownerCfgPin`), not from `_mw.cfg.pin` alone.
- **Premoderation in the files lane (integrator, MF-53):** a public listing that waits for a moderator is listed only for its author,
  with `pending: true`; nobody else lists it, and `files.fetch` of it answers `E_POLICY` (`deps.listingVisible`, `src/loader/mod.js`).
- **Stripping and posters:** MP4 timed-metadata and subtitle tracks are zeroed and their `trak` turned into `free`; a fragmented file with
  such a track is refused; `decodeImage()` tries `createImageBitmap` with the orientation option, then without, then an `<img>`;
  `videoPoster` plays muted to the first frame (8 s), and without a frame the item keeps its size and says "No preview".
