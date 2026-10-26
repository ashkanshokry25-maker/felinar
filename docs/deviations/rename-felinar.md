# Rename lane: Lightweb to felinar

Lane: rename (workflow brief of 2026-10-24). Worked 05:06 to 05:20 EDT (`TZ=America/Toronto date`).

The owner chose the name "felinar" (tagline "the light web"). "Lightweb" was an interim name for about one day, never
published, and was dropped because of a pending US trademark in class 42. This lane did the same rename that the
CHANGELOG section "Renamed to Lightweb" (`CHANGELOG.md:40` to `:50`) records for magnet-web to Lightweb, in the files
the brief gives this lane. The status lane renames inside the CHANGELOG, README, SECURITY, the user documents, the
recipes, the example READMEs and the two `strings.js` files; the promote lane renames inside ARCHITECTURE, INTERFACES,
the design review, THREAT-MODEL and SECURITY-MODEL.

How: one scripted pass over the files below replaced `@lightweb/` with `@felinar/`, `LIGHTWEB` with `FELINAR`, and
`Lightweb` and `lightweb` with `felinar` (lower case everywhere, as the brief writes the name), with the protected names
of the second table held out; then hand edits for the alias commands, the test regular expressions and the hash of
`verify.js`. The tagline "The light web." is unchanged (`bin/felinar.mjs:43`, `package.json:5`).

## Files changed (98 files, 523 occurrences of "felinar" after the pass)

- Package and command: `package.json` (name `:2`, description `:5`, repository URLs `:20` to `:26`, bin `:30` to
  `:34`), `package-lock.json` and `npm-shrinkwrap.json` (root name `:2` and `:8`, bin `:18` to `:22`),
  `bin/felinar.mjs` (renamed from `bin/lightweb.mjs` with `git mv`; usage and `--version` print `felinar`).
- `packages/verify/package.json` (`@felinar/verify`, `:2`), `packages/verify/README.md`, `packages/verify/verify.js`
  (comment `:1` and the WebCrypto error `:22`). The file's sha256 is now
  `eda60c70d9607fd02b8a4869c00b4c69327149892d1b65a53965622744b42bbf`, written into `packages/verify/README.md:16` and
  `docs/specs/mw-signin-v1.md:192` (`test/unit/signin-verify.test.mjs:214` and `:216` check both).
- `build.mjs`: the app manifest name, short name, description and icon label (`:573`, `:589` to `:591`), the door
  manifest name (`:611`), the door.json name (`:648`), the bundle banner (`:782`) and the build.json name (`:886`).
- `tools/`: `check-site`, `check-webseed`, `demo`, `dev-server`, `door-kit-files`, `init`, `live`, `publish-policy`,
  `publish` (torrent `created by`, TXT record comments, log lines), `seeder.html`, `ship` (`DEFAULT_REMOTE_DIR =
  '/opt/felinar'`, `tools/ship.mjs:56`; repository fallback `:786` to `:788`), `tracker`, `verify-release` (default
  list name `felinar`, `:99` and `:401`), `webseed-file`, `withdraw`.
- `deploy/`: `github-actions/publish-site.yml` (`FELINAR_REPO`, `FELINAR_REF`, `FELINAR_COMMIT`,
  `FELINAR_RELEASE_KEY` at `:67` to `:72`; `felinar/genesis.json` at `:30`, `:154`, `:207`; `$RUNNER_TEMP/felinar`;
  `bin/felinar.mjs`), `one-box/README.md`, `one-box/docker-compose.yml` (project `felinar-one-box` `:16`, `/opt/felinar`
  `:29`, images `felinar-tracker:local` `:39` and `felinar-pin:local` `:107`), `pin/Dockerfile` (`felinar-pin`,
  `/opt/felinar`), `pin/README.md`, `tracker/README.md`, `tracker/docker-compose.yml` (project `felinar-tracker` `:14`).
- `.github/`: `ISSUE_TEMPLATE/bug_report.yml`, `ISSUE_TEMPLATE/site_compat_report.yml`, `workflows/ci.yml` (allowed
  file `bin/felinar.mjs`, image `felinar-pin:ci`), `workflows/pages-demo.yml`, `workflows/release.yml` (release files
  `felinar-<version>-dist.zip`, `-idp.zip`, `.tgz` at `:8` to `:10`, `:153` to `:161`, `:200` to `:201`, `:231`; the
  release title `:235`).
- Landing page: `examples/landing/index.html` (title, og:title, brand, links to `OWNER/felinar`), `app.js`,
  `styles.css`. The identity origin page title: `src/idp/index.html:8` (`<title>felinar identity</title>`).
- Other examples (not the markdown files): `existing-site-dropin/index.html`, `with-own-sw-integrated/index.html` and
  `sw.js`, `with-widgets/index.html`; `peer-guestbook/about.html`, `data/about.json`, `index.html`, `js/app.js`,
  `js/common.js`, `members.html`, `profile.html`; `social/index.html`, `js/data.js`, `js/directory.js`, `js/strings.js`.
- Documents: `CONTRIBUTING.md`, `GOVERNANCE.md`, `LICENSE` ("The felinar authors"), `docs/COMPATIBILITY.md`,
  `docs/CRITIQUE.md`, `docs/CRUD.md`, `docs/DEVIATIONS.md`, `docs/MIGRATION.md`, `docs/ONBOARDING.md`,
  `docs/QUICKSTART.md`, `docs/README.md`, `docs/RUNBOOK.md`, `docs/specs/mw-signin-v1.md`, `docs/assets/architecture.svg`,
  `docs/assets/logo.svg`, `docs/assets/social-preview.svg`. `docs/DEV-NETWORK.md` never named the project.
- Tests: `test/unit/cli-bin.test.mjs` (`PKG.bin` is `{ felinar, lightweb, 'magnet-web' }`, `:86`),
  `repo-layout.test.mjs` and `deploy-one-box.test.mjs` (the command-line scanners accept `felinar`, `lightweb` and
  `magnet-web`, `repo-layout.test.mjs:173`, `deploy-one-box.test.mjs:218`), `tools-install-scripts.test.mjs` (the
  outside-a-clone pattern covers both names `:25`; SECURITY.md must give `./felinar-<version>.tgz` `:40`),
  `tools-ship`, `tools-v03-release`, `tools-v03-init`, `tools-publish`, `tools-publish-v021`, `tools-publish-doors`,
  `tools-check`, `signin-verify`, `signin-browser`, `sw-sdk`, `sw-core`, `dropin-*`, `chain-core-crypto`,
  `test/example/*`, `test/e2e/run.mjs`, `scenarios-v03.mjs`, `v03/signin-lab.*`, `test/fixtures/existing-site-dropin/stage.mjs`.

## Compatibility names kept

| Name | Where | Why |
|---|---|---|
| SDK global `mw`, every `mw-` prefix, the `/_mw/` routes | throughout `src/` | brief; wire and page contract |
| wire extension names (`mw_chat1`, `mw_chain2`, `mw-signin-v1`, ...) | `src/` | brief |
| pointer, block and key formats, golden vectors | `src/common/pointer.js`, `test/vectors/` | brief |
| `~/.config/magnet-web/` | `tools/ship.mjs:76` and the other tools | brief |
| `magnet-web-identity-backup.json` | `src/idp/idp.js:70` | brief |
| `Symbol.for('magnet-web.sdk.facade')` | `src/sdk/sdk.js:55` | brief |
| manifest name `magnet-web-idp` | `tools/build-idp.mjs:162` | brief |
| alias command `magnet-web` | `package.json:32` | brief: kept for one release. The `lightweb` alias was dropped by the orchestrator on 2026-10-24 09:50 ET (nothing was published under it, and it carries the name the project dropped); package.json, both lock files, test/unit/cli-bin.test.mjs and the command regexes in deploy-one-box, repo-layout and tools-install-scripts tests changed with it |
| protocol scheme `web+lightweb:` | `src/common/pointer.js:70`, `build.mjs:621`, `tools/publish.mjs:450` | a link format in `src/`, outside this lane (Requests 1). Renamed later the same run: now `web+felinar:` (section "Request 1 applied") |
| door kinds `lightweb-door`, `lightweb-doors` | `src/loader/doors.js:47`, `build.mjs:648`, `tools/publish.mjs:1686` | machine identifiers that `checkDoorJson` checks (`src/loader/doors.js:249`); see Requests 1. Renamed later the same run: now `felinar-door` and `felinar-doors` (section "Request 1 applied") |
| one-box variables `LW_SITE`, `LW_ACME_CA` | `tools/ship.mjs:21`, `deploy/one-box/docker-compose.yml:4` | configuration keys, not the name a person reads |
| history records | `docs/deviations/*`, `docs/review/*`, `docs/research/**` | they record what happened under the old names; the previous rename left them too |

## Results

- `npm test` (05:10 EDT): 2,266 tests, 2,255 pass, 2 fail, 9 todo; the lint floor is clean. The two failures:
  `test/unit/tools-install-scripts.test.mjs:40` (SECURITY.md still says `./lightweb-<version>.tgz`; passes once the
  status lane renames SECURITY.md) and `test/unit/docs-claims.test.mjs:142` (the R 4.2 table of
  `deviations/integration-v03.md`, another lane's edit in progress; not about the name).
- `npm run test:example` (05:11 EDT): 186 tests, 174 pass, 6 fail, 6 todo. Three wait on the status lane: the example
  pages repeat the loader's sentence `neverWords` verbatim (R 3.9), and `src/loader/strings.js` still says "Lightweb
  never asks..." ("Peer Guestbook v0.3 in a browser" in `browser-v03.test.mjs`, "R 3.9 and the card copy"), and
  `dropin-widgets.test.mjs:354` wants `@felinar/verify` in `examples/existing-site-dropin/README.md`. Three are not
  about the name: the SDK error sentences `E_INTERNAL` and `E_BANNED` ("UX-15", "strings: the error table is the
  SDK's", "every error code the page can show") differ from the examples' copies after an edit in `src/`.
- `npm run check:example`: 2 sites, 7 pages, 0 errors. `node build.mjs --check-lock`: pins match.
- `npm pack --dry-run`: `felinar@0.3.0`, file name `felinar-0.3.0.tgz`, 182 files, `bin/felinar.mjs` 11.4 kB.
- Registry (read-only, about 05:08 EDT): `npm view felinar` and `npm view @felinar/verify` both answered E404.
- `git grep -n -i lightweb` over this lane's files now finds only the kept names of the table above.

## Requests

1. (Closed on 2026-10-24 by the scheme fixer of the extra wave after verifier round 1; see "Request 1 applied" below.)
   Integrator or owner: decide whether the never-published `web+lightweb:` scheme and the door kinds
   `lightweb-door` and `lightweb-doors` become `web+felinar:`, `felinar-door` and `felinar-doors` before 0.3.0. A person
   sees the scheme in the door kit (`tools/publish.mjs:450`). Changing it means `src/common/pointer.js:70`, `:1179` and
   `:1180`, `src/loader/doors.js:47` and `:232`, `src/loader/app.js:4596`, `build.mjs:34`, `:621` and `:648`,
   `tools/publish.mjs:1686`, and the tests `common-pointer`, `loader-doors` and `tools-publish-doors` in one change.
2. Integrator: brand strings in `src/` that no lane of this run owns still say Lightweb: `src/dropin/engine.js` (the
   console lines, `:99` to `:1410`), `src/dropin/ledger.js:135` to `:147`, `src/dropin/mw.js:156`,
   `src/dropin/swreg.js:72` and `:360`, `src/files/preview.js:21` (asserted by `test/unit/media-service.test.mjs:697`),
   `src/idp/passkey.js:26` and `:27` (the passkey's relying-party name), `src/idp/index.html:13` (the noscript line),
   `src/loader/app.js:3818`, `src/sdk/sdk.js:509` and `:534`, `src/sdk/sdk-static.js:20`, `src/sw/core.js:1828`,
   `src/loader/doors.js:232` (the default door name; `build.mjs:648` now writes `felinar`).
3. Status lane: after `src/loader/strings.js` and `src/idp/strings.js` change, the examples already say "felinar never
   asks for your 12 words on the site you are signing in to." (`examples/peer-guestbook/profile.html:91`,
   `examples/social/js/strings.js:115`); `test/unit/idp-cards.test.mjs:249`, `ui-v03-cards.test.mjs:103`,
   `ui-v03-strings.test.mjs:54` and `:55` and `widget-signin.test.mjs:40` and `:181` were left to you because you were
   editing them. SECURITY.md:172 should read `./felinar-<version>.tgz` (the release file name of
   `.github/workflows/release.yml:116`).
4. Status lane: references to `bin/lightweb.mjs` remain in `README.md:106`, `CHANGELOG.md:44` and `:431`,
   `docs/PUBLISH-CHECKLIST.md:234`, `:684`, `:694`, `:695`, `:948`, `:976`; the file is now `bin/felinar.mjs`. The
   checklist's npm-name row (`docs/PUBLISH-CHECKLIST.md:416`) can cite the E404 answers above.
5. Promote lane: `docs/ARCHITECTURE.md:1192` and `docs/INTERFACES.md:1467` name `bin/lightweb.mjs`.
6. Status lane, the CHANGELOG section (`CHANGELOG.md:40` to `:50`), proposed text:

   > ### Renamed to felinar
   >
   > - **The project is now felinar** (tagline: "the light web": sites in plain sight, visible by design, no backend).
   >   It was magnet-web until v0.3, then Lightweb for one day, never published; Lightweb was
   >   dropped because a US trademark application for that name is pending in class 42. The package and the command are
   >   `felinar` (`bin/felinar.mjs`); `lightweb` and `magnet-web` stay as alias commands for one release and are removed
   >   in the next. The server-side sign-in package is `@felinar/verify` (never published under an earlier name). The
   >   documents, the examples, the workflows, the Docker image names, the release file names
   >   (`felinar-<version>-dist.zip`, `-idp.zip`, `.tgz`) and the box directory (`/opt/felinar`) use the new name.
   > - **Unchanged for compatibility:** the SDK global `mw`, every `mw-` prefix, the `/_mw/` routes, the wire extension
   >   names (`mw_chat1`, `mw-signin-v1` and the rest), the pointer, block and key formats, the golden vectors, the
   >   `~/.config/magnet-web/` key directory, the `magnet-web-identity-backup.json` backup file name, the
   >   `Symbol.for('magnet-web.sdk.facade')` key and the `magnet-web-idp` manifest name. Every on-disk and on-wire
   >   format reads and writes as before; only names a person reads changed.

   No dates are given for the Lightweb day: the Lightweb rename landed in the checkpoint of 2026-10-21 02:46 ET
   (`git show eef6113`), and this brief gives the felinar decision without a date.

## Request 2 applied (verifier round 1)

Rename fixer, 2026-10-24, 08:28 to 08:32 EDT (`TZ=America/Toronto date`). Request 2 above was open: no lane owned these
strings. Each `Lightweb` or `lightweb` below became `felinar` (lower case, as in the rest of this note); nothing else in
the line changed. Exact-line edits only; `src/loader/app.js` was edited with one exact-string Edit because the social
fixer edits that file at the same time.

| What | Where (after the edit) |
|---|---|
| Passkey relying-party name and default nickname, now `'felinar identity'` | `src/idp/passkey.js:26`, `:27`; header comment `:4` |
| The risk warning of the file card | `src/files/preview.js:21`; its test `test/unit/media-service.test.mjs:697` |
| The identity page's noscript line | `src/idp/index.html:13` |
| The "needs a newer version" error title | `src/loader/app.js:3862` (was `:3854`; the social fixer's edits moved it) |
| SDK error messages | `src/sdk/sdk.js:509`, `:534`, `:1009`; `src/sdk/sdk-static.js:20` |
| SDK comments | `src/sdk/sdk.js:31`, `:335`, `:1007`; `src/sdk/sdk-static.js:3` |
| The service worker's build-mismatch response body | `src/sw/core.js:1828` |
| Service worker comments | `src/sw/kill-switch.js:2`, `src/sw/lib.js:732` |
| Drop-in console lines (prefix `felinar: `) and one error | `src/dropin/engine.js:99`, `:461`, `:478`, `:482`, `:511`, `:561`, `:571`, `:578`, `:585`, `:690`, `:725`, `:1105`, `:1244`, `:1275`, `:1406` to `:1410`; comment `:732` |
| | `src/dropin/ledger.js:135`, `:136`, `:147`; `src/dropin/mw.js:156`; `src/dropin/swreg.js:72`, `:360` |
| Default door name of `doorJsonFor` (`build.mjs:648` already writes `felinar`) | `src/loader/doors.js:232` |

Existing passkeys keep working. The relying-party `name` is display text that the browser shows in its passkey dialog
and is sent only at `create()` (`src/idp/passkey.js:120`, `rp: { id: rpId, name: RP_NAME }`); `get()` asks by `rpId`
alone (`src/idp/passkey.js:154`), and the `rpId` is the identity origin's host name (`src/idp/passkey.js:38`), which
the rename does not change. A passkey made under "Lightweb identity" keeps that label in the person's password manager
until they rename it there; the nickname is the person's own choice anyway (`src/idp/passkey.js:118`).

No test pinned the drop-in console lines, the SDK messages, the `sw/core` body or the loader title (`git grep` over
`test/` before the edit found only `media-service.test.mjs:697`). `test/example/browser.test.mjs:30` already expected
"felinar" for the examples' own `noHost` sentence.

`git grep -n -i lightweb -- src test` now prints only the compatibility names: the `web+lightweb:` scheme and its
constants and regular expressions (`src/common/pointer.js:46`, `:70`, `:1179`, `:1180`, `:1196`, `:1208`, `:1211`,
`:1247`, `:1257`, `:1281`, `:1292`; the `LIGHTWEB_SCHEME` import and uses and the comments about the scheme in
`src/loader/app.js` and `src/loader/ui.js:511`; the scheme tests in `common-pointer`, `loader-doors` and
`tools-publish-doors`), the door kinds (`src/loader/doors.js:47`, `loader-doors.test.mjs:120`,
`tools-publish-doors.test.mjs:93`) and the alias commands (`cli-bin.test.mjs:86`, `repo-layout.test.mjs:173`,
`deploy-one-box.test.mjs:218`, `tools-install-scripts.test.mjs:25`). Request 1 (the scheme and the door kinds) was
still open at that time; it was closed in the extra wave ("Request 1 applied" below). The built `dist/_mw/loader.js` holds `lightweb` only in the scheme and the `lightweb-door` kind.

Results:

- `npm test` (08:30 EDT): lint floor clean (147 files); 2,281 tests, 2,272 pass, 0 fail, 9 todo. A first run at 08:29
  EDT had 1 fail, `test/unit/tools-build.test.mjs:235` (the third build's id differed from the first): other fixers were
  editing `src/` during that run. `node --test test/unit/tools-build.test.mjs` alone then passed 28 of 28, and the
  second full run passed.
- `npm run build` (08:30 EDT): exit 0, 21 files, build `3329978977d3`.
- `npm run test:browser` was not run (the brief leaves it to the next verifier).

## Request 1 applied

2026-10-24, scheme fixer of the extra wave after verifier round 1. Nothing was published under the Lightweb name, so the
scheme and the door kinds were renamed with no fallback for the old forms: `web+lightweb:` is now `web+felinar:` (the
`web+` prefix stays, because `registerProtocolHandler` requires it), `LIGHTWEB_SCHEME`, `LIGHTWEB_PREFIX_RE` and
`LIGHTWEB_ENCODED_PREFIX_RE` are now `FELINAR_*` (`src/common/pointer.js:70`, `:1179`, `:1180`, with the encoded form
`web%2bfelinar%3a`), and the kinds are `felinar-door` (`src/loader/doors.js:47`, `build.mjs:648`) and `felinar-doors`
(`tools/publish.mjs:1680`). The door manifest's handler is `web+felinar` (`build.mjs:621`). The uses in
`src/loader/app.js` (the import at `:52`, `:88`, `:1133`, `:4631`, `:4641`, `:4663`, `:4744`), `src/loader/ui.js:511`,
`tools/check-site.mjs:28`, the tests `common-pointer`, `loader-doors` and `tools-publish-doors`, and the documents
DEPLOY, FAQ, ARCHITECTURE, INTERFACES, ROADMAP, DEMO-RESULTS and `docs/deviations/doors.md` changed with them;
CHANGELOG.md says the scheme and kinds were renamed with the project. `git grep -n -i lightweb` (outside
`node_modules`, `dist`, `dist-idp`, `.orchestration` and `docs/research`) now prints only history records and the
alias commands; the built `dist/_mw/loader.js` holds no `lightweb`.

- The three unit files (09:39 EDT): 84 tests, 84 pass.
- `npm test` (09:39 EDT): 2,286 tests, 2,277 pass, 0 fail, 9 todo.
- `npm run build` (09:40 EDT): exit 0, build `b33f182a92d1`; `dist/_mw/door.json` has `"kind": "felinar-door"`.
- `node test/e2e/run.mjs --webkit --only DOOR-DOWN,DOOR-HASH,DOOR-GUEST,DOOR-GUEST-W` (09:40 EDT): 4 passed, 0 failed,
  "PASS network policy: every request stayed on 127.0.0.1".
- `node test/e2e/run.mjs --firefox --only F:DOOR-DOWN,F:DOOR-HASH,F:DOOR-GUEST,DOOR-GUEST-F` (09:40 EDT): 4 passed,
  0 failed, "PASS network policy: every request stayed on 127.0.0.1".

## Verifier round 2: the `lightweb` bin alias in the publish checklist

Rename fixer, 2026-10-24, 10:21 to 10:24 EDT (`TZ=America/Toronto date`). Verifier round 2 found
`docs/PUBLISH-CHECKLIST.md:409` saying "The old names `lightweb` and `magnet-web` are only `bin` aliases", while
`package.json:30-33` lists only `felinar` and `magnet-web`. When this fixer started, the line already read "The old name
`magnet-web` is only a `bin` alias (the `lightweb` alias went with the name); do not register the old package names."
(`docs/PUBLISH-CHECKLIST.md:409`); the change is in the checkpoint `5e2c547` (2026-10-24 10:01 ET, `git log -S`), made by
another lane. This fixer did not edit the checklist. It now agrees with `docs/PUBLISH-CHECKLIST.md:17`,
`CHANGELOG.md:54` and `test/unit/cli-bin.test.mjs:86`.

`src/idp/passkey.js:26` and `:27` already hold `'felinar identity'` (section "Request 2 applied" above, with the reason
existing passkeys keep working: the relying-party name is display text and the `rpId` is the origin's host name).
`git grep -n -i lightweb -- src test` prints one line, the alias assertion `test/unit/cli-bin.test.mjs:86`; the scheme
and door kinds were renamed in "Request 1 applied".

- `npm test` (10:22 EDT): exit 0; lint floor clean (147 files); 2,291 tests, 2,282 pass, 0 fail, 9 todo.
- `npm run build` (10:23 EDT): exit 0, 21 files, 2737 KiB, build `a40b9601949c`.
- `npm run test:browser` was not run (left to the next verifier).
