# Documentation

This is the map of the felinar documentation. The project page is the [README](../README.md). This page says
which document answers which question and in which order to read them.

The documents describe version 0.3.0, the release being prepared: a pre-release, and the first public one (0.2.1 was
never published). The release gate on real devices has not run ([DEMO-RESULTS](DEMO-RESULTS.md)), so nothing here
calls felinar production-ready.

A section that opens with the line "Status: v0.3, built and reviewed." describes v0.3 (one identity for many sites,
sign-in for any site, private messages, files and media, and a social example): the code is in this tree, 0.3.0 carries
it, and it passes its tests on loopback ([INTEGRATION-STATUS](INTEGRATION-STATUS.md)). "Reviewed" means that the
review round of the design review's Part 5.3 (the judges, the red-team attackers and the conformance reviewers against the
built code) ran, from 2026-10-22 to 2026-10-24, after the code review of the v0.3 and C2 code, and that the blockers it
confirmed are fixed; what it left open is in the CHANGELOG's known gaps (until then the line read "built, not yet reviewed"). The real-device gate has not run either. It is the text that has to be true
before 0.3.0 is published. The source of truth for that build is [the v0.3 design review](review/V03-DESIGN-REVIEW.md).

A section that opens with the line "Status: v0.3 C2, built and reviewed." describes phase C2 (smart seeding on phones, the pin node's
receipts and heartbeat, the zero-setup ladder, peer-to-peer calls and doors), built from [the C2 design](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md)
and [S4](research/v03/S4-doors.md) and integrated on 2026-10-20 (until then it read "Status: v0.3 C2 (proposed), not yet built.", and until the review round
"Status: v0.3 C2, built, not yet reviewed."); 0.3.0 carries it. The review round read the C2 code too. It ran on loopback only; no C2 row of [DEMO-RESULTS](DEMO-RESULTS.md) has run on a real device or network.

## Start here

Pick the path that matches what you are about to do. Each step is one document. Stop when your question is
answered.

### I want to publish a new site

1. [WHY](WHY.md): what you get, the condition attached to each benefit, and "When not to use it".
2. [QUICKSTART](QUICKSTART.md), track A: publish the example for your domain, deploy it, check it.
3. [ONBOARDING](ONBOARDING.md): for a team, the decision tree, prerequisites, roles and the questions to answer first.
4. [CRUD](CRUD.md) and [SDK](SDK.md): if the site keeps shared data such as a guestbook, comments or a poll.
5. [DEPLOY](DEPLOY.md): hosts, DNS, deploy order and your duties as an owner.
6. [OPERATIONS](OPERATIONS.md): monitoring, incidents and abuse handling once the site is live.

### I want to move an existing site

1. [WHY](WHY.md): read "When not to use it" first.
2. [COMPATIBILITY](COMPATIBILITY.md): whether your browsers, host, framework and features fit.
3. [MIGRATION](MIGRATION.md): the drop-in path, what changes for visitors and crawlers, and how to roll back.
4. [Recipes](recipes/): one page per framework or host, with the exact settings.
5. [QUICKSTART](QUICKSTART.md), track B: the commands for a drop-in publish.
6. [DEPLOY](DEPLOY.md): upload order and headers.

### I want to add "Sign in with felinar" to a site (v0.3)

1. [WHY](WHY.md#v03-sign-in-for-any-site-and-the-honest-ceiling): what the person gets, and the condition attached to each part.
2. [Sign-in on a Node server](recipes/signin-server-node.md): issue a challenge, verify a proof, one shared nonce store for many instances.
3. [The sign-in widget](recipes/signin-widget.md): the self-hosted button with its hash.
4. [mw-signin-v1](specs/mw-signin-v1.md) and [@felinar/verify](../packages/verify/README.md): the format and the library.
5. [PRIVACY](PRIVACY.md#v03-identity-chat-files-and-private-media): the recipients to name in your privacy notice.

### I want to work on felinar

1. [CONTRIBUTING](../CONTRIBUTING.md): setup, tests, coding rules, wording rules and how a change gets merged.
2. [ARCHITECTURE](ARCHITECTURE.md), then [INTERFACES](INTERFACES.md): the specification and the module contracts.
3. [DEV-NETWORK](DEV-NETWORK.md): why every test browser stays on 127.0.0.1.
4. [RUNBOOK](RUNBOOK.md): build, test, demo, publish, kill switch and troubleshooting, command by command.
5. [DEVIATIONS](DEVIATIONS.md): where the build differs from the specification and why.
6. [INTEGRATION-STATUS](INTEGRATION-STATUS.md): what passes today, newest first.
7. [ROADMAP](ROADMAP.md) and [GOVERNANCE](../GOVERNANCE.md): what to pick up, and how a specification change is made.

To build a site on the SDK instead, read [CRUD](CRUD.md), then [SDK](SDK.md), then the
[examples](../examples/).

### I run trackers, pin nodes or hosts

1. [DEPLOY](DEPLOY.md): deploy order, your own tracker, a pin node and publishing from CI.
2. [deploy/](../deploy/): the tracker, pin node and GitHub Actions templates.
3. [OPERATIONS](OPERATIONS.md): monitoring without a backend, capacity, the incident runbook, the notice-and-action runbook and privacy operations.
4. [RUNBOOK](RUNBOOK.md): the kill switch (section 11) and troubleshooting.
5. [PRIVACY](PRIVACY.md) and [SECURITY-MODEL](SECURITY-MODEL.md): who sees what, and what is and is not protected.
6. [A pin node for a hub](recipes/hub-pin.md) and [DEPLOY](DEPLOY.md#central-storage-the-hub-pin-and-snapshot-service): central storage, and what it costs and sees (v0.3, proposed).
7. [deploy/one-box](../deploy/one-box/README.md): one rented server with a `nip.io` name and automatic HTTPS, started by `npx felinar ship` (v0.3 C2; not yet run against a real server).

### I am reviewing it (security, privacy, product, due diligence)

1. [CRITIQUE](CRITIQUE.md): where the design is weakest, and what would make it fail.
2. [SECURITY-MODEL](SECURITY-MODEL.md): assets, actors, protections and explicit non-protections, and [THREAT-MODEL](THREAT-MODEL.md): the long tables of the v0.3 design, every red-team attack and the honest limits.
3. [PRIVACY](PRIVACY.md): the recipients register. It is not legal advice.
4. [ARCHITECTURE](ARCHITECTURE.md) section 13 and the [design review](review/DESIGN-REVIEW.md): why the rules are what they are. For v0.3, the [v0.3 design review](review/V03-DESIGN-REVIEW.md).
5. [DEMO-RESULTS](DEMO-RESULTS.md): what has and has not been tested on real devices.
6. [Research index](research/README.md): the evidence, with the four digests first.
7. [CHANGELOG](../CHANGELOG.md) and [ROADMAP](ROADMAP.md): what exists and what is known to be missing.

## All documents

### Learn and decide

| Document | What it covers |
|---|---|
| [WHY](WHY.md) | The long-form case: the problem, the idea, the trade-offs, the economics (a model, not measurements), use cases, prior art; the v0.3 part adds sign-in, private messages and, as v0.3 C2, what readers who agree can carry and what calls cost |
| [QUICKSTART](QUICKSTART.md) | From nothing to a published site in two tracks: a new shell-mode site, or an existing site with drop-in |
| [ONBOARDING](ONBOARDING.md) | The intake for teams: decision tree, prerequisites, roles, an intake form, a 30-60-90 day plan and what to tell your visitors |
| [FAQ](FAQ.md) | Short, honest answers with links to the long ones |
| [CRITIQUE](CRITIQUE.md) | A frank critique: what is new, where the design is weakest, what would make it fail or succeed, and what is still to measure |
| [ROADMAP](ROADMAP.md) | What comes after 0.3.0, in tiers, with the research behind each item; phase C2, the v0.4 adoption list and what the browser-only decision rules out |

### Build a site

| Document | What it covers |
|---|---|
| [CRUD](CRUD.md) | Backend-free create, read, update and delete on the site ledger, with the limits |
| [SDK](SDK.md) | Every `mw` method, its parameters, results, events and error codes, per mode |
| [Examples](../examples/) | A shell-mode guestbook, an existing multi-page site in drop-in mode, and this project's homepage |

### Migrate an existing site

| Document | What it covers |
|---|---|
| [MIGRATION](MIGRATION.md) | The drop-in path in three steps, the shell alternative, rollback, and what stays on your host |
| [COMPATIBILITY](COMPATIBILITY.md) | Browsers, features by mode, hosts, frameworks and network conditions, and what stays on a server; v0.3 adds key storage and the capability matrix, and v0.3 C2 what phones do in the background, calls and the rungs without a domain |
| [Recipes](recipes/) | Per framework, CMS export and host: the settings, the publish command and the known problems; three v0.3 recipes cover sign-in on a Node server, the sign-in widget and a hub's pin node |

### Deploy and run

| Document | What it covers |
|---|---|
| [DEPLOY](DEPLOY.md) | What the host must do, host recipes, the DNS record, deploy order, updates, rollback, the kill switch, takedown, your own tracker, a pin node, CI/CD, hubs and owner duties |
| [OPERATIONS](OPERATIONS.md) | Day-2 work: monitoring without a backend, capacity, the incident runbook (key compromise included), abuse and legal operations with the notice-and-action runbook, privacy operations and recurring tasks |
| [RUNBOOK](RUNBOOK.md) | Build, test, demo, publish, deploy order, the kill switch and troubleshooting, command by command |
| [deploy/](../deploy/) | Templates: a tracker with Caddy, a pin node image, a GitHub Actions workflow for site owners and, as v0.3 C2, [one-box](../deploy/one-box/README.md): a rented server with a `nip.io` name and automatic HTTPS for a site with no domain |

### Security and privacy

| Document | What it covers |
|---|---|
| [SECURITY-MODEL](SECURITY-MODEL.md) | The threat model: what is protected, who is trusted with what, protections threat by threat, what is not protected, budgets and the supply chain; a v0.3 section and a v0.3 C2 section (with "Trust on first door") end it |
| [THREAT-MODEL](THREAT-MODEL.md) | The living threat model of the v0.3 design (proposed): what each observer sees before and after, threats added, every red-team attack and its status, honest limits and findings from the build; v0.3 C2 adds rows for calls, seeding, the pin node and the no-domain rungs |
| [PRIVACY](PRIVACY.md) | Who receives what (the recipients register), what stays on the device, what visitors are told, retention, and a privacy-notice template; v0.3 sections add the identity page, chat, files and media, and v0.3 C2 adds calls, re-sharing, the pin heartbeat, dock mode and doors. Not legal advice, and no lawyer has reviewed it |
| [SECURITY](../SECURITY.md) | How to report a vulnerability, the response times, the supported versions and the security program for 1.0 |

### Specification

| Document | What it covers |
|---|---|
| [ARCHITECTURE](ARCHITECTURE.md) | The normative specification: modes, pointer, loader flow, site ledger, Service Worker, policy, SDK, tooling, tests; 8.1 (smart seeding), 15.14 (calls), 15.15 (doors) and 15.16 (the C2 integration) are v0.3 C2 |
| [INTERFACES](INTERFACES.md) | The module contracts, one section per source file; the last part is v0.3 C2 |
| [SEEDING-AND-ZERO-SETUP-DESIGN](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) | The phase C2 design (built as v0.3 C2): smart seeding on phones, the zero-setup ladder, adoption mechanics and peer-to-peer calls. The source of ARCHITECTURE 8.1 and 15.14 and of the C2 lanes |
| [DIGEST-AMENDMENTS](review/DIGEST-AMENDMENTS.md) | The v0.2.1 amendments to both, with a status per item |
| [V03-DESIGN-REVIEW](review/V03-DESIGN-REVIEW.md) | The resolved v0.3 design: the verdict, 78 must-fix items, the decisions, the design of identity, sign-in, chat, files and media, the example site, the test plan and the build plan. ARCHITECTURE section 15 and the last section of INTERFACES carry its contracts and stay proposed |
| [mw-signin-v1](specs/mw-signin-v1.md) | The sign-in proof format, its verification order and its vectors (v0.3, written with the code that landed) |
| [DEVIATIONS](DEVIATIONS.md) | Where the build differs from the specification, and how ambiguous points were read |

### Project status and process

| Document | What it covers |
|---|---|
| [INTEGRATION-STATUS](INTEGRATION-STATUS.md) | What passes today and what each milestone changed, newest first |
| [DEMO-RESULTS](DEMO-RESULTS.md) | The release gate on real devices: every row with its procedure, and its result once it has run; the v0.3 rows and the C2 rows (G-PS, G-ZS, G-CL, proposed) follow them |
| [PUBLISH-CHECKLIST](PUBLISH-CHECKLIST.md) | What the repository owner checks before the first public push and before each release |
| [DEV-NETWORK](DEV-NETWORK.md) | The network policy for developer machines: tests stay on 127.0.0.1 |
| [CHANGELOG](../CHANGELOG.md) | What changed in each version, and the known gaps |
| [CONTRIBUTING](../CONTRIBUTING.md) | Setup, tests, coding and wording rules, pull requests, issue labels, releases |
| [GOVERNANCE](../GOVERNANCE.md) | Maintainers, decisions, the RFC for specification changes, the security embargo |
| [CODE_OF_CONDUCT](../CODE_OF_CONDUCT.md) | How we treat each other |

### Research and review trail

None of this is normative. It is the evidence behind the decisions and the record of how they were checked.

| Folder or file | What it holds |
|---|---|
| [research/README.md](research/README.md) | The index of 42 research files, with a status for each topic and the five topics never researched |
| [research/RESEARCH-DIGEST.md](research/RESEARCH-DIGEST.md) | Wave 1: engine, trackers, serving, DNS, mobile |
| [research/MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md) | Wave 2a: moving existing sites |
| [research/PRODUCTION-DIGEST.md](research/PRODUCTION-DIGEST.md) | Wave 2b: trackers, connectivity, observability, abuse and legal operations |
| [research/IMPROVEMENTS-DIGEST.md](research/IMPROVEMENTS-DIGEST.md) | Wave 2c: the ledger, identity, hubs, testing, standards, economics |
| [research/labs/](research/labs/) | The experiments behind the research files, kept so they can be re-run (follow [DEV-NETWORK](DEV-NETWORK.md)) |
| [research/v03/README.md](research/v03/README.md) | The v0.3 research: differentiators, privacy failures, identity and authentication, realtime and files, the six judges and the eight red-team attackers; the phase C2 inputs S1 to S4 (phone seeding, zero-setup hosting, adoption, doors) and the seeding and zero-setup design |
| [research/labs/c2-calls-lab](research/labs/c2-calls-lab/README.md) | Fake and mock media devices and a loopback call in Playwright Chromium and WebKit: the evidence for the calls design, measured 2026-10-20, loopback only |
| [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md) | The design review. Section 4 holds the binding wording; section 7 lists code review round 1, finding by finding |
| [review/](review/) | The four design critiques, the four code reviews, and the superseded v0.1 specification |
| [deviations/](deviations/) | The per-agent notes and deviations. They are the source; DEVIATIONS merges the v0.2 notes and the v0.2.1 notes are read in place |
| [assets/](assets/) | The logo, the architecture diagram and the social preview image |

## Which documents are normative

[ARCHITECTURE](ARCHITECTURE.md), [INTERFACES](INTERFACES.md) and [DIGEST-AMENDMENTS](review/DIGEST-AMENDMENTS.md)
are the specification. Code that disagrees with them is a bug in one or the other, and the pull request that finds it
fixes the wrong one. The v0.3 sections of ARCHITECTURE (15) and INTERFACES (the v0.3 part) describe the code as built (what
is not built is marked "(proposed)"); the C2 parts (ARCHITECTURE 8.1, 15.14 to 15.16, and the last part of INTERFACES) describe the C2 code as
built and integrated on 2026-10-20, marked "v0.3 C2". They became normative after the review round of 2026-10-22 to 2026-10-24
([V03-DESIGN-REVIEW](review/V03-DESIGN-REVIEW.md), section 5.4), with what is still not built marked "(proposed)"; before
that, the design review was the source of truth for the v0.3 build. Section 4 of the [design review](review/DESIGN-REVIEW.md) sets the wording that every
user-facing text follows. Everything else describes, explains or advises. The research is evidence, not a rule.
Changing the specification takes an RFC ([GOVERNANCE](../GOVERNANCE.md)).

## Terms used across the documents

| Term | Meaning |
|---|---|
| Loader | The small static program (a page, scripts and a Service Worker) that your HTTPS host serves on every visit. It fetches, checks and shows the site |
| Pointer | A record signed with the owner key. It names the torrent, the web seed, the trackers and the owner key. It sits in a `<meta>` tag, a DNS TXT record or the URL fragment |
| Shell mode | The loader runs the site in a same-URL frame from its torrent. For new sites and returning visitors who must ride out a host outage |
| Drop-in mode | One script tag on an existing site's own pages. The host keeps serving the HTML, and the other files come from the visitor's verified copy |
| Hub | One loader that opens many sites by magnet link. Per-site subdomains, or a shared origin for demos and one publisher |
| Web seed | Your host's own copy of the site files, fetched over HTTP with `Range` requests. It is what keeps the site loading when nobody else is online (`ws=` and `xs=` in the pointer) |
| Tracker | A WebSocket server that introduces visitors to each other. It does not carry the site's data |
| Site ledger | A signed, hash-linked log that every visitor copies and verifies. No mining, no consensus, no finality. Sites use it through `mw.db` |
| Owner key | The key that signs the pointer and the ledger's control blocks. It never enters a browser |
| Pin node | A browser kept open on a machine you control (`tools/pin.mjs`) so the site and its ledger always have one copy online. (v0.3 C2) It also answers with signed receipts and writes a signed heartbeat |
| Dock mode | (v0.3 C2) A phone on a charger with the screen kept on, sharing for 2 hours by default and 8 at most. The only web route to a phone that is online for long |
| Seeding lanes | (v0.3 C2) Hand-off (H), Keep (K) and Echo (E): what a browser shares first, under a budget by device, network, power, session and month |
| Identity origin | (v0.3, proposed) The one web address where a person's identity lives. A site never holds the root; it gets that site's keys or a signed proof |
| Freeze group | (v0.3, proposed) The set of ledger format changes that have to ship together before any public ledger exists: `unban`, `keyinfo`, `rotate`, `checkpoint` and the rules around them |
| Hub pin | (v0.3, proposed) A hub's optional pin, snapshot and mailbox service. It is central storage that its operator pays for |

## Conventions

- The tools run as `node tools/<tool>.mjs` in any clone, or as `felinar <command>` (`npx felinar <command>`
  from the root of a clone, or `node bin/felinar.mjs <command>`), which starts the same file with your arguments
  unchanged. The README, DEPLOY, OPERATIONS and DEMO-RESULTS use the short form; QUICKSTART, RUNBOOK, MIGRATION,
  CRUD and the recipes use the `node tools/...` form. Every command prints its options with `--help`, and the
  documents list only flags that exist.
- A number is given only when it was measured or comes from a cited source. Economics figures are model outputs, and
  the documents say so.
- Every benefit comes with its condition. For example, "stays up when nobody is online" needs `ws=` and `xs=` in the
  pointer.
- The writing and wording rules are in [CONTRIBUTING](../CONTRIBUTING.md).
- Every v0.3 section starts with the line "Status: v0.3, built and reviewed." (until the final integration of
  2026-10-20 it read "Status: v0.3 (proposed), not yet built.", and until the review round of 2026-10-22 to 2026-10-24
  "Status: v0.3, built, not yet reviewed."). Search for `v0.3, built` to find them all.
- "R" followed by a number, in the v0.3 documents, is a section of [the v0.3 design review](review/V03-DESIGN-REVIEW.md).
- Every phase C2 section starts with the line "Status: v0.3 C2, built and reviewed." (headings of ARCHITECTURE and INTERFACES say "v0.3 C2";
  before the C2 integration of 2026-10-20 they read "v0.3 C2 (proposed)"). Search for `v0.3 C2, built` to find them all; what is still not built
  carries **(proposed)** in place. "SZ" followed by a number is a section of
  [the C2 design](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), and SZ-1 to SZ-6 are its owner decisions (ARCHITECTURE 15.11).

## Keeping the documents current

A change to the code or the behaviour is not done until the documents that state it say the same. Search for the
flag, the method or the number before you finish.

| You change | Also update |
|---|---|
| A tool's flag or output | The tool's `--help`, then every document that shows it: [QUICKSTART](QUICKSTART.md), [RUNBOOK](RUNBOOK.md), [DEPLOY](DEPLOY.md), [MIGRATION](MIGRATION.md), the recipes and the README |
| An SDK method, option or error code | [SDK](SDK.md), [CRUD](CRUD.md) and, for the contract, [INTERFACES](INTERFACES.md) |
| A rule of the specification | [ARCHITECTURE](ARCHITECTURE.md) and [INTERFACES](INTERFACES.md) through an RFC, then the [CHANGELOG](../CHANGELOG.md); [DEVIATIONS](DEVIATIONS.md) if the build differs on purpose |
| A consent, privacy or storage default | [PRIVACY](PRIVACY.md), [SECURITY-MODEL](SECURITY-MODEL.md), the consent strings and "What it is not" in the README |
| A result for a browser, host or framework | [COMPATIBILITY](COMPATIBILITY.md) and the matching recipe |
| A test count or a release gate result | [INTEGRATION-STATUS](INTEGRATION-STATUS.md), [DEMO-RESULTS](DEMO-RESULTS.md) and the [CHANGELOG](../CHANGELOG.md) |
| A v0.3 part changes after the review round | the status line of each of its sections (search for `v0.3, built`), the marks in [ARCHITECTURE](ARCHITECTURE.md) section 15 and [INTERFACES](INTERFACES.md), then the [CHANGELOG](../CHANGELOG.md) and [THREAT-MODEL](THREAT-MODEL.md) rows it touches |
| A v0.3 C2 part changes after the review round | the "v0.3 C2, built" lines of [ARCHITECTURE](ARCHITECTURE.md) 8.1, 15.14 and 15.15 and of [INTERFACES](INTERFACES.md), the status lines of [PRIVACY](PRIVACY.md), [SECURITY-MODEL](SECURITY-MODEL.md), [THREAT-MODEL](THREAT-MODEL.md), [COMPATIBILITY](COMPATIBILITY.md), [DEMO-RESULTS](DEMO-RESULTS.md), [ROADMAP](ROADMAP.md) and [WHY](WHY.md), then the [CHANGELOG](../CHANGELOG.md) |
| The plan | [ROADMAP](ROADMAP.md) |

A pull request that adds a document adds its row to the tables above. `npm test` fails when a document names a `.md`
file that does not exist (the `docs-links` test), which catches most broken links, but only a person notices a missing
row.
