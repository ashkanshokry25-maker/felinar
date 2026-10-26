# formats agent (hardening v0.2 -> v0.2.1): notes and deviations

Brief: DIGEST-AMENDMENTS A1 (salted value hash), A2 (algorithm-tagged keys, reserved op names,
unknown-op rule, golden vectors), A3 (pointer size budget, st= fail-closed, why=, aud=,
publish --withdraw), A4 (site-callable SDK surface).

Baseline (2026-10-19 12:40 ET): `npm test` 675 pass, 0 fail.

## Progress log (newest last; the session can be cut off)

- 12:38 ET plan written; nothing changed yet.
- 12:45 ET A2 keys: `src/chain/crypto.js` emits and accepts only `p256:<87 b64url>` (92 chars); untagged
  keys are refused ("must be algorithm-tagged"), unknown tags give "unsupported key type: <tag>";
  `fromUntaggedP256()` exists only for v0.2 fixtures and locally stored identities. HELLO owner must be
  tagged (`OWNER_KEY_RE` in gossip.js). Tests updated where they asserted the untagged shape
  (chain-core-crypto, dropin-identity, dropin-engine, tools-ledger; reason: the amendment).
- 12:50 ET A1 salted vh: `block.z` (22-char b64url, 16 random bytes), `vh = sha256("mw-vh-v1\n" + z +
  "\n" + canonical(v))`, z travels exactly with v (dag, node, stores, gossip, redact, dropValue);
  `blockBytes` and `maxBlockBytes` count the 22 bytes of z; `dag.valueBytes` stays canonical(v)
  only (the maxValueBytes rule must match `admit`). Unknown op names give the new reason
  `unknown-op` (also in gossip INVALID_REASONS).
- 12:55 ET A3 pointer: st/why/aud/ct/lg parsed and signed; fail-closed status; budget constants;
  `withdrawalRecord()`; `magnetFromRecord` throws E_WITHDRAWN; `verifyPointer` results carry
  `status` and `withdrawn`. `publish.mjs --withdraw` implemented in the new `tools/withdraw.mjs`
  (publish.mjs only dispatches), so a concurrent rewrite of publish.mjs cannot lose it.
- 12:58 ET golden vectors: `test/vectors/{pointer,block,hello}.json` (28 vectors) + `LOCK.json`
  (append-only hash chain); `test/unit/formats-vectors.test.mjs` freezes the chain head (FROZEN) and
  fails on any edited, removed or unlocked vector (checked by editing one byte: the test failed).
- 13:15 ET A4 SDK surface: `identity.export`, `identity.import`, `consent.accept` removed from
  `src/sdk/sdk.js`, `src/loader/bridge.js`, `src/loader/api.js` (shared table) and
  `src/dropin/binding.js`; `mw.consent.request()` added (ConsentRequests in api.js: decided state at
  once, one card for concurrent calls, 10 s cooldown after an undecided close, never grants). Drop-in:
  `ConsentState.request()` + `DropinEngine.consentPromptRequested()` show the panel card; the panel
  ignores untrusted events. e2e 10B step (8) clicks the notice's OK for the metered visitor instead of
  calling `window.mw.consent.accept()` (reason: A4 removes the call).
- 13:20 ET docs: ARCHITECTURE §3.4.9, §4, §5.8, §6.1, §6.6, §9, §12 and INTERFACES (crypto, pointer,
  block, dag, gossip, stores, bridge, api, ui hooks, mw.js, sdk, tools) marked v0.2.1.
  `npm test`: lint-floor clean (56 files), 758 unit pass, 0 fail.
- 13:30 ET A3 loader side (nobody else had it): `src/common/withdrawal.js` (`purgeWithdrawn`,
  `withdrawalNotice`); shell `app.js` shows the withdrawal at boot (no frame, every stored version
  deleted) and applies one found by the page-tag check or the DNS re-check at once (`withdrawNow`);
  drop-in `engine.js` goes off with reason `withdrawn`; `sw/core.js` neither maps nor keeps a page
  stamped with a withdrawal. New e2e scenarios FMT-SDK and FMT-WITHDRAW (`test/e2e/scenarios-formats.mjs`)
  pass; golden vectors also verify in Chromium 156 and WebKit 27.2 (`chain-core-browser`).
  `npm test`: lint-floor clean (58 files), 815 unit pass, 0 fail. `npm run test:e2e`: 21 of 23 pass;
  the 2 failures are the network agent's PEER-BLIP and PEER-WS, still in progress (debug output in them).

- 13:37 ET final: `npm test` lint-floor clean (58 files), 819 unit pass, 0 fail; `npm run test:browser` 28
  pass, 1 skipped (v0.1 sw-browser, as before); `npm run test:example` 29 pass; `npm run test:e2e` 21 of 23
  (FMT-SDK, FMT-WITHDRAW and every v0.2 scenario pass; PEER-BLIP and PEER-WS, the network agent's, fail
  while that work is in progress). Added `test/unit/tools-pointer-budget.test.mjs` (900-byte refusal,
  450-byte warning).

## Decisions and deviations (with reasons)

1. **vh formula.** The normative amendment text wins over the digests' byte-concatenation variant:
   `vh = hex(sha256(utf8("mw-vh-v1\n" + z + "\n" + canonical(v))))` with `z` the 22-character base64url
   string (RD D31 and w2c-02 §3.2 write `"mw-vh-v1\n" || bytes(z) || canonical(v)`). The newline after `z`
   and the textual `z` make the hashed text unambiguous; golden vectors pin it (`test/vectors/block.json`).
2. **z counts toward the block size** (`maxBlockBytes` and `blockBytes`: canonical(e) + canonical(v) + 22),
   as w2c-02 §3.2 says. `dag.valueBytes(h)` stays canonical(v) alone because `state.js` compares it with
   `maxValueBytes` and must agree with `admit` (which never sees z).
3. **`unknown-op` is a new validateBlock reason** (an unknown `op.t` used to be `op`); it is in gossip's
   INVALID_REASONS, so a peer that keeps sending them is ignored like any sender of invalid blocks. Test
   `chain-core-block` "'op' and 'limit' rejections" changed with the amendment (`{ t: 'nope' }` moved to the
   new unknown-op assertions).
4. **Reserved names.** The amendment reserves the five control ops; `FUTURE_CONTROL_OPS = ['checkpoint',
   'vanish', 'grp']` (IMPROVEMENTS-DIGEST D9, w2c-02 R6) are reserved too and rejected as `unknown-op` in v1.
   `RESERVED_OP_NAMES` lists all eleven.
5. **HELLO owner.** The codec accepts `null` or any algorithm-tagged key (`OWNER_KEY_RE`), so a later
   algorithm is a `(site, owner)` mismatch (detach), not a malformed frame; an untagged owner is malformed.
6. **Untagged keys** are refused on every input path. `fromUntaggedP256()` is used only by tests and by
   `ChainNode` for the LOCAL identity of a browser that stored it before v0.2.1 (same key, tagged
   spelling); never for anything from peers, pointers or files. `ledger-admin.mjs` refuses untagged keys
   with a hint ("write p256:..."). Ledger ids now hash the tagged owner, so every v0.2 ledger id changes
   (pre-release, accepted).
7. **Pointer keys.** `st`, `why`, `aud` (the brief) and also `ct`, `lg` (PRODUCTION-DIGEST P0-16) are named
   fields; a record built with them in `extra` (before v0.2.1) signs to the same bytes (`LATE_FIELDS`).
   `aud=` is a token list (the network agent's `consentModeFor` reads `personal, eea, uk, qc, sensitive,
   kids`); `pointer.js` only tokenises it (`audienceTokens`), it gives no meaning.
8. **Fail closed, concretely:** any `st` other than `ok` is withdrawn; a withdrawal parses without `btih`
   (read as 40 zeros); `verifyPointer` reports a valid withdrawal as `ok: true, withdrawn: true` (a failure
   would make callers fall back to a cached version); `magnetFromRecord` throws `E_WITHDRAWN`; the worker
   never maps a withdrawn stamp to a stored copy. Expiry, rollback and owner checks apply to withdrawals as
   to any record (only the pinned owner or a valid `rot` with a higher `seq` withdraws).
9. **Size budget enforced in publish**: above 900 bytes publish refuses, above 450 it warns (a realistic
   signed pointer is 537 to 541 bytes, 3 TXT strings). serving-publishing changed `tools-publish`
   "dns.txt" (7 long trackers instead of 8) because of this.
10. **`publish --withdraw`** lives in the new `tools/withdraw.mjs`; publish.mjs only merges the flags and
    dispatches (so the concurrent publish.mjs work could not lose it). Default validity 400 days (an
    expired withdrawal is ignored by fresh lookups, so it should last as long as the grammar allows).
11. **A4 consent.request** answers through `ConsentRequests` (`src/loader/api.js`): a decided state at
    once, one card for concurrent calls, a 10 s cooldown after a card closed without a choice, never a
    grant. The Bridge prefers `ui.openConsent()` and falls back to `consent.request()` (the network agent's
    `consentApi(A).request` already opens its card, so shell mode works without a `ui` option).
12. **Drop-in panel ignores untrusted events** (`event.isTrusted === false`) for every control, so a site
    that captured the closed shadow root cannot click for the visitor. Fake-DOM unit events have no
    `isTrusted` and still work; e2e clicks there are real mouse clicks.

## Files changed outside the listed ownership (all for A1-A4; minimal, commented)

- `src/loader/api.js` (the SDK table shared by the Bridge and the drop-in binding), `src/dropin/binding.js`
  (A4 surface), `src/dropin/engine.js` (`ConsentState.request`, `consentPromptRequested`,
  `withdrawScope`, `inspect().withdrawn`), `src/dropin/panel.js` (isTrusted guard).
- `src/loader/app.js` (withdrawal at boot and from the update channels, `inspect().withdrawn`),
  `src/loader/strings.js` (`withdrawnTitle`, `withdrawnDetail`, `withdrawnContact`), `src/sw/core.js` (one
  line in `keepDocument`), `examples/peer-guestbook/js/app.js` (short id skips the `p256:` tag; still 347 lines).
- Tests: `dropin-identity`, `dropin-engine`, `dropin-binding`, `tools-ledger`, `sw-sdk` (tagged key shape
  and the A4 surface), `sw-core` (one appended withdrawal test), `test/e2e/run.mjs` (10B metered visitor
  clicks OK instead of `window.mw.consent.accept()`; FMT scenarios wired), `examples/existing-site-dropin/
  EXPECTED.md` (text).

## Open items for other owners

1. Shell `ui.js`: the consent card and Settings export/import buttons should also ignore untrusted events
   (A4); today `test/e2e/lib.mjs acceptConsent` and PEER-CONSENT click with `element.click()`, so they would
   have to move to real mouse clicks (as 10B does) when that lands.
2. Drop-in panel has no Export/Import identity controls; `engine.identityApi()` keeps `export`/`import`
   for them (the site can no longer reach them).
3. `tools/check-site.mjs` prints `owner.slice(0, 8)` (now `p256:abc`); `fingerprint()` would match the
   loader. (The `mw.consent.accept()` comments in `src/dropin/rules.js` and `stamp.js` were updated here.)
4. Identity export files made before v0.2.1 carry an untagged `pub` and fail the key-match check on import
   (`importIdentityText` in app.js and dropin/identity.js); pre-release, so not migrated.
5. A withdrawal keeps the ledger database (`mw-chain-*`) and the visitor's identity; only site versions,
   files and offline documents are deleted.
