# Security policy

felinar moves website files and shared data between visitors' browsers. Bugs here can expose
visitors, not only site owners, so reports are welcome and taken seriously.

## Reporting a vulnerability

- Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a
  vulnerability", or https://github.com/ashkanshokry25-maker/felinar/security/advisories/new). Do not open a
  public issue for anything exploitable. The project holds no domain and runs no mailbox, so this is the private route.
- If it does not work for you, open a public issue that says only "security report, please contact me", with no details
  and a way to reach you, and a maintainer will arrange a private channel. Encrypt the details you then send to the
  project's OpenPGP public key: the file `SECURITY-KEY.asc` at the root of this repository (ed25519, fingerprint
  `4C44 C2A8 D935 27B7 4C88 1E20 A46F 0FB0 E1F8 0C26`, made 2026-10-25, expires 2028-10-24; its user id names no e-mail
  address). Check the fingerprint before you encrypt (`gpg --show-keys SECURITY-KEY.asc`). Do not send details to an
  address that claims to be the project's: the project has none.
- Include: the affected component (loader shell, drop-in script, Service Worker, site ledger,
  publisher tools, tracker tooling, and from v0.3 the identity origin bundle, the sign-in widget, the
  SDK and `@felinar/verify`), a minimal reproduction, the browsers and versions involved, and
  the impact you believe it has.
- You will get an acknowledgement within 3 business days and a triage decision within 10. We aim to
  ship fixes for confirmed high-impact issues within 30 days and to publish an advisory within 90.
  Coordinated disclosure after 90 days is the default (chosen, R 2.19); we ask you to give us that time
  and we will tell you if a fix needs longer.
- Please give us the chance to fix before you publish. Credit is given in the advisory unless you
  prefer otherwise.

### Safe harbour

Good-faith research that follows this policy is welcome. We will not ask anyone to stop, and will not
pursue or support legal action over research that: tests only your own devices, accounts and
deployments (or the loopback and test setups in this repository); does not read, change or delete
anyone else's data; does not degrade a service other people use; and gives us the time above before
anything is published. We cannot speak for third parties such as hosts, trackers or registries, and
this paragraph is not legal advice or a contract. No lawyer has reviewed it: for 0.3.0, the first release that carries the
identity features, the owner had AI research agents check the project's texts against published law instead (2026-10-24),
and that is research, not legal advice. The paragraph states what the maintainers intend; it cannot authorise anyone to
reach other people's systems or data.

## Scope

In scope: everything under `src/`, `tools/`, `build.mjs`, the published loader assets, and the
documented deployment recipes. From v0.3 this includes the identity origin bundle (`src/idp/`), the
sign-in widget (`/_mw/signin.js`), the chat panel, the SDK, `packages/verify` (`@felinar/verify`),
the `mw-signin-v1` format (`docs/specs/mw-signin-v1.md`), the freeze-group ledger rules, and the build
and release pipeline.

The identity origin bundle and `@felinar/verify` have their own severity class. A flaw in them can
expose a person's identity on every site, or let a server accept a forged proof, so such a report is
triaged first and its advisory says which sites and which builds are affected.

Out of scope: third-party trackers, STUN servers, DNS-over-HTTPS resolvers and static hosts you do not
control; vulnerabilities in dependencies that are already public (report upstream, then tell us so
we can bump); social engineering of site owners; malicious browser extensions and compromised devices.

## What the design protects, and what it does not

Read `docs/SECURITY-MODEL.md` and, for the v0.3 design, `docs/THREAT-MODEL.md` before reporting. In short:
content integrity is verified against the site's infohash, so other visitors cannot tamper with files;
the HTTPS host that serves the loader is the trust root on every visit, so a compromised host or DNS zone
controls what visitors run; peers, trackers and STUN servers see visitors' IP addresses by design; the
site ledger is public and has no finality. Reports that restate these documented properties are not
vulnerabilities, but reports that show a documented protection failing are exactly what we want. The
list of limits the project states about itself (no forward secrecy for retained envelopes, hostile site
code using that site's keys, the hub serving the loader for its personal sites, and others) is in
`docs/THREAT-MODEL.md`, "Honest limits".

## Cryptography and export rules

This repository contains encryption source code: chat, sealed records, private files and media, and the identity page.
It is public under the MIT license, with no restriction on passing it on. Its author is in Canada, and it is hosted by
US services (GitHub, and npm if the package is published there). What follows is the owner's reading of the rules as
checked on 2026-10-22, not the opinion of a lawyer or of a government.

### United States

Under the US Export Administration Regulations (EAR), publicly available encryption source code is not subject to the
EAR (15 CFR 742.15(b)(1) and 734.7(b); https://www.ecfr.gov/current/title-15/section-742.15). Since 2021-03-29 the one
condition is an e-mail notice to the Bureau of Industry and Security (BIS) and the NSA, and only for source code that
provides or performs "non-standard cryptography" (15 CFR 742.15(b)(2); 86 FR 16482). BIS's web page "Encryption items
not subject to the EAR" still reads as if the notice applied to all publicly available encryption source code, which
does not match the rule text.

The primitives here are published algorithms: P-256 (ECDSA and ECDH), AES-256-GCM, SHA-256, HMAC, HKDF, Argon2id,
BLAKE2b and PBKDF2. The protocols that combine them are this project's own: a Noise XX variant over P-256, a sealed box,
and the record and media formats (`src/chat/noise.js`, `src/chat/seal.js`, `src/media/format.js`). They are documented
here and have test vectors (`test/vectors/`), but no standards body has adopted them and none has had an outside review.
The rule text does not say whether that makes them "non-standard cryptography". <The owner's decision, one of: "The owner
sent the notice on <date> to crypt@bis.doc.gov and enc@nsa.gov, naming <the internet locations>." or "The owner decided
not to send it, because <reason>.">

`@felinar/verify` only checks signatures and a message authentication code. It has no data-confidentiality function,
so the owner reads it as outside encryption controls (the owner's reading, not a BIS classification).

### Canada

The project uses AES-256-GCM, ECDH and ECDSA on P-256, SHA-256, HMAC, HKDF, PBKDF2-SHA-256, Argon2id and a Noise XX
handshake over P-256 with AES-GCM, through the browser's WebCrypto API except for Argon2id and BLAKE2b, which are plain
JavaScript. These are the kind of information security functions that Group 1, Category 5, Part 2 of the Export
Control List controls (items 1-5.A.2 and 1-5.D.2 of A Guide to Canada's Export Control List, 2026 edition) unless an
exclusion applies. The General Software Note of that Guide says the Lists do not control software that is "in the
public domain", which the Guide defines as made available without restrictions upon its further dissemination, and adds
that copyright restrictions do not remove software from that status. The source, the built files and the packages are
published that way, so the owner treats them as in the public domain and seeks no export permit; the note does not rely
on the mass-market Note 3, which Global Affairs Canada says source code does not normally meet. Separately, the Export
Control List leaves Group 1 items exported to the United States uncontrolled (s. 2(a)). No Canadian notice like the US
one was found. Check again when distribution is restricted (a private build, a paid or registered download), when a
build is sent to a named customer, when a new cryptographic construction is added, or when the Guide changes.

No lawyer reviewed this section, and it is not legal advice. It does not cover the European Union, other countries or
sanctions. If you build a product from this code, work out your own export position: BIS says an item is not publicly
available merely because it calls publicly available code.

## Supported versions

Only the latest minor release line receives fixes. Security fixes are released as patch versions
and announced in `CHANGELOG.md` and GitHub advisories.

## The security program for 1.0

> **Status: v0.3, partly built; reviewed in the review round of R 5.3 (2026-10-22 to 2026-10-24).** This is the program that R 2.19 of the v0.3 design review
> (`docs/review/V03-DESIGN-REVIEW.md`) requires before a 1.0 release. The parts that are code are in the tree
> (`build.lock.json`, the fuzzers in `test/fuzz/`, `tools/verify-release.mjs`, the CI, release and rebuild
> workflows), and 0.3.0 is the first release to be cut with them: its workflow attests
> the files and leaves a draft, and the owner signs the per-file hash lists offline before publishing it. The
> repository settings are the owner's steps (`docs/PUBLISH-CHECKLIST.md`, section 16.7). The parts that need people
> (two-person review, the independent audit, the real-device rows) have not happened. The identity origin makes the
> build the trust root for every person's root, which is why the items on releases and dependencies are blockers for
> any release that carries identity features.

| Area | What is required |
|---|---|
| Threat model | `docs/THREAT-MODEL.md` is a living document. Every release adds or closes rows, and a release cannot ship with a row whose "after" column changed without review |
| Disclosure policy | This file: private reporting, the scope above, 90-day coordinated disclosure by default (chosen), safe harbour, credit, how fixes and advisories are published, and the separate severity class for the identity origin and the verifier |
| Releases | Immutable GitHub releases; a tag ruleset (no creation outside the owner, no force push, no delete) and a release job that builds only a commit on `main`; no `--clobber`; the release job runs in an environment with a reviewer who is not the person who pushed; build provenance attestation (`actions/attest-build-provenance`); an ECDSA P-256 signature over each per-file hash list, made offline with `tools/verify-release.mjs sign` and a release key from `tools/keygen.mjs` that stays outside the clone, whose public key is pinned in the README, in this file and in `tools/verify-release.mjs` itself (`PINNED_RELEASE_KEYS`, with `RETIRED_RELEASE_KEYS` for a key that must never verify again), and compared with the second places named under "Checking a release", which need no domain; the owner signs a list only when it equals a build of the tag made on the signing machine (`sign --rebuilt`); a cross-OS rebuild job that compares `dist/` (`.github/workflows/rebuild.yml`); `tools/verify-release.mjs verify`, which names the release it accepts and refuses an older or other version than the one expected (`--expect-version`, `--min-version`); attestation checks bound to the release workflow, tag and commit; the identity origin bundle hash published for every release and shown on its cards |
| Dependencies | Every bundled package pinned by tarball SHA-256 in `build.lock.json` (not only the vendored WebTorrent); two-person review of changes to that file (CODEOWNERS); a dependency cooldown of 14 days (chosen) with an explicit override for security fixes; no unreviewed WebAssembly blob; `npm-shrinkwrap.json` in the command-line package and `--ignore-scripts` in every install instruction (a dependency's install script runs on a global or tarball install and under npx even on npm 11.19, because the clone's `.npmrc` is not in the package); the packages that have install scripts listed with a reason in `tools/install-scripts.json` (a test fails when the shrinkwrap gains one); `node build.mjs --update-lock` refuses a new release of a package that carries npm provenance when the new release has none (`--accept-no-provenance` overrides, for the second reviewer to see) |
| Names | The npm names are reserved, and `@felinar/verify` is published with zero dependencies, as a single file that can also be vendored, with the conformance vectors of `mw-signin-v1`. R 2.19 also asks for npm provenance, which needs a publishing workflow; none exists (the release workflow publishes nothing to npm), so a package published by hand carries none |
| Fuzzing | Property and mutation fuzzers in CI for the parsers and codecs of untrusted input (bencode, torrent files and magnets, MW-PTR/1, RFC 8785 canonicalisation, ledger and chat frames, the Noise handshake, sealed items, the media chunk format, MP4 and WebM box rewriting, image headers, `mw-signin-v1` in the verifier, the wire guard and ledger ingest), every numeric field driven to 0, -1 and 2^53-1 |
| Real devices | The rows of `docs/DEMO-RESULTS.md` (G1 to G22 and the v0.3 rows) pass on real devices; a row never passes from emulation |
| Independent audit | Before 1.0: the identity origin bundle (derivation, wrapping, passkey use, cards, message handling, the redirect flow, storage), the sealed box, the Noise XX instantiation, the media chunk format and Service Worker routes, `@felinar/verify` and the `mw-signin-v1` spec, the freeze-group ledger rules, the drop-in widget and the build and release pipeline; plus a separate privacy and legal review of the cards, `docs/PRIVACY.md` and the impact-assessment templates. Findings are published |
| Incident response | Runbooks in `docs/OPERATIONS.md`: an identity origin compromise (publish the bad build hash, ship a fixed build, tell people to use "Replace my keys on all sites"), a site host compromise (the loader floor `ml=` and the separate purge mode), a leaked owner key (rotation to the committed key, `nx=`), and a lost or leaked release key (retire it in `RETIRED_RELEASE_KEYS`, announce it through the second places, sign again with a new key) |

Two parts of the table need people, not code. A two-person review and a reviewer who is not the pusher both
need at least two maintainers; when a release is cut with fewer, its release notes say so. The independent
audit is scheduled and paid for by the owner (`docs/PUBLISH-CHECKLIST.md`, section 16).

## Checking a release

Releases are signed from 0.3.0 on, with one ECDSA P-256 key that the owner made with `tools/keygen.mjs` and keeps
offline. Its public half:

`p256:BCHNewmajl6XLH2R_GitiO3TJ5bQQQCEK6ljHGk-y5ZBnZ7iVk_dnkRQWcMrvy-LAbwQ5UTfQTBOpDKxz-YvtS4`

The same key is in the README and in `tools/verify-release.mjs` (`PINNED_RELEASE_KEYS`), so every copy of the tools
that a release carries knows it, and `verify` then refuses a list signed by any other key, whatever `--pubkey` says.
Take the key from a copy you already trust, not from the release you are checking: a change to this file, the README
and the tools in the same commit as a release would otherwise go unnoticed. The project holds no domain, so no DNS
record carries the key. The places to compare it with need none:

- the key built into every earlier release (`PINNED_RELEASE_KEYS` in its `tools/verify-release.mjs`): a later release
  verifies under it, or under a new key that a rotation announced ([docs/OPERATIONS.md](docs/OPERATIONS.md), "A lost or
  leaked release key"). 0.3.0 is the first release, so for it this place is empty;
- the line `Release key: p256:...` in the message of the annotated tag `v<version>`
  (`git tag -l --format='%(contents)' v<version>`), in every clone made from the tag;
- `release-key.txt` and its detached OpenPGP signature `release-key.txt.asc` on the release page, signed with the
  project's OpenPGP key above (`gpg --verify release-key.txt.asc release-key.txt`);
- an archive copy of this file at the tag (Software Heritage or the Wayback Machine), made when the release went out.

These places protect against someone who takes over the GitHub account or the repository after a release: they cannot
change a clone, a tag message or an archive copy made before. They do not protect against the owner, who controls all of
them, and the OpenPGP key and this file come from the same repository. Until the line above shows a key that starts with
`p256:`, no release has been signed: treat a release that claims a signature as a security report.

Download a release (`gh release download <tag> --repo ashkanshokry25-maker/felinar`), or take a copy of its files from anywhere else: a
mirror, a door, a torrent or a USB stick. The signed hash lists are the check, so a copy passes or fails the same way
wherever it came from:

1. `sha256sum -c SHA256SUMS` (on macOS, `shasum -a 256 -c SHA256SUMS`): the downloads are whole. The release notes list
   the same sha256 of each zip and of the `.tgz`, and the build id and bundle sha256 of the identity page, so an identity
   page served from anywhere can be compared with its release (`<meta name="mw-idp-build">` in its `index.html`).
2. Unzip `felinar-<version>-dist.zip` and `felinar-<version>-idp.zip`, then run
   `node tools/verify-release.mjs verify <unzipped>/dist --list hashes-dist.json --sig hashes-dist.json.sig --pubkey <the key above> --expect-version <version> --expect-tree dist`
   and the same for `<unzipped>/dist-idp` with `hashes-idp.json` and `--expect-tree dist-idp`: the lists carry the
   pinned key's signature, they are the release you meant to get (a genuine older release is refused), and every file
   matches its list. The OK line names the release. The tool reads nothing from the network and needs neither `gh` nor a
   GitHub account; once a release key is built into your copy of the tools, it refuses a list signed by any other key.
3. Extra evidence for a copy that came from GitHub: for each file,
   `gh attestation verify <file> --repo ashkanshokry25-maker/felinar --signer-workflow ashkanshokry25-maker/felinar/.github/workflows/release.yml --source-ref refs/tags/v<version> --source-digest <the tag's commit>`:
   the release workflow built it, from that tag and commit (an attestation checked with `--repo` alone accepts any
   workflow, branch or commit of the repository). It says where the bytes were built, not who approved them: step 2
   does that.

### Installing the command-line package

Install scripts stay off: `npm install -g --ignore-scripts ./felinar-<version>.tgz`. With npx outside a clone, set
`npm_config_ignore_scripts=true` first. In a clone, `npm ci` reads the clone's `.npmrc` (`ignore-scripts=true`). No
command needs a script to run; the one optional native binding is the WebRTC module that `felinar seed` uses, and
`seed` prints the single command that builds only it (`npm rebuild node-datachannel --ignore-scripts=false`) and what it
downloads.

The check that needs no key is to build the tagged commit yourself (`node build.mjs --strict`) and compare
(`node tools/verify-release.mjs list dist --out <file>`). If a release was replaced after you downloaded it, the
immutable-release record and the attestation will disagree with the file you hold; treat that as a security report.
