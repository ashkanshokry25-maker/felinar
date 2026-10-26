# Review round R 5.3: fixer loader-pointer (2026-10-24)

Area: the pointer and the loader's resolution path (`src/common/**`, `src/loader/app.js`, `doh.js`, `mod.js`). Brief:
the confirmed findings PTR-1, PTR-2, PTR-3 (blockers), PTR-4, PTR-5, PTR-6, PTR-8, PTR-9, PTR-11, PHISH-7, GATE-1,
SYB-11, and the minors PTR-12, PTR-13, PTR-14, SYB-18, CONF-1 (records in
`.orchestration/reports/all-findings-2026-10-22.json`, verdicts in `verdicts-2026-10-23.json`). No wire, vector or
existing storage format changed; one new preference key is added (`ledger:<ledgerId>`, below). Nothing was committed,
pushed or published.

Regression tests: `test/unit/review-round-loader-pointer.test.mjs` (new, 17 tests), plus edits to
`test/unit/loader-common-doh.test.mjs`, `test/unit/common-withdrawal.test.mjs` and
`test/unit/harden-loader-state.test.mjs` (the old expectations the fixes change on purpose).

## Findings

| Id | Status | What changed (file:line) | Test |
|---|---|---|---|
| PTR-1 (blocker) | fixed | `pointerLineage()` (src/common/pointer.js:788) says whether a signed record earned the ledger its `lo=` names: `owner`, `rot` (rot= signed by lo=, one step, as the identity origin checks), `carried` (continues a record or a per-ledger memory this device accepted with proven lineage, or matches its nx=), else `unproven`. `vetCandidate` sets `cand.lineage` (src/loader/app.js:240); `resolvePointer` returns it; `lineageAction()` (app.js:299) decides: hub-sub refuses the mount (the address is that ledger's label, app.js:1211), hub-shared and door mount read only with no restored sign-in (app.js:3354), no moderator key (app.js:2537) and never `setCurrent` (app.js:2078); shell is only logged (the host serves its own origin and the identity origin already gives it the origin label, src/identity/derive.js:296). Update checks refuse an unproven update (`guardUpdate`, app.js:2852). | `PTR-1: pointerLineage ...`, `PTR-1: a stranger's record lo=<victim> ...` |
| PTR-2 (blocker) | fixed | The `#host:name@<fp>` check compares the fingerprint with `owner=`; the `lo=` form matches only with lineage `rot` or `carried` (app.js:482). | `PTR-2: "#host:name@<fp of V>" ...` |
| PTR-3 (blocker) | fixed | Both update paths build their context with `updateContext(A)` (app.js:2842: the rendered record is `previousRecord`, its seq the floor) and run `guardUpdate` (app.js:2852: an owner change goes through `rotationDecision`, an accepted one shows the "owner changed" notice; unproven lineage is refused). The resolvePointer floor and previous record are re-derived from the saved raw text (PTR-11). | `PTR-3: the update paths vet ...` (also a source scan that both update functions use `updateContext` and `guardUpdate` and never copy `A.pointerCtx` alone) |
| PTR-4 | fixed (code); docs claim is a request | Per-ledger memory `ledger:<ledgerId>` = `{ seq, owner, nx, at }` (app.js:271, `noteLedger` app.js:315), written only from a record with proven lineage and never from a seq more than a day ahead; `vetCandidate` refuses a lower seq of the same ledger (`seq-rollback`) in every mode and for every source, the saved copy included (app.js:240). DoH: an empty or NXDOMAIN answer asks the next resolver (src/loader/doh.js:351), and `dnsCandidate` passes `accept` so an answer with no acceptable record (older seq, floor, bad signature) also moves on (app.js:386). The signed `minSeq` and the two-source disagreement notice are not built: see Requests 6. | `PTR-4: a link to an older version ...`, `PTR-4: dnsCandidate asks the next resolver ...`, `resolveTxt (PTR-4, PTR-12) ...`, `resolveTxt (PTR-4): accept() ...` |
| PTR-5 | fixed | A first visit (no pin for the scope, no memory of the ledger) that meets a recorded rotation (`rot=` with `lo=` another key) younger than 24 h is held: `resolvePointer` returns `rotationHold` and saves neither pin nor pointer, so a reload is still a first visit (app.js:544); `run()` calls `presentOwnerChange` for it (app.js:1255). A returning visitor's previous owner comes from the pin when the saved copy is gone. An aged first-visit rotation shows no notice (app.js:3867). Consequence, by design of `rotationDecision` (src/loader/harden.js:271): publish re-signs `rot=` with `--prev-key` on every publish that keeps the ledger (tools/publish.mjs:1521), so first-time visitors of a rotated site wait 24 h after each such publish; see Requests 7. | `PTR-5: a first visit that meets a 5-minute-old rotation ...` |
| PTR-6 | partial | The drop-in engine is not in this brief's files (`src/dropin/engine.js:582`, `src/dropin/stamp.js:146`). The shared pieces it needs now exist in `src/common/pointer.js` (`pointerLineage`) and `src/loader/harden.js` (`rotationDecision`, `withdrawalState`, `loaderFloorOk`, `signRefusal`). Exact edits: Requests 1. | (requested: `dropin-stamp`, `dropin-engine` tests) |
| PTR-8 | partial | `isPublicWebHost` refuses wildcard-DNS names (`WILDCARD_DNS_SUFFIXES`, src/common/magnet.js:154) and names that embed a private IPv4 in dashed or dotted labels (magnet.js:164); `filterWebseeds` applies the host rule to signed records too, with caps 8 ws= and 4 xs= (magnet.js:296); `isPublicHttpsUrl` (magnet.js:264) now guards `cs=` (app.js:2759) and the pin web seed base (app.js:4491); door hints get the stricter `isPublicWebHost` through `hintAllowed`. Still open in files of the other loader fixer: `src/loader/torrent.js:183` returns a signed record's lists unfiltered, tr= hosts and probe concurrency (Requests 2). | `PTR-8: wildcard-DNS names ...`, `web-seed filter ...` (harden-loader-state) |
| PTR-9 | fixed | `gateHoldsDownload(A)` (app.js:2153): every non-shell mode waits for the gate before any byte request, signed or not; the follower tab's timeout path waits too. Shell keeps its web-seed fast path (the host's own record). | `PTR-9: on a hub or a door the gate holds ...` |
| PTR-11 | partial | The previous record and the seq floor come from the saved raw text and its owner signature, never from stored fields (`signedSavedRecord`, app.js:602; app.js:440). Not fixed: the device key stays usable by same-origin code in shell mode (it lives in the origin's IndexedDB), so signed pins and refusals only catch accidental edits; moving it out of reach is an architecture change. The documents must say so (Requests 4). | `PTR-11: the previous record and the seq floor come from the saved raw text ...` |
| PHISH-7 | partial | Loader side fixed: `retryRotation` (app.js:3538) writes the rotation at sign-in and again on every ledger change (`node.subscribe`) until `state.rotations` holds it, with a banner while it waits (app.js:3511). Identity-origin side (the notice is handed out once per origin, src/idp/idp.js:856-858) is not this brief's file: Requests 3. | `PHISH-7: a rotation that cannot be written on a cold node ...` |
| GATE-1 | fixed | `resolvePointer` returns `refusedOwners`; the key-refused banner has "Review the key change" (`reviewKeyChange`, app.js:1804), which clears only those refusals (`forgetKeyRefusals`, app.js:260) and reloads, so the card asks again; the refusal otherwise stays. | `GATE-1: a refused key change is returned and can be revisited ...` |
| SYB-11 | fixed (eviction and caps); persistence open | One bounded queue per kind (`QUEUE_CAPS`, src/loader/mod.js:51): a full queue refuses the new item, nothing is evicted (mod.js:418); one open join per sender, one open report per (reporter, target), at most 3 open reports, joins and pins per sender; `syncListings` puts at most 100 pending listings of one author in the queue (mod.js:475). The report queue is still in memory only (not persisted in the sealed store): Requests 8. | `SYB-11: a report survives 500 joins and 600 pending listings ...` |
| PTR-12 (minor) | partial | Unicode format characters (Cf) in `why=` become spaces (src/common/withdrawal.js:68); the contact button names its host or mail address (`contactLabel`, app.js:1884); resolver failover on empty answers (PTR-4). The quote frame "written by the publisher (unverified)" is strings.js text: Requests 5. | `withdrawalNotice ...` (common-withdrawal), `PTR-12: the withdrawal contact button ...`, `resolveTxt (PTR-4, PTR-12) ...` |
| PTR-13 (minor) | fixed | The page's `mw-doh` override is ignored while the scope has no pin and no saved signed record (app.js:443); DoH bodies over 64 KiB are refused, by Content-Length and while streaming (`MAX_DOH_BODY_BYTES`, `readCapped`, doh.js:28, 295). | `PTR-13: the page's mw-doh override ...`, `resolveTxt (PTR-13) ...` |
| PTR-14 (minor) | fixed | `notAnsweringModel` (app.js:4766): "The owner lists" names only owner, guest and ledger doors; last-good and hints are named apart, and opening a hint asks first, naming its host. "Copy link with doors" no longer passes the link's hints on (app.js:4686). | `PTR-14: "The owner lists" names only owner doors ...` |
| SYB-18 (minor) | rejected: minor, deferred | The code is `src/loader/api.js:579` (`cfgFromNode`), outside this brief's files; the exact edit is Requests 9. | (requested: api test) |
| CONF-1 (minor) | fixed (loader record); docs record is a request | The "No always-on copy" note uses the owner-standing pin key (`pinKeyOf`, app.js:4299). The other CONF-1 record (`<mw-chat-panel tracker stun>`) is in `src/widget/chat-panel.js:13` and `tools/publish.mjs:728`: Requests 10 (INTERFACES.md:1145 already says the attributes are not read). | `CONF-1: the upload card says "No always-on copy" ...` |

## Behaviour changes to know

- A hub address (hub-sub) refuses a record whose `lo=` is not proven. A site rotated twice (V to V2 to V3, `rot=` of V3
  signed by V2) is refused on a device that never saw V2's record; the owner keeps it working on cold devices by
  signing `rot=` with the genesis key (the key `lo=` names), which is what the identity origin checks too
  (src/idp/idp.js:175).
- The ledger floor is device state in the origin's preferences: like pins (PTR-11), same-origin code can delete or
  rewrite it. It stops replays by links, by resolvers and by stale saved copies, not by hostile code on the origin.
- `filterWebseeds({ signed: true })` now filters hosts (8 ws=, 4 xs=); it changes nothing in the loader until
  Requests 2 lands.

## Requests (for the integrator and the owners of these files)

1. **PTR-6, drop-in** (`src/dropin/stamp.js:146`, `src/dropin/engine.js:582`, `:621`, `:642`): `evaluateStamp` gains
   `previousRecord` and passes it to `verifyPointer(record, host, { now, pinnedOwner, cachedSeq, previousRecord })`
   (both calls, :146 and :150); `evaluate()` reads the cached pointer's raw text, parses and verifies it (as
   `signedSavedRecord` in src/loader/app.js:602) and passes that record; after an accept, call
   `rotationDecision({ prev, next, firstVisit: !pin, rotOk })` and hold on 'delay'; refuse to mount when
   `loaderFloorOk(record.ml)` is false; apply `withdrawalState(record).binding` before purging; store a refusal with
   `signRefusal` and read it with `verifyRefusal` (7-day expiry) instead of `true` (:621, :642). Tests:
   dropin-stamp: pinned K1, cached record with nx=, thief rot record -> rejected 'nx-mismatch'; dropin-engine: a
   refusal older than 7 days prompts again; a withdrawal older than 30 days does not purge; ml above the engine
   version does not mount.
2. **PTR-8, torrent** (`src/loader/torrent.js:183`): delete `if (record && record.signed) return { ws, xs }` and pass
   `signed: !!(record && record.signed)` to `filterWebseeds` at :186. In `announceListFor` (:172-176) keep only
   `wss:` tr= URLs whose host passes `isPublicWebHost` (src/common/magnet.js) or is the page's own host, at most 8.
   Probe ws= with a concurrency of 2 (:2734, :2984-2989). Test: a signed record with 24 hostile ws=/xs= (the PTR-8
   unit list) yields 0 usable; 5,000 tr= give at most 8.
3. **PHISH-7, identity origin** (`src/idp/idp.js:856-858`): do not push the origin into `rotated.delivered` when the
   notice is handed out; hand it out at every sign-in at that origin until a request carries
   `rotated: [{ from, next }]` (the loader can send it once `state.rotations` holds the rotation:
   `retryRotation`'s stop, src/loader/app.js:3538). Test (idp-review-v03): two sign-ins after `replaceAllKeys` both
   carry the notice until the acknowledgement arrives.
4. **PTR-11, documents** (docs/THREAT-MODEL.md:162 and :290, docs/SECURITY-MODEL.md:77,
   docs/research/v03/redteam-poisoned-pointers-dns-and-hosts.md:93): say that code on the same origin can use the
   device key, so signed pins and refusals catch accidental edits only; row 290 becomes "partly mitigated: the floor
   and nx= come from the signed saved record; the device key is reachable by same-origin code (shell mode)".
5. **Strings** (`src/loader/strings.js`, owner: the other loader fixer): add `keyChangedReview: 'Review the key
   change'` (GATE-1), `rotationPending: 'Your key replacement is not on this site yet. It is written as soon as this
   site's ledger has caught up.'` (PHISH-7), `lineageUnproven: ({ ownerFp, loFp }) => 'This link names the site
   ledger of publisher key ' + loFp + ' but is signed by another key, ' + ownerFp + ', and nothing shows that the
   first key handed the site over. It is not opened as that site here.'` (PTR-1), door texts
   `'door.notAnsweringAlso': 'Not from the owner: {hosts}.'` and `'door.confirmHint': 'Open {host}? This address
   came with the link, not from the site's owner.'` (PTR-14, en and fr), and in `withdrawnDetail` (:175) replace
   `'Reason: ' + why + '.\n'` with `'The publisher wrote (not checked): "' + why + '"\n'` (PTR-12). app.js already
   uses these keys when present and falls back to the same English text.
6. **PTR-4, documents** (docs/ROADMAP.md:65, docs/THREAT-MODEL.md:224 and :285): the cover is now "a per-ledger seq
   floor on each device, resolver failover on empty or older answers"; delete "two-source disagreement" (no code
   shows one). `minSeq` stays proposed.
7. **PTR-5, publish** (`tools/publish.mjs:1521`): `--prev-key` re-signs `rot=` on every publish that keeps the
   ledger, so first-time visitors of a rotated site wait 24 h after each publish (rotationDecision reads the change
   time from seq). Either note it in the publish output and docs/DEPLOY.md, or (format decision for the owner) give
   the rotation its own signed time. Also warn when `--prev-key` is not the genesis key (lo=): cold devices then
   cannot prove the lineage (hub addresses refuse it).
8. **SYB-11, persistence** (`src/loader/mod.js`): keep the report queue in the sealed store so a reload does not drop
   open reports (ROADMAP entry if not built now).
9. **SYB-18** (`src/loader/api.js:579-595`, `cfgFromNode`): read `chatBits`, `requests`, `chat`, `files`, `media`,
   `calls`, `age`, `turn` and `blockTiers` only from a `_mw.cfg` entry whose hash is in `state.ownerWritten` (as
   `ownerCfgPin`, api.js:566-577 does); for a moderator-written entry, take a field only when it tightens (higher
   chatBits, 'off'). Test: owner writes chatBits 24; a moderator then writes chatBits 10 and requests 'on'; readers
   keep 24 and requests off.
10. **CONF-1, chat panel** (`src/widget/chat-panel.js:13`, `tools/publish.mjs:728`): drop `tracker=` and `stun=` from
    the usage comment and the printed tag (`'<mw-chat-panel></mw-chat-panel>'`); docs/deviations/ui.md item 8 gets an
    F-6 follow-up line.

## Runs

2026-10-24, 04:05 to about 05:30 ET (Toronto time).

- Unit, this area: `node --test test/unit/review-round-loader-pointer.test.mjs` 17 of 17; `common-*`, `harden-loader-*`,
  `loader-*` 412 of 412 after the expectation updates above.
- `npm test`: the lint floor clean (147 files); unit 2,214 tests, 2,161 pass, 42 fail, none in this area's files. The
  failures are in files other lanes were editing at the same time: `chat-lane-service` (19), `calls-service` (14),
  `calls-mesh` (2), `strings-c2` (2), `call-ui`, `chat-lane-holder`, `integration-v03-reconcile` (chat keys and
  messages), `docs-links` (a THREAT-MODEL link to a missing `review-round-tools.md`), `repo-layout` (an untracked
  `SECURITY-KEY.asc` at the top level), `tools-install-scripts`. None of them imports a file this fixer changed.
- E2E (`node test/e2e/run.mjs --only ...`, local-only Chromium, every request on 127.0.0.1): `1,2,3,4,5,6,7,8,9,10,12,13,14,
  DOOR-DOWN,DOOR-GUEST,DOOR-HASH,FMT-WITHDRAW,E-HD-1,PEER-WS,PEER-CONSENT` 20 of 20 passed (127.1 s). `E-SO-1,E-SO-2,
  E-SO-3,E-SO-11`: a first run failed all four on timeouts (the identity window and the consent notice not reached, under
  load); run again, E-SO-3 passed alone (148.7 s), E-SO-1 and E-SO-11 passed (112.8 s), and E-SO-1 with E-SO-2 passed
  (80.5 s) after E-SO-2 had once timed out waiting for a post over the follow lane.
