# Review round, chat fixer (R 5.3)

Written 2026-10-24 04:58 EDT to 05:04 EDT (America/Toronto). Brief: the "chat" area of the review round. Files owned:
`src/chat/**`, their unit tests (`test/unit/chat-*.test.mjs`) and the chat parts of `test/e2e/scenarios-v03.mjs` (only E-CH-6M
is chat there, and nothing in it needed a change). Findings and verdicts are read from
`.orchestration/reports/all-findings-2026-10-22.json` and `.orchestration/reports/verdicts-2026-10-23.json`.

Files changed: `src/chat/limits.js`, `tags.js`, `seal.js`, `stamp.js`, `ck.js`, `replay.js`, `holder.js`, `outbox.js`,
`presence.js`, `lane.js`, `service.js`; `test/unit/chat-core-frames.test.mjs`, `chat-core-replay.test.mjs`,
`chat-core-seal.test.mjs`, `chat-lane-holder.test.mjs`, `chat-lane-routing.test.mjs`, `chat-lane-service.test.mjs`. No
existing vector changed (`test/vectors/chat.json` is untouched; every new derivation is an opt-in option of `sealDm`, and the
known answers are checked against node:crypto in `chat-core-seal`). Wire layout and frame sizes are unchanged.

## Findings

Status: fixed (code and a regression test that fails on the code before), partial (what is left is named, with the request),
rejected (minor, deferred).

| Finding | Status | Files | Test |
| --- | --- | --- | --- |
| UX-6 | fixed (service side) | `src/chat/service.js:153` (`shortId`), room event `short` in `onRoom`, message and request events | `chat-lane-service.test.mjs:1015` (short id equals `src/idp/cards.js` `shortId`); the panel already prints `from.short` (`src/widget/chat-panel.js:113-118`), request R1 adds the name next to it |
| UX-7 | partial | none in my files (the social example adds its own lines, `examples/social/js/chat.js:10`, so the service must not echo) | request R1 |
| UX-8 | partial | none in my files | request R1 |
| UX-14 | fixed | `src/chat/service.js:1190` (`resume`), `:1212` (`enableCore`), `chat.state` resumes in a leader tab, `chat.disable` clears the consent, joined rooms persist | `chat-lane-service.test.mjs:987` (reload: on with no card, Lobby joined; follower stays off; another tracker stays off; after `chat.disable` off) |
| PRIV-1 | fixed | `src/chat/lane.js:898` (`send`: random hop 0 to 2, first-send jitter when more than one neighbour, flood to a random half, at least two); `src/chat/tags.js:46` (`contactTagFrom`), `src/chat/seal.js` `sealDm({ directional })`, service seals contact mail, ACKs and SIG directionally and listens on the contact's direction | `chat-lane-routing.test.mjs:471`, `chat-core-seal.test.mjs:369` |
| PRIV-2 | partial | `src/chat/service.js:995` (`ckReason`), `:1014` (`shareCk`), `:1019` (`onCk`: no 'presence' event from a CK any more, a wanted key's CK is answered) | `chat-lane-service.test.mjs:950`; the whole service test file runs with `ckShare: 'reason'` |
| PRIV-3 | partial | none (`src/loader/torrent.js` is not mine) | request R3 |
| DS-1 | fixed | `src/chat/lane.js:729` (`_routedTargets`: routes add to a random half, never replace), `:621` (`_onWant`: a wire's prefixes are those of its latest WANT) | `chat-lane-routing.test.mjs:371`; the old exclusivity assertion is replaced (`:309`) |
| DS-5 | fixed | `src/chat/outbox.js:105` (HOLDING never stops the held copies) | `chat-lane-service.test.mjs:855` |
| DS-6 | fixed | `src/chat/replay.js:124-145` (no Bloom check for a sender with no high-water mark above `floor`; counter-exact for older messages; 5,000 ids per sender per day) | `chat-core-replay.test.mjs:103`, `:119`, `:134` |
| DS-7 | fixed | `src/chat/holder.js:178` (source = Noise static key), `:200` (equal sources: the newest gives way), `src/chat/lane.js:566` | `chat-lane-holder.test.mjs:115` |
| SEC-7 | fixed | `src/chat/lane.js:171` (`chatBits` getter), `:541` (relayed stranger frame under the bits but at 10 bits or more: dropped, no strike; under 10 bits or at hop 0: a strike), `src/chat/service.js:1236` | `chat-lane-routing.test.mjs:551` |
| MP-3 | fixed | `src/chat/lane.js:621` (full tags only at a holder, 16 per wire), `:698` (4,096 in all), `:399` (WANT budget) | `chat-lane-routing.test.mjs:409` |
| MP-4 | fixed | as DS-1 | `chat-lane-routing.test.mjs:371` |
| MP-5 | fixed | `src/chat/ck.js:103-170` (known signers kept apart from 256 unknown ones; identical CK not verified again), `src/chat/service.js:1019` (no rebuild for a CK that changed nothing or of a key the interest does not use), `src/chat/lane.js:399` (CK budget), `:386` (1 MiB backlog) | `chat-core-seal.test.mjs:439`, `chat-lane-routing.test.mjs:626` |
| MP-7 | fixed | as DS-5 | `chat-lane-service.test.mjs:855` |
| MP-8 | fixed | `src/chat/lane.js:399` (`_ingress` buckets for WANT, CK, PRES, ICHAL, IRESP, HELD; over budget: dropped and a strike), `:386` (backlog cap) | `chat-lane-routing.test.mjs:409`, `:437`, `:626` |
| SYB-3 | fixed | as DS-1 | `chat-lane-routing.test.mjs:371` |
| SYB-5 | fixed | as MP-5 | `chat-core-seal.test.mjs:439` |
| SYB-6 | fixed | as DS-6 | `chat-core-replay.test.mjs:103` |
| SYB-7 | fixed | `src/chat/lane.js:551` (seen entry keeps the lowest hop and whether it was relayed) | `chat-lane-routing.test.mjs:501` |
| SYB-8 | fixed | `src/chat/lane.js:762` (a full queue drops from the source holding the most bytes) | `chat-lane-routing.test.mjs:526` |
| SYB-9 | fixed | as MP-3 | `chat-lane-routing.test.mjs:409` |
| SYB-10 | fixed | `src/chat/lane.js:399`, `:420` (ROOM signature checks: 20 a second per wire, 100 in all), `:386` | `chat-lane-routing.test.mjs:437`, `:602`, `:626` |
| SYB-14 | fixed | `src/chat/service.js:738` (one request per sender, the oldest goes, `requestsDropped` in `chat.state`), `:1433` (`decline({ all })`, `decline({ from })`) | `chat-lane-service.test.mjs:1060`, `:1099` |
| SYB-15 | fixed | `src/chat/seal.js:176` (`collectSecret`, `collectIv`: the iv is the COLLECTED hash lock), `src/chat/holder.js:36` (`lockOpens`), `:328` (`collected`), `:233` (64 frames a wire a minute); service seals with `collectLock` and sends the secret (`src/chat/service.js:688`) | `chat-lane-holder.test.mjs:61`, `:89`, `chat-core-seal.test.mjs:417`; held-mail service tests (`chat-lane-service.test.mjs` p7, p4) now collect through the lock |
| STALK-2 | partial | as PRIV-2 | `chat-lane-service.test.mjs:950` |
| STALK-7 | partial | `src/chat/seal.js:364` (`blindInbox`: one byte of the inbox tag, the full tag stays the HKDF salt), `:410` (open tries the salts), `src/chat/service.js:605` (bucket interest), own frames at a random hop (`lane.js:898`) | `chat-core-seal.test.mjs:389`; `chat-lane-service.test.mjs` "message requests" runs blinded end to end |
| STALK-9 | partial | `src/chat/service.js:144` (`requestsOn`: 'introduced' takes no requests until introductions are built) | `chat-lane-service.test.mjs:1060` |
| DS-8 (minor) | fixed | `src/chat/stamp.js:114` (tomorrow within 5 minutes of midnight), `:131` (`fullDay` nearest) | `chat-core-frames.test.mjs:322` |
| DS-9 (minor) | fixed | `src/chat/limits.js:123` (`ACK_TIMEOUT_MS` 40 s) | arithmetic in the comment; E-CH-2 and E-CH-9 keep their bounds (55 s, 35 s) |
| HUB-8 (minor) | fixed | as SYB-15 | `chat-lane-holder.test.mjs:89` |
| MP-13 (minor) | fixed | `src/chat/service.js:923` (room (author, id) shown once) | `chat-lane-service.test.mjs:1015` |
| SEC-10 (minor) | fixed | `src/chat/tags.js:55` (`secureRandom`), defaults in tags, presence, lane, outbox and service; `service.js:168` replaces a passed `Math.random` | covered by every test that uses the defaults; no Math.random default left in `src/chat` (`grep -n "Math.random" src/chat` finds only comments) |
| STALK-12 (minor) | partial | `src/chat/service.js:921` (room t rounded to the minute, others refused) | `chat-lane-service.test.mjs:1015`; the files listing is request R7 |
| SYB-16 (minor) | fixed | `src/chat/service.js:871` (64 groups, 16 from one inviter) | `chat-lane-service.test.mjs:1126` |
| SYB-17 (minor) | fixed | as DS-5 | `chat-lane-service.test.mjs:855` |
| UX-20 (minor) | partial | none in my files | request R1 |

## Notes on the partial ones

- **PRIV-2, STALK-2.** The policy is built and tested (`ckShare: 'reason'`): a neighbour gets this tab's CK only when it is a
  contact, group member or call-roster key whose CK this tab holds, when this tab looks for such a key's chat key, when message
  requests are open, or when presence is public; a wanted key's CK is answered with ours. It is not the default yet because
  two fixtures outside my files wait for the chat keys of strangers before they add contacts (`test/fixtures/calls/peers.mjs:200-215`,
  16 calls unit tests; `test/e2e/scenarios-chat-rows.mjs:415-424`). Turning it on is requests R2, R4 and R5, in one step. What
  stays open after that (STALK-2): the Noise static key is the chat key, stable for 90 days, so a neighbour still sees a stable
  pseudonym next to the IP address; the fix the finding names (per-session statics and blinded contact proofs) is a protocol
  change for the owner (request R6). The 'presence' event no longer fires from a CK in either mode.
- **STALK-7.** Stranger frames are blinded and leave at a random hop; a first-hop neighbour can still guess by timing, which
  THREAT-MODEL should say (R6). The pin mailbox releases stranger mail by exact inbox tag only, so blinded stranger mail is not
  collected from it; the mailbox has no sender yet (ROADMAP), and releasing a 1-in-256 bucket there is left for when it does
  (`src/chat/holder.js` `respond`).
- **STALK-9.** Item 1 is fixed here. Items 2 (blocks and contacts in the vault) and 3 (a new identity with no link) belong to the
  identity lane (R8).
- **PRIV-3, UX-7, UX-8, UX-20, STALK-12 (files).** The code is in files other areas own; the exact changes are below.

## Requests (for the integrator and the owning areas)

- **R1 `src/widget/chat-panel.js` (UX-6 name, UX-7, UX-8, UX-20).**
  - `:118` old `this._log.push({ pub, name: String(from.name || from.short || '?'), text });` new
    `this._log.push({ pub, name: from.name ? String(from.name) + ' (' + String(from.short || pub.slice(-9)) + ')' : String(from.short || pub.slice(-9)), text });`
  - `:227-229` `_sendRoom`: after `await mw.chat.room.send('Lobby', { text })` succeeds, push the line itself (the service does
    not echo own room messages; `examples/social/js/chat.js:10` relies on that):
    `this._log.push({ pub: '', name: this.T('chatYou'), text: text.slice(0, MAX_TEXT) }); if (this._log.length > MAX_LOG) this._log.shift(); this.render();`
    (a `chatYou` string, "You", is needed in `src/widget` strings). Test: a fake `mw.chat.room.send` that resolves, click Send,
    the lobby holds the line.
  - `render()` (`:159-162`): before removing the children, keep the composer's value, selection and whether it had focus
    (`const prev = root.querySelector && root.querySelector('input[name="message"]')`, `const keep = prev ? { v: prev.value, s: prev.selectionStart, e: prev.selectionEnd, f: root.activeElement === prev } : null`);
    after the new composer is built, restore them (`input.value = keep.v; if (keep.f) { input.focus(); input.setSelectionRange(keep.s, keep.e); }`).
    Test: type into the input, call `_onMessage`, the input keeps value and focus.
  - `_composer` (`:185-195`): put the input and button in a `form` whose `submit` handler calls the same send (`ev.preventDefault()`),
    so Enter sends; tabs (`:174-176`): `role="tab"` with `aria-selected`, or drop `role="tablist"`. Test: Enter on the input calls `onSend`.
  - E2E (scenarios-dropin-v03.mjs:275): assert the Lobby line does not start with `?:`.
- **R2 `src/loader/api.js:2117-2121` (PRIV-2, UX-14, SEC-10).** Pass `ckShare: 'reason'` to `createChatService`; call
  `chat.resume()` once the working keys exist (after sign-in; `chat.state` also resumes in a leader tab); `random: Math.random`
  may be dropped (the service replaces it with `secureRandom` already).
- **R3 `src/loader/torrent.js:1339-1342` and `:1322` (PRIV-3).** Import `sanitizeSdp` from `../calls/ice.js` and give the
  tracker client an SDP transform: `tracker: peers ? { rtcConfig: this._rtcConfig, sdpTransform: (sdp) => sanitizeSdp(sdp, { sameLan: false, direction: 'out' }) } : false`
  and the same `sdpTransform` in `_useLaneRtc`'s `Object.assign({}, saved, { rtcConfig: rtc })`. Check first that
  `bittorrent-tracker` passes the tracker opts to simple-peer (`node_modules/bittorrent-tracker/lib/client/websocket-tracker.js:404-410`
  builds the Peer with `config` and `wrtc` only); if it does not, wrap `client._rtcConfig`-built peers through the
  `peerConnectionConfig`/`sdpTransform` of simple-peer in the manager's own `_wire` hook. Test: a fake Peer factory whose offer
  SDP holds `a=candidate:... 192.168.1.23 ... typ host` reaches the tracker message without that address.
- **R4 `test/fixtures/calls/peers.mjs:205-215` (PRIV-2, to turn the policy on).** In `people()`, add the contacts before
  `knowEachOther` (`if (contacts) { add all; } if (wire) { connect; knowEachOther }`), and for `contacts: false` let
  `knowEachOther` fall back to `a.chatSvc.sig.learn(b.chatSvc.sig.ckOf(b.pub))` both ways (as `calls-service.test.mjs:475` does).
- **R5 `test/e2e/scenarios-chat-rows.mjs:415-424` (PRIV-2).** In `contacts()`, call `chat.contacts.add` on both sides first,
  then wait for `hasCk` both ways (the CK then comes because each side looks for the other's key).
- **R6 docs (PRIV-1, PRIV-2, STALK-2, STALK-7, DS-9, SYB-15).** `docs/THREAT-MODEL.md:61` and `docs/PRIVACY.md:235`/`:258`:
  until R2 is applied, neighbours see the chat key and the site key next to the IP address while chat is on; after it, they
  see a stable chat key (the Noise static, 90 days) next to the IP address; a first-hop neighbour can still guess the author of
  a frame by timing. `src/loader/strings.js:597` and `:613` (`presenceOff`) need the same correction. THREAT-MODEL `:297-299`
  (STALK A1 to A3): own frames now jitter and start at a random hop; stranger frames show one byte of the inbox tag. R 2.7.3 /
  2.7.5 amendments: ACK timeout 40 s; WANT routes add to a random half; the COLLECTED proof is the hash-lock secret
  `s = HMAC(K_pair, "collect|" | tag | epk)` and the iv is `SHA-256("mw-collect-v1" | s)[:12]` (closes O-1 in
  `docs/deviations/chat.md`); contact tags are directional `HMAC(K_pair, "tag|" + day + "|" + senderEk)[:8]`. INTERFACES:
  `chat.requests.decline({ all } | { from } | { id })`, `chat.state().requestsDropped`, `short` on room, message and request
  events, `service.resume()`, dep `ckShare`. Owner decision (STALK-2): per-session Noise statics with blinded contact proofs.
- **R7 `src/files/lane.js:389` (STALK-12).** `t: rec.t = this._now()` -> `t: rec.t = Math.floor(this._now() / 60000) * 60000`; test: a
  listing's `t % 60000 === 0`.
- **R8 identity lane (STALK-9 items 2 and 3).** A vault seam for chat contacts and blocks (`src/identity` vault field
  `contacts`, `vault.js:196-198`, written by nobody today) that the chat service can read at enable and write on block, and either
  a per-site fresh identity or removing "new identity with no link" from R 2.17.2 and THREAT-MODEL `:306`. Until then,
  `tools/ledger-admin.mjs:634` and `docs/OPERATIONS.md:699-701` should say that `introduced` takes no message requests (the
  chat service now treats it as closed, `src/chat/service.js:144`).
- **R9 `src/calls/limits.js:42` (DS-8).** `T_SKEW_MS` is 60 s against chat's 5 minutes; align it or state the 60 s requirement.
- **R10 vectors (optional).** Add known-answer entries for `contactTagFrom`, the collect lock and a blinded stranger frame to
  `test/vectors/chat.json` with their LOCK lines; today they are checked against node:crypto in `chat-core-seal.test.mjs:369`, `:417`.

## Runs

- `node --test test/unit/chat-*.test.mjs`: every chat test passes (routing 19, holder 7, service 33, and the core files);
  `chat-lane-routing` three times in a row green. `node --test test/unit/chat-lane-holder.test.mjs test/unit/tools-v03-pin.test.mjs`:
  21 of 21. `node tools/lint-floor.mjs`: 147 files clean.
- `npm test` (final, finished 05:02 EDT): 2,266 tests, 2,246 pass, 19 todo, 1 failure that is not from this area:
  `test/unit/repo-layout.test.mjs:31` refuses a tracked top-level `SECURITY-KEY.asc` another area added. (An earlier run also
  failed the pin-mailbox "Eve gets nothing" check while the mailbox released blinded buckets; the mailbox now releases exact
  inbox tags only, see STALK-7.)
- e2e, every request on 127.0.0.1: `node test/e2e/run.mjs --only E-CH-2,E-CH-9,E-CH-11,E-CH-3,E-CH-4,E-CH-10,E-CH-12,E-CH-R`
  7 passed and E-CH-3 failed (a relayed under-stamped stranger frame was no longer struck when send() gave it hop 1 or 2); after
  the fix at `src/chat/lane.js:541` (under 10 bits is a strike at any hop) `--only E-CH-3` passed. E-CH-2 collected through the
  hash lock (handed after 40.0 s, the new ACK timeout); E-CH-10 met its 5 s bound. `--only E-CH-1,E-CH-8,E-CH-6,E-CL-3,E-CL-1,E-CL-2`:
  6 of 6. Not run: `--webkit`, the social rows.
