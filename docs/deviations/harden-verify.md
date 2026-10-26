# harden-verify (v0.2 -> v0.2.1 verifier): notes, fixes and CHANGELOG-worthy changes

Brief: run `node build.mjs`, `npm test`, `npm run test:browser`, `npm run test:e2e` after the three hardening
implementers (formats, network, serving-publishing); fix integration breakage between their changes
(INTERFACES.md wins); confirm the v0.2.1 marks in ARCHITECTURE.md and INTERFACES.md; add a Status column to
`docs/review/DIGEST-AMENDMENTS.md`; update `docs/INTEGRATION-STATUS.md`. Progress log newest last (the session
can be cut off).

## Progress log

- 13:52 ET baseline after the implementers: `node build.mjs` OK (15 files, webtorrent bundle patched by the
  three B3 patch points); `npm test` lint-floor clean (58 files), 819 unit pass, 0 fail (7.1 s);
  `npm run test:browser` 28 pass, 1 skipped (v0.1 `sw-browser`, unchanged; Firefox still not launchable here);
  `npm run test:e2e` 23 of 23 PASS in 96.8 s, network policy PASS.
- 13:58 ET `node test/e2e/run.mjs --webkit`: 24 of 24 PASS in 96.6 s (W7 included); `npm run test:example` 29 pass.
- 14:00 ET integration review (reading the three reports against INTERFACES/ARCHITECTURE and the code) found these
  cross-agent gaps, fixed below in small steps:
  1. `publish --aud` accepted only one of `general|kids|sensitive`, while ARCHITECTURE §4/§8 and the loader's
     consent rule (`consentModeFor`, `config.consent.gateAudiences`) expect a token list including `personal`,
     `eea`, `uk`, `qc`: an owner could not declare the audiences that make the gate the default (C1).
  2. Drop-in C1 was not implemented (no agent owned `src/dropin/*` for C1): the notice had no same-layer refusal,
     `aud=` did not force the gate, and the choice was the v0.2 bare string per ledger, not the versioned record.
  3. Shell `ui.js` buttons did not ignore script-made clicks, although INTERFACES (A4 UI hooks) requires it for
     the consent decision and identity export/import (the formats agent's open item 1).
  4. Shell `mw.consent.request()` never settled when the visitor closed the card without a choice ("Not now",
     gate Cancel), so `ConsentRequests` kept that promise forever (INTERFACES: it resolves `pending`).
  5. Drop-in pages had no B7 offer-timeout wrapper (only the shell installed it before importing the bundle).
  6. Display fallbacks still cut tagged keys with `slice(0, 8)` (`p256:abc`): `tools/check-site.mjs`,
     `src/dropin/ledger.js`, `src/loader/app.js` (A2; the formats agent's open item 3).
  7. `CONFIG.version` still said 0.2.0 while the formats are v0.2.1 (SDK_VERSION 0.2.1).
  8. (found while fixing 1) `publish.mjs` still computed `anchorBtih` as the infohash of the v0.2 one-piece anchor
     torrent and told owners to allow it on their tracker, while the loader now announces the B2 rendezvous
     infohash: a tracker started with `--allow summary.json` (and `tools/demo.mjs`, which does exactly that)
     refused the ledger swarm. The e2e stack runs an open tracker, so nothing failed.
- 14:03 ET fixed 1, 6, 7, 8: `publish --aud` takes a comma list of `AUD_TOKENS` (pointer.js `AUDIENCES` plus
  `config.consent.gateAudiences`), normalised, error text still starts "--aud must be"; summary.json and the
  publish result gain `rendezvousBtih` (= `rendezvousInfoHash(ledgerId)` from `src/loader/torrent.js`), and
  `anchorBtih`/`anchorInfoHash()` stay one release as deprecated aliases holding the same value; `tracker.mjs`
  reads `rendezvousBtih`; `check-site` prints fingerprints (`keyLabel`), drop-in and shell fallbacks use
  `shortKey()`; `CONFIG.version` and `TOOLS_VERSION` are 0.2.1. New `test/unit/v021-integration.test.mjs`
  (3 tests). `npm test`: 822 pass, 0 fail.
  9. (found while fixing 3) `tools/live.mjs acceptConsent` (used by `pin.mjs`, `snapshot.mjs --consent`,
     `check-site --headless --consent`) still looked for "OK" or "Load", the v0.2 labels: after C1 the shell's
     card says "Share and load", so the pinned node never gave consent and never shared the site or the ledger.
- 14:08 ET fixed 3, 4, 9: shell `ui.js` exports `trustedOnly()` and builds every decision with it (first-run card,
  gate, v0.2 notice, "Change your sharing choice", identity export and import); `app.js` gains `ConsentWaiters`:
  a choice settles waiting `mw.consent.request()` calls with the state, "Not now" and gate Cancel settle them
  with `pending` (so `ConsentRequests` applies its 10 s cooldown instead of holding one promise forever);
  `tools/live.mjs` exports `CONSENT_ACCEPT_LABELS`/`CONSENT_ACCEPT_RE` (from STRINGS) and clicks with Playwright
  (trusted); the e2e helpers `acceptConsent` and `clickGateButton` click with the mouse (new `clickShellButton`),
  PEER-CONSENT gained the step "a script click on Share and load is ignored". Tests: 3 more in
  `v021-integration.test.mjs`. `npm test` 825 pass; `node test/e2e/run.mjs` 23 of 23 PASS (99.4 s).
- 14:13 ET fixed 2 and 5 (drop-in C1 and B7): the pure consent rules moved from `app.js` to the new
  `src/loader/consent.js` (`consentModeFor`, `recipientsKey`, `makeConsentRecord`, `consentFromRecord`,
  `dnsAllowedBy`, `consentKeyFor`, `audienceOf`; `app.js` re-exports them, so the existing tests are unchanged).
  The drop-in engine uses them: `aud=` forces the gate (`consentMode()`), the choice is the versioned record under
  the per-origin key `consent` (`consentRecordFor()`, `inspect().consentRecord`), and a v0.2 string, another
  version or other recipients are asked again. `panel.showConsentCard()` is the first-run card with the shell's
  strings: [Share and load] [Load from host only] (both primary) [Settings]; its prompt kind stays `notice`.
  `src/dropin/mw.js createDeps().webtorrent` installs `installOfferTimeout` on the window before importing the
  bundle. Tests changed with the amendment (C1): `dropin-engine` (the card's button is "Share and load", stored
  consent is the versioned record; 7 presets/asserts via the new `consentPref()`/`storedConsent()` fixtures in
  `dropin-fakes.mjs`) and `dropin-engine-tabs` (same); e2e 10B clicks "Share and load" (`rectOf`), checks the
  same-layer refusal and the record; `EXPECTED.md` checks 6 and 7 reworded. New tests: 3 in `dropin-engine`
  (aud gate, host-only card, re-ask rules), 1 in `dropin-panel`, 1 in `dropin-mw` (B7). `npm test` 830 pass.
- 14:15 ET full e2e: 22 of 23; PEER-BLIP failed once ("both back on the tracker: not reached within 6000 ms"),
  then passed 8 of 8 alone (re-announce 0.6 to 1.5 s). Not caused by these changes (shell trackers untouched).
  Added failure diagnostics to PEER-BLIP (client-side announces and sockets after the drop against what the
  tracker processed). Suspect: bittorrent-tracker's socket pool (an instance that attaches to a pooled socket
  that is still connecting gets no 'connect' callback, so it never re-announces) meeting the shim's short
  0.5 to 1.5 s reconnect window; under investigation.
- 14:26 ET PEER-BLIP root cause found, and two real B1 bugs under it:
  10. The scenario dropped nothing: `http.Server.closeAllConnections()` does not reach upgraded sockets (checked in
      Node 24 with a bittorrent-tracker client: still connected 500 ms later). It passed because each visitor's
      ledger rendezvous join (0 to 1.5 s jitter) announced after the "drop", and failed when both joins came
      before it. `tools/tracker.mjs` now tracks live WebSockets: `dropConnections()` terminates them (keeps
      listening), `liveConnections`, and `close()` really ends them (it relied on `ws.clients`, which is empty with
      `clientTracking: false`). PEER-BLIP waits until both visitors announced both swarms, drops for real (asserts
      at least 2 sockets), and requires both swarms of both visitors to re-announce: 1.3 to 1.6 s, 5 of 5.
  11. Shim bug (B1): bittorrent-tracker registers 'connect' only on a socket it creates, so a tracker instance whose
      reconnect timer fired while the other instance's new pooled socket was still connecting (the site torrent and
      the rendezvous swarm share one socket per tracker URL and now reconnect within the same 0.5 to 1.5 s window)
      never re-announced: one swarm went silent on that tracker until a visibility change. `installTrackerShim`
      wraps `_openSocket` and adds the missing hook.
  12. Shim bug (B1): `destroy()` clears the regular announce interval but keeps the id in `this.interval`, and the
      shim's "same interval: do not restart" shortcut then refused to start it again after every reconnect, so the
      periodic announces stopped for good. The shim's `destroy` wrapper forgets the interval it saw.
  New `test/unit/loader-app-tracker-shim.test.mjs` (2 tests) runs the real bittorrent-tracker client against a
  local tracker with manual reconnect timers; each test fails without its fix and passes with it. On loopback the
  e2e rarely hits the pool race (the connect window is milliseconds), so the unit test is the regression test.
  `npm test`: 832 pass, 0 fail.
- 14:30 ET with the shim fixes: `node test/e2e/run.mjs` 23 of 23 (PEER-BLIP both swarms re-announced in 1.6 s) and
  `--webkit` 24 of 24 (1.5 s). Then:
  13. A4 completed for drop-in: the panel's Settings has Export / Import identity (passphrase fields, file input;
      the shell's file format and strings), shown when `settingsModel().identity` is set (a moderator identity is
      not exported); `engine.changeSetting('exportIdentity' | 'importIdentity')` uses the engine's loader-only
      `identityApi()` and `downloadText()`. Buttons go through the panel's trusted-click guard.
  14. E5 (publish output): `publish --dropin` prints `egressNote(copyBytes)`: each unmetered drop-in visitor
      completes the whole copy from the host once, budget egress for copies (13.3x in the measured example).
      [Post-wave fix, 2026-10-20: 13.3x is the model of research w2a-07 F21, not a measurement; the note now says so.]
  15. D3 (docs): RUNBOOK §11 gained what visitors see (about 3 s after the next navigation), the
      `Clear-Site-Data: "storage"` last resort with what it deletes, and the per-release drill.
  16. F8 (docs): DESIGN-REVIEW S7 and security.md M10 carry the correction (npm >= 11.19 reads `allowScripts`
      as a working default-deny).
  Tests: 2 more (`dropin-panel`, `dropin-engine` identity), 1 more in `v021-integration` (E5). `npm test` 835 pass;
  `npm run test:browser` 28 pass, 1 skipped.
  17. (found while reviewing 11) `TorrentManager.kick()` reopened every instance flagged `reconnecting`, including
      one already attached to a pooled socket that is still connecting (the state 11 leaves for a moment, and the
      state the unfixed race left for good): bittorrent-tracker then counts it twice in its socket pool, so after
      the next blip the closed socket stays pooled and every instance attaches to a dead socket that never connects
      or closes (and listeners double). Likely on phones, where `online` and `visibilitychange` arrive together.
      `kick()` now skips an instance that has a socket and is not destroyed. Tests changed with the fix: the two
      kick tests in `loader-app-torrent` model the library's destroy (socket null, destroyed) before the reconnect
      timer; new test "kick() never reopens an instance already attached". `loader-app-torrent` 72 pass.

## Decisions and deviations (with reasons)

1. **Drop-in C1 implemented by the verifier.** No implementer owned `src/dropin/*` for C1, yet ARCHITECTURE §8
   (as amended) says per-domain and drop-in show the same first-run card. The rules moved to a shared pure module
   (`src/loader/consent.js`) instead of being copied; `app.js` re-exports them so no shell test changed.
2. **The drop-in card keeps prompt kind `notice`** (the engine's state machine and `consentPromptRequested()` key
   on it) and `panel.showNotice` stays for v0.2 callers; the engine falls back to it when a panel lacks
   `showConsentCard`.
3. **A v0.2 drop-in choice is asked again**, as in the shell: the card changed, and the record now names its
   recipients. Pre-release, so no migration.
4. **Shell click guard scope.** INTERFACES requires the consent decision and identity export/import to ignore
   script clicks; those buttons (and "Change your sharing choice") are guarded. The share and host-only switches,
   Forget and the moderator import stay ordinary controls (a script flipping them grants nothing; scenario 12
   drives the share switch with script clicks because an error card may cover the bar).
5. **`--aud` vocabulary.** publish accepts `pointer.js AUDIENCES` (content audience) plus
   `config.consent.gateAudiences` (consent tokens) instead of changing the formats agent's `AUDIENCES` constant
   (and its frozen test). The error text still starts "--aud must be", so the serving-publishing test is unchanged.
6. **`anchorBtih` kept one release** with the rendezvous value (not the v0.2 anchor-torrent hash), so trackers
   started from older summaries or tools reading the old key admit the swarm visitors actually announce.
7. **Drop-in runs no STUN probe** (B7): the engine lives for one page view and has no diagnostics panel; the
   1.5 s offer timeout bounds a dead STUN server. Noted in ARCHITECTURE §8.
8. **PEER-BLIP rewritten, not patched**: the old version could not detect a broken shim (it dropped nothing). It now
   needs `tracker.dropConnections()`, so `tools/tracker.mjs` (tools owner) gained live-socket tracking; `close()`
   also ends live sockets now (it relied on `ws.clients`, always empty with `clientTracking: false`).
9. **Kick tests changed with the fix**: the fake tracker in two `loader-app-torrent` tests now models the library's
   `destroy()` before the reconnect timer (socket null, destroyed), which the stricter `kick()` relies on.

## CHANGELOG 0.2.1 (draft for the release notes; all agents)

Breaking (pre-release formats frozen now; v0.2 data does not carry over):
- Public keys are written `p256:` + base64url everywhere (blocks, pointer `owner=`, lists, HELLO, SDK); untagged
  keys are refused. Ledger ids change (they hash the tagged owner). (A2)
- Payload blocks carry a salt `z`; `vh = sha256("mw-vh-v1\n" + z + "\n" + canonical(v))`; a redacted stub reveals
  nothing guessable. Unknown op names are rejected at ingest and not relayed; `checkpoint`, `vanish`, `grp` are
  reserved. Golden vectors under `test/vectors/` are append-only. (A1, A2)
- `window.mw` has no `identity.export`, `identity.import` or `consent.accept`; `mw.consent.request()` opens the
  loader's card and resolves with the visitor's choice (`pending` if closed without one). Export and import live in
  the shell's Settings and in the drop-in panel's Settings only; both ignore script-made clicks. (A4)
- Consent is a versioned per-origin record; v0.2 choices are asked again. Shell and drop-in show the first-run card
  [Share and load] [Load from host only]; `aud=` personal/eea/uk/qc (or `consent=gate`) forces the gate; no DoH
  lookup before a choice unless the pointer came by `<meta>`. (C1)
- The ledger swarm is the bare rendezvous infohash `sha1hex("mw-ledger/1/" + ledgerId)`; `summary.json` names it
  `rendezvousBtih` (`anchorBtih` is a deprecated alias for one release). (B2)

Pointer (MW-PTR/1): `st=` fail-closed (anything but `ok` is a withdrawal: every stored version is deleted and the
owner's `why=` shown), `aud=` token list, `ct=`, `lg=`; 450-byte SHOULD and 900-byte MUST budget;
`publish --withdraw`. (A3)

Network: offer-free keepalive announces instead of `scrape`; a fast reconnect shim (about 1 s instead of 10 s to
5 min) that also re-announces swarms sharing a pooled socket and keeps the regular announce interval after a
reconnect; `kick()` on visibility, `pageshow` and `online`; web-seed circuit breaker; unsigned wire length guard
with a buffer watchdog; per-swarm soft/hard wire caps; TURN off, two STUN operators, a STUN probe (shell) and a
1.5 s offer timeout (shell and drop-in); four-class mobile policy with uploads off by default on phones. (B1, B4 to
B7, C2)

Serving: navigation deadline with a self-retrying interstitial and reload-loop guard, keep-alive while streaming,
versioned page/worker protocol module; atomic Service Worker install with `Request.integrity`, navigations fail
open; drop-in rule edits (40 ms cold-start wait, no-store pages host-only, coalesced web-seed downloads, no CSP
meta, `data-cfasync` tag guard, idempotent double inclusion). (D1, D2, D4)

Publishing: web-seed header patch of the vendored bundle (hash-asserted) and a single three-mode verification gate
(`check-webseed`, `publish --verify-ws/--verify-host`, `check-site`); path policy, budget gates with a size report,
secrets and personal-data lint (`--from-wxr`), deterministic packing (`--date`, `--double-pack`), open-ledger
contact warning (`--ct`), `--aud` token list, drop-in egress note, static `/_mw/sdk.js` stub, `data-nosnippet`.
(B3, B4, E1 to E5, F4, F7)

Docs: kill switch runbook (recovery time, `Clear-Site-Data` last resort, drill); DESIGN-REVIEW S7 and security M10
corrected on `allowScripts`. (D3, F8)

## Final state (2026-10-19 14:40 ET)

- `node build.mjs` OK (15 files). `npm test`: lint-floor clean (59 files), 836 pass, 0 fail (about 7 s).
- `npm run test:browser`: 28 pass, 1 skipped (v0.1 `sw-browser`), 0 fail. `npm run test:example`: 29 pass.
- `node test/e2e/run.mjs` on the final code, three runs in a row: 23 of 23 (99.9 s), `--webkit` 24 of 24 (100.0 s),
  23 of 23 (99.2 s); network policy PASS each time; PEER-BLIP 1.0 to 1.5 s after a real drop.
- Docs: ARCHITECTURE (v0.2.1 header, §3.2 C3, §3.3 C4, §3.4.9 C1/A4 drop-in, §5.3, §8 shim and drop-in ICE,
  §10 `--aud`/`rendezvousBtih`/tracker/E5, §12 tests, §14 open items), INTERFACES (header, config version, cache
  prefs, `consent.js`, torrent shim and kick, ui.js guard and card, app.js C1/A4, drop-in card/record/identity/B7,
  tools), DIGEST-AMENDMENTS Status table (24 done, 3 partial, 6 skipped), INTEGRATION-STATUS, RUNBOOK §11 and the
  tracker line, DESIGN-REVIEW S7, security M10, DEVIATIONS.md pointer to the v0.2.1 notes.
- Not committed: the auto-checkpoint loop has not run since 13:49 ET (pid file in `.orchestration/`); the working tree
  holds every change (`git status`).

Open after verification (also in ARCHITECTURE §14 and INTEGRATION-STATUS next steps): Firefox D1 checks (not
launchable here); the floor browsers' treatment of a simple `Range` header (the gate requires the range preflight
until measured); the CI double-pack job (E4); documentation-wave items (E5 in README and DEPLOY, F1 to F3, F5, F6, F4
owner duties in DEPLOY.md); identity files exported before v0.2.1 carry an untagged key and do not import
(pre-release, not migrated); real-device checks of the tracker shim, the probe classes and the lifecycle plan;
`test/unit/sw-browser.test.mjs` (v0.1) still skipped; the ledger id still includes the owner key (a rotation starts a
new ledger; design question carried from v0.2).
