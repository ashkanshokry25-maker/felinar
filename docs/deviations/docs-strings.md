# docs-strings lane (phase C2): notes, deviations and requests

Lane: docs-strings. Source of truth: `docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md` ("SZ"), with S1 D8 and F1 to F4 and S2 Rc6, and the
briefs of the other C2 lanes (`.orchestration/args/c2/*.md`) for the module contracts. Date: 2026-10-20 (ET). Written contract-first: the code lanes
build from the same SZ sections, and the C2 integrator sets the status marks.

Files written: `src/loader/strings.js`, `test/unit/strings-c2.test.mjs` (new), `docs/ARCHITECTURE.md`, `docs/INTERFACES.md`,
`docs/COMPATIBILITY.md`, `docs/PRIVACY.md`, `docs/DEMO-RESULTS.md`, `docs/ROADMAP.md`, `docs/WHY.md`, `docs/SECURITY-MODEL.md`,
`docs/THREAT-MODEL.md`, `docs/README.md` and this file. `test/unit/ui-v03-strings.test.mjs` was read and left alone: it needs nothing for the new tables,
and `strings-c2.test.mjs` covers them. Nothing else was touched.

## What was written

- **strings.js.** `SEED_TEXT` and `CALL_TEXT` (English and French, the same placeholders), `seedText()` and `callText()` (English fallback, own keys only),
  six sentences in `ERROR_TEXT` (E_BUSY, E_DECLINED, E_NO_ANSWER, E_MEDIA_DENIED, E_NO_DEVICE, E_CALL_FAILED, in both languages, needing no parameter) and
  two lists, `C2_ERROR_CODES` and `C2_REUSED_CODES`. Every English text of the SZ 3.1.5 and 3.5 tables is verbatim (the test pins them). The seed-policy lane
  asked for text for the dock refusal and stop reasons: `dock.stop` (the button) and `dock.refused.<unsupported|hidden|declare|unplugged|battery|denied>` and
  `dock.stopped.<hidden|unplugged|battery|cap|user|released>`, so wire-ui shows `seedText('dock.refused.' + reason)` and `seedText('dock.stopped.' + reason)`.
- **ARCHITECTURE.** The C2 note in the section 15 preamble; section 4 item 3 (the nip.io and sslip.io DNS-over-HTTPS skip); `8.1 Smart seeding (v0.3 C2,
  proposed)` (8.1.0 to 8.1.10: what the platforms forbid, tiers, lanes, the budgets table, windows, evidence and labels, hand-off with `mw_pin1` and the
  heartbeat, partial seeding, when the tab is gone, contribution rules, gate rows and what the owner rejected); section 10 (`ship`, `name-check`,
  `publish --calls`, `ledger-admin cfg --calls`, `dev-server --tracker-proxy`, the pin flags); the SZ-1 to SZ-6 table at the end of 15.11; the C2
  signing prefixes at the end of 15.12; and `15.14 Calls (v0.3 C2, proposed)`.
- **INTERFACES.** A last part, `v0.3 C2 (proposed)`, with the module contracts of every C2 lane (seed-policy, seed-engine, pin-node, calls, wire-ui, the
  zero-setup tools), the strings contract and the ownership of the C2 build.
- **PRIVACY, SECURITY-MODEL, THREAT-MODEL, COMPATIBILITY, DEMO-RESULTS, ROADMAP, WHY, docs/README.** Each gains a section that opens with
  `> **Status: v0.3 C2 (proposed), not yet built.**` (see below for how to flip it): calls (every participant learns your IP address once you accept; a
  relay operator sees both addresses, sizes and times; roster keys), re-sharing ("Others can see which files you share"), the pin heartbeat (hashed
  ids), dock mode and the recipients rows; trust, protection, limit and budget rows; 22 threat rows with ids CALL 1 to 10, SEED 1 to 4, PIN 1 to 4 and
  ZS 1 to 4, a C2 observer table and honest limits 18 to 25; the platform, capability, "reliable" and rung tables with their sources; the gate rows
  G-PS-1 to G-PS-14, G-ZS1 to G-ZS4 and G-CL-1 to G-CL-9, all `not yet run`, with what to record; the C2 items, the SZ section 4 priorities, the v0.4 adoption
  list and "Not planned (owner decision 2026-10-20: browser only)"; the qualified line "Readers who agree help carry this site while their page is open"
  and calls, each with its price, and the plain words of SZ 3.4.

## Tests run

- `node --test test/unit/strings-c2.test.mjs`: 14 of 14 pass (keys in both languages, placeholders, the verbatim English of SZ, French differs, filling,
  lookups, the dock reasons, IP-address clauses, no durability promise, no banned word, dash or curly quote, "online" only for holders, the six errors,
  ARCHITECTURE and INTERFACES quote or name every string, PRIVACY quotes the card sentences, DEMO-RESULTS lists all 27 C2 rows and lets a row carry a
  result only with a date). The two spec checks match headings without the word "proposed", so flipping a status mark does not break them.
- The 11 other unit files that import `strings.js` or read INTERFACES (`ui-v03-strings`, `ui-v03-cards`, `idp-cards`, `widget-chat-panel`, `dropin-panel`,
  `dropin-engine`, `loader-app-consent`, `loader-app-connectivity`, `loader-app-review1`, `v021-integration`, `sdk-v03-tables`) with mine: 193 of 193 pass. (One
  run showed four files failing to load for a moment: another lane's `torrent.js` had a syntax error mid-edit; the next run was clean.)
- Ad hoc, not committed: every added line scanned for the banned words, em and en dashes, curly quotes and non-ASCII (none, but one `§` in the section 4 note, in
  step with the sections around it); every markdown table of the ten documents has the header's column count (0 bad rows); a scratch copy of
  `docs-links.test.mjs` with `docs/research/v03` added to its search list: wording, dash and quote rules pass, and the only references left are files other C2
  lanes create (`deploy/one-box/README.md`, `docs/deviations/pin-node.md`).
- No browser was launched, no e2e suite was run, `dist/` was not rebuilt, nothing was pushed.

## Deviations from the brief

1. **Calls is 15.14, not 15.12.** The brief says `15.12 Calls`. 15.12 (signing prefixes) and 15.13 (final integration) already exist and are cited by
   INTEGRATION-STATUS, INTERFACES, CHANGELOG, DEVIATIONS and `deviations/integration-v03.md`, so renumbering would break those citations and the new section
   is `15.14`. The SZ-1 to SZ-6 list is where the brief put it, at the end of 15.11.
2. **Extra string keys.** `call.kind.audio` and `call.kind.video` fill `{kind}` of `call.incoming`, so French does not show an English word. The dock texts above
   say "keep the screen on" and never "dock mode", because no card introduces that name to the person. `call.incoming`
   holds the sentence only; its three buttons are the keys `call.accept.audio`, `call.accept.video` and `call.decline` the brief lists. The six error texts take no
   `{name}` (the call texts `call.declined` and `call.busy` carry it), so they cannot print a placeholder when an error has no name.
3. **Section numbers of the SZ design.** Documents cite it as `research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md` and call it "SZ", as the brief says.
4. **A claim added that SZ does not make.** THREAT-MODEL and SECURITY-MODEL say that the operators of nip.io and sslip.io are part of a no-domain site's trust root
   (they can point the name elsewhere and obtain a certificate that validates over that DNS), labelled as inference from how the validation works. SZ 3.4 names the
   volunteers and the block list but not this; it follows from S2 F2, F3 and F7 and from the fact that a name's DNS operator controls where it points. Say if it
   should be softened.

## Requests to other lanes and the C2 integrator

- **`src/chain/state.js` (integrator).** `cfgOk` returns false for a key it does not list, and `calls` is not listed (checked: `schemaOk('_mw.cfg', { chat: 'members',
  calls: 'contacts' }, 'key')` is `false` today). Add `calls: ['off', 'contacts']` to the `CFG` table. Until then `ledger-admin cfg --calls contacts` writes an item that
  every peer skips (state.js lines 1109 and 1114), and a peer on a build without the rule skips the whole `_mw.cfg` item, so chat, files and media read as off for it.
  SZ's open question "does R 2.10.2's `_mw.cfg` schema accept `calls`?" is answered no. Add a unit test next to the existing `cfgOk` tests, and a vector if the
  freeze group keeps one for `_mw.cfg`.
- **`docs-links.test.mjs` (integrator).** Add `docs/research/v03` to `SEARCH`. Until then ten documents that cite `SEEDING-AND-ZERO-SETUP-DESIGN.md` by name fail
  the "every named .md exists" test (the file exists; the bare name does not resolve against the old list). `docs/README.md` also links
  `../deploy/one-box/README.md`, which the zero-setup lane creates.
- **`sdk-v03-tables.test.mjs` (integrator / wire-ui).** Line 322 limits `HOST_ONLY_METHODS` to `chat|files|media|report`, and the test pins the last 29 of
  `ERROR_CODES` to the review's list. Adding `calls.*` to `HOST_ONLY_METHODS` and the six C2 codes to `ERROR_CODES` (INTERFACES, C2) needs both updated. The
  six codes already have sentences: import `C2_ERROR_CODES` from `strings.js` instead of retyping them.
- **seed-policy asked docs-strings** to mirror its signatures into INTERFACES (done, including `budget.call`, `local.on`, `prefs.seedAsked`, `SEED_ROWS`,
  `MONTH_LANES`, `laneRates`, `networkOfEnv`, `monthKeyOf`, `flush`, `ready`, `selectedPair`, `addressKind` and the dock reasons) and to give the dock reasons text
  (done). Its readings of the budgets table are in ARCHITECTURE 8.1.3 as "C2 build"; the integrator folds or corrects them with the owner.
- **wire-ui.** Use `seedText()` and `callText()`; `avail.heldBy` and `meter.visit` have no singular ("at least 1 others", "1 visitors"), so show `avail.heldBy`
  only for a count of two or more, or ask this file for a singular key. The French percent sign takes a space (`{pct} %`), as French typography does.
- **zero-setup.** `publish --calls` is a gate like `--chat` (`featureProblems`), not a writer: the setting is written by `ledger-admin cfg --calls`. The
  ARCHITECTURE section 10 text says so. Z8 and Z1 to Z3 are quoted in THREAT-MODEL by their meaning, not verbatim; the tool strings stay yours.
- **The doors lane** (it depends on this one) appends to PRIVACY, SECURITY-MODEL, DEMO-RESULTS and `docs/README.md`. The C2 sections of those files are marked
  `v0.3 C2 (proposed)`; add door rows under their own headings, so that the flip below stays simple.

## How to flip the marks

Every C2 section opens with `> **Status: v0.3 C2 (proposed), not yet built.**` and the headings of ARCHITECTURE 8.1, ARCHITECTURE 15.14 and the INTERFACES part say
`(v0.3 C2, proposed)`. To find them all:

    grep -rn "v0.3 C2 (proposed)\|v0.3 C2, proposed" README.md CHANGELOG.md docs/*.md

When a lane lands and is green, change the phrase in that section and nowhere else, and fold the lane's `docs/deviations/<lane>.md` exports into INTERFACES. The
"Planned test" column of SECURITY-MODEL and the "By" column of THREAT-MODEL name the tests from the lane briefs (`calls-signal`, `calls-service`, `calls-ice`,
`calls-browser`, `pin-frames`, `pin-heartbeat`, `tools-c2-pin`, `seed-budget`, `lint-contrib`, `tools-ship`, `name-check`, `sdk-c2-calls`, E-CL-1 to 3, E-PS-1 to 4,
E-ZS-1); rename them there if a lane names its tests differently.

## What was not checked

- The French strings were written for this lane and not reviewed by a French speaker. They follow the vocabulary of the file (registre, essaim, serveur de
  connexion, hébergeur, écran d'accueil).
- No number in these documents is a measurement of this lane. Each carries the label of its source (documented with an id, measured in the c2-calls-lab of
  2026-10-20, arithmetic, chosen, or a planning range), copied from SZ, S1 and S2. The platform behaviours in COMPATIBILITY are documents, reports and a
  loopback lab: no phone has been tested.
- The module contracts in INTERFACES are the briefs' signatures. The seed-policy part mirrors that lane's own note (`deviations/seed-policy.md`, read at 16:38 ET); the
  pin and calls parts were compared once with the exports of `src/pin/*` and `src/calls/limits.js` as they stood at 16:30 ET (the constants, the frame and
  heartbeat functions and the signal exports agree; `verifyHello` and `verifyReceipt` are async). The pin-node, calls, zero-setup, seed-engine and wire-ui notes had
  not landed (or were only a progress log), so those parts may drift: where a lane's own note differs, that note wins until the integrator folds it in.
