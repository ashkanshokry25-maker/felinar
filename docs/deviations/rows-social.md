# Social rows lane (R 4.2 E-SO-3 to E-SO-9), 2026-10-22

Lane: social rows of the R 4.2 table in [integration-v03.md](integration-v03.md) (rows E-SO-3 to E-SO-9), driven against the real
loader, SDK, hub follow lane and identity origin on the loopback subdomain hub of `test/e2e/hub-stack.mjs`, not the mock SDK.
Scenario file: `test/e2e/scenarios-social-rows.mjs`, registered in `test/e2e/run.mjs` before scenario 13 (one block, after the chat
rows lane's). Chromium only, because labels are hostnames under `.localhost` ([DEV-NETWORK.md](../DEV-NETWORK.md)).

No file under `src/` changed in this lane. `src/chain/recent.js` and `tools/snapshot.mjs` already write and load `recent-v1` windows
(`tools/snapshot.mjs --recent-out`, `src/chain/node.js` 2254 `importSnapshot`). Nothing was promoted from "(proposed)": the two
pieces the brief named as "not built" (the hub's per-ledger `cs=` first screen and `mw.mod.requestJoin`) have contracts with missing
clauses, quoted below.

## Rows

| Row | Status | Scenario | What it proves (loopback, Chromium) |
|---|---|---|---|
| E-SO-3 | pass | E-SO-3 | BO's comment on ADA's post is an `mw.c` item on BO's own ledger aimed at ADA's post; ADA's page finds it in BO's window, her wall setting accepts it and her `mw.ok` lists it (3,458 to 6,506 ms in three runs); CY, who follows only ADA, opens the post and sees "Comments (1)", accepted |
| E-SO-4 | pass | E-SO-4 | BO reacts "heart", then "laugh": one key `re/<ADA's ledger>/<h>` on BO's ledger with `{ r: 'laugh' }`; CY counts 0 before following BO and "1 from people you follow" after; ADA counts 1 |
| E-SO-5 | open | E-SO-5 (runs only when named: `--only E-SO-5`) | The 20 tool-made ledgers are made and served as `cs=` windows, but no browser holds them on the hub lane: defect D-1 below. The scenario stays in the file so the integrator can run it after the fix |
| E-SO-6 | partial | E-SO-6 | A reader's first visit to a tool-made page nobody holds: the first screen comes from the page's own loopback `cs=` recent window (`recent-v1`, 16 blocks), newest first, 12 posts in 1,068 to 1,100 ms. Open: the member's merged first screen from the hub's per-ledger windows (missing clause C-1) |
| E-SO-7 | pass | E-SO-7 | A group made with the tools (writers `allow`, ADA moderator, `_mw.cfg.chat` open). BO taps "Ask to join": a join grant reaches ADA's `mw.mod.queue` in about 2,017 ms; ADA accepts on the loader's moderator card ("Confirm"); BO's role becomes writer, the page says "You're in."; `allowCount` 1 within `modAllowPerDay` 20; BO posts in the group; ADA bans BO and the post goes for both. Precondition: ADA and BO are contacts (D-2). The request travels as `mw.chat.dm.send` grants, not `mw.mod.requestJoin` (C-2) |
| E-SO-8 | pass | E-SO-8 | ADA's Alerts list a reply, a follow and a mention from BO (from BO's window, `notices.js` `syncedNotices` and `mentionsOfMe`), and on the group page "New messages" after BO's direct message |
| E-SO-9 | partial | E-SO-9, E-SO-9B (E-SO-9B runs only when named) | E-SO-9 (pass): every other browser closes its pages and ADA's browser goes offline; she posts, the post shows at once (526 ms) with "Showing what this device has. Last updated ..."; an offline reload shows the shell, the app and her posts from this device. E-SO-9B (open, D-1): back online, BO reopens his page and should get the post over the hub lane. It passed alone (23,486 ms from the network's return, including BO's page load and sign-in) and failed after the other rows: ADA's reloaded page held no ledger on the lane (`held` 0, `due` 1 for 58 s) |

Numbers are from the runs logged on 2026-10-22 between 15:42 and 16:21 ET (eight runs; the last, of E-SO-3, 4, 6, 7, 8 and 9 together, passed) (`node test/e2e/run.mjs --only ...`); every run ended with
"PASS network policy: every request stayed on 127.0.0.1".

## What changed

- `test/e2e/scenarios-social-rows.mjs`: the scenarios above. A `tap()` helper dismisses the loader's recovery-kit card (R 2.2.6), which
  covers the page after a member's first meaningful action, before clicking in the site frame. The moderator cards answer "Confirm"
  (`UI_TEXT.en.modConfirm`, `src/loader/ui.js` 1381, 1443), not "Continue". A site reads its snapshot through `mw.db.subscribe`;
  `mw.db.snapshot` is a Bridge method only ([SDK.md](../SDK.md) line 220). E-SO-9 closes the other browsers' pages, because
  Playwright's offline mode blocks new requests but leaves an open WebRTC data channel working, so "offline" alone does not take the
  peers down (the first version of the row passed for that reason).
- `test/e2e/hub-stack.mjs` (additions): `makeSyntheticPages` (keygen, `ledger-admin` genesis with the personal policy, keyinfo, name,
  posts, `snapshot.mjs` recent window, a pointer signed for the hub scope with its own `cs=`) and `makeGroupSite`; `socialDriver` for
  the helpers other scenario files need.
- `examples/social`: join requests without `mw.mod.requestJoin` (`hub.js` `joinGrant`, `joinRecipients`, the `requestJoin` fallback),
  the four request screens (`views/group.js`), `pointerFor` for a first follow by id (`model.js`), notices taken from followed windows
  (`notices.js` `syncedNotices`, `data.js` `scanSynced`), and `mentionsOfMe` matching both short id formats (D-3;
  `views/notifications.js`).
- `test/unit/social-rows.test.mjs`: 8 tests for the pieces above.

## Defects found (code this lane may not edit; rows stay open or carry a precondition)

| ID | File, line | Scenario | Fix | Test |
|---|---|---|---|---|
| D-1 | `src/loader/app.js` 3480 to 3483 (`joinHubLane`) with 3095 (`mountHub` runs after the services) and 2410 (`ledger open`) | Seen twice. (1) E-SO-9B: after an offline reload, ADA's own page held no ledger on the lane, so her post written offline never left (58 s, `held` 0). (2) The lane holds the page's own ledger only if `A.node` exists when `joinHubLane` finishes its awaits. On a page whose ledger opens after the services mount (log: "v0.3 services" at 58.799, "ledger open, height 0" at 58.817), the ledger is never held: a reader page of a tool-made personal page showed `hubLane.held: []` with the ledger at height 8 for 40 s (E-SO-5). ARCHITECTURE 15.8 says the loader "holds the member's own ledger in full"; a member whose page opens this way cannot be followed over the lane | Hold the page's ledger when it opens as well as at join: where `A.node` is set, `A.hubLedgers.set(A.ledgerId, A.node)` then `A.multi.hold(A.ledgerId)` when `A.multi` and `A.hubLane` exist (`hold` is idempotent, `src/chain/multi.js` 428 to 434). Whether a visitor's page should hold the ledger it shows (not only the owner's) is a design choice for the integrator; E-SO-5's seeders need it, or the hub snapshot path of C-1 | e2e E-SO-5 (`--only E-SO-5`); a unit test that opens the node after `joinHubLane` resolves and expects `multi.stats.held` 1 |
| D-2 | `src/chat/service.js` 1234 (`chat.dm.send`) | A join request from someone who is not yet a contact is refused at the sender with `E_POLICY` ("this site does not take message requests") when the group's message requests are off, the default. R 2.5.2 addresses the request to the moderators' chat keys with no contact precondition, so a stranger cannot ask to join. E-SO-7 adds the contacts first | Let a grant `{ t: 'join' }` to a key that is the owner or a moderator of this ledger through as a stranger message, and have the moderator's loader route it to `mod.receive` without the requests switch; or carry joins as `KIND.join` (reserved, `src/chat/limits.js` 165, unused) with that rule | e2e E-SO-7 without the contacts step; unit: a stranger's join grant to a moderator reaches `mod.queue()` |
| D-3 | `src/identity/service.js` 194 (`short: keys.short`), `src/idp/cards.js` 137 (`shortId`), [SDK.md](../SDK.md) 322 and 422 | `identity.short` from the real loader is the identity card's format ("cw3y-mu8w", 8 base32 characters with a dash), while SDK.md shows "5666dca3" (8 hex) and the example derives others' short ids as 8 hex (`examples/social/js/ids.js` 116). On one screen a member's own chip and the people around them use two formats, and a person comparing short ids (MF-70) sees different codes on the identity card and on the site. The example now matches mentions in both formats; the chip still shows the loader's | One format everywhere: either SDK.md and the example adopt the card format, or the identity service returns the 8-hex form. Owner or integrator decision | `test/example` mock data uses `shortIdOf`; an e2e check that `ready().identity.short` equals the example's `shortIdOf(pub)` (fails today) |

## Missing clauses (rows left open rather than guessed)

- **C-1, E-SO-6, the hub's recent-window first screen.** R 3.2.2 ("Snapshot first: where the hub pins, the first screen comes from `cs=`
  snapshots of each followed ledger's recent window over HTTPS") and ARCHITECTURE 15.8 ("(proposed) The first screen from the hub's
  recent-window `cs=` snapshots (`loadRecentSnapshot`; E-SO-6)") do not say where a followed ledger's window is found. A personal
  pointer made in the browser carries no `cs=` (INTERFACES 1193, final integration F-1), the hub amendment's `mw.hub.follow` takes a
  pointer or an id, and no URL scheme for a hub's per-ledger window exists. Needed: the URL (for example a hub path keyed by ledger
  id), who writes it (the pin node, `tools/pin.mjs`), and when a follower reads it before the lane. The building blocks exist and are
  tested: `windowFromDag`, `encodeRecentSnapshot`, `loadRecentSnapshot` (`test/unit/hub-lane-recent.test.mjs`), `snapshot.mjs
  --recent-out` (`test/unit/tools-snapshot.test.mjs`), and the loader applies a `recent-v1` page window (E-SO-6 partial).
- **C-2, E-SO-7, `mw.mod.requestJoin(group)`.** INTERFACES 1210 to 1211 names it only as "(proposed)". R 2.5.2 gives the transport ("a
  sealed `join` item (2.6) addressed to the moderators' chat keys, carried as an ENV with the `hold` flag") and four screens, but not:
  the return value and error codes; how "Your request was declined" reaches the requester (`mod.decide` with `decline` sends nothing,
  `src/loader/mod.js` 436 to 457); whether a join is a 2.6 sealed item or a chat grant (the loader takes `{ t: 'join' }` grants,
  `src/loader/mod.js` 351, and `KIND.join` is unused); and the stranger rule of D-2. Adding the method also touches files outside this
  lane: the static stub `src/sdk/sdk-static.js` 64 and the method tables test `test/unit/sdk-v03-tables.test.mjs` 66 to 70 and 138. The
  example works without it (E-SO-7 passes over `mw.chat.dm.send`) and uses it the day it exists (`hub.js` `joinBySdk`).

## Requests

- ARCHITECTURE 15.8 and INTERFACES 1210: keep "(proposed)" on the hub's recent-window first screen and add C-1's missing clause in
  the same sentence. Suggested text for 15.8, after "(`loadRecentSnapshot`; E-SO-6)": "Not specified yet: where a followed ledger's
  window is published and found (a personal pointer carries no `cs=`). A page's own `cs=` may already be a `recent-v1` window
  (`snapshot.mjs --recent-out`), which the loader applies as it applies any snapshot (e2e E-SO-6, partial)."
- INTERFACES 1211 and examples GAP 4: keep `mw.mod.requestJoin(group)` "(proposed)" and list C-2's four open points there.
- docs/SDK.md: no paragraph, because the method is not built.
- Integrator: D-1 to D-3. After D-1, run `node test/e2e/run.mjs --only E-SO-5,E-SO-9B` (each runs its prerequisites) and, when
  both pass, drop the `named()` gate in `SOCIAL_ROWS_ORDER` so they join the default order.
