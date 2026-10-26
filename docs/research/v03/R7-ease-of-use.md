# R7: Ease of use, owner and visitor journeys, and a login for people who have never heard of keys

- **Track:** v0.3 research, topic ease-of-use (R7)
- **Written:** 2026-10-20
- **Subject:** magnet-web 0.2.1 at $HOME/Documents/Projects/magnet-web
- **Method:** read QUICKSTART, ONBOARDING, MIGRATION, `bin/magnet-web.mjs`, `tools/publish.mjs --help`, `deploy/github-actions/publish-site.yml`, the two examples, `src/loader/strings.js`, and the identity research (w2c-03 and its VERIFY). Ran `keygen` and `publish` against a one-file site in the scratchpad to see the real messages. Looked up Netlify, Vercel, GitHub Pages, Bluesky and Nostr onboarding on 2026-10-20. No browser was launched.
- **Not done:** no usability test with a real person was run. Every step count below is a count of documented steps, not a measured time. Timings are stated as unmeasured.

## 1. Summary

1. **The owner path has four different front doors and none of them is one command.** Track A (new site, shell mode) is a documented sequence of: clone, `npm ci`, `npm run build`, `keygen`, a `publish` call with 9 flags in the QUICKSTART example, assemble a deploy tree, upload in order, `check-site`. Track B (existing site, drop-in) is the same minus the web seed, plus a script tag and an upload order rule. The ONBOARDING page adds a 4-question decision tree and a 25-line intake form before any of it.
2. **Reading load is large.** Before a first publish the documented reading is QUICKSTART (30,928 bytes, 510 lines), ONBOARDING (21,319 bytes, 309 lines) and, for a migration, MIGRATION (58,828 bytes, 850 lines): about 111 KB (byte counts from `wc -c`, 2026-10-20). Netlify Drop and Vercel Drop need a one-line instruction (section 3).
3. **The installable package is not installable.** `package.json` has `"private": true` (line 4), so `npx magnet-web` cannot fetch it from npm; QUICKSTART tells the reader to `git clone` first, and says `npx magnet-web publish` works only inside that clone. A "try it in 60 seconds" path that needs no clone is blocked by this one field and by the build step (`dist/` is built by `npm run build`).
4. **The best existing "try it" path is `npm run demo`, and it already needs no DNS.** It builds, publishes the example guestbook, starts a local tracker and dev server on `localhost`, and prints the address. Its prerequisites are a clone, Node 22+, `npm ci`, and optionally a Playwright Chromium for the headless seeder. It cannot run on a bare machine with one command.
5. **The tools already refuse bad input with an action.** The key-permission refusal ends with a `chmod 600 <path>` instruction, and publish warns about a missing `--tr`, `--ws` and `--cs` in plain words. The weak points are: a missing required flag prints one error line followed by the whole usage block, there is no interactive mode, and nothing infers `--scope`, `--name`, `--tr` or `--ct`.
6. **The visitor journey is short for the site and long for the identity.** A visitor installs nothing and sees one first-run card with three buttons. The identity is created silently and is visible only as `You: <8 hex>`. Backup is in Settings as "Export identity" with a passphrase and a file: two things to keep, no phrase, no passkey, no prompt at the moment backup matters (`src/loader/strings.js` lines 241 to 247; `grep -i 'backup\|recovery'` finds no recovery string, 2026-10-20).
7. **Competitors split cleanly into two classes.** Hosting products (Netlify Drop, Vercel Drop) reach a live URL in drag, drop, and optionally name it. Identity-first networks (Bluesky, Nostr clients) spend the visitor's first minute on account creation, and Nostr's key backup is documented as the user's own job. magnet-web is both: a hosting product for the owner and an identity network for the visitor, so it inherits both frictions unless it designs them away.
8. **Proposed owner path:** `magnet-web init` (guided, 6 questions, writes `magnet-web.json`), `magnet-web try` (local, no DNS, no clone), `magnet-web ship` (publish, assemble, verify, print the upload command or run it for supported hosts). Section 5 gives the files each changes and an effort for each.
9. **Proposed visitor login:** one button, "Sign in", that creates a passkey and a local identity in one prompt; no username, no password, nothing typed. A recovery phrase is offered after the first meaningful action, not at sign-in. "Log out" is split into Lock (default, one tap) and Remove from this device (guarded). Section 6.
10. **What this cannot fix:** the owner still needs an HTTPS host at the root of an origin and a place for the web seed. The visitor still sees IP addresses shared with peers once sharing is on. A passkey cannot sign arbitrary bytes today, and whether a synced passkey returns the same PRF output on every device is unproven (w2c-03-VERIFY, claim 8). A phrase backup stays in the design for that reason.

## 2. Findings: the owner journey as it stands

### 2.1 Counted steps, decisions and prerequisites

Counts come from the documents named. A "step" is a command or an action the owner must take; a "decision" is a point where the owner must choose or invent a value.

| Journey | Steps | Decisions | Prerequisites | Source |
|---|---|---|---|---|
| Try on this computer (`npm run demo`) | 4 (clone, `npm ci`, `npm run demo`, open the address) | 0 required; 1 optional (`--site`, `--name`) | git, Node 22+, npm; Playwright Chromium for the seeder (else the site "still loads from the web seed") | QUICKSTART "Step 0" and "Try it on this computer first" |
| Track A, shell mode, new site | 3 setup + keygen + publish + assemble + upload + check = 8, then optional DNS (9). QUICKSTART headings A1 to A6 | 9 values in the example publish call: dir, `--name`, `--scope`, `--key`, `--ws`, `--tr`, `--cs`, `--ct`, `--shell`; plus policy and bits if the site has shared data | everything above, plus a domain with DNS you control, an HTTPS static host at the origin root, a web seed that answers `Range` with 206 (GitHub Pages does; Cloudflare Pages answers 200 and cannot be one), an abuse contact | QUICKSTART A1 to A6; ONBOARDING "Prerequisites checklist" |
| Track B, drop-in, existing site | 3 setup + keygen + add tag + publish + upload (non-HTML first, HTML last) + check = 8; headings B1 to B6 | `--scope`, `--name`, `--key`, `--tr`, `--ct`, `--dropin`, `--inject-script`; check fit (B1); CSP (B6) | same minus the web seed | QUICKSTART B1 to B6; MIGRATION "The drop-in path in three steps" |
| Team adoption | 30-60-90 day plan; 4-question decision tree; 25-line intake form; 7 roles | 14 prerequisite checkboxes, 12 intake sections of questions | see ONBOARDING | ONBOARDING "Decision tree", "Intake form", "Roles" |
| CI publish | one-time setup of at least 3 secrets and an environment with reviewers, a pinned commit, storage and DNS provider | `CHANGE-ME` values throughout | AWS S3 or R2, Route 53 or Cloudflare | `deploy/github-actions/publish-site.yml` header ("Nothing in it has run against a real account yet") |

QUICKSTART's own target is "about 10 minutes of typing once your host and domain exist", and it adds that "setting up a new domain, its certificate or a DNS record takes as long as your provider takes". That claim is the document's estimate. It was not measured here.

### 2.2 What the tools print today (run on 2026-10-20, Node 24.22.0)

| Situation | What the tool said | Verdict |
|---|---|---|
| `publish <dir>` with no flags | `error: missing --name`, then a blank line and the full usage block (about 60 lines) | The first line is right; the usage dump buries it |
| `keygen` | `wrote <path> (mode 600); keep it offline and backed up`, a fingerprint, and `owner=p256:...` | Clear. It does not say where to put the key so that the next command finds it |
| key file with mode 644 | `error: refusing <path>: it is readable or writable by group or others (mode 644). Run: chmod 600 <path>` | Good: says what to do |
| shell publish with no `--tr`, `--ws`, `--cs` | three warnings: "no --tr: visitors will not find each other (signed pointers never use default trackers); the site loads from the web seed only", "no --ws or --xs: the site only loads while another visitor is online", "No --cs: the ledger root (gen=) reaches a visitor only from another visitor. Upload genesis.json ... and pass its URL as --cs." | Good wording, but they are warnings on a command that succeeded, so a first-time owner ships a site that cannot find peers |
| pointer longer than the DNS limit | "the pointer is 628 bytes in 3 TXT strings; pointers should stay at or under 450 bytes (fewer --tr and --ws entries make it shorter)" (QUICKSTART abridged output) | Says what to change |
| web seed unchecked | "the web seed ... has not been checked: after uploading, run publish again with --verify-ws" (QUICKSTART abridged output, truncated there) | Correct but requires a second publish run |
| no git history | `created   no creation date (pass --date, set SOURCE_DATE_EPOCH or publish from a git work tree)` | Fine for reproducible builds; confusing to a newcomer who has no idea why a date matters |

Observations that follow from this run: the CLI has no interactive mode and no config file. Every run restates every flag, and QUICKSTART tells the owner to "run the same publish command again" for each new version and each re-sign (90 days by default), so the owner must keep the command line somewhere.

### 2.3 Where the friction sits

1. **Install friction.** No npm package (`private: true`), a build step before first use, Node 22 or newer, and `npm ci` ends with a vulnerability notice the QUICKSTART has to explain in a paragraph (GHSA-2p57-rm9w-gvfp, QUICKSTART "Step 0"). A newcomer seeing "4 high severity vulnerabilities" will stop.
2. **Hosting friction.** The loader needs the root of an origin. A GitHub Pages project site at `https://<user>.github.io/<repo>/` does not work. GitHub's own quickstart names the repository `<username>.github.io` for the same reason (section 3), so this is a documented step, but it removes the usual "any repo" path.
3. **Upload friction.** The owner assembles a deploy tree by hand (QUICKSTART A3, "Where the files land" table lists 13 outputs) and uploads in an order (web seed first, shell last; non-HTML before HTML for drop-in) that matters for correctness (DEPLOY.md, RUNBOOK.md section 7).
4. **Naming friction.** `--name` must stay the same for every version, `--chain` and `--genesis` must be reused or the ledger restarts (`--new-genesis` exists to say so on purpose). Losing `genesis.json` is a silent footgun that the CI template handles by committing the file.
5. **Key friction.** The owner key is a file the owner must back up, with no recovery. "Losing the key means visitors see 'publisher key changed' and the ledger starts" afresh (ONBOARDING intake table). `--prev-key` supports rotation, but only with the old key.
6. **Legal friction.** `--ct` (an abuse and legal contact) is signed into the pointer and is part of the documented owner duties. It is a good default to ask for; it is also a prompt a casual owner has to answer.
7. **No guided answer to "which track?"** The tracks are chosen from a table with 8 rows in QUICKSTART and a decision tree in ONBOARDING. Nothing inspects the folder and recommends one, though `publish --dropin` already checks fit and prints refusals and warnings (MIGRATION "What `publish --dropin` checks").

### 2.4 The visitor journey as it stands

| Moment | What happens | Friction |
|---|---|---|
| Open the site | Loader page, status bar "Starting...", "Finding this site...", then the site (QUICKSTART "What visitors see") | None the visitor must act on |
| First-run card | "This site is delivered peer-to-peer." with [Share and load] [Load from host only] [Settings]; nothing connects before a choice | One forced choice; the supporting text (`consentText`) is about 600 characters and is the honest disclosure of IP exposure. It cannot be shortened without losing a true statement |
| Phone | Sharing stays off until "Share on this network" is turned on | Correct default; the visitor needs a Settings trip to change it |
| Identity | Created silently, shown as `You: <8 hex>` | Visitor has no idea it exists until a post |
| Posting | Proof-of-work fee, "Posting: working out the spam fee for this post (12,345 tries so far)" | Number is meaningless to a visitor; the wait is real |
| Backup | Settings, "Export identity", a passphrase, a file. iOS warning: "Safari may delete this site's copy and your identity after 7 days without a visit" (`iosHomeScreen`) | Backup is not offered at the moment it matters. The warning exists but is for iOS only |
| New device | Import identity in Settings | The visitor must find, carry and decrypt a file |

The identity design for v1 and v2 (recovery phrase first, passkey wrapping later) is already worked out in w2c-03 section 4 (rows R1 to R21). This report does not repeat it. It adds the flow a first-time visitor sees (section 6).

## 3. Findings: how others onboard (sources accessed 2026-10-20)

| Product | Path to "live" | Steps | Account | Source |
|---|---|---|---|---|
| Netlify Drop | open the Drop page, drag the folder, get a unique preview URL | 3 to 4 | none required; the page describes Drop as "no account required". Its CLI offers `netlify deploy --allow-anonymous`, a temporary project claimable within one hour | https://docs.netlify.com/site-deploys/create-deploys/ (fetched 2026-10-20; summarised by the fetch tool, not read in full). The page does not say whether the one-hour window applies to Drop |
| Vercel Drop | go to the Drop page, drag a folder, choose a team and project name, Deploy | 3 | a team is chosen, so an account | https://vercel.com/docs/deployments (page header `last_updated: 2026-09-03`, fetched 2026-10-20) |
| Vercel CLI | `npm i -g vercel`, then `vercel --prod` in the project root | 2 | account (login) | same page |
| GitHub Pages quickstart | create repo named `<user>.github.io`, visibility, README, create, Settings, Pages, source from a branch, pick branch, edit README, visit | 11 as listed by the fetch tool; publishing "can take up to 10 minutes" | GitHub account | https://docs.github.com/en/pages/quickstart (fetched 2026-10-20) |
| Bluesky | web or app, "Create account", email, birthdate, password, pick a handle, captcha, then profile picture and bio; a custom-domain handle is a separate step in Settings that needs a DNS record | about 6 fields | email-based account | Third-party guides only, which disagree on details: https://buffer.com/resources/how-to-use-bluesky/ and https://contentstudio.io/blog/how-to-use-bluesky (search result summaries, 2026-10-20; official docs not opened) |
| Nostr clients | apps prompt the new user to copy or download the private key (nsec) at sign-up; there is no "forgot password"; losing the key loses the identity; signer apps (NIP-55 Amber, NIP-46 remote signers) exist to avoid pasting the key into each client; the onboarding wizard Nstart offered local backup and an emailed encrypted copy | varies by client | none | https://soapbox.pub/blog/managing-nostr-keys , https://nobsbitcoin.com/nstart-nostr-onboarding-wizard , https://d-central.tech/nostr/key-management/ (search result summaries, 2026-10-20). I could not confirm Primal's 2026 sign-up flow; a December 2024 review said Primal lacked external-signer login |

What this means. Three patterns are worth copying and none is exotic:

1. **A drop surface.** The competitor's first run does not ask the owner to understand the delivery system. Netlify and Vercel both name drag-and-drop as the zero-setup path.
2. **A throwaway first deploy.** Netlify's CLI documents anonymous, claimable-within-one-hour projects. The equivalent for magnet-web is a local-only site that exists, works and is thrown away with no domain, no key outside the machine, and no host.
3. **Keys that a newcomer never sees at sign-up.** Nostr's documented norm (show the nsec, tell the user to store it) is the pattern magnet-web's competitors are moving away from with signers and wizards. The research already in the repo (w2c-03 F10 to F12) reaches the same direction.

What the comparison does not show: any claim that these competitors are faster in seconds. No timing data was collected, and none is asserted.

## 4. What this means for magnet-web

### 4.1 Today

- The owner path is correct, safe and documented, and its defaults protect the owner: the key must be mode 600, publish warns when visitors cannot find each other, the consent card connects to nothing before a choice. These are the right defaults and should survive any simplification.
- The "try it" path exists (`npm run demo`) and needs no DNS. Its cost is the clone, the build and `npm ci`.
- Drop-in mode is already close to Netlify Drop for the visitor: one script tag, nothing else changes.
- A visitor has an identity, a Settings export and import, and an honest disclosure. They do not have a first-time guidance flow.

### 4.2 Upgrade (what can be built on the current design)

- A guided `init`, a config file, a `try` command, a `ship` command, hosted templates, a published package, and a visitor sign-in flow. Section 5 and 6.
- Defaults inferred from the folder and the host: `--name` from the folder name, `--scope` from a URL, `--tr public`, a key path under a per-user directory.

### 4.3 Cannot

- **No hosting without a host.** The owner needs an HTTPS static host at the root of an origin and, in shell mode, a web seed that answers `Range` with 206. A guided tool can pick and check a host. It cannot remove the need for one. A "hosted drop" operated by the project would be a host and would carry the abuse duties in OPERATIONS.md; ONBOARDING states that a shared-origin hub "never isolates sites" and is for demos and a single publisher only, so a public drop service would need one origin per site, wildcard TLS and a Public Suffix List entry.
- **No anonymous visitors.** Peers, trackers and STUN servers see IP addresses once the visitor shares (ROADMAP: anonymity is a non-goal; consent text says so). Easier onboarding must not hide this; section 6 keeps the line.
- **No phrase-free, device-free recovery today.** Whether a synced passkey returns the same PRF output on every device is unproven; Apple's hybrid PRF mismatch has a 2026-04 recurrence report (w2c-03-VERIFY, claim 7). A recovery path that depends on it would be a promise the project cannot keep yet.
- **No passkey signing of every post.** The WebAuthn `sign` extension is an unmerged draft (w2c-03 F18). A passkey can unlock a key; it cannot be the key for every ledger entry.

## 5. Proposals (owner side)

Each proposal gives the file it changes, the effort (S under a day, M a few days, L a week or more), and the test that would show it works. Priorities use P0 (needed for the first public release path to be usable), P1 (v0.3), P2 (later), P3 (nice to have).

### 5.1 One command to publish a folder  (P0, M)

**Today:** 9 flags (QUICKSTART A2). **Proposed:**

```sh
npx magnet-web ship ./my-site --host https://example.com/
```

- `--host` supplies `--scope` (hostname), `--ws` (`<host>/ws/`), `--cs` (`<host>/ws/genesis.json`) and the shell/drop-in decision (see 5.2).
- `--name` defaults to the folder name; `--tr public` is the default when the flag is absent and the owner has not set one; `--out` defaults to `dist-publish`.
- The key defaults to `~/.config/magnet-web/<hostname>.jwk`, created with mode 600 if absent, with the existing "keep it offline and backed up" message and a one-line "type this to print where it is".
- It runs publish, then `--verify-ws` against the host if the host answers, then prints one thing: the upload instruction in deploy order, or does the upload for a host with a supported adapter (5.5).
- It never invents an abuse contact. It asks for `--ct` once and saves the answer (5.2).
- It remembers the answers in `magnet-web.json` so that "publish a new version" and "re-sign before the pointer expires" are the same command with no arguments.

**Files:** new `tools/ship.mjs` that calls the existing exports of `tools/publish.mjs`, `tools/keygen.mjs` and `tools/check-site.mjs`; `bin/magnet-web.mjs` (add the `ship` row to its command table); `tools/lib.mjs` for the config reader; `docs/QUICKSTART.md` (the "short version" becomes the first screen). **Constraint:** keep `publish` as is, because CI and the reproducibility checks (`--double-pack`, `--date`) depend on its flags.

### 5.2 A guided init wizard  (P0, M)

`magnet-web init` asks 6 questions and writes `magnet-web.json`. It uses facts the tool can read from the folder before it asks.

| # | Question | How the tool helps | Writes |
|---|---|---|---|
| 1 | Where is the site folder? | looks for `public/`, `dist/`, `build/`, `_site/` | dir |
| 2 | What is its address? (a URL, or "none yet, just try it") | checks the root-of-origin rule and refuses a sub-path with the reason (`check-site` already reports "non-root deployment") | scope, host |
| 3 | New site or existing site? | runs the `--dropin` fit check on the folder and recommends drop-in when pages need to be indexed (MIGRATION "Which path") | mode |
| 4 | Can visitors write (comments, guestbook)? | no (default, owner-only policy), anyone, or a list | policy, bits |
| 5 | Where do people send abuse reports? | email prompt, becomes `mailto:` | `--ct` |
| 6 | Where will you host it? | list of hosts that the tool can check for `Range` support; GitHub Pages noted as a user/org root only | host adapter |

Questions 4 and 6 have defaults, so a user who presses Enter four times gets: owner-only ledger, public trackers, GitHub Pages instructions. The wizard must print the one thing it cannot decide for the owner: the HTTPS host and the domain.

**Files:** new `tools/init.mjs`; `bin/magnet-web.mjs`; `src/chain` is untouched. The audience question (`--aud` tokens for minors, EEA and similar) should be asked only when the answer to the personal-data question says so; reuse the token list in `tools/publish.mjs`. **Test:** a scripted run of the wizard in `test/unit` produces a `magnet-web.json` that `ship` accepts.

### 5.3 "Try it in 60 seconds", no DNS, no clone  (P0, M to L)

Target experience (the 60 seconds is a goal, not a measurement):

```sh
npx magnet-web try ./my-site
# prints: http://localhost:8080/  (open it on this computer)
```

- Runs the existing local pipeline from `npm run demo`: build-free (ship `dist/` inside the package), publish with a throwaway key kept in a temp directory, local tracker, dev server on `localhost`, which browsers accept as a secure context (the demo already prints "use localhost, not 127.0.0.1: the pointer is signed for the hostname").
- Prints what the tool is doing in 4 lines, then the address. It states plainly that this is local only and that no one else can reach it.
- Optional second line for a phone: the existing `--tls` mkcert route, as an opt-in, not the default (it needs `brew install mkcert nss && mkcert -install`).
- Everything stays on the machine and LAN, consistent with docs/DEV-NETWORK.md.

**Blockers and changes:**
1. `package.json`: `"private": true` must be removed and the `files` list extended to include `dist/` so that the tool needs no build. This is a release decision, and it is the owner's.
2. New `tools/try.mjs`, a thin wrapper over `tools/demo.mjs` and `tools/dev-server.mjs`. Today `demo` expects a checkout; the copy of the example guestbook should move to a `templates/` folder inside the package.
3. The headless seeder (Playwright) must stay optional. Without it the site loads from the web seed and no second peer exists, so the "see a post sync between two browsers" step stays manual: open a second browser as QUICKSTART describes. Say so in the output rather than imply a peer is online.
4. **Honesty rule:** `try` must not run any remote tracker, STUN or DoH call, and must not suggest the result proves anything about public performance.

Effort is L if packaging `dist/` and the Playwright question are included, M if only the wrapper is built on an installed checkout.

### 5.4 Hosted templates  (P1, M)

Two kinds, with different risks.

| Template | What it is | Honest caveat |
|---|---|---|
| GitHub template repository for `<user>.github.io` | the site folder, `magnet-web.json`, a workflow adapted from `deploy/github-actions/publish-site.yml`, which today targets S3/R2 and DNS and "has not run against a real account yet" | The existing workflow keeps the owner key in a repository secret in an "mw-sign" environment with required reviewers. That is the documented CI trade-off ("unless the owner chooses to sign in CI", ONBOARDING Roles), but it contradicts "the key never goes into a repository" in QUICKSTART A1. A Pages template must state this on its first screen |
| Netlify, Vercel or Cloudflare "deploy this" templates | Same structure; Cloudflare Pages answers 200 to `Range`, so it cannot be the web seed, which means shell mode on it needs a second host for `/ws/` or must use drop-in | Must be tested; none of these were run here |

**Files:** new `templates/` folder in the repo (or a separate repository), `deploy/github-actions/pages-publish.yml` (new, a Pages-only variant with no S3 and no DNS), `docs/DEPLOY.md` (a "template" section). A project-run "drop a folder, get a URL" service is not proposed: see section 4.3 on abuse duties.

### 5.5 Host adapters: deploy in the right order for the owner  (P1, M per host)

`ship --deploy github-pages|s3|r2` uploads in the documented order and runs the check at the end. Start with GitHub Pages because it honours `Range` (ONBOARDING) and needs no credentials beyond `git`. **File:** `tools/ship.mjs` plus `tools/adapters/*.mjs`. Test by deploying to a staging hostname and running `tools/check-site.mjs` against it, which the CI template header also demands.

### 5.6 Sensible defaults  (P0, S each)

| Item | Today | Proposed | File |
|---|---|---|---|
| Trackers | none unless `--tr`; "visitors never find each other" | `--tr public` when the flag is absent and the pointer fits 450 bytes; print the choice | `tools/publish.mjs` |
| Key location | any path; the owner invents one | `~/.config/magnet-web/<hostname>.jwk`, mode 600, printed once | `tools/keygen.mjs`, `tools/ship.mjs` |
| Name | required | folder name | `tools/publish.mjs` |
| Scope | required | from `--host` | `tools/ship.mjs` |
| Ledger policy | owner-only | keep owner-only; wizard asks | `tools/init.mjs` |
| Pointer expiry | 90 days, re-sign by hand | `ship` stores the date and prints "re-sign due 2027-01-18" at the end of every run; `check-site` already warns 14 days before | `tools/ship.mjs` |
| Visitor consent | card with 3 choices; nothing connects first | **Keep.** Pre-selecting sharing would make a privacy default weaker for convenience. Instead make the two main buttons equal in weight and shorten the heading, not the disclosure | `src/loader/consent.js`, `src/loader/strings.js` |
| Phone sharing | off until enabled | **Keep** | none |

### 5.7 Error messages that say what to do  (P1, S to M)

The existing key-permission refusal is the model: the problem, then the command. Proposed changes, all in `tools/publish.mjs` unless stated:

| Case | Today | Proposed |
|---|---|---|
| Missing required flag | one error line, then the whole usage block | the error, a one-line example with the flag filled in, and "run `magnet-web init` to be asked instead"; the full usage only with `--help` |
| No `--tr`, `--ws`, `--cs` in shell mode | warnings on success | a single "Your site would ship in peers-only mode: re-run with `--host <url>`" block at the end, not three scattered warnings |
| `--ct` absent | accepted | prompt in `init`/`ship`; in `publish` keep the current behaviour so CI is not broken |
| No creation date | "pass --date, set SOURCE_DATE_EPOCH or publish from a git work tree" | in `ship`, set the date silently from the clock unless the owner asks for reproducibility |
| Loader errors (visitor) | strings in `src/loader/strings.js`, wording fixed by `docs/review/DESIGN-REVIEW.md` section 4 | audit each for "what happened" plus "what to do"; change only through that review document |

Test: a unit test that feeds each failure and asserts that the message contains a runnable command or a URL.

### 5.8 Publish the package and shrink the first-use text  (P0, S to M)

Remove the `private` flag when the owner decides to release, publish `magnet-web` to npm, make `npx magnet-web` the first line of QUICKSTART, and move the clone-based flow to "Contributing". Rewrite QUICKSTART to a 1-screen "Do this" followed by the existing material as reference. Move the `npm audit` explanation from "Step 0" to a short note in FAQ, because under an npm install the owner never sees `npm ci`'s output. **Files:** `package.json`, `docs/QUICKSTART.md`, `docs/FAQ.md`, `README.md`. **Constraint:** any release statement must follow the project wording rules (no "production-ready").

## 6. The visitor login and logout that needs no knowledge of keys

### 6.1 Design goals

1. The visitor never types a key, a hex string, a base64 value or a long password.
2. The first screen asks for one tap and one platform prompt (Face ID, fingerprint, device PIN).
3. Everything that matters is stated in plain language once, at the moment it matters.
4. The design never says "safe" or "secure" about a state it did not verify (w2c-03 R4: the UI must not say "safe" when `persisted()` is false).
5. The design stays correct if the passkey is missing, unsupported or later deleted.

### 6.2 Sign in, first time

Words below are drafts for testing, not shipped copy. They go through `docs/review/DESIGN-REVIEW.md` section 4, which fixes wording.

1. The site shows a **Sign in** button (in the example site, where chat and files need an identity). A visitor who never presses it still reads the site; only writing, chat and files need it.
2. On tap, the loader (not the site's code) shows a small sheet:
   *"Sign in on this device. We will ask this device to create a passkey for this site. Nothing is sent to a server. [Continue] [Not now]"*
3. **Continue** calls `navigator.credentials.create()` for a discoverable passkey with the PRF extension requested. The platform shows its own prompt. The visitor does the same gesture they use to unlock their phone.
4. If PRF results are available, the loader derives a wrapping key (HKDF) and stores the identity seed wrapped by it (w2c-03 4.3, item 1). If PRF is not available (the flags are not guarantees: w2c-03-VERIFY claim 7), the passkey is used only as a presence check before the local key is used, and the next step is shown with more emphasis.
5. The sheet closes. The status shows the visitor's chosen display name or a default such as "Guest 4f2a". Nothing was typed. A display name is a field they can fill later in a profile card.
6. Where the browser has no passkey support or the visitor presses **Not now**, a plain **Continue as a guest on this device** keeps the current silent identity. Guests can chat only if the site allows guests; that is the site's policy.

### 6.3 The phrase as a backup, offered at the right time

- Do not show a phrase at sign-in. The research shows that people often misunderstand seed phrases (CHI 2025 figures in w2c-03 F10, themselves from search snippets and not confirmed at source) and a phrase at the first screen adds exactly the friction this report is meant to remove.
- Offer it after the first thing worth keeping: the first ledger entry, the first chat message sent, or the first file uploaded. A non-blocking card: *"You can now sign in again later on this device. To use this identity on another device, or if this browser forgets this site, save a recovery kit. [Save recovery kit] [Later]"*
- The kit is the 12-word phrase (print, copy, QR) or an encrypted file, per w2c-03 R3. The visitor is told once that anyone with the words can act as them and that no one, including the site's owner, can recover them.
- Show the card again after 7 days without a visit on iOS, where the existing warning (`iosHomeScreen`) already applies.
- Restore is a separate path: **Sign in** then **I already have an account**, then scan, paste, or choose a file. Typing exists only here, and only on the visitor's own recovery.

### 6.4 Sign in, returning

One tap, **Sign in**, platform prompt. If the passkey is in a synced provider on a second device, the platform may offer it. The loader must try the sync-dependent path only after real-device verification (w2c-03 R21: "prototype only after the sync-equality test passes"), and until then it must fall back to the recovery kit on a second device and say so plainly.

### 6.5 Log out: three meanings, two buttons

A website's "log out" is ambiguous for a local identity. With no server session, logging out cannot end anything on a server. It can end three different things:

| Meaning | Name in the UI | What it does | Default? |
|---|---|---|---|
| Lock | **Sign out** | Forgets the unwrapped key in memory, hides chat and profile, keeps everything on the device. Next sign-in needs the passkey | yes, one tap |
| Leave this device | **Remove from this device** | Deletes the local identity and cached private records after a check that a recovery kit exists or that the visitor accepts losing the identity. Words: *"This removes your identity from this browser. Without a recovery kit you will not be able to use it again. [Remove] [Cancel]"* | no, behind a confirmation |
| Make the public history disappear | not offered | Ledger entries are signed, hash-linked and copied by every visitor. Tombstones hide entries; they do not remove copies (ARCHITECTURE section 6). The UI must say "Hide my posts" for what a tombstone does | n/a |

The honest edge: **Sign out** protects against a person who picks up the unlocked device later. It does not protect against a script in the same origin, which is why w2c-03 4.2 says the seed is readable by site code in per-domain mode and the privacy copy should say "the site you are on can act as you". A passkey-wrapped seed (proposal 11) removes silent access but is unproven end to end.

### 6.6 What the site developer sees

The SDK should expose three calls, so the example site and any other site get the same behaviour: `mw.auth.signIn()`, `mw.auth.signOut()` and `mw.auth.state()` ('guest' | 'signed-in' | 'locked'). The prompts and the recovery kit UI live in the loader frame, never in site code, so site code never touches a phrase or a key. This mirrors the existing rule that the phrase UI "runs in the loader frame after a user gesture" (w2c-03 4.2). **Files:** `src/sdk/sdk.js`, `src/loader/api.js`, `src/loader/bridge.js`, `src/loader/ui.js`, `src/loader/strings.js`, `examples/peer-guestbook/js/app.js` (the sign-in and sign-out buttons in the example), `docs/SDK.md`.

### 6.7 Tests that would show the flow works

- Chromium virtual authenticator with PRF on and off: sign in, sign out, sign in; with PRF off the fallback path still ends signed in and the UI says what is different.
- A scripted "delete the passkey" run, then restore from the recovery kit, then check the public key is the same.
- A second browser profile that imports the kit, posts, and does not break validity (w2c-03 R9: decide multi-device semantics first).
- A review of every string for words a new user will not know ("key", "seed", "PRF", "ledger"), except where the privacy page needs them.

## 7. Recommendations

| Priority | Effort | Recommendation | Why |
|---|---|---|---|
| P0 | S | Remove `private` and publish the package; make `npx magnet-web` the first command in README and QUICKSTART | Every other proposal depends on a one-line install |
| P0 | M | `ship <folder> --host <url>` with defaults for name, scope, trackers and key path | Cuts 9 flags to 2 without changing `publish` |
| P0 | M | `init` wizard that writes `magnet-web.json` and recommends shell or drop-in from the folder | The track choice is the first decision in all three documents |
| P0 | M to L | `try ./folder`, local only, no clone, no DNS | The only path that proves value in a minute without a host |
| P0 | S | Keep the consent defaults (nothing connects before a choice; phones off). Document why in DESIGN-REVIEW | Do not trade a privacy default for a click |
| P1 | S to M | Error messages with the next action; trim the usage dump | The key-permission message shows the target quality |
| P1 | M | Pages-only workflow and a `<user>.github.io` template; state the key-in-secret trade-off at the top | The most common free host; matches GitHub's own quickstart rule |
| P1 | L | Sign-in sheet, sign-out as lock, `mw.auth.*`, example-site buttons | Needed for the v0.3 identity goal |
| P1 | S to M | Backup card after the first meaningful action, not at sign-in | The point where a visitor first has something to lose |
| P2 | M | Passkey-wrapped seed when PRF works; keep the phrase as the master backup | Removes silent access, depends on platform behaviour that varies |
| P2 | M | Host adapters beyond GitHub Pages | Removes the upload-order footgun |
| P3 | L | Project-run drop service | Adds a host, abuse duties and a Public Suffix List entry; not recommended before the rest |

## 8. Open questions

1. **Release decision:** does the owner want the package public on npm for 0.3, and under what name? (Owner decision; `package.json` has an `OWNER` placeholder repository URL.)
2. **Key in CI:** is a Pages workflow with the owner key in a repository secret acceptable for the template, given QUICKSTART A1 says the key never goes into a repository? If not, the template can only build and the owner signs locally with `ship`.
3. **Synced passkey PRF equality:** two real devices, same salt, same output? Unresolved in w2c-03-VERIFY claim 8. Until then phrase or file recovery is the only cross-device route.
4. **Guest policy:** may guests (no passkey) chat and upload on the example site, or is that site-by-site policy? This changes whether **Continue as a guest** is shown.
5. **Per-origin passkeys:** a passkey is tied to an RP ID, so a site loaded from a mirror or hub origin gets a different one (w2c-03 F17). Does the sign-in sheet say so, or is it hidden behind the recovery kit?
6. **Does `try` ship the Playwright seeder?** Without it there is no second peer, so the sync step is manual.
7. **Measure:** none of the step counts here are timed. A 5-person, moderated test of `ship` and of the sign-in sheet would replace this report's counts with observations. No such test has been run.
8. **Bluesky and Nostr sources are secondary.** Official Bluesky onboarding documentation and a current Nostr client's sign-up were not opened; if the comparison is quoted in public materials, replace those rows with first-party sources.

## 9. Sources

Accessed 2026-10-20 unless stated.

- Netlify, "Create deploys": https://docs.netlify.com/site-deploys/create-deploys/
- Vercel, "Deploying to Vercel" (last_updated 2026-09-03): https://vercel.com/docs/deployments
- GitHub, "Quickstart for GitHub Pages": https://docs.github.com/en/pages/quickstart
- Buffer, "How to use Bluesky" (secondary): https://buffer.com/resources/how-to-use-bluesky/
- ContentStudio, "How to use Bluesky" (secondary): https://contentstudio.io/blog/how-to-use-bluesky
- Soapbox, "How to store and manage your Nostr private key": https://soapbox.pub/blog/managing-nostr-keys
- NoBS Bitcoin, "Nstart: Nostr onboarding wizard": https://nobsbitcoin.com/nstart-nostr-onboarding-wizard
- D-Central, "Nostr key management and signer security": https://d-central.tech/nostr/key-management/
- In this repository: the files named in the Method line and in each proposal, plus docs/research/w2c-03-identity-ux.md and its VERIFY file. Local runs of `keygen` and `publish` on 2026-10-20 (Node 24.22.0), in the session scratchpad.
