# Contributing to felinar

Thanks for helping. felinar moves website files and shared data between visitors' browsers, so being correct
and being honest about what it does matter more than being fast. This page covers how to set up, what the tests
expect, the coding and wording rules, how pull requests and issues are handled, and how a release is made.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Vulnerabilities go through
[SECURITY.md](SECURITY.md), never through a public issue. How decisions are made is in
[GOVERNANCE.md](GOVERNANCE.md). The documentation index is [docs/README.md](docs/README.md).

## Ways to help

- Report a bug, or a site that doesn't migrate cleanly, with the issue forms. Questions and ideas go to Discussions;
  issues are for bugs, feature requests and compatibility reports.
- Run the release gate on a real device and send the result. Every row of [docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md)
  says "not yet run", so a result from a real phone, from Firefox or from Safari is the most useful contribution.
  Open a pull request that fills in the row, or an issue with the details.
- Fix or extend the docs, write a [recipe](#adding-a-recipe) or a [research note](#adding-a-research-note).
- Pick up an item from [docs/ROADMAP.md](docs/ROADMAP.md); its section "Where help is most useful" lists well-defined
  ones. Items labelled `good first issue` are small, have a clear test and don't change a format or the spec.

For anything bigger than a bug fix, open an issue (or a discussion) first, so we agree on the shape before you
write code. A change to the specification, a frozen format or the security model needs an RFC (see
[GOVERNANCE.md](GOVERNANCE.md)).

## Where things live

| Path | What it holds |
|---|---|
| `src/common`, `src/chain` | Shared code: pointers, torrent files, the site ledger. Runs unchanged in Node and in browsers. |
| `src/loader` | The shell loader: boot, pointer resolution, torrents, policy, consent, rendering, UI. |
| `src/dropin` | The drop-in runtime (`/_mw/mw.js`). |
| `src/sw` | The Service Worker and the kill switch. |
| `src/sdk` | The SDK a site imports (`mw.db` and friends). |
| `tools`, `bin`, `build.mjs` | The command-line tools, the `felinar` command that starts them, and the build. `build.lock.json` pins the vendored WebTorrent bundle. |
| `test/unit`, `test/e2e`, `test/example`, `test/fixtures`, `test/vectors` | Unit tests, end-to-end scenarios, the example guestbook's checks, the helpers that stage and host the drop-in example, golden vectors. |
| `deploy`, `.github/workflows` | Templates for a tracker, a pin node and publishing from CI; the workflows of this repository. |
| `examples` | `peer-guestbook` (shell mode), `existing-site-dropin` (drop-in mode, and the end-to-end fixture) and `landing` (the project homepage, a site to publish with felinar itself). Each holds only the site: its checks live under `test/`. |
| `docs` | Documentation. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/INTERFACES.md](docs/INTERFACES.md) are the specification. |

## Development setup

You need Node 22 or newer (`engines` says `>=22`), npm and git. `.nvmrc` names 24, the version the project is
developed on; CI runs the suites on Node 22 and on 24. Unit tests need no browser.

```sh
git clone https://github.com/ashkanshokry25-maker/felinar.git
cd felinar
npm ci
npm test
```

`npm ci` reports "4 high severity vulnerabilities": one advisory in the `ip` package that nothing here calls. Don't run
`npm audit fix --force`; [QUICKSTART.md](docs/QUICKSTART.md#step-0-get-the-tools) explains why.

`.npmrc` sets `ignore-scripts=true`, so no dependency runs an install script and Playwright does not download its
browsers for you. Install them when you need the browser or end-to-end tests:

```sh
npx playwright install chromium webkit
```

Build the loader into `dist/`, or try the whole thing on your machine (it builds, publishes the example guestbook for
localhost, starts a tracker and a dev server, seeds from a headless browser and prints a URL):

```sh
npm run build
npm run demo
```

[docs/RUNBOOK.md](docs/RUNBOOK.md) has the rest, including how to open the demo on a phone.

Each tool runs as `node tools/<name>.mjs` or through the `felinar` command, which starts the same file with your
arguments unchanged:

```sh
node bin/felinar.mjs --help
node bin/felinar.mjs publish --help
```

Every tool prints its usage with `--help`. The flag lists in the docs come from there, so don't document a flag that
isn't in the help.

## Scripts

| Script | What it does |
|---|---|
| `npm test` | The browser-floor lint, then every unit test that doesn't launch a browser |
| `npm run lint:floor` | Only the lint of `src/` for APIs past the browser floor |
| `npm run test:browser` | The `*-browser` unit tests in Chromium and WebKit |
| `npm run test:example` | The example guestbook's own checks (`npm run check:example` runs only its HTML check) |
| `npm run test:e2e` | The end-to-end scenarios of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 12 |
| `npm run test:e2e:webkit` | The same, plus scenario W7 (a cold start in WebKit) |
| `npm run build` | `node build.mjs`: bundles the loader, the worker and the SDK into `dist/` |
| `npm run demo` | A local demo with a tracker, a dev server and a seeder |
| `npm run keygen`, `ledger`, `publish:site`, `tracker`, `dev`, `pin`, `seed`, `snapshot`, `check:site`, `check:webseed` | The matching tool in `tools/`. Pass its arguments after `--`, for example `npm run publish:site -- --help` |

## How the tests are organised

| Layer | Command | Where | Covers |
|---|---|---|---|
| Unit | `npm test` | `test/unit/*.test.mjs` | Logic in Node, no browser, no network. The docs tests (links and wording) run here too. |
| Browser unit | `npm run test:browser` | `test/unit/*-browser*.test.mjs` | Code that needs a real browser API, in Chromium with the local-only flags and in WebKit on 127.0.0.1 |
| Example site | `npm run test:example` | `test/example/` | The example guestbook's markup, its scripts and a browser run |
| End to end | `npm run test:e2e` | `test/e2e/` | Several visitors, a tracker, a dev server and a web seed together (about two minutes) |
| Release gate | by hand | [docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md) | Real phones and desktop browsers. Not run yet. |

The four automated layers all passed at the last full verification; the counts are in
[docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md) and in the [changelog](CHANGELOG.md). A skipped test says why
it is skipped. CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request: `npm test`, the
build and its lock check, the browser unit tests, the example's checks and the end-to-end run on Node 22 and 24, a job
that publishes each example twice and compares the infohashes, and a job that builds and runs the files in `deploy/`.

Rules of thumb:

- Test the lowest layer that can show the behaviour. Pure logic belongs in a unit test; anything that needs a
  browser API belongs in a `*-browser` file; behaviour between visitors belongs in an end-to-end scenario.
- A bug fix comes with a regression test that fails without the fix. Say so in the pull request.
- Unit file names start with the area they test: `chain-core-`, `chain-net-`, `common-`, `dropin-`, `formats-`,
  `loader-app-`, `loader-common-`, `sw-`, `tools-`, `docs-`. A file whose name contains `-browser` launches a browser and
  runs only under `npm run test:browser`.
- Don't add a wall-clock assertion that fails on a slow machine. The end-to-end run reports its timing targets as
  met or missed and fails only on generous bounds.
- Golden vectors in `test/vectors/` are append-only. To add one, give it a new id, append it to the vector file,
  append the `{ file, id, sha256 }` line that `test/unit/formats-vectors.test.mjs` prints to `test/vectors/LOCK.json`,
  and never edit or remove an existing entry. A release then freezes the chain head over the entries it contains
  (`FROZEN` in the same test; the command is in [docs/PUBLISH-CHECKLIST.md](docs/PUBLISH-CHECKLIST.md) section 8). A
  change that would break a vector needs an RFC and a new format version.

Run one file, or a few, with the runner (`--list` prints the files it would run). `node --test <directory>` doesn't
work on Node 24, which is why the runner builds an explicit list. The end-to-end runner takes `--only <ids>`, `--keep`
(leave keys and publish output in `.tools/e2e/`), `--headed` (local debugging only) and `--webkit` (adds scenario W7,
as `npm run test:e2e:webkit` does). Scenarios 2 to 6 build on the visitors that 1 and 2 leave open, so run them
together with their predecessors.

```sh
node tools/run-unit.mjs sw-core.test.mjs
node test/e2e/run.mjs --only 7,1
```

### The local-only network policy

Every test, and every browser the repository launches, stays on 127.0.0.1 ([docs/DEV-NETWORK.md](docs/DEV-NETWORK.md)).
The reasons are determinism without the internet, and not setting off an alert in your firewall for every remote
connection a test browser makes.

- Every Playwright Chromium launch uses `chromiumArgs()` from `test/e2e/browser-args.mjs`. It makes every hostname
  except localhost unresolvable.
- WebKit and Firefox have no such switch. Launch them only for pages on `http://127.0.0.1:<port>`.
- A test for an unreachable host uses a local listener that refuses or hangs, never a reserved internet address.
- Probes of public trackers, DNS-over-HTTPS resolvers or web seeds run in Node, never in a browser, and only from
  `tools/check-site.mjs` and `tools/check-webseed.mjs`, which print what they will contact before they connect.
  `tools/pin.mjs`, `tools/check-site.mjs --headless` and `tools/snapshot.mjs <url> --remote` also drive Chromium, and
  that browser loses the local-only flags only for a page that isn't on loopback (`allowRemoteFor` in
  `tools/live.mjs`). No test runs any of them against a real host.

## Coding rules

- **Browser floor.** Safari and iOS 15.4, Chromium 110, Firefox 115. Don't use an API or syntax past it
  (`Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`, the new `Set` methods, `URL.parse`,
  `AbortSignal.any`, iterator helpers, the regex `v` flag and others). `npm test` runs `tools/lint-floor.mjs` over
  `src/` and `build.mjs` runs it over the vendored bundle. A line that carries `lint-floor-ignore`, or
  follows one that carries `lint-floor-ignore-next`, is skipped; use that only where the code guards the use at run
  time, and keep the guard visible.
- **Shared code runs everywhere.** `src/common` and `src/chain` run unchanged in Node and in browsers. Use
  `globalThis.crypto.subtle`, `TextEncoder` and `Uint8Array`. No `Buffer`, no `node:` imports.
- **Plain JavaScript.** ES modules, no TypeScript, no framework. esbuild only bundles.
- **IndexedDB.** Build every value before you open a readwrite transaction, and never `await` inside one.
- **No new dependency without a discussion.** Every dependency is attack surface for the visitors of every site
  that uses the loader. Open an issue first and say what it replaces, its size and licence, whether it has install
  scripts and whether it runs at the browser floor. Dependency install scripts never run here (`.npmrc`), and the
  vendored `webtorrent.min.js` is pinned by hash in `build.lock.json`; the build fails if it changes or if a patch
  point moves. After you have reviewed a WebTorrent upgrade, `node build.mjs --update-lock` rewrites the pins.
  Dependabot opens the weekly update pull requests; review them like any other change.
- **Consent first, no third parties.** The loader has no analytics and no third-party scripts, and the visitor's choice
  comes before the first tracker, peer connection and DNS-over-HTTPS lookup
  ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 8). Keep it that way ([docs/PRIVACY.md](docs/PRIVACY.md)).
- **Keys and consent stay in loader-owned UI.** The owner key never enters a browser. A site's script can't export
  the visitor's identity or accept consent for them; `window.mw` has no call for either.
- **Follow the spec, and say when you don't.** Comments cite the rule they implement (for example
  "ARCHITECTURE section 7.1"). If the code and the specification disagree, fix the wrong one in the same pull
  request. If you have to differ on purpose, write the reason into a short file under `docs/deviations/` and link
  it from the pull request; maintainers fold it into [docs/DEVIATIONS.md](docs/DEVIATIONS.md).
- **Style.** [.editorconfig](.editorconfig) sets two-space indents, LF line endings and a final newline.

## Wording rules for text people read

These apply to UI strings (`src/loader/strings.js`), tool output, the README and every page under `docs/`.
The reasons are in section 4 of [docs/review/DESIGN-REVIEW.md](docs/review/DESIGN-REVIEW.md), which also holds the
approved strings; use them verbatim.

| Say | Never say |
|---|---|
| "No backend": no application server or database for you to run. You still need an HTTPS static host. | `serverless`, "no servers" |
| "Site ledger: a signed, hash-linked log that every visitor copies and verifies. No mining, no consensus, no finality." | `blockchain`, except once, as an analogy, in the README paragraph "Why not a blockchain?" |
| That the sites on a hub with one shared browser origin can reach each other's data | That such a hub keeps its sites apart (never an isolation claim) |
| What the system does, with its condition ("stays up when nobody is online" needs `ws=` and `xs=`) | `censorship-resistant`, `unstoppable`, `fully decentralized`, `sub-second` |

Writing style for docs: plain, concrete and honest; short paragraphs; headings in sentence case; a code block for
every command; relative links between docs; no em dashes or en dashes; straight quotes; contractions are fine.
Marketing is welcome, but every benefit comes with its condition. Give a number only if it was measured or comes
from a cited source, and cite the file or digest. The `docs-links` test in `npm test` checks that the `.md` files
named by the documents, the tools and the templates exist, the banned words in `README.md` and `docs/*.md`, and dashes
and curly quotes in a short list of documents. Review and the greps in
[docs/PUBLISH-CHECKLIST.md](docs/PUBLISH-CHECKLIST.md) cover the rest.

## Commits and pull requests

- Branch from `main`. One logical change per pull request, small enough to review in one sitting.
- Commit subjects are imperative and at most 72 characters, optionally prefixed with the area: `loader:`, `sw:`,
  `ledger:`, `dropin:`, `sdk:`, `tools:`, `build:`, `docs:`, `test:` or `ci:`. The body says why, and
  `Fixes #123` links the issue.
- Fill in the pull request template. Its checklist is the contract: `npm test` and `npm run test:e2e` pass locally, no
  test browser reaches the internet, the browser floor holds, shared code still runs in Node and browsers, strings
  follow the wording rules, docs and `CHANGELOG.md` are updated, and any new dependency is explained.
- Add a line to `CHANGELOG.md` under the unreleased heading for anything a user or an operator can see. Update the
  docs in the same pull request when behaviour or a CLI flag changes.
- A maintainer reviews and merges. CI must be green. Changes to the specification, a frozen format or the security
  model are merged only after the RFC that proposed them was accepted ([GOVERNANCE.md](GOVERNANCE.md)). Pull requests
  are squash-merged unless the history is worth keeping.
- There is no contributor licence agreement and no sign-off line. By opening a pull request you agree that your work
  is licensed under the repository's MIT licence.

Reviewers look for:

- A test that fails without the change, at the lowest layer that can show the behaviour.
- The rule the code implements, cited in a comment, and the specification changed in the same pull request when the
  rule changed.
- A change to what a reader of a frozen format accepts or rejects, to a `window.mw` call, to a consent or privacy
  default, or to a claim in the security model. That is an RFC, not a pull request.
- No new dependency, no network request before consent, no API past the browser floor, and no `Buffer` or `node:`
  import in shared code.
- Text that follows the wording rules, with each benefit next to its condition.

## Issue triage and labels

Maintainers go through new issues in this order:

1. A vulnerability? Move it to a private security advisory, remove the public text and point to
   [SECURITY.md](SECURITY.md).
2. Can it be reproduced? If not, ask for the pointer or magnet, the browsers on both sides and the loader's debug
   export, and add `needs-repro`.
3. Is it documented behaviour? Many reports restate a documented limit (visitors' IP addresses are visible, the
   ledger has no finality, the host is the trust root). Close with a link to [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
4. Label the component and the mode, and link the roadmap tier.

| Label | Meaning |
|---|---|
| `bug`, `enhancement`, `compatibility` | Set by the issue forms: behaves differently from the docs, a request, a site or host that doesn't migrate |
| `documentation` | A documentation fix or gap |
| `rfc` | A proposal to change the specification, a frozen format or the security model ([GOVERNANCE.md](GOVERNANCE.md)) |
| `needs-repro`, `question` | Waiting for steps, a pointer or a browser version; or an answer rather than a change |
| `needs-device` | Needs a real phone or a browser the test setup can't launch (iOS, Firefox) |
| `release-gate` | A failure from the manual gate in [docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md); blocks 1.0 |
| `upstream` | Caused by WebTorrent, bittorrent-tracker or a browser; link the upstream issue |
| `roadmap: next`, `roadmap: 1.0`, `roadmap: later` | The tier in [docs/ROADMAP.md](docs/ROADMAP.md) |
| `good first issue`, `help wanted` | Small and well defined; or maintainers can't get to it soon |
| `wontfix` | Declined, with the reason in the thread (see "Not planned" in the roadmap) |

No response time is promised for ordinary issues. Security reports follow the times in [SECURITY.md](SECURITY.md).

## Adding a recipe

A recipe is one page in `docs/recipes/` that takes one host, one CI system or one kind of site from nothing to a
checked deployment. Copy an existing recipe as the template, and include:

- What it covers and which mode it is for (shell or drop-in).
- What you need: accounts, tools and versions.
- Numbered steps with every command in a code block.
- The check: the `check-webseed` or `check-site` command, and what a pass looks like.
- Limits and known problems.
- "Tested on <date> with <versions>". For prices and quotas, give the date and a link to the vendor's page.

Use `example.com` for domains and never put a real key or token in a recipe. Run every command before you submit,
and say which steps you couldn't test. Add the recipe to the index, [docs/recipes/README.md](docs/recipes/README.md),
and link it from [docs/MIGRATION.md](docs/MIGRATION.md) or [docs/DEPLOY.md](docs/DEPLOY.md) where it fits.

## Adding a research note

Research lives in `docs/research/` and is not normative: the specification and its amendments are. Start from the
index, `docs/research/README.md`, which also lists the five topics never researched. Name the file by wave, number and
topic like the existing ones (`w2c-07-incentives-economics.md`); the file of a second-pass check adds `-VERIFY` to
the name of the note it checks. A note has:

- The question, and why it matters to a decision.
- The method, with the commands, versions and dates.
- The evidence, in a folder under `docs/research/labs/` named after the note, so a reader can re-run it.
- Findings with ids (F1, F2 and so on), so that digests and the roadmap can cite them.
- Recommendations, each with an effort and a priority (P0 to P3).
- What you could not verify, and open questions. Mark a claim verified only when a second source or a second run
  agrees; say nuanced or refuted when it doesn't.

Add a row to the index with a status: verified, researched or missing. Network probes follow the local-only policy
above: they run in Node and print their targets first. A research note never changes the specification. If it
should, open an RFC that cites it.

## Release process

Only maintainers release. The first public release has its own, longer list in
[docs/PUBLISH-CHECKLIST.md](docs/PUBLISH-CHECKLIST.md) (secrets, placeholders, wording greps, squashing the checkpoint
commits). Later releases follow these steps.

1. Make sure `main` is green and run the release gate rows that apply ([docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md)).
   A release is not called production-ready until every row passes.
2. Set the version. It lives in `package.json` and the root entry of `package-lock.json` (the first command below
   changes both), in `CONFIG.version` in `src/loader/config.js`, in `SDK_VERSION` in `src/sdk/sdk.js` and in
   `TOOLS_VERSION` in `tools/lib.mjs`. `test/unit/v021-integration.test.mjs` checks that `package.json` and the three
   constants agree and pins the number, so update the test too. It doesn't read the lock file.
3. If golden vectors were added since the last release, freeze them: append the chain head to `FROZEN` in
   `test/unit/formats-vectors.test.mjs` (the command is in the checklist, section 8). Never edit an existing entry.
4. In `CHANGELOG.md`, rename the unreleased heading to `## [<x.y.z>] - <date>`, refresh the test counts, point the
   `[Unreleased]` link at `compare/v<x.y.z>...HEAD`, add a `[<x.y.z>]` link to the release, and start a new
   `## [Unreleased]` section above it.
5. Run `npm test`, `npm run build`, then `npm run test:browser` (one browser test needs the build), `npm run test:e2e`
   (and `npm run test:e2e:webkit` when rendering or the Service Worker changed), `node build.mjs --check-lock` and the
   pack dry run from the checklist.
6. Tag the tested commit and push the tag. The tag starts `.github/workflows/release.yml`. It refuses a tag that isn't
   `v` plus the version in `package.json`, or a version with no `## [<x.y.z>] - <date>` heading in the changelog. Then
   it runs `npm test`, the fuzzers and the end-to-end suite, builds the loader and the identity page, attests the files
   and leaves a draft GitHub Release with the changelog section as the notes and six files: the two zips, the npm
   package, the two per-file hash lists and `SHA256SUMS`.
7. Download the draft's files, check `SHA256SUMS` and the attestation, sign the two hash lists offline with the release
   key, upload the signatures, verify them, and only then publish the draft (a version below 1.0 as a pre-release):
   the commands are in [docs/PUBLISH-CHECKLIST.md](docs/PUBLISH-CHECKLIST.md), section 14.
8. Run the kill switch drill from [docs/RUNBOOK.md](docs/RUNBOOK.md) section 11 on a staging host and write the
   measured times into `docs/DEMO-RESULTS.md`.

```sh
npm version <x.y.z> --no-git-tag-version
git tag -a v<x.y.z> -m "felinar <x.y.z>"
git push origin v<x.y.z>
```

Only the latest minor release line gets fixes ([SECURITY.md](SECURITY.md)). A fix to the loader or the Service
Worker reaches visitors only when site owners redeploy, so a security release says exactly which files to replace.
