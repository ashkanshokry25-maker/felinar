# Deviations and notes: deploy-ops-security (documentation wave, 2026-10-19)

Owned files: `docs/DEPLOY.md`, `docs/OPERATIONS.md` (new), `docs/SECURITY-MODEL.md`, `docs/CRITIQUE.md` (new),
`docs/PRIVACY.md`, `docs/DEMO-RESULTS.md`. The first versions of DEPLOY, SECURITY-MODEL, PRIVACY and DEMO-RESULTS
(code review round 1) were grown in place. `## Owner duties` and its DESIGN-REVIEW 4.5 sentence in DEPLOY.md are
unchanged, so `tools/publish.mjs` and `test/unit/docs-links.test.mjs` still find them.

## Corrections to the first versions (checked against the code)

1. **SECURITY-MODEL.md said every file is checked against "its own SHA-256" before it is served or uploaded.**
   It isn't: serving and uploading check SHA-1 pieces against the torrent (`src/loader/verify.js`,
   `src/sw/core.js`); `/.mw/files.json` holds a SHA-256 per file but is read only by the drop-in refresh
   (`src/dropin/refresh.js`) and is not bound to the pointer (`fj=` is a 1.0 ROADMAP item). The new text says so.
2. **PRIVACY.md said the DNS-over-HTTPS resolver is contacted "only for a pointer published in DNS".** Shell
   pages on a public hostname query `_magnet.<host>` after "Share and load" (or the gate's "Load") whether or
   not a TXT record exists: right after the choice, then every 5 minutes or the TTL, and on focus at most once a
   minute (`src/loader/app.js` `afterRender`, `scheduleUpdateCheck`, `checkForUpdate`, `dnsAllowedBy`). Drop-in
   never queries DNS. PRIVACY, DEPLOY ("What you need", "The DNS TXT record") and SECURITY-MODEL now say this.
   There is no owner switch to turn the lookup off; `<meta name="mw-doh">` only changes the resolver.

## Placement decisions

- The privacy-notice template and the verbatim consent texts are in PRIVACY.md (DIGEST-AMENDMENTS F2, research
  digest P0-18 name PRIVACY.md); OPERATIONS.md has the privacy operations (when visitors are asked again,
  requests, breaches, retention of records an owner holds, children's content) and links PRIVACY.md for the
  texts and the template.
- The notice-and-action runbook (F3: intake, case log, classes and times, levers, templates, drill) is a section of
  OPERATIONS.md; the research digest's name `ABUSE-RUNBOOK.md` is not in the binding layout and is not used.
- F4 (owner duties) is the extended "Owner duties" section of DEPLOY.md; F5 (host recipes with dated prices and
  CORS JSON, rollback as roll-forward with a compare-and-swap DNS update) and F6 (CI security baseline) are in
  DEPLOY.md, which also links the per-host recipes in `docs/recipes/` and the READMEs of `deploy/tracker/` and
  `deploy/pin/`. D3 (kill switch) stays in RUNBOOK section 11 and is summarised in DEPLOY.md.
- DEMO-RESULTS.md numbers the rows G1 to G22. G1 to G18 are the ARCHITECTURE section 12 gate plus the two phone
  checks the first version had; G19 (takedown drill), G20 (posting fee on phones), G21 (Safari
  `resultingClientId`) and G22 (iOS identity storage) are the drills and open items of ARCHITECTURE section 14,
  OPERATIONS and the ROADMAP. DEPLOY, OPERATIONS and CRITIQUE cite rows by these numbers.

## Commands checked on this machine (offline, no network)

`publish` (shell, drop-in, `--withdraw`, `--prev-key` rotation, a new key without `--prev-key`), `ledger owner`
with `--accept-key`, `ledger policy` (partial update; `--moderator` replaces the list), `snapshot` from a file,
`keygen`, the `restamp-pointer.mjs` script in DEPLOY.md on shell and drop-in output, the two `jq` checks in
OPERATIONS.md on sample `check-site --json` output, `npx --no-install magnet-web --version`. The host, DNS and
CI recipes were not run: they are marked as documentation-based in DEPLOY.md.

## Found in files I don't own (not changed; for their owners)

1. `README.md` ("What it is not", item 9) and `docs/WHY.md` ("Third parties carry the introductions") say the
   default `<meta>` pointer "needs no lookup". It needs none to load, but shell pages check DNS-over-HTTPS for
   updates after "Share and load" (correction 2). The first-run card names the resolvers only for DNS-only sites
   (`strings.consentDns`); a page-tag site's card covers them only as "connection servers run by third parties".
2. `docs/WHY.md` ("The idea", item 2): "every file against its SHA-256" is not checked when serving (correction 1).
3. `docs/RUNBOOK.md` section 6: "the ledger id includes the owner key, so a rotation starts a new ledger" is
   outdated since code review F09 (`lo=` keeps the ledger). Section 10 step 6 still says a site "calls
   `mw.consent.accept()`", which v0.2.1 A4 removed (`mw.consent.request()` opens the loader's card).
4. `tools/publish.mjs`, `webseed-layout.txt`: "WebTorrent sends Range, Cache-Control and User-Agent, so browsers
   preflight every cross-origin web-seed request" predates the B3 patch. Its CloudFront note recommends the managed
   `CORS-with-preflight-and-SecurityHeadersPolicy`, which sends no `Access-Control-Allow-Headers` (research w1-10
   F5); it works only if S3's own CORS answer passes through, which is untested.
5. `tools/publish.mjs --dropin`, `csp.txt`: "If you also publish the pointer in DNS (dns.txt), add the
   DNS-over-HTTPS resolvers" does not apply: drop-in never reads DNS.
6. `tools/publish.mjs --prev-key`: after a rotation it still prints "Ledger snapshot: upload genesis.json ... to
   <cs URL>", which would replace a snapshot that holds the hand-over. OPERATIONS.md warns about it.
7. `tools/snapshot.mjs` prints "visitors need DecompressionStream, Safari 16.4 or later: use --plain for older
   iOS", which predates code review F20 (the `src/common/inflate.js` fallback).
8. `tools/ledger-admin.mjs` given `--file x.json.gz` writes plain JSON back under the `.gz` name. The loader
   detects gzip by its magic bytes, so it still works; OPERATIONS.md uses plain `ledger.json` files.
9. The `publish --dropin` egress note (`tools/publish.mjs`) calls the 13.3x drop-in multiplier "the measured
   example"; MIGRATION-DIGEST M10 and research w2a-07 F21 call it arithmetic ("Model for the multiplier").
   `README.md` and `docs/WHY.md` were corrected by their owner during this wave; my documents say "a worked
   example".
10. The posting identity is created when the ledger opens on the first visit, before any post and before the
    consent choice, in both modes (`src/loader/app.js` `openLedger` and `loadIdentity`, `src/dropin/ledger.js`
    `loadSigner`). Research w2b-06 F15 recommends creating it at the first write; the ROADMAP's recoverable guest
    identity (1.0) does. PRIVACY.md states the current behaviour.
11. No owner setting forces host-only (research digest P1-21 proposed `aud=kids` forcing it); `aud=kids` only
    makes the gate the default. OPERATIONS and PRIVACY say so.
12. A production subdomain hub needs `<meta name="mw-hub" content="subdomain">` in the apex's `index.html` and
    `404.html`; only `tools/dev-server.mjs --hub` writes it. DEPLOY.md says so.
13. `tools/check-webseed.mjs` run by hand treats a web seed on the site's own origin as cross-origin unless given
    `--origin <site origin>` (its default origin is `https://check-webseed.invalid`); `check-site` and
    `publish --verify-ws` pass the site's origin. DEPLOY.md shows `--origin`.
14. "Forget this site" deletes the stored site versions only, not the identity, the ledger database, the
    remembered key or the consent record (`src/loader/app.js`, settings action `forget`). PRIVACY.md says so;
    the research template's "To delete: Settings, Forget this site, or clear site data" was adjusted.

## Verification

- `npm test` after the last change (2026-10-19): exit 0, 929 tests, 929 pass, 0 fail. The only failure seen
  while writing was `CONTRIBUTING.md -> VERIFY.md` in the docs-links test, which belongs to another document
  and was fixed by its owner.
- Relative links and GitHub heading anchors in every Markdown file of the repository (top level, `docs/`,
  `docs/recipes/`, `deploy/*/README.md`, `examples/`): 0 problems.
- Wording scan of the seven files: no "serverless", "blockchain", "censorship-resistant", "unstoppable",
  "fully decentralized" or "sub-second", no em or en dashes, no curly quotes; the one "isolation" says a
  shared-origin hub has none.
- Last pass: only a shell page has the Settings, Diagnostics list (the drop-in panel has none; it warns once per
  problem in the console). OPERATIONS and DEMO-RESULTS now say so and list what each `inspect()` returns
  (`inspectShell` in `src/loader/app.js`, `inspect()` in `src/dropin/engine.js`). The pin-node check in
  OPERATIONS now has the `docker logs` form that `deploy/pin/README.md` uses, and notes that `--quiet` turns the
  status lines off.
