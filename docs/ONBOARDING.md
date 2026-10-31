# Onboarding: adopting felinar as a team

This is the intake for a team that wants to put a site on felinar: engineering, whoever owns the
content, whoever signs off on privacy, and whoever runs the hosting. It takes you from "should we?" to a
live site in three stages, with the questions to answer first, the people and keys you need, and the checks
that say each stage is done.

felinar 0.3.0 is a pre-release (0.2.1 was never published). Every automated suite
passes on a development machine, but the release gate on real phones and browsers has not run
([DEMO-RESULTS.md](DEMO-RESULTS.md)); the review round of the v0.3 design review ran from 2026-10-22 to 2026-10-24. Plan a pilot, not a
cutover, and run the gate rows that match your audience yourself.

| Read first | For |
|---|---|
| [WHY.md](WHY.md) | what you get, the condition attached to each benefit, the economics, "When not to use it" |
| [QUICKSTART.md](QUICKSTART.md) | the commands, end to end, for a new site (shell) or an existing one (drop-in) |
| [FAQ.md](FAQ.md) | short answers to the questions your team will ask |

## Stop here if

Any one of these means felinar is the wrong tool, or the scope must shrink first:

- The site handles **private or personal data**, accounts, payments, email sending or server-side
  secrets. Everything on the site ledger is public and copied to every visitor; those features stay on a
  server ([COMPATIBILITY.md](COMPATIBILITY.md)).
- Visitors need **anonymity**. Peers, trackers and STUN servers see each visitor's IP address once the
  visitor chooses to share.
- The site must live under a **sub-path** you can't move (`https://example.com/docs/`,
  `https://<user>.github.io/<repo>/`). The loader needs the root of an origin.
- The site is on a **hosted builder** that can't serve a file at `/mw-sw.js` (Squarespace, Wix, Webflow,
  Ghost(Pro)). Export or rebuild it as static files first ([MIGRATION.md](MIGRATION.md)).
- The goal is a **smaller hosting bill** for a small site. Peers carry close to none of a small site's first
  loads ([WHY.md](WHY.md), "Honest economics").
- The site **streams media**. A shell site downloads whole before it renders; keep video on plain HTTP.

## Decision tree

Answer from the top. Each answer narrows the setup; the table after it says where each outcome is
documented.

```text
1. Can you serve the root of a domain or subdomain over HTTPS?
   no  -> get one first (a custom domain on GitHub Pages, Cloudflare Pages, Netlify, or S3 + CloudFront)
   yes -> 2

2. Whose sites are these?
   one publisher (you)            -> 3
   many publishers, by magnet link -> SUBDOMAIN HUB: one origin per site, wildcard TLS, a Public Suffix
                                      List entry and an abuse process. A shared-origin hub never isolates
                                      sites: demos and a single publisher only.

3. Is it an existing site whose pages must stay indexable, shareable and exactly as they are?
   yes -> DROP-IN (the default for migrations)
   no  -> is it peer-to-peer first (an app, a demo, a site returning visitors must reach while the host is down)?
            yes -> SHELL
            no  -> DROP-IN (shell pages show only the loader to crawlers and link previews)

4. Does the site need shared data (comments, guestbook, reactions, polls)?
   no  -> keep the default ledger policy (owner and moderators only); nothing else to plan
   yes -> who writes?   anyone          -> --policy open, plus moderators and an abuse contact
                        a known group  -> --policy allow, plus an allow list
                        only you       -> --policy owner (the default)

5. How many visitors are online at the same moment?  (visits per day x mean seconds per visit / 86,400)
   under about 1     -> peers rarely help: the web seed carries the site; a pin node keeps the ledger reachable
   dozens or more    -> large files can come partly from peers; still budget the host for all of it

6. Who are the visitors?
   mostly phones     -> phones download only by default; keep shell sites under 24 MiB; no offline promise on iOS
   mostly desktops   -> after "Share and load", desktops share up to 1 MiB/s while the page is open
   an EEA, UK or Quebec audience, children, sensitive content, personal data
                     -> publish with --aud <tokens>: visitors get the blocking consent gate by default
                        (Quebec: also a French notice, a person in charge and the assessments of PRIVACY.md;
                        the first-run card has no French yet)
   chat, uploads or profiles
                     -> do not turn them on for a site that children use, or for a Quebec audience, until the
                        assessments are done (age checks, if any, are yours: felinar has none)
```

| Outcome | Documented in |
|---|---|
| Drop-in | [QUICKSTART.md](QUICKSTART.md) track B, [MIGRATION.md](MIGRATION.md) |
| Shell | [QUICKSTART.md](QUICKSTART.md) track A, [DEPLOY.md](DEPLOY.md) |
| Subdomain hub | [DEPLOY.md](DEPLOY.md) "Hubs", [ROADMAP.md](ROADMAP.md) (the hub operating layer is not built yet) |
| Shared data and its policy | [CRUD.md](CRUD.md) |
| Traffic and cost | [WHY.md](WHY.md) "Honest economics", and the calculator below |
| Phones | [COMPATIBILITY.md](COMPATIBILITY.md), [FAQ.md](FAQ.md) |
| Audience and consent | [PRIVACY.md](PRIVACY.md), [OPERATIONS.md](OPERATIONS.md) |

The traffic question has a calculator. Put in your own visits per day, mean seconds per visit (the mean,
not the median: the few long visits decide how many people overlap) and site size in MiB:

```sh
node docs/research/labs/w2c-07-lab/little-calc.mjs --visits 1000 --dwell 60 --size 5
```

```text
E[N] visitors online (Little)      : 0.69     peak-hour (x1.9): 1.32
P(alone on arrival) = e^-E[N]       : 50%   at peak hour: 27%
...
expected offload, 5 MiB site    : 0.00%  (web seed 8 MiB/s, peers 1 MiB/s each, first wire after 2s)
```

It is a model with stated assumptions, not a measurement ([WHY.md](WHY.md), "Honest economics").

## Prerequisites checklist

- [ ] **A domain with DNS you control.** The loader runs only on HTTPS at the root of an origin. DNS also
      holds the optional `_magnet` TXT record.
- [ ] **An HTTPS static host** that serves your files at the root: GitHub Pages (a user, organisation or
      custom-domain site), Cloudflare Pages, Netlify, Vercel, or S3 behind CloudFront. Ideally it can send
      `Cache-Control: no-cache` for `/mw-sw.js` and HTML, so updates and the kill switch reach visitors at once.
- [ ] **A web seed that answers `Range` with 206** (shell mode): the same host under `/ws/` works when it
      honours `Range` (GitHub Pages does; Cloudflare Pages answers 200 and can't be a web seed). A web seed on
      another origin also needs CORS. Drop-in needs none of this: its worker turns your host into the web seed.
- [ ] **Node 22 or newer** where you publish: a workstation or CI. Visitors install nothing.
- [ ] **An owner key, kept offline**, with a backup and a named holder (`node tools/keygen.mjs`). It signs
      every pointer and the ledger's policy; it never goes into a browser, a server or a repository.
- [ ] **Moderator keys** (one per moderator) if visitors can write.
- [ ] **Trackers**: the four public defaults (`--tr public`), plus your own for production
      (`node tools/tracker.mjs --allow dist-publish/summary.json`; deployment files in `deploy/tracker/`).
- [ ] **A place for the ledger snapshot** (`--cs`), on the same host, if visitors can write.
- [ ] **Optional: a pin node**, a browser kept open on a machine you control (`tools/pin.mjs`,
      `deploy/pin/`), when the ledger must stay reachable with no visitor online.
- [ ] **An abuse and legal contact** (`--ct mailto:...`) and **a privacy and terms page** (`--lg https://...`),
      both signed into the pointer.
- [ ] **A health check** that runs from CI or cron: `node tools/check-site.mjs https://<your site>/`
      (exit code 0 when everything passes).

## Roles

| Role | Holds | Does | Needs |
|---|---|---|---|
| Owner | the owner key, offline | publishes and re-signs the pointer (at least every 90 days by default), sets and changes the ledger policy with `tools/ledger-admin.mjs`, names moderators, signs a withdrawal if the site must go | Node 22, the key, a calendar reminder for pointer expiry, a second person who knows where the backup is |
| Moderator | their own key, imported in the loader's Settings | removes posts and bans authors from a browser, writes the owner's notice and flags (`_` keys) | a browser on the site in shell mode; for drop-in sites the owner moderates offline for now ([CRUD.md](CRUD.md)) |
| Writer (allow list) | their browser identity | posts under `--policy allow` | to send the owner their public key, which your site can show them |
| Visitor | a browser identity the loader makes | reads, posts where allowed, chooses whether to share | a browser at the floor: Safari and iOS 15.4, Chromium 110, Firefox 115 |
| Operator | access to the host, DNS, CI, the tracker and the pin node | deploys in the right order, purges the CDN, watches `check-site`, keeps the previous version's files for 7 days | no keys, unless the owner chooses to sign in CI |
| Developer | the site's code | uses `mw.db` for shared data, keeps every URL root-relative, adds nothing under `/_mw/` | [SDK.md](SDK.md), [CRUD.md](CRUD.md) |
| Privacy and legal lead | the privacy notice and the notice-and-action process | approves what visitors are told, answers notices sent to `--ct` | [PRIVACY.md](PRIVACY.md), [OPERATIONS.md](OPERATIONS.md); none of it is legal advice |

## Intake form

Answer these before you change anything. Copy the template into an issue or a document; the table after
it says what each answer decides.

```markdown
## felinar intake: <site name>

Site
- Public URL(s), and served from the root of the origin? (yes / no: which sub-path)
- Static host and CDN; can it set response headers? keep the previous deploy's files for 7 days?
- Generator or CMS and version (Hugo, Astro, Next.js static export, WordPress + Simply Static, ...)
- Size of the non-HTML files in MiB, number of files, largest file
- Does it register its own Service Worker? Does it send a Content-Security-Policy?
- Pages served with Cache-Control: no-store?

Change
- How often does it change (deploys per week)? Who deploys, from where (CI, a laptop)?
- Who will hold the owner key, and where is the backup?

Features
- Dynamic features used today: comments, forms, search, login, members, payments, newsletter, analytics,
  embeds, A/B tests, scheduled posts
- Which of them must keep working on day one?

Search and sharing
- Which pages must be indexed or previewed in chat apps? (all / some / none)

People and places
- Visits per day, mean time on site (seconds), peak events
- Share of visitors on phones; regions (EEA, UK, Quebec, elsewhere)
- Children as an audience (under 14 in Quebec, under 13 elsewhere in Canada and in the US)? Sensitive subjects? Personal
  data anywhere on the site?
- Is the site run as a business or another organized activity (then PIPEDA or Quebec's Act may apply)? Who is the
  person accountable for privacy, who answers access requests within 30 days, and is there a French notice?

Operations
- Who answers abuse and legal notices, and how fast?
- Who moderates posts, and how fast?
- Monitoring today, and who gets the alert
```

| Question | What the answer decides |
|---|---|
| Served from the root? | a sub-path is not supported: move to a domain or subdomain root first |
| Host, headers, previous files | whether the host can be the web seed, whether updates reach visitors at once, and whether lazily loaded files of the old version stay reachable for 7 days |
| Generator or CMS | the recipe to follow ([MIGRATION.md](MIGRATION.md), [recipes](recipes/)) |
| Size, file count, largest file | shell sites must fit 128 MiB (desktop), 48 MiB (phones on Wi-Fi), 24 MiB (other phones); `publish` warns at 5,000 files and stops above 20,000; per-file host limits such as 25 MiB on Cloudflare Pages |
| Own Service Worker | felinar does not register over it; you add two lines to yours ([RUNBOOK.md](RUNBOOK.md), section 10) |
| Content-Security-Policy | `publish --dropin` writes the additions to `csp.txt` |
| `no-store` pages | they run host-only: no peers on those pages |
| Change frequency | pointer re-signing (every 90 days at least), and the deploy order every time ([DEPLOY.md](DEPLOY.md)) |
| Owner key holder | who can publish, change the policy, or take the site down; losing the key means visitors see "publisher key changed" and the ledger starts over |
| Dynamic features | which work now on the ledger, which need a third party from the browser, and which stay on a server ([COMPATIBILITY.md](COMPATIBILITY.md)) |
| Indexed pages | drop-in for any page that must be found or previewed; shell pages show crawlers only the loader |
| Visits and time on site | how many visitors overlap, so how much peers can carry (the calculator above) |
| Phones | uploads are off on phones until the visitor turns them on; iOS stops peer connections in the background |
| Regions, children, sensitive subjects, personal data | `--aud` tokens (`eea`, `eu`, `uk`, `qc`, `quebec`, `personal`, `kids`, `sensitive`) make the blocking consent gate the default; the privacy notice and its review |
| Abuse and moderation | `--ct`, moderators, the open or allow policy, and the notice-and-action process ([OPERATIONS.md](OPERATIONS.md)) |
| Monitoring | where `check-site` runs and who it alerts |

## A 30-60-90 day plan

| Days | Goal | Steps | Done when |
|---|---|---|---|
| 1 to 30 | **Pilot.** Prove it on your site without risking it | Run `npm run demo` and `npm run demo -- --site <your build> --name <name>` locally. Fill in the intake form. Create the owner key and its backup. Publish drop-in to a staging copy of the site (a staging subdomain), deploy in order, run `check-site` from CI. Read the egress note `publish --dropin` prints and compare it with your host's price. Review the consent card and your privacy notice with whoever signs off privacy. Then go live on production with the script tag on one page, or a few (publish without `--inject-script` and add the tag by hand). | every pilot criterion below is met |
| 31 to 60 | **The whole site.** Drop-in on every page (or shell, if the decision tree said so) | Publish from CI with the tag on every page (`--inject-script`). Run your own tracker next to two public ones. Schedule pointer re-signing. Drill the kill switch on staging and write down the recovery time. Put the privacy notice and the abuse contact live. Keep the previous version's files for 7 days on every deploy. | every whole-site criterion is met |
| 61 to 90 | **Shared data, or shell mode.** The features that need felinar | Turn on the ledger features you chose (`--policy open` or `allow`, moderators, `--cs`). Moderators import their keys and practise a removal. Refresh the snapshot on a schedule; add a pin node if the ledger must stay reachable. Run the release gate rows that match your audience. | every ledger criterion is met and your gate rows pass |

A note on piloting a few pages: the script tag runs the engine (consent card, peers, the ledger) only on pages
that carry it, but once a visitor's browser has registered the Service Worker, it also serves verified
copies of files to the other pages `publish --dropin` stamped. Both are safe: every file is checked
against the SHA-1 piece hashes of the version's torrent, which the pointer's infohash names, before it is served.

## Success criteria

Each stage ends with checks anyone on the team can repeat.

**Pilot**

- `node tools/check-site.mjs https://staging.example.com/` exits 0 from CI every day for two weeks.
- With JavaScript off, every page looks and behaves exactly as before (drop-in).
- Before anyone chooses in the card, the browser's network panel shows no `wss:` connection and no
  DNS-over-HTTPS request, and `chrome://webrtc-internals` shows no peer connection.
- The second page view gets its scripts, styles and images from the Service Worker.
- Host egress per day stays within the budget you set from the egress note.
- The consent card, the privacy notice and the posting notice are approved by whoever signs off privacy.

**Whole site**

- A new version reaches returning visitors: shell visitors see "Update available: reload", drop-in visitors
  get it on their next page view, and `check-site` shows the new `seq`.
- The kill switch drill on staging is recorded with its time to recovery ([RUNBOOK.md](RUNBOOK.md),
  section 11, measures about 3 s after the next navigation in Chromium).
- The owner key backup has been restored once, on a machine that is not the usual one.
- A calendar reminder exists for pointer re-signing, at least 14 days before expiry.

**Shared data**

- A moderator removes a test post from a browser, and a second browser shows it gone.
- A first visitor with nobody else online sees the ledger from the snapshot.
- `node tools/ledger-admin.mjs show --file <export>` shows `bytes` well under `maxChainBytes`.
- A restore from a snapshot file has been rehearsed ([CRUD.md](CRUD.md), "Export and backup").

## The release gate

Nothing here is called production-ready until the release gate passes on real devices. The project's own
gate ([DEMO-RESULTS.md](DEMO-RESULTS.md)) lists every row (a real domain with a `_magnet` record, iPhone on
iOS 18 and an older iOS, Android Chrome on mobile data, Samsung Internet, Firefox normal and private, Brave
with aggressive Shields, Edge with sleeping tabs, cold start, the update flow, the key-change prompt, the
kill switch, the drop-in fixture, 7-day persistence on iOS), and none has run yet.

For your deployment: copy the table, keep the rows your audience uses, run them on your staging site, and
record the date, the browser and OS versions and the numbers. Send your results upstream as well (a pull
request on DEMO-RESULTS, see [CONTRIBUTING.md](../CONTRIBUTING.md)): they are the most useful contribution
the project can get right now.

## What you tell your visitors

felinar asks before it connects anyone to anything, but the site is yours, so the honesty is yours too.

**The consent card is the loader's, not yours.** Every visitor sees it before any tracker, peer or DNS
lookup; you can't remove it or answer it for them. It reads:

> **This site is delivered peer-to-peer.**
>
> If you choose to share, your browser connects to other visitors and to connection servers run by third
> parties. They can see your IP address and that you are viewing this site, and anyone who knows this
> site's address can join and see who is online. While this page is open your browser may upload this
> site's files and posts to other visitors, which uses bandwidth and battery. This site also keeps its
> files and settings on this device so it loads faster next time (on iPhone and iPad, until Safari clears
> them).
>
> You can load the site from its host only, with no peer connections, and change your mind any time in
> Settings.
>
> [Share and load] [Load from host only] [Settings]

On phones it adds: "On this phone sharing stays off until you turn on "Share on this network" in
Settings." On a shell site with a public hostname it also names the DNS-over-HTTPS service that "Share and load"
lets the page ask for updates ([PRIVACY.md](PRIVACY.md) quotes the sentence). With `--consent gate` or a gate audience in `--aud`, visitors get the gate instead: "Load this
site peer-to-peer? Other visitors and the connection servers will see your IP address and that you're
viewing this site." with [Load] [Load from host only] [Cancel]. In drop-in mode you can explain sharing in
your own words first (`data-mw-consent="site"` and `mw.consent.request()`, [SDK.md](SDK.md)); the visitor
still decides in the loader's card.

**Your privacy notice** names who receives what: your host, the web seed, the trackers and STUN servers,
the DNS-over-HTTPS resolvers (shell pages ask them for updates once a visitor shares), and other visitors.
[PRIVACY.md](PRIVACY.md) has the recipients register and the notice template; [OPERATIONS.md](OPERATIONS.md),
"Privacy operations" and "Abuse and legal operations", has what to do when visitors ask, and the
notice-and-action process. Link the notice from your footer and sign its URL into the pointer with `--lg`.

**Every form that writes to the ledger** says, before the visitor posts:

> Everything written with mw.db is public and copied to every visitor. Deleting an entry hides it for
> visitors who receive the deletion. Copies on devices that never sync again stay where they are.

(or the same in your own words, without the SDK's name).

**Don't promise what it doesn't do.** Don't describe the site as "serverless", "unstoppable",
"censorship-resistant" or "fully decentralized", don't call the ledger a "blockchain", and don't promise
offline use on iPhone ("saved on this device until Safari clears it" is accurate). If you run a hub, never
say that sites on a shared origin are kept apart. The wording rules are in
[review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md), section 4.

## Support

| You want to | Go to |
|---|---|
| ask how to migrate a site, model data on the ledger, or run a hub | GitHub Discussions on the repository, "Questions and ideas" |
| report a bug | an issue with the bug report form |
| report a site, framework or host that doesn't migrate cleanly | an issue with the site compatibility report form: include `check-site` and `publish --dropin` output |
| propose a feature or a change to the specification | an issue with the feature request form; specification changes need an RFC ([GOVERNANCE.md](../GOVERNANCE.md)) |
| report a vulnerability | privately, never in a public issue ([SECURITY.md](../SECURITY.md)) |

felinar is a community project with no paid support. Maintainers answer in issues and discussions as
they can; security reports get the response times in [SECURITY.md](../SECURITY.md).
