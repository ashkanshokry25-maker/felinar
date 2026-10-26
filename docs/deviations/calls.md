# calls lane (v0.3 C2): notes, contracts and deviations

Brief: SEEDING-AND-ZERO-SETUP-DESIGN.md ("SZ") 3.5 and 1.4; V03-DESIGN-REVIEW ("R") 2.7.3, 2.7.4, 2.7.8, 2.11;
docs/research/labs/c2-calls-lab. Files: `src/calls/{limits,signal,ice,adapt,mesh,session,service}.js`,
`src/chat/service.js` (the SIG seam and `chat.direct.connect` only), `test/vectors/calls.json`,
`test/unit/calls-{signal,ice,adapt,mesh,service,browser}.test.mjs`, `test/unit/chat-lane-service.test.mjs`,
`test/e2e/scenarios-calls.mjs`, `test/fixtures/calls/{fake-webrtc.mjs,peers.mjs,browser-page.js}`.

New code that carries media between people. Nothing here is called secure before the outside review of R 2.19; the
binding of DTLS to the chat keys rests on the chat lane's sealed box, which waits for that review too.

## What a call shows, and to whom (plain words)

- Accepting a call shows your IP address to everyone in it; a ring shows nobody's (it carries no SDP and no candidate,
  and neither side makes a connection before the accept). A relay, when the owner runs one, sees both addresses, sizes
  and times, never content.
- Offers and answers travel only inside SIG frames sealed with K_pair, so a relaying neighbour reads nothing and cannot
  swap a DTLS fingerprint; each pair also checks the remote certificate in getStats against the fingerprint of the sealed
  SDP. A stolen chat key impersonates in calls as in chat.
- Loopback measurements only (calls-browser.test.mjs, 2026-10-20, this machine): connected in 227 ms (Chromium 156) and
  302 ms (WebKit 27.2) after the accept; offer SDP 9,493 and 9,671 bytes, SIG bodies 10,212 and 10,446 bytes (caps
  14,000 and 15,000). Real networks and phones are the gate rows G-CL-1 to G-CL-9, not run.

## Contract for wire-ui: the SIG seam (`createChatService(deps).sig`)

Loader only: `sig` is a property of the chat service object, never a method, so the site cannot reach it.

```
sig.send(pub, payload, { group }?) -> Promise<{ reached, route, bucket }>
    payload: Uint8Array or string, 1 to 15,000 bytes (E_LIMIT). Sealed with sealDm under KIND.sig (5) into a SIG frame
    (0x0B) via lane.stamped(T.SIG, { flags: 0, bits: 10 }): never FLAG_HOLD, never FLAG_STRANGER; counter and replay
    conversation 'sig|' + pub (DM gap detection untouched); never remembered in history, never ACKed, no outbox.
    Allowed to: an accepted, unblocked contact; a key in an active listen set; or, while _mw.cfg.calls is 'contacts', a
    member of `group` when this tab holds that group too. Errors: E_HOST_ONLY, E_POLICY (chat off, destroyed),
    E_BAD_REQUEST, E_LIMIT, E_BLOCKED, E_NOT_CONTACT, E_NO_CHAT_KEY, E_STAMP.
sig.onReceive(fn(pub, payload: Uint8Array, meta)) -> unsubscribe
    meta = { contact, listen, groups: [groupId], t, id, n, gap, via }. Delivered: KIND.sig inside a SIG frame from an
    accepted unblocked contact, a key in an active listen set, or (calls on) a member of a group both hold. Dropped:
    KIND.sig inside ENV, any other kind inside SIG, a SIG with the hold or stranger flag, a SIG that came held, SIG under
    a group tag or an inbox tag.
sig.listen(pubs, untilMs) -> stop()
    those keys' pair tags (from cached CKs) join the lane interest for SIG only (an ENV under such a tag is dropped
    unopened) until untilMs, at most 2 h from now; at most 32 keys; stop() is idempotent.
sig.contact(pub) -> { pub, nick, accepted, blocked, verified, hasChatKey } | null
sig.groupMembers(groupId) -> [pub] without this tab's key (E_NOT_MEMBER)
sig.state() -> { on, calls }
sig.ckOf(pub) -> CK | null; sig.learn(ck) -> Promise<boolean> (verifies and caches a CK a call roster carried)
```

Interest: besides contacts, inbox and groups, the lane listens (SIG only) to listen-set keys and, while calls are on,
to the members of held groups who are not contacts. A change of `_mw.cfg.calls` takes effect at the next interest
refresh (any contact, group or listen change, or the next UTC day).

## Contract for wire-ui: the calls service (`createCallService(deps)`, src/calls/service.js)

```
createCallService(deps) -> { methods, on(event, fn) -> unsubscribe, answer(id, { video }), setVisible(visible),
                             setNetwork(), media(id), inspect(), destroy() }
methods: 'calls.start', 'calls.accept', 'calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera', 'calls.screen',
         'calls.state', 'calls.list'; async (params, ctx), ctx = { activation, tab }. Params are objects (positional
         arrays work): start { to: pub | [pub] | groupId, video? }, accept { id, video? }, decline/hangup/state { id },
         mute/camera/screen { id, on }.
UI methods (ctx.activation === true, then the loader's card): calls.start, calls.accept, calls.screen.
results: start/accept -> state(id); decline/hangup -> { id, state: 'ended' }; mute -> { id, mute }; camera -> { id, camera };
         screen -> { id, screen }; state(id) -> the state, the ended state (kept 10 min) or null; list() -> [state].
state = { id, role: 'caller' | 'callee', state: 'ringing' | 'connecting' | 'connected' | 'reconnecting' | 'ended',
          kind: 'audio' | 'video', caller, group, startedAt, connectedAt, endedAt, expiresAt (a ringing incoming call),
          local: { mute, camera, screen, videoPaused }, paused: { audio, camera } (the browser muted a track),
          participants: [{ pub, name, state: 'ringing' | 'connecting' | 'direct' | 'relayed' | 'reconnecting' | 'left',
          reason, path, mute, camera, screen, checked (certificate matched), verified (contacts.verify) }],
          notice: 'metered' | null, platform: 'call.ios' | 'call.android' | null, relay, relayOnly, operator, error, reason }
events: 'ring' { id, from, name, kind, group, roster, expiresAt }; 'state' (the state); 'peer' { id, pub, state, path,
        mute, camera, screen, name, reason, code? }; 'ended' { id, reason, code, duration }. No event and no result
        holds a MediaStream or a track.
reasons: hangup, declined, busy, no-answer, cancelled, unreachable, failed, fingerprint, alone, closed, signed-out, host-only
codes in 'ended': E_DECLINED, E_BUSY, E_NO_ANSWER (rings expired), E_CALL_FAILED (no path in 30 s, fingerprint, lost),
        E_PEER_UNREACHABLE (no ring reached anyone), or null (a normal end).
```

Loader-only functions (not methods, so the SDK cannot reach them):
- `answer(id, { video })`: the call panel's own incoming card was answered by the person's click; no second card.
- `media(id)` -> `{ local: { audio, camera, screen }, remote: [{ pub, audio, camera, screen }] }` tracks for the panel's
  `<video>` and `<audio>` elements.
- `setVisible(visible)`: hidden releases the Wake Lock; visible gets muted or ended tracks again (replaceTrack) and takes
  the Wake Lock back during a video call. Feed it from the lifecycle watcher.
- `setNetwork()`: an ICE restart on every pair and the rates of the new policy class. Feed it from watchNetwork.
- `inspect()` -> `{ calls: [{ id, state, role, pairs: [{ pub, state, path, connectionState, signalingState, control,
  fingerprint: { status, expected, actual }, verified, stats, bytes, rung }], participants }], seedYield }`.

deps (mountV03Services 'calls' after 'chat'):

| dep | what |
|---|---|
| `chat` | the chat service's `sig` (it carries contact, groupMembers, state, ckOf and learn) |
| `keys` | WorkingKeys or a function returning them; only `.pub` is read |
| `cfg()` | `_mw.cfg`; calls run only when `calls === 'contacts'` |
| `policy()` | `{ class, metered }` from src/loader/policy.js (class: desktop, mobileUnmetered, mobileUnknown, mobileMetered) |
| `hostOnly` | boolean or function, read at every call |
| `stun` | the site's own STUN list (MF-44), as chat gets its own tracker; calls need it or a relay (E_POLICY) |
| `turn` | `_mw.cfg.turn` RESOLVED by the loader into `[{ urls, username, credential, operator }]` (R 2.7.8 option a's shipped static credentials, or option b's endpoint answer); the ledger holds only `{ urls, mode }` (state.js) |
| `prefs()` | `{ sameLan, hideIp }`: the person's "same local network" and "Hide my IP from people I call" (per origin, loader settings) |
| `RTCPeerConnection`, `mediaDevices`, `wakeLock`, `mediaSession` | from the window |
| `prompt(kind, data)` | the loader's cards, kinds below |
| `deviceClass` | 'desktop', 'android' or 'ios' (the chat service's deviceClass) |
| `mode` | 'shell', 'hub' or 'dropin' (drop-in: every non-read method is E_UNSUPPORTED) |
| `onSeedYield(state)` | `{ active, limited, connections, video }` or null: the seed budget's `env.call = state ? { limited: state.limited } : null` |
| `now`, `random`, `setTimeout`, `clearTimeout` | optional |

Cards (deps.prompt) and what they resolve to; anything else is E_USER_CANCELLED:

| kind | when | data | resolves |
|---|---|---|---|
| `call.start` | start, one contact | `{ to, name, video, relay: { operator } \| null, relayOnly, metered }` | `true` |
| `call.group` | start of a group or several contacts (`role: 'caller'`), and accept of a call with others in it (`role: 'callee'`) | caller: `{ role, to, names, group, video, relay, relayOnly, metered }`; callee: as call.incoming plus `roster, names` | caller `true`; callee `'audio'`, `'video'`, `'decline'` or `true` |
| `call.incoming` | accept of a call of two | `{ id, role, from, name, kind, roster, names, group, relay, relayOnly, metered, video }` | `'audio'`, `'video'`, `'decline'` (declines the call) or `true` (the asked or default media) |
| `call.metered` | video asked on a metered network (after call.start or call.incoming) | `{ id?, video: true }` | `true` (then audio only) |
| `call.screen` | screen on | `{ id }` | `true`; getDisplayMedia runs right after, in the task of the card's click |

Gating order (SVC): E_HOST_ONLY (methods that reach peers, before any card or request), E_UNSUPPORTED (drop-in),
E_POLICY (follower tab; calls off for start and accept; chat off; no own STUN or relay; "Hide my IP" without a relay),
E_NEEDS_GESTURE (UI methods), E_NOT_SIGNED_IN, E_UNSUPPORTED (no RTCPeerConnection or getUserMedia; no getDisplayMedia
for screen). Hang up, mute and decline keep working when the owner turns calls off during a call; hang up in host-only
ends without telling peers.

## e2e contract (test/e2e/scenarios-calls.mjs; the integrator wires and runs it)

`callsScenarios({ run, assert, headed })`, `CALLS_ORDER = ['E-CL-3', 'E-CL-1', 'E-CL-2']`, `CALLS_WEBKIT_ORDER =
['E-CL-1W']`. The file launches its own Chromium (chromiumArgs() plus the loopback flag and both fake-media flags) and
WebKit browsers and makes lib.mjs Visitors on them (the run's request guard and ICE stripping apply). It assumes:
mw.calls in the SDK as SZ 3.5 (start, accept, decline, hangup, mute, camera, screen, on) and `features.calls`; the call
cards findable by `window.__mwShell.rectOf(label)` with the CALL_TEXT labels ('Accept with audio', 'Accept with
video', 'Decline', 'Share screen') and, for the start, group and metered cards, one of 'call.call' / 'call.join' /
'Call' / 'Join' / 'Continue'; `window.__mwShell.setCallPrefs({ sameLan })` (two browsers on one machine have only
private loopback candidates); `_mw.cfg.calls` accepted by setCfg and the reader schema.

## Deviations and choices (the design text is unchanged; these are the readings)

| Id | SZ 3.5 / R says | What the code does | Why |
|---|---|---|---|
| D-1 | SIG from "contacts or the named group's members only"; brief: contacts or a listen set | Contacts, listen sets, and (calls on) members of a group both hold, naming that group in `g`; their pair tags join the interest for SIG only | A ring from a group member who is not a contact must be heard; nothing but SIG is taken from such a key |
| D-2 | "perfect negotiation" for renegotiation | Fixed layout from the first offer: audio, camera, screen transceivers, all sendrecv; camera and screen go on and off with replaceTrack (no renegotiation); perfect negotiation (higher key polite) handles ICE restarts and any renegotiation, over 'mw-call' once connected, over SIG while a pair is down | Sharing a screen in WebKit or Chromium needs no SDP round trip; one code path for 1:1 and mesh |
| D-3 | ring, accept, offer | The caller captures (getUserMedia) after its card and before ringing; the callee after its card. No connection exists before an accept on either side | Permission errors (E_MEDIA_DENIED, E_NO_DEVICE) come before anything leaves; a capture is not a connection |
| D-4 | body fields | `media` is required on ring and accept; `roster` on a ring names the other invitees (for the group card), on an offer and on 'mw-call' who joined; `g` may be on any kind | The card needs the kind and the names; the roster authorises pairs |
| D-5 | "rising s; duplicates dropped by (c, s)" | Duplicates by (sender, c, s) dropped; a seq more than 256 below the sender's highest dropped; out of order taken (relays wait 0.5 to 3 s and reorder) | Strict rising order would drop reordered candidates |
| D-6 | "private, loopback and link-local candidates are dropped" | Also unspecified, shared (100.64.0.0/10), multicast and host names other than mDNS '.local'; our srflx and relay candidates have a private related address masked as 0.0.0.0 / ::; private c= and a=rtcp: addresses in our SDP masked; received SDP candidate lines filtered too | A peer must not make our browser probe our network or look a name up; our own private address must not leak in raddr |
| D-7 | E-CL-1: certificate equals the sealed answer | getStats transport.remoteCertificateId, or the certificate that is not ours; an engine without certificate stats is recorded as `checked: false` and the call goes on (both Chromium 156 and WebKit 27.2 report it: 'ok') | The browser's DTLS check already binds the SDP; the stats check is the end-to-end proof |
| D-8 | `chat.direct.connect` (P2) | E_POLICY while calls are off, else E_UNSUPPORTED, for contacts and non-contacts alike | As the brief; answering E_NOT_CONTACT would tell the site who is a contact without the contacts card |
| D-9 | "needs chat on and the site's own tracker and STUN, MF-44" | E_POLICY without the site's own STUN (or a relay); "Hide my IP" without a relay is E_POLICY, never a silent direct call | The person's choice must hold or the call must not start |
| D-10 | caps 6 audio, 4 video (SZ-4 pending) | Checked at start with the asked video (E_LIMIT before any card); a ring over the cap is not shown; turning the camera on in a call of more than 4 is E_LIMIT | SZ-4 |
| D-11 | "metered networks start audio only"; SZ-4 adds unknown networks (pending) | mobileMetered starts audio only whatever was asked (call.metered card when video was asked); mobileUnknown (a phone without a provable network) defaults to audio unless video was asked; a desktop is never 'unknown' (policy.js) | SZ-4 as written, kept to phones, where the class exists |
| D-12 | ladder | Bad reading = loss >= 5% (remote-inbound fractionLost, else the packet deltas) or 4 s limited (qualityLimitationReason bandwidth or cpu, or availableOutgoingBitrate under the send target); halve to 100 kbit/s, scale 2, 4, pause the camera; 10 s clean is one step back; round-trip time is read and reported, no rule uses it; the screen keeps its rate | SZ 3.5 names no RTT rule; scaling a 'detail' screen ruins it |
| D-13 | timers | A pair that has not connected in 30 s fails (call.noPath); disconnected: ICE restart after 3 s, closed 15 s later; a callee with no offer 30 s after its accept fails; a call that never connected and lost its last pair ends E_CALL_FAILED on both sides | Both sides show the same outcome whichever timer fires first |
| D-14 | busy | Automatic 'busy' while this tab has any call, ringing included; one call at a time per tab (start is E_BUSY) | The call panel shows one call |
| D-15 | errors | Besides the SZ 3.5 codes: E_NEEDS_GESTURE, E_USER_CANCELLED (a card answered no, a cancelled screen picker), E_BAD_REQUEST, E_NOT_MEMBER (a group this tab does not hold); ring limits are E_LIMIT; a contact without a chat key is E_PEER_UNREACHABLE ("not connected now") | Codes the SDK already has strings for |
| D-16 | Wake Lock "during a visible video call" | Held while visible and any camera (ours or a peer's) is on in a connected call; released on hide, camera off everywhere, and end | |
| D-17 | 'mw-call' messages | `{ t: 'state', mute, camera, screen }`, `{ t: 'roster', pubs, cks? }` (the caller's only; cks lets members who never met learn each other's chat key), `{ t: 'leave' }`, `{ t: 'desc', type, sdp }`, `{ t: 'cand', cand }`; JSON, at most 16 KiB, strict fields | |

## Requests to other lanes (not edited here)

- **R-1 (chain or the C2 integrator), src/chain/state.js, critical:** `CFG` has no `calls`, so `cfgOk` refuses a
  `_mw.cfg` that names it and readers hide the WHOLE setting (chat, files and media go off with it). Add
  `calls: ['off', 'contacts']` to `CFG`. tools/ledger-admin.mjs (zero-setup) already refuses to write such a cfg until
  then ("the reader schema in src/chain/state.js does not list calls yet"), so the E-CL scenarios stop at their first step.
- **R-2 (wire-ui), src/loader/api.js mountV03Services:** mount 'calls' after 'chat' with the deps table above (`chat:
  chat.sig`); `stun` from the pointer as `ownTracker` is; resolve `turn`; per-origin `prefs` with two Settings toggles
  ("Same local network" for calls, "Hide my IP from people I call", shown only when a relay exists); feed `setVisible`,
  `setNetwork` and `onSeedYield`; add the five `call.*` kinds to the cards with the results above; the call panel uses
  `answer()`, `media()` and the methods. Drop-in mode: pass `mode: 'dropin'` or answer E_UNSUPPORTED in the bridge.
- **R-3 (wire-ui), test hooks for the e2e:** `window.__mwShell.setCallPrefs({ sameLan, hideIp })` and the call cards'
  buttons in `window.__mwShell.rectOf(label)`.
- **R-4 (docs-strings), src/loader/strings.js:** labels for the confirm buttons of call.start and call.group (for
  example 'call.call': 'Call', 'call.join': 'Join'); the scenarios fall back to 'Continue'.
- **R-5 (C2 integrator):** add `'calls.json'` to `FILES` in test/unit/formats-vectors.test.mjs and append these lines to
  test/vectors/LOCK.json entries; wire `callsScenarios` with `CALLS_ORDER` (after MEMBERS_ORDER) and `CALLS_WEBKIT_ORDER`
  (with --webkit) in test/e2e/run.mjs; bundle src/calls in dist/ with the loader.

```
{"file":"calls.json","id":"calls-sig-001-ring","sha256":"815d7c874e9f58c7b5bf711de308e689e73f859afe54daa70d5982da6c6e6c54"}
{"file":"calls.json","id":"calls-sig-002-accept-audio","sha256":"10d028796b0835e75cf28b23438d8ced94d2f1fc84eca911789e1e55bb8935c4"}
{"file":"calls.json","id":"calls-sig-003-offer","sha256":"ed086d6c6976d294cf51f6e699c4c454741f8a4f6095abd9f1fc7700b1b62a38"}
{"file":"calls.json","id":"calls-sig-004-ice","sha256":"b7e04ae706391f77f86bbe46214701ff9a09aaa4f429c50309e765e22ea30a6f"}
{"file":"calls.json","id":"calls-sig-005-hangup","sha256":"8e51b959fd5cd53928d776c0a8ca5576844cd95dd364b1852e579b18f2bda898"}
{"file":"calls.json","id":"calls-sig-006-leave-group","sha256":"714891e260b0313debf3dc081157ccee46d6d668b6408db241f2d181c6c99250"}
{"file":"calls.json","id":"calls-sig-neg-001-unknown-key","sha256":"65ef59b7ca77e483bfed8a4cc9434942d1766f9cd3521f83878336e0aa7a3bf8"}
{"file":"calls.json","id":"calls-sig-neg-002-sdp-on-ring","sha256":"f24d68f14a99486924c24dec591a745af166119d493f07b14ddea5d731b0978a"}
{"file":"calls.json","id":"calls-sig-neg-003-offer-without-sdp","sha256":"6a462e208387355881adc57241b519a03bce303d2db127f5fc60516f21e6137f"}
{"file":"calls.json","id":"calls-sig-neg-004-sha1-fingerprint","sha256":"54da02833b4b9580f66e37bcdd84c6e0dbc1ae7fcf149d8715cdee7c62f017cb"}
{"file":"calls.json","id":"calls-sig-neg-005-two-fingerprints","sha256":"bfe57883237b972922fcaface5b86d748ddc1d397419a6cd19ad09aacbd8a9bd"}
{"file":"calls.json","id":"calls-sig-neg-006-candidate-newline","sha256":"a17af931988699c65ffa33173b5808b7aada71231c58894f91ee00d213ceb955"}
{"file":"calls.json","id":"calls-sig-neg-007-roster-duplicate","sha256":"6a6836189917859f8b4067848e6c01df656e16b6c9a77ef2d93267ad0f2dd142"}
{"file":"calls.json","id":"calls-sig-neg-008-short-call-id","sha256":"2072406b148c2de5a3b78f5df4bec0d51092ea82adfc167d48ef3c43617f603f"}
{"file":"calls.json","id":"calls-sig-neg-009-version","sha256":"405bb31349c59072a0753d9b2c6a09f0a2267561fd7ab57768008e7a013d9d8a"}
{"file":"calls.json","id":"calls-sig-neg-010-media-type","sha256":"7a80097ff678eac0c2efefd3feb21ee0998befb1d1f1d8a40d28bc4e990785ab"}
{"file":"calls.json","id":"calls-sig-neg-011-kind","sha256":"2c0901085a852425433b2412858f8f8cd10e32003b3f827f1980fffddb2c77f7"}
{"file":"calls.json","id":"calls-bucket-001","sha256":"892c0a672de686b6f7adc537e2ba4a34ebf5221315ab97cc5dfcbc46345bab41"}
{"file":"calls.json","id":"calls-ice-001-filter","sha256":"6503ec84cb566d59af790cdaa775409ba807c56ea8e7299fd6eaa903ade6dfda"}
{"file":"calls.json","id":"calls-ice-002-config","sha256":"cbc28f7bd6aa34ff42d39c6d959b898e43609314663b287ecee977ae14a8003f"}
{"file":"calls.json","id":"calls-media-001-profiles","sha256":"b841f7e20bfb17e9167aff86ab48ded9ef18d23da89019fadea4fc4e526777d0"}
{"file":"calls.json","id":"calls-control-001","sha256":"60639d02bb63530c9c5c187ac88f91d5c0979b54669af1569ba7321455de86f4"}
```

## Open items

- O-1: the spoken safety code for a verified call is P1 (SZ 3.5 "Binding"); `participants[].verified` only passes on
  `chat.contacts.verify`'s flag, which the chat service does not set yet.
- O-2: SZ-4 and SZ-5 are not signed: the caps, the audio-only defaults and "no relay unless the owner runs one" ship as
  chosen constants in src/calls/limits.js.
- O-3: a ring reaches a contact who is not a neighbour only through desktop relays of the chat lane (phones relay
  nothing); "{name} is not connected now" is then E_NO_ANSWER after 45 s, not an immediate answer.
- O-4: mDNS '.local' candidates pass the filter as SZ 3.5 says; resolving one is a local-link lookup our browser makes.
- O-5: the e2e scenarios and the gate rows G-CL-1 to G-CL-9 were not run by this lane (the e2e needs wire-ui and the
  integrator; the gate rows need phones and real networks).

## Progress log (newest last; the session can be cut off)

- 2026-10-20 16:15 ET: brief and spec read (SZ 3.5, R 2.7.3, 2.7.4, 2.7.8, 2.11, the lab, `src/chat/*`, the SVC
  contract in INTERFACES, `mountV03Services`, the members and social e2e scenarios). Plan: limits, signal, ice, adapt,
  mesh, session, service; then the chat seam; then tests, the fake WebRTC fixture, vectors, the browser test and the
  e2e scenarios.
- 16:55 ET: `src/calls/{limits,signal,ice,adapt,mesh,session,service}.js` written; the SIG seam added to
  `src/chat/service.js`; fixtures `test/fixtures/calls/fake-webrtc.mjs` (a fake WebRTC with signaling states,
  transceivers, negotiated data channels, candidates and certificate stats) and `peers.mjs` (real chat services over
  fake wires). Smoke: a 1:1 video call between two Node peers rings, is accepted, connects over SIG really sealed with
  K_pair, passes the certificate check, carries mute over 'mw-call' and hangs up with every capture track ended; the
  loopback and private host candidates were withheld (2), the public one sent (1).
- 17:40 ET: unit tests written and green: calls-signal 11, calls-ice 7, calls-adapt 7, calls-mesh 6, calls-service 15,
  chat-lane-service 15 (10 kept, the direct.connect expectation changed, 5 seam tests added). calls-browser (opt-in,
  MW_BROWSER=1): Chromium 156 and WebKit 27.2 both green on the first real run: connected in about 0.3 s on loopback,
  audio and video both ways, the certificate check 'ok' in both engines (WebKit reports transport.remoteCertificateId
  too), a getStats that shows another certificate ends the call with E_CALL_FAILED ('fingerprint'), a relay that alters
  the answer's fingerprint makes DTLS refuse and the call fail with E_CALL_FAILED, mute and camera off reach the peer,
  hang up closes both connections and ends every capture track, WebKit shares a screen from page.click.
- 18:05 ET: `videoPaused` in the state (call.videoPaused); an adaptation test in Node (loss to a pause and back);
  measured SIG sizes in both engines; e2e scenarios written contract-first (module loads; not run); LOCK lines computed;
  this document's contracts written. All lane tests: 62 passed, 0 failed, 2 opt-in browser tests skipped by default and
  green with MW_BROWSER=1; three runs alike.
