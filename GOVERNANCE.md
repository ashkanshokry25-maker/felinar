# Governance

felinar is a small project with a light governance model. This page says who decides, how decisions are made,
how the specification changes, and how security reports are handled. It changes by pull request, like everything
else. How to contribute is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Principles

- **Decide in public and write it down where the next person looks.** Decisions live in issues and pull requests,
  and their outcome lives in the specification, [CHANGELOG.md](CHANGELOG.md) and the review documents in
  [docs/review/](docs/review/), not in a chat.
- **The documents are the specification.** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/INTERFACES.md](docs/INTERFACES.md), amended by [docs/review/DIGEST-AMENDMENTS.md](docs/review/DIGEST-AMENDMENTS.md),
  say what the code does. Code that disagrees with them is a bug in one or the other.
- **Say only what is true.** The wording rules in [CONTRIBUTING.md](CONTRIBUTING.md) apply to everything the project
  publishes, including the README and the release notes.
- **Use the smallest process that works.** Lazy consensus for most changes. An RFC only where a change is expensive
  to undo: the specification, a frozen format and the security model.

## Roles

| Role | Who | What they can do |
|---|---|---|
| Contributor | Anyone | Open issues and discussions, comment, send pull requests. No permission needed. |
| Maintainer | People listed below | Triage, review and merge; cut releases; receive security reports; enforce the [Code of Conduct](CODE_OF_CONDUCT.md). |
| Lead maintainer | One of the maintainers | Breaks ties, owns the repository settings and the credentials a release needs. |

Current maintainers:

| GitHub account | Role | Areas |
|---|---|---|
| `@ashkanshokry25-maker` | Lead maintainer, releases, security contact | Everything |

At the first public release the project has one maintainer, so not every change can get a second pair of eyes. A
second maintainer is the most useful thing a regular contributor can become.

**Becoming a maintainer.** A maintainer proposes a contributor after sustained, careful work over several months.
The other maintainers have 7 days to object; with no objection the contributor is added. Maintainers use two-factor
authentication on their accounts, because a maintainer account can publish the code that every visitor of a site
runs. A maintainer who has done nothing for 12 months may be moved to emeritus after a message to them, and can
come back by asking.

## How decisions are made

| Kind of change | Who decides | How |
|---|---|---|
| Bug fixes, tests, docs, tooling that doesn't change a format | One maintainer | Merge once approved and no objection is unresolved |
| A new feature inside the specification | One maintainer | An issue first, then a pull request |
| A new dependency, or an upgrade of the vendored WebTorrent bundle | One maintainer, after discussion | Discussed in an issue; `build.lock.json` changes in the same pull request |
| The specification, a frozen format, the `window.mw` surface, the wire protocol, consent or privacy defaults, claims in the security model, the wording rules | The maintainers | An RFC (below) |
| A security fix | The maintainers who hold the report | The embargo process (below) |
| The roadmap | One maintainer | A pull request to [docs/ROADMAP.md](docs/ROADMAP.md); moving an item between tiers cites the evidence |
| This document | All maintainers | A pull request they all approve, after 7 days open |

Maintainers don't merge their own non-trivial changes without a review when another maintainer is available.

If a discussion doesn't converge, the lead maintainer decides and writes the reason in the thread. A conflict of
interest, or a conduct question, is handled under the [Code of Conduct](CODE_OF_CONDUCT.md); a maintainer who is
part of a report doesn't decide it.

## RFCs: changing the specification

Sites, stored data and other implementations depend on the specification, so changes to it are proposed, argued and
accepted before they are made.

**An RFC is required for:**

- Any change to the normative text of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) or
  [docs/INTERFACES.md](docs/INTERFACES.md).
- A frozen format: the pointer grammar (MW-PTR/1), the block, the gossip HELLO frame and `mw_chain1`, and the
  golden vectors in `test/vectors/`.
- The `window.mw` surface that a site can call, and what only loader-owned UI may do.
- Consent, privacy and bandwidth defaults, and any claim in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) or
  [docs/PRIVACY.md](docs/PRIVACY.md).
- The wording rules.

**No RFC is needed** for a fix that makes the code match the specification, an editorial change, a new tool or flag
that changes no format, or a new document.

**How it works:**

1. Open an issue with the feature request form and start the title with "RFC:". A maintainer adds the `rfc` label.
   Talking it over in a discussion first is welcome.
2. Write it in the shape the design review uses ([docs/review/DESIGN-REVIEW.md](docs/review/DESIGN-REVIEW.md)):
   - **Sources:** the problem, and the evidence (issues, research notes, measurements).
   - **Change:** the exact text of the new or changed rule.
   - **Amend:** which sections of ARCHITECTURE and INTERFACES change.
   - **Compatibility:** whether it touches a frozen format or a golden vector, whether it needs a new format
     version, and what happens to existing data and to visitors on the old version.
   - **Security and privacy:** who sees what, what needs consent, how it can be abused.
   - **Accept:** the test, end-to-end scenario or drill that shows it works.
   - **Alternatives and open questions.**
3. It stays open at least 7 days. A change to a frozen format or to the security model stays open longer if
   anyone asks for time.
4. The maintainers decide by lazy consensus, and the lead maintainer closes it as accepted, declined with a
   reason, or needs work.
5. The pull request that implements it edits ARCHITECTURE and INTERFACES, marks each changed rule with the version
   and the RFC (as "v0.2.1" marks do now), adds the tests and the "Accept" check, appends golden vectors if a
   format changed, updates the security and privacy documents if a guarantee changed, and adds a line to the
   changelog (under "Breaking" if it breaks anything). Where the build differs from the text, the reason goes in
   [docs/DEVIATIONS.md](docs/DEVIATIONS.md).
6. A declined idea that is likely to come back goes into "Not planned" in [docs/ROADMAP.md](docs/ROADMAP.md) with the
   reason.

**Frozen formats.** A format covered by golden vectors changes only through a new format version: a new version
string, readers that accept the old one for a stated overlap, and new vectors appended. Editing a vector, or
changing what a reader of the current version accepts or rejects, is a breaking change and needs an RFC.

## Releases

- Versions follow semantic versioning. Before 1.0 a minor version can change behaviour; frozen formats follow the
  rule above.
- 1.0 means the release gate in [docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md) passed on real devices. Until then no
  release is called production-ready, in the README, the changelog or anywhere else.
- Maintainers cut releases with [docs/PUBLISH-CHECKLIST.md](docs/PUBLISH-CHECKLIST.md) and the release process in
  [CONTRIBUTING.md](CONTRIBUTING.md).
- Only the latest minor release line gets fixes ([SECURITY.md](SECURITY.md)).

## Security reports and embargo

Reports come in through GitHub's private vulnerability reporting, as [SECURITY.md](SECURITY.md) describes. SECURITY.md
holds the response times (an acknowledgement within 3 business days, a triage decision within 10, a fix aimed at
30 days and an advisory within 90). This is how the maintainers handle a report.

- **Who sees it.** The maintainers who are security contacts, the reporter, and anyone a maintainer brings in to
  fix or review, who is asked to keep it private.
- **Where it stays private.** Nothing about an unfixed vulnerability goes into a public issue, pull request, commit
  message, discussion or chat. The fix is developed in the advisory's private fork and merged when the release is
  ready. A regression test that fails without the fix is part of it.
- **When it ends.** The embargo ends when the fixed version is released and the advisory is published, which
  SECURITY.md aims to do within 90 days of the report. If the problem is being exploited, the maintainers release
  sooner and say what visitors and site owners should do, and they tell the reporter first when time allows.
- **What a release says.** A fix to the loader or the Service Worker reaches visitors only when site owners
  redeploy. The advisory therefore names the files to replace and says whether the kill switch
  ([docs/RUNBOOK.md](docs/RUNBOOK.md), section 11) is the stopgap.
- **Credit.** The reporter is credited in the advisory unless they prefer not to be.
- **No early-warning list yet.** There is no private list for site owners, pinners or hub operators. If one is
  created, it will be announced here.

A report that restates a documented property (visitors' IP addresses are visible, the ledger has no finality, the
host is the trust root) isn't a vulnerability. A report that shows a documented protection failing is what the
project wants.

## Continuity

The code is MIT licensed, so anyone can fork it. Each site serves its own copy of the loader from its own host,
so a site doesn't depend on this repository while it runs; it depends on it for fixes. If the lead maintainer can
no longer act, the remaining maintainers choose a new lead. If no maintainer is left, the licence and the
documented formats (golden vectors included) are what lets someone else carry on.
