# Chat rows lane (R 4.2 E-CH-2, 3, 4, 5, 7, 9, 10, 11, 12)

Written 2026-10-22 (America/Toronto). Scope: the open chat rows of the R 4.2 table in
`docs/deviations/integration-v03.md` (lines 330 to 340), run end to end in Chromium through Playwright, local-only.

Files: `test/e2e/scenarios-chat-rows.mjs` (new), one registration line in `test/e2e/run.mjs` (lines 1895 and 1896, in the
self-contained group, spliced before scenario 13), this note. No file under `src/` was edited.

## How the rows run: the chat lab

Each peer is a page in its own browser context. The page loads the unbundled chat service (`src/chat/service.js`, the module
the loader bundles) and the vendored WebTorrent bundle from the e2e build, joins swarms on the e2e stack's local tracker and
registers `mw_chat1` through the same `registerWireExtension` seam the loader uses (`test/e2e/scenarios-chat-rows.mjs:80` to
`92`). Every URL is on 127.0.0.1; every run ended with "PASS network policy: every request stayed on 127.0.0.1".

What is a stand-in, and only that (`test/e2e/scenarios-chat-rows.mjs:1` to `40`, `169` to `216`):

- site keys and the chat key are generated in the page (no identity origin);
- the ledger is a stub: role `writer`, a ban set the scenario fills, `mw.ck` ledger copies the scenario adds;
- the loader's consent card answers "Continue" (`prompt: async () => true`, line 209);
- the service's 60 s timers (the WANT-TAGS period and the outbox retry) run every 5 s (line 210).

The 30 s ACK timeout (`src/chat/limits.js:118`), the 2 to 20 s ACK delay, the 0.5 to 3 s relay jitter
(`src/chat/limits.js:74`, `75`), stamps, the Noise handshake, the holder, the relay budgets and the fair queues are the shipped
code, unchanged. Swarms set the topology: a line A - R - B is two swarms that only R joins.

## Row status

All numbers below are from the runs of 2026-10-22: the first full run of the nine rows, the rerun of E-CH-7 and E-CH-10
after the fix described under "Test fix", and a final run of all fourteen chat scenarios. Logs are in the session scratchpad.

| Row | Status | Where | What ran |
|---|---|---|---|
| E-CH-2 | pass | E-CH-2 (`scenarios-chat-rows.mjs:443`) | Recipient offline. After the 30 s ACK timeout, A sent a copy with the hold flag. H held it and sent HOLDING, so A showed "handed" after 30.0 s (1 holder). A then left. B came back, asked with WANT-TAGS, got HELD and read the message from A after 2.2 s. B's COLLECTED emptied the holder after 4.3 s. H read 7 WANT-TAGS frames. |
| E-CH-3 | pass | E-CH-3 (`scenarios-chat-rows.mjs:588`) | The line A - R - B with chatBits 20 (the default). A sent 5 stranger frames whose stamps were below 20 bits: R struck all 5 for the stamp and relayed 0, and B read 0 ENV frames and 0 requests. Then A sent a real stranger message: the 20-bit stamp took 502 ms to mint (Chromium on this machine, one sample). It reached B's requests 1.1 s after it left A, and B accepted it and read the text. |
| E-CH-4 | pass | E-CH-4 (`scenarios-chat-rows.mjs:631`) | The line B - R - A, both in the Lobby. Before the ban, B's room message reached A. Once the ban was in R's and A's ledgers, R read B's next room frame and relayed none (its relayed count stayed at 1), and A showed 0. Once the ban reached B's own ledger, B's `chat.room.send` returned `E_BANNED`. |
| E-CH-5 | pass, partial | E-CH-5 (`scenarios-chat-rows.mjs:674`) | A (admin), B and C start the group. A then removed C and invited D at the same moment (two calls in parallel). B and D converged on one epoch with members A, B and D, the epoch A ended on, and it stayed stable for 4 s (B saw 0 conflict events). C read nothing written after its removal (8 s wait). D never saw the earlier message, and its sealed store held 1 secret in 1 epoch, none from the first epoch. Not driven: two admins rekeying at once. The API makes the group's creator its only admin, so this case is unit-tested only (chat-lane-groups, U-CH-6). |
| E-CH-7 | pass, partial | E-CH-7 (`scenarios-chat-rows.mjs:754`) | The device class can be decided under Chromium emulation, so this row runs. P is an Android phone emulated in Chromium (`ANDROID_CONTEXT`, line 361: user agent, 412 x 915 viewport, touch, coarse pointer). The loader's own `detectEnvironment` (`src/loader/policy.js:54`) and `chatDeviceClass` (`src/loader/api.js:1880`) class it as "android", the same calls `src/loader/app.js:3068` and `src/dropin/engine.js:1790` make. On P, `chat.holder.set` returns `E_POLICY`. On the line A - P - B, P read 1 ENV frame and relayed 0 bytes, and B got nothing in 10 s. Control: a desktop relay R relayed 1 frame and B got the message. Not driven: Android after "Share on this network" (8 KiB/s, `src/chat/limits.js:77`) and the iOS class. |
| E-CH-9 | pass | E-CH-9 (`scenarios-chat-rows.mjs:494`) | The line A - H - B, where H is a holder. B had the message 2.4 s after the send, and A showed "delivered" after 20.8 s, inside the 30 s ACK timeout. 35 s after the send, H had read 2 ENV frames and relayed 2, none with the hold flag, and held 0. |
| E-CH-10 | pass | E-CH-10 (`scenarios-chat-rows.mjs:801`) | Relay R has three neighbours: X, A and B. X floods R at 24 frames a second, each 16,115 bytes with a valid 10-bit stamp, for 16 s: 384 frames, 6,043 KiB. R relayed 158 of them and dropped 218 at its queue caps. **The 5 s bound was measured and met: contact DM latencies A to B under the flood were 2.90 s, 2.60 s and 1.41 s** (this includes the 0.5 to 3 s relay jitter). The measurement starts once R holds B's WANT-TAGS route; see "Observations". |
| E-CH-11 | pass | E-CH-11 (`scenarios-chat-rows.mjs:537`) | Frames captured at E-CH-9's relay H, after the wire's Noise layer. Scanned: 16 conversation frames (2 ENV) and 23 sealed wire messages. None held the plaintext, a site key, or an inbox tag computable from a public chat key for yesterday, today or tomorrow (`src/chat/tags.js` `inboxTag`). 14 WANT-TAGS frames held 168 entries, all 1-byte prefixes, with 5 to 32 entries per frame. The 2 decrypted CK frames carry "p256:", and the sealed bytes do not, which shows the capture read the decrypted layer. |
| E-CH-12 | pass | E-CH-12 (`scenarios-chat-rows.mjs:855`) | Three runs of a relay M that swaps BitTorrent peer ids. (1) M forwards bytes unchanged: both handshakes ended with the real chat keys, the DM was delivered, M's log held no text and no key, and the 3 messages M injected each failed A's session AEAD and were struck. (2) M swaps the XX ephemeral key: the handshake failed (`xx2`) and 0 sessions were set up. (3) M answers as itself: A sees M under M's own chat key, never as B, and the DM still reaches B sealed and is not readable at M. |

Final run of all fourteen chat scenarios (E-CH-6M, E-CH-R, E-CH-1, E-CH-8, E-CH-6 and the nine above), 2026-10-22:
"OK: 14 passed, 0 failed, total 196.0s" and "PASS network policy: every request stayed on 127.0.0.1". That run's numbers:
E-CH-10 DM latencies 2.12 s, 1.66 s and 1.41 s (R relayed 143 and dropped 214); E-CH-3 stamp minted in 147 ms; E-CH-2
delivered from the holder 0.4 s after B came back, and the holder was empty after 4.3 s. Across the two runs, the six
flooded DMs took between 1.41 s and 2.90 s, and the two 20-bit mints took 147 ms and 502 ms.

## Test fix (in this lane's own file)

The first run failed E-CH-7's control step and E-CH-10's warm-up: the DM never reached B within 20 s. The cause is in the
shipped design, not a defect. When a relay has no WANT-TAGS route for a frame's tag, it forwards the frame to a random half of
its eligible neighbours (`src/chat/lane.js:605` to `613`, `_randomHalf` at `586` to `595`, design review line 675: "goes to a
random half of eligible neighbours (chosen; STALK A3)"). With two eligible neighbours, a first DM reaches B half the time.
The scenarios now wait until the relay holds a WANT-TAGS prefix route toward B that was set after the contacts were added
(`routed`, `scenarios-chat-rows.mjs:431`), and only then send. Both rows then passed.

## Observations for the integrator (not defects)

- The E-CH-10 bound is measured from the moment the relay holds the recipient's WANT-TAGS route. Before that, a contact DM
  across a relay with k eligible neighbours (k >= 2) reaches its recipient with probability ceil(k/2)/k per hop (arithmetic
  from `_randomHalf`). A miss is left to the later paths: the 30 s ACK timeout and hold flag (`src/chat/limits.js:118`) and
  the outbox retry (`OUTBOX_RETRY_MS` 60 s, `src/chat/limits.js:121`); this lane did not time that recovery. In shipped
  timing a route forms within one WANT-TAGS period (`WANT_INTERVAL_MS` 60 s, `src/chat/limits.js:124`; the lab uses 5 s). The design chose this behaviour (STALK A3). Whether the first DM after a
  join needs a 5 s bound too is an owner or design question.
- E-CH-10 measured three DMs on one machine over loopback. Phone timing (G-CH-6, G-CH-7) is not measured.

## Defects found

None. No file under `src/` was edited.

## R 4.2 cell texts (for `docs/deviations/integration-v03.md`)

| E-CH-2 | pass | E-CH-2 | recipient offline: the ACK timeout (30 s) sets the hold flag, a holder holds the frame ("handed" at the sender), the sender leaves, the recipient returns and collects it with WANT-TAGS and HELD, and COLLECTED empties the holder (`scenarios-chat-rows.mjs`) |
| E-CH-3 | pass | E-CH-3 | 5 stranger frames with stamps below 20 bits: struck by the relay, 0 relayed, 0 at the recipient; a stranger message with a stamp minted at 20 bits (147 ms and 502 ms in two runs, Chromium, this machine) lands in requests and is accepted |
| E-CH-4 | pass | E-CH-4 | after the ban, the relay reads the banned member's room frame and relays none, and the reader shows nothing; the banned member's own send is `E_BANNED` |
| E-CH-5 | pass, partial | E-CH-5; unit: chat-lane-groups (U-CH-6) | a removal and an invite started at the same moment converge on one epoch (A, B, D); the removed member reads nothing after removal; the newcomer has no earlier message or epoch secret; two admins rekeying at once is unit-tested only (the API has one admin) |
| E-CH-7 | pass, partial | E-CH-7 | an Android context under Chromium device emulation is classed "android" by the loader's `detectEnvironment` and `chatDeviceClass`; holder `E_POLICY`; a line through the phone relays 0 bytes, and a desktop relay delivers; "Share on this network" and the iOS class are not driven |
| E-CH-9 | pass | E-CH-9 | a DM delivered live across a holder (ACKed after 20.8 s): no frame with the hold flag reaches the holder, which holds 0 |
| E-CH-10 | pass | E-CH-10 | a neighbour floods the relay with 16 KiB frames at 24 a second (6,043 KiB in 16 s; 218 dropped at the queue caps); six contact DMs over two runs took 1.41 s to 2.90 s (bound 5 s, met), measured once the relay holds the recipient's WANT-TAGS route |
| E-CH-11 | pass | E-CH-11 | frames captured at a relay after Noise: no plaintext, no site key, no publicly computable inbox tag; WANT-TAGS entries are 1-byte prefixes (168 entries in 14 frames), and sealed wire bytes carry no key text |
| E-CH-12 | pass | E-CH-12 | a relay that swaps peer ids: forwarding unchanged gives sessions with the real keys and nothing readable, and injected messages fail AEAD; swapping the XX ephemeral fails the handshake; answering as itself, it is seen under its own chat key |

## Requests (area docs)

- `docs/deviations/integration-v03.md` R 4.2: replace rows E-CH-2, 3, 4, 5, 7, 9, 10, 11 and 12 (lines 330 to 340) with
  the cell texts above, and drop "E-CH-1 to E-CH-12 except the media gate" from the "not added yet" sentences (lines 90 and
  220).
- `docs/INTEGRATION-STATUS.md`: name the measured E-CH-10 number (six contact DMs under a relay-cap flood took 1.41 s to
  2.90 s, bound 5 s, one machine, loopback, two runs) and the 20-bit stamp mint time (147 ms and 502 ms, two Chromium samples
  on this machine).
- Chat area docs (ARCHITECTURE section 15 or the chat deviations note, owner's choice): record that the 5 s bound holds once
  the recipient's WANT-TAGS route exists at the relay; a first DM before that depends on the random half and the outbox retry.
