# pin-node lane (v0.3 C2): contract, notes and deviations

Brief: [SEEDING-AND-ZERO-SETUP-DESIGN](../research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) ("SZ") 3.1.6 (frames, signing
strings, heartbeat, owner auto-accept), 3.1.5 (evidence tiers E3, E4), 3.2 `deploy/one-box`; V03-DESIGN-REVIEW ("R")
2.5.5 (`_mw.cfg.pin` is the pin's key), 2.8.6 (moderator queue, quarantine, never open or render), 2.10.3 (distinct
signing prefixes); S1 D4. The pin node is infrastructure the owner or a hub runs beside the static host and the
tracker; members never run one (owner decision, browser only).

Files: `tools/pin.mjs`, `src/pin/frames.js`, `src/pin/heartbeat.js`, `deploy/pin/Dockerfile`, `deploy/pin/README.md`,
`test/vectors/pin.json`, `test/unit/pin-frames.test.mjs`, `test/unit/pin-heartbeat.test.mjs`,
`test/unit/tools-c2-pin.test.mjs`, `test/fixtures/pin/start-pin.mjs`, this file. `test/unit/tools-v03-pin.test.mjs` is
unchanged: every behaviour it checks is unchanged.

## Progress log (ET)

- 2026-10-20 16:00 read SZ, the lane brief, R 2.5.5, 2.8.6, 2.10.3, S1 D4, the existing `tools/pin.mjs` and its tests.
- 16:10 `src/pin/frames.js` and `src/pin/heartbeat.js` written; a Node smoke run signed and verified a hello (305
  bytes), a receipt (291 bytes) and a two-item heartbeat (376 bytes).
- 16:20 `tools/pin.mjs`: pin key, signer, month meter, heartbeat file, page probe, host ops, `runPin` glue, flags.
- 16:25 `test/vectors/pin.json` generated once (15 vectors) with throwaway keys; unit tests written.
- 16:37 unit tests green: pin-frames 8, pin-heartbeat 7, tools-c2-pin 16, tools-v03-pin 14 (45 in all);
  `repo-layout` and `tools-lib` (they read the Dockerfile, the README and `pin.mjs`) green as read-only checks.
- 16:40 one local smoke run with a real Chromium, 127.0.0.1 only (scratch script, not part of any suite): the current
  loader built into a temporary directory (the repository's `dist/` untouched), a local tracker and dev server,
  `examples/peer-guestbook` published for 127.0.0.1, the pin started by the fixture. Results: the page rendered; the
  heartbeat verified on disk (mode 644) and when fetched at `<ws base>/pin-status.json`, listed the site torrent, and
  its `site` equalled the ledger id `publish` reported; the owner key came from the page tag, an owner request was
  pinned at once (`approvedBy: 'auto-accept owner'`) and a member's waited; through the real binding `pin.key`
  answered, a `pin.sign` hello verified, a block string was refused, the site frame was refused; after `stop()` the
  heartbeat listed nothing; the browser requested nothing outside 127.0.0.1.

## The contract (exact exports)

### `src/pin/frames.js` (Node 22 and browsers, WebCrypto, no `node:` imports)

Reuses `src/chain/crypto.js` (`p256:` keys, raw P1363 ECDSA) and `src/chain/canonical.js` (`utf8`, `b64url`).

| Export | Value or signature |
|---|---|
| `EXT_NAME` | `'mw_pin1'` |
| `FRAME_MAX_BYTES` | `1024` (UTF-8 bytes of the JSON) |
| `NONCE_BYTES` | `16` |
| `SKEW_MS` | `300000` (`\|now - at\|` at most 5 minutes) |
| `HELLO_PREFIX`, `RECEIPT_PREFIX` | `'mw-pin1-hello\n'`, `'mw-pin1-receipt\n'` |
| `SIGNABLE_MAX_BYTES` | `128` |
| `FRAME_TYPES` | `['chal', 'hello', 'rcpt']` |
| `helloBytes(ih, n, at)` | `utf8('mw-pin1-hello\n' + ih + '\n' + n + '\n' + at)`; TypeError on bad fields |
| `receiptBytes(ih, total, at)` | `utf8('mw-pin1-receipt\n' + ih + '\n' + total + '\n' + at)`; TypeError on bad fields |
| `parseSignable(bytes)` | `{ kind: 'hello', ih, n, at }` \| `{ kind: 'receipt', ih, total, at }` \| `null` |
| `isPinSignable(bytes)` | `parseSignable(bytes) !== null`: bytes only (a string is refused) |
| `checkFrame(frame)` | `{ ok }` \| `{ ok: false, reason }`, shape only |
| `encodeFrame(frame)` | `Uint8Array`, fields in a fixed order; TypeError (bad frame), RangeError (over 1,024) |
| `decodeFrame(bytes \| string)` | `{ ok: true, frame }` \| `{ ok: false, reason }`; never throws |
| `makeChallenge({ random })` | `{ t: 'chal', n }`, `random(16)` or WebCrypto |
| `makeHello({ key, ih, n, at }, signer)` | Promise of a hello frame |
| `makeReceipt({ key, ih, total, at }, signer)` | Promise of a rcpt frame |
| `verifyHello(frame, { expectKey, ih, n, now, skewMs = 300000 })` | Promise of `{ ok, reason }`; never throws |
| `verifyReceipt(frame, { expectKey, ih, now, skewMs = 300000, total })` | Promise of `{ ok, reason }`; never throws |

`signer` is a private `CryptoKey`, or a function `(bytes) -> Promise<signature as 64 bytes or base64url>` (a pinned
page passes `(bytes) => window.__mwPinCall('pin.sign', b64url.encode(bytes))`). Field rules: `ih` 40 lowercase hex;
`n` canonical base64url of 16 bytes (22 characters); `key` a `p256:` key; `at` a safe integer of milliseconds since the
epoch; `total` the torrent's length in bytes, a safe integer of at least 1; `sig` canonical base64url of 64 bytes.
A frame has exactly its fields (chal: `t, n`; hello: `t, key, ih, n, at, sig`; rcpt: `t, key, ih, total, at, sig`).

Reasons: shape `malformed`, `too-large`, `unknown-type`, `extra-field`, `bad-n`, `bad-key`, `bad-ih`, `bad-total`,
`bad-at`, `bad-sig`; checks `wrong-type`, `no-expected-key` (no `_mw.cfg.pin`: nothing is trusted), `other-key`,
`other-ih`, `other-n` (an answer to another challenge), `other-total`, `skew`, `signature`.

### `src/pin/heartbeat.js` (Node 22 and browsers)

| Export | Value or signature |
|---|---|
| `STATUS_TYPE`, `STATUS_VERSION` | `'mw-pin-status'`, `1` |
| `STATUS_PREFIX` | `'mw-pin-status-v1\n'` (signed bytes) |
| `ITEM_PREFIX` | `'mw-pin-status-v1\|'` (hash input of the item ids, never signed) |
| `STATUS_FILE` | `'pin-status.json'` |
| `STATUS_MAX_BYTES`, `STATUS_MAX_ITEMS` | `262144`, `4096` |
| `STATUS_MAX_AGE_MS`, `STATUS_SKEW_MS` | `900000` (15 minutes), `300000` (5 minutes ahead) |
| `SITE_MAX` | `128` |
| `itemId(ih)` | base64url of the first 16 bytes of `SHA-256(utf8('mw-pin-status-v1\|' + ih))`, ih lowercased; 22 characters; synchronous (`src/chain/sha256-sync.js`) |
| `makeStatus({ key, site, at, ihs, monthBytes = 0, monthCap = null })` | `{ v: 1, t: 'mw-pin-status', key, site, at, items, monthBytes, monthCap }`, items sorted and deduplicated |
| `checkStatus(obj, { signed = true })` | `{ ok }` \| `{ ok: false, reason }` |
| `statusBytes(obj)` | `utf8('mw-pin-status-v1\n' + JCS(obj without sig))` |
| `encodeStatus(obj)` | the file's JSON text plus a newline; RangeError above 256 KiB |
| `signStatus(obj, signer)` | Promise of the heartbeat with `sig` |
| `parseStatus(text \| bytes \| object)` | `{ ok: true, status }` \| `{ ok: false, reason }`; never throws |
| `verifyStatus(input, { expectKey, site, now, maxAgeMs = 900000, skewMs = 300000 })` | Promise of `{ ok, reason, age, count, has(ih), status }`; `has` is always false when not ok; never throws |
| `statusUrl(wsBase)` | `<ws base>/pin-status.json` |

`site` is the pinned site's ledger id (`'mw1:'` plus 27 characters, `A.ledgerId` in the loader); `verifyStatus`
checks it when the caller passes `site`. `monthCap` is a number of bytes or `null` (no cap). Reasons: `malformed`,
`too-large`, `extra-field`, `wrong-version`, `wrong-type`, `bad-key`, `bad-site`, `bad-at`, `bad-items`,
`too-many-items`, `cleartext-infohash` (an item spelled as an infohash), `bad-item`, `duplicate-item`,
`bad-month-bytes`, `bad-month-cap`, `bad-sig`, `no-expected-key`, `other-key`, `other-site`, `stale`, `future`,
`signature`.

### `tools/pin.mjs` (every earlier flag, export and behaviour kept)

New flags:

| Flag | Meaning |
|---|---|
| `--pin-key <jwk file>` | the node's own P-256 key (tools/keygen.mjs); refused when group or others can read or write it (`loadOwnerKey` rules). Printed: the public key, its fingerprint and `node tools/ledger-admin.mjs cfg --key owner.jwk --file <ledger.json> --pin <pub>`. Without a URL: that printout only, exit 0 |
| `--status <file>` | the signed heartbeat, written atomically with mode 0644 (needs `--pin-key`, else exit 2); stored as an absolute path |
| `--status-every <s>` | default 300, accepted 1 to 600 |
| `--auto-accept owner` | the only rule; needs `--files` (else exit 2) |
| `--month-cap <size>` | bytes, or a number with `B`, `kB`, `MB`, `GB`, `TB` (decimal) or `K`, `M`, `G`, `T`, `KiB`, `MiB`, `GiB`, `TiB` (binary); at least 1 byte |

Bridge ops on the existing `window.__mwPinCall(op, arg)` binding (top frame of the pinned page only):

| Op | Argument | Answer | Refusals (`err.code`) |
|---|---|---|---|
| `pin.key` | none | the `p256:` key, or `null` without `--pin-key` or after the owner-key guard | none |
| `pin.sign` | the base64url string of the bytes (at most 256 characters) | the base64url signature (64 bytes) | `E_POLICY` (no key, or the guard), `E_BAD_REQUEST`, `E_NOT_SIGNABLE` (isPinSignable says no), `E_STALE` (`at` more than 5 minutes from the node's clock), `E_NOT_KEPT` (a receipt for an infohash that is neither the site torrent the page reports nor a file pinned here) |
| `file.request` | as before | as before; with `--auto-accept owner` and the owner's key as author: `{ queued: true, accepted: true, seeding }`, or `{ queued: true, accepted: false, reason }` when the accept failed (for example `E_PIN_FULL`) | as before |
| `file.pinned` | as before | as before, plus `paused: true` on every entry while the month cap holds | as before |
| `stats` | as before | as before, plus `month: { month, bytes, cap, paused }` and `key: { pub, off } \| null` | none |

The page side of the pin, `window.__mwPinHost` (not built by this lane; `pageSeeder` already called `start` and
`stop`):

| Method | Called by | Expected |
|---|---|---|
| `start({ ih, name, size, state })` | approve, auto-accept, restart, a new month, each page load (when the method exists) | join and keep that file torrent (the bytes stay in the profile) |
| `stop(ih)` | quarantine, the month cap | stop seeding that torrent, keep the bytes |
| `status()` | every 2 s, 5 s timeout | `{ files: [{ ih, uploaded, complete }] }`: `uploaded` the piece bytes sent to peers since that torrent started in this page (cumulative), `complete` true once every piece is verified |

New exports: `PIN_C2` (`statusEveryDefaultSec` 300, `statusEveryMaxSec` 600, `statusMinGapMs` 5000, `signArgMax`
256, `pageFilesMax` 10000, `monthSaveEveryMs` 30000), `parseByteSize`, `utcMonth`, `loadPinKey`, `pinKeyLines`,
`createPinSigner({ key, now, skewMs, kept })`, `MonthMeter`, `writeStatusFile(file, status)`, `parsePinPage(raw,
{ url, cache, now })`, `PIN_FLAGS`, `parsePinArgs(argv)`. `FilePins` takes `paused` (a predicate). `createPinHost`
takes `pinKey`, `autoAccept`, `monthCap`, `log` and returns, besides what it did, `signer`, `meter`,
`observe({ site, files })`, `setSite(site)`, `site()`, `statusItems()`, `heartbeat({ empty })`,
`writeStatus(file, { empty })`, `statusDirty()`, `resume()`, `pageChanged()`. `runPin` takes `pinKey`, `statusFile`,
`statusEverySec`, `autoAccept`, `monthCap`, `allowRemote` (only `false` changes anything) and `onHost(host)`.

New store entries: `<profile>/pin/month.json` (`{ v: 1, month: 'YYYY-MM', bytes }`, mode 0600) and the
`log.jsonl` actions `auto-accept`, `auto-accept-wait`, `auto-accept-failed`, `seed-paused`, `month-cap`,
`month-resume`, `signer-off`; `approve` entries of auto-accept carry `by: 'auto-accept owner'`.

### `deploy/pin/Dockerfile`

`PIN_URL` (required), `PIN_KEY` (a path inside a volume; empty: no key), `PIN_STATUS` (default
`/srv/site/ws/pin-status.json`, used only with `PIN_KEY`; empty: no heartbeat), `PIN_MONTH_CAP`, `PIN_AUTO_ACCEPT`
(`owner` adds `--files --auto-accept owner`), plus `PIN_PROFILE` and `PIN_INTERVAL` as before. Flags from the
environment come before the arguments given to `docker run`. The image runs as `node` (uid 1000), creates
`/srv/site/ws` owned by it, and its build fails if a `.jwk` file was copied in.

### `test/fixtures/pin/start-pin.mjs` (for the integrator's E-PS-1)

`startPin({ url, statusFile, files = true, autoAccept = 'owner', monthCap, mailbox, statusEverySec = 2, intervalSec = 5,
consent = true, maxRestarts = 0, readyTimeoutMs = 120000, keep, log, run })` resolves with `{ pub, fingerprint,
statusFile, profileDir, keyFile, dir, lines, ready, done, waitFor(re, ms), readStatus({ site }),
waitForStatus(pred, ms, { site }), host(), stop() }`. Only `http://127.0.0.1` URLs (`assertLocalUrl`); it checks that
`chromiumArgs({ allowRemote: false })` holds the resolver rule and runs `runPin` headless with `allowRemote: false`,
a temporary profile and a temporary key (mode 0600), all deleted by `stop()` unless `keep`. It builds nothing and
starts no server. E-PS-1 outline: publish with `_mw.cfg.pin = pin.pub` (`ledger-admin cfg --pin`), put `statusFile`
in the web seed directory so it is served at `<ws base>/pin-status.json`, `await pin.ready`, upload as the owner,
then `await pin.waitForStatus((v) => v.ok && v.has(ih), ms, { site: ledgerId })` and check the label.

### `test/vectors/pin.json` (append-only once locked)

15 vectors: two throwaway keys, a challenge, a hello, a receipt, a heartbeat, and negatives (wrong prefix, skew,
other key, forged receipt, oversize frame, infohash in the clear, stale heartbeat, other site, 12 unsignable
strings). ECDSA is randomized: implementations verify the signatures, they cannot reproduce them. LOCK.json entries
for the integrator, in this order:

```text
{"file":"pin.json","id":"pin-key-001","sha256":"88604a744aa6a3278ded6ce7eff348d310278042dfb4ba04aa3687731325a4a2"},
{"file":"pin.json","id":"pin-key-002-other","sha256":"56b8cf29d1028e5409ed9a4a0d3bbd9dd021a2f6b40854acd203cef1d23c9382"},
{"file":"pin.json","id":"pin-chal-001","sha256":"61200bf4996dc03226f245765cd508df2e0be69ff61bd1ced2ec7db81a7f8491"},
{"file":"pin.json","id":"pin-hello-001","sha256":"7912a8aa1ac8a3408fd6395fde27c51b8220e45e8019bb85ac3f5dc7ce82d52d"},
{"file":"pin.json","id":"pin-rcpt-001","sha256":"1a89141e50c15bfd3e76099ccc747e8ef582ae4cc0ad04c33942c4f13fc9d02e"},
{"file":"pin.json","id":"pin-status-001","sha256":"cea2d8b9b3072e93ba0f2b35e8e2deb3e016d5aee1ecc4848eca0d31c3d3d767"},
{"file":"pin.json","id":"pin-neg-001-wrong-prefix","sha256":"325e2840f0ca65c79585826674d56a9420b52ba34693ec9458f2a72944399f29"},
{"file":"pin.json","id":"pin-neg-002-skew","sha256":"b50e8a590936950729a332c4fabbc3a7a90acb60d95bb7bc1bc42a58c5f19929"},
{"file":"pin.json","id":"pin-neg-003-other-key","sha256":"d7b086251e63ad7aec0980d140ef4170e3b95b49e8bf102233066920cb780211"},
{"file":"pin.json","id":"pin-neg-004-forged-receipt","sha256":"eaeba581b5360380e0aa2fce6748211e8c63515104b3ae8c296c8d25eaa4326a"},
{"file":"pin.json","id":"pin-neg-005-oversize-frame","sha256":"50eceb525bf0820954e96dc1abee7db0877bde53f4448439f4490b04f3e79775"},
{"file":"pin.json","id":"pin-neg-006-cleartext-infohash","sha256":"9b89482bdd3b9c6f7c710fc378ec37290c166c1de9fc02ac7da1cc3f0452331d"},
{"file":"pin.json","id":"pin-neg-007-stale-status","sha256":"44204543d1cfd8594eab232f83132c668b7dbcc47e1c5768dd9119a358651efd"},
{"file":"pin.json","id":"pin-neg-008-other-site","sha256":"65b994ea4e2059f06b5402c3c888a2b5d7f83250f58e03245b07ae89c62cc10d"},
{"file":"pin.json","id":"pin-neg-009-unsignable","sha256":"1dfc217a5e6aa58ecc7ad3bfe547d3a18ade7764c89fffd214a350de8182d84b"},
```

## Deviations and choices (where SZ or the brief left room)

| Id | What SZ or the brief says | What the code does | Why |
|---|---|---|---|
| D-1 | rcpt carries `total` (unnamed unit) | `total` is the torrent's length in bytes; `verifyReceipt` takes an optional `total` and then requires the same length | binds a receipt to one exact item; the verifier knows the length from the metadata |
| D-2 | `at` and `\|now - at\|` at most 5 minutes | `at` is milliseconds since the epoch, a safe integer; `verifyReceipt` also takes `skewMs` | same unit as `now = Date.now()` and the other v0.3 records |
| D-3 | heartbeat field `site` (unnamed value); `verifyStatus(obj, { expectKey, now, maxAgeMs })` | `site` is the ledger id; `verifyStatus` takes an optional `site` and `skewMs` (a heartbeat more than 5 minutes ahead is `future`) | a hub pin's heartbeat for one site must not count for another; the ledger id names the site independent of its address |
| D-4 | `monthCap` | `null` when there is no cap | 0 would read as "a cap of nothing" |
| D-5 | items list "the site torrent and every pinned file" | the site torrent while the page reports it mounted; a pinned file only while it is held whole (complete on the node's disk, or `complete` in the page's `status()`) and the month cap does not pause it; ids sorted | E4 must not claim more than the node holds; sorting hides which id is the site |
| D-6 | the signer refuses what `isPinSignable` refuses | it also refuses an `at` more than 5 minutes from its clock, and a receipt for an infohash that is not the site torrent or a file pinned here | a page could otherwise get receipts dated in the future, or receipts for files the node never kept |
| D-7 | none | if the pointer's owner key equals the pin key, the signer turns off (`pin.key` null, no signatures, no heartbeat) and logs one error | DEPLOY: never keep the owner key on a pin node |
| D-8 | none | when the browser stops (crash, restart, SIGTERM) the node writes a heartbeat with no items | the last heartbeat would otherwise claim the files for up to 15 minutes |
| D-9 | `'pin.sign' (b64url bytes) -> b64url signature` | the argument is the base64url string itself (at most 256 characters); `pin.key` answers `null`, not an error, without a key | the pinwire responder role only needs a yes or no |
| D-10 | `--status-every 300` | accepted 1 to 600 s; after a change (site mounted, a file whole, the cap) the heartbeat is written within about 5 s | a heartbeat must stay under 15 minutes old while visitors cache it up to 10 minutes |
| D-11 | `--month-cap <bytes>` | also accepts units (`500GiB`, `2TB`) | a VPS plan is sold in GiB or TB |
| D-12 | `--pin-key` prints the key and the command | also a command of its own: `node tools/pin.mjs --pin-key pin.jwk` prints and exits 0 | the owner needs the public key before the pin first runs; the printed command includes `--key owner.jwk --file <ledger.json>`, which `ledger-admin cfg` requires |
| D-13 | `--auto-accept owner` approves the owner's requests | needs `--files`; a moderator's earlier decline or a quarantine stands; requests that arrived before the node knew the owner (the page had not loaded) are approved once it does; a failed accept (store full) leaves the request queued; the owner key is the one the page tag names, verified for the URL's host (an expired tag still names it, a withdrawn or badly signed one names nobody) | a moderator decision outranks the automatic rule; no request is lost to timing |
| D-14 | "count uploaded bytes of pinned files per UTC calendar month from the page's progress counters" | growth of `status().files[].uploaded` per page session (a smaller value or a new page starts a session); bytes of the first sample after midnight UTC go to the new month (2 s of uploads at most); new approvals start no seeding while paused; `file.pinned` marks entries `paused` | the page's counters are cumulative per session |
| D-15 | none | after each page load the node asks the page to keep the pinned files (`start`), once it sees `window.__mwPinHost.start`; otherwise one line says the files stay on disk | before, `start()` ran only before a page existed, so a restarted node asked nobody |
| D-16 | frames are JSON of at most 1 KiB | decoding is strict: exactly the fields of the type, lowercase infohash, canonical base64url; a string input is accepted as well as bytes | one spelling per frame; unknown fields are a version change (a new extension name) |
| D-17 | none | `runPin({ allowRemote: false })` can only narrow the browser to local-only; `onHost(host)` exposes the host to the fixture | the fixture's network policy; tools never write `allowRemote: true` (tools-lib test) |
| D-18 | Dockerfile with `PIN_URL`, `PIN_KEY`, `PIN_STATUS`, `PIN_MONTH_CAP`, `PIN_AUTO_ACCEPT` | `PIN_STATUS` is used only with `PIN_KEY`; `PIN_AUTO_ACCEPT=owner` adds `--files`; the flags from the environment come before the user's arguments | a heartbeat needs a key to sign it; the auto-accept rule acts on file requests |

## Requests to other lanes

- **seed-engine (`src/loader/pinwire.js`).** Verifier: `decodeFrame(bytes)`, then `verifyHello(frame, { expectKey:
  cfg.pin, ih: <this wire's infohash>, n: <the nonce this wire sent> })` and `verifyReceipt(frame, { expectKey:
  cfg.pin, ih, total: <torrent length> })`; heartbeat: `fetch(statusUrl(wsBase))`, then `verifyStatus(text, {
  expectKey: cfg.pin, site: <ledger id>, now })` and `has(ih)`. Responder (only when `await
  window.__mwPinCall('pin.key') === cfg.pin`): `makeHello({ key, ih, n, at: Date.now() }, (bytes) =>
  window.__mwPinCall('pin.sign', b64url.encode(bytes)))`, and `makeReceipt({ key, ih, total, at: Date.now() }, ...)`
  only for the site torrent and pinned files once every piece is verified (the node refuses other receipts with
  `E_NOT_KEPT`).
- **seed-engine or the integrator (the page side of the pin).** `window.__mwPinHost` with `start`, `stop` and
  `status` as in the table above does not exist in `src/` yet (the old comment in `pin.mjs` expected the SDK lane to
  wire it; it did not). Without it pinned files are not seeded by the page, the month cap counts 0, and the heartbeat
  lists only the site torrent and files completed through `file.write` and `file.finish`.
- **Whoever calls `file.request` from the pinned page.** Auto-accept trusts the `author` the top frame passes. The
  page must take it from an authenticated source (the sender of a sealed chat grant, `m.from`, as `src/loader/mod.js`
  does, or the author of a signed ledger block), never from a field the requester wrote. In drop-in mode the site's
  own code is the top frame, so a pin should run drop-in pages only for sites whose code its operator trusts
  (`attachPinBridge` comment).
- **zero-setup (`deploy/one-box`, `ship`, DEPLOY).** Checked at 16:45 (read only): the compose `pin` service uses these
  names and mounts `./site/ws` at `/srv/site/ws`, and `ship` sends `ws/` without `--delete`, so `pin-status.json`
  survives a ship. Two things to settle there: the compose sets `PIN_KEY=/var/lib/mw-pin/pin.jwk` always, and
  `pin.mjs` exits 1 ("key file not found") when that file is not in the volume, so the container restarts in a loop
  until the key is put there (deploy/pin/README.md, step 2, shows how); and `site/ws` made by rsync as root is not
  writable by uid 1000, so the node only warns that it cannot write the heartbeat until someone runs `chown 1000:1000
  site/ws` once. Serve the file with `Cache-Control: no-cache`; DEPLOY "Pin node" can take the flag table above.
- **docs-strings (INTERFACES, ARCHITECTURE 8.1).** The exports above are the contract for `src/pin/frames.js` and
  `src/pin/heartbeat.js`. R 2.10.3 should list `mw-pin1-hello`, `mw-pin1-receipt` and `mw-pin-status-v1` (signed),
  and note the hash prefix `mw-pin-status-v1|` of the item ids.
- **Integrator.** Add `'pin.json'` to `FILES` in `test/unit/formats-vectors.test.mjs` and append the 15 LOCK lines
  above: until then that test fails on the list of vector files. The fixture is ready for E-PS-1.

## Open items

- O-1: a signed pin request (the author signs `"mw-pin1-request\n" + ih + "\n" + size + "\n" + at`, a new prefix)
  would let the node check the author itself instead of trusting the page; proposed for v0.4. **The node side is built** since
  the v0.3 code review (`src/pin/frames.js` `pinRequestBytes` over the ledger id, infohash, size, SHA-256, time and name;
  `makePinRequest`, `verifyPinRequest`; `tools/pin.mjs` refuses unsigned and forged requests); a member's page that signs and
  sends one is still to build.
- O-2: `docker build` with the new variables, a heartbeat served by Caddy, and a site on the internet were not run in
  this lane; the entrypoint script was run under `sh` with a stand-in for `node` (unit test).
- O-3: closed. At 16:30 `test/unit/tools-demo.test.mjs` failed twice on the `--tls` tracker URL after the zero-setup
  lane changed `tools/demo.mjs`; by 16:45 it passed 13 of 13, including the pin helpers it imports.
- O-4: `file.request` answers `seeding: true` when the seeder was asked without an error, as `decide()` always did;
  a page without `window.__mwPinHost` answers `'no-host'`, which the node logs but still counts as asked.
