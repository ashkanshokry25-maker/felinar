# docs lane (D1 + P1 docs): notes, deviations and requests

Lane: docs. Source of truth: `docs/review/V03-DESIGN-REVIEW.md` ("R"), the "v0.3 (proposed)" sections of
`docs/ARCHITECTURE.md` (15) and `docs/INTERFACES.md`, and the notes of the lanes that had landed (freeze, harden-loader,
idcore, chat, media, ui). Date: 2026-10-20.

Files written: `docs/PRIVACY.md`, `docs/SECURITY-MODEL.md`, `docs/THREAT-MODEL.md` (new), `docs/OPERATIONS.md`,
`docs/WHY.md`, `docs/FAQ.md`, `docs/DEPLOY.md`, `docs/COMPATIBILITY.md`, `docs/ROADMAP.md`, `docs/DEMO-RESULTS.md`,
`docs/PUBLISH-CHECKLIST.md`, `docs/README.md`, `docs/recipes/README.md`, `docs/recipes/signin-server-node.md` (new),
`docs/recipes/signin-widget.md` (new), `docs/recipes/hub-pin.md` (new), `SECURITY.md`, `CHANGELOG.md` and this file.
Nothing else was touched. No spec file (ARCHITECTURE, INTERFACES, SDK, `docs/specs/`, INTEGRATION-STATUS, DEVIATIONS)
was edited.

## Tests run

- `node --test test/unit/docs-links.test.mjs`: 5 of 5 pass after the last edit (existence of every named `.md`, the
  `DEPLOY.md` "Owner duties" sentence, the wording rules, no dashes or curly quotes in the six named files, every
  relative link).
- Ad hoc checks, not committed: every table row has the header's column count (0 bad rows); every anchor link in the
  edited files resolves to a heading (86 checked, 0 bad); the edited files hold no non-ASCII character; the owner's
  `git grep` patterns of PUBLISH-CHECKLIST section 5 find only the existing quotations.
- The Node server of `docs/recipes/signin-server-node.md` was run against the real `packages/verify/verify.js` on Node 24.22
  with the vector `si-001-pairwise` and the vector's clock: the challenge route answers, a valid proof in the widget's
  `{ proof }` shape is accepted and starts a session, the same proof is refused as a replay (401, `replay`), a bad body
  gives 400 and an oversized body 413. Node 22, a shared store and a real proof from an identity origin were not run.
- No browser was launched, no e2e suite was run, `dist/` was not rebuilt, nothing was pushed.

## The status line, and how to flip it

Every new v0.3 section opens with the line `> **Status: v0.3 (proposed), not yet built.**`; in the recipes it sits in the
Status row of the table. Headings carry no "(proposed)" on purpose, so the phrase is the only place that says it. To flip
a built and reviewed part, change that phrase in that section and nowhere else. To find them all:

    grep -rn "v0.3 (proposed)" README.md CHANGELOG.md SECURITY.md docs/*.md docs/recipes/*.md

Prose that says "(v0.3 (proposed) adds ...)" inside older sections, the "v0.3 (proposed)" column of the moderation
table in OPERATIONS, the roadmap annotations and the pointers in FAQ answers are the other hits; read each when a part flips.
The changelog block `## [Unreleased: v0.3 (proposed)]` keeps its name, as the brief asks.

Final integration (2026-10-20): the code landed, so the status line now reads `> **Status: v0.3, built, not yet
reviewed.**` in all sixteen places (SECURITY.md's program: "partly built"), the prose hits above were read one by one
and say "v0.3" where the part is built, and the changelog block is `## [Unreleased] - 0.3.0`
([integration-v03.md](integration-v03.md), "Final integration").

## Deviations from the brief or from R (each decided so that no document says more than the code or R supports)

1. **The R 1.1 summary was tightened.** R 1.1 ends "anyone who learns your 12 words can read them". R 2.2.2 and 2.16.2
   say the keys for old messages, records and own media are random and live in the vault, so the words alone restore the
   public identities and not those. PRIVACY.md and the FAQ use "anyone who learns your 12 words can act as you on every
   site. They cannot open what was kept under your older keys unless they also get your backup file or an unlocked
   device." Request to the review owner: update R 1.1.
2. **SECURITY.md had no reporting address placeholder** (it names GitHub private vulnerability reporting only), so none
   was reused and no address was invented. It now carries the advisory URL with the `OWNER` placeholder that the publish
   checklist replaces, says plainly that there is no mailbox yet, and PUBLISH-CHECKLIST 16.8 makes the mailbox and key an
   owner step. The safe-harbour paragraph is a draft for counsel (16.3).
3. **Gate rows.** G-ID-3 and G-ID-3b are two rows (R lists them together). The 11 scale rows and their text come from the
   scale judge's section 4 (R 4.3 only names the range); G-SC-1 is "250 follows" as R says ("renamed to the 250 cap"). R 2.8.8
   names a row "G-FI-5" that R 4.3 does not list; it is read as G-MD-5 (the chunk store). 40 rows in all, every one "not yet run".
4. **COMPATIBILITY.** R's unlabelled cells ("yes", "persistent") are shown as "expected", because only "lab" cells are
   results. Every Firefox cell is "not run". The floor is three columns; a version is named only where R names it (MDN BCD
   figures are marked as not re-fetched). The media lane exercised image stripping in Chromium only, and the matrix says so.
5. **Children's defaults.** R MF-60 and 2.5.5 say "children defaults apply" with no age method but list no more than
   message requests off, separate opt-ins for files and media, and "stay signed in" off on shared computers.
   PRIVACY.md lists exactly those and says the integrator and counsel confirm the full list.
6. **Identity-origin incident runbook.** R 2.19 says to publish the bad build hash, ship a fixed build and tell people to
   use "Replace my keys on all sites". A rotation from the same root cannot outrun someone who holds the root (the
   attacker can sign every rotation and the recovery rotation too). OPERATIONS says so and names a new root as the safe
   course for people who unlocked on a bad build. Request to the review owner: confirm or amend the runbook.
7. **R 2.17.2** calls "Start a new identity on this site" "a `rotate` with no link", while R 2.5.3 gives `rotate` the fields
   `from` and `next` (a public link) and says `next` inherits bans. Docs say only that the person can start a new identity
   with one tap; request to the review owner to settle what is public.
8. **`_deny/` key encoding.** MF-52 writes the hash in hex; R 2.8.7, 2.10.2 and the freeze lane use base64url (43
   characters). Docs use base64url.
9. **Argon2id time.** R says about 0.1 s from a WebAssembly build on an M3; the idcore lane measured 1.3 to 2.5 s in plain
   JavaScript on an M3 in Node, Chromium and WebKit. Docs use the measured figure and name the source.
10. **"Purge mode"** (R 2.19, MF-30) is named in R but not specified anywhere. The site-host runbook in OPERATIONS says what
    R says (a worker mode separate from the kill switch that deletes the site origin's working keys on the owner's
    explicit request) and that its file and contract are not specified.
11. **PUBLISH-CHECKLIST** sections 1 to 15 assume a tree in the 0.2.1 state. The tree now holds v0.3 work, so section 16
    opens with a paragraph that asks the owner and the integrator to decide which release carries what. The changelog
    block sits above `## [Unreleased] - 0.2.1`, so the perl command of section 8 and `release.yml` leave it alone.
12. **Statements of law** in PRIVACY.md and OPERATIONS.md are the research's readings (R6, PRIV M6), flagged "for counsel"
    and "not legal advice"; none was checked against a primary source (R6 says the same of itself). Canada's mandatory
    reporting Act is named as R names it ("counsel to confirm application").

## Findings across lanes that the integrator has to settle (found while writing; not mine to fix)

- **Widget body versus library input (ui and idcore).** `src/widget/signin.js` POSTs `{ "proof": { ... } }`. The spec
  (`docs/specs/mw-signin-v1.md`, "the page posts the proof text"), the verifier README and the fixture server
  (`test/fixtures/signin-server/server.mjs`) pass the whole body to `verify()` as the proof text, which the strict parser
  rejects as `parse` because of the wrapper. The recipe unwraps `{ proof }` and passes the object, which skips the
  duplicate-key refusal that only works on text. Either the widget should post the bare proof text or the server contract
  should name the wrapper.
- **`_mw.cfg` schema versus other lanes (freeze, chat, media, social example).** `cfgOk` in `src/chain/state.js` hides a
  `_mw.cfg` value that holds any key it does not list. It accepts `requests: 'off' | 'on'`, so R 2.17.2's `'introduced'`
  (which the chat lane treats as `'on'`) would hide the whole value. The media lane reads `_mw.cfg.blockTiers` and R 3.5
  uses `_mw.cfg.wall`; neither is accepted. OPERATIONS tells owners not to write them until the lanes agree.
- **COLLECTED cannot be verified by a holder** (chat O-1) is in THREAT-MODEL as a build finding on PEER B3 and B4.
- **Signing prefixes** added by lanes and not in R 2.10.3: `mw-vault-v2`, `mw-identity-v3`, `mw-nonce-v1`, `mw-selftest-v1`
  (idcore), `mw-file-v1` (media), `mw-grp-admin-v1`, `mw-grp-commit-v1`, `mw-pres-v1` (chat). The documents do not list
  prefixes; the review owner should extend R 2.10.3.
- **Research location.** Documents link to files under `docs/research/v03/` (R6, the judges). If the integrator moves that
  folder under `docs/research/labs/` (as `repo-layout.test.mjs` expects), the links in PRIVACY.md and elsewhere need the new path;
  `docs-links.test.mjs` will say which.

## Requests to other lanes

- **tools lane (T1).** The documents show these forms, taken from R and not run: `ledger-admin cfg --chat|--files|--media
  members`, `--records sealed --max-items n`, `--requests on --chat-bits n`, `--age none`; `publish --tracker wss://...
  --stun stun:...`, `--turn ...`, `--signin-widget`, `--chat-panel`, `--dropin --chain <label>`; `tools/pin.mjs --mailbox
  --files`, `--quarantine <infohash>`; `tools/webseed-file.mjs`; `tools/build-idp.mjs`; `tools/verify-release.mjs`;
  `tools/init.mjs`. If a name or flag differs, update OPERATIONS ("Owner settings"), DEPLOY ("v0.3"), the three recipes and
  PUBLISH-CHECKLIST 16.
- **ui lane.** Say which body the widget posts (see above). Say whether `publish --signin-widget` also serves
  `/_mw/idp-return` for a site without the drop-in engine; the widget recipe leaves it open.
- **idp lane.** The DEPLOY text on the identity origin gives no header list beyond R 2.2.4 and says to use the headers the
  build documents; fill it in when `src/idp` and `tools/build-idp.mjs` land, and say whether `'wasm-unsafe-eval'` is still needed.
- **sdk lane.** SDK.md can link PRIVACY.md "The sentences the loader and these documents use" for the replaced wording.
- **Integrator.** Flip statuses as above; add the vector lines the lane notes list to `test/vectors/LOCK.json`; extend
  `repo-layout.test.mjs` for `packages/`; re-run the full suites; copy the contract text from the lane notes into INTERFACES
  and ARCHITECTURE as those lanes ask; decide the 0.2.1 versus v0.3 release question (PUBLISH-CHECKLIST 16).

## Open

- Counsel has reviewed nothing: PRIVACY.md, the cards, the safe-harbour paragraph, the transfers questions, the children's
  defaults, the file-lane duties and the hub rules are all "counsel review before release".
- Every number in the v0.3 sections is labelled measured, arithmetic or chosen with its source; none of the throughput
  figures is measured, and nothing was measured on a phone or a public network.
- Firefox, real devices and the 40 gate rows have not run.
