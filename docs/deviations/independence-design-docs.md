# Independence design: the design-docs fixer (IND-1, IND-7, IND-8, IND-9; 2026-10-25)

Written by the design-docs fixer on 2026-10-25 between 09:32 and 09:50 ET (times from `TZ=America/Toronto date`), one of three
fixers that worked on the tree at the same time (the others: code, release-docs). The plan is the independence design of
2026-10-25 (the owner's request: "make it domain independent"; the decision memo is kept with the orchestration notes, which are
not tracked). Decisions taken by the orchestrator under the owner's delegation and recorded here: O1, the project runs no default
identity origin in 0.3.0 (N-2 decided as "none"); O4, no hosted demo by default; O7, SZ-3 accepted (399 days, with a calendar
reminder file planned for 0.3.x). Nothing was committed, pushed or published; the checkpoint loop carries the edits. Only
exact-line edits were made to shared files. No end-to-end suite was run: no row of this fixer names one.

## Changes, row by row

| Id | What changed (file:line, as of 09:44 ET) | Tests and results |
|---|---|---|
| IND-1 | N-2 recorded as decided, "none in 0.3.0", with the wording "By design, the project hosts no identity page: run your own or use one you trust". `docs/PUBLISH-CHECKLIST.md:422` (the decision row), `:1282` (16.1: "N-2 decided: no default identity origin in 0.3.0"), `:1362` (16.6 first item: conditional on a later shared default, "buy it yourself" gone, the nip.io/sslip.io and not-a-subdomain rules kept); `docs/DEPLOY.md:1240` to `:1246`; `docs/FAQ.md:395`; `docs/PRIVACY.md:26` to `:30` (with O4: a hosted demo is optional and 0.3.0 has none), `:186`, `:427` (the register row stays the template every operator copies); `docs/QUICKSTART.md:318` to `:324` (adds: a site whose visitors only read needs no identity page; the owner writes offline with `tools/ledger-admin.mjs`); `README.md:136` to `:138`; `CHANGELOG.md:649` (the known gap); `docs/ARCHITECTURE.md:1378` to `:1379` (15.1) | HON-4 rewritten (`test/unit/docs-review-round.test.mjs:83` to `:96`): no early return; pins "By design, the project hosts no identity page" in FAQ, CHANGELOG, README, QUICKSTART, DEPLOY and PRIVACY, refuses the old "yet" and "has not been made (N-2" wording there, refuses "buy it yourself" in the checklist and pins the 16.1 line; keeps the two doesNotMatch checks (project publishes one, the release hash). Run against the HEAD text of the six files: the new wording is absent and the old wording present in each, so the test fails on the old tree. 1 of 1 pass |
| IND-7 | `docs/DEPLOY.md:23` to `:38`: the dependency table ("What you need") gains a column "Replace it with" and four rows (an identity origin, a name, a certificate authority, the code at deploy time); the certificate row names `LW_ACME_CA` (the Caddyfile reads it; not tried) and says `ship` writes Let's Encrypt. Z1 (`tools/ship.mjs:99`) now reads "the name costs nothing and needs no sign-up, but the server is rented under an account its provider can close"; copies at `docs/QUICKSTART.md:204`, `deploy/one-box/README.md:175`, and the same claim at `deploy/one-box/README.md:4`. The bare-IP claim corrected: `docs/DEPLOY.md:455` to `:460` (passkeys live at the identity origin; an identity page on an IP address keeps identities through the passphrase card, `src/idp/idp.js:421` to `:424`; the real costs are the 6-day certificate, the unrun Caddy variant and one authority), `docs/FAQ.md:294`, `docs/COMPATIBILITY.md:378`, and `docs/QUICKSTART.md:262` (same sentence, owned). Hubs need an owned domain: `docs/DEPLOY.md:941` to `:943`, `docs/ARCHITECTURE.md:149` to `:152` (3.2) | `test/unit/tools-ship.test.mjs:201` to `:206` (the Z1 pin and a doesNotMatch on "It costs nothing"; the row named `:42` to `:43`, which hold the name constants, not the pin); `test/unit/deploy-one-box.test.mjs:200` to `:204` (the README holds the new Z1, no "costs nothing and needs no sign-up" sentence, and "the server is rented under an account"). 58 of 58 pass in the two files |
| IND-8 | Doors first. `docs/DEPLOY.md:1000` to `:1022`, a new subsection "Doors without a domain": publish once with `--chain` and `--door`, hand out `link.txt` or the QR code; three doors with no purchase (a free static site with a door kit, a friend's host, the built loader on 127.0.0.1 with the link pasted into `/_mw/open.html`, `pastedFragment` in `src/loader/app.js`); guest doors give a per-visit identity; door kits check against the pinned release key (IND-3); no G-DR row has run on a real host. `README.md:81` to `:82` (item 9) and `:138` to `:141` (the guestbook: `--chain peer-guestbook --door <host>`); `docs/QUICKSTART.md:14` to `:15` (the intro), `:62` to `:66` (a third block of the short version), `:163` (rung 2d, a light link); `docs/FAQ.md:283` to `:285` | None new, as the row says: doors are covered on loopback by e2e DOOR-DOWN, DOOR-HASH and DOOR-GUEST, which were not run here. `README-DOOR.txt` (`tools/door-kit-files.mjs:63` to `:81`) read, unchanged: it already says "the site lives at its key; domains are doors" and names the pinned key |
| IND-9 | `docs/DEPLOY.md:1278` to `:1294`: "Hosting it without buying a domain", a table of no-purchase identity hosts (`*.pages.dev` or `*.netlify.app`: headers sent, one company each; `<user>.github.io`: no headers, only `refuseFramed`, not recommended; an IP-address origin: passphrase only; a one-box sibling name: 0.3.x, unmeasured) and the move rule (passkeys and the passkey-wrapped copy stay; the 12 words restore the public identity; the backup file restores everything; back up at the first sign-in on a short-term host). `docs/FAQ.md:435` to `:439` (the move rule in the recovery answer); `docs/recipes/github-pages.md:81` to `:84` (do not host an identity page there) | The MF-09 case extended (`test/unit/idp-review-v03.test.mjs:439` to `:456`): an identity page at `https://203.0.113.7` with the real passkey module; the RP ID it sends is `203.0.113.7`, the browser's `SecurityError` maps to `E_UNSUPPORTED`, the passphrase card shows in the same window, the site gets its keys, and no "Tap to finish" is asked. Proved by a scratch copy that throws another error name: the case then fails at "an identity page on an IP address still gives the site its keys". 2 of 2 MF-09 tests pass. Not measured: a passkey on any of these names in a real browser |
| SZ-3 | `docs/ARCHITECTURE.md:1590` to `:1593` (the table's intro: SZ-3 decided, the other five unsigned) and `:1599` (the row: 399 days accepted with a reminder file planned for 0.3.x; the owner key never on a server or in CI); `docs/DEPLOY.md:465` to `:466` ("accepted on 2026-10-25") | covered by `test/unit/tools-ship.test.mjs:281` (`SHIP_DEFAULT_EXP_DAYS` equals the longest record publish signs), unchanged |

## Suites

- `node --test test/unit/docs-links.test.mjs test/unit/docs-review-round.test.mjs test/unit/docs-claims.test.mjs
  test/unit/tools-ship.test.mjs test/unit/deploy-one-box.test.mjs test/unit/idp-review-v03.test.mjs` at 09:41 ET: 106 tests,
  106 pass, 0 fail. Every new anchor (`#doors-without-a-domain`, `#hosting-it-without-buying-a-domain`,
  `#door-kits-publish---door-kit`, `#your-own-tracker`, `#your-own-tracker-and-stun-servers-for-chat-and-files`) was checked
  against the headings.
- `npm test` at 09:42 to 09:44 ET: lint floor clean (147 files); 2,305 tests, 2,294 pass, 2 fail, 9 todo. Both failures are in
  `test/unit/docs-domain-free.test.mjs` (IND-5 and IND-3, another fixer's new test): six lines of three historical deviation
  notes (`review-round-tools.md:75`, `:78`, `:103`, `:104`, `review-round-verify-1.md:74`, `review-round-verify-3.md:17`) still
  name the project domain, which IND-5 rewords; no file of this fixer is in either list. Run again with this note in place, 09:44
  to 09:46 ET: the same counts (2,305 tests, 2,294 pass, 2 fail, the same two, 9 todo), lint floor clean.
- Every added line is plain ASCII and free of the forbidden words (checked with `git diff` and grep).

## Open, with reasons

- A passkey on `*.pages.dev`, `*.netlify.app` or `<user>.github.io` in a real browser, and a browser's exact error for an IP RP ID,
  are not measured here (the unit case stands in a `SecurityError`, as WebAuthn requires for an RP ID that is not a valid domain).
- The local door (`npx felinar dev`, then paste into `/_mw/open.html`) is described from the code and the loopback e2e suites;
  it was not run by hand in this step.
- The calendar reminder file of SZ-3 is not built in 0.3.0; the documents say "planned for 0.3.x".

## Requests for files this fixer does not own

1. `docs/DEPLOY.md`, the DNS-over-HTTPS row of "What you need" (`:31`, the code fixer's IND-10 line): the table now has five
   columns; add the fifth cell, for example "a resolver the site names with `<meta name="mw-doh">`; a name that cannot carry a
   TXT record is never looked up".
2. `docs/PUBLISH-CHECKLIST.md:1397` to `:1405` (release-docs): the second item of 16.6 ("Once the identity page answers at that
   domain ...") and its search should become conditional on a later shared default; the search for "no identity origin is
   published yet" now finds nothing by design.
3. `docs/recipes/README.md:70` and `:71` (release-docs or the orchestrator): "no default identity origin exists yet (owner decision
   N-2)" should read "the project hosts no identity page, by design (N-2)".
4. `docs/ARCHITECTURE.md:853` and `:916` to `:929` (section 8, not this fixer's): "the owner decisions SZ-1 to SZ-6 (15.11) are
   unsigned" should say SZ-3 is decided.
5. `docs/WHY.md:425`: "A site with no domain and no sign-up | `ship` to a rented server" should say the rented server is an
   account, as Z1 now does.
6. `tools/ship.mjs:9` (a comment): "which costs nothing and needs no sign-up" is true of the name only; same rewording as Z1 if
   anyone edits that header.
7. `docs/research/v03/S2-zero-setup-hosting.md:264` keeps the old Z1 as research history; the test name says Z1 was reworded.
