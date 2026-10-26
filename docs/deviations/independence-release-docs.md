# Domain independence: release documents (IND-2 to IND-6, 2026-10-25)

Written by the release-docs fixer on 2026-10-25 between 09:32 and 09:58 ET (times from `TZ=America/Toronto date`). The plan
is the independence design memo (`.orchestration/reports/independence-design-2026-10-25.md`, not tracked), which answers
the owner's request of 2026-10-25: no bought domain, and the project made domain independent. This lane owns rows IND-2,
IND-3, IND-4, IND-5 and IND-6; the code fixer and the design-docs fixer edited the tree at the same time, so every edit
here is an exact-line edit. Nothing was committed, pushed or published; the checkpoint loop carries the edits. No browser
ran and nothing left 127.0.0.1.

Facts used: the owner regenerated `SECURITY-KEY.asc` on 2026-10-25 with an address-free user id ("felinar security
(reports through GitHub private vulnerability reporting)"; `gpg --show-keys` prints fingerprint
`4C44 C2A8 D935 27B7 4C88 1E20 A46F 0FB0 E1F8 0C26`, ed25519, expires 2028-10-24). The retired fingerprint no longer appears
in any tracked file. `PINNED_RELEASE_KEYS` stays empty until the owner makes the release key; only the checklist line
that fills it was added.

Before any edit (09:38 ET), the new guard test ran against the tree and reported exactly the 19 lines in 7 files the memo
counted (README.md 1, SECURITY.md 3, docs/OPERATIONS.md 1, docs/PUBLISH-CHECKLIST.md 8, review-round-tools.md 4,
review-round-verify-1.md 1, review-round-verify-3.md 1), which proves its pattern. After the edits it reports none.

## Rows

| id | What changed (file:line, as of 09:55 ET) | Tests | Result |
|---|---|---|---|
| IND-2 | `SECURITY.md:8` to `:16`: the mailbox bullet is gone; GitHub private reporting is the private route ("The project holds no domain and runs no mailbox"), the public "please contact me" issue is the fallback, and the regenerated key (new fingerprint, user id with no address) encrypts what is then sent. `README.md:290` to `:293`: the same, with the new fingerprint. `docs/PUBLISH-CHECKLIST.md:105` to `:108` (1b item 5 answered "no mailbox") and `:113` to `:118` (fingerprint, a `gpg --with-colons` line that must print nothing when the user id holds no `@`, and a count of the fingerprint in SECURITY.md and README.md, replacing the mailbox grep); `:440` (decisions table); `:833` to `:838` (section 9 go or no-go, now answered); `:272` to `:284` and `:1063` to `:1073` (step 7 and section 12 check `private-vulnerability-reporting --jq .enabled`); `:1451` to `:1465` (16.8 "Security reporting", one item done and one open: a second, project-only route). `docs/OPERATIONS.md:497` to `:499`: a domainless operator's contact is an `https:` page or a mailbox they read, never derived from the site's name. `test/unit/repo-layout.test.mjs:21` unchanged: the key file is kept (regenerated) | `test/unit/verify-release-anchor.test.mjs`, "IND-2": parses the armoured key (OpenPGP packets, no gpg needed), computes the v4 fingerprint, checks that no user id holds an address and that SECURITY.md, the README and the checklist give that fingerprint and not the retired one. `test/unit/docs-domain-free.test.mjs` guards the address (IND-5) | pass; revert sample: the old fingerprint put back into SECURITY.md fails the IND-2 case |
| IND-3 | `docs/PUBLISH-CHECKLIST.md:157` to `:175` (step 3b): a second perl line writes `RELEASE_PUB` into `PINNED_RELEASE_KEYS` of `tools/verify-release.mjs` (`:171`) and the loop checks all three files (`:175`), before the squash of step 5 and the npm publish of 5b. Gate line of 5b and its copy in section 11 (`:246`, `:999`): stop while the array is empty. Step 10 and its copy in section 14 (`:358`, `:1176`): tag only when `RELEASE_PUB` is the key SECURITY.md shows, with "Release key: <key>" in the annotated tag message. Step 10b and section 14 (`:382` to `:383`, `:1221` to `:1222`): `release-key.txt` signed with the project's OpenPGP key and uploaded, and an archive copy of SECURITY.md at the tag (`:364` to `:371`, section 14 text). `:1426` to `:1436` (16.7): the second places that need no domain, and that they protect against an account takeover, not against the owner. `SECURITY.md:154` to `:172`: the DNS record and "Take the key from that record" are gone; the four domain-free places and the honest limit. `docs/OPERATIONS.md:982` to `:986`: "the second places named in SECURITY.md", the advisory's key line signed with the OpenPGP key. `README.md:293` to `:295`: the key is the one `PINNED_RELEASE_KEYS` holds. `docs/deviations/review-round-tools.md:75` to `:79`, `:104` to `:106`: the DNS pin marked superseded and R-SUP-2c applied without its DNS part | `verify-release-anchor.test.mjs`, "IND-3" (4 cases): every pinned entry is `p256:` plus 87 characters (vacuous while empty) and the array is one line of the form step 3b rewrites; the key SECURITY.md and the README show equals `PINNED_RELEASE_KEYS` (placeholder and empty today); step 3b's own lines, run from the checklist on a temporary copy of the tools, print "pinned" for all three files, refuse a blank or other key, and the gate's grep stops before and passes after; from that copy, with one key built in, `verify` refuses a list signed by another key even with `--pubkey` naming it (FAILED (key)), and without `--pubkey` (FAILED (signature)). `docs-domain-free.test.mjs`: no tracked file names a DNS pin of the release key | pass; revert samples: dropping the step 3b perl line, dropping the gate's pin grep from one copy, and disabling the pin check in a copy of `verify-release.mjs` each fail a case |
| IND-4 | `docs/PUBLISH-CHECKLIST.md:76` to `:77`, `:92` (DEMO_DOMAIN empty by default), `:71` (the demo is an option of section 12), `:279` and `:1041` (homepage set only when DEMO_DOMAIN is), `:286` to `:290` (step 8: no demo in 0.3.0, `gh workflow disable pages-demo.yml`), `:439` (decisions table), `:1075` to `:1101` (section 12: the free route, a second repository named `$OWNER.github.io` with `MW_DEMO_ORIGIN`, its public lines behind the gate; no CNAME or `-f cname=` call), `:1262` (section 15: only if a demo runs). `docs/recipes/github-pages.md:3` to `:8`, `:32` to `:37`, `:44` to `:55`, `:67` to `:87`, `:95` to `:96`: the recipe leads with `<user>.github.io` (`:81` to `:84`, IND-9's, untouched). `examples/landing/README.md:110` to `:116`. `.github/workflows/pages-demo.yml:22` to `:31` (comments only) | `docs-domain-free.test.mjs`, "IND-4": no `demo.example.org` in the checklist, DEMO_DOMAIN empty, every `--homepage` line guarded by `[ -n "$DEMO_DOMAIN" ]`, no `-f cname=`. `test/unit/tools-v03-release.test.mjs` (workflow shape, :606 to :680) | pass; revert sample: DEMO_DOMAIN set back to the old default fails the IND-4 case |
| IND-5 | New `test/unit/docs-domain-free.test.mjs`. Gate line of step 5b and its copy in section 11 (`:247`, `:1000`): `! git grep -q -I -i -P 'felinar\.(dev|app|ca|io|com|org|net)\b'`, explained at `:228` to `:233`. The six historical lines reworded to "a project domain (never bought)", dates kept: `docs/deviations/review-round-tools.md:75`, `:79`, `:104`; `review-round-verify-1.md:74`; `review-round-verify-3.md:17` (and its row now records the close) | The new file: every tracked text file is free of the TLD form (`felinar.mjs` never counts), the pattern catches each TLD and a mailbox in any case, and both gate copies run the same search. The gate grep itself ran in bash and zsh on a scratch copy: exit 0 on the tree, 1 with a mailbox line added | pass; first run before the edits: 19 lines in 7 files; revert sample: a mailbox line appended to README.md fails |
| IND-6 | `SECURITY.md:174` to `:191`: a copy from any mirror, door, torrent or USB stick passes the same check; the signed lists with `verify` are step 2, the anchor; `gh attestation verify` is step 3, extra evidence for a copy from GitHub (now on one line, with the R-SUP-2b flags); the notes carry the sha256 of each file and the identity page's build id and bundle sha256 (`<meta name="mw-idp-build">`). Release-notes block of step 3 and its copy in section 8 (`:149`, `:771`): one bullet naming the signed lists as the check, the checksums, and the domain-free key places with their limit. Step 10b and section 14: the owner builds the tag from this clone and signs only with `--rebuilt` (`:376` to `:378`, `:1215` to `:1217`), `verify` with `--expect-version 0.3.0 --expect-tree` (`:380` to `:381`), and a node line appends the SHA256SUMS lines and the identity page's build id and bundle sha256 to the draft's notes (`:384` to `:387`, `:1223` to `:1226`). Gate copies in section 11 updated with step 5b. `README.md:294`: "from GitHub or from any other copy" | `verify-release-anchor.test.mjs`, "IND-6" (4 cases): the test's guard trips on `fetch` and on a read outside its folder; a fixture release copied to a second folder verifies from a temporary copy of the tools under `node --permission --allow-fs-read=<temp folder>`, with `PATH` empty (no gh) and every socket, DNS and fetch call made to throw: OK with and without `--pubkey`, no "no release key built in yet" warning, a changed byte fails naming the file, an older signed release fails (version); step 3's release-notes block runs in bash on a copy of CHANGELOG.md with no stderr and writes the bullet; step 10b's notes line produces the exact checksum and identity-page text, signs with the fingerprint SECURITY.md names, and both copies of the sign, verify, upload and tag lines are identical | pass; revert sample: an apostrophe in the release-notes bullet (it broke the single-quoted perl line once during this work, found by running the block) fails the case |

## Suites (2026-10-25)

1. 09:41 to 09:50 ET, the two new files: `node --test test/unit/docs-domain-free.test.mjs test/unit/verify-release-anchor.test.mjs`,
   last run 14 tests (5 and 9), 14 pass, 0 fail.
2. 09:50 ET, the touched and related files: the two above plus `docs-links`, `docs-claims`, `docs-review-round`, `repo-layout`,
   `tools-v03-release`, `tools-review-requests` and `tools-install-scripts`: 89 tests, 80 pass, 0 fail, 9 todo. The todo case
   "SUP-3: the owner signs only with --rebuilt" (`test/unit/tools-review-requests.test.mjs:28`) now passes (see Requests).
3. 09:51:47 to 09:52:15 ET, `npm test`: lint floor "147 files, no APIs or syntax past the browser floor"; 2,314 tests, 2,305
   pass, 0 fail, 9 todo (the count includes the other fixers' new tests of the same hour). Exit 0. Again after this note
   was written, 09:54:23 to 09:54:51 ET: the same counts, exit 0.
4. The counsel grep of `docs/PUBLISH-CHECKLIST.md:123` prints nothing (exit 1), and
   `git grep -n -I -i -P 'felinar\.(dev|app|ca|io|com|org|net)\b'` prints nothing (exit 1).
5. Revert samples on a scratch copy of the tree (git-initialised, in the session's scratchpad), one at a time: the step 3b
   perl line removed, DEMO_DOMAIN set back, a mailbox line added, the pin check disabled in `verify-release.mjs`, the old
   fingerprint put back, the gate's pin grep removed from one copy, a DNS pin line added, an apostrophe put into the
   release-notes bullet. Each made at least one of the new cases fail; the copy was reset after each.
6. By hand, in the scratch copy: step 3b's then-branch and loop under zsh with a key from `tools/keygen.mjs` (pinned, all
   three files); the gate's pin grep and domain grep under zsh and bash; step 3's release-notes block under bash (the
   changelog gains the bullet); the notes line of 10b against the tree's `dist-idp` (build id 9d6a24e3eb7f, bundle sha256
   67a742cd...). No end-to-end suite: none of these rows names one.

## Open

- The two `gpg` lines of step 10b (sign and verify `release-key.txt`) have not run: no `gpg-agent` could start in this
  session (the scratchpad path is too long for its socket), so not even a throwaway key could be made. The checklist says
  so at section 14. Never with the owner's key, which is his.
- Private reports depend on GitHub alone until a second, project-only route exists (owner decision O2; 16.8 keeps it open).
- The second places of the release key do not protect against the owner, and the OpenPGP key comes from the same
  repository; SECURITY.md, the release notes and 16.7 say so. Only a second person removes this.
- The archive copy of SECURITY.md and the tag message exist only once the owner tags and releases; 0.3.0 has no earlier
  release to carry the key.
- The GitHub lines added here (the `private-vulnerability-reporting --jq .enabled` check, `gh workflow disable`, the free
  demo route, the notes edit and the asset upload) have never run, like every GitHub step of the checklist.

## Requests for files this lane does not own

1. `tools/verify-release.mjs:13` (header comment: "in a place the repository owner does not control"), `:263` (warning: "the
   second place") and `:460` (`sign` prints "pin this public key in README.md, SECURITY.md and a second place you do not
   control"): name `PINNED_RELEASE_KEYS` and "the second places SECURITY.md names" instead. Code fixer.
2. `.github/workflows/release.yml:28` ("a second place the repository owner does not control") and
   `deploy/github-actions/publish-site.yml:70` ("its second place"): the same wording. `release.yml` notes template (`:112` to
   `:119`): optionally list `release-key.txt` and its `.asc`, which step 10b now uploads.
3. `.github/workflows/pages-demo.yml:99` (an error string, not a comment): "set a custom domain in Settings, Pages" could also
   name a repository named `<owner>.github.io`. And a guard so the workflow does nothing in a repository that runs no demo
   (for example `if: vars.MW_DEMO_ORIGIN != '' || github.event.repository.name == format('{0}.github.io', github.repository_owner)`),
   which would make the `gh workflow disable` line of step 8 unnecessary.
4. `test/unit/tools-review-requests.test.mjs:28`: the todo case R-SUP-3 now passes (every `sign` line of the checklist has
   `--rebuilt`, every `verify` line `--expect-version`); remove its `todo` option. Its title also says "attestation-checks
   every downloaded file", which no assertion checks; the checklist's `gh attestation verify` lines (`:375`, `:1199`)
   still lack the R-SUP-2b flags.
5. `CHANGELOG.md`, 0.3.0 known gaps: one line saying the release key's second places protect against a takeover of the
   GitHub account, not against the owner (IND-3 docs; the release-notes block of step 3 carries it in the notes already).
   Design-docs fixer or integrator.
6. `docs/PUBLISH-CHECKLIST.md:1263` (section 16 intro, not a step this lane owns): "the security mailbox decision" could read
   "the security reporting decision".
