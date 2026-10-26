# Review round of R 5.3: index of the notes

Written 2026-10-24 05:13 EDT (America/Toronto) by the promote lane (R 5.3 item 4). This page is the index of the notes the
review round of [review/V03-DESIGN-REVIEW.md](../review/V03-DESIGN-REVIEW.md) ("R") left. The results, finding by finding,
are R section 5.4; the contracts the round changed are ARCHITECTURE 15.20 and the INTERFACES section "v0.3 review round".
The project is felinar (the light web), formerly magnet-web and, for one day, Lightweb; the notes below were written under
those names.

## Inputs

| File | What it holds |
|---|---|
| `.orchestration/reports/all-findings-2026-10-22.json` | 203 finding records from 16 reviewers (the six judges, the eight red-team attackers and two conformance agents, one for ARCHITECTURE 8.1 and 15 against `src/chain`, `src/loader`, `src/sw`, `src/common`, `src/calls`, `src/pin`, `src/sdk`, tools, examples and deploy, one for the identity, chat, files and media code and the sign-in spec), plus two records (GATE-1, GATE-2) from the owner-side gate run in Brave (`.orchestration/reports/gate-notes-brave-2026-10-22.md`), with file, line, scenario, fix and test; 199 distinct ids (CONF-1 to CONF-4 have two records each); 22 raised as blockers, 114 as majors, 67 as minors |
| `.orchestration/reports/verdicts-2026-10-23.json` | two refuters per serious finding (136 records): 121 confirmed by both, 1 refuted (STALK-4), 14 not confirmed by two because the session limit stopped a refuter |

## Fixer notes (the fix wave, R 5.3 item 2)

Each note lists every finding of its area as fixed (code and a regression test that fails on the code before), partial
(what is left, with a request) or rejected (minor, deferred, with the reason), then "Requests" with the exact edit for a file
the fixer could not touch. The counts are rows of each note's table.

| Note | Area and files | Rows: fixed, partial, rejected | Requests |
|---|---|---|---|
| [review-round-chain.md](review-round-chain.md) | `src/chain/block.js`, `state.js`, `node.js`, `gossip.js`, `multi.js`, `tools/ledger-admin.mjs`; 20 tests in `test/unit/chain-review-round.test.mjs` | 16, 4, 4 | 11 (review-round-chain.md:64 to :111) |
| [review-round-chat.md](review-round-chat.md) | `src/chat/**` | 29, 9, 0 | R1 to R10 (review-round-chat.md:78 to :129) |
| [review-round-docs.md](review-round-docs.md) | README, docs (not THREAT-MODEL, OPERATIONS, DEPLOY, DEMO-RESULTS, PUBLISH-CHECKLIST, DEV-NETWORK), recipes, loader and identity strings; `test/unit/docs-review-round.test.mjs` | 17, 8, 6 | 16 (review-round-docs.md:65 to :147) |
| [review-round-examples.md](review-round-examples.md) | `examples/peer-guestbook/**`, `test/example/**` | 2, 1, 0 | 1: SYB-12 in `examples/social/js/data.js` (review-round-examples.md:96 to :150) |
| [review-round-identity.md](review-round-identity.md) | `src/identity/**`, `src/idp/**`, `packages/verify/**`, `src/dropin/**`, `src/widget/**`, the sign-in spec; `test/unit/idp-review-round.test.mjs` | 20, 12, 3 | 15 (review-round-identity.md:64 to :115) |
| [review-round-loader-pointer.md](review-round-loader-pointer.md) | `src/common/**`, `src/loader/app.js`, `doh.js`, `mod.js`; `test/unit/review-round-loader-pointer.test.mjs` | 10, 6, 1 | 10 (review-round-loader-pointer.md:47 to :99) |
| [review-round-loader-ui.md](review-round-loader-ui.md) | `src/loader/ui.js`, `strings.js`, `torrent.js`, `policy.js`, seed planner and superseed, `src/widget/redress.js`, the two accept branches of `mod.js`; `test/unit/review-round-loader-ui.test.mjs` | 13, 5, 1 | R1 to R13 (review-round-loader-ui.md:37 to :100) |
| [review-round-media.md](review-round-media.md) | `src/files/**`, `src/media/**`; `test/unit/media-review-round.test.mjs` | 13, 2, 1 | R1 to R5 (review-round-media.md:128 to :160) |
| [review-round-tests.md](review-round-tests.md) | `test/unit/hub-moderator-gaps.test.mjs` (HUB-12) | 0, 1, 0 | 4 (review-round-tests.md:64 to :89) |
| [review-round-tools.md](review-round-tools.md) | `tools/tracker.mjs`, `verify-release.mjs`, `publish.mjs`, `withdraw.mjs`, `ship.mjs`, `seed.mjs`, `build.mjs`, `deploy/**`, SECURITY.md, THREAT-MODEL, DEPLOY, OPERATIONS | 6, 11, 2 | R-SEC-6 to R-BIN (review-round-tools.md:81 to :153) |

## Lane notes (the finish phase that ran beside the review, 2026-10-22)

| Note | What it closed or opened |
|---|---|
| [firefox.md](firefox.md) | Playwright Firefox 157.0 runs on loopback in the harness (`--firefox`); 31 Firefox scenarios pass; four harness defects and one possible product gap (F:E-MD-1, no poster) for the integrator (firefox.md:114 to :121; the defects at :90 to :112) |
| [a11y.md](a11y.md) | axe-core 4.14.0 as a development dependency; E-ID-9 and E-ID-9b pass, E-SO-12 passes in part (60 screens, 0 violations; the keyboard-only direct message is not scripted) |
| [rows-identity.md](rows-identity.md) | E-ID-3, 3b, 8, 11, 13, 14 and 15 pass; no defect |
| [rows-chat.md](rows-chat.md) | E-CH-2, 3, 4, 9, 10, 11 and 12 pass, E-CH-5 and 7 in part; no defect |
| [rows-media.md](rows-media.md) | E-FI-5, E-FI-6, E-MD-3 and E-MD-5 pass, E-MD-6 in part; E-FI-4 stays a real-device row; defects D-1 and D-2 of the pin node |
| [rows-social.md](rows-social.md) | E-SO-3, 4, 7 and 8 pass, E-SO-6 and E-SO-9 in part, E-SO-5 open; defects D-1 to D-3; missing clauses C-1 (where a hub publishes a followed ledger's recent window) and C-2 (`mw.mod.requestJoin`) |

## Where the round's results went

- [review/V03-DESIGN-REVIEW.md](../review/V03-DESIGN-REVIEW.md) section 5.4: the counts, every finding id with its status and a
  one-line reason for the partial, rejected and refuted ones, the lanes' outcomes and the residual list; 2.16.2 and the
  2.17.6 rows the round changed.
- [ARCHITECTURE.md](../ARCHITECTURE.md) 15.20 and [INTERFACES.md](../INTERFACES.md) "v0.3 review round": the contracts as built
  after the fixers; every "(proposed)" left in either file names the reason it is not built.
- [THREAT-MODEL.md](../THREAT-MODEL.md) and [SECURITY-MODEL.md](../SECURITY-MODEL.md): the rows and guarantees the round
  changed.

## Requests still open after the promote lane

The requests above that name a file outside the promote lane's six files are the integrator's (the brief of the
integrator applies every request that names a file a fixer could not touch). The promote lane applied the requests that
named its own files: review-round-docs.md Request 1 and Request 16, review-round-chain.md Request 9 (THREAT-MODEL and
SECURITY-MODEL parts and the rotate contract), review-round-identity.md Requests 6, 9 (THREAT-MODEL and SECURITY-MODEL parts)
and 15, review-round-loader-pointer.md Requests 4 and 6 (THREAT-MODEL and SECURITY-MODEL parts), review-round-chat.md R6
(THREAT-MODEL and INTERFACES parts) and review-round-loader-ui.md R10 (ARCHITECTURE and INTERFACES parts).

## After the integration and verifier round 1 (2026-10-24)

The integrator's record, request by request, is [review-round-integration.md](review-round-integration.md): section 1 applies
the lanes' defects (rows-media D-1 and D-2, rows-social D-1, the Firefox harness defects), section 2 the fixers' requests and
section 3 lists the requests not applied, with the reason. The fixes after verifier round 1 (E-SO-2, E-SO-9, E-CH-7, the
fresh-clone unit run, the rename strings and the documents) are in [review-round-verify-1.md](review-round-verify-1.md), and
those after verifier round 2 (the example composer test, E-SO-4 without E-SO-3, E-SO-9B, and E-SO-5 left open) in
[review-round-verify-2.md](review-round-verify-2.md); those after verifier round 3 (integration Requests 3 to 5 in the
documents, and the hub-directory counsel sentence) in [review-round-verify-3.md](review-round-verify-3.md). The
fixer and lane rows above are the counts as each note wrote them; R 5.4.1 gives the per-id counts after the integration.
