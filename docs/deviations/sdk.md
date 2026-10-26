# sdk lane (v0.3 A1): SDK v0.3, the Bridge, the method tables, loader and drop-in integration of every service

Status: landed for integration (2026-10-20). Sources of truth: docs/review/V03-DESIGN-REVIEW.md (R 2.11, 2.9.11, 2.4.1,
3.1 to 3.5), the "v0.3 (proposed)" sections of docs/ARCHITECTURE.md and docs/INTERFACES.md. The method reference is
docs/SDK.md (this lane's file).

## Files

- `src/loader/api.js` (rewritten): the v0.3 method tables, the A4 boundary (ActivationTracker, gating order, conditional
  UI, loader-only methods), MwApi with service mounting (the SVC contract), the identity binding (v03, legacy, follower
  remote state), the implicit sign-in, the prompt adapter (service prompts to lane ui card kinds), grant redaction, and
  the shared v0.3 wiring for the shell and drop-in mode (`mountV03Services`, `createTorrentSeam`, `setNodeIdentity`,
  `nodeIdentityOf`, `chatStore`, `createSealedStore`, `sealedAdapter`, `swPortFor`, `denyChecker`, `authorOfEntry`).
- `src/loader/mod.js` (new): `mw.mod.*`, `mw.report.send`, `db.setMine/getMine/listBy`, `owner.policy` (R 2.5, 2.17,
  MF-27).
- `src/loader/personal-site.js` (new): "Create my page" (genesis, pointer with `nx=`, ledger id, label, the link that
  carries the genesis) and the hub service of followed ledgers (the amendment below).
- `src/loader/bridge.js` (rewritten): transport only (handshake, port, fee progress and cancellation, `wait` pushes,
  `files.fetch` over the port, the activation tracker on the site frame), over the page's MwApi.
- `src/loader/app.js` (integration): WorkingKeys, the 0.2.1 key migration deps, implicit sign-in, `/_mw/idp-return`,
  follower tabs without keys and `signed-out`, host-only refusals, the harden.js helpers, the torrent seam
  (registerWireExtension, addFileTorrent, budget), media sessions, `isDenied`, MultiGossip and the hub follow lane in hub
  mode, personal sites.
- `src/sdk/sdk.js` (rewritten, no imports), `src/sdk/sdk-static.js` (v0.3 stubs).
- `src/dropin/binding.js` (rewritten), `src/dropin/engine.js`, `src/dropin/ledger.js`, `src/dropin/leader.js`,
  `src/dropin/mw.js` (drop-in parity).
- `docs/SDK.md` (rewritten for v0.3).
- Tests: `test/unit/sdk-v03-tables.test.mjs` (10), `sdk-v03-gating.test.mjs` (9), `sdk-v03-wiring.test.mjs` (10),
  `sdk-v03-personal.test.mjs` (7), `dropin-v03.test.mjs` (8), and updates to `dropin-binding`, `dropin-engine`,
  `dropin-mw` and `sw-sdk` (listed under "Test changes").

## Contract changes and amendments (also in docs/SDK.md)

1. **Amendment to R 2.11.2: followed ledgers.** R 2.11.2 has no method for following a ledger, which Part 3 needs.
   Added: `mw.hub.follow(target)` (write), `mw.hub.unfollow(ledger)` (write), `mw.hub.list()` (read),
   `mw.hub.createPage(options)` (UI, R 3.3), the Bridge read `db.snapshot({ ledger })`, a `{ ledger }` option on
   `db.get`, `db.list`, `db.subscribe`, `db.getMine` and `db.listBy` (read only; a write with another ledger is
   `E_POLICY`), and the push event `hub` (`{ type: 'change' | 'follow' | 'unfollow' | 'state', data }`). Follow caps
   250 (phone) and 1,000 (computer) as R 3.2.3 chose. Ledger ids are validated as `mw1:` + 27 base64url or `btih:` +
   40 hex (`E_BAD_REQUEST`). Only mounted in hub mode; drop-in pages answer `E_UNSUPPORTED`.
2. **Classes of the R 2.11.2 names INTERFACES leaves unclassified.** Reads: `db.getMine`, `db.listBy`,
   `chat.requests.list`, `chat.contacts.verify`, `files.preview`. Writes: `chat.disable`, `chat.contacts.add/remove/
   block/unblock`, `chat.requests.accept/decline`, `chat.dm.keepHistory`, `chat.room.join/leave`, `files.fetch`,
   `files.stopSharing`, `files.pinRequest`, `media.pinRequest`. UI: `auth.signOut` (with `forget: true` only),
   `chat.contacts.list` and `chat.dm.history` (first call per session, as R 2.11.2 says), `files.enable` and
   `files.remove` (the files service treats them as UI, docs/deviations/media.md item 18). `test/unit/sdk-v03-tables`
   checks that the tables are exactly INTERFACES v0.3 plus v0.2.1 plus this list.
3. **The `wait` transport push.** A request that waits for the person (a card, the identity page, a guest's sign-in
   prompt) is kept alive by `{ event: 'wait', data: { id } }` from the Bridge every 20 s (`WAIT_PUSH_MS`); the SDK
   restarts the request's 30 s timer on each one, at most 10 minutes (`waitTimeoutMaxMs`). It is a transport message
   (`TRANSPORT_EVENTS`), not a site event. UI methods also get an AbortController, as writes do.
4. **Gating order.** Unknown or loader-only (`E_BAD_REQUEST`), shape (`E_LIMIT`), host-only (`E_HOST_ONLY`, before any
   card or request), the click (`E_NEEDS_GESTURE`), a read-only hub ledger (`E_POLICY`), the write rate (`E_RATE`), then
   the service. So a call that fails both the click and a service rule reports `E_NEEDS_GESTURE` (a reader's
   `mod.ban` without a click), where the services alone would report their rule first.
5. **MF-27, `db.tombstone` of another author's entry** is a conditional UI method: a click, then the loader's card
   (today lane ui's `confirm` card with the sdk lane's text "Remove this entry for everyone?", danger style), else
   `E_NEEDS_GESTURE` or `E_USER_CANCELLED`. One's own entry stays a plain write. The author is looked up in what this
   browser holds (the DAG, the state, a follower's snapshot); an entry it does not hold is left to the ledger node.
6. **`consent.request` needs no click at the SDK boundary** (`GESTURE_EXEMPT`): its v0.2.1 behaviour (the card takes
   the person's click, a 10 s cooldown after a card closed undecided) is kept; the drop-in tests depend on it.
7. **`identity.mode` 'legacy'** names the 0.2.1 per-site key in a build without the identity service; `ready().identity`
   always carries `mode` (R 2.11.2 shows `{ pub, short, name, mode }`).
8. **`owner.policy`** is a write that the identity page confirms for the owner of a personal site (R 3.3); elsewhere
   `E_NOT_OWNER`. The standalone SDK (no magnet-web on the page) keeps the v0.2.1 answer `E_NOT_OWNER`, and the static
   stub keeps it as INTERFACES F7 says.
9. **Error strings.** Every code maps (`ERROR_STRING_KEYS`) to a key of lane ui's `ERROR_TEXT` in English and French.
   The 29 codes R 2.11.2 adds map to themselves; seven older codes without a sentence of their own point at the
   nearest one: `E_NOT_OWNER` and `E_NOT_MODERATOR` to `E_POLICY`, `E_IDENTITY` to `E_NOT_SIGNED_IN`, `E_NO_HOST` to
   `E_UNSUPPORTED`, `E_CAP` to `E_LEDGER_FULL`, `E_INTERNAL` to `E_BAD_REQUEST`, `E_TIMEOUT` to `E_SYNCING`.
10. **Features.** `ready().features` from `_mw.cfg` (R 2.5.5): every feature off unless set; `records` is true only for
    `'sealed'` (or `{ mode: 'sealed' }`).
11. **Grants.** A chat message that carries a grant shows the site only `{ grant: { t } }`, in `chat` pushes and in
    `chat.dm.history` results; the grant itself goes to the media (`media`, `revoke`), files (`file`) or moderation
    (`report`, `join`, `pin`) service.
12. **Follower tabs.** No service is mounted and no key is held there; service methods answer `E_POLICY` ("use the first
    tab"), a guest's write `E_NOT_SIGNED_IN` without a prompt. The engine tab's auth state reaches them in its `state`
    messages (`auth`, `mode`), and `signed-out` (tab channel and `BroadcastChannel('mw-identity')`) drops it. A page whose
    engine never started (no pointer, engine off) counts as the engine tab: its methods answer `E_UNSUPPORTED`.
13. **`files.fetch` over the port** answers `{ handle, name, size, mime, blob }` with the Blob typed
    `application/octet-stream` (functions cannot cross a MessagePort); the SDK gives the site the R 2.11.2 shape
    `{ handle, name, size, mime, stream(), blob() }` again. The drop-in binding returns the service's object directly.

## Contract-first adapters (thin code against a documented contract; each is a request below)

- `setNodeIdentity(node, identity)` (api.js): sign-in and sign-out change the identity an open ChainNode signs with,
  without reopening the ledger. Uses `node.setIdentity(id)` when it exists; otherwise sets the private `_identity` (as
  the constructor does) and forgets the own-chain hints. Checked against the real ChainNode in
  `sdk-v03-wiring` (a guest cannot write, the bound working key signs, sign-out takes it away).
- `writeControl(node, op, opts)` (mod.js): control blocks from the browser (`unban`, `ban.until`, the bulk tombstone,
  `allow`, `policy`). Uses `node.writeControl` or `node.control`, then `ban`/`tombstone` for the v1 forms, then `_write`;
  `E_UNSUPPORTED` otherwise.
- `nodeIdentityOf(keys)`: what ChainNode signs with is `keys.identity` (`{ privateKey, pub }`, non-extractable) from
  WorkingKeys; keys with only `sign(bytes)` cannot sign blocks (createBlock needs a private CryptoKey: `E_IDENTITY`).
- `workingKeysOf(service)`: `keys()`, then `workingKeys`, then `current().keys`.
- Owner actions (`ownerConfirm` in app.js and engine.js): `service.ownerAction(card)` when lane idp adds it; otherwise
  `client.signIn({ owner: { what } })` or `{ create: true }` (client.js accepts both).
- Personal-site genesis: `ChainNode.genesis({ signer, policy, keyinfo, chain, ledgerId, now })` (landed in lane
  chain-net) is used; without it `genesisBlocks` makes the same two blocks (seq 0 and 1, the full policy op). The
  bundle's recovery commitment and next-key commitment are read as `keys.rc` (or `recoverCommitment`) and
  `keys.nextPubHash` (or `nx`), and in the shell also from the owner action's bundle; without them `E_UNSUPPORTED`.
- The hub follow lane (app.js): `MultiGossip`, `recent.js viewOf`, `wire-ext attachToTorrent(... { name: 'mw_chain2',
  kind })` from lane chain-net, joined with `TorrentManager.joinLane({ kind: 'group' })` because `joinLane` accepts only
  `'chat'` and `'group'` today.
- `sealedAdapter(sealed)`: `seal` and `open` in the media lane's shape; `sealTo` (durable grants) answers
  `E_UNSUPPORTED`, so grants travel as chat messages.
- Drop-in identity: lane idp's `createDropinIdentity` (src/dropin/identity.js) with the build's client and WorkingKeys
  (`deps.v03`), the page window's BroadcastChannel as `channelFactory`, its `boot()` (deferred redirect answer, then
  "Stay signed in" restore, waited for at most 3 s before the ledger opens as a guest) and `completeRedirect()` on
  `/_mw/idp-return`.
- 0.2.1 key migration: the identity service's `legacy` deps (shell: app.js `legacyDeps`; drop-in: lane idp's
  `legacyAccess` with the engine's `writeLegacyItem`, which signs the `mw.link` item with the 0.2.1 key through
  `createBlock` and `node.ingest`), and `migrate.legacyAuthorFor({ policy, newPub, legacyPub })` for an `allow` site that
  still lists only the old key (HON M9).
- PSL check of a subdomain hub: `src/idp/psl.js` `PSL_RULES` through harden.js `pslHubCheck`.

## Requests to other lanes

- **chain-net**: `ChainNode.setIdentity(identity | null)` (replaces the `_identity` adapter); a public control writer
  `writeControl(op, opts)` for `unban`, `ban.until`, the bulk tombstone, `allow` and `policy`.
- **harden-loader / torrent**: `TorrentManager.joinLane({ kind: 'hub' })` with the hub lane's own wire budget, instead of
  joining as `'group'`.
- **idp**: `service.ownerAction(card) -> boolean` for policy, checkpoint, withdraw, delete and create-page, so loaders
  stop calling `client.signIn` for owner actions; a `keys.rc` and `keys.nextPubHash` on WorkingKeys from the bundle.
- **ui**: sentences of their own for `E_NOT_OWNER`, `E_NOT_MODERATOR`, `E_IDENTITY`, `E_NO_HOST`, `E_CAP`, `E_INTERNAL`
  and `E_TIMEOUT`; a card kind `mod.tombstone` (MF-27, one entry); the `PROMPT_TEXT` sentences in api.js (contacts,
  history, share, delete, report, owner action, tombstone) moved to strings.js; the loader-too-old and owner-change
  delay texts app.js shows inline in English. The chat panel widget expects `from` objects and room messages on
  `'message'`, while the chat service emits `'room'` and `from` strings. Request 2 of docs/deviations/ui.md: the drop-in
  engine sends `identity.legacy: true` only in a build without the identity service; with it the 0.2.1 key moves at the
  first sign-in (R 2.2.7) and the panel shows "Open identity page" (`openIdentity` is handled). Request 3: app.js sends
  `v03: true`.
- **chat**: `groupMembers(groupId)` for `media.share({ to: groupId })`; a sealed box per recipient for durable grants.
- **integrator**: `package.json` `version` 0.3.0 (`v021-integration` now expects 0.3.0; `CONFIG.version` and
  `SDK_VERSION` already are). The drop-in bundle `_mw/mw.js` is 738,816 bytes in a scratch build (`node build.mjs`, esbuild 0.28.2):
  esbuild inlines the dynamic imports of the services into the one output file, so evaluation stays lazy but the
  bytes are not; code splitting would be a build change. Left to the integrator as the brief says: E-ID-1 to E-ID-15,
  E-CH-*, E-FI-*, E-MD-*, E-SO-*, the 25/26 regressions and the e2e harness.

## Test changes (intended changes to existing tests)

- `dropin-engine.test.mjs` ("identity export and import from the panel Settings"): the settings identity model also
  carries `legacy: true` in a build without the identity service (the panel shows Export and Import only then).
- `dropin-mw.test.mjs` ("createDeps"): the loaders include `v03`; the test also checks `chain.createBlock` and the v0.3
  modules (identity client and store, chat, files, media).
- `dropin-binding.test.mjs`: the surface is the R 2.11.2 one (with the hub amendment); `identity.current()` and
  `ready().identity` carry `mode: 'legacy'` and `ready().auth`; `mod.ban` is a UI method (a click and the moderator
  card; `E_NEEDS_GESTURE` without a click, `E_USER_CANCELLED` when the card is declined, `E_NOT_MODERATOR` for a reader
  after a click); `setup()` takes `activation` and `prompt`.
- `sw-sdk.test.mjs`: the facade's `identity` has `current`, `setName`, `backupStatus`, `openIdentity`;
  `ready().identity` carries `mode`; without a click `mod.ban` is `E_NEEDS_GESTURE` over the Bridge, and a new test
  checks `E_NOT_MODERATOR` with a click (`shell()` takes `activation`).

## Found by the new tests and fixed here

- `featuresOf` gave `records: undefined` without `_mw.cfg.records`.
- A drop-in page whose engine never started answered "use the first tab you opened it in" (it counted as a follower).
- `genesisBlocks` called `ChainNode.genesis` with `site` instead of `ledgerId` and `chain`, which would have minted the
  genesis for another ledger; it now passes the contract's names and refuses blocks for another ledger.
- The chat service got host-only as a snapshot at mount time; it now reads it live (the chat service accepts a
  function).
- The shell's signed-in header showed 'private' for a linked identity: `identity.current()` gives the site form
  ('same'), the header mapping expected the WorkingKeys form ('linked'). `siteModeOf` (api.js) now takes either, and
  follower tabs show the engine tab's mode instead of a fixed one.
