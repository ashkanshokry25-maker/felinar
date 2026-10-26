# v0.3 research and design: index

- **Date:** 2026-10-20. **Applies to:** magnet-web 0.2.1 going to 0.3. **Status:** research plus design proposals for the owner; nothing in this folder is shipped or binding until the owner signs off the decisions listed below.
- **Wording:** every file here follows the project rules ("no backend", "site ledger", no claim of takedown resistance or full decentralisation, every number sourced).

## Read in this order

| # | File | What it is | Size |
|---|---|---|---|
| 1 | [DIFFERENTIATORS-AND-WHY.md](DIFFERENTIATORS-AND-WHY.md) | Synthesis: the differentiators that survive (D1 to D5, candidates D6 and D7), the honest WHY with ready-to-paste sentences, audiences, comparison table, counter-arguments, the complete weak-area list (W1 to W24) with v0.3 yes or no, and the claims the current tests allow | about 35 KB |
| 2 | [PRIVACY-UPGRADES.md](PRIVACY-UPGRADES.md) | Synthesis: each of R2's 17 privacy failures plus 8 that v0.3 introduces, as problem, today, upgrade, residual, sentence the docs may say; the decision on encrypted records in the ledger; new recipients-register rows | about 31 KB |
| 3 | [IDENTITY-AUTH-DESIGN.md](IDENTITY-AUTH-DESIGN.md) | Design proposal (amendments to ARCHITECTURE 6.1, 6.9, 6.10, 9 and INTERFACES): seed-derived per-site keys, passkey PRF wrap, recovery, QR hand-off, sign-in and sessions, roles, the sealed private record, SDK, compatibility, threat model, example-site login, tests, build plan | about 40 KB |
| 4 | [REALTIME-AND-FILES-DESIGN.md](REALTIME-AND-FILES-DESIGN.md) | Design proposal (amendments to ARCHITECTURE 6.6, 6.11, 6.12, 8, 9 and INTERFACES): chat lane, sealed DMs, groups, rooms, presence, offline holders, file lanes, limits, moderation, the full exposure statement, SDK, example site, tests, build order | about 37 KB |

## The research it is built on

| File | Topic |
|---|---|
| [R1-landscape-differentiators.md](R1-landscape-differentiators.md) | 20-odd systems compared: who runs, who holds identity, who pays, what breaks |
| [R2-privacy-failures-2026.md](R2-privacy-failures-2026.md) | 17 privacy failures of today's web, with sources, and magnet-web's status for each |
| [R3-identity-auth-landscape.md](R3-identity-auth-landscape.md) | Passkeys and PRF, DIDs, Nostr, AT Protocol, SIWE, recovery, unlinkability, the auth block |
| [R4-why-and-positioning.md](R4-why-and-positioning.md) | Audiences, economics, breach costs, history of earlier pitches, wording audit |
| [R5-weak-area-audit.md](R5-weak-area-audit.md) | 19 weak areas from the code and docs, with fixes and efforts |
| [R6-legal-compliance.md](R6-legal-compliance.md) | Erasure, controller roles, Canada and Quebec, DSA and OSA, age assurance, encryption law, export (not legal advice) |
| [R7-ease-of-use.md](R7-ease-of-use.md) | Owner and visitor journeys, `init`, `ship`, `try`, a sign-in for people who have never heard of keys |
| [R8-realtime-chat-and-files.md](R8-realtime-chat-and-files.md) | Transport, encryption, offline delivery, metadata, spam and files with no backend |

All eight R-files were read in full for the synthesis, including R7, which the synthesis brief's summary list omitted.

## Phase C2 inputs (2026-10-20, after the owner's browser-only decision)

| File | What it is |
|---|---|
| [SEEDING-AND-ZERO-SETUP-DESIGN.md](SEEDING-AND-ZERO-SETUP-DESIGN.md) | Synthesis: smart seeding (amends ARCHITECTURE 8), the zero-setup ladder (amends DEPLOY and QUICKSTART), adoption mechanics for v0.3 and v0.4, what cannot be done, peer-to-peer calls, the seven C2 build lanes; owner decisions SZ-1 to SZ-6 |
| [S1-smart-phone-seeding.md](S1-smart-phone-seeding.md) | Phones: what iOS and Android allow, availability arithmetic, lanes, budgets, hand-off, labels, gate rows G-PS-1 to G-PS-14 |
| [S2-zero-setup-hosting.md](S2-zero-setup-hosting.md) | nip.io and sslip.io, automatic HTTPS, LAN and tunnels, free hosts, the one-box Caddy template, CLI strings Z1 to Z9 |
| [S3-adoption-mechanics.md](S3-adoption-mechanics.md) | What drove adoption and retention elsewhere; keepers (their installed forms rejected by the owner), meters, links, badges, templates, the hub, metrics |

Evidence for the calls design: [c2-calls-lab](../labs/c2-calls-lab/README.md) (loopback only).

## Decisions the owner must sign off before the build

| ID | Decision | Recommended | Where |
|---|---|---|---|
| PR-1 | Private record: local-first vault plus opt-in sealed ledger record, or commitment only | local-first plus opt-in, counsel to confirm | PRIVACY-UPGRADES 4.1 |
| PR-2 | Per-site shreddable record key (not in the phrase) or phrase-derived key (tombstone-only per site) | phrase-derived for v0.3, stated honestly | PRIVACY-UPGRADES 4.3 |
| D-1 to D-7, D-11 | Derivation tree, storage, passkey role, backup routes, migration, login challenge, session states, record format | as written | IDENTITY-AUTH-DESIGN 3 to 6 |
| D-8 | Advisory roles under `_roles/` | yes | IDENTITY-AUTH-DESIGN 5 |
| D-9 | Moderators may write `allow` (format freeze window) | yes, before any public ledger | IDENTITY-AUTH-DESIGN 5 |
| D-10 | Add `unban` and `rotate` ops (format freeze window) | yes, before any public ledger | IDENTITY-AUTH-DESIGN 5 |
| D-C1 to D-C7, D-C9 | Chat swarms, frames, budgets, presence, chat-key record, sealed box, groups, file lanes | as written | REALTIME-AND-FILES-DESIGN 4 to 6 |
| D-C8 | TURN with no backend: public static credentials with quotas, or a credential endpoint | static with quotas for small sites, off by default | REALTIME-AND-FILES-DESIGN 9.4 |

## Findings new in the synthesis (not in R1 to R8)

1. **Per-site crypto-shredding is impossible in the phrase-derived design:** the phrase re-derives every site's record key, so deleting a key on a device is not shredding while the phrase exists (PRIVACY-UPGRADES 4.3).
2. **The record "tiers" are UX boundaries, not security boundaries:** in shell mode the site frame is same-origin with the loader and can wrap its functions; only a separate identity origin protects keys and plaintext from hostile site code (IDENTITY-AUTH-DESIGN 6.5).
3. **Passkey PRF wrapping does not stop a hostile same-origin script** that triggers a passkey prompt with the same salt; the browser prompt is the only signal (IDENTITY-AUTH-DESIGN 3.4).
4. **A TURN relay needs either public credentials (an open relay bounded by quotas) or a credential endpoint (a backend)** (REALTIME-AND-FILES-DESIGN 9.4).
5. **First contact from a stranger needs a public inbox tag** that shows observers someone wrote to that key that day (REALTIME-AND-FILES-DESIGN 5.3).

## Before anything here is quoted publicly

Re-check the items each R-file marks UNVERIFIED or "search snippet only", run the first release-gate pass (DIFFERENTIATORS-AND-WHY W1), and have counsel read R6 and PRIVACY-UPGRADES 4.
