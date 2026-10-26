# Publish checklist

What the repository owner does, in order, to publish felinar for the first time, and again before each release.
Run every command yourself, from the root of your clone, on your own machine. Agents never push, tag, create a
repository or a release, and never hold your GitHub credentials; CI creates the release only when you push the tag.
Steps that change GitHub are marked "(owner)".

**The first public release is felinar 0.3.0. Do not publish 0.2.1.** 0.2.1 was never tagged, and the red team of the
v0.3 design review found seven defects in it that work today: MF-27, MF-28, MF-30 and MF-73 to MF-76 (section 0 lists
them). 0.3.0 fixes MF-27, MF-28 and MF-73 to MF-76, and fixes MF-30 in part (its signed `minSeq` is proposed). 0.3.0 is
a pre-1.0 release. The release gate on real devices ([DEMO-RESULTS.md](DEMO-RESULTS.md)) has not run, so the
repository, the release notes and the README must not call it production-ready.

The project was named magnet-web until v0.3, then Lightweb for one day (never published), and is now felinar ("the
light web": sites in plain sight, visible by design, no backend). Every command below uses the new name: the repository
`felinar`, the package `felinar`, the scoped package `@felinar/verify`, the command `felinar`. The old commands
`magnet-web` stays as an alias for one release (the `bin` field of `package.json` lists both; the `lightweb` alias went with the name, since nothing was published under it) and goes
in the release after 0.3.0. If you already created a
repository under the old name, read "A repository under the old name" in section 11 before you push: the
`gh repo create` of sequence step 6 fails when the repository exists.
Names that did not change, for compatibility: the SDK global `mw`, every `mw-` prefix, the `/_mw/` routes, the wire
extension names and every on-disk format (the changelog says so under "Renamed to felinar").

## 0. The release and the defects it fixes

0.3.0 carries everything in the changelog block `## [Unreleased] - 0.3.0`: the site ledger and its freeze group, the
identity origin and `mw-signin-v1`, sealed records, `mw_chat1` chat and rooms, private photos and videos, calls, smart
seeding, the zero-setup ladder, doors and the `examples/social` demo, on top of the 0.2.1 work. The 0.2.1 block stays
in the changelog as history, headed "0.2.1 - never published; superseded by 0.3.0".

- [ ] The seven defects of 0.2.1 that work today, as numbered in
  [review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md) (section 1.1 item 7, section H, 2.16.4), each fixed in
  the 0.3.0 tree with a regression test (MF-30 in part, as its row says). Read the rows once before you publish; none
  may be reopened:

| MF | The defect in 0.2.1 | Where the fix is described |
|---|---|---|
| MF-73 | One 205-byte HELLO frame freezes a tab (`d` unbounded; PEER A1) | 2.16 |
| MF-74 | Wire caps bypassed by one reused peer id; ignored peers keep slots; idle wires never closed (PEER A2, A3, A10) | 2.16 |
| MF-75 | Signature verified before policy; the throttle bypassed by a backdated `ts`; `ut_metadata` amplification (PEER A4, A5) | 2.16 |
| MF-76 | Web seeds from unsigned magnet links probe loopback and LAN hosts (PEER A9) | 2.16 |
| MF-27 | Moderator keys extractable in IndexedDB; moderation without a gesture (HUB H2) | 2.5.3 |
| MF-28 | A stolen owner key rotates silently and can freeze ownership (`rot=`; HUB H3, PTR A5) | 2.5.3 |
| MF-30 | Loader state: withdrawal and pointer replay to cold devices, uncapped DNS TTL, first-use trust (HUB H4, PTR A2 to A9). Fixed except its signed `minSeq`, which is (proposed): the withdrawal expiry and two-source disagreement cover the cold-device replay meanwhile ([ROADMAP.md](ROADMAP.md)) | 2.16 |

  Why these seven: the review's must-fix list marks three rows "(works today)" (MF-27, MF-28, MF-30), and its section
  H lists the defects of the 0.2.1 transport (MF-73 to MF-76). Section H also holds MF-77 (reaction and follow
  stuffing, rendezvous poisoning), which concerns the social features that v0.3 adds rather than 0.2.1 as it stood:
  0.3.0 has its author-scoped keys, and its rendezvous part is open (SYB A10, [ROADMAP.md](ROADMAP.md)). The verdict
  (R 1.1 item 7) names six works-today blockers in other words: three are rows of this table (PEER A1 is MF-73, HUB H2
  is MF-27, HUB H3 and PTR A5 are MF-28), and the other three are must-fix rows that 0.3.0 answers with the freeze
  group and the release program: MF-24 (open ledgers fill to the cap: the reserved byte pool), MF-04 (ledger-id
  squatting through `lo=`: the `org=` check) and MF-78 (unsigned, replaceable releases: section 16.7). Every list of
  the 0.2.1 defects in the documents (the changelog, [THREAT-MODEL.md](THREAT-MODEL.md)) names these seven numbers.
- [ ] The changelog's "Breaking" block says what a 0.2.1 peer cannot read (`unknown-op`), what changed for a site
  written against the 0.2.1 SDK, and how a 0.2.1 posting key moves into the identity origin at the first sign-in.
  Nothing public ever ran 0.2.1, so no outside site breaks.

## The whole sequence

Nothing of the project leaves this machine before step 5b, and nothing from step 5b on is reversible: npm keeps a
published version number for good, and a public repository, its tags and its releases stay public ("If something goes
wrong"). So step 1b answers every go or no-go of section 9 before step 3 freezes the tree, and step 5b starts with a
gate line that must print "go". Until it does, you make no npm organisation, and every line that publishes a package
or puts the code on GitHub does nothing: those of steps 5b and 6, their copies in sections 11 and 16.5, and the routes
of section 11 that replace step 6 carry the same guard.

Every command of this page in the order you run it, except three kinds that stay in their sections: the checks of
sections 2, 3, 5, 7 and 9, which print things for you to read before the squash of step 5; the commands for another
route, an option or a repair (the replacements of section 3, a pin `MISMATCH` in section 6, the `--private` route, a
repository under the old name and `felinar` kept off npm in section 11, the optional homepage demo of section
12, the manual release of section 14 and "If something goes wrong"); and the commands that wait for something outside
the sequence: only if you later run a shared default identity origin, the search of section 16.6, and the real `ship` of
section 17, on a server you rent (step 12 is its rehearsal). The sections below explain each command. `OWNER` is the
placeholder for the GitHub account or organisation that will own the repository: set the shell variable once and
every command uses it. `TAG_DATE` is the day you tag, `DEMO_DOMAIN` the host name of the optional homepage demo,
empty by default because 0.3.0 runs no demo (section 12), `REVIEW_ROUND` and `TEXTS_REVIEW_DATE` the answers of step 1b that step 3 writes into the changelog,
`RELEASE_KEY` the path of the release signing key on a drive you keep offline and `RELEASE_PUB` its public key
(section 16.7), `GATE` the answer of the gate line of step 5b and `RELEASE_DATE` the day of the tag (step 11c). The
sequence takes days or weeks (CI, the release environment and the owner steps): in a new shell, set the variables again, and run the
gate line of step 5b again before step 6.

The commands work in bash and zsh. In an interactive zsh, run `setopt interactive_comments` first: without it zsh
doesn't treat `#` as the start of a comment.

```sh
# 1. Set up and decide (sections 1 and 3). npm view answers E404 while a name is free (section 1). It shows packages
#    only: whether the scope @felinar of the sign-in verifier is free shows when step 5b makes the organisation, after
#    the gate line (section 16.5)
export OWNER=your-github-account
export TAG_DATE="$(date +%F)"
export DEMO_DOMAIN=    # empty: no homepage demo (section 12); "$OWNER.github.io" for the free route
git config --local user.name "Your public name"
git config --local user.email "<id>+<username>@users.noreply.github.com"
npm view felinar name version
npm view @felinar/verify name version

# 1b. The go or no-go of section 9, before anything else changes the tree: the answers change files that steps 3 to 5
#     freeze, date and squash, and nothing may leave this machine while one is open. A "no" stops the sequence.
#     (1) The review round of R 5.3: it ran from 2026-10-22 to 2026-10-24 and its confirmed blockers are fixed (section 9;
#     V03-DESIGN-REVIEW 5.4). (2) The texts review: no lawyer
#     reviews the privacy texts (the owner's decision of 2026-10-22); AI research agents checked them against the code and
#     against published law in its place (section 16.3), and that review's changes are applied first. (3) The 4 open
#     end-to-end rows: run each one, accept it as open or make it a blocker. (4) axe-core: answered, it is a development
#     dependency since 2026-10-22 (section 9). (5) Security reporting (section 16.8): answered, no mailbox, because the
#     project holds no domain: GitHub's private vulnerability reporting (step 7 turns it on), and as a fallback a public
#     issue that asks only for contact, with the details encrypted to SECURITY-KEY.asc (regenerated 2026-10-25; its user
#     id names no e-mail address). (6) The export decision (section 16.12). Then write down the answers to 1 and 2
#     for step 3, which refuses to run without the date of the texts review:
export REVIEW_ROUND="ran on 2026-10-24, and its blockers are fixed"    # the review round of R 5.3 (section 9)
export TEXTS_REVIEW_DATE=2026-10-24  # the day the texts review ended (AI research agents; no lawyer reviewed the texts)
#     Security reporting: the first line must print the fingerprint 4C44 C2A8 D935 27B7 4C88 1E20 A46F 0FB0 E1F8 0C26, the
#     second nothing (no e-mail address in the key's user id), and the grep 1 or more for each file; step 7 checks that
#     private reporting is on:
gpg --show-keys --with-fingerprint SECURITY-KEY.asc
gpg --show-keys --with-colons SECURITY-KEY.asc | grep '^uid:' | grep -F '@'
grep -c -F '4C44 C2A8 D935 27B7 4C88 1E20 A46F 0FB0 E1F8 0C26' SECURITY.md README.md
#     The sentences the answers made false (a promised lawyer's review, a promised mailbox, the axe-core decision open): change
#     each one to the answer, until the first search prints nothing (11 lines on 2026-10-21, none on 2026-10-24; the gate
#     line of step 5b runs it again). The second runs only if the review round ran: it lists every line that calls v0.3
#     "not yet reviewed" or names the review round (about 150 lines on 2026-10-24, most of them saying that it ran);
#     change each one that says the round has not run
git grep -n -i -E 'for counsel.s review|for the same review|counsel review before release|reviewed by counsel, before|counsel reviews it before|no security mailbox|waits? for the owner' -- README.md SECURITY.md CHANGELOG.md ':(glob)docs/*.md' ':(glob)docs/recipes/*.md' ':(glob)examples/*/*.md' ':(exclude)docs/PUBLISH-CHECKLIST.md'
case "$REVIEW_ROUND" in ran*) git grep -n -i -P 'not yet reviewed|(?<!code )review round(?! [12]\b)' -- README.md SECURITY.md CHANGELOG.md ':(glob)docs/*.md' ':(glob)docs/recipes/*.md' ':(glob)examples/*/*.md' ':(exclude)docs/PUBLISH-CHECKLIST.md';; esac

# 2. Replace the OWNER placeholders (section 4); the last command must print nothing
: "${OWNER:?set OWNER first}"
git grep -lz -P '(github\.com/|@)OWNER\b|OWNER/(REPO|felinar)' -- . ':(exclude)docs/PUBLISH-CHECKLIST.md' ':(exclude)docs/research' ':(exclude)docs/review' ':(exclude)docs/deviations' \
  | xargs -0 perl -pi -e 's{OWNER/(?:REPO|felinar)}{$ENV{OWNER}/felinar}g; s{\@OWNER\b}{\@$ENV{OWNER}}g'
git grep -n -P '(github\.com/|@)OWNER\b|OWNER/(REPO|felinar)' -- . ':(exclude)docs/PUBLISH-CHECKLIST.md' ':(exclude)docs/research' ':(exclude)docs/review' ':(exclude)docs/deviations'

# 3. Freeze the golden vectors and date the changelog (section 8): the node command must print count 226 and the head
#    that the first perl line appends (d3c50559... at the last check; the grep keeps it from appending twice). The if
#    block writes the status of 0.3.0 and the lines the release notes must carry, with the answers of step 1b, and
#    rewords the line of "Added" that says the workflows never ran, which the first CI run makes false (section 15);
#    it prints STOP without the answers. git diff shows the changelog edit: change a release-notes line that is not
#    true for you (a second maintainer, a hub; section 11 gives the line for felinar kept off npm)
node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const lock = JSON.parse(readFileSync("test/vectors/LOCK.json", "utf8"));
let head = sha("mw-vectors-v1");
for (const e of lock.entries) head = sha(head + "\n" + e.file + "\n" + e.id + "\n" + e.sha256);
console.log(JSON.stringify({ count: lock.entries.length, head }));
'
grep -q '}, // v0.3.0$' test/unit/formats-vectors.test.mjs || perl -0pi -e "s|(\{ count: 28, head: '97ec17dc96e8d359e8cde663d983126c200f8d3862b91ae1f6f6b2c11853765c' \}, // v0\.2\.1, 2026-10-19\n)|\$1  { count: 226, head: 'd3c50559f823ae0ba3576a9c172f7c36aaa22ecc6664f2b370424c5799effe3c' }, // v0.3.0\n|" test/unit/formats-vectors.test.mjs
if printf '%s\n' "$TEXTS_REVIEW_DATE" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' && [ -n "$REVIEW_ROUND" ] && [ -n "$TAG_DATE" ]; then
  perl -0pi -e 's{^## \[Unreleased\] - 0\.3\.0\n\nNot released yet\.[^\n]*\n(?:[^\n]+\n)*}{## [Unreleased]\n\n## [0.3.0] - $ENV{TAG_DATE}\n\nPre-release, and the first public release: 0.2.1 was never published, because the red team of the v0.3 design review found seven defects in it that work today (MF-27, MF-28, MF-30 and MF-73 to MF-76). 0.3.0 fixes MF-27, MF-28 and MF-73 to MF-76, and fixes MF-30 in part: its signed `minSeq` is proposed, and the withdrawal expiry and two-source disagreement cover the cold-device replay meanwhile. The review round of the v0.3 design review (Part 5.3, the judges and the red-team attackers against the built code) $ENV{REVIEW_ROUND}. Of the other steps a release needs, the release gate on real devices has not run beyond the desktop parts of six rows, in a Brave browser on loopback ([docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md)), Firefox ran only in the automated harness, and the outside review of the new cryptographic code that R 2.19 asks for before 1.0 has not happened. No lawyer has reviewed the privacy texts (the cards, the v0.3 sections of [docs/PRIVACY.md](docs/PRIVACY.md) and the safe harbour of [SECURITY.md](SECURITY.md)): the owner decided against it, and AI research agents checked them against the code and against published law and regulator guidance in its place, in a review that ended on $ENV{TEXTS_REVIEW_DATE}. That review is research, not legal advice. Every test below ran on loopback only (Apple M3, Playwright Chromium 156, WebKit 27.2 and Firefox 157.0).\n\nHow this release was made:\n\n- One maintainer made it: the person who pushed the tag also approved the environment "release" that the attest and release jobs wait for, and no second person reviewed the lock files, so the two-person rule of R 2.19 is not met ([SECURITY.md](SECURITY.md), "The security program for 1.0").\n- `felinar` and `\@felinar/verify` were published to npm by hand, so neither carries npm provenance: no workflow publishes to npm ([docs/ROADMAP.md](docs/ROADMAP.md), release provenance).\n- No hub runs for this release: without one, `examples/social` runs as personal sites with a hub-less follow lane.\n- The signed per-file hash lists are the check of this release: `node tools/verify-release.mjs verify`, offline and under the release key built into the tools, accepts a copy of these files from any mirror, door, torrent or USB stick just as it accepts a download from GitHub, and the build provenance attestation is extra evidence for a copy that came from GitHub ([SECURITY.md](SECURITY.md), "Checking a release"). The checksums below give the sha256 of each zip and of the package, and the build id and bundle sha256 of the identity page. The project holds no domain: reports go through private vulnerability reporting on GitHub, and the places to compare the release key with are the tag message, `release-key.txt` with its OpenPGP signature and an archive copy of SECURITY.md. They protect against a takeover of the GitHub account after the release, not against the owner, who controls all of them.\n- The zero-setup route (`felinar ship` with a nip.io or sslip.io name; [docs/DEPLOY.md](docs/DEPLOY.md), "Zero-setup: a server without a domain") is not a domain of your own: the name changes if the IP address of the server changes, visitors who already opened the site keep their saved copy if the DNS service stops, and the box is one server, not a backend. It is a stepping stone to a domain you own, where the pointer can also live in DNS. Its rows G-ZS1 to G-ZS4 have not run.\n}m; s{^\[Unreleased\]: (https://github\.com/[^/]+/felinar)/commits/main$}{[Unreleased]: $1/compare/v0.3.0...HEAD\n[0.3.0]: $1/releases/tag/v0.3.0}m' CHANGELOG.md
  perl -0pi -e 's{ CI,\n  release \(it stops at a draft\) and rebuild workflows, never run\.\n}{ CI,\n  release (it stops at a draft) and rebuild workflows, none of which had run on GitHub before 0.3.0 was pushed.\n}' CHANGELOG.md
  perl -0pi -e 's{to be copied into `CADDY_IMAGE`, and it has not run \(nothing was\n  pushed\)\.}{to be copied into `CADDY_IMAGE`, and it had not run before 0.3.0 was pushed.}' CHANGELOG.md
else
  echo "STOP: step 1b sets REVIEW_ROUND and TEXTS_REVIEW_DATE, and step 1 TAG_DATE"
fi
git diff CHANGELOG.md

# 3b. The release key (section 16.7): made once, on a drive you keep offline, never inside the clone, and pinned in
#     README.md, SECURITY.md and PINNED_RELEASE_KEYS in tools/verify-release.mjs, before the squash of step 5 and the
#     npm publish of step 5b, so every package, zip and clone of the release carries the key and its verify refuses a
#     list signed by any other key. The second places that need no domain (the tag message, release-key.txt with its
#     OpenPGP signature, an archive copy of SECURITY.md) come at steps 10 and 10b. The if block pins it only when
#     the key's folder exists outside the clone, keygen makes a new key and the file parses as a P-256 private key;
#     otherwise it prints STOP and changes nothing (correct the path and run the block again). The loop must print
#     "pinned" for all three files; "NOT PINNED" (no key, a blank one or another one) is a stop. In a later shell:
#     export RELEASE_PUB=<the p256: key that SECURITY.md now shows>
export RELEASE_KEY="/Volumes/YOUR-OFFLINE-DRIVE/felinar-release.jwk"
keydir="$(cd -P "$(dirname "$RELEASE_KEY")" > /dev/null 2>&1 && pwd -P)"
if [ -n "$keydir" ] && case "$keydir/" in "$(pwd -P)"/*) false;; esac && node tools/keygen.mjs --out "$RELEASE_KEY" \
  && RELEASE_PUB="$(node --input-type=module -e 'import { loadOwnerKey } from "./tools/lib.mjs"; console.log((await loadOwnerKey(process.argv[1])).pub)' "$RELEASE_KEY")"; then
  export RELEASE_PUB && perl -pi -e 's{RELEASE-KEY-NOT-PINNED-YET}{$ENV{RELEASE_PUB}}g' README.md SECURITY.md \
    && perl -pi -e 's{^export const PINNED_RELEASE_KEYS = Object\.freeze\(\[\]\);$}{export const PINNED_RELEASE_KEYS = Object.freeze([\x27$ENV{RELEASE_PUB}\x27]);}' tools/verify-release.mjs
else
  echo "STOP: no key was made or pinned (the folder is missing or inside the clone, the file exists, or it is no P-256 key)"
fi
for f in README.md SECURITY.md tools/verify-release.mjs; do case "$f" in *.mjs) want="Object.freeze(['$RELEASE_PUB'])";; *) want="\`$RELEASE_PUB\`";; esac; case "$RELEASE_PUB" in p256:?*) grep -q -F "$want" "$f" && echo "pinned $f" || echo "NOT PINNED $f";; *) echo "NOT PINNED $f";; esac; done

# 3c. The sentences that publishing to npm makes false (section 11), changed before the squash so that the npm package
#     and the pushed commit carry the new text; skip it if you do not publish felinar (section 11 says what changes
#     then). The perl lines are the table of section 11; the git grep must print one line, the 0.2.1 history of
#     CHANGELOG.md
perl -0pi -e 's{\n  "private": true,\n}{\n}' package.json
perl -0pi -e 's{<a href="#status-and-roadmap"><img alt="npm: not published yet" src="https://img\.shields\.io/badge/npm-not%20published%20yet-lightgrey\.svg"></a>}{<a href="https://www.npmjs.com/package/felinar"><img alt="npm version" src="https://img.shields.io/npm/v/felinar.svg"></a>}; s{\*\*Status: 0\.3\.0, pre-release \(not published yet\)\.\*\*}{**Status: 0.3.0, a pre-release.**}; s{runs this clone.s `bin/felinar\.mjs` \(the package isn.t on npm yet\)\.}{runs this clone\x27s `bin/felinar.mjs`; outside a clone it runs the `felinar` package from npm.}; s{pre-release, and the first release planned for the public:}{pre-release, and the first public release:}' README.md
perl -0pi -e 's{runs the matching tool from a clone of this repository \(the package isn.t on npm\nyet\):}{runs the matching tool, from a clone of this repository or from\nthe npm package `felinar`:}' docs/DEPLOY.md
perl -0pi -e 's{dependencies; not published to npm\)}{dependencies; on npm, published by hand)}' CHANGELOG.md
perl -0pi -e 's{- The package is not published to npm \(`package\.json` has `"private": true`\)\. The `felinar` command runs from a\n  clone of the repository, or from the package attached to the GitHub Release \(`npm install -g \./felinar-0\.3\.0\.tgz`\);\n  `build` and `demo` still need a clone\. `\@felinar/verify` is not published either: servers copy\n  `packages/verify/verify\.js` \(\[docs/recipes/signin-server-node\.md\]\(docs/recipes/signin-server-node\.md\)\)\.\n}{- `felinar` and `\@felinar/verify` are on npm, published by hand, so neither carries npm provenance (no workflow\n  publishes to npm). `build` and `demo` still need a clone of the repository, and a server can copy\n  `packages/verify/verify.js` instead of installing the package ([docs/recipes/signin-server-node.md](docs/recipes/signin-server-node.md)).\n}' CHANGELOG.md
perl -0pi -e 's{Until the owner publishes the package \(\[PUBLISH-CHECKLIST\.md\]\(\.\./PUBLISH-CHECKLIST\.md\), section 16\), copy `packages/verify/verify\.js`}{Install it with `npm install \@felinar/verify`, or copy `packages/verify/verify.js`}' docs/recipes/signin-server-node.md
git grep -n -E "isn.t on npm|not published (yet|to npm|either)|not%20published|Until the owner publishes the package|first release planned|\"private\": true" -- package.json README.md CHANGELOG.md docs/DEPLOY.md docs/recipes/signin-server-node.md

# 4. Test everything once more (section 6); the browser tests need the playwright install once per machine, and
#    test:browser needs the build first (without it, tools-v03-pin-browser skips)
npm ci && npx playwright install chromium webkit firefox
npm test && npm run build && node build.mjs --check-lock
npm run test:browser && npm run test:example && npm run test:e2e && npm run test:e2e:webkit && npm run test:e2e:firefox
npm run test:fuzz && npm run build:idp

# 4b. Every action is pinned to a commit hash (the first command must print nothing), and every pin is the commit of
#     its tag in the repository of the action (section 6): every line of the loop must start with "ok"
git grep -n -E 'uses: *[^ ]+@' -- .github/workflows deploy | grep -v -E '@[0-9a-f]{40}'
git grep -h -o -E 'uses: *[^ ]+@[0-9a-f]{40} *# *v[0-9][0-9.]*' -- .github/workflows deploy | sed -E 's/uses: *//; s/ *# */ /' | sort -u | while read -r ref tag; do
  action="${ref%@*}"; sha="${ref#*@}"
  got="$(git ls-remote "https://github.com/$action" "refs/tags/$tag" "refs/tags/$tag^{}" | tail -1 | cut -f1)"
  if [ "$got" = "$sha" ]; then echo "ok       $action $tag"; else echo "MISMATCH $action $tag: pinned $sha, the tag is ${got:-missing}"; fi
done

# 5. Squash the checkpoint history into one commit (section 10). Only that commit is ever pushed: the history holds
#    the private TLS key of the w1-13 lab and the home path and username of the build machine. First end every agent
#    session on this machine (Claude Code chats and the workflows they run): an agent session restarts the checkpoint
#    loop at each milestone (section 4 of the agents' resume notes in .orchestration/, which git ignores). Then stop
#    the loop, only if the stored pid still runs it. The last line must print "loop stopped" and nothing else: if
#    pgrep prints a process, end the session that started it, run pkill -f checkpoint.sh and run pgrep again
pid="$(cat .orchestration/checkpoint-loop.pid 2>/dev/null)"
ps -p "$pid" -o command= 2>/dev/null | grep -q checkpoint.sh && kill "$pid"
sleep 1; pgrep -fl checkpoint.sh || echo "loop stopped"
git add -A && git commit -m "Prepare felinar 0.3.0"
#    a fresh clone of that commit passes (section 6):
fresh="$(mktemp -d)" && git clone . "$fresh/felinar" && (cd "$fresh/felinar" && npm ci && npm test && npm run build)
rm -rf "$fresh"
#    a safety copy of the old history, written under your temporary folder (which does not sync; it may be cleared on
#    reboot, so move it to a folder that does not sync if you want to keep it): never push, attach, upload or sync it
git bundle create "${TMPDIR:-/tmp}/felinar-checkpoints.bundle" --all
git checkout --orphan release && git add -A && git commit -m "felinar 0.3.0"
#    the diff must print nothing, and the log must show one commit, with your author:
git diff --stat main release
git branch -M release main
git log --format='%h %an <%ae> %s'

# 5b. Claim the npm names before the README and its npx commands are public (sections 11 and 16.5, owner). The first
#     step that leaves this machine, and npm keeps 0.3.0 for good: the gate line must print "go". STOP means a go or
#     no-go of step 1b, the status of step 3 or the key of step 3b (in SECURITY.md or in tools/verify-release.mjs) is
#     missing, or a tracked file names a project domain ("felinar." and dev, app, ca, io, com, org or net), which the
#     project does not hold and whoever registers could use to receive reports or publish a key
#     (test/unit/docs-domain-free.test.mjs runs the same search), and the publish lines then do nothing.
#     After "go", and not before, open https://www.npmjs.com/org/create and make the organisation "felinar", the
#     scope of @felinar/verify (an organisation holds no code). If the name is taken, stop: nothing is published yet,
#     so rename the scope wherever git grep -n '@felinar/' finds it, run the steps it touches again and squash again
#     ("If something goes wrong"). npm view must still answer E404 for both names. Skip the felinar lines if you
#     switched the documents to a scoped name or to node bin/felinar.mjs; the second publish line publishes
#     @felinar/verify by hand, so it carries no npm provenance (section 16.5). This runs before the first CI run on
#     GitHub (step 6): a fix that run needs in a file of the package goes out as 0.3.1 ("If something goes wrong"; the
#     private route of section 11 runs CI first). Each publish line writes the commit it published into .git (never
#     pushed), for the check of step 10. The last three lines print the hash of the verify.js that npm now serves and
#     the sha256 line of packages/verify/README.md, which must show the same hash (section 16.5). Before the gate line, settle the export decision of
#     section 16.12: the first public copy of the encryption source code is the npm package `felinar` (or, if you skip
#     those lines, the repository of step 6)
if grep -q 'No lawyer has reviewed the privacy texts' CHANGELOG.md && grep -Eq '^`p256:[A-Za-z0-9_-]{87}`$' SECURITY.md \
  && grep -Eq "^export const PINNED_RELEASE_KEYS = Object\.freeze\(\['p256:[A-Za-z0-9_-]{87}'\]\);$" tools/verify-release.mjs \
  && ! git grep -q -I -i -P 'felinar\.(dev|app|ca|io|com|org|net)\b' \
  && ! git grep -q -i -E 'for counsel.s review|for the same review|counsel review before release|reviewed by counsel, before|counsel reviews it before|no security mailbox|waits? for the owner' -- README.md SECURITY.md CHANGELOG.md ':(glob)docs/*.md' ':(glob)docs/recipes/*.md' ':(glob)examples/*/*.md' ':(exclude)docs/PUBLISH-CHECKLIST.md'
then GATE=go; else GATE=STOP; fi; echo "$GATE"
npm view felinar name version
npm view @felinar/verify name version
npm login
npm publish --dry-run
[ "$GATE" = go ] && npm publish --access public && git rev-parse HEAD > "$(git rev-parse --git-dir)/felinar-npm-commit"
[ "$GATE" = go ] && (cd packages/verify && npm publish --dry-run && npm publish --access public) && git rev-parse HEAD > "$(git rev-parse --git-dir)/felinar-npm-commit"
npm pack @felinar/verify --pack-destination "${TMPDIR:-/tmp}"
tar -xOzf "${TMPDIR:-/tmp}/felinar-verify-0.3.0.tgz" package/verify.js | shasum -a 256
grep -n 'sha256' packages/verify/README.md

# 6. Create the public repository and push main (section 11, owner): from here the code is public for good, and the
#    push is the first real run of the workflows. GATE must still say "go" (in a new shell, run the gate line of step
#    5b again; without it the gh repo create line does nothing), and no checkpoint loop may run (the first line must
#    print "loop stopped" and nothing else); gh auth status shows the account that creates the repository; gh run
#    watch asks which run to follow. If a repository exists under the old name, section 11 replaces the gh repo
#    create line with lines that carry the same guard
pgrep -fl checkpoint.sh || echo "loop stopped"
gh auth login
gh auth status
[ "$GATE" = go ] && gh repo create "$OWNER/felinar" --public --source . --remote origin --push
gh run watch --repo "$OWNER/felinar"

# 7. Description, topics, Discussions, merge settings and security settings (section 12, owner). The homepage is set
#    only when you run a demo (DEMO_DOMAIN, section 12). Private vulnerability reporting is the route SECURITY.md gives
#    reporters, and the project has no other: the last line must print true
gh repo edit "$OWNER/felinar" --description "felinar: websites loaded by magnet link, verified in your browser, from a plain static host. No backend. The light web." \
  --add-topic webtorrent,bittorrent,magnet-link,peer-to-peer,p2p,webrtc,service-worker,static-site,static-hosting,web-seed,site-ledger,no-backend \
  --enable-issues --enable-discussions --enable-wiki=false \
  --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false --delete-branch-on-merge
[ -n "$DEMO_DOMAIN" ] && gh repo edit "$OWNER/felinar" --homepage "https://$DEMO_DOMAIN/"
gh repo edit "$OWNER/felinar" --enable-secret-scanning --enable-secret-scanning-push-protection
gh api --method PUT "repos/$OWNER/felinar/private-vulnerability-reporting"
gh api --method PUT "repos/$OWNER/felinar/vulnerability-alerts"
gh api --method PUT "repos/$OWNER/felinar/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
gh api "repos/$OWNER/felinar/private-vulnerability-reporting" --jq .enabled

# 8. The homepage demo is optional, and 0.3.0 runs none (section 12, owner): a hosted demo makes you its operator
#    (docs/PRIVACY.md), and the loader needs the root of an origin, which this repository's project site under
#    /felinar/ is not. Without a demo, turn off .github/workflows/pages-demo.yml, which would fail on every push to
#    main. If you want one later, section 12 gives the free route, a repository named $OWNER.github.io
[ -z "$DEMO_DOMAIN" ] && gh workflow disable pages-demo.yml --repo "$OWNER/felinar"

# 8b. The labels that CONTRIBUTING.md names; site_compat_report.yml applies compatibility (section 12, owner)
while IFS='|' read -r name color desc; do gh label create "$name" --repo "$OWNER/felinar" --color "$color" --description "$desc" --force; done <<'EOF'
compatibility|fbca04|A site, framework or host that does not migrate cleanly
rfc|5319e7|Proposal to change the specification, a frozen format or the security model
needs-repro|d4c5f9|Waiting for steps, a pointer or a browser version
needs-device|d93f0b|Needs a real phone or a browser the test setup cannot launch
release-gate|b60205|A failure from the manual release gate; blocks 1.0
upstream|cfd3d7|Caused by WebTorrent, bittorrent-tracker or a browser
roadmap: next|0e8a16|Roadmap tier: next (0.4)
roadmap: 1.0|0e8a16|Roadmap tier: 1.0
roadmap: later|c2e0c6|Roadmap tier: later
EOF

# 8c. The social preview (section 12, owner): export a PNG of 1280 by 640 pixels, for example like this, then
#     upload it under Settings, General, Social preview
rsvg-convert -w 1280 -h 640 docs/assets/social-preview.svg -o social-preview.png

# 9. Protect main once CI has passed on it (section 13, owner)
gh run watch --repo "$OWNER/felinar" --exit-status "$(gh run list --repo "$OWNER/felinar" --workflow ci.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh api "repos/$OWNER/felinar/commits/main/check-runs" --jq '.check_runs[].name'
gh api --method PUT "repos/$OWNER/felinar/branches/main/protection" --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["test (Node 22)", "test (Node 24)", "reproducible pack", "deploy files", "one-box files"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "dismiss_stale_reviews": true, "required_approving_review_count": 0 },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF

# 9b. The release settings of section 16.7, before the first tag (owner). In the browser: Settings, General, Releases,
#     "Enable release immutability". Then the tag ruleset (no deletion, no update, no force push of the tags v*) and
#     the environment "release" with a required reviewer and a rule that only the tags v* deploy to it. With one
#     maintainer the reviewer is you, and the release notes that step 3 wrote say so; with two, put the id of the one
#     who does not push the tag. The last command must list required_reviewers and branch_policy
gh api --method POST "repos/$OWNER/felinar/rulesets" --input - <<'EOF'
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "update" }, { "type": "non_fast_forward" }]
}
EOF
gh api --method PUT "repos/$OWNER/felinar/environments/release" --input - <<EOF
{
  "reviewers": [{ "type": "User", "id": $(gh api user --jq .id) }],
  "prevent_self_review": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
EOF
gh api --method POST "repos/$OWNER/felinar/environments/release/deployment-branch-policies" -f name='v*' -f type=tag
gh api "repos/$OWNER/felinar/environments/release" --jq '[.protection_rules[].type]'

# 10. Tag v0.3.0 (section 14, owner): .github/workflows/release.yml builds, tests, packs and attests, and leaves a
#     DRAFT release. The attest and release jobs wait for your approval in the environment "release" (step 9b). The
#     tag ruleset of step 9b keeps the tag for good: never tag v0.3.0 twice, and never tag v0.2.1. The if line tags
#     only when no file of the npm packages changed since the commit that step 5b published and RELEASE_PUB is the key
#     that SECURITY.md shows; it prints STOP and the changed files otherwise, and then 0.3.1 is the release ("If
#     something goes wrong"; for a missing RELEASE_PUB, set it as step 3b says and run the lines again). The tag message
#     carries the line "Release key: p256:...", one of the second places of SECURITY.md
npm_commit="$(cat "$(git rev-parse --git-dir)/felinar-npm-commit" 2>/dev/null)"
d="$(git diff --stat "${npm_commit:-HEAD}" HEAD -- package.json README.md LICENSE bin src tools build.mjs build.lock.json npm-shrinkwrap.json test/e2e/browser-args.mjs packages/verify 2>&1)"
if [ -n "$npm_commit" ] && [ -z "$d" ] && printf '%s\n' "$RELEASE_PUB" | grep -Eq '^p256:[A-Za-z0-9_-]{87}$' && grep -q -F "\`$RELEASE_PUB\`" SECURITY.md; then git tag -a v0.3.0 -m "felinar 0.3.0" -m "Release key: $RELEASE_PUB"; else printf '%s\n' "$d" "STOP: no tag; npm 0.3.0 is another commit, step 5b did not run (release 0.3.1 instead), or RELEASE_PUB is not the key SECURITY.md shows (step 3b)"; fi
git push origin v0.3.0
sleep 15
gh run watch --repo "$OWNER/felinar" --exit-status "$(gh run list --repo "$OWNER/felinar" --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh release view v0.3.0 --repo "$OWNER/felinar"

# 10b. Check the draft, build the tag yourself from this clone (not from GitHub), sign the two hash lists offline with
#      the release key only where they equal your build, verify the signatures, sign release-key.txt with the project's
#      OpenPGP key (gpg asks for its passphrase), add the checksums and the identity page's build id and bundle sha256 to
#      the notes, upload, and publish the draft as a pre-release (section 14, owner). Both sign lines must print
#      "signed", both verify lines must start with "OK" and gpg must say "Good signature"; the last command publishes,
#      and with immutable releases on, no file or tag of v0.3.0 can change afterwards. Then save SECURITY.md at the tag
#      in an archive, in a browser: https://web.archive.org/save with https://github.com/$OWNER/felinar/blob/v0.3.0/SECURITY.md,
#      or Software Heritage's "Save code now" for the repository (section 16.7)
export RDIR="${TMPDIR:-/tmp}/mw-release"
gh release download v0.3.0 --repo "$OWNER/felinar" --dir "$RDIR"
(cd "$RDIR" && shasum -a 256 -c SHA256SUMS)    # Linux: sha256sum -c SHA256SUMS
gh attestation verify "$RDIR/felinar-0.3.0.tgz" --repo "$OWNER/felinar"
git clone -q --branch v0.3.0 --depth 1 "file://$(pwd -P)" "$RDIR/src" && (cd "$RDIR/src" && npm ci --ignore-scripts && node build.mjs --strict --out "$RDIR/rebuilt/dist" && node tools/build-idp.mjs --out "$RDIR/rebuilt/dist-idp")
node tools/verify-release.mjs sign --list "$RDIR/hashes-dist.json" --rebuilt "$RDIR/rebuilt/dist" --key "$RELEASE_KEY" --out "$RDIR/hashes-dist.json.sig"
node tools/verify-release.mjs sign --list "$RDIR/hashes-idp.json" --rebuilt "$RDIR/rebuilt/dist-idp" --key "$RELEASE_KEY" --out "$RDIR/hashes-idp.json.sig"
mkdir -p "$RDIR/unzipped" && unzip -q "$RDIR/felinar-0.3.0-dist.zip" -d "$RDIR/unzipped" && unzip -q "$RDIR/felinar-0.3.0-idp.zip" -d "$RDIR/unzipped"
node tools/verify-release.mjs verify "$RDIR/unzipped/dist" --list "$RDIR/hashes-dist.json" --sig "$RDIR/hashes-dist.json.sig" --pubkey "$RELEASE_PUB" --expect-version 0.3.0 --expect-tree dist
node tools/verify-release.mjs verify "$RDIR/unzipped/dist-idp" --list "$RDIR/hashes-idp.json" --sig "$RDIR/hashes-idp.json.sig" --pubkey "$RELEASE_PUB" --expect-version 0.3.0 --expect-tree dist-idp
printf '%s\n' "$RELEASE_PUB" > "$RDIR/release-key.txt" && gpg --local-user 4C44C2A8D93527B74C881E20A46F0FB0E1F80C26 --armor --detach-sign --output "$RDIR/release-key.txt.asc" "$RDIR/release-key.txt"
gpg --verify "$RDIR/release-key.txt.asc" "$RDIR/release-key.txt"
gh release view v0.3.0 --repo "$OWNER/felinar" --json body --jq .body > "$RDIR/notes.md"
node -e 'const fs = require("fs"); const d = process.argv[1]; const b = JSON.parse(fs.readFileSync(d + "/unzipped/dist-idp/build.json", "utf8")); fs.appendFileSync(d + "/notes.md", "\n### Checksums\n\n" + fs.readFileSync(d + "/SHA256SUMS", "utf8").trimEnd().replace(/^/gm, "    ") + "\n\nIdentity page (dist-idp): build id " + b.buildId + ", bundle sha256 " + b.bundleSha256 + ".\n")' "$RDIR"
gh release upload v0.3.0 "$RDIR/hashes-dist.json.sig" "$RDIR/hashes-idp.json.sig" "$RDIR/release-key.txt" "$RDIR/release-key.txt.asc" --repo "$OWNER/felinar"
gh release edit v0.3.0 --repo "$OWNER/felinar" --notes-file "$RDIR/notes.md"
gh release edit v0.3.0 --repo "$OWNER/felinar" --prerelease --draft=false

# 11. After publishing (section 15): a fresh clone of the public repository installs and passes
fresh="$(mktemp -d)" && git clone "https://github.com/$OWNER/felinar.git" "$fresh/felinar" && (cd "$fresh/felinar" && npm ci && npm test)
rm -rf "$fresh"

# 11b. Pin the site owners' workflow template to the release (section 15): a pull request that sets FELINAR_COMMIT in
#      deploy/github-actions/publish-site.yml to the commit of v0.3.0 (a file cannot name the commit it is part of, so
#      the tagged tree keeps the placeholder). Merge it once CI is green
git switch -c pin-template-v0.3.0
commit="$(git rev-parse 'v0.3.0^{commit}')" && perl -pi -e 's/^(  FELINAR_COMMIT: )0{40}/${1}'"$commit"'/' deploy/github-actions/publish-site.yml
git diff deploy/github-actions/publish-site.yml
git commit -am "ci: pin the site workflow template to v0.3.0"
git push -u origin pin-template-v0.3.0
gh pr create --repo "$OWNER/felinar" --fill

# 11c. The sentences the release and the first CI run made false (section 15), npm or not: one more pull request.
#      The perl lines are the rows of the table of section 15 that name step 11c (its README status rows are done
#      already if step 3c ran). They write the date of the tag, so they run only when this clone has the tag v0.3.0:
#      otherwise the if block prints STOP and changes nothing, and the last line commits and pushes nothing (run
#      git fetch origin tag v0.3.0, then the if block and the lines after it again). The git grep must print nothing.
#      Merge the pull request once CI is green
git switch main && git pull --ff-only origin main && git switch -c docs-0.3.0-released
if git rev-parse -q --verify 'refs/tags/v0.3.0^{tag}' > /dev/null; then
  export RELEASE_DATE="$(git for-each-ref --format='%(taggerdate:short)' refs/tags/v0.3.0)"
  git grep -lz -E 'release being prepared|first release planned for the public|pre-release \(not published yet\)|it has not run on GitHub yet' -- README.md SECURITY.md ':(glob)docs/*.md' ':(glob)deploy/*/README.md' ':(exclude)docs/PUBLISH-CHECKLIST.md' \
    | xargs -0 perl -0pi -e 's{\*\*Release status \(2026-10-21\):\*\* the tree is 0\.3\.0, the release being prepared and the first public one}{**Release status ($ENV{RELEASE_DATE}):** 0.3.0 is released, the first public one}; s{0\.3\.0, the release being prepared, a pre-release}{0.3.0, a pre-release}g; s{0\.3\.0, the release being prepared, }{0.3.0 }g; s{0\.3\.0, the release being prepared(?=[:.\s(])}{0.3.0}g; s{ \(the release being prepared\)}{}g; s{\*\*Status: 0\.3\.0, pre-release \(not published yet\)\.\*\*}{**Status: 0.3.0, a pre-release.**}; s{pre-release, and the first release planned for the public:}{pre-release, and the first public release:}; s{, job `deploy`; it has not run on GitHub yet\)}{, job `deploy`)}g'
else
  echo "STOP: this clone has no tag v0.3.0, so nothing was changed"
fi
git grep -n -E 'release being prepared|first release planned for the public|pre-release \(not published yet\)|it has not run on GitHub yet' -- README.md SECURITY.md ':(glob)docs/*.md' ':(glob)deploy/*/README.md' ':(exclude)docs/PUBLISH-CHECKLIST.md'
git commit -am "docs: 0.3.0 is released" && git push -u origin docs-0.3.0-released && gh pr create --repo "$OWNER/felinar" --fill

# 12. The zero-setup site, once the release is out (section 17; owner): rehearse with --dry-run, which contacts nothing,
#     then publish on a rented server named by its IP address (nip.io, with sslip.io as the second name)
npx felinar ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org --dry-run
```

## 1. Decide first

| Decision | Where it lands |
|---|---|
| The GitHub account or organisation, and the repository name | The shell variable `OWNER`, which replaces the placeholders (section 4). The commands assume the name `felinar`. |
| Your public identity | Commits and annotated tags carry the name and e-mail address of your git configuration, and everything pushed is public, history included (section 3). |
| Your name in the research notes | The post-wave fix replaced the build machine's home directory (`$HOME`) and the macOS username (`owner`) in all 105 tracked files that held them (2026-10-20), and the v0.3 verify fix round 2 in the two files written after it (2026-10-21). What is left is your first name in research notes and test fixtures, your hardware security key's model, the machine's short hostname and one public IP address in lab output: each line is listed in `docs/deviations/post-wave-fix.md`, "Owner decisions" (section 3). |
| The checkpoint history | Not a choice: it is never pushed. Only the one squashed commit of section 10 is pushed. The history is automatic `checkpoint:` commits (139 at 2026-10-21 04:31 ET) with a placeholder author; every commit from `735f349` until `621455b` removed it holds the private key of the w1-13 lab's `localhost` certificate, and every one from `735f349` until the privacy scrub (`3130928`) holds the build machine's home path and username, as do the two files that `9d5ab58` and `468f6eb` added after the scrub, until the v0.3 verify fix round 2 (2026-10-21). The history and the bundle that section 10 makes stay on this machine or are deleted. |
| The npm name | `felinar` answered 404 on the registry on 2026-10-22, and so did twelve variants such as `felinar-js`, `felinar-cli` and `@felinar/core` (the naming sprint; `@felinar/verify` itself was not asked). Sequence step 1 asks again, and step 5b once more the day you publish. That proves a package name is free, not that the `@felinar` scope is: an npm organisation or user may already own the scope, so step 5b makes the organisation before its publish lines, once its gate line prints "go" (section 16.5). Inside a clone, `npx felinar` runs the clone; once anyone registers the name, the same command outside a clone runs their package, and the README, DEPLOY, OPERATIONS and DEMO-RESULTS use it. Before the repository is public, publish the package under that name yourself (section 11: sequence step 3c removes `"private": true` from `package.json` and changes the sentences that publishing makes false before the squash, then step 5b runs `npm publish`), or switch the documents to `node bin/felinar.mjs` or a scoped name. Until then the `.tgz` on the release page is the package. The old name `magnet-web` is only a `bin` alias (the `lightweb` alias went with the name); do not register the old package names. |
| The identity origin (owner decision N-2: none in 0.3.0) | Decided: 0.3.0 runs no default identity origin. By design, the project hosts no identity page; it ships the page only as a release file, `felinar-<version>-idp.zip` (`dist-idp/` in a clone), which each site owner serves on a host name of their own or replaces with one they trust ([DEPLOY.md](DEPLOY.md#the-identity-origin-running-your-own-with-toolsbuild-idpmjs)). Nothing in the code defaults to one: a site names it with `publish --idp <origin>` (the pointer's `idp=`) or `<meta name="mw-idp">`, and without either, every post fails with `E_IDP_UNREACHABLE`. A site whose visitors only read needs none: the owner changes it by publishing again or with `tools/ledger-admin.mjs`, which uses the owner key offline; moderators who write from a browser sign in like anyone else. Only if you later run a shared default: its host name is the passkey's RP ID and cannot move without every person restoring from the 12 words or the backup file, so section 16.6 gives the rules for it. |
| The hub domain | A hub gives each member a label under one domain (`<name>.<hub domain>`). The domain must be on the Public Suffix List before a hub with a subdomain per site runs (the loader turns off persistent identity on a hub that is not on it; [DEPLOY.md](DEPLOY.md), [OPERATIONS.md](OPERATIONS.md)), and the identity origin and loader are built with that suffix (`build-idp --hub-suffix`). The list entry takes weeks, neither nip.io nor sslip.io is on the list (so a hub cannot run under either), and the hub directory stays off pending counsel (no lawyer is engaged for 0.3.0). Decide whether to run a hub at all for 0.3.0; the `examples/social` demo needs one. |
| A name that can't be confused with another project | A project with the same idea and name, `KayleePop/magnet-web` (MIT, last commit 2022-12-14), existed when the research was done ([research/RESEARCH-DIGEST.md](research/RESEARCH-DIGEST.md), P3-1). Renaming removes the clash (to Lightweb on 2026-10-21, then to felinar on 2026-10-22, after a preliminary search found a pending US trademark application for LIGHTWEB in class 42); the README still credits it. Preliminary searches of the US and Canadian trademark registers for felinar (2026-10-22) found no record; no lawyer is engaged for 0.3.0 and no clearance opinion exists: search the registers yourself and write down the date and the result. |
| Whether to publish the research folder | It is the review trail and the evidence behind the numbers. If you keep it, the secrets and path checks below cover it too. |
| The homepage demo (optional) | `pages-demo.yml` publishes `examples/landing` through felinar, and the loader needs the root of an origin, which a project site under `/<repository>/` is not. 0.3.0 runs none: `DEMO_DOMAIN` stays empty and sequence step 8 turns the workflow off, because a hosted demo makes you its operator ([PRIVACY.md](PRIVACY.md)). Later, the free route is a second repository named `<OWNER>.github.io` (section 12); a domain you own works too. Never set a name you do not hold. |
| Who answers security and abuse reports | `SECURITY.md` sends reporters to GitHub's private vulnerability reporting, which section 12 switches on, and, if that fails them, to a public issue that asks only for contact, with the details encrypted to the committed key `SECURITY-KEY.asc` (`SECURITY.md:8` to `:16`; regenerated on 2026-10-25 with a user id that names no e-mail address). The project holds no domain and runs no mailbox (section 16.8, sequence step 1b). `GOVERNANCE.md` names you as the security contact. |
| Whether to say how the project was made | Most of the code, tests and documents, and the design and code reviews, were written by AI agents under your direction (`docs/deviations/` has one file per agent; the history is automatic checkpoints). No tracked file says so in general terms. Add a sentence to the README or GOVERNANCE.md if you want readers to know. |
| The contribution terms | CONTRIBUTING.md says a pull request is licensed under the repository's MIT License, with no CLA and no sign-off, and sets the commit subject prefixes; section 11 creates the repository public (`--private` is the alternative it names). These were the writers' choices: change them before the first outside contribution if you want a DCO, a CLA or other rules. |

## 2. A tree you expect

- [ ] Everything you want published is committed or staged (the searches below read tracked files only), and the
  ignored paths are only local state.

```sh
git status --short
git status --short --ignored | grep -v node_modules
```

Expect no untracked file you don't know. `dist/`, `.tools/` (the demo, the pin profile and end-to-end runs) and
`.orchestration/` (the notes of the agents that built this release) are ignored and stay on your machine, as do
`node_modules/` folders and ignored logs inside `docs/research/labs/`. The examples hold only their sites: the
guestbook's checks live in `test/example/` and the drop-in helpers in `test/fixtures/existing-site-dropin/`.

- [ ] A fresh install works: `npm ci`. It ends with "4 high severity vulnerabilities": one advisory in the `ip`
  package that nothing here calls ([QUICKSTART.md](QUICKSTART.md#step-0-get-the-tools)). Don't run
  `npm audit fix --force`.

## 3. Secrets and private data

- [ ] No key, certificate or token is tracked. Run each command and read every hit.

```sh
git ls-files | grep -Ei '\.(jwk|pem|key|p12|pfx|env)$|(^|/)\.env|id_rsa|id_ed25519|credentials|secrets?\.'
git grep -nI -E -e '-----BEGIN [A-Z ]*PRIVATE KEY-----'
git grep -nI -E -e '"d" *: *"[A-Za-z0-9_-]{40,}"'
git grep -nI -E -e '(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}' -e 'AKIA[0-9A-Z]{16}' -e 'xox[baprs]-[A-Za-z0-9-]{10,}' -e 'sk-[A-Za-z0-9]{32,}' -e 'AIza[0-9A-Za-z_-]{35}' -e 'npm_[A-Za-z0-9]{36}' -e 'glpat-[0-9A-Za-z_-]{20}'
```

At the last check (2026-10-21) the first command printed nothing; the second and the fourth found only the fake keys
that `test/unit/tools-publish-v021.test.mjs` plants on purpose to test the publish lint; and the third printed 16
lines, the private halves of throwaway P-256 keys in the golden vectors (14 in `test/vectors/chat.json`, 2 in
`test/vectors/pin.json`; each file says so in its `about` field), which stay. The one real hit before it, a
self-signed `localhost` certificate and its key in `docs/research/labs/w1-13-lab/tls/`, was removed from the tree, and
`.gitignore` now ignores `*.pem`, `*.key`, `*.p12` and `*.pfx` as well as `*.jwk`. The checkpoint history still holds
that key, in every commit from `735f349` until `621455b` removed it, so the history is never pushed: section 10
squashes it into one commit, and only that commit is pushed.

- [ ] No machine-specific path, personal address or account name is tracked that you don't want public.

```sh
git grep -nI -E '/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|C:\\Users\\'
git grep -nI -E '[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|icloud|yahoo|proton|fastmail)\.[a-z]+'
git grep -nI -i -e "$(id -un)"
```

At the last check (2026-10-21) the first command printed only the example paths `docs/QUICKSTART.md`
(`/Users/you/keys/...`) and `test/unit/tools-demo.test.mjs` (`/Users/me/...`), which stay, and the places that quote
them (this file and `docs/deviations/post-wave-fix.md`); the second found no personal e-mail address, and the third
printed nothing. The post-wave fix replaced the build machine's home directory with `$HOME` and the remaining forms of the
username (a scratch path such as `-Users-<name>-...`) with `owner` in the 105 tracked files that held them: 104 under
`docs/research` and `docs/review/code-review-security.md`. Two files written after it held them again
(`docs/deviations/wire-ui.md` and `docs/research/v03/R7-ease-of-use.md`); the v0.3 verify fix round 2 replaced them the
same way on 2026-10-21. A lab script that imported by absolute path won't run as it is; those scripts are evidence, not
part of the build. The checkpoint history still holds the old text (every commit from `735f349` until the scrub,
`3130928`, the username once more in `2d1862f`, and the two later files from `9d5ab58` and `468f6eb` until the round 2
fix), another reason it is never pushed (section 10).

If your clone still shows hits (a file added later, or a run on another machine), the first command below replaces
the home directory with `$HOME` in the research folder only, and the second replaces what remains of your username
with `USER` (do it by hand instead if your username is a common word).

```sh
git grep -lIz -E '/Users/[A-Za-z0-9._-]+' -- docs/research | xargs -0 perl -pi -e 's{/Users/[A-Za-z0-9._-]+}{\$HOME}g'
export MW_USER="$(id -un)"
git grep -lIz -F -e "$MW_USER" | xargs -0 perl -pi -e 's/\Q$ENV{MW_USER}\E/USER/g'
git grep -nI -F -e "$MW_USER" | head
```

The last command must print nothing. Then look for the other names people know you by: your first name, a nickname the
notes use and your machine name. The research notes address the project owner by first name in a few places, three test
files use it as a sample display name, the notes name the owner's hardware security key, two lab outputs print the
machine's short hostname, and one lab result holds a public IP address (a STUN answer). Every such line is listed with
its file and line in `docs/deviations/post-wave-fix.md`, "Owner decisions"; decide whether each stays.

```sh
git grep -n -w Ash
git grep -nI -i -w -F -e "$(git config user.name)" | cut -c1-160 | head -40
git grep -nI -i -w -F -e "$(hostname -s)" | cut -c1-160 | head -40
```

The first command finds the short form of the first name that the notes use, which a search for the first word of
your git name misses. At the last check (2026-10-21) it printed 30 lines: the 28 that "Owner decisions" lists with file
and line, and the two that quote this command (in that note and here). The second finds your full name as git knows it,
the third the machine's short hostname.

- [ ] Set the identity your squash commit and tag will carry. A commit or an annotated tag takes the name and e-mail
  address from your git configuration. Use GitHub's no-reply address (`<id>+<username>@users.noreply.github.com`,
  under Settings, Emails) if you don't want your e-mail address public. The `--local` setting applies to this
  repository only:

```sh
git config --local user.name "Your public name"
git config --local user.email "<id>+<username>@users.noreply.github.com"
git config user.name && git config user.email
```

The `LICENSE` holder line reads "The felinar authors"; change it only if you mean to.

## 4. OWNER placeholders

- [ ] Replace the placeholders with your account. At the last check (2026-10-21) 13 files held 38 lines of them (39
  matches: the README's badge line has two):

| File | What it holds |
|---|---|
| `package.json` | `homepage`, `bugs.url` and `repository.url` |
| `README.md` | the CI badge (two links on one line) and the clone command |
| `CHANGELOG.md` | the `[Unreleased]` link at the bottom (sequence step 3 adds the `[0.3.0]` link from it) |
| `CONTRIBUTING.md` | the clone command |
| `docs/QUICKSTART.md` | the clone command, and the clone on the server of "Start without a domain" |
| `GOVERNANCE.md` | `@OWNER` in the maintainer table |
| `SECURITY.md` | the security advisory link, and the `--repo` of the two `gh` commands of "Checking a release" |
| `.github/ISSUE_TEMPLATE/config.yml` | `OWNER/REPO` in the security advisory and Discussions links |
| `.github/CODEOWNERS` | `@OWNER`, the code owner of the four paths it lists |
| `docs/OPERATIONS.md` | the `repository:` line of the canary workflow example |
| `deploy/github-actions/publish-site.yml` | `FELINAR_REPO`, the repository a site owner's workflow clones |
| `tools/ship.mjs` | the fallback repository URL of the clone command that `ship` prints for a server without a clone, used when `package.json` names none (two lines) |
| `examples/landing/index.html` | 15 links of the homepage |

The searches use PCRE (`-P`), because `\b` is not part of the basic extended expressions that `git grep -E` understands
on every platform (on macOS it silently misses `@OWNER`). A plain search for `OWNER` also finds `E_NOT_OWNER` and
similar names, so they look for the URL and handle forms only. They leave out this file, which quotes the patterns,
and `docs/research`, `docs/review` and `docs/deviations`: those are records, and `docs/research/w2a-06-cicd-automation.md`
quotes GitHub's own `repo:OWNER@OWNER-ID/...` claim format, which must stay as it is.

```sh
export OWNER=your-github-account
: "${OWNER:?set OWNER first}"
git grep -lz -P '(github\.com/|@)OWNER\b|OWNER/(REPO|felinar)' -- . ':(exclude)docs/PUBLISH-CHECKLIST.md' ':(exclude)docs/research' ':(exclude)docs/review' ':(exclude)docs/deviations' \
  | xargs -0 perl -pi -e 's{OWNER/(?:REPO|felinar)}{$ENV{OWNER}/felinar}g; s{\@OWNER\b}{\@$ENV{OWNER}}g'
git grep -n -P '(github\.com/|@)OWNER\b|OWNER/(REPO|felinar)' -- . ':(exclude)docs/PUBLISH-CHECKLIST.md' ':(exclude)docs/research' ':(exclude)docs/review' ':(exclude)docs/deviations'
```

The last command must print nothing (tested on a throwaway clone on 2026-10-19). The `git+https://github.com/...` form in
`package.json` is covered by the same pattern. Then read the maintainer table in `GOVERNANCE.md`. If `OWNER` is an
organisation, the replacement writes `@<organisation>` into `GOVERNANCE.md` and `.github/CODEOWNERS`, where a person
or a team belongs: put your user name or `@<organisation>/<team>` there. Two comments still
mention the placeholder afterwards and need no change: step 5 of the header of `.github/workflows/pages-demo.yml`, and
the fork instructions in `examples/landing/README.md`.

## 5. Wording

The rules are in section 4 of [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md) and in
[CONTRIBUTING.md](../CONTRIBUTING.md). The `docs-links` test enforces part of them inside `npm test`; these greps cover
the rest, including the sources and the tool output.

- [ ] The banned words appear only where a rule quotes them.

```sh
git grep -n -i -E 'serverless|unstoppable|censorship[- ]resistant|fully decentralized|sub-second' -- '*.md' ':(exclude)docs/research' ':(exclude)docs/review' ':(exclude)docs/deviations' src tools build.mjs examples package.json
git grep -n -i 'blockchain' -- ':(glob)*.md' ':(glob)docs/*.md' src tools package.json
git grep -n -i 'isolat' -- ':(glob)*.md' ':(glob)docs/*.md'
```

`blockchain` appears only where the rule is quoted: the README section that used the word as a heading was renamed in the
review round (HON-14). At the last check (2026-10-19,
23:25 ET) every hit quoted the rule: the pull request template, the rule table in `CONTRIBUTING.md`, the
introduction of `docs/ARCHITECTURE.md`, the "don't promise" list in `docs/ONBOARDING.md`, `docs/DEVIATIONS.md`, this
checklist and a comment in `src/loader/strings.js`.

Read each `isolat` hit that concerns a hub. A shared-origin hub never gets an isolation claim; at the last check
every such hit was a negation.

- [ ] No em dashes, en dashes or curly quotes in the user-facing documents. The `docs-links` test checks only six named
  documents for these characters, so this grep is the real check; at the last check it printed nothing.

```sh
git grep -n -P '[\x{2013}\x{2014}\x{2018}\x{2019}\x{201C}\x{201D}]' -- README.md CONTRIBUTING.md GOVERNANCE.md CHANGELOG.md SECURITY.md CODE_OF_CONDUCT.md ':(glob)docs/*.md' ':(glob)docs/recipes/*.md' ':(glob)examples/*/*.md' ':(glob)deploy/*/README.md'
```

- [ ] No unfinished markers in the code or the current documents. Both commands must print nothing. The research and
  review folders and the lock file are left out on purpose: they hold the archived v0.1 specification and hash text
  that match a wider search.

```sh
git grep -n -w -E 'TODO|FIXME' -- src tools build.mjs bin examples README.md CONTRIBUTING.md GOVERNANCE.md CHANGELOG.md SECURITY.md ':(glob)docs/*.md' ':(exclude)docs/PUBLISH-CHECKLIST.md'
git grep -n 'RESEARCH-PENDING' -- README.md ':(glob)docs/*.md' src tools ':(exclude)docs/PUBLISH-CHECKLIST.md'
```

- [ ] Every benefit in the README and in `docs/WHY.md` carries its condition (for example, "stays up when nobody is
  online" needs `ws=` and `xs=` in the pointer).

## 6. Tests and build

- [ ] Everything passes. The browser tests need `npx playwright install chromium webkit firefox` once, and `test:browser`
  needs the build: before `npm run build`, `tools-v03-pin-browser` skips too and the count reads 40 passed and 2
  skipped instead of 41 and 1.

```sh
npm ci
npm test
npm run build
node build.mjs --check-lock
npm run test:browser
npm run test:example
npm run test:e2e
npm run test:e2e:webkit
npm run test:e2e:firefox
```

The counts of the last recorded runs are in [INTEGRATION-STATUS.md](INTEGRATION-STATUS.md), newest first, and those of the
independence round (2026-10-25) in `CHANGELOG.md` under 0.3.0 (its "Tests" bullet): 2,314 unit tests (2,306 pass, 8 are
`todo`), 41 browser tests and 1 skipped, 186 example checks, and 102, 107 and 140 end-to-end scenarios for `test:e2e`,
`test:e2e:webkit` and `test:e2e:firefox`, all passing: each runs the 102 Chromium scenarios, and the last two add 5 in
WebKit and 38 in Firefox ([deviations/firefox.md](deviations/firefox.md)). The three end-to-end suites ran at the same
time: E-MD-6 (in the WebKit run) failed once under that load and passed alone right after; Chromium passed 102 of 102 and
Firefox 140 of 140 in the runs themselves. Every end-to-end run ends with "network policy: every
request stayed on 127.0.0.1".
If yours differ, write your numbers into the changelog before the squash (section 10). Also run the parser fuzzers and the identity page
build, because `release.yml` does:

```sh
npm run test:fuzz
npm run build:idp
```

- [ ] A fresh clone passes. This catches a file that the build needs but git does not track. Commit first: the clone
  contains only what is committed.

```sh
fresh="$(mktemp -d)" && git clone . "$fresh/felinar" && (cd "$fresh/felinar" && npm ci && npm test && npm run build)
rm -rf "$fresh"
```

- [ ] The workflows, and the workflow template in `deploy/`, pin every third-party action to a commit hash. The command
  prints the actions that are not pinned; it must print nothing. `npm test` checks the same (`repo-layout`).

```sh
git grep -n -E 'uses: *[^ ]+@' -- .github/workflows deploy | grep -v -E '@[0-9a-f]{40}'
```

- [ ] (owner) Every pinned hash is the commit of the release its comment names, in the action's own repository. The
  agents that wrote the workflows and `deploy/github-actions/publish-site.yml` pinned the hashes offline (no network
  call was made, on purpose), so nobody has checked them: 43 `uses:` lines, 8 actions (`actions/attest-build-provenance`,
  `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`,
  `actions/upload-pages-artifact`, `actions/deploy-pages`, `aws-actions/configure-aws-credentials`). A hash that is not a commit fails the first run of
  CI; a hash that is a commit but not the tagged release would run code you didn't choose, and GitHub can also serve a
  commit that exists only in a fork through the parent repository's URL, so checking that the commit exists is not
  enough. The loop compares each pin with what the tag in its comment points at (`git ls-remote`, no login needed):

```sh
git grep -h -o -E 'uses: *[^ ]+@[0-9a-f]{40} *# *v[0-9][0-9.]*' -- .github/workflows deploy | sed -E 's/uses: *//; s/ *# */ /' | sort -u | while read -r ref tag; do
  action="${ref%@*}"; sha="${ref#*@}"
  got="$(git ls-remote "https://github.com/$action" "refs/tags/$tag" "refs/tags/$tag^{}" | tail -1 | cut -f1)"
  if [ "$got" = "$sha" ]; then echo "ok       $action $tag"; else echo "MISMATCH $action $tag: pinned $sha, the tag is ${got:-missing}"; fi
done
```

  Every line must start with `ok` (8 lines at the last check of the parsing, 2026-10-21; the network part has never
  run). For a `MISMATCH`, read the action's release notes, then put the tag's commit into every file that pins it
  (`git grep -n '<old hash>'`), and run `npm test` (`repo-layout` checks that every action is pinned).

## 7. The package

- [ ] A pack dry run lists only what the command needs, and none of it is a key, local state or a dependency folder.

```sh
npm pack --dry-run --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [p]=JSON.parse(s);console.log(p.name+"@"+p.version,p.entryCount+" files",p.size+" bytes");for(const f of p.files)console.log(f.path)})' > "${TMPDIR:-/tmp}/pack-list.txt"
head -1 "${TMPDIR:-/tmp}/pack-list.txt"
grep -E '\.jwk|\.pem|\.key|\.orchestration|\.tools|node_modules|dist-publish|^examples/|^docs/' "${TMPDIR:-/tmp}/pack-list.txt"
```

The `grep` must print nothing. At the last check (2026-10-24, after the review round) the package packed to
about 1.34 MB, 182 files: `bin/felinar.mjs` (the one file behind the
`felinar` command and the `magnet-web` alias),
`src/`, `tools/`, `build.mjs`, `README.md`, `LICENSE` and `package.json`, plus the files the code reads at run time:
`npm-shrinkwrap.json`, `build.lock.json` (the build checks the vendored WebTorrent bundle against it) and `test/e2e/browser-args.mjs` (the
local-only browser flags that `tools/live.mjs` imports for `pin`, `snapshot` and `check-site --headless`). The CI job
"reproducible pack" refuses any other file.

- [ ] The command-line entry point runs from the tree:

```sh
node bin/felinar.mjs --version
node bin/felinar.mjs --help
```

  Both names run the same file after an install (`npm install -g ./felinar-0.3.0.tgz`, then `felinar --version` and
  `magnet-web --version`); the alias is for one release.

## 8. Version, vectors, changelog

- [ ] The version is the same in `package.json`, the root entry of `package-lock.json` and `npm-shrinkwrap.json`,
  `src/loader/config.js`, `src/sdk/sdk.js` and `tools/lib.mjs`: 0.3.0. The unit test `v021-integration` (its title says 0.3.0) checks
  all of them except the lock files.
- [ ] Freeze the golden vectors for this release. `test/vectors/LOCK.json` has 226 entries (2026-10-24) and `FROZEN` in
  `test/unit/formats-vectors.test.mjs` ends at 28, the head that 0.2.1 would have frozen. 0.3.0 is the release that freezes
  the formats, v0.3's included (the pointer fields `org=`, `nx=` and `ml=`, the ledger freeze group, `identity.json`,
  `signin.json`, `chat.json`, `media.json`, `calls.json`, `pin.json`), so append the head of all entries. The first
  command prints it; the second appends it after the entry for 28 (never edit an existing entry; its grep skips the
  append when the entry is there already), and `npm test` must still pass.

```sh
node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const lock = JSON.parse(readFileSync("test/vectors/LOCK.json", "utf8"));
let head = sha("mw-vectors-v1");
for (const e of lock.entries) head = sha(head + "\n" + e.file + "\n" + e.id + "\n" + e.sha256);
console.log(JSON.stringify({ count: lock.entries.length, head }));
'
grep -q '}, // v0.3.0$' test/unit/formats-vectors.test.mjs || perl -0pi -e "s|(\{ count: 28, head: '97ec17dc96e8d359e8cde663d983126c200f8d3862b91ae1f6f6b2c11853765c' \}, // v0\.2\.1, 2026-10-19\n)|\$1  { count: 226, head: 'd3c50559f823ae0ba3576a9c172f7c36aaa22ecc6664f2b370424c5799effe3c' }, // v0.3.0\n|" test/unit/formats-vectors.test.mjs
npm test
```

The first command printed `{"count":226,"head":"d3c50559f823ae0ba3576a9c172f7c36aaa22ecc6664f2b370424c5799effe3c"}` at
the last check (2026-10-24). If it prints another count or head, a vector or a lock entry was added or changed after this
page was written: use what it prints in the second command, but only after you know why (an added vector is fine, an
edited one is a stop). The `FROZEN` entry for 28 stays: it is history.

- [ ] Date the changelog. Rename `## [Unreleased] - 0.3.0` to `## [0.3.0] - <tag date>`, replace the "Not released yet"
  paragraph under it with a status that still says why 0.2.1 was never published, what 0.3.0 fixes (MF-30 in part),
  whether the review round of the v0.3 design review ran, what has not run (the release gate, Firefox, the outside
  review of the new cryptographic code) and that no lawyer reviewed the privacy texts (with the date of the review that replaced it), followed by the lines the release
  notes must carry; start a new empty `## [Unreleased]` above it, point the `[Unreleased]` link at the bottom at
  `compare/v0.3.0...HEAD`, and add a `[0.3.0]` link to the release, so the new heading shows as a link. The 0.2.1
  block already reads "0.2.1 - never published; superseded by 0.3.0", with no link, because that tag never exists.
  `release.yml` refuses the tag until the `## [0.3.0] - <date>` heading exists, and takes the release notes from this
  section. Run this after the placeholders (section 4), so the links already name your account, and after the go or
  no-go (sequence step 1b), whose answers it writes. The commands of sequence step 3 do all of it; read the diff:

```sh
export TAG_DATE="$(date +%F)"
if printf '%s\n' "$TEXTS_REVIEW_DATE" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' && [ -n "$REVIEW_ROUND" ] && [ -n "$TAG_DATE" ]; then
  perl -0pi -e 's{^## \[Unreleased\] - 0\.3\.0\n\nNot released yet\.[^\n]*\n(?:[^\n]+\n)*}{## [Unreleased]\n\n## [0.3.0] - $ENV{TAG_DATE}\n\nPre-release, and the first public release: 0.2.1 was never published, because the red team of the v0.3 design review found seven defects in it that work today (MF-27, MF-28, MF-30 and MF-73 to MF-76). 0.3.0 fixes MF-27, MF-28 and MF-73 to MF-76, and fixes MF-30 in part: its signed `minSeq` is proposed, and the withdrawal expiry and two-source disagreement cover the cold-device replay meanwhile. The review round of the v0.3 design review (Part 5.3, the judges and the red-team attackers against the built code) $ENV{REVIEW_ROUND}. Of the other steps a release needs, the release gate on real devices has not run beyond the desktop parts of six rows, in a Brave browser on loopback ([docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md)), Firefox ran only in the automated harness, and the outside review of the new cryptographic code that R 2.19 asks for before 1.0 has not happened. No lawyer has reviewed the privacy texts (the cards, the v0.3 sections of [docs/PRIVACY.md](docs/PRIVACY.md) and the safe harbour of [SECURITY.md](SECURITY.md)): the owner decided against it, and AI research agents checked them against the code and against published law and regulator guidance in its place, in a review that ended on $ENV{TEXTS_REVIEW_DATE}. That review is research, not legal advice. Every test below ran on loopback only (Apple M3, Playwright Chromium 156, WebKit 27.2 and Firefox 157.0).\n\nHow this release was made:\n\n- One maintainer made it: the person who pushed the tag also approved the environment "release" that the attest and release jobs wait for, and no second person reviewed the lock files, so the two-person rule of R 2.19 is not met ([SECURITY.md](SECURITY.md), "The security program for 1.0").\n- `felinar` and `\@felinar/verify` were published to npm by hand, so neither carries npm provenance: no workflow publishes to npm ([docs/ROADMAP.md](docs/ROADMAP.md), release provenance).\n- No hub runs for this release: without one, `examples/social` runs as personal sites with a hub-less follow lane.\n- The signed per-file hash lists are the check of this release: `node tools/verify-release.mjs verify`, offline and under the release key built into the tools, accepts a copy of these files from any mirror, door, torrent or USB stick just as it accepts a download from GitHub, and the build provenance attestation is extra evidence for a copy that came from GitHub ([SECURITY.md](SECURITY.md), "Checking a release"). The checksums below give the sha256 of each zip and of the package, and the build id and bundle sha256 of the identity page. The project holds no domain: reports go through private vulnerability reporting on GitHub, and the places to compare the release key with are the tag message, `release-key.txt` with its OpenPGP signature and an archive copy of SECURITY.md. They protect against a takeover of the GitHub account after the release, not against the owner, who controls all of them.\n- The zero-setup route (`felinar ship` with a nip.io or sslip.io name; [docs/DEPLOY.md](docs/DEPLOY.md), "Zero-setup: a server without a domain") is not a domain of your own: the name changes if the IP address of the server changes, visitors who already opened the site keep their saved copy if the DNS service stops, and the box is one server, not a backend. It is a stepping stone to a domain you own, where the pointer can also live in DNS. Its rows G-ZS1 to G-ZS4 have not run.\n}m; s{^\[Unreleased\]: (https://github\.com/[^/]+/felinar)/commits/main$}{[Unreleased]: $1/compare/v0.3.0...HEAD\n[0.3.0]: $1/releases/tag/v0.3.0}m' CHANGELOG.md
  perl -0pi -e 's{ CI,\n  release \(it stops at a draft\) and rebuild workflows, never run\.\n}{ CI,\n  release (it stops at a draft) and rebuild workflows, none of which had run on GitHub before 0.3.0 was pushed.\n}' CHANGELOG.md
  perl -0pi -e 's{to be copied into `CADDY_IMAGE`, and it has not run \(nothing was\n  pushed\)\.}{to be copied into `CADDY_IMAGE`, and it had not run before 0.3.0 was pushed.}' CHANGELOG.md
else
  echo "STOP: step 1b sets REVIEW_ROUND and TEXTS_REVIEW_DATE, and step 1 TAG_DATE"
fi
git diff CHANGELOG.md
```

  The substitution replaces the whole "Not released yet" paragraph of the 0.3.0 block with a status paragraph that keeps
  each of its facts and takes two answers from sequence step 1b: whether the review round ran (`REVIEW_ROUND`) and the
  day the texts review ended (`TEXTS_REVIEW_DATE`). Without a date it prints STOP and changes nothing, because the
  status must say how the texts were reviewed and that no lawyer reviewed them (section 9). Under
  "How this release was made" it then writes the lines that sections 14, 16.5, 16.7, 16.11 and 17 ask of the release
  notes, so that you need not remember them: one maintainer pushed the tag and approved the environment `release`, so
  the two-person rule is not met; `felinar` and `@felinar/verify` were published to npm by hand, without provenance;
  no hub runs, so `examples/social` runs as personal sites; and what the zero-setup route is not. Each line is true for
  a release made by this page with one maintainer, no hub and both packages on npm; change one that is not true for
  you before the squash (section 11 gives the line for `felinar` kept off npm), and if the release gate has run, say
  so in the status. The second perl line of the if block rewords the end of the tools line of "Added", "CI, release
  (it stops at a draft) and rebuild workflows, never run.", which the first CI run makes false and the release notes
  carry, to "CI, release (it stops at a draft) and rebuild workflows, none of which had run on GitHub before 0.3.0 was
  pushed." (section 15). Run on copies of the changelog on 2026-10-21: the heading `## [0.3.0] - ` with the date of
  `TAG_DATE`, a second run changed nothing, and `release.yml`'s notes extraction found the section (367 lines, up to
  the 0.2.1 heading) with the new lines, the reworded line of "Added" among them, and its links pointed at the tagged
  tree.

If you tag on another day, change the date in the heading before you tag.

## 9. The go or no-go, the release gate and the claims

The go or no-go items come first because you answer them first, in sequence step 1b: before step 3 freezes the
vectors and dates the changelog, and so before anything leaves this machine (step 5b publishes to npm and step 6 makes
the repository public, and neither can be taken back). A "no" stops the sequence; the gate line of step 5b prints STOP
while an answer is missing from the tree. The checks after them print things for you to read before the squash of
step 5.

- [x] Go or no-go, answered: the review round of the v0.3 design review (R 5.3: the six judges and the eight red-team
  attackers, read-only against the built code, and the conformance agents) ran from 2026-10-22 to 2026-10-24: 16
  reviewers, 203 findings (199 distinct ids), 136 of them blockers or majors, 121 confirmed by two refuters, 1 refuted, 14 not
  verified before the session limit; the six blockers both refuters confirmed (HUB-1, PTR-1, PTR-2, PTR-3, MAL53-1,
  SCALE-1) are fixed. The results, finding by finding, are in
  [review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), section 5.4, the fixers' notes in
  `docs/deviations/review-round-*.md`, and the fixes in the changelog ("Changed in the review round"). Step 1b records
  the answer (`REVIEW_ROUND="ran on 2026-10-24, and its blockers are fixed"`), and step 3 writes it into the changelog
  status of section 8; the second search of step 1b lists the lines that still say it has not run.
- [ ] Go or no-go, decided: no lawyer reviews the privacy texts for 0.3.0. The owner decided this on 2026-10-22; in its
  place AI research agents checked the texts against the code and against published law and regulator guidance
  (research on 2026-10-22, synthesis on 2026-10-24; its memo is kept outside the repository), and every document that
  promised a lawyer's review now says that no lawyer reviewed it. For a reader this means the texts are research, not
  legal advice, and that nobody qualified has checked them. Apply that review's changes before step 1b. Step 1b records
  the date of the review (`TEXTS_REVIEW_DATE`; step 3 refuses to date the changelog without one), and the search of
  step 1b lists the sentences that still promise a lawyer's review.
- [ ] Go or no-go: read the 4 open end-to-end rows of R 4.2 in `docs/deviations/integration-v03.md` ("In all: 64 rows,
  60 that ran and passed (48 as written, 12 in part) and 4 open", each with its reason; the rows lanes of 2026-10-22 ran
  the other 27 that were open). For each one, and for each half a partial row names: run it, accept it as open (the
  changelog's known gaps list them), or make it a blocker.
- [x] Go or no-go, answered: axe-core is a development dependency (4.14.0, added on 2026-10-22; `package.json`,
  `package-lock.json` and `npm-shrinkwrap.json`, byte for byte the same). It is used only by the end-to-end tests and
  is never bundled or served. The accessibility rows E-ID-9, E-ID-9b and E-SO-12 ran it (wcag2a, wcag2aa,
  best-practice) on 60 screens and found no violation; the keyboard-only direct message of E-SO-12 is not scripted
  ([deviations/a11y.md](deviations/a11y.md)).
- [x] Go or no-go, answered: security reporting has no mailbox (section 16.8). The project holds no domain (the owner's
  decision of 2026-10-25), and a mailbox at a name nobody holds would send reports to whoever registers it. `SECURITY.md`
  and the README send reporters to GitHub's private vulnerability reporting (sequence step 7 turns it on and checks it),
  and as a fallback to a public issue that asks only for contact, with the details encrypted to `SECURITY-KEY.asc`,
  regenerated on 2026-10-25 with a user id that names no e-mail address (step 1b prints its fingerprint and checks the
  user id). Until a second route exists, private reports depend on GitHub alone (section 16.8).
- [ ] Go or no-go: the export decision (section 16.12). The source code that goes public contains encryption. Decide
  whether you send the e-mail notice of 15 CFR 742.15(b)(2) to BIS and the NSA, and write the decision into
  `SECURITY.md` ("Cryptography and export rules") before the first public copy leaves this machine (step 5b if you
  publish `felinar` to npm, otherwise step 6).
- [ ] Re-read [PRIVACY.md](PRIVACY.md), the consent cards (`src/loader/strings.js`, `src/idp/strings.js`) and the FAQ
  against the code, one sentence at a time: follow each claim of the form "never", "cannot", "nobody", "only" or
  "nothing" to the code that enforces it, and each recipient to the code that contacts it. Change the date in the
  "About this text" section of PRIVACY.md.
- [ ] [DEMO-RESULTS.md](DEMO-RESULTS.md) says which rows were run. Every row that has not run still says "not yet run".
- [ ] The README, the release notes and the repository description call this a pre-release and don't say
  "production-ready".
- [ ] [DEMO-RESULTS.md](DEMO-RESULTS.md) also says which of its v0.3 and v0.3 C2 rows ran (section 16.9). 0.3.0 carries
  both, so both tables belong to the gate.
- [ ] Every published document describes 0.3.0 as the release and the v0.3 and C2 code as what runs, and calls nothing
  of v0.3 unreleased or proposed that is built (the v0.3 verify fix round 2 brought them there on 2026-10-21). Read
  every hit of this search: what may stay is history (a line that labels 0.2.1 as never published, a "v0.2.1" mark
  of the specification, a measurement taken on the 0.2.1 build, how a 0.2.1 key or peer is handled):

```sh
git grep -n -E '0\.2\.1|not (yet )?released|proposed and not built' -- README.md SECURITY.md CONTRIBUTING.md ':(glob)docs/*.md' ':(glob)docs/recipes/*.md' ':(glob)deploy/*/README.md' ':(glob)examples/*/*.md' .github ':(exclude)docs/ARCHITECTURE.md' ':(exclude)docs/INTERFACES.md' ':(exclude)docs/PUBLISH-CHECKLIST.md' ':(exclude)docs/INTEGRATION-STATUS.md' ':(exclude)docs/DEVIATIONS.md'
```

- [ ] The ROADMAP's first tier is "Next (0.4)", the tier after the release you publish; the label `roadmap: next` of
  sequence step 8b says the same, and section 15 files its issues under it.

## 10. Squash the checkpoint commits (owner)

This section is not optional. The history is the automatic `checkpoint:` commits made while the project was built,
with the placeholder author `magnet-web checkpoint <checkpoint@localhost>` (the project's first name; it stays in
the history that is never pushed), and it is never pushed: every commit from
`735f349` until `621455b` removed it holds the private key of the w1-13 lab's `localhost` certificate, and every
commit from `735f349` until the privacy scrub (`3130928`) holds the build machine's home path and username
(`2d1862f` holds the username once more, and the two files that `9d5ab58` and `468f6eb` added hold them until the v0.3
verify fix round 2). Only the one squashed commit that this section makes, on a new orphan branch, is pushed. Do this
after sections 3 to 9, once every go or no-go of section 9 has its answer (sequence step 1b), with everything
committed.

First end every agent session on this machine (the Claude Code chats and the workflows they run), then stop the loop
that makes the checkpoint commits. Agent sessions restart the loop at each milestone (section 4 of the agents' resume
notes in `.orchestration/`), so a session that is still open can start it again after you stop it. Every 15 minutes the loop runs
`git add -A` and commits with the placeholder author, so a run during this section would put a checkpoint commit on
the new branch or on top of it, and a later run would commit the files that the manual release of section 14 writes.
Its process id is in `.orchestration/checkpoint-loop.pid`; `.orchestration/` is ignored by git and never part of the
tree, so that file exists only on the machine where the agents ran.

```sh
pid="$(cat .orchestration/checkpoint-loop.pid 2>/dev/null)"
ps -p "$pid" -o command= 2>/dev/null | grep -q checkpoint.sh && kill "$pid"
sleep 1; pgrep -fl checkpoint.sh || echo "loop stopped"
```

The last line must print "loop stopped" and nothing else. The pid file can name a process that is no longer the loop
(after a restart the number is reused), so the commands check that the process runs checkpoint.sh before killing it;
a loop that ended on its own (about 6 hours after it starts) prints "loop stopped" at once. `pgrep` also finds a loop
that another session started with a pid file of its own: if it prints a process, end that session, run
`pkill -f checkpoint.sh` and run `pgrep -fl checkpoint.sh` again. Run the same `pgrep` check right before the push of
section 11 (sequence step 6). Then commit, keep a local copy of the old history and squash:

```sh
git add -A && git commit -m "Prepare felinar 0.3.0"
git bundle create "${TMPDIR:-/tmp}/felinar-checkpoints.bundle" --all
git checkout --orphan release
git add -A
git commit -m "felinar 0.3.0"
git diff --stat main release
git branch -M release main
git log --format='%h %an <%ae> %s'
```

`git diff --stat main release` must print nothing: the new commit has exactly the tree of the last one. `git log` must
show one commit, with the author you set in section 3. These commands were run on a throwaway clone on 2026-10-19.

The bundle is a safety copy for this machine only: it holds the whole checkpoint history, with the key, the paths and
the username and every file that was ever committed. Keep it on this machine or delete it. Never push it, attach it
to a release, upload it or keep it in a folder that syncs.

## 11. Create the repository and push (owner)

Everything pushed to a public repository is published for good, so finish sections 1 to 10 first, with every go or
no-go of section 9 answered (sequence step 1b). The `gh repo create` line, and every line of this section that
publishes a package or puts the code on GitHub, runs only when the gate line of sequence step 5b printed "go" in this
shell (`GATE`); in a new shell, run that line again first (the npm block below starts with it).

```sh
pgrep -fl checkpoint.sh || echo "loop stopped"
gh auth login
gh auth status
[ "$GATE" = go ] && gh repo create "$OWNER/felinar" --public --source . --remote origin --push
```

The first line must print "loop stopped" and nothing else (section 10). `gh auth status` shows which account `gh` acts as; it must be `$OWNER`, or an account that can create repositories
in the `$OWNER` organisation. `--source .` creates the repository from this clone, `--remote origin` adds the remote and
`--push` pushes `main`.
The push starts the workflows in `.github/workflows/`: `ci.yml` needs nothing from you; `pages-demo.yml` fails until
section 12 has set up GitHub Pages, and you run it again there.

**A repository under the old name.** If `$OWNER/magnet-web` already exists (made before the rename), `gh repo create`
fails once it is renamed, and anything it already holds is public history that the squash cannot remove. First see
whether it holds commits (an empty repository answers with an HTTP 409 error, "Git Repository is empty"):

```sh
gh api "repos/$OWNER/magnet-web/commits?per_page=1" --jq length
```

- If it is empty, rename it and push to it, in place of the `gh repo create` line above. Like that line, each of these
  runs only when the gate line of sequence step 5b printed "go" in this shell:

```sh
[ "$GATE" = go ] && gh repo rename felinar --repo "$OWNER/magnet-web"
[ "$GATE" = go ] && git remote add origin "https://github.com/$OWNER/felinar.git"
[ "$GATE" = go ] && git push -u origin main
[ "$GATE" = go ] && gh repo edit "$OWNER/felinar" --visibility public --accept-visibility-change-consequences
```

  The last line is needed only if the repository was private.
- If it holds commits, delete it and let the `gh repo create` line above make `felinar`. Deleting needs the
  `delete_repo` scope, and `gh repo delete` asks you to type the name:

```sh
gh auth refresh -h github.com -s delete_repo
gh repo delete "$OWNER/magnet-web"
```

The first CI run is the first real run of every workflow: none of them has run on GitHub. The YAML parses and the
shell steps were simulated locally, but the Node 22 leg is the first test on Node 22 (only Node 24.22 ran here),
`npx playwright install --with-deps chromium webkit firefox` (CI; the release workflow installs Chromium and WebKit only) is the first install of the browsers' system packages on
`ubuntu-latest`, and the `deploy files` job is the first build of the Docker images (`node:24-bookworm-slim` and
`caddy:2.11` were never pulled on the build machine, so the Caddyfile's `stream_timeout 24h` is first validated
there). Watch the runs (`gh run watch --repo "$OWNER/felinar"`), and expect to fix something before you protect
`main` (section 13).

- [ ] (owner) Claim the npm name first, unless you switched the documents away from it (section 1). The README,
  DEPLOY, OPERATIONS and DEMO-RESULTS say `npx felinar`; outside a clone npx fetches that name from the registry,
  so once the repository is public anyone who registers `felinar` before you decides what that command runs.
  `npm view felinar name version` answers E404 while the name is free (it did on 2026-10-21; sequence step 1 asks,
  and step 5b asks again the day you publish, because the answer can change at any time). Publishing makes the
  sentences of this table false, and npm copies the README into the package, so sequence step 3c changes them before
  the squash (section 10), together with the line `"private": true`, which makes `npm publish` refuse:

| Where | Now | Step 3c writes |
|---|---|---|
| `package.json` | `"private": true,` | nothing: the line goes |
| `README.md`, the npm badge | "npm: not published yet", a grey badge linked to the status | the version badge `https://img.shields.io/npm/v/felinar.svg`, linked to `https://www.npmjs.com/package/felinar` |
| `README.md`, the status line | "Status: 0.3.0, pre-release (not published yet)." | "Status: 0.3.0, a pre-release." |
| `README.md`, "Try it in 90 seconds" | "runs this clone's `bin/felinar.mjs` (the package isn't on npm yet)." | "runs this clone's `bin/felinar.mjs`; outside a clone it runs the `felinar` package from npm." |
| `README.md`, "Status and roadmap" | "the first release planned for the public" | "the first public release" |
| `docs/DEPLOY.md`, under the opening note | "runs the matching tool from a clone of this repository (the package isn't on npm yet):" | "runs the matching tool, from a clone of this repository or from the npm package `felinar`:" |
| `CHANGELOG.md`, 0.3.0, "Added", sign-in for any site | "`@felinar/verify` (`packages/verify`: one file, no dependencies; not published to npm)" | "(`packages/verify`: one file, no dependencies; on npm, published by hand)" |
| `CHANGELOG.md`, 0.3.0, "Known gaps" | "The package is not published to npm (`package.json` has `"private": true`). [...] `@felinar/verify` is not published either: servers copy `packages/verify/verify.js` [...]." | "`felinar` and `@felinar/verify` are on npm, published by hand, so neither carries npm provenance (no workflow publishes to npm). `build` and `demo` still need a clone of the repository, and a server can copy `packages/verify/verify.js` instead of installing the package [...]." |
| `docs/recipes/signin-server-node.md`, "Needs" | "Until the owner publishes the package ([...], section 16), copy `packages/verify/verify.js` into your project" | "Install it with `npm install @felinar/verify`, or copy `packages/verify/verify.js` into your project" |

  The same known gap in the 0.2.1 block of the changelog stays: it is history. Then publish with the lines of sequence
  step 5b from its gate line to its second publish line, copied here as they are. Run the gate line in this shell
  first, and make the npm organisation once it prints "go" (section 16.5). Each publish line writes the commit it
  published into `.git`, and step 10 tags only when that record exists; the second publish line is `@felinar/verify`
  (section 16.5); after it, run the last three lines of step 5b as well, which check the published `verify.js` against the
  tree:

```sh
if grep -q 'No lawyer has reviewed the privacy texts' CHANGELOG.md && grep -Eq '^`p256:[A-Za-z0-9_-]{87}`$' SECURITY.md \
  && grep -Eq "^export const PINNED_RELEASE_KEYS = Object\.freeze\(\['p256:[A-Za-z0-9_-]{87}'\]\);$" tools/verify-release.mjs \
  && ! git grep -q -I -i -P 'felinar\.(dev|app|ca|io|com|org|net)\b' \
  && ! git grep -q -i -E 'for counsel.s review|for the same review|counsel review before release|reviewed by counsel, before|counsel reviews it before|no security mailbox|waits? for the owner' -- README.md SECURITY.md CHANGELOG.md ':(glob)docs/*.md' ':(glob)docs/recipes/*.md' ':(glob)examples/*/*.md' ':(exclude)docs/PUBLISH-CHECKLIST.md'
then GATE=go; else GATE=STOP; fi; echo "$GATE"
npm view felinar name version
npm view @felinar/verify name version
npm login
npm publish --dry-run
[ "$GATE" = go ] && npm publish --access public && git rev-parse HEAD > "$(git rev-parse --git-dir)/felinar-npm-commit"
[ "$GATE" = go ] && (cd packages/verify && npm publish --dry-run && npm publish --access public) && git rev-parse HEAD > "$(git rev-parse --git-dir)/felinar-npm-commit"
```

  `--dry-run` must list the files of section 7 (180 on 2026-10-21). Publish the real package, not an empty placeholder.

  If you would rather not publish `felinar` yet, replace `npx felinar` in the documents with `node bin/felinar.mjs`
  (or a scoped name you own, such as `@<you>/felinar`) before the squash, and skip the `felinar` lines of step 5b. If
  you publish that scoped package instead, publish it with the `felinar` lines of step 5b after changing `name` in
  `package.json`, and in both perl lines below write "its package is `@<you>/felinar` on npm" in place of "its package is
  the `.tgz` attached to this release". Of
  step 3c, run only its two lines for `@felinar/verify` (the "Added" line of the changelog and the recipe), because
  step 5b still publishes that package. In place of the rest of step 3c, run the lines below after step 3 and before
  the squash. The first writes the known gap of the changelog: `felinar` is not on npm and `@felinar/verify` is. The
  second changes the release-notes line that step 3 wrote, "`felinar` and `@felinar/verify` were published to npm by
  hand, so neither carries npm provenance: [...]", to "`@felinar/verify` was published to npm by hand, so it carries
  no npm provenance: no workflow publishes to npm ([...], release provenance). `felinar` is not on npm: its package is
  the `.tgz` attached to this release." The git grep must print nothing:

```sh
perl -0pi -e 's{- The package is not published to npm \(`package\.json` has `"private": true`\)\. The `felinar` command runs from a\n  clone of the repository, or from the package attached to the GitHub Release \(`npm install -g \./felinar-0\.3\.0\.tgz`\);\n  `build` and `demo` still need a clone\. `\@felinar/verify` is not published either: servers copy\n  `packages/verify/verify\.js` \(\[docs/recipes/signin-server-node\.md\]\(docs/recipes/signin-server-node\.md\)\)\.\n}{- `felinar` is not published to npm (`package.json` has `"private": true`). The `felinar` command runs from a\n  clone of the repository, or from the package attached to the GitHub Release (`npm install -g ./felinar-0.3.0.tgz`);\n  `build` and `demo` still need a clone. `\@felinar/verify` is on npm, published by hand, so it carries no npm\n  provenance (no workflow publishes to npm), and a server can copy `packages/verify/verify.js` instead of installing\n  the package ([docs/recipes/signin-server-node.md](docs/recipes/signin-server-node.md)).\n}' CHANGELOG.md
perl -0pi -e 's{^- `felinar` and `\@felinar/verify` were published to npm by hand, so neither carries npm provenance: no workflow publishes to npm \(\[docs/ROADMAP\.md\]\(docs/ROADMAP\.md\), release provenance\)\.$}{- `\@felinar/verify` was published to npm by hand, so it carries no npm provenance: no workflow publishes to npm ([docs/ROADMAP.md](docs/ROADMAP.md), release provenance). `felinar` is not on npm: its package is the `.tgz` attached to this release.}m' CHANGELOG.md
git grep -n -E 'were published to npm by hand|neither carries|is not published either' -- CHANGELOG.md
```

  The badge and the "isn't on npm yet" sentences stay true, and step 11c changes the README's status lines once the
  release is out.

  If you want to look at the repository on GitHub before anyone else can, or to see the first CI run before npm has
  0.3.0, use `--private` in the `gh repo create` line, which still needs "go" from the gate line of step 5b: run that
  line first, then the private `gh repo create`, then the rest of step 5b while the repository is private. Make it
  public with the line below when you are done (it also needs "go"); branch protection and GitHub Pages on a private
  repository depend on your plan.

```sh
[ "$GATE" = go ] && gh repo edit "$OWNER/felinar" --visibility public --accept-visibility-change-consequences
```

## 12. Repository settings (owner)

- [ ] The description, the topics (the `keywords` of `package.json`), Discussions (the issue forms link to them) and
  squash merging only; the homepage only when you run the demo (`DEMO_DOMAIN`, below). Without it, the repository page
  is the homepage, as `package.json` says:

```sh
gh repo edit "$OWNER/felinar" --description "felinar: websites loaded by magnet link, verified in your browser, from a plain static host. No backend. The light web." \
  --add-topic webtorrent,bittorrent,magnet-link,peer-to-peer,p2p,webrtc,service-worker,static-site,static-hosting,web-seed,site-ledger,no-backend \
  --enable-issues --enable-discussions --enable-wiki=false \
  --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false --delete-branch-on-merge
[ -n "$DEMO_DOMAIN" ] && gh repo edit "$OWNER/felinar" --homepage "https://$DEMO_DOMAIN/"
```

- [ ] Secret scanning and push protection, private vulnerability reporting (`SECURITY.md` sends reporters there),
  Dependabot alerts (`.github/dependabot.yml` already updates npm packages, the action pins and the base image of
  `deploy/pin/Dockerfile`, each with a 14-day cooldown for version updates; nobody has run that configuration yet), and a read-only
  default token for workflows. These are the REST calls behind Settings, Code security and Settings, Actions.

```sh
gh repo edit "$OWNER/felinar" --enable-secret-scanning --enable-secret-scanning-push-protection
gh api --method PUT "repos/$OWNER/felinar/private-vulnerability-reporting"
gh api --method PUT "repos/$OWNER/felinar/vulnerability-alerts"
gh api --method PUT "repos/$OWNER/felinar/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
gh api "repos/$OWNER/felinar/private-vulnerability-reporting" --jq .enabled
```

  The last line must print `true`: the project holds no domain and runs no mailbox, so this is the private route
  `SECURITY.md` gives reporters (section 16.8).

- [ ] The homepage demo is optional, and 0.3.0 runs none: `DEMO_DOMAIN` stays empty and sequence step 8 turns
  `pages-demo.yml` off, which would otherwise fail on every push to `main`. A hosted demo makes you its operator under
  [PRIVACY.md](PRIVACY.md), and the loader needs the root of an origin, which a project site under `/felinar/` is not.
  If you want one later, the free route needs no domain: a second repository named `$OWNER.github.io` (a user site at
  the root of its own origin; `github.io` is on the Public Suffix List, so it shares nothing with other users' sites)
  that holds this tree and runs `pages-demo.yml` (its header lists what it needs), with Pages built from GitHub Actions
  and the repository variable `MW_DEMO_ORIGIN`. Like every line that puts code on GitHub, these need "go" from the gate
  line of sequence step 5b:

```sh
export DEMO_DOMAIN="$OWNER.github.io"
[ "$GATE" = go ] && gh repo create "$OWNER/$DEMO_DOMAIN" --public
[ "$GATE" = go ] && git push "https://github.com/$OWNER/$DEMO_DOMAIN.git" main
gh api --method POST "repos/$OWNER/$DEMO_DOMAIN/pages" -f build_type=workflow
gh variable set MW_DEMO_ORIGIN --repo "$OWNER/$DEMO_DOMAIN" --body "https://$DEMO_DOMAIN"
gh workflow run pages-demo.yml --repo "$OWNER/$DEMO_DOMAIN" --ref main
[ -n "$DEMO_DOMAIN" ] && gh repo edit "$OWNER/felinar" --homepage "https://$DEMO_DOMAIN/"
```

  In that repository, turn off the workflows a demo does not need (`gh workflow disable release.yml --repo
  "$OWNER/$DEMO_DOMAIN"`, and the same for `rebuild.yml`). The `github-pages` environment that the first deployment
  creates must allow deployments from `main`. A domain you own works too: a CNAME record to `$OWNER.github.io`, the
  domain verified for your account (Settings, Pages, "Add a domain") so nobody else can claim it, and the custom domain
  set under Settings, Pages, with "Enforce HTTPS". Optional repository variable: `MW_DEMO_TRACKERS`
  (your own `wss://` trackers), for example
  `gh variable set MW_DEMO_TRACKERS --repo "$OWNER/$DEMO_DOMAIN" --body "wss://tracker.example.org"`.

- [ ] Create the labels that [CONTRIBUTING.md](../CONTRIBUTING.md) names. GitHub already has `bug`, `enhancement`,
  `documentation`, `good first issue`, `help wanted`, `question` and `wontfix`.

```sh
while IFS='|' read -r name color desc; do gh label create "$name" --repo "$OWNER/felinar" --color "$color" --description "$desc" --force; done <<'EOF'
compatibility|fbca04|A site, framework or host that does not migrate cleanly
rfc|5319e7|Proposal to change the specification, a frozen format or the security model
needs-repro|d4c5f9|Waiting for steps, a pointer or a browser version
needs-device|d93f0b|Needs a real phone or a browser the test setup cannot launch
release-gate|b60205|A failure from the manual release gate; blocks 1.0
upstream|cfd3d7|Caused by WebTorrent, bittorrent-tracker or a browser
roadmap: next|0e8a16|Roadmap tier: next (0.4)
roadmap: 1.0|0e8a16|Roadmap tier: 1.0
roadmap: later|c2e0c6|Roadmap tier: later
EOF
```

- [ ] Upload a social preview (Settings, General, Social preview; there is no API for it). GitHub takes PNG, JPG or
  GIF, so export `assets/social-preview.svg` as a PNG of 1280 by 640 pixels first, for example with
  `rsvg-convert -w 1280 -h 640 docs/assets/social-preview.svg -o social-preview.png`.

## 13. Protect main (owner)

Protect `main` once CI has passed on it, so you can read the exact names of its checks.

```sh
gh run watch --repo "$OWNER/felinar" --exit-status "$(gh run list --repo "$OWNER/felinar" --workflow ci.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh api "repos/$OWNER/felinar/commits/main/check-runs" --jq '.check_runs[].name'
```

The CI jobs are named `test (Node 22)`, `test (Node 24)`, `reproducible pack`, `deploy files` and `one-box files`; the
list also shows the jobs of `pages-demo.yml` (`build`, `deploy` and `check`), which runs only on `main`, and of
`rebuild.yml` (`build (ubuntu-latest)`, `build (macos-latest)`, `build (windows-latest)` and `compare`), which runs on a
pull request only when it touches the build. Require neither: a required check that a pull request never starts
blocks its merge. If the names differ, put the ones it printed into `contexts`:

```sh
gh api --method PUT "repos/$OWNER/felinar/branches/main/protection" --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["test (Node 22)", "test (Node 24)", "reproducible pack", "deploy files", "one-box files"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "dismiss_stale_reviews": true, "required_approving_review_count": 0 },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF
```

Every change then reaches `main` through a pull request with green checks, and nobody can force-push or delete it. With
one maintainer a review can't be required ([GOVERNANCE.md](../GOVERNANCE.md)); raise
`required_approving_review_count` to 1 when there is a second, list them in `.github/CODEOWNERS` and add
`"require_code_owner_reviews": true` to `required_pull_request_reviews`, so a change to the lock files or to `.github/`
needs their approval (section 16.7). `enforce_admins: false` leaves you a way to push a fix
when CI itself is broken; set it to `true` if you want no exceptions.

## 14. Tag and release (owner)

- [ ] Tag the commit that CI passed on and push the tag. The tag starts `.github/workflows/release.yml` (its header is the
  full description). It refuses a tag that differs from the version in `package.json` and a version with no
  `## [0.3.0] - <date>` heading in `CHANGELOG.md` (section 8). Then it runs the tests, the parser fuzzers and the
  end-to-end suite, builds the loader and the identity page, packs the files, attests where they came from, and leaves a
  **draft** release. It never publishes one: the signing key stays with you. npm has had 0.3.0 since sequence step 5b,
  so the first lines tag only when no file of the two packages (the files of section 7 and `packages/verify`) changed
  since the commit that step 5b (or its copy in section 11 or 16.5) published and wrote into `.git`: a fix after it,
  such as one the first CI run needed, goes out as 0.3.1 ("If something goes wrong"), and the tag is never made. They
  also need `RELEASE_PUB` to be the key `SECURITY.md` shows, because the tag message carries the line
  `Release key: p256:...`, one of the places to compare the release key with that need no domain (section 16.7).

```sh
npm_commit="$(cat "$(git rev-parse --git-dir)/felinar-npm-commit" 2>/dev/null)"
d="$(git diff --stat "${npm_commit:-HEAD}" HEAD -- package.json README.md LICENSE bin src tools build.mjs build.lock.json npm-shrinkwrap.json test/e2e/browser-args.mjs packages/verify 2>&1)"
if [ -n "$npm_commit" ] && [ -z "$d" ] && printf '%s\n' "$RELEASE_PUB" | grep -Eq '^p256:[A-Za-z0-9_-]{87}$' && grep -q -F "\`$RELEASE_PUB\`" SECURITY.md; then git tag -a v0.3.0 -m "felinar 0.3.0" -m "Release key: $RELEASE_PUB"; else printf '%s\n' "$d" "STOP: no tag; npm 0.3.0 is another commit, step 5b did not run (release 0.3.1 instead), or RELEASE_PUB is not the key SECURITY.md shows (step 3b)"; fi
git push origin v0.3.0
sleep 15
gh run watch --repo "$OWNER/felinar" --exit-status "$(gh run list --repo "$OWNER/felinar" --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh release view v0.3.0 --repo "$OWNER/felinar"
```

  The attest and release jobs run in the environment `release`, which waits for the approval of the reviewer that
  sequence step 9b names (section 16.7): with two maintainers the one who did not push the tag, with one maintainer
  you, because `"prevent_self_review": false` lets the person who pushed approve. Create it, the tag ruleset and
  immutable releases before the first tag (sequence step 9b): a workflow that names an environment that does not exist
  gets one with no protection. The release notes that sequence step 3 wrote say that one maintainer approved it: with
  two maintainers, change that line before the squash (sequence step 5).

- [ ] Open the draft. It carries the `[0.3.0]` section of the changelog as its notes (the workflow points relative links at
  the tagged tree) and these files: `felinar-0.3.0-dist.zip`, `felinar-0.3.0-idp.zip`, `felinar-0.3.0.tgz`,
  `hashes-dist.json`, `hashes-idp.json` and `SHA256SUMS`. Download them and check them (on macOS,
  `shasum -a 256 -c SHA256SUMS`), and check the attestation:

```sh
export RDIR="${TMPDIR:-/tmp}/mw-release"
gh release download v0.3.0 --repo "$OWNER/felinar" --dir "$RDIR"
(cd "$RDIR" && shasum -a 256 -c SHA256SUMS)    # Linux: sha256sum -c SHA256SUMS
gh attestation verify "$RDIR/felinar-0.3.0.tgz" --repo "$OWNER/felinar"
```

- [ ] Sign the two hash lists offline, verify the signatures, upload them, and only then publish the draft as a
  **pre-release** (steps 1 to 6 of the `release.yml` header; with immutable releases on, the release cannot change after
  that). The key is the file of sequence step 3b (`RELEASE_KEY`, made by `tools/keygen.mjs`, outside the clone), and its
  public key (`RELEASE_PUB`) is already pinned in the README, `SECURITY.md` and `tools/verify-release.mjs`. `sign`
  signs a list only when it equals your own build of the tag, made from this clone and not from GitHub (the first
  line). The project holds no domain, so the second places of the key are the tag message (step 10), `release-key.txt`
  with its detached signature by the project's OpenPGP key `SECURITY-KEY.asc` (gpg asks for its passphrase), and an
  archive copy of SECURITY.md at the tag (section 16.7). The notes gain the sha256 of every file and the identity
  page's build id and bundle sha256, so a copy from any mirror and an identity page served from anywhere can be
  compared with the release. Every path is in the folder the draft was downloaded to; both sign lines must print
  "signed", both verify lines must start with "OK", and gpg must say "Good signature":

```sh
git clone -q --branch v0.3.0 --depth 1 "file://$(pwd -P)" "$RDIR/src" && (cd "$RDIR/src" && npm ci --ignore-scripts && node build.mjs --strict --out "$RDIR/rebuilt/dist" && node tools/build-idp.mjs --out "$RDIR/rebuilt/dist-idp")
node tools/verify-release.mjs sign --list "$RDIR/hashes-dist.json" --rebuilt "$RDIR/rebuilt/dist" --key "$RELEASE_KEY" --out "$RDIR/hashes-dist.json.sig"
node tools/verify-release.mjs sign --list "$RDIR/hashes-idp.json" --rebuilt "$RDIR/rebuilt/dist-idp" --key "$RELEASE_KEY" --out "$RDIR/hashes-idp.json.sig"
mkdir -p "$RDIR/unzipped" && unzip -q "$RDIR/felinar-0.3.0-dist.zip" -d "$RDIR/unzipped" && unzip -q "$RDIR/felinar-0.3.0-idp.zip" -d "$RDIR/unzipped"
node tools/verify-release.mjs verify "$RDIR/unzipped/dist" --list "$RDIR/hashes-dist.json" --sig "$RDIR/hashes-dist.json.sig" --pubkey "$RELEASE_PUB" --expect-version 0.3.0 --expect-tree dist
node tools/verify-release.mjs verify "$RDIR/unzipped/dist-idp" --list "$RDIR/hashes-idp.json" --sig "$RDIR/hashes-idp.json.sig" --pubkey "$RELEASE_PUB" --expect-version 0.3.0 --expect-tree dist-idp
printf '%s\n' "$RELEASE_PUB" > "$RDIR/release-key.txt" && gpg --local-user 4C44C2A8D93527B74C881E20A46F0FB0E1F80C26 --armor --detach-sign --output "$RDIR/release-key.txt.asc" "$RDIR/release-key.txt"
gpg --verify "$RDIR/release-key.txt.asc" "$RDIR/release-key.txt"
gh release view v0.3.0 --repo "$OWNER/felinar" --json body --jq .body > "$RDIR/notes.md"
node -e 'const fs = require("fs"); const d = process.argv[1]; const b = JSON.parse(fs.readFileSync(d + "/unzipped/dist-idp/build.json", "utf8")); fs.appendFileSync(d + "/notes.md", "\n### Checksums\n\n" + fs.readFileSync(d + "/SHA256SUMS", "utf8").trimEnd().replace(/^/gm, "    ") + "\n\nIdentity page (dist-idp): build id " + b.buildId + ", bundle sha256 " + b.bundleSha256 + ".\n")' "$RDIR"
gh release upload v0.3.0 "$RDIR/hashes-dist.json.sig" "$RDIR/hashes-idp.json.sig" "$RDIR/release-key.txt" "$RDIR/release-key.txt.asc" --repo "$OWNER/felinar"
gh release edit v0.3.0 --repo "$OWNER/felinar" --notes-file "$RDIR/notes.md"
gh release edit v0.3.0 --repo "$OWNER/felinar" --prerelease --draft=false
```

  These steps ran on 2026-10-21 against a local build with a throwaway key (`list`, a zip made as `release.yml` makes
  it, `sign`, `unzip`, `verify` printed "OK: 22 files match the list"); the GitHub steps have never run. On 2026-10-25
  the notes line ran against a local `dist-idp` (build id 9d6a24e3eb7f), and `test/unit/verify-release-anchor.test.mjs`
  runs the pin of step 3b, the notes line and `verify` from a copy of the files with no `gh` and no network. The two
  `gpg` lines have not run: the agent session that wrote them could not start a `gpg-agent`. Afterwards, save SECURITY.md at the tag in an archive (https://web.archive.org/save with
  `https://github.com/$OWNER/felinar/blob/v0.3.0/SECURITY.md`, or Software Heritage's "Save code now").

- [ ] If the workflow cannot run, build the same files by hand from the tagged checkout and create the draft yourself; the
  zip holds a `dist/` folder, as the workflow's does (unzip it, then `publish --dist dist`), not files at the root of the
  zip. This is the loader zip and the package; the identity page and the hash lists come from `npm run build:idp` and
  `node tools/verify-release.mjs list` (see the `release.yml` header), and a hand-made release has no attestation: add the
  line "This release was built by hand, so its files carry no build provenance attestation." to its notes.

```sh
npm ci --ignore-scripts && npm run build && npm run build:idp
epoch="$(git log -1 --format=%ct)"
find dist -exec touch -h -t "$(date -r "$epoch" +%Y%m%d%H%M.%S 2>/dev/null || date -d "@$epoch" +%Y%m%d%H%M.%S)" {} +
find dist -type f | LC_ALL=C sort | TZ=UTC zip -X -D -q felinar-0.3.0-dist.zip -@
npm pack
shasum -a 256 felinar-0.3.0-dist.zip felinar-0.3.0.tgz > SHA256SUMS   # Linux: sha256sum
gh release create v0.3.0 --repo "$OWNER/felinar" --verify-tag --draft --prerelease --title "felinar 0.3.0" \
  --notes-file "${TMPDIR:-/tmp}/release-notes.md" felinar-0.3.0-dist.zip felinar-0.3.0.tgz SHA256SUMS
```

  `release-notes.md` is the `[0.3.0]` section of the changelog without its link references, every relative link pointed at
  the tagged tree (`https://github.com/$OWNER/felinar/blob/v0.3.0/...`), and a list of the files.

## 15. After publishing

- [ ] A fresh clone installs and passes: clone `https://github.com/$OWNER/felinar.git`, then run `npm ci` and
  `npm test` inside it. Open the repository in a private window and click through the README, the issue forms, the
  Discussions tab and the Security tab ("Report a vulnerability" must be there).
- [ ] Only if you run the homepage demo (section 12; 0.3.0 runs none): open it at `https://$DEMO_DOMAIN/` and check
  that it renders in shell mode and shows how the page reached you.
- [ ] Run the kill switch drill from [RUNBOOK.md](RUNBOOK.md) section 11 on a staging host and write the measured
  times into [DEMO-RESULTS.md](DEMO-RESULTS.md).
- [ ] Open an issue for each "Next (0.4)" item in [ROADMAP.md](ROADMAP.md), labelled `roadmap: next`, and one issue per
  release gate row that needs a device, labelled `release-gate` and `needs-device`.
- [ ] Pin the site owners' workflow template to the release: `deploy/github-actions/publish-site.yml` names
  `FELINAR_REF: v0.3.0`, but its `FELINAR_COMMIT` can only be set after the tag, because a file cannot name the
  commit it is part of. Sequence step 11b sets it to `git rev-parse 'v0.3.0^{commit}'` in a pull request. Do the same
  for every later release.
- [ ] Change the sentences that the published release and the first CI run made false, npm or not, in one more pull
  request (sequence step 11c). Its `git grep` prints nothing afterwards. One row is changed earlier: the release notes
  copy the 0.3.0 section of the changelog from the tagged tree, so step 3 rewords its line on the workflows before the
  squash, in words that stay true after the first CI run:

| Where | Now | Becomes | Step |
|---|---|---|---|
| `SECURITY.md` and 14 documents of `docs/`, 21 lines in all (`git grep -n 'release being prepared'` lists them) | "0.3.0, the release being prepared" | "0.3.0", without the commas or brackets around the phrase | 11c |
| of these, the "Release status" line of `docs/INTEGRATION-STATUS.md` | "(2026-10-21): the tree is 0.3.0, the release being prepared and the first public one" | "(<the day of the tag>): 0.3.0 is released, the first public one" | 11c |
| `README.md`, the status line, unless step 3c changed it | "Status: 0.3.0, pre-release (not published yet)." | "Status: 0.3.0, a pre-release." | 11c |
| `README.md`, "Status and roadmap", unless step 3c changed it | "the first release planned for the public" | "the first public release" | 11c |
| `deploy/pin/README.md` and `deploy/tracker/README.md`, "What was tested", false from the first CI run (step 6) on | "CI (`.github/workflows/ci.yml`, job `deploy`; it has not run on GitHub yet)" | "CI (`.github/workflows/ci.yml`, job `deploy`)" | 11c |
| `CHANGELOG.md`, 0.3.0, "Added", the tools, false from the first CI run (step 6) on, and copied into the release notes | "CI, release (it stops at a draft) and rebuild workflows, never run." | "CI, release (it stops at a draft) and rebuild workflows, none of which had run on GitHub before 0.3.0 was pushed." | 3, before the squash |
| `CHANGELOG.md`, 0.3.0, "Known gaps of phase C2", Zero-setup, false from the first CI run (step 6) on, and copied into the release notes | "and it has not run (nothing was pushed)" | "and it had not run before 0.3.0 was pushed" | 3 |

  If you did not publish `felinar`, the npm badge and the "isn't on npm yet" sentences stay: they are still true. The
  known gap of the 0.2.1 block that says the workflows have not run on GitHub stays as well: it is history.

## 16. The release gate and the v0.3 owner steps

> **Status: v0.3, built and code-reviewed on loopback; the review round of R 5.3 ran on 2026-10-24, and the release gate on real devices has not run**
> (section 9 makes the review round, the texts review that replaced a lawyer's review, the security reporting decision and the export decision go or no-go items, answered in sequence
> step 1b before anything is published).
> Sections 1 to 15 are the sequence for 0.3.0. This section is what the v0.3 identity, chat, media, calls and seeding
> features need on top of them ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), cited "R"; a number after R is
> its section), and the gate rows that the v0.3 design review and the C2 design
> ([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), cited "SZ") added. Agents
> never push, tag, publish a package, create an account or reach a public network; every step here is yours, and several
> need a second person or a real device.

**There is one release to decide, not two.** 0.3.0 carries everything and 0.2.1 is never published (section 0). Section 8 does
the version, the vectors and the changelog once, for 0.3.0. The changelog's `## [Unreleased] - 0.3.0` block sits above the
0.2.1 block, which already reads "0.2.1 - never published; superseded by 0.3.0"; the commands of section 8 date the first,
and `release.yml` reads only the section of the version being tagged.

### 16.1 Confirm the decisions

- [ ] You have signed, or changed, the owner decisions of R 1.5 (N-1 to N-7 and the resolved D-, D-C and PR rows). A
  reversal of N-1 (the identity origin) stops the identity lanes, of N-3 the social example, and of N-4 (the freeze
  group) every lane that uses the new ledger ops (R 5.1).
- [ ] N-2 decided: no default identity origin in 0.3.0. The project runs none; each site owner hosts the release's
  identity page or names one they trust (16.6 applies only if you later run a shared default). Whether you run a hub,
  and under which domain, is still yours to decide (16.11). No agent picks a domain or buys one.

### 16.2 The freeze-group release comes before any public ledger (R 2.5.3)

- [ ] One release contains the whole freeze group with its vectors before any public ledger carries one of the new ops:
  `unban`, `keyinfo`, `rotate`, a defined `checkpoint`, `ban.until`, moderator `allow` with caps, owner-protected
  entries, reserved byte pools, author-scoped `@` keys, moderator voiding, and the pointer fields `org=`, `nx=` and
  `ml=`. A 0.2.1 peer rejects the new ops as `unknown-op`, which is why the order matters.
- [ ] No public ledger (on a public host, or a hub's) uses the new ops until that release is out. Loaders older than the
  `ml=` floor refuse to mount, so no public ledger has two kinds of peers for long.
- [ ] The new vector files (`identity.json`, `signin.json`, `chat.json`, `media.json`, `ledger.json` and the appended
  lines of `block.json` and `pointer.json`) are in `test/vectors/LOCK.json` and in the `FILES` list of the vector test,
  and the chain head is frozen again as in section 8, with the new count and head. The integrator prepares the lines;
  you check that `npm test` passes.

### 16.3 The texts review that replaced a lawyer's review, before anything is published (sequence step 1b)

- [ ] No lawyer reviews the texts for 0.3.0: the owner decided this on 2026-10-22. In place of that review, AI research
  agents compared the card copy (English and French; R 2.14.1), the v0.3 sections of [PRIVACY.md](PRIVACY.md), the
  transfers part for the DPIA and the Quebec assessment, the children's defaults, the file-lane duties, the hub denylist
  and directory rules and the safe-harbour paragraph of [SECURITY.md](../SECURITY.md) with the code and with the
  published law and regulator guidance of Canada and Quebec, the EU and the UK, and the US (research on 2026-10-22,
  synthesis on 2026-10-24). That review is research, not legal advice, and every document says so. What it could not
  settle is yours to decide (its owner actions); a reader who relies on these texts relies on research that nobody
  qualified has checked.
- [ ] Public uploads (R 2.17.3) stay off by default, and no lawyer will say whether they may be turned on: each owner
  decides, after writing down an illegal-content risk assessment and a notice-and-action process
  ([OPERATIONS.md](OPERATIONS.md)). Canada (desk research, 2026-10-22): the Mandatory Reporting Act reaches a person who
  provides Internet access, Internet content hosting or e-mail to the public, so it does not reach the maintainers, who
  host nothing, and it may reach an owner, hub or pin-node operator who stores other people's files or posts for the
  public (report to the Canadian Centre for Child Protection, notify the police, keep the data 21 days offline;
  OPERATIONS.md, "The worst content"); S.C. 2026, c. 19, ss. 178 to 183 are not in force, so check Justice Laws before
  each release. US: COPPA needs a parent's consent for children under 13, which this software cannot obtain; a hub, a pin
  node or public uploads bring 18 U.S.C. 2258A reporting and the TAKE IT DOWN Act removal process.
- [ ] Put the day the review ended into `TEXTS_REVIEW_DATE` (sequence step 1b): step 3 writes it into the changelog with
  the sentence that no lawyer has reviewed the privacy texts, and prints STOP without it. Then change every sentence
  that still promises a lawyer's review (the search of step 1b lists them; the gate line of step 5b prints STOP while
  one is left).
- [ ] Run the comprehension test of 16.4: the research review does not replace it.

### 16.4 The comprehension test (row G-ID-9, P0)

- [ ] Run the test with 5 to 8 people on the sign-in, recovery-kit, restore, link and same-identity cards, record it in
  [DEMO-RESULTS.md](DEMO-RESULTS.md), and change the wording where people misread a card. The review makes this a P0
  step (UX m5).

### 16.5 npm names and the verifier (R 2.19, SC-4)

- [ ] Reserve the npm scope `@felinar` (create the organisation, sequence step 5b, once its gate line prints "go") and
  the name `@felinar/verify`. `npm view @felinar/verify` printing E404 means the name is free; claim it before the
  README names it.
- [ ] Publish `@felinar/verify` by hand, with zero dependencies, as the three files `npm publish --dry-run` lists in
  `packages/verify` (`README.md`, `package.json` and `verify.js`; 2026-10-21). This is the second publish line of
  sequence step 5b, copied as it is: it does nothing unless the gate line of step 5b printed "go" in this shell, and it
  writes the commit it published into `.git`, which step 10 needs before it tags:

```sh
[ "$GATE" = go ] && (cd packages/verify && npm publish --dry-run && npm publish --access public) && git rev-parse HEAD > "$(git rev-parse --git-dir)/felinar-npm-commit"
```

  A package published from your machine carries no npm provenance: provenance needs the identity of a CI run, and no
  workflow here publishes to npm (`release.yml` says so). R 2.19 asks for provenance; it waits for a publishing
  workflow ([ROADMAP.md](ROADMAP.md), release provenance), and the release notes that sequence step 3 writes say that
  both packages were published by hand (section 11 gives the line for `felinar` kept off npm).
  Servers copy `packages/verify/verify.js` until the package exists ([recipes/signin-server-node.md](recipes/signin-server-node.md)).
- [ ] The `sha256(verify.js)` line of `packages/verify/README.md` matches the published file. It changes with every
  edit of `verify.js`, so check it last. The published file is the one `npm test` runs the conformance vectors of
  `mw-signin-v1` against (`test/vectors/signin.json`, `test/unit/signin-verify.test.mjs`) when the two hashes agree.
  These are the last three lines of sequence step 5b:

```sh
npm pack @felinar/verify --pack-destination "${TMPDIR:-/tmp}"
tar -xOzf "${TMPDIR:-/tmp}/felinar-verify-0.3.0.tgz" package/verify.js | shasum -a 256
grep -n 'sha256' packages/verify/README.md
```

### 16.6 The identity origin's host

- [ ] (owner decision N-2: none in 0.3.0) The project runs no default identity origin, and nothing in the tree names
  one. Only if you later run a shared default: choose its host name once, because the name is the passkey's RP ID and a
  later move makes every person restore from the 12 words or the backup file. Use a name that is not a subdomain of a
  site, a hub or the demo, and do not use nip.io or sslip.io for it (a shared suffix is a shared cookie scope and a
  shared block list). The identity page is a folder of static files (`dist-idp/`, or the `felinar-<version>-idp.zip` of
  the release) that you serve from that name.
- [ ] Only if you later run a shared default: once the identity page answers at its name, name it where the documents leave it open. Nothing in the code
  defaults to an identity origin: a site names it with `publish --idp <origin>` (the pointer's `idp=`) or
  `<meta name="mw-idp">`, and a site without one answers every post with `E_IDP_UNREACHABLE`. Add
  `--idp https://<your identity origin>` to the publish commands of the README ("Try it", the guestbook for your own
  domain), QUICKSTART (A2) and DEPLOY; in DEPLOY's "The identity origin", the identity-origin row of PRIVACY's v0.3
  register and the status cells of the sign-in recipes, replace "By design, the project hosts no identity page" with the name;
  and change the changelog's known gap of N-2. This lists the places (in 0.3.0 it finds only the "by design" sentences):

```sh
git grep -n -i -E 'project hosts no identity page|no default (identity origin )?(exists )?yet|no identity origin is published yet|--idp https://<|project publishes (one|an identity)' -- README.md CHANGELOG.md ':(glob)docs/*.md' ':(glob)docs/recipes/*.md' ':(exclude)docs/PUBLISH-CHECKLIST.md'
```

- [ ] Only if you later run a shared default: serve it as static files over HTTPS with `frame-ancestors 'none'`, the script policy and `Referrer-Policy:
  no-referrer` that the build documents, and nothing else on the origin: no analytics, no third-party scripts, no other
  site ([DEPLOY.md](DEPLOY.md#the-identity-origin-running-your-own-with-toolsbuild-idpmjs)).
- [ ] Only if you later run a shared default: its bundle hash and build id go in the release notes of each release
  (step 10b), where the identity artifact's hash already goes; the README and [SECURITY.md](../SECURITY.md) point at the notes.
- [ ] Only if you later run a shared default: print the identity page's address on the recovery kit text.
- [ ] Only if you later run a shared default: decide who answers an incident at the identity origin ([OPERATIONS.md](OPERATIONS.md#runbooks-for-v03-incidents)).

### 16.7 Signed releases and the two-person rule (R 2.19)

- [ ] Make the release signing key once, offline: `node tools/keygen.mjs --out <a file outside the clone>` (sequence
  step 3b) writes a P-256 key file with mode 600 and prints its public key as `owner=p256:...`.
  `tools/verify-release.mjs sign` signs the two per-file hash lists of a release with it (ECDSA P-256), and `verify`
  checks a download against the pinned public key; no other key format works with the tool. Keep the key file on a
  drive you keep offline, backed up, and never in the clone (`*.jwk` is ignored, but a copy in the tree is one
  `git add -f` from public). The drive must keep file modes (APFS or Mac OS Extended, for example): the tools refuse a
  key file that others can read, a FAT or exFAT drive may not keep mode 600, and step 3b then prints STOP. Sequence step 3b
  pins its public key in the README and in [SECURITY.md](../SECURITY.md) (replacing their placeholder
  `RELEASE-KEY-NOT-PINNED-YET`) and in `PINNED_RELEASE_KEYS` of `tools/verify-release.mjs`, before the squash of step 5,
  so every package, zip and clone of the release carries the key and its `verify` refuses a list signed by any other
  key; the gate line of step 5b stops while the array is empty. The project holds no domain, so no DNS record carries
  the key. The second places need none: the line `Release key: p256:...` in the message of the annotated tag (step 10),
  `release-key.txt` with a detached signature by the project's OpenPGP key `SECURITY-KEY.asc` on the release page, and
  an archive copy of SECURITY.md at the tag (both step 10b), and from 0.3.1 on the key built into every earlier
  release. They protect against a takeover of the GitHub account after the release, not against you: you control all
  of them, and the OpenPGP key comes from the same repository. Say so when you describe them.
- [ ] Turn on immutable releases, a tag ruleset on `v*` (no deletion, no update, no force push) and the environment
  `release` with a required reviewer and a deployment rule that allows only the tags `v*`, all before the first tag
  (sequence step 9b). With two maintainers the reviewer is the one who does not push the tag. `.github/CODEOWNERS`
  names you for `build.lock.json`, the two lock files and `.github/`, and `.github/dependabot.yml` delays version
  updates by 14 days (`cooldown`, chosen; GitHub does not delay security updates). Both are in the tree and have not
  run on GitHub: check them after the first push (Insights, Dependency graph, Dependabot), add the second maintainer to
  CODEOWNERS when there is one, and then require code-owner reviews (section 13).
- [ ] If you are the only maintainer, the two-person rule on the lock file and a reviewer who is not the pusher cannot be
  met. Recruit a second person first, or publish as one maintainer: the release notes that sequence step 3 writes say
  so (change that line if a second maintainer reviews the release).
- [ ] Rehearse `tools/verify-release.mjs` (`list`, `sign`, `verify`) on a build of your own before the first tag (section
  14 says how it was rehearsed here), and after the first push read the cross-OS rebuild run
  (`.github/workflows/rebuild.yml`): its `compare` job must pass.
- [ ] Book the independent audit that R 2.19 requires before 1.0, with the scope in [SECURITY.md](../SECURITY.md).

### 16.8 Security reporting (sequence step 1b)

- [x] No mailbox: the project holds no domain, and a mailbox at a name nobody holds would deliver reports to whoever
  registers it. [SECURITY.md](../SECURITY.md) and the README send reporters to GitHub's private vulnerability reporting
  (sequence step 7 switches it on and prints `true`), and, if that fails them, to a public issue that asks only for
  contact, with the details encrypted to the project's OpenPGP key, committed as `SECURITY-KEY.asc` at the repository
  root (ed25519, fingerprint `4C44 C2A8 D935 27B7 4C88 1E20 A46F 0FB0 E1F8 0C26`, made 2026-10-25, expires
  2028-10-24). Its user id names no e-mail address; the block of sequence step 1b prints the fingerprint, checks that
  the user id holds no address and counts the fingerprint in both files. The same key signs `release-key.txt` at
  sequence step 10b (section 16.7). Before 2028-10-24, extend the key or publish a new one and change the fingerprint in
  SECURITY.md, the README and this section.
- [ ] Until a second route exists, private reports depend on GitHub alone. If you add one, use an address or account
  that belongs to the project only (a mail alias, a Matrix or SimpleX account), never your personal address, and name
  it in SECURITY.md and the README. If you run an identity origin or a demo on a host name you hold, also publish
  `/.well-known/security.txt` there with `Contact` and `Expires` (RFC 9116).

### 16.9 Real-device rows

- [ ] Run the v0.3 rows of [DEMO-RESULTS.md](DEMO-RESULTS.md) on real devices and record each one. A row never passes
  from emulation. The hardware they need follows; it is a summary, and the device column of each row in DEMO-RESULTS
  decides when they differ:

| Hardware or setup | Rows |
|---|---|
| iPhone on iOS 18.x, Safari and a Home Screen app | G-ID-1, G-ID-7, G-CH-2, G-CH-4, G-CH-6, G-CH-7, G-MD-2, G-MD-3, G-MD-8, G-SC-1, G-SC-3, G-SC-8, G-SO-3, G-SO-4 |
| An iPhone or iPad on iOS 15.4, a browser build at Chromium 110 and one at Firefox 115, and a low-end Android | G-ID-6, G-ID-8, G-MD-6, G-CH-6, G-SC-1, G-SC-8 |
| Android Chrome, with Google Password Manager | G-ID-2, G-ID-7, G-CH-1, G-CH-4, G-MD-5, G-MD-7 |
| Passkey providers: iCloud Keychain, Google Password Manager, Windows Hello, 1Password | G-ID-3, G-ID-3b |
| Desktop Firefox (normal and private), Chrome and Safari | G-ID-4, G-ID-8, G-MD-1, G-MD-7, G-CH-8 |
| Two in-app browsers | G-ID-7 |
| Phone and laptop, for the device link | G-ID-5 |
| A real host with a Node verifier | G-SI-1 |
| A staging site or hub, and a week or a month of it | G-CH-3, G-SC-4, G-SC-7, G-SC-11 |
| A tracker and synthetic ledgers | G-SC-1, G-SC-2, G-SC-3, G-SC-5, G-SC-6, G-SC-9, G-SC-10 |
| A TURN relay | G-CH-5 |
| A phone seeder at 128 KiB/s and a desktop seeder, for seeks | G-MD-4 |
| An iPhone with a notch or Dynamic Island (Safari) and an Android phone with a cutout (Chrome), in landscape | G-SO-5 |
| Five to eight people | G-ID-9 |

- [ ] Run the rows that the C2 design added (smart phone seeding, the zero-setup ladder, peer-to-peer calls and doors; the
  table "v0.3 C2: rows to add" of [DEMO-RESULTS.md](DEMO-RESULTS.md), cited from SZ). Rows G-PS-1 to G-PS-4 and G-CL-2 run on one
  iPhone and one Android phone before any card or document says what phones do in the background; nothing is quoted before
  its row has run, and failures are published too. Phone rows need HTTPS (the demo's `--tls` tier with the mkcert root on the
  phone) and a Node peer that logs when each wire closes (`tools/seed.mjs` with the optional `node-datachannel`).

| Hardware or setup | Rows |
|---|---|
| iPhone, iOS 26 and 27, tab and Home Screen app | G-PS-1, G-PS-2, G-PS-5, G-PS-6, G-PS-7, G-PS-8, G-PS-13, G-CL-2, G-CL-5, G-DR-1 |
| Two Android phones, one of them a Samsung; an installed web app | G-PS-3, G-PS-4, G-PS-5, G-PS-6, G-PS-7, G-PS-8, G-CL-3, G-CL-5, G-DR-2 |
| A phone on LTE and a laptop on home Wi-Fi | G-CL-1, G-CL-8, G-PS-11 |
| Desktops, and an iPhone on iOS 27 for screen share | G-CL-4, G-CL-6, G-DR-3 |
| A TURN relay that you own | G-CL-7 |
| Node peers and synthetic swarms | G-PS-9 |
| A staging site for 14 days | G-PS-10 |
| A Mac or Windows laptop running `tools/pin.mjs` for 14 days | G-PS-12 |
| A rented server (section 17) or a free host account | G-ZS1, G-ZS2, G-ZS3, G-ZS4 |
| Five to eight people | G-PS-14, G-CL-9 |
| A phone, `file:` and `data:` pages | G-DR-4 |

- [ ] Firefox runs in the automated harness since 2026-10-22 (Playwright Firefox 157.0, build firefox-1555, headless, on
  loopback; `npm run test:e2e:firefox`, [deviations/firefox.md](deviations/firefox.md)). Its 31 Firefox scenarios give
  harness facts for the desktop Firefox rows G6, G7, G-ID-4 and G-MD-1, recorded in those rows' Date, Versions and
  Measured cells; G-ID-8, G-MD-7, G-CH-8 and the C2 rows got nothing from it. The Result of a Firefox row stays "not
  yet run" until a person runs it in Firefox on a real device: never record one as passed from the harness or from a
  guess.

### 16.10 Claims

- [ ] The README, the release notes and the repository description say which v0.3 features exist and which rows ran.
  Do not claim more than those rows support, and keep "pre-release" until the audit and the gate are done.
- [ ] The tagline and the repository description use the wording of the README ("felinar: websites loaded by magnet link,
  verified in your browser, from a plain static host. No backend. The light web."). Sites in the light web are visible by
  design: any peer you connect to sees your IP address, and every document says so plainly (review/DESIGN-REVIEW.md,
  section 4); nothing may describe felinar as anonymous, private by default or censorship-proof.

### 16.11 The hub domain

- [ ] (owner decision) Decide whether a hub runs for 0.3.0 and under which domain. A hub with a subdomain per site needs
  the domain on the Public Suffix List first (the entry can take weeks, and a pull request to the list is yours to make);
  until then persistent identity is off on that hub, and the loader and the identity origin must both be built with the
  suffix (`build-idp --hub-suffix`, [DEPLOY.md](DEPLOY.md)). The directory code stays off until a lawyer has
  looked at it (decision N-7; none is engaged for 0.3.0), and what the operator owes under the hub rules of
  [OPERATIONS.md](OPERATIONS.md) is yours to settle: in the US a hub needs a registered DMCA agent, may have to report
  child abuse material to NCMEC and may be a covered platform under the TAKE IT DOWN Act; in the EU and the UK the DSA and
  the Online Safety Act rows of OPERATIONS.md apply.
- [ ] Without a hub, `examples/social` still runs as personal sites with a hub-less follow lane, and the release notes
  that sequence step 3 writes say so (change that line if a hub runs). Never run a hub under `nip.io` or `sslip.io`:
  neither is on the list.

### 16.12 Export of the encryption source code (owner; sequence steps 5b and 6)

Nobody has given legal advice on this. It rests on the text of 15 CFR 734.7, 742.15 and 772.1 and on BIS's page
"Encryption items not subject to the EAR", and for Canada on the Export Control List and its 2026 Guide, as read on
2026-10-22.

- [ ] Read the US rule. Publicly available encryption source code is not subject to the EAR (15 CFR 742.15(b)(1)). The
  e-mail notice is required only for source code that provides or performs "non-standard cryptography" (742.15(b)(2),
  in force since 2021-03-29). BIS's own page still reads as if it applied to all such source code: the rule text
  decides, and the page is a reason to send the notice anyway.
- [ ] Decide, and write the decision into SECURITY.md ("Cryptography and export rules"). The primitives are published
  standards; the chat handshake, the sealed box and the media format are this project's own protocols
  (`src/chat/noise.js`, `src/chat/seal.js`, `src/media/format.js`), published here but not adopted by a standards body.
  The rule text does not say whether that is "non-standard cryptography". Sending the notice costs one e-mail and
  settles it either way.
- [ ] If you send it: one message to `crypt@bis.doc.gov` and `enc@nsa.gov` giving the internet location of the source
  code (the GitHub repository and, if published, the npm package page) or a copy. Send it on or before the day the first
  public copy exists, and again only if the location changes (a rename or transfer), not for updates at the same
  location. Keep the sent message and its delivery proof outside the repository and put the date into SECURITY.md. You
  send it; an agent never does.
- [ ] The author's country does not decide the US question: copies on GitHub's and npm's servers are items "in the
  United States" if the servers are there (15 CFR 734.3(a)(1)). No BIS text was found on what a foreign author must do.
- [ ] Canada: on the reading in SECURITY.md, publishing without restriction keeps the software "in the public domain"
  under the General Software Note, so no permit or notice is needed. Check again when distribution is restricted, a
  build goes to a named customer, a new cryptographic construction is added or the Guide changes. For a written answer,
  ask Global Affairs Canada's Export Controls Division for an advisory opinion.

## 17. The zero-setup route: nip.io, sslip.io and the one-box deploy (owner)

This is the ladder that lets someone publish a felinar site with no domain of their own (the server is still rented under an account its provider can close)
([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), 3.2; the user pages are
[QUICKSTART.md](QUICKSTART.md), "Start without a domain", and [DEPLOY.md](DEPLOY.md), "Zero-setup: a server without a
domain"). Nothing here has run against a real server or a public resolver yet: rows G-ZS1 to G-ZS4 of
[DEMO-RESULTS.md](DEMO-RESULTS.md) are "not yet run", and the README must not promise this route until G-ZS1 and G-ZS2 pass.

- [ ] Know what the name is. A server with a public IPv4 address `203.0.113.7` is named `203-0-113-7.nip.io`, and
  `203-0-113-7.sslip.io` is the same service under its second name. Both are one free DNS service run by two volunteers,
  with no terms and no uptime promise, a phishing block list (a blocked address answers a block page, so a recycled server
  address can be listed before you use it) and no Public Suffix List entry. They cannot carry a `_magnet` TXT record, so the
  signed page tag is the only pointer and it expires; the date is printed when you publish. `nip.io` comes first because a
  DNS filter list covers `sslip.io` and not `nip.io`.
- [ ] Rehearse with nothing changed. `--dry-run` prints every host and every command and contacts nothing. The real run
  looks the name up with your computer's resolver before it publishes anything, tries `sslip.io` if `nip.io` is blocked or
  wrong, and stops with a plain sentence if both fail (`tools/name-check.mjs`):

```sh
npx felinar ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org --dry-run
```

- [ ] Ship to a rented server (a public IPv4 address, Docker with Compose 2.17 or newer, rsync, ports 80 and 443 open to the
  internet, an ssh key). `ship` publishes with the Let's Encrypt **staging** authority first and switches to production
  once the staging certificate is there, so a closed port costs no production certificate. The server needs a clone at the
  remote directory (default `/opt/felinar`):

```sh
ssh root@203.0.113.7 'git clone https://github.com/'"$OWNER"'/felinar.git /opt/felinar'
npx felinar ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org
node tools/check-site.mjs https://203-0-113-7.nip.io/
```

  By hand, the same box is `deploy/one-box/` ([README](../deploy/one-box/README.md)): `LW_SITE=203-0-113-7.nip.io` in `.env`,
  then `docker compose up -d --build`. Keep the work directory `ship` prints (`dist-ship/<name>`): it holds the ledger's
  first block, and an update without it is refused, because a new first block is a new ledger for every visitor. The owner
  key stays on your computer and is never copied.
- [ ] Record G-ZS1 (a real server with a nip.io name, staging then production and one renewal), G-ZS2 (iOS Safari and Android
  Chrome load it), G-ZS3 (a returning visitor with DNS failing) and G-ZS4 (GitHub Pages end to end with `check-site`) in
  [DEMO-RESULTS.md](DEMO-RESULTS.md). Open questions the rows answer: whether Let's Encrypt issues for a fresh nip.io name
  under the shared limits (5 failed validations per name per hour), whether Caddy falls back to ZeroSSL, and how the
  three engines treat `*.nip.io` names.
- [ ] The release notes that sequence step 3 writes say what the route is not: the name changes if the IP changes,
  visitors who already opened the site keep their saved copy if the DNS service stops, the box is one server and not a
  backend, and it is a stepping stone to a domain you own, where the pointer can also live in DNS
  ([DEPLOY.md](DEPLOY.md)). Read that line before the squash.

## If something goes wrong

Before step 5b nothing has left this machine: fix the problem, run the steps it touches again, and squash again (the
bundle of step 5 keeps the old history).

The `--private` route of step 5b pushes before step 6. While the repository is still private and nobody else has
cloned it, a squash that must be redone is pushed again with `git push --force-with-lease origin main` (step 9b's
rulesets do not exist yet), or the repository is deleted and created again; once it is public, the rule below applies.

From step 5b on, nothing is deleted and nothing is tagged again. npm keeps the version number 0.3.0 for good, even
after an unpublish. The tag ruleset of step 9b forbids deleting or moving a `v*` tag and names nobody who may bypass
it; a published release is immutable and keeps its files and its tag; and the release job refuses a tag that already
has a release ("Nothing is replaced: tag a new version instead"). So a bad 0.3.0 is superseded, never replaced: fix
the problem on `main` through a pull request, release 0.3.1 with the release process of
[CONTRIBUTING.md](../CONTRIBUTING.md) and the sections of this page it names, and mark 0.3.0 as superseded in its
release notes and on npm. A fix that the first CI run (step 6) needs in a file of the package goes the same way: npm
has 0.3.0 already, so the fix is 0.3.1, and v0.3.0 is never tagged; the 0.3.1 entry of the changelog says so.

```sh
gh release view v0.3.0 --repo "$OWNER/felinar" --json body --jq .body > "${TMPDIR:-/tmp}/notes-v0.3.0.md"
#   put a first line into that file, such as "Superseded by 0.3.1: <what is wrong>. Do not use this release.", then:
gh release edit v0.3.0 --repo "$OWNER/felinar" --notes-file "${TMPDIR:-/tmp}/notes-v0.3.0.md"
npm deprecate felinar@0.3.0 "Superseded by 0.3.1: <what is wrong>"
npm deprecate @felinar/verify@0.3.0 "Superseded by 0.3.1"
```

While 0.3.0 is only a draft, skip the `gh release` lines and never publish that draft. Treat anything that was public as exposed, and
rotate every secret that was in it at once: a commit, a tag or a package that someone copied stays copied. Making the
repository private (`gh repo edit "$OWNER/felinar" --visibility private --accept-visibility-change-consequences`)
hides it from now on, but it takes back nothing that was cloned, forked or downloaded.
