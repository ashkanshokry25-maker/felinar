# onboarding-crud: notes and deviations (documentation wave, 2026-10-19)

Agent: onboarding-crud. Owned files: `docs/QUICKSTART.md` (extended in place), `docs/ONBOARDING.md`,
`docs/CRUD.md`, `docs/SDK.md`, `docs/FAQ.md` (new), and this file. Nothing else was edited.

## How the claims were checked

Every command and flag in the five documents was run or read from `--help` on 2026-10-19 between 20:50 and
21:30 ET (Node 24.22, macOS), with keys and outputs in the session scratchpad, never in the repository:

- `--help` of every tool in `tools/` and of `bin/magnet-web.mjs`; `npx --offline magnet-web --version` resolves
  the local CLI without the network.
- `keygen`, `publish` in shell mode (the example guestbook, `--ws --tr public --cs --ct --shell`) and in drop-in
  mode (a four-page site, `--dropin --inject-script`, and the drop-in example): the output snippets in
  QUICKSTART and CRUD are from these runs, abridged where marked with `...`, with the scratch paths replaced
  by `dist-publish/`.
- Republishing into the same `--out` with conflicting policy flags (the error quoted in CRUD) and without
  them (`reused`).
- `ledger-admin policy`, `allow`, `ban`, `tombstone` and `show` on a real genesis and on a ledger export, then
  `snapshot.mjs` (gzip and `--plain`); the tombstoned value is absent from the snapshot file.
- The demo with `--seeder none` on other ports, and `check-site` against it (output identical in shape to the
  QUICKSTART snippet). A manual local stack (publish with `--moderator`, `tracker.mjs`, `dev-server.mjs
  --pointer @file --dev`) passes `check-site`: the commands in CRUD "Testing locally" are that run with the
  documented ports.
- Ledger semantics probed with scratch scripts against `src/chain/node.js` and `tools/ledger-admin.mjs`: a
  tombstone on a key's current entry brings the previous value back; `del` hides the key; any writer can
  overwrite another author's key; `_` names give `E_NOT_MODERATOR`; a foreign tombstone gives
  `E_NOT_MODERATOR`; concurrent writes converge to one value and one root, a causal write wins; an owner
  policy tightening keeps the entries the owner had seen and drops the concurrent one; the 31st write in 10
  minutes from one identity gives `E_RATE`.
- `node test/e2e/run.mjs --only FMT-SDK` (PASS, 1.7 s) and `--only 1,2,3,4` (PASS, 6.1 s; scenario 2 measured
  469 ms from Post to the entry on the other visitor, the figure CRUD quotes as a loopback measurement).
- `npm test` after writing: 921 tests, 920 pass; the one failure is `docs-links` for files other agents own
  (below), none from these five documents. The wording test passes for all of them.

## Decisions and deviations

1. **QUICKSTART kept its structure** (two tracks, the demo, deploy, DNS, check, what visitors see, where files
   land, keep it running). Changes: a "short version" with the six commands; the publish outputs replaced with
   current ones (the `ledger rv`, `created` and size-report lines are new since the first draft) and a key
   whose fingerprint matches across A1, A2 and B3; an explanation of each output line; the drop-in "First time
   on this device" line (it is inside the drop-in card, not absent); the "syncing with N peers" ledger line; the
   DNS negative-caching sentence now cites research 05 F12 (5 to 30 minutes measured) instead of an unsourced
   figure; the CSP step names the `script-src` case `csp.txt` prints.
2. **No `*-VERIFY.md` file names in the documents.** `test/unit/docs-links.test.mjs` reads the `VERIFY.md` at the
   end of `w2b-04-observability-no-backend-VERIFY.md` as a document name of its own and fails. The posting-fee
   figures are cited from `research/_w1-part-a.md` (section 4.2, row 10, which quotes that measurement) and
   the phone estimate from `research/06-browser-chain-vs-crdt.md` F37 (arithmetic on published rates, labelled
   as an order of magnitude). The 95th-percentile figures, which only the VERIFY file states, are left out.
3. **"blockchain" and "serverless" appear only inside double quotes** (two FAQ headings, one ONBOARDING list
   of words not to use), which is how the wording test and README treat a question that refutes them. No
   link anchors contain those words. The EDPB guidance is cited by number and date without its title.
4. **Modelling advice that follows from the code, not from the spec text:** keys carry no author for readers
   (`db.get` and the snapshot return values only), so per-author data is modelled as lists with "latest item
   per author"; the `h` of a key's entry is only returned by `set` at write time; lists in snapshots are oldest
   first while `db.list` defaults to newest first. CRUD and SDK say so.
5. **Moderation on drop-in sites** is documented as offline only (`ledger-admin` plus a snapshot): the drop-in
   panel has no moderator-key import (dropin deviation, still open), so `_` names cannot be written from a
   browser on a drop-in site in 0.2.1.

## Found in files I do not own (for their owners)

- `docs/RUNBOOK.md` section 10, step 6: "calls `mw.consent.accept()`". That method was removed in v0.2.1 (A4);
  the site calls `mw.consent.request()` and the visitor decides in the loader's card.
- `docs/RUNBOOK.md` section 6: "the ledger id includes the owner key, so a rotation starts a new ledger". Since
  code review round 1 (F09) `publish --prev-key` keeps the ledger (`lo=`).
- `docs/RUNBOOK.md` section 3: test counts from integration-2 (675 unit, 28 browser, 14 scenarios); current
  numbers are in `docs/INTEGRATION-STATUS.md`.
- `tools/snapshot.mjs` prints "visitors need DecompressionStream, Safari 16.4 or later: use --plain for older
  iOS" for gzip output, but since F20 every loader inflates gzip without `DecompressionStream`
  (`src/common/inflate.js`).
- `tools/ledger-admin.mjs` reads a gzip ledger file and writes it back as plain JSON under the same name (a
  `.json.gz` file then holds plain JSON).
- `src/dropin/mw.js` header comment still lists `engine` in `window.__mwDropin`; since F08 it is a frozen handle
  without it.
- `CONTRIBUTING.md` line 279 (`<same name>-VERIFY.md`) trips the same `docs-links` false positive as item 2.
- `docs/CRITIQUE.md` does not exist yet and README, `docs/README.md` and `docs/WHY.md` link to it.

## Open items worth a ROADMAP row

- A moderator-key import in the drop-in panel (so drop-in sites can moderate and write `_` names in a browser).
- A way to lift a ban (there is no unban operation in v1).
- An SDK read that returns a key's current entry with its `author` and `h` (today only the value).
