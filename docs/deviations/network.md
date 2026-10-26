# network agent: v0.2.1 hardening notes (B1, B2, B4, B5, B6, B7, C1, C2, C3, C4)

Owned: `src/loader/{torrent,policy,app,ui,strings,config}.js`, new `src/loader/connectivity.js`,
`src/loader/render.js` (consent ordering only), `test/unit/loader-app*.test.mjs`, `test/e2e/run.mjs` (the
malicious-peer constant and the `PEER-*` scenarios). Progress log, newest last.

## Progress

- 12:55 ET: config.js (v0.2.1 keys), policy.js (four-class classifier), connectivity.js (probe, offer-timeout
  wrapper, ICE gating), torrent.js (B1, B2, B4, B5, B6) written; `loader-app-torrent.test.mjs` 71 pass.
- 13:17 ET: app.js (C1 card + versioned record + no DoH before a choice, C2 lifecycle plan, B7 probe and
  offer-timeout wiring, rendezvous), ui.js (first-run card, openConsent/openIdentityExport hooks),
  strings.js; new unit files loader-app-{policy,connectivity,consent,arrival}.test.mjs (39 tests, pass).
  `node test/e2e/run.mjs`: 14 of 14 PASS after two test updates (lib.mjs acceptConsent clicks "Share and
  load"; 10B's ledger swarm is the rendezvous infohash and the metered visitor's peer link is awaited).

## Final (v0.2.1 network done)

All of the brief's items implemented and green:
- B1 tracker keepalive + fast reconnect shim + kick(): `config.wire.keepaliveAnnounceMs` (55 s, replaced
  keepaliveScrapeMs), `installTrackerShim` (per-instance `_startReconnectTimer`, 500 ms + jittered backoff),
  `keepaliveAnnounce` (numwant 0), `TorrentManager.kick()` on visibilitychange/pageshow/online. e2e PEER-BLIP.
- B2 rendezvous: `rendezvousInfoHash` = sha1hex("mw-ledger/1/"+ledgerId); `addRendezvous` (left:1, numwant
  clamp, 0-1.5 s join jitter, glare watchdog, ut_metadata.cancel on its wires); `addAnchor` kept as a
  deprecated alias (and `tm.anchor` getter) for one release; gossip rides both swarms (app.js/dropin attach
  the extension through the 'torrent' event). e2e PEER-RV; the ARCH §14 anchor open item is closed.
- B4 web-seed circuit breaker: 3 failures/30 s per host -> 5 min backoff, visible message, cheapest ws first
  (`orderWebseeds`, page origin first), no re-request within backoff. Precise per-wire attribution PLUS a
  torrent-level fallback (charge the active web seed for an unattributed piece-verification failure when no
  peer wire could have served it) so the breaker is effective in the real browser. e2e PEER-WS.
- B5 wire guard: unsigned prefix read, destroy > 256 KiB before buffering, periodic `_bufferSize` watchdog
  > 512 KiB, fail-closed when the patch point is missing; a unit test fails if `_bufferSize` disappears; the
  e2e malicious peer writes 0x7FFFFFFF. e2e PEER-11.
- B6 per-swarm caps after the extended handshake (content from policy, rendezvous 6/9 desktop, 3/5 mobile),
  lowest score dropped first, numwant 0 at the soft cap, peers by unique peerId excluding web seeds, reqq.
- B7 ICE: TURN off, two STUN operators, `src/loader/connectivity.js` probe (2.5 s, never blocks render,
  gates the ICE list), 1.5 s offer timeout wrapper installed before the bundle import, probe class in the
  diagnostics panel.
- C1 consent before trackers, peers AND the DoH lookup (skipped until consent unless the record came by
  <meta>); versioned record `{ v, choice, dns, day, scope, rcpt }` per origin, re-asked on version/recipient
  change; same-layer refusal card; aud= -> gate default (`consentModeFor`). mw.consent.request() reaches the
  loader card through the Bridge's `ui.openConsent` hook. e2e PEER-CONSENT, FMT-SDK.
- C2 four-class classifier (`classifyNetwork`/`policyClass`, no moz/webkitConnection), uploads off by
  default on every mobile class with a per-origin opt-in, hidden -> lock uploads, visible > 10 s / online /
  pageshow.persisted -> rebuild + re-attach ledger, never beforeunload/unload (`lifecyclePlan`).
- C3 arrival-safety tests for parseFragment (`loader-app-arrival.test.mjs`). C4 no SANDBOX_HUB/HUB_CSP
  remnants (asserted over src/ and dist/).

Existing tests kept green; updated with reasons: `loader-app-torrent.test.mjs` (the keepalive test now
asserts the numwant-0 announce and no scrape; the wire-cap test asserts the soft/hard cap after the
handshake; addAnchor -> addRendezvous). `test/e2e/lib.mjs` `acceptConsent` also clicks "Share and load".
Scenario 10B's ledger swarm is the rendezvous infohash and its metered visitor's peer link is awaited.

Toolchain gates at finish: `node build.mjs` OK (58 files lint-floor clean); `npm test` 819 unit pass, 0
fail; `npm run test:browser` 28 pass, 1 skipped (v0.1 sw-browser); `node test/e2e/run.mjs` 23 of 23 PASS.

Coordination with the other hardening agents (shared ARCH/INTERFACES/e2e): the formats agent owns the SDK
surface (A4) and documented `ui.openConsent()`/`ui.openIdentityExport()`; I implement them in ui.js and pass
them to the Bridge from app.js. The serving-publishing agent owns B3/D-items and the `scenarios-serving.mjs`
e2e; the full suite runs all of it together (SW-INSTALL, PUBLISH-WS, FMT-SDK, FMT-WITHDRAW + my PEER-*).

Not done by this agent (out of scope / other owners): the B3 bundle header patch and the publish/doctor
verification gate (serving-publishing); the A1/A2/A3 block and pointer formats (formats); DIGEST-AMENDMENTS
"Status" column (the verifier reconciles after all three implementers).
