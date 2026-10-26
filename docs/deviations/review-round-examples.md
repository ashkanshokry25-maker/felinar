# Review round, examples fixer (findings SYB-12, UX-15, UX-16)

Written 2026-10-24 04:15 EDT (America/Toronto). Brief: the "examples" area of the review round (V03-DESIGN-REVIEW 5.3, step 2).
Serious: SYB-12. Minor: UX-15, UX-16. Records: `.orchestration/reports/all-findings-2026-10-22.json` and
`.orchestration/reports/verdicts-2026-10-23.json`.

An earlier run of this fixer was cut off after editing the guestbook and its tests (`git diff 4e82be5 HEAD -- examples test/example`).
This run reviewed those edits line by line, kept them, and finished the round: SYB-12 test, this note, the runs below.

Files this round: `examples/peer-guestbook/js/app.js`, `examples/peer-guestbook/js/common.js`, `examples/peer-guestbook/js/members.js`,
`test/example/site.test.mjs`, `test/example/sdk-surface.test.mjs`, `test/example/browser.test.mjs`, `test/example/browser-v03.test.mjs`,
`test/example/social-notice-sender.test.mjs` (new) and this note. No file under `examples/social/`, `src/` or `tools/` was edited.
No wire, storage or vector format changed.

## Findings

| Finding | Status | Files | Test |
| --- | --- | --- | --- |
| SYB-12 (major): the social template trusts the `from` ledger of a notice instead of the authenticated sender (`examples/social/js/data.js:423`) | partial: the fix is written and verified, but `examples/social/**` belongs to another workflow (Request 1) | `test/example/social-notice-sender.test.mjs` (new) | `node --test test/example/social-notice-sender.test.mjs`: 1 pass, 6 todo on the current tree; 7 of 7 pass against a copy with Request 1 applied |
| UX-15 (minor): the guestbook shows the SDK's internal `err.message` for codes missing from its table | fixed | `examples/peer-guestbook/js/common.js:27`-`68`, `examples/peer-guestbook/js/app.js:20`-`70` | `test/example/site.test.mjs:470` (every code of `src/loader/api.js` ERROR_CODES has a sentence in both tables, the SDK's own words, never `err.message`); `test/example/browser-v03.test.mjs:153` (E_SYNCING and an unknown code in the toast) |
| UX-16 (minor, MF-70): a self-chosen name shows without the short id | fixed | `examples/peer-guestbook/js/app.js:304`, `examples/peer-guestbook/js/members.js:28`-`33` | `test/example/browser.test.mjs:163`, `:181`, `:195`, `:351` (entries: "Alice (short id)"); `test/example/browser-v03.test.mjs:382`, `:390` (Lobby lines); `test/example/site.test.mjs:496` |

### SYB-12

Confirmed in the code as both verifiers describe it: `chat.js:43` hands `(notice, msg)` to the listener and `data.js:174` forwards both,
but `handleNotice(n)` (`data.js:423`) never reads `msg`. The blocked check uses the claimed ledger's owner (`data.js:426`-`427`), the
wall decision gets `fromLedger: n.from` (`data.js:431`) and an accepted ref goes to `queueOk` (`data.js:433`, `:444`) with no per-sender
bound. The fix is Request 1. What it does:

- A chat notice counts only when this browser holds the ledger the notice names and that ledger's owner is the key the loader
  authenticated (`msg.from.pub`, `src/chat/service.js` builds it). A notice for a ledger this browser does not hold is dropped: its owner
  cannot be checked. Notices from a followed window (`scanSynced`, `data.js:102`-`113`) pass no `msg` and keep working, since they are
  that ledger's own word.
- A notice speaks only for blocks of its own ledger: `n.ref.l` must equal `n.from` (every notice the template sends satisfies this:
  `data.js:266`, `:267`, `:281`, `:282`, `:297` use refs on `state.siteId`, the sender's own ledger).
- The blocked check runs on the sender's key as well as on the ledger owner.
- One key puts at most 20 refs an hour before the wall setting (reply and wall notices), with at most 1,000 keys remembered.

Not done, with the reason: the finding also proposes checking that the referenced block exists and has `to` = this wall before `mw.ok`.
A live notice usually arrives before the sender's window has synced the new block, so the check would drop honest notices; once
`n.ref.l === n.from` and the sender owns that ledger, the sender can only get their own block accepted, which the wall mode already
allows for a followed sender, and the views show an accepted wall post only when it names this wall (`model.js:289`-`299`, as the first
verifier traced). The cost of the strict owner check: a notice from a ledger the reader does not hold is not shown. In this build chat runs
per page ledger, so notices from another member's home page rarely reach yours anyway (`notices.js:86`-`87`,
`docs/deviations/rows-social.md` D-3), and the followed-window path still produces replies and follows.

The regression test, `test/example/social-notice-sender.test.mjs`, drives the real `createData` with a fake SDK (Sam on his own page,
following Fiona through `mw.hub`, Mallory a contact he does not follow). Six cases are node:test `todo` until Request 1 lands, as in
`docs/deviations/review-round-tests.md`; they arm themselves when `handleNotice` takes the chat message as its second argument
(`d.handleNotice.length >= 2`), so the integrator does not need to edit the test. `MW_SOCIAL_DIR` points it at another copy of the
template, as `test/example/social-browser-lib.mjs:9` already does.

| Line | Case | Today | With Request 1 |
| --- | --- | --- | --- |
| `test/example/social-notice-sender.test.mjs:72` | control: an honest wall notice from Fiona's key is accepted | pass | pass |
| `:84` | a wall notice naming Fiona's ledger, sent by Mallory: no mw.ok, no alert | todo (fails) | pass |
| `:94` | a forged reply notice: no mw.ok, no alert | todo (fails) | pass |
| `:103` | a forged "followed you", and one for a ledger not held: no alert | todo (fails) | pass |
| `:112` | Fiona's key names Mallory's block: no mw.ok | todo (fails) | pass |
| `:120` | a blocked key, whatever ledger it names: dropped | todo (fails) | pass |
| `:132` | 200 wall notices from one key: at most 20 refs in mw.ok | todo (fails: 200 refs) | pass |

Verified against a copy of `examples/social` with Request 1 applied (scratch, outside the project): the new file 7 of 7, and with
`MW_SOCIAL_DIR` set to that copy every `test/example/social-*.test.mjs` file passes, 112 of 112, including the browser tests of incoming
notices (`social-browser.test.mjs:346`, `social-browser-more.test.mjs:203`) and the site lint (`social-site.test.mjs:13` reads the copy).

### UX-15

Both guestbook tables now hold a sentence for every code in `src/loader/api.js` ERROR_CODES, the SDK's own words from
`src/loader/strings.js` ERROR_TEXT (or the key `ERROR_STRING_KEYS` names), except the guestbook's older sentences it keeps on purpose
(`test/example/site.test.mjs:476` lists them). `explain()` never returns `err.message`: a code without a sentence gets "Something went wrong
(CODE).", a thrown page error "Something went wrong." (`common.js:64`-`68`, `app.js:67`-`70`). `{name}` in an SDK sentence becomes "this
person". The two source checks that sliced the table up to `export const explain` now slice up to `export function explain`
(`test/example/site.test.mjs:315`, `test/example/sdk-surface.test.mjs:101`).

### UX-16

Every self-chosen name now shows as "name (short id)": guestbook entries (`app.js:302`-`304`) and Lobby lines (`members.js:28`-`33`).
A key without a name shows the short id alone. The short id comes from the key (sha256 of the raw key, the loader's rule), or from the
loader's own `identity.short` for the visitor's own lines; a remote room message carries only the sender's key
(`src/chat/service.js:850`), so nothing a sender types can set it.

## Runs (2026-10-24, EDT)

- `npm run test:example` (04:10): 186 tests, 180 pass, 6 todo (the SYB-12 cases), 0 fail. `npm run check:example`: 2 sites, 7 pages,
  0 errors.
- `node test/e2e/run.mjs --only 1,2` (04:08): 2 passed (the guestbook post through the form, the "Posted." toast), every request on
  127.0.0.1. `--only E-CH-1` (04:08): passed, every request on 127.0.0.1. (`--only 3,E-CH-1` reported 3 as failed only because
  scenario 3 needs scenario 1's visitor.)
- `npm test` (04:11): lint floor clean over 147 files; the unit run stopped at its 300 s limit. Failures, none in this area:
  `test/unit/repo-layout.test.mjs:31` (a tracked top-level `SECURITY-KEY.asc` the layout does not list), `test/unit/tools-demo.test.mjs:135`
  (the demo's tracker allows 3 infohashes, not 2; `tools/publish.mjs` has uncommitted edits by another lane), and
  `test/unit/ui-c2-cards.test.mjs` ("ReferenceError: notice is not defined", which also kept a file open past the limit). The
  `files-c2-handoff` failure named in the brief belongs to the media area.

## Requests

1. **SYB-12, for the owner of `examples/social/**` (integrator).** File `examples/social/js/data.js`, lines 423-430. Old text:

   ```js
     function handleNotice(n) {
       const o = own();
       if (n.from === state.siteId) return;
       const pubOfSender = (views.get(n.from) || {}).owner;
       if (pubOfSender && blockedSet().has(pubOfSender)) return;
       pushNotice(n);
       if ((n.k === 'reply' || n.k === 'wall') && isHome() && o) {
         const sender = views.get(n.from);
   ```

   New text (the rest of the function, from `const decision = ...` on, is unchanged):

   ```js
     // SYB-12: refs one sender key may put before the wall setting per hour, so a contact cannot make this page sign mw.ok items without end.
     const NOTICE_REFS_PER_HOUR = 20, refTimes = new Map();
     function spendRef(key) {
       const t = env.now(), times = (refTimes.get(key) || []).filter((x) => t - x < 3600000);
       refTimes.set(key, times);
       if (times.length >= NOTICE_REFS_PER_HOUR) return false;
       times.push(t);
       if (refTimes.size > 1000) refTimes.delete(refTimes.keys().next().value);
       return true;
     }
     /**
      * handleNotice(n, msg): msg is the chat message that carried the notice (chat.js onNotice); without msg the notice comes from a followed
      * window (scanSynced), which is that ledger's own word. A notice's `from` is typed by its sender (SYB-12), so a chat notice counts only
      * when this browser holds the ledger it names and that ledger's owner is the key the loader authenticated (msg.from.pub); a notice
      * speaks only for blocks of its own ledger; a blocked key is dropped; one key puts at most NOTICE_REFS_PER_HOUR refs before the wall setting.
      */
     function handleNotice(n, msg) {
       const o = own();
       if (!n || n.from === state.siteId) return;
       const sender = views.get(n.from);
       const pubOfSender = sender && sender.owner;
       if (n.ref && n.ref.l !== n.from) return;
       if (msg !== undefined) {
         const key = msg && msg.from && typeof msg.from.pub === 'string' ? msg.from.pub : '';
         if (!key || blockedSet().has(key) || pubOfSender !== key) return;
       }
       if (pubOfSender && blockedSet().has(pubOfSender)) return;
       const walled = (n.k === 'reply' || n.k === 'wall') && isHome() && o;
       if (walled && msg !== undefined && !spendRef(pubOfSender)) return;
       pushNotice(n);
       if (walled) {
   ```

   Test: `node --test test/example/social-notice-sender.test.mjs` goes from 1 pass and 6 todo to 7 pass and 0 todo with no edit to the
   test; then `npm run test:example` (112 social tests passed against the patched copy). Keep the signature `handleNotice(n, msg)` with
   two declared parameters: the test arms itself on it. After it lands, add one row to `docs/deviations/rows-social.md` (or the social
   README) saying a notice from a ledger this browser does not hold is not shown, since its owner cannot be checked.
