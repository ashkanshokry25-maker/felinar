# marketing: notes and deviations (productionize wave, 2026-10-19)

Agent: `marketing`. Owned: `README.md`, `docs/WHY.md`, `examples/landing/{index.html,styles.css,app.js,README.md}`
and `docs/assets/{logo.svg,architecture.svg,social-preview.svg}`. This file is the only other file written.

## Where this run started

The first run of the wave died at 20:42 ET. Its checkpoints held full drafts of `README.md`, `docs/WHY.md` and the
three SVG files; `examples/landing/` was an empty folder. Nothing was started over: every statement in the drafts was
checked against the code, the tools' `--help` output, `docs/INTEGRATION-STATUS.md` and the digests, then corrected
and extended in place. The baseline `npm test` had one failure, the `docs-links` test, caused by documents other
writers of the wave own (CRITIQUE, CRUD, SDK, FAQ and so on); none of it was in an owned file's control.

## What changed, by file

| File | Change |
|---|---|
| `README.md` | Six "Why" reasons with their conditions (no S3 website endpoint as a host, reactions and polls described as built on lists, a key counts a device); the DESIGN-REVIEW 4.1 and 4.3 sentences that were missing from "What it is not" (no anonymity; phones share only after the visitor turns it on); the tour says where `npx magnet-web` works and that both demo windows must choose "Share and load"; "How it works" now has the same six steps as the diagram; the CRUD sample shows create, read, update and delete with SDK.md's names and the `--cs` condition for a first writer; the comparison row says new visitors need the host for the loader; "Only WebRTC peers share" names the Node seeder too; the 13.3x egress figure is called a worked example, not a measurement; the roadmap teaser follows ROADMAP.md's tiers; status numbers are dated |
| `docs/WHY.md` | The drop-in egress formula with its source (w2a-07 F21); the like-size figure for polls and reactions (w2a-03, measured on the v0.2 block format) and "a key is a device"; event pages without recordings in the torrent; same infohash only under the same name; STUN in every "before the visitor's choice" list; no unmeasured "ten minutes"; test counts by reference instead of a number that this wave already changed |
| `docs/assets/architecture.svg` | Redrawn: six numbered steps (loader, pointer, pieces, copy, serve, ledger) instead of two step 3s and an unnumbered serve step; the site ledger as its own component inside the loader; the DNS arrow unnumbered (a first visit with a page tag never asks DNS); one self-contained card with light and dark colours |
| `docs/assets/social-preview.svg` | A comment on exporting it: GitHub's social preview setting takes PNG, JPG or GIF, not SVG |
| `docs/assets/logo.svg` | Checked, unchanged |
| `examples/landing/*` | New: the homepage (hero, why with conditions, how it works, shared data, what it is not, get started), its stylesheet and the live box "How this page reached you", plus a README with the publish commands for both modes |

## How the claims were checked

- Every command in the README tour, the migration section and the landing README was run in a scratch directory with
  a scratch key: `keygen`, `build --out`, `publish` (shell, and drop-in with `--inject-script`), the injected tag's exact
  text, and `npx --offline magnet-web --version` in the clone (it resolves the clone's own `bin/magnet-web.mjs`
  without the registry).
- Gzip sizes of `loader.js` (116,768 B), `webtorrent.min.js` (64,297 B) and `mw.js` (104,880 B) were measured on a fresh
  build; the calculator output quoted in WHY.md was reproduced.
- Defaults read from the code: trackers and STUN (`src/loader/config.js`), size caps (128, 48 and 24 MiB), the ledger
  policy defaults (owner writers, 16 bits, 2,048-byte values, 8 MiB), 20 writes a minute (`bridge.writesPerMinute`),
  the 90-day pointer default (`publish --help`), consent before the STUN probe (`startProbe`), and the consent strings.
- The landing page ran through the whole system on loopback, in local-only Chromium: shell mode through
  `tools/demo.mjs` `runDemo` with two visitors (0 peers and the consent prompt before the choice; 1, then 2 peers
  after "Share and load"), and drop-in mode with `publish --dropin --inject-script`, a local tracker and the fixture
  host (first view from the host, second view "HTML from the host, other files from the copy on this device"). No
  console errors and no request left 127.0.0.1 or localhost. Served by a plain static server it shows the plain-copy
  message. `node tools/lint-floor.mjs examples/landing` is clean, and the CI job that packs every example twice and
  from a second path (`.github/workflows/ci.yml`) was reproduced for the landing page: one infohash, identical
  `.torrent` bytes, `--double-pack` passes.

## Deviations from the brief

1. **Six reasons, not five.** The brief asks for "5 crisp reasons" and then lists six (cost, shared data, domain and
   key, drop-in, outages, privacy). All six are kept, each with its condition.
2. **"Backend-free CRUD in 20 lines"** counts code lines: the sample has 19 lines of code plus comments and three lines
   of HTML. Update, read-back and delete of a key are shown as one-line comments, so the sample never writes on every
   page load.
3. **The landing page links to GitHub with the `OWNER` placeholder**, like `package.json`. Its README gives the one-line
   replacement.
4. **The landing page recommends drop-in mode for itself**, because a homepage must be visible to crawlers and link
   previews (MIGRATION-DIGEST verdict 2). Shell mode is documented beside it and was tested too.

## Open issues for other owners

1. **`progress.uploaded` is not zero before any peer connection.** On loopback the loader's connect-time `progress`
   push reported 178 B "uploaded" in shell and drop-in mode before the visitor chose to share (no tracker or peer
   connection existed yet), 165 B with only a complete seeder connected, and 421 to 651 B after a second visitor joined
   whose copy was already complete. It looks like traffic that is not file pieces (web-seed replies or metadata) is
   counted. The landing box shows "Passed on to others" only after the visitor chose to share; the guestbook example
   shows the figure unconditionally. Worth a look by the loader owners before anything calls it "uploads".
2. **The npm name.** `KayleePop/magnet-web` exists (MIT, same idea, R04 F3). Inside the clone `npx magnet-web` runs the
   clone's own bin, checked offline; outside it, npm would look the name up in the registry. Whether `magnet-web` is
   taken on npm was not checked (no network use from this agent); the release owner should check before publishing,
   and the README tells readers to run the command only from the clone's root.
3. **Social preview.** Upload a PNG export of `docs/assets/social-preview.svg` in the repository settings at release.
4. **"Measured" 13.3x.** The egress note `publish --dropin` prints calls 13.3x "the measured example", and
   DIGEST-AMENDMENTS E5 says the same, but its source (w2a-07 F21) labels the multiplier a model: arithmetic for a
   20 MB copy after a 1.5 MB page view with no peer help. README and WHY.md call it a worked example; the tools owner
   may want to reword the note.
5. **`docs-links` was still red at the end of this run** (920 of 921 unit tests pass) because `docs/CRITIQUE.md` and
   `VERIFY.md` (named by CONTRIBUTING) did not exist yet; the host recipes it also missed earlier had landed. The README
   and WHY.md link to `docs/CRITIQUE.md` as the target layout requires. The wording-rules test passes.
