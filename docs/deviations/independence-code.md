# 0.3.0 domain independence: the code rows IND-10, IND-11 and IND-12 (2026-10-25)

Written by the code fixer on 2026-10-25 between 09:34 and 09:46 ET (times from `TZ=America/Toronto date`), one of three fixers
working on the tree at the same time (the others: release-docs and design-docs). The plan is the decision memo
`.orchestration/reports/independence-design-2026-10-25.md` (not tracked), section 3 and its change-list block, after the owner's
request of 2026-10-25 to make the project domain independent. Nothing was committed, pushed or published; the checkpoint loop
carries the edits. Every run stayed on 127.0.0.1. Documents were changed only by exact-line edits.

| Id | Code change (file:line) | Tests (file:line) | Documents (file:line) | Result |
|---|---|---|---|---|
| IND-10 | `src/loader/doh.js:59` to `:68`: new exported frozen `NO_TXT_SUFFIXES` (github.io, gitlab.io, codeberg.page, pages.dev, workers.dev, netlify.app, vercel.app, surge.sh, trycloudflare.com, ts.net); `:88` to `:96` `isNoTxtPlatformName` (function at `:92`) (dot boundary, the matching of `isWildcardDnsName`); `:115` `shouldSkipDoh` returns `isWildcardDnsName(h) \|\| isNoTxtPlatformName(h)`. `WILDCARD_DNS_SUFFIXES` (`:57`) is unchanged, so `tools/name-check.mjs:23` (`NAME_SERVICES`) and `addressBoundScope` (`tools/publish.mjs:672`) do not widen. dedyn.io and duckdns.org are not listed. No consent version bump. The callers pick it up unchanged: `src/loader/app.js:370`, `:1660` (`dnsUpdatesPlanned`), `:1776`, `:2917`; `tools/check-site.mjs:510` | `test/unit/loader-common-doh.test.mjs:236` (each suffix, a subdomain, upper case, trailing dot; the list is frozen and deep-equals the ten), `:252` (false for xgithub.io, github.io.example.com, my-netlify.app, notts.net, dedyn.io, duckdns.org and others; `WILDCARD_DNS_SUFFIXES` still deep-equals `['nip.io','sslip.io']` and shares no entry), `:266` (a github.io site's `recipientsKey` and consent record `v` and `rcpt` equal those of a named site; the consent card's `dnsUpdate` is false for github.io, netlify.app, pages.dev and ts.net names and true for www.example.com); `test/unit/tools-check.test.mjs:855` (check-site on alice.github.io, my-site.netlify.app, project.pages.dev and a ts.net name: one "dns pointer" line, level info, "not possible for this name (page tag only)", no request to cloudflare-dns.com, doh.dns.sb or dns.google, no DoH target announced; github.io.example.com is still looked up). `test/unit/name-check.test.mjs:36` untouched | `docs/ARCHITECTURE.md:390` to `:396` (section 4, after the C2 paragraph); `docs/DEPLOY.md:31` (the DoH row of "What you need") and `:517` to `:523` ("The DNS TXT record"); `docs/PRIVACY.md:48` to `:50` (the DoH paragraph) and `:65` (the register row, the same exclusion list); `CHANGELOG.md:568` to `:575` (new section "Changed for domain independence (2026-10-25)", first bullet) | unit files pass; revert sample: with `:115` back to `return isWildcardDnsName(h);` in a scratch copy, the three IND-10 tests of `loader-common-doh` and the one of `tools-check` fail (47 pass, 3 fail across the two files); e2e on the rebuilt `dist` (build exit 0, `--check-lock` exit 0): `--only E-ZS-1,7` 2 of 2 (Chromium), `--webkit --only W7` 1 of 1, `--firefox --only F7` 1 of 1, each ending "PASS network policy: every request stayed on 127.0.0.1" |
| IND-11 | none (test only, as the row says). The options it pins: `src/loader/torrent.js:1339` (`this._rtcConfig = { iceServers: (this._iceServers \|\| this.config.stun).slice() }`), `:1342` (`tracker: peers ? { rtcConfig: this._rtcConfig } : false,`), `:1410` (`client.add(source, Object.assign({ private: true }, opts))`), `:1105` (lane rtcConfig starts as `{ iceServers: [] }`), `:1322` (`_useLaneRtc`), `:1283` to `:1287` (`setIceServers` never empty) | new `test/unit/bundle-defaults.test.mjs`: `:40` (the only WebTorrent client in `src/` is built in `_ensureClient`, with that rtcConfig or `tracker: false`, `dht: false`, `lsd: false`; the lane and `setIceServers` pins), `:63` (one `client.add`, with `private: true`; no `.seed(` in the loader; no `private: false/0/null/undefined` anywhere under `src/`; the site and file swarm options name `private: true`), `:101` (when `dist/_mw/webtorrent.min.js` or `node_modules/webtorrent/dist/webtorrent.min.js` exists: the exact STUN pair `stun:stun.l.google.com:19302` and `stun:global.stun.twilio.com:3478`, the eight trackers including `wss://tracker.btorrent.xyz` (matched as "tracker.btorrent", never "btorrent") and five UDP trackers, the http(s) hosts example.com and webtorrent.io; skipped with a message when neither file exists), `:116` (the loader's `CONFIG.stun` and `CONFIG.trackers` name none of the bundle-only hosts). Comments are stripped before matching, so a sentence cannot satisfy a pin | `docs/ARCHITECTURE.md:84` to `:87` (section 1, one sentence after the `private: true` fact) and the second bullet of the CHANGELOG section (`CHANGELOG.md:576` to `:578`) | 4 of 4; revert samples in a scratch copy: `private: true` removed from `:1410` fails `:63`; `tracker: peers ? {} : false` and `tracker: peers ? true : false` each fail `:40`; a ninth tracker string added to the scratch `dist/_mw/webtorrent.min.js` fails `:101` (`+ 'wss://new.tracker.example'`) |
| IND-12 | `tools/init.mjs:20` imports `addressBoundScope` from `./publish.mjs`; `:337` to `:346`: with `writers=open`, an address-bound scope (nip.io, sslip.io, a non-loopback IP literal) gets the prompt "Abuse and legal contact: an https: page or a mailto: address you read (<scope> cannot receive mail)" with no default, a typed answer must start with `https://` or `mailto:` (asked again otherwise), Enter leaves `site.ct` null and the plan's existing warning (`:254`) fires; a named scope keeps "Abuse and legal contact (https: or mailto: URL) [mailto:abuse@<scope>]". The "Do you have a domain?" branch stays 0.3.x (L-8) | `test/unit/tools-v03-init.test.mjs:226` (for 203-0-113-7.nip.io, 203.0.113.7.sslip.io and 203.0.113.7: Enter gives `ct` null, no `[mailto:` and no `abuse@` in the prompt, the plan warns; "abuse@example.org" is refused and "https://example.org/contact" taken; a typed mailto reaches the publish command; forum.example keeps `mailto:abuse@forum.example` with the exact old prompt; owner-only writing asks no contact) | `docs/QUICKSTART.md:238` to `:239` (Rung 2a, after the "cannot carry a DNS record" paragraph: the guided setup offers no derived contact there) and the third bullet of the CHANGELOG section (`CHANGELOG.md:579` to `:581`) | 9 of 9 in the file; revert sample: with the address-bound branch disabled in a scratch copy, the IND-12 test fails (8 pass, 1 fail) |

## Suites

- Touched unit files, 09:40 ET: `node --test test/unit/loader-common-doh.test.mjs test/unit/tools-check.test.mjs
  test/unit/tools-v03-init.test.mjs test/unit/bundle-defaults.test.mjs test/unit/docs-links.test.mjs` 68 tests, 68 pass, 0 fail.
- `npm test`, 09:41 ET: lint floor clean (147 files); 2,305 tests, 2,293 pass, 3 fail, 9 todo. All nine IND-10, IND-11 and
  IND-12 tests pass. The three failures are the other fixers' rows, in progress at that time, all in
  `test/unit/docs-domain-free.test.mjs` (not a file of this lane): IND-5 (`:52`), IND-3 (`:78`) and IND-4 (`:84`), which fail on
  document lines the docs lanes were still editing.
- `npm test` again after this note, 09:44 ET: lint floor clean; 2,305 tests, 2,294 pass, 2 fail, 9 todo. The two failures are
  IND-5 (`docs-domain-free.test.mjs:52`: six lines in `docs/deviations/review-round-tools.md`, `review-round-verify-1.md` and
  `review-round-verify-3.md`, the docs lanes' files) and IND-3 (`:78`); none names a file of this lane.
- `npm run build` exit 0 and `node build.mjs --check-lock` exit 0 (09:41 ET); the new list is in `dist/_mw/loader.js`.
- End-to-end, one run at a time on the rebuilt tree (09:42 ET): `node test/e2e/run.mjs --only E-ZS-1,7` "OK: 2 passed, 0 failed,
  total 12.1s"; `node test/e2e/run.mjs --webkit --only W7` "OK: 1 passed, 0 failed, total 1.8s"; `node test/e2e/run.mjs --firefox
  --only F7` "OK: 1 passed, 0 failed, total 4.0s"; each ended "PASS network policy: every request stayed on 127.0.0.1".

## Open, with reasons

- The full three-engine end-to-end suites the memo asks for after IND-10 (`npm run test:e2e`, `test:e2e:webkit`,
  `test:e2e:firefox`) did not run here: two documentation fixers were editing the tree at the same time, so a 25-minute run would
  not have tested the final tree, and three suites at once miss waits on this machine (INTEGRATION-STATUS, final full runs of
  2026-10-24). They belong to the final verification of this round. No end-to-end row opens a platform name (no scenario under
  `test/e2e/` names github.io, pages.dev, netlify.app, vercel.app or ts.net); the first-visit rows above cover the path.
- Owner step, not provable on loopback: check each IND-10 zone once with `dig` (for example `dig TXT _magnet.<name>.github.io`)
  and confirm that users cannot publish TXT records there. Until then the list is an inference, and the documents say so.
- Out of the row's scope, noted: `tools/seeder.html:109` and `:162` build `new WebTorrent()` with the bundle defaults. That page
  runs in the owner's own browser (`tools/demo.mjs`), not for visitors, so IND-11's guard covers `src/` only; blanking the
  defaults in `WEBTORRENT_PATCHES` (`build.mjs:105`) is the memo's later row L-14.
- Unchanged behaviour, noted: `tools/check-site.mjs:510` skips the lookup only without an `mw-doh` override, while the loader
  (`src/loader/app.js:370`) skips a skip-listed name even with one. This predates IND-10 (it holds for nip.io too) and does not
  send a request the loader would not.

## Requests for files this lane does not own

1. `tools/check-site.mjs:513` to `:515` (owner: whoever holds tools next; the memo lists the file as unchanged). For a platform name
   the reason clause now reads "alice.github.io is not a public DNS name", which is not true of these names. Proposed:
   import `isNoTxtPlatformName` with the other doh.js names (`:38`) and add a middle branch, `: isNoTxtPlatformName(finalUrl.hostname)
   ? finalUrl.hostname + ' is on a hosting platform where no user can publish a TXT record (github.io, netlify.app, pages.dev and
   others)'`. Test: tighten `test/unit/tools-check.test.mjs:855` with `assert.match(dns[0].message, /hosting platform/)`.
2. The release-docs lane, if it adds its own CHANGELOG section for the domain-independence rows: `CHANGELOG.md:568` already has
   "### Changed for domain independence (2026-10-25)" with the three code bullets; add the docs rows under it rather than a
   second heading.
