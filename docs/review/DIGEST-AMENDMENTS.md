# Architecture v0.2.1 amendments from the research digests (2026-10-19)

Normative. These amend `docs/ARCHITECTURE.md` v0.2 and `docs/INTERFACES.md` v0.2 where the four digests
(`docs/research/RESEARCH-DIGEST.md` = RD, `MIGRATION-DIGEST.md` = MD, `PRODUCTION-DIGEST.md` = PD,
`IMPROVEMENTS-DIGEST.md` = ID) produced measured evidence against a v0.2 decision, or found a cheap
freeze-before-release change. Each item names the digest section that holds the evidence and the detail;
implementers read that section before coding. Items marked DOCS are for the documentation wave; items marked
ROADMAP are deferred to `docs/ROADMAP.md`. Everything else is code for the hardening batch.

## Status after the v0.2.1 hardening (2026-10-19)

Filled in by the verifier (harden-verify) after the three implementers (formats, network, serving-publishing)
and the integration fixes; details and evidence in `docs/deviations/{formats,network,serving-publishing,harden-verify}.md`
and `docs/INTEGRATION-STATUS.md`. "done" = implemented (written, for a DOCS item), documented in ARCHITECTURE/INTERFACES
with a v0.2.1 mark and, for code, covered by a regression test; "partial" = the code part is done and a named remainder belongs to a later wave;
"skipped" = DOCS or ROADMAP items left to the documentation wave or `docs/ROADMAP.md` by design.

| Item | Subject | Status | Owner | Evidence and remainder |
|---|---|---|---|---|
| A1 | Salted value hash | done | formats | `block.z`, `vh = sha256("mw-vh-v1\n" + z + "\n" + canonical(v))`, dropped with `v`; golden vectors `test/vectors/block.json` |
| A2 | Tagged keys, reserved ops, unknown-op rule, golden vectors | done | formats, verifier | `p256:` keys everywhere, `unknown-op` rejected and not relayed, append-only vectors with `LOCK.json`; verifier: display fallbacks use `fingerprint`/`shortKey` |
| A3 | MW-PTR/1 budget, fail-closed `st=`, `why=`, `aud=`, `--withdraw` | done | formats, serving-publishing, verifier | withdrawal purges every version (shell, drop-in, worker), e2e FMT-WITHDRAW; verifier: `publish --aud` takes the token list the consent rule reads |
| A4 | Site-callable SDK surface | done | formats, network, verifier | no `identity.export/import`, `consent.accept`; `mw.consent.request()`; verifier: shell buttons ignore script clicks (`trustedOnly`), undecided card settles `pending`, drop-in panel gained Export/Import identity; e2e FMT-SDK, PEER-CONSENT |
| B1 | Tracker keepalive, fast reconnect, kick | done | network, verifier | numwant-0 keepalive, shim, `kick()`; verifier: shim re-hooks pooled sockets and restarts the interval after a reconnect (`loader-app-tracker-shim.test.mjs`), PEER-BLIP now drops the sockets for real |
| B2 | Ledger rendezvous infohash | done | network, verifier | `addRendezvous`, e2e PEER-RV; verifier: `publish` names `rendezvousBtih` so `tracker --allow summary.json` admits the ledger swarm |
| B3 | Web-seed request header patch | done | serving-publishing | hash-asserted patch points, `build.lock.json` `patched.sha256`, e2e PUBLISH-WS (0 preflights) |
| B4 | Web-seed circuit breaker, single verification gate | done | network, serving-publishing | loader breaker (e2e PEER-WS); `check-webseed` seed/origin/host modes, `publish --verify-ws/--verify-host` |
| B5 | Wire guard details | done | network | unsigned prefix, 256 KiB cap, `_bufferSize` watchdog test, e2e PEER-11 with `0x7FFFFFFF` |
| B6 | Connection discipline | done | network | per-swarm soft/hard caps after the handshake, numwant 0 at the soft cap, unique peerIds, `reqq` |
| B7 | ICE hygiene | done | network, verifier | TURN off, two STUN, `connectivity.js` probe and 1.5 s offer timeout (shell); verifier: drop-in installs the offer timeout before the bundle (no probe in a page-view engine, by design) |
| C1 | Consent before any third party | done | network, verifier | shell first-run card, no DoH before a choice, versioned record (e2e PEER-CONSENT); verifier: drop-in card with same-layer refusal, `aud=` gate, versioned record (`src/loader/consent.js` shared) |
| C2 | Mobile defaults | done | network | four-class classifier, uploads off on mobile with per-origin opt-in, lifecycle plan |
| C3 | Arrival safety | done | network | `loader-app-arrival.test.mjs` (no code change needed) |
| C4 | Remove v0.1 hub flags | done | network | tree-wide assertion test (none left) |
| D1 | Navigation and streaming safety | done | serving-publishing | 25 s deadline, interstitial, reload-loop guard, keep-alive, `protocol.js`; Firefox not launchable here (unit and Chromium only) |
| D2 | Atomic install, fail open | done | serving-publishing | `Request.integrity` from `build.json`, e2e SW-INSTALL |
| D3 | Kill switch runbook (DOCS) | done | verifier | RUNBOOK §11: recovery about 3 s after the next navigation, `Clear-Site-Data` last resort, per-release drill |
| D4 | Drop-in rule edits | done | serving-publishing | 40 ms cold-start wait, no-store host-only, coalesced web seed, no CSP meta, tag guards |
| E1 | Path policy | done | serving-publishing | `publish-policy.mjs lintPaths`; deviation: Windows-reserved characters warn instead of fail |
| E2 | Budget gates | done | serving-publishing | `budgetReport`, printed size report, host profiles |
| E3 | Secrets and PII lint | done | serving-publishing | `lintSecrets`, `--from-wxr` import with dropped-field report |
| E4 | Deterministic pack, double-pack check | partial | serving-publishing | `--date`/`SOURCE_DATE_EPOCH`/git time, `--double-pack`, test; the CI job that packs twice is left to the CI wave |
| E5 | Egress multiplier (DOCS) | partial | verifier | `publish --dropin` prints `egressNote` (copy size, 13.3x example); the unmetered-at-idle default was already the drop-in rule; README and DEPLOY text left to the documentation wave |
| F1 | Compatibility statement (DOCS) | skipped | - | documentation wave |
| F2 | `docs/PRIVACY.md` (DOCS) | skipped | - | documentation wave |
| F3 | Notice-and-action runbook (DOCS) | skipped | - | documentation wave |
| F4 | Owner duties, open-ledger contact warning | partial | serving-publishing | `publish` warns on `writers:'open'` without `--ct`, `--ct/--lg/--aud` signed; DEPLOY.md owner duties left to the documentation wave |
| F5 | Host recipes, roll-forward (DOCS) | skipped | - | documentation wave |
| F6 | CI security baseline (DOCS) | skipped | - | documentation and CI waves |
| F7 | Crawler-inert loader | done | serving-publishing | `data-nosnippet` on the panel host and `#mw-bar`, static `/_mw/sdk.js` stub (`sdk-static.js`) |
| F8 | Correct DR S7 and ARCH §12 test 11 | done | network, verifier | ARCH §12 test 11 uses `0x7FFFFFFF`; DESIGN-REVIEW S7 and `security.md` M10 carry the `allowScripts` correction |
| G | Roadmap items | skipped | - | deferred to `docs/ROADMAP.md` (ROADMAP by design) |

## A. Formats to freeze before the first release (cheap now, expensive later)

A1. **Salted value hash.** `vh = hex(sha256(utf8("mw-vh-v1\n" + z + "\n" + canonical(v))))` where `z` is a fresh
128-bit random value, base64url, carried beside `v` as `block.z` and dropped together with `v` on tombstone.
Never reuse the hashcash nonce as the salt. A redacted stub must reveal nothing guessable about `v`. Golden
vectors in tests. (RD D31, P0-14; ID verdict 5, 7.) Amends ARCH §6.1, INTERFACES `block.js`.

A2. **Algorithm-tagged identity strings and reserved op names.** Public keys in records and blocks are written
`p256:<b64url raw 65 bytes>` (accept untagged as `p256:` for v0.2 inputs only in tests, never emit); control
op names `policy, owner, tombstone, ban, allow` are reserved; an unknown `op.t` is rejected at ingest and the
block is not relayed (unknown-op rule); golden test vectors for pointer, block and HELLO may only be added to.
(ID verdict 5; ID w2c-02 R1, R3, R6; w2c-06 A1-A2.) Amends ARCH §6.1, §4; INTERFACES `crypto.js` callers,
`block.js`, `pointer.js`.

A3. **Pointer grammar: size budget and fail-closed key.** A signed `v=mw1` record is ~515 B and spans 3 TXT
strings; `splitTxt` and `joinTxtData` stay as specified; document the budget and keep the grammar a stated
profile (MW-PTR/1). Reserve `st=` (status): `st=withdrawn` is fail-closed: the loader stops serving and seeding
the scope, clears every stored version (not "keep the previous one"), and shows the owner's `why=` text when
present; unknown `st` values are treated as withdrawn. `publish.mjs --withdraw` writes such a record.
(RD P0-8; PD verdict 6, P0-16; ID verdict 5.) Amends ARCH §4, §5.8 (withdrawal purges all versions),
INTERFACES `pointer.js`, `app.js`.

A4. **Site-callable SDK surface.** Remove `identity.export`, `identity.import` and `consent.accept` from
`window.mw`; add `mw.consent.request()` (opens the loader-owned consent card; resolves with the state). Export,
import and consent live only in loader-owned UI (closed shadow root, `event.isTrusted`, transient activation).
(RD D32, P0-14.) Amends ARCH §9, INTERFACES `sdk.js`, `bridge.js`, `dropin/mw.js`.

## B. Network layer corrections (measured)

B1. **Tracker keepalive.** `tracker.openwebtorrent.com` closes the socket on `scrape` with no reply. Replace the
90 s `scrape` with an offer-free keepalive announce (`numwant: 0`) at most every 55 s, plus a jittered fast
reconnect shim (1-2 s instead of the stock 10 s to 5 min backoff) and a `kick()` on `visibilitychange`,
`pageshow` and `online`. (RD P0-1, §4.1 row 1; PD verdict 3, P0-3.) Amends ARCH §1, §8; INTERFACES
`config.js wire.keepaliveScrapeMs` → `keepaliveAnnounceMs: 55000`, `torrent.js`.

B2. **Ledger rendezvous.** Replace the one-piece anchor torrent with a bare infohash
`sha1hex("mw-ledger/1/" + ledgerId)` added with the site torrent's exact announce list and
`getAnnounceOpts: () => ({ left: 1, numwant: clamp(softCap - wires, 0, 3) })`, never seeded; 0-1.5 s join
jitter; a glare watchdog (peers exist but no wire after 20 s → re-announce with jitter, at most 3 times);
`wire.ut_metadata.cancel()` on rendezvous wires; gossip rides `mw_chain1` on both content and rendezvous wires.
Metadata-less wires held 15/15 locally and 18/20 live; the one-piece torrent connected 0/15. (RD D26, P0-11.)
Amends ARCH §5.5, §6.6; INTERFACES `torrent.js addAnchor` → `addRendezvous(ledgerId, trackers)`.

B3. **Web-seed request headers.** WebTorrent's `Cache-Control` and `user-agent` request headers force a CORS
preflight that 18 of 24 hosts fail; removing them (keep `cache: 'no-store'`) raised usable hosts from 6 to 13
of 24 and removed every preflight in Chromium and WebKit. Apply a hash-asserted string patch to the vendored
bundle at build time (`build.mjs` fails if the patch point or the bundle hash changes) until our own bundle
lands; `check-webseed` probes both the stock and the patched header set and says which passed. (RD P0-9, P0-3;
MD verdict 5; ID verdict 2.) Amends ARCH §1, §10; `build.mjs`, `tools/check-webseed.mjs`.

B4. **Web-seed circuit breaker and Range-only contract.** A host that answers `Range` with 200 or returns wrong
bytes makes stock WebTorrent hot-loop (23,240 requests in 4 s). Loader: 3 failures in 30 s on a web seed → 5 min
backoff and a visible message; several `ws=` tried cheapest first; a failed piece from a web seed is not
re-requested from the same host within the backoff. Publish/doctor: the single verification gate (`publish
--verify-ws`, `check-webseed`, `check-site`) tests origin, seed and host modes and blocks pointer output on
failure. (MD M06-M08, P0 verdict 5; ID verdict 2.) Amends ARCH §5.4, §10; `torrent.js`, tools.

B5. **Wire guard details.** Read the length prefix unsigned (`>>> 0`), destroy above 256 KiB before buffering,
add a periodic buffer watchdog above ~512 KiB with a unit test that fails if the private `_bufferSize` field
disappears, and use `0x7FFFFFFF` in the e2e malicious-peer test (a 4 GiB prefix wraps negative in the stock
parser). (RD P0-5; PD verdict 9.) Amends ARCH §12 test 11, §13; `torrent.js`.

B6. **Connection discipline.** Soft and hard wire caps per swarm applied after the extended handshake (content
wires from policy; rendezvous 6/9 desktop, 3/5 mobile); drop the lowest-scored wire first; drive `numwant` to 0
at the soft cap; count peers by unique `peerId` excluding web seeds; `reqq` sane on content wires. (RD P0-6.)
Amends ARCH §8; `torrent.js`.

B7. **ICE hygiene.** One dead ICE server stalls every non-trickle offer by 5 s. Ship TURN off, at least two STUN
operators, probe STUN before use (2.5 s budget, never blocking render), offer timeout 1.5-2 s; a boot-time
connectivity probe module `src/loader/connectivity.js` feeds the diagnostics panel. (PD P0-6, P0-7.) Amends
ARCH §5.1, §8; INTERFACES new module.

## C. Consent, privacy, mobile

C1. **Consent before any third party.** The consent card (with a same-layer refusal and a versioned consent
record stored per origin) precedes the first tracker, peer and DoH connection; the DoH lookup is skipped until
consent unless the record arrived by `<meta>`; "Host only" remains available; `consent=gate` is the default
when the owner declares personal data or an EEA/UK/Quebec audience (`aud=` pointer key, DOCS for the owner).
(RD P0-10; PD P0-17.) Amends ARCH §4, §8; `app.js`, `ui.js`, `dropin/mw.js`.

C2. **Mobile defaults.** Four-class network classifier (wifi-confirmed, cellular, unknown, saveData) without
`mozConnection`/`webkitConnection`; uploads off by default on every mobile class with a per-origin opt-in; on
hidden record the time and lock uploads; on visible after more than 10 s, `online` or `pageshow.persisted`,
destroy and rebuild the client and re-attach the ledger; never `beforeunload`/`unload`; memory-bounded store;
48/24 MiB caps. (RD D38, P0-16.) Amends ARCH §8; `policy.js`, `app.js`.

C3. **Arrival safety.** Nothing that arrives by fragment, protocol handler, share target or paste loads
without an explicit click; `parseFragment` decodes once and only for encoded-scheme fragments; tests for
handler-built links, literal links, trackers with `?key=a&b=c`, encoded `=` and `%`. (RD P0-15.) Amends ARCH
§3.2, §5.3; `app.js`.

C4. **Remove v0.1 hub flags.** No `SANDBOX_HUB`/`HUB_CSP`; the shared-origin hub exists only as a localhost demo
or single-publisher mode behind the gate. (RD P0-12.)

## D. Service Worker and release safety

D1. **Navigation and streaming safety.** Answer every navigation within about 25 s (interstitial while waiting;
Firefox unregisters after 3 navigation faults); keep-alive ping at most every 20 s while streaming; no required
state in SW memory; reload-loop guard; versioned SW-page protocol. (RD P0-4.) Amends ARCH §7.1.

D2. **Atomic install and fail-open.** Precache fetches use `Request.integrity` for JS/CSS from `build.json`
hashes; a failed precache aborts install; navigations fail open to the host. (PD P0-13.) Amends ARCH §7.1.

D3. **Kill switch runbook (DOCS)** with the measured ~3 s recovery after the next navigation, `Clear-Site-Data`
as the documented last resort, a drill in every release. (PD P0-14.)

D4. **Drop-in rule edits.** Cold start: a bounded 40 ms wait for the index before pass-through; host responses
with `Cache-Control: no-store` are never cached and such pages run host-only; the web-seed rewrite coalesces
concurrent requests for one path; no CSP `<meta>` injected by the drop-in script (the host's CSP is the host's;
`publish --dropin` prints the measured additions); tag guards (`data-cfasync="false"`, idempotent double
inclusion). (MD M09, verdict 3.) Amends ARCH §3.4.2, §3.4.9.

## E. Publishing discipline

E1. **Path policy.** NFC-normalise paths; reject `?`, `#`, `%`, `\`, control characters, case-twins and
collisions after normalisation; enumerate dot-files explicitly and report dropped paths; reserved paths
(`/_mw/`, `/mw-sw.js`, `/.mw/`, `/ws/`) refused. (MD M02.)

E2. **Budget gates.** Files: warn 5,000, fail 20,000; torrent metadata: warn 1 MB (10 MB peer ceiling); largest
file vs host limits; total vs `maxSiteBytes`; a printed size report. (MD M03.)

E3. **Secrets and PII lint.** Refuse to publish files matching key/token patterns; strip WordPress export
commenter email and IP fields when `--from-wxr`; print what was dropped. (MD M04.)

E4. **Deterministic pack and double-pack check.** `creationDate` fixed to a passed `--date` or the commit date,
`createdBy` constant, sorted paths, no default trackers; CI packs twice and compares infohashes. (MD M05.)

E5. **Egress multiplier (DOCS).** Drop-in can multiply host egress (13.3x in the model of research w2a-07 F21 when a
20 MB copy completes after a 1.5 MB page view; arithmetic, not a measurement); README, DEPLOY and the publish output say so and the default is to
complete copies only on unmetered networks at idle. (MD M10, verdict 4.)

## F. Documentation-only outcomes (DOCS)

F1. Compatibility statement with four feature classes (works now / needs new code / third party from the
browser / stays on a server) and per-CMS verdicts; no personal data in the ledger, even encrypted. (MD M11,
verdict 7.) F2. `docs/PRIVACY.md`: recipients register (trackers, STUN, DoH with IP, TURN/relays/blob hosts when
enabled), retention, DPIA and Quebec PIA notes, not legal advice. (PD P0-18.) F3. Notice-and-action runbook,
`/report` intake, case log, takedown drill times. (PD P0-19.) F4. Owner duties in DEPLOY.md; `publish.mjs`
warns on `writers:'open'` without a contact key. (PD P0-20.) F5. Host recipes with dated prices and tested
CORS JSON; rollback as roll-forward with compare-and-swap DNS. (MD M14, M15.) F6. CI security baseline:
`permissions: {}`, SHA-pinned actions, OIDC roles, KMS signing path documented. (MD M16.) F7. Crawler-inert
loader: `data-nosnippet` on the status container, static `/_mw/sdk.js` stub present on the host. (MD M12.)
F8. Correct DR S7 (`allowScripts` is not inert) and ARCH §12 test 11 (use `0x7FFFFFFF`). (PD P0-12.)

## G. Roadmap (ROADMAP, not v0.2)

Seed-derived guest identity with a recovery phrase and passkeys as a v2 wrapper (ID verdict 8); owner
checkpoint blocks and lossless packing (ID verdict 6); Nostr/Blossom mirroring, pinner-published only (PD
verdict 8); multi-publisher hub operating layer: signed double-hashed denylist, gate-only apex, PSL entry,
451 + `Clear-Site-Data` takedown, no directory (PD H-1..H-3; ID verdict 9); TURN with short-lived credentials;
own WebTorrent bundle replacing the string patch; performance topic 07 measurements; real-device gate.
