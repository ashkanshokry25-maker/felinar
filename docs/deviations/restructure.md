# restructure: notes and deviations (productionize wave, 2026-10-19)

Agent: `restructure`. Brief: the repository layout of the first public release (the moves), `bin/magnet-web.mjs`,
`package.json`, `.github/workflows/{ci,release,pages-demo}.yml`, `deploy/**`, `.gitignore`, the paths of
`tools/demo.mjs` and `test/e2e` after the moves, and the wiring of `examples/landing/`. This is the resumed run: the
first run of the wave died at 20:42 ET in a DNS outage after it had made the moves, the command and the package
metadata (checkpoints 20:23 and 20:38 ET).

## Result

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    npm test            # lint:floor clean (62 files), 929 unit tests, 0 failures (913 before this run, plus 16 new)
    npm run test:e2e    # 25 of 25 PASS in 128.8 s, network policy PASS
    npm pack --dry-run  # 88 files: bin/, src/, tools/, build.mjs, build.lock.json, test/e2e/browser-args.mjs,
                        # CHANGELOG.md, README.md, LICENSE, package.json

The unit baseline at the start of this run had one failure, `docs-links`, for documents other writers had not written
yet; it passed once they had.

## What this run did

| Item | State |
|---|---|
| Moves (`example-site` to `examples/peer-guestbook`, `test/fixtures/existing-site` to `examples/existing-site-dropin`, the research labs to `docs/research/labs/`, `ng-app` to `docs/research/labs/w2a-01-lab/ng-app`) | done by the first run; checked: no reference to an old path remains (one more in `docs/review/code-review-conformance.md` updated); `docs-links` searches `examples/existing-site-dropin` |
| `bin/magnet-web.mjs` | extended: `demo` now says it needs a checkout before it starts (it imports `build.mjs` and esbuild even with `--no-build`); `help toString` and other inherited names are unknown commands instead of a crash; Ctrl-C and hang-up are not sent twice to a child in an interactive terminal (the terminal already sent them to the whole process group; a second SIGINT ended `tools/pin.mjs` before it closed its browser), SIGTERM is always passed on |
| `test/unit/cli-bin.test.mjs` | new, 8 tests: the twelve commands and their files, argument and exit-code pass-through, the preflights, the signal rule, SIGTERM through the command to a real tracker, the package metadata |
| `test/unit/repo-layout.test.mjs` | new, 8 tests: tracked top-level entries match the release layout and the moves stay done; every workflow (and the site owner's template) has `permissions: {}`, actions pinned to a commit with the version in a comment, checkouts without persisted credentials, no `${{ }}` inside `run:`, no npm code in a job with a write or OIDC token; every `npm run`, file and tool flag the workflows, the deploy files and their READMEs use exists |
| `.github/workflows/ci.yml` | new: `test` (Node 22 and 24), `pack`, `deploy` |
| `.github/workflows/release.yml` | new: `build`, `release` |
| `.github/workflows/pages-demo.yml` | new: `build`, `deploy`, `check` |
| `deploy/tracker/` | new: `docker-compose.yml`, `Caddyfile`, `README.md` |
| `deploy/pin/` | new: `Dockerfile`, `README.md` |
| `deploy/github-actions/publish-site.yml` | new: the site owner's template |
| `.gitignore` | `.env`, `*.tgz`, `release/`, `ci-logs/`, `deploy/tracker/allow/` added; an em dash in a comment removed |
| `examples/landing/` | the marketing writer wrote the page and its README before this run needed to; nothing written there |
| `package.json` | unchanged: the first run's metadata, `bin`, `files` and scripts already matched the brief; checked with `npm pack --dry-run` and an offline install of the packed tarball (`magnet-web --version`, `keygen`, `publish` work; `build` and `demo` print the checkout message) |

Action pins: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `actions/upload-artifact` v7.0.2,
`actions/download-artifact` v8.0.2 and `aws-actions/configure-aws-credentials` v6.3.0 are the SHAs the w2a-06
research resolved through the GitHub API on 2026-10-17 (`docs/research/labs/w2a-06-lab/gh-pins-2026-10-17.txt`).
`actions/upload-pages-artifact` v5.0.0 (`fc324d3...`) and `actions/deploy-pages` v5.0.1 (`368f825...`) were resolved
the same way on 2026-10-19 20:53 ET with that lab's `gh_pin.sh`, and the inputs used were read from each action's
`action.yml` at the pinned commit (raw.githubusercontent.com, read-only).

## Deviations from the brief

1. **pages-demo publishes the homepage only, in shell mode, not "peer-guestbook and landing, hub mode".** A GitHub
   Pages site is one origin and a shell serves one site per origin. The shared-origin hub renders sites under
   `/_mw/s/<btih>/` and does not support root-relative URLs (ARCHITECTURE 3.3); both examples use them (the guestbook
   on purpose: E2E scenario 1 checks `/css/app.css` and `fetch('/data/about.json')`; the landing page by its brief), so
   in the hub both would load unstyled and without their scripts. And under an unsigned pointer the guestbook's
   ledger is unmoderated ("nobody can remove posts for everyone"), which an official public demo should not be.
   So the workflow builds the loader, publishes `examples/landing` with a throwaway key (publish always signs; the
   signed pointer is discarded) and stamps an unsigned record, in the form E2E scenario 6 renders, into the shell's
   `index.html` and `404.html`; the web seed is `/ws/<12-character commit>/` on the same origin. Checked locally:
   the assembled tree on a plain static server (http-server, `404.html` fallback, Range) passes
   `check-webseed`, and local-only Chromium renders the homepage in shell mode from the page tag in 140 ms
   (`signed: false`, ledger `btih:<hex>`, the unmoderated banner, no WebSocket before consent, no request off
   127.0.0.1), and a deep link mounts the shell. The guestbook is still published by CI (`pack`).
2. **CI installs WebKit as well as Chromium**: E2E scenario 14 asserts that Playwright WebKit is installed, and the
   browser unit tests use it. CI also runs `npm run test:browser`, `npm run test:example` and, on Node 24, W7.
3. **CI has two more jobs.** `pack` is DIGEST-AMENDMENTS E4's CI job (each example published with `--double-pack`
   and again from a copy at another path; same infohash and the same `.torrent` bytes; run locally for all three
   examples). `deploy` builds the tracker image, starts it behind Caddy on `localhost` (Caddy's internal CA) and
   probes announces, the allow list and its reload through Caddy, validates the Caddyfile, builds the pin image and
   runs it against `npm run demo`.
4. **release.yml also attaches the npm package** (`magnet-web-<version>.tgz`), so the `magnet-web` command installs
   from the release without npm publishing; `SHA256SUMS` covers both files. The release is a pre-release below 1.0.0,
   its notes are the changelog section with relative links pointed at the tagged tree, and the workflow refuses a tag
   that differs from `package.json` or whose version has no `## [<version>]` heading. It creates the release with the
   `gh` CLI in a job that runs no repository code (`contents: write`), not with a third-party action.
5. **deploy/tracker defines the tracker image inline** (`dockerfile_inline`, Compose 2.17 or newer) to stay within
   the layout's three files, and mounts the allow file's directory, not the file (an atomic rename over a
   bind-mounted single file is invisible inside the container). The Caddyfile adds `stream_timeout 24h` to the
   research reference that passed `caddy validate` (tools/tracker.mjs has no idle close); CI validates the result.
6. **The site owner's template** (`publish-site.yml`) separates the loader build, the site build, signing (`mw-sign`
   environment), upload (`mw-deploy`) and DNS (`mw-dns`), uploads the web seed under an immutable per-release prefix
   (the same URL for a new version would serve new bytes to visitors still on the old one), reuses the committed
   `genesis.json` (`--genesis`) so the ledger keeps its root, and writes Route 53 with a compare-and-swap batch
   (the exact live record set) and Cloudflare with a seq check. No npm code runs in a job that can assume a role
   (check-webseed needs no packages).
7. **`test/vectors/` stays.** The layout lists `test/{unit,e2e,fixtures}`; the golden vectors are named by path in
   ARCHITECTURE, CONTRIBUTING, the CHANGELOG and the checklist, and `test/fixtures/` had nothing left after its only
   content became `examples/existing-site-dropin/`.

## Not verified

- No workflow has run on GitHub (`gh` is not authenticated; nothing is pushed). Their YAML parses (Ruby Psych), the
  w2a-06 research lint passes except one false positive (`actions/deploy-pages` needs `id-token: write`), the shell
  steps of `pack`, the Pages assembly and the release notes ran locally, and the CI probe script ran over TLS against
  a local tracker. The first push is the first real run; expect to fix details such as runner image packages.
- Node 22: only Node 24.22 is installed here. A scan found no API newer than Node 22 in `tools/` and the tests.
- No Docker image was built here (that would pull from Docker Hub). `docker compose config` validates the Compose
  file offline; the tracker image's file set (production dependencies, `src/`, `tools/`) and the pin image's file set
  (all dependencies, `src/`, `tools/`, `test/e2e/browser-args.mjs`) were reproduced in directories and run: the
  tracker answered an allowed announce, and the pin kept the local demo open for 35 s (consent given, render ok,
  status every 5 s, snapshot written) and exited on SIGTERM. The image tags `node:24-bookworm-slim` and `caddy:2.11`
  are assumed to exist.
- Caddy with a real ACME certificate, HTTP/3, and either image on a real server.
- Signal handling of the command in an interactive terminal (unit-tested as a decision function only).

## For other owners

- `docs/PUBLISH-CHECKLIST.md`: release.yml now rewrites relative links in the notes to the tagged tree, so the manual
  link step is only needed for a release made by hand; the dist zip holds `dist/` (unzip, then `publish --dist dist`).
- `CHANGELOG.md`: "Added" could list the CI, release and Pages workflows, `deploy/` and the publish template; "Known
  gaps" says the command runs only from a clone, but the release's `.tgz` now installs it (`build` and `demo` still
  need a clone).
- `examples/landing/README.md`: could say that `.github/workflows/pages-demo.yml` publishes the page to GitHub Pages
  in shell mode with an unsigned page tag.
- `.github/dependabot.yml` updates the action pins; adding the `docker` ecosystem for `deploy/pin` would update its
  base image too (the inline tracker image is not covered).
- If the editor moves `examples/peer-guestbook/.dev/`, `package.json` (`test:example`, `check:example`) and the
  CI step "Example site checks" must follow.
