# Privacy: who receives what

What a visitor's browser sends to whom when it opens a felinar site, what it keeps, what the visitor is told
and when, and a privacy-notice template for site owners. It describes the code of 0.3.0
(the first public one; 0.2.1 was never published). The sections up to "Children" cover loading a site and its site
ledger; the sections headed "v0.3" cover what 0.3.0 adds (identity and sign-in, chat, files, private media, seeding,
calls and doors), which runs in 0.3.0. No lawyer has reviewed these texts; the review round of the v0.3 design review
(its Part 5.3) ran from 2026-10-22 to 2026-10-24. Day-2 privacy work (requests, breaches, the retention of records you hold) is in
[OPERATIONS.md](OPERATIONS.md#privacy-operations). The date of the last check, who answers for this text and how it
changes are in "About this text" below.

> [!NOTE]
> This is not legal advice, and no lawyer has reviewed it. For 0.3.0 the owner decided not to have a lawyer review the
> privacy texts. In place of that review, AI research agents compared these texts with the code and with the published
> laws, cases and regulator guidance they rely on (four research passes on 2026-10-22, a synthesis on 2026-10-24), and
> the sources are named where they are used. That review is research: it can be wrong, nobody qualified in any
> jurisdiction has checked it, and it gives you no protection in a dispute. Whether consent or an exemption is the right
> basis for each step below, and which law applies to your site, is a question for a lawyer where your visitors are.

## About this text

- **Version and date.** This page describes the code of 0.3.0 as checked on 2026-10-25 (after the DNS-over-HTTPS skip list of the independence round). Each release re-reads it against
  the code (release checklist, section 9); changes are in [CHANGELOG.md](../CHANGELOG.md). When the trackers or STUN
  servers a visitor agreed to change, the loader asks for the choice again; a release that changes a card's text must
  raise `consent.version` in `src/loader/config.js` so that visitors are asked again too.
- **Who answers for it.** The project publishes software and runs no service for your visitors. By design, the project
  hosts no identity page (owner decision N-2, none in 0.3.0): run your own or use one you trust. Two things would change
  that, and 0.3.0 has neither: a default identity page, if the project ever hosts one, and a hosted homepage demo, which
  the release checklist makes optional. For those two the owner named in [GOVERNANCE.md](../GOVERNANCE.md) would answer,
  and this page names the operator and a contact before either is published. For every other site, the site owner answers: use
  the contact in that site's privacy notice.
- **No lawyer, no legal advice.** See the note above. The review that replaced a lawyer's review used public sources
  only; no regulator, court or lawyer was asked.
- **Languages.** The first-run card, the gate, the Settings panel and the status messages are in English only in 0.3.0;
  the v0.3 cards and error messages, and the seeding, call and door texts, also exist in French.
- **Contact.** The project has no privacy mailbox. For a security problem, follow [SECURITY.md](../SECURITY.md). For a
  privacy question about the software, open an issue on the project's GitHub page and put no personal data in it.

## In short

- The loader has no analytics, no telemetry, no third-party scripts and no cookies.
- Before the visitor chooses anything, the browser talks only to hosts the site owner chose: the static host,
  and the hosts of the web seed, the `.torrent` and the ledger snapshot. It stores the site's files and a few
  records on the device.
- After "Share and load", the browser also connects to WebSocket trackers, STUN servers and other visitors,
  and they see the visitor's IP address and that they are viewing this site. A shell page then also asks a
  DNS-over-HTTPS resolver for the site's `_magnet` record, to learn about updates, whether or not the owner
  published one; the resolver sees the visitor's IP address and the site's name. Drop-in pages never do, and no page asks
  for a name that cannot carry the record: IP addresses, nip.io and sslip.io names, and hosting-platform names where no user can
  publish a TXT record, such as `*.github.io`, `*.netlify.app`, `*.pages.dev` or `*.ts.net` (the list: [DEPLOY.md](DEPLOY.md#the-dns-txt-record)).
- "Load from host only" keeps the visitor away from peers, trackers and STUN servers, and on a site with a page
  tag from the DNS-over-HTTPS resolver too.
- Everything written with mw.db is public and copied to every visitor. Deleting an entry hides it for visitors
  who receive the deletion. Copies on devices that never sync again stay where they are.

## Recipients register

| Recipient | What it receives | When | Default |
|---|---|---|---|
| Your static host | the visitor's IP address, the pages and files requested, the usual request headers | every visit, before any choice (it serves the loader) | your host |
| Web seed, `.torrent` and snapshot hosts (`ws=`, `xs=`, `cs=`) | IP address, the files requested | from page load, before any choice: the download from the web seed starts at once over HTTP, and the snapshot is fetched after the site renders | set by the site owner; often the same host |
| WebSocket trackers | IP address, the site's infohash and the ledger's rendezvous infohash, WebRTC offers | after "Share and load" (or a stored choice) | for a signed pointer, exactly its `tr=` list; for an unsigned pointer or a bare magnet link, its `tr=` plus `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.novage.com.ua` and `open.ftorrent.com` |
| STUN servers | IP address (to learn the public address WebRTC needs) | after "Share and load" | `stun.cloudflare.com:3478`, `global.stun.twilio.com:3478` |
| Other visitors (peers) | IP address, that the visitor is viewing this site, the site's files, ledger entries, the visitor's posting key and posts | after "Share and load", while the page is open | anyone in the swarm, including people who join only to record addresses |
| DNS-over-HTTPS resolver | IP address and the name `_magnet.<site>` | shell pages on a public hostname, after "Share and load" (or the gate's "Load"): right after the choice (on a later visit, after the site renders, unless a cached answer is still fresh), then every 5 minutes or the record's TTL while the page is open, and on focus at most once a minute, whether or not a TXT record exists. "Load from host only" makes no lookup on a site with a page tag. A site found only through DNS asks after its blocking card, with either of its two load buttons (Cancel loads nothing), and keeps checking on the same schedule. Never in drop-in mode, never for `localhost`, IP addresses or names such as `.local` and `.test`, and never for nip.io and sslip.io names or hosting-platform names that cannot carry a TXT record (`*.github.io`, `*.gitlab.io`, `*.codeberg.page`, `*.pages.dev`, `*.workers.dev`, `*.netlify.app`, `*.vercel.app`, `*.surge.sh`, `*.trycloudflare.com`, `*.ts.net`) | Cloudflare first, then dns.sb, then Google (asked not to forward the visitor's subnet, `edns_client_subnet=0.0.0.0/0`); `<meta name="mw-doh">` replaces them with a resolver you choose |
| Your tracker, if you run one | IP address and the infohash | as for trackers | you, and whatever your proxy logs |
| Your pin node, if you run one | IP address, as any peer | as for peers | you |
| The site owner | posts the visitor writes, like everyone else | when the visitor writes | |

Not used for loading a site or for its ledger: relay (TURN) servers, Nostr relays or blob hosts, and analytics or
error reporting of any kind. If a later release adds any of them, this register and the consent card change first.
The v0.3 features of 0.3.0 add recipients (an identity page, a passkey provider, the site's own tracker and STUN
servers for chat and files, a hub's pin service, and a relay for calls that only the owner can set up); they are in
[the v0.3 register](#the-recipients-register-v03) and [the C2 register](#the-recipients-register-c2), and no lawyer
has reviewed them, like the rest of the v0.3 text.

The consent record stores the recipients a visitor agreed to: the host names of the trackers in the pointer and
of the STUN servers. When they change, the card asks again. The DNS-over-HTTPS resolvers are part of the loader
and not in that record, so a new `<meta name="mw-doh">` doesn't ask again. The OPC's consent guidelines ask for
fresh consent when personal information goes to a new third party, so choose `mw-doh` before launch and do not change it
afterwards: visitors who already chose "Share and load" would otherwise send their IP address and your site's name to a
resolver they were never told about. The first-run card and the gate name
them on every page that will ask them (a shell page on a public hostname): a site with a page tag gets the update
sentence below, and a site found only through DNS gets the two DNS sentences. Name them in your privacy notice
too. 0.3.0 has no switch that turns the update lookup off.

### What the default recipients say about their logs

Read on 2026-10-22 from the operators' own pages. They can change, and the project cannot enforce any of it.

| Recipient | What it says |
|---|---|
| Cloudflare public resolver (`cloudflare-dns.com`) | keeps no source IP address in non-volatile storage except sampled packets (at most 0.05% of traffic); deletes resolver logs within 25 hours (its 1.1.1.1 privacy page) |
| DNS.SB (`doh.dns.sb`) | logs no queries or IP addresses; operated by xTom GmbH in Germany (dns.sb/privacy) |
| Google Public DNS (`dns.google`) | deletes temporary logs, with IP addresses and queries, within 24 to 48 hours (longer for security and abuse); permanent logs replace the IP address with a city or region (its Public DNS privacy page) |
| Cloudflare and Twilio STUN, the four WebSocket trackers | no statement on logging or retention was found |

## What stays on the device

| What | Where | Created | Removed |
|---|---|---|---|
| The loader: a Service Worker and its cache of loader files | Service Worker registration, Cache Storage (`mw-shell-<build>`) | the first visit | the kill switch, clearing site data |
| The site's files (current and previous version) | IndexedDB (`mw-sites`) | when the download completes, whatever the choice | "Forget this site" in Settings, a new version (the old one is pruned), a withdrawal, the storage budget (512 MiB desktop, 128 MiB phone, least recently visited first), Safari after 7 days without a visit, clearing site data |
| Pages a drop-in visitor visited, for offline use | Cache Storage, with a cap that drops the least recently used | each page view (never a page the host marks `no-store`) | a new version, the cap, clearing site data |
| Builds without the identity service only (0.2.1 mode): the posting identity, a key pair for this site's ledger. 0.3.0 makes no key for a guest; the working keys arrive from the identity page at sign-in ([below](#what-stays-on-the-device-v03)) | IndexedDB (`mw-sites`) | in 0.2.1 mode, when the site's ledger opens on a visit, before any post | clearing site data; Safari after 7 days without a visit. In 0.2.1 mode Settings can export it (passphrase-protected) |
| The copy of the site ledger | IndexedDB (`mw-chain-<ledger id>`) | when the ledger opens | clearing site data |
| The remembered site key and pointer | IndexedDB (`mw-sites`) | the first signed pointer | clearing site data |
| The sharing choice `{ v, choice, dns, day, scope, rcpt }` | IndexedDB (`mw-sites`) | the visitor's choice | clearing site data; asked again when the version or the recipients change |
| Small flags: the status bar collapsed or not, a one-time reload guard | `localStorage`, `sessionStorage` | as needed | clearing site data, closing the tab |

"Forget this site" removes the site's files, not the identity, the ledger copy, the remembered key or the choice:
clearing the site's data in the browser removes everything. The loader asks the browser to keep its storage
(`navigator.storage.persist()`) only from the click on "Share and load" (or the gate's "Load").

## What visitors are told

The texts below are the loader's own (`src/loader/strings.js`), shown in the shell and in the drop-in panel,
copied verbatim. Their wording follows the design review's final strings (DESIGN-REVIEW 4.3 and 4.5).

**The first-run card**, shown before any tracker, peer, STUN or DNS-over-HTTPS connection:

> **This site is delivered peer-to-peer.**
>
> If you choose to share, your browser connects to other visitors and to connection servers run by third
> parties. They can see your IP address and that you are viewing this site, and anyone who knows this site's
> address can join and see who is online. Other visitors and these servers can be anywhere in the world, and this
> software cannot make them protect your data. While this page is open your browser may upload this site's files
> and posts to other visitors, which uses bandwidth and battery. Whichever you choose, this site keeps its files and
> settings on this device so it loads faster next time, until you clear this site's data ('Forget this site' in
> Settings removes the files); on iPhone and iPad, Safari clears them after 7 days without a visit.
>
> You can load the site from its host only, with no peer connections, and change your mind any time in Settings.
>
> **[Share and load]  [Load from host only]**  [Settings]

On phones the card adds: "On this phone sharing stays off until you turn on "Share on this network" in
Settings." On a shell page with a public hostname it adds: "If you choose to share, your browser also asks a
DNS-over-HTTPS service (Cloudflare, dns.sb or Google) whether this site has a newer version, at most once a minute
while this page is open. That service sees your IP address and the name of this site." When the site can only be
found through DNS, the card blocks the page and says instead: "To find this site, your browser first asks a
DNS-over-HTTPS service (Cloudflare, dns.sb or Google), which sees your IP address and the name of this site." and
"While this page is open your browser asks again whether there is a newer version, at most once a minute,
whichever you choose." With `<meta name="mw-doh">` on the page, these sentences name that resolver's host
instead. A site with no host copy (no web seed) offers [Not now] in place of "Load from host only".

**The gate**, blocking, shown on hubs, for `consent=gate`, and for an `aud=` declaring personal data, children,
sensitive content or an EEA, UK or Quebec audience:

> Load this site peer-to-peer? Other visitors and the connection servers will see your IP address and that you're
> viewing this site. They can be anywhere in the world, and this software cannot make them protect your data. By
> choosing Load, you agree to your IP address being sent to them. **[Load]** [Load from host only] [Cancel]

On a page with a public hostname the gate adds: "Loading it peer-to-peer also lets your browser ask a
DNS-over-HTTPS service (Cloudflare, dns.sb or Google) whether this site has a newer version, at most once a minute
while this page is open. That service sees your IP address and the name of this site."

"Load from host only" appears only when the pointer has a web seed. A shared-origin hub adds "Sites on this hub
share one browser origin and can access each other's data." and labels its button "Load anyway: this site can
read and change everything other sites stored on this hub".

**Settings:**

- "Share with other visitors: On / Off. Off stops sharing this site's files. Posts are still passed between
  connected visitors, and your IP stays visible. Choose Host only to stop all peer connections."
- "Host only: no peer connections. Slower, and shared data won't sync."
- "Share on this network", with "Phones on mobile data or an unknown network only download until you allow
  sharing here."
- "Change your sharing choice" opens the card again.

## Retention

| Data | Kept by | How long |
|---|---|---|
| Files, ledger copy, identity, choices | the visitor's browser | until cleared, evicted, or deleted by Safari after 7 days without a visit (table above) |
| Posts in the ledger | every visitor who holds a copy | until a deletion reaches that copy; devices that never sync again keep them. A deleted post leaves its outline (the author's key, the minute it was written and the list's name) until the owner writes a checkpoint, and copies that never apply a checkpoint keep it |
| Host and CDN logs | your host | your choice; say it in your notice (7 to 30 days, or none, is a common choice: [OPERATIONS.md](OPERATIONS.md#retention)) |
| Tracker, STUN and resolver logs | their operators | their policies; link them in your notice; nobody can delete them for you |
| Your own tracker's logs | you | none is best; never the infohash together with an IP address |

## Who is responsible for what

| Deployment | Who decides how the visitor's data is processed |
|---|---|
| A site on its own domain (shell or drop-in) | the site owner, for everything the loader on that domain makes the browser do |
| A hub | the hub operator for the hub's own processing, and each site's owner for its site |
| This repository | the maintainers ship software and run no service for your visitors, so nothing here receives visitors' data, with two possible exceptions that the owner would answer for, neither run for 0.3.0: a default identity page, if the project ever hosts one (by design it hosts none), and a hosted homepage demo on GitHub Pages ("About this text" names them) |

The research reads the roles below from the laws' texts, the cases and the regulators' guidance (first in
[PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 4.2 and 5.3; checked again by AI research agents on 2026-10-22). No
lawyer has reviewed it, and no authority has applied these rules to a browser loader that talks to peers. "High",
"medium" and "low" say how sure the reading is.

**EU and UK.** The GDPR and the UK GDPR apply to you if you are in the EU or the UK, or offer the site to people there or
monitor them (Art. 3 of each); being reachable from there is not enough. An IP address is personal data where there are
lawful means to link it to a person (Breyer, C-582/14).

- **Site owner:** a controller of the visitor's IP address as its own host sees it, and of the transmission of that
  address and the site's name to the trackers, STUN servers, DNS-over-HTTPS service and peers its page causes, and only
  of those operations (Fashion ID, C-40/17, operative part 2; EDPB Guidelines 07/2020, paragraphs 40, 67). High for
  host logs, medium for the transmission.
- **Trackers, STUN servers and resolvers:** most likely controllers of their own logs, not joint controllers with the
  owner (EDPB 07/2020, paragraphs 68, 70 to 72); no Art. 26 arrangement is possible with a public service. Medium.
- **Visitors who share:** not clearly inside the household exemption, which covers only a purely personal activity
  (GDPR Art. 2(2)(c); Jehovah's Witnesses, C-25/17, paragraph 42). A browser that passes on a public ledger decides
  neither purposes nor essential means, so it is at most a recipient (EDPB Guidelines 02/2025, paragraphs 42 to 44). Low
  to medium.
- **An owner who runs an open ledger:** expect to be treated as the controller of what visitors post, because the owner
  sets the policy and moderates (EDPB 02/2025, paragraphs 38 to 40; Russmedia, C-492/23, paragraphs 66 to 75, on a
  commercial marketplace). Medium.
- **This repository:** none; its maintainers run no service that receives visitors' data. The default trackers, STUN
  servers and resolvers (`src/loader/config.js`, `src/loader/doh.js`) are the project's choice of recipients, which an
  owner adopts by shipping them. A maintainer who runs a default identity origin or a hub is the controller of that
  host's logs. Medium.
- **Legitimate interest** is weak for letting peers see a visitor's address, because a web seed can deliver the site
  without them. The loader relies on consent through the card.

Storing information on the device is a separate rule: ePrivacy Directive Art. 5(3) and, in the UK, PECR regulation 6
and Schedule A1. The EDPB names local storage, WebSQL and caches, treats an instruction to send an IP address as
"gaining access" and says networks of peers are covered; it does not name Service Workers or IndexedDB, and does not
analyse the exemptions (EDPB Guidelines 2/2023, version 2.0). Only storage strictly necessary for a service the visitor
explicitly asked for is exempt. Since 2026-02-05 the UK also exempts storage whose sole purpose is to enhance website
functionality, if the visitor is told what it is for and has a simple, free way to object (PECR Schedule A1, paragraph
6); the Directive has no such exception. For the loader:

- identity-page keys, the sharing choice, the visitor's own selections and sign-in working keys: strictly necessary.
  High.
- the loader, its cache and the site's files while the site is shown: strictly necessary in shell mode, weaker in
  drop-in mode. Low to medium.
- keeping the site's files, ledger copy and cached pages for the next visit: not strictly necessary from the visitor's
  side. The EU reading is that it needs consent; the UK needs the information and an objection that really stops it.
  The loader keeps them whichever button is pressed and has no setting that stops it, so the EU question is open and
  the UK exception is not met (an owner decision; the card now says that the site is kept). Medium.
- a posting key made for a guest (only in a build without the identity service): not necessary. Medium.

**Canada.** Canada uses other words. PIPEDA has no controller or processor: an organization is responsible for the
personal information under its control, including what it has passed to a third party for processing (Schedule 1,
clauses 4.1 and 4.1.3), and the Act applies only to personal information that an organization collects, uses or
discloses in the course of commercial activities (s. 4(1)(a)); an individual's own personal or domestic use is outside
it (s. 4(2)(b)). Quebec's private-sector Act binds a person who carries on an enterprise (s. 1), which the Civil Code
defines as an organized economic activity, whether or not it is commercial (art. 1525). On that reading the
maintainers publish software, run no service for your visitors and hold no visitor data, so they have no duty as an
organization, except for an identity page the project might host. A site owner, a hub operator and the operator of a
pin node are each an organization or an enterprise for the data they handle, if their activity is commercial or, in
Quebec, an organized economic activity. A free service can still be commercial when the business model as a whole is,
so an operator with paid hosting, sponsors or advertising should assume the law applies. A visitor who shares for
personal reasons is neither. The OPC treats an IP address as personal information when it can be associated with an
identifiable individual, and Quebec's CAI lists the IP address, the time of connection and the pages visited among the
personal information a website collects. Nobody has tested this reading of peer-to-peer delivery before the OPC, the
CAI or a court.

## Impact assessments

- **DPIA (GDPR):** the EDPB-endorsed criteria (WP248) suggest one when two criteria meet. Likely candidates here:
  an innovative technology (peer-to-peer delivery and a replicated signed log), large scale, vulnerable data
  subjects (children), and arguably systematic monitoring, since anyone in a swarm can see who views the site.
  Hubs and owners with a sizeable audience should run one.
- **Canada and Quebec:** Quebec's private-sector Act (CQLR c. P-39.1) binds a person who carries on an enterprise. It
  asks for a privacy impact assessment for any project to acquire, develop or overhaul an information system or
  electronic service delivery system that involves personal information, in proportion to its sensitivity and purposes
  (s. 3.3), and for a further one before personal information is communicated outside Quebec, which may go ahead only if
  the assessment finds adequate protection and a written agreement follows (s. 17). Anyone who collects personal
  information with technology that can identify or locate a person must first say so and say how to turn those
  functions on (s. 8.1); the CAI reads that to mean such functions cannot be on by default. A technological product or
  service offered to the public must give its privacy settings the highest level of confidentiality by default, with
  no action by the person (s. 9.1). A website that collects personal information must publish a confidentiality policy
  in clear and simple language (s. 8.2), with the title and contact information of the person in charge of protecting
  personal information (s. 3.1). Before the visitor chooses, felinar sends nothing to peers, trackers, STUN servers or
  DNS-over-HTTPS services: the browser contacts only the hosts the site owner chose (the static host, the web seed, and the hosts of the `.torrent` and the
  snapshot), which see the visitor's IP address as any web host does. Publishing with `--aud qc` makes the blocking
  gate the default for your site. Nothing in 0.3.0 checks that an assessment was done. Outside Quebec, PIPEDA has no
  impact-assessment duty; the OPC's Children's Privacy Code (launched 2026-10-20) encourages one for a service that
  children are likely to use.
- **No personal data in the ledger**, even encrypted: encrypted personal data is still personal data (EDPB
  Guidelines 02/2025, [MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), L3). The salted hash in a deleted entry's
  stub keeps short values from being guessed, but keys and list names are never deleted. The v0.3 design adds one
  opt-in exception, a synced sealed record, and says why in [Impact assessments, v0.3](#impact-assessments-v03).

### A Quebec assessment, pre-filled

Use this for the assessment of s. 3.3 of Quebec's private-sector Act and, with its last rows, for the one s. 17 asks for
before personal information goes outside Quebec. It is a starting point written from the code of 0.3.0, not a lawyer's
work, and no lawyer has reviewed it. Fill the right-hand column for your deployment, date it and keep it.

| Question | What felinar does (0.3.0) | You fill in |
|---|---|---|
| What personal information, and how sensitive? | The IP address and the fact that the visitor views this site: to the hosts you chose before any choice, and to peers, trackers and STUN servers after "Share and load". Posts and sealed items if you turn those features on. The subject of your site can make the IP address sensitive (health, belief, sexuality) | the sensitivity of your site's subject |
| Purposes | to deliver the site, find peers and keep the site ledger in sync; nothing else is built in (no analytics, no profiling) | any purpose you add |
| Who receives it | the recipients register, by feature | the hosts, trackers, STUN and DNS-over-HTTPS servers you named; your pin node and hub, if any |
| Where it is kept, and for how long | the visitor's device; host and tracker logs for as long as each operator keeps them; peers for as long as they like | your retention for host and tracker logs |
| How the visitor chooses | nothing goes to peers, trackers or STUN before "Share and load" or "Load", on a card with an equal "Load from host only"; `--aud qc` makes the gate blocking | whether your site needs the gate; the first-run card has no French yet |
| Defaults (s. 9.1) | peer sharing off until chosen; phones share kept items only after "Share on this network"; chat, files, presence and message requests off; one exception, the Echo lane for private media on desktops after "Share and load" | any setting you changed |
| Identify, locate, profile (s. 8.1) | peers see an IP address; presence is off until turned on; no profiling | the means you offer to switch on any function you add |
| Communication outside Quebec (s. 17) | peers and some servers can be anywhere; the software cannot restrict where | where your trackers, STUN, DNS-over-HTTPS and hosts are; the written agreement with each operator you name; your conclusion on adequate protection, or why peer sharing waits for the visitor's choice |
| Access, correction, the person in charge (ss. 3.1, 27, 28, 32) | the visitor's data is on their device; a post can be tombstoned | the person's title and contact; your 30-day process |
| Incidents (ss. 3.5 to 3.8) | the site ledger is public by design; a leaked host log is yours | your incident register, kept 5 years |

## Children

This software cannot check anyone's age, and a click on a card is not a parent's consent. A site that children use
should be a plain static site without felinar's peer sharing: the web seed can deliver everything, and peers,
trackers and STUN servers all see a visitor's IP address. 0.3.0 has no owner setting that forces host-only; `--aud
kids` makes the blocking gate the default, and a visitor can still choose "Load". See
[OPERATIONS.md](OPERATIONS.md#childrens-content). This is research, not legal advice, and no lawyer has reviewed it.

- **United States.** COPPA (15 U.S.C. 6501 to 6506 and the FTC's COPPA Rule, 16 CFR Part 312) counts an IP address as
  personal information when it is collected from a child under 13. It binds the operator of a commercial site or
  service directed to children, and any operator that has actual knowledge that it is collecting personal information
  from a child; such an operator needs verifiable parental consent first. The FTC reads the operator of a
  child-directed site as liable when a third party collects through it (90 FR 16918). A general-audience site is
  covered once its operator has actual knowledge: a parent's message, a post that states an age, or an age check that
  flags a child. Then it must get verifiable parental consent or delete what the child gave; a tombstone does not reach
  copies on devices that never sync again, so it may not meet COPPA's "delete" (16 CFR 312.2). A ban on children in
  your terms does not settle the question: the FTC looks at the site.
- **Canada.** In Quebec, personal information about a minor under 14 may be collected only with the consent of the
  person who has parental authority, and that person gives the minor's consent (ss. 4.1 and 14 of the private-sector
  Act); a card cannot show who is clicking. Elsewhere in Canada the OPC's position is that, in all but exceptional
  circumstances, a child under 13 cannot consent, and its Children's Privacy Code (launched 2026-10-20, open for comment
  until 2027-01-20) expects a service directed at children, or likely to be used by them, to give the most private
  defaults, to infer no consent from inaction, to offer privacy information in both official languages and, where it
  cannot tell who is a child, to give every user the protections.
- **EU and UK.** A child's own consent to an online service is valid from 16 in the EU, or from a lower age (not below
  13) that a member state sets, and from 13 in the UK; below that age the holder of parental responsibility must give
  or authorise it, and the controller must make reasonable efforts to check (GDPR and UK GDPR Art. 8). The ICO and
  Ofcom say that self-declaration alone is not enough (joint statement, 2026-03-25). In the UK a service likely to be
  accessed by children must take the children's higher protection matters into account (UK GDPR Art. 25(1A)), its
  settings must be high privacy by default (ICO Children's code, standard 7), and under the Online Safety Act a
  provider can conclude that children cannot access its service only if age verification or estimation is used with
  that result (s. 35(2)); one that does not assess is treated as likely to be accessed by children (s. 37(4), (5)).

## United States

What the research found about US law, from statutes, rules and regulators' pages read in October 2026. It is not
complete (many states have privacy laws of their own, and this page does not go through them), no lawyer has reviewed
it, and it is not legal advice.

- **California privacy law (CCPA).** It reaches a "business": a for-profit entity that does business in California,
  collects consumers' personal information, and either has annual gross revenue above $26,625,000 (the figure since
  2025, adjusted every two years), or buys, sells or shares the personal information of 100,000 or more consumers or
  households a year, or earns 50 percent or more of its revenue from selling or sharing it (Civil Code 1798.140(d)).
  The project is not a business: it earns nothing and receives no visitor data. A site owner or hub operator is one
  only if it is for-profit and passes a test; if you do, add a California section to your notice.
- **Sale and sharing.** "Sale" is disclosure for money or other valuable consideration, and "sharing" is disclosure for
  cross-context behavioral advertising. Neither happens when the consumer directs the business to disclose personal
  information or to interact with a third party (1798.140(ad), (ah)). The loader sends nothing to trackers, STUN servers
  or peers before the visitor chooses "Share and load". Nobody has said whether that choice fits the exception.
- **What these documents say about encryption.** The FTC treats a claim as deceptive if it is likely to mislead a
  reasonable consumer and is material, judged on the net impression. It acted over an "end-to-end" claim where the
  provider held the keys (Zoom, 2020). That is why the cards and these documents say, in the same sentence, who can
  still read a message (the site's own code, while you are signed in) and what stays visible (IP addresses, timing,
  sizes). If you describe the software to your visitors, give the same conditions.

## v0.3: identity, chat, files and private media

> **Status: v0.3, built and reviewed.** Everything in the sections that follow describes v0.3 as designed and built
> ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), cited "R"; a number after R is its section): the code that
> 0.3.0 runs. "Reviewed" means that the review round of R 5.3 ran (2026-10-22 to 2026-10-24,
> after the code review of the v0.3 and C2 code); it does not mean a lawyer reviewed these texts, and none has. R 2.14.3 and MF-59 asked for a
> lawyer's review before 0.3.0 is published; the owner decided against it, and AI research agents checked the texts
> against the code and against published law and regulator guidance in its place (research on 2026-10-22, synthesis on
> 2026-10-24). That review is research, not legal advice, and it can be wrong. The sentences quoted here are the ones the
> loader's cards use (R 2.14.1); the cards have had that review and no more.

The sections above describe the parts that 0.3.0 kept from 0.2.1 (which was never published), and they stay true. The
sections below add the v0.3 features; where a v0.3 row and a row above disagree, the v0.3 row describes what 0.3.0 runs.

### The summary

After the review fixed the design, the honest one-paragraph summary for visitors is:

> Sites cannot recognise you by your key unless you choose to be recognised. Anyone you connect to, the connection
> servers and any relay can still see your IP address, when you are active and which felinar sites you open, and
> can link activity on several sites by that address. Your messages, private record and private media are encrypted,
> but the people you share with and the code of the site you are signed in to can read them, and anyone who learns your
> 12 words can act as you on every site. They cannot open what was kept under your older keys unless they also get
> your backup file or an unlocked device.

The last sentence tightens the design review's summary (R 1.1), which said only that anyone who learns the 12 words
can read them. R 2.2.2 and 2.16.2 are more precise: the keys for old messages, records and own media are random and
live in the vault, so a restore from the words alone recovers the public identities and not those. The change is
recorded in `docs/deviations/docs.md`.

The statement on anonymity, in plain words (R 2.18):

> felinar identities are **pseudonymous by design**: a key, not a person, and by default a different key on every
> site. They are **not anonymous**. Whenever your browser connects to other visitors, they see your IP address, and so
> do the connection servers (trackers and STUN) and any relay; they can see when you are active and, for the sites
> you open, link your activity on several sites by that address. **Host-only mode** connects to nobody but the site's
> own host, so other visitors see nothing of you, but chat, file sharing and private media do not work there and the
> host still sees your address. **Tor Browser** hides your address from the host and the connection servers for what
> it can carry, but it does not run WebRTC (to be confirmed from a primary source), so in Tor Browser you can read
> and sign in but cannot connect to other visitors. Nothing in felinar proves who you are, your age or that one key
> is one person.

### The sentences the loader and these documents use

R 2.14.2 replaced sentences that promised more than the code can hold. The replacements below are the wording of the
cards and of every document in this repository. Each one carries its condition in the same sentence. A test in the
loader's string tables fails if a replaced sentence comes back (`docs/deviations/ui.md`).

| Subject | The sentence |
|---|---|
| Matching a visitor by key | "Sites cannot match you by key unless you choose to be recognised. They can still match you by IP address, a reused name or timing." |
| The private record | "Other visitors and anyone holding a copy of the ledger see only ciphertext. The site's own code can read your record while you are signed in." |
| A profile | "Encrypted. The site can read it while you are signed in." |
| The sign-in card and the passkey | "Your passkey may be saved by your password manager (for example iCloud Keychain or Google Password Manager), which then knows you have a felinar identity at `<IdO>`. Your identity itself stays on your devices." |
| The passkey and the sealed copies | "If you choose a passkey, each site you sign in to also keeps a sealed copy of your identity in this browser, so you can get it back if the browser clears this page's data. The site cannot open the copy, but its code can read it." |
| Signing in | "Signing in does not send your key or the list of your other sites to any identity company. The host of the identity page does see your IP address and the time whenever your browser has to load that page. Your passkey provider, if you use one, stores a passkey for the identity page." |
| Conversations | "Conversations are never written to the site ledger. Anyone connected can record the encrypted copies." |
| Holders | "Holders can link the address that left a message to the address that collected it." |
| Groups and trackers | "Private groups are not announced to the public trackers; the site's own tracker sees the addresses of members who join." |
| Neighbours | "Your IP address, unless the site is busy enough that you are not connected to them directly." |
| Presence, off by default | "Nobody sees your name as online unless you turn presence on. People connected to you can see that your address is on this site's chat." |
| Public presence | "Public presence shows your key." |
| Keys held by site code | "Code on a site you are signed in to can copy your keys for that site." |
| Uploaded files | "The loader never renders uploaded files at the site's address; site code that renders a file itself is responsible for it." |
| Private lanes and the owner | "The owner cannot read them from the ledger or the swarm; the owner can read them through the code visitors run." |

(`<IdO>` stands for the host name of the identity page. The card prints it.)

### The recipients register, v0.3

These recipients are added to the register above, and each must be named on the card for the feature that reaches it
before any data flows (R 2.14.3, MF-59).

| Recipient | What it receives | When | Default |
|---|---|---|---|
| The identity origin's operator | the IP address and the time of popup loads that miss its cache, and of update checks. With altered code at the identity origin, the roots of people who unlock afterwards | when the identity page opens in a window; by design most sign-ins load nothing from this host because its own Service Worker caches the bundle (R 2.3.9; unmeasured) | whichever origin the site names (`publish --idp`, which puts `idp=` in the pointer, or `<meta name="mw-idp">`); there is no default, by design: the project hosts none (R 1.5, N-2, decided for 0.3.0). A site owner, hub or person runs their own or uses one they trust, and every operator copies this row into their own notice |
| The passkey provider (a password manager, or the platform: for example iCloud Keychain or Google Password Manager) | that the person has a felinar identity at the identity page: one credential, for one origin | when the person chooses a passkey | the person's own provider |
| A server-backed relying party (a site that checks sign-ins with `@felinar/verify`) | the person's key for that site, a nonce, times, the IP address and the user agent, at each sign-in | at each sign-in to that site | the site's operator |
| The site's own tracker and STUN servers, for chat, groups and private files | IP addresses, the lane's infohash, when a person is active; for private media swarms a random infohash and which addresses announce it (an edge between an uploader's address and a recipient's) | after the visitor turns chat or files on | the site owner must name its own; the separate chat lane, group lanes and private media swarms announce only to it and use only its STUN servers (R 2.7.1, MF-44). Chat also travels over the connections the browser already has for this site's ledger, which the pointer's trackers (for an unsigned pointer, the four public ones too) and the two default STUN servers helped set up; those servers do not learn that you chat, because the chat lane's infohash is never announced to them |
| The public default trackers and STUN servers | which addresses open which felinar sites, on the ledger and content swarms, as in the register above | after "Share and load" | unchanged from the register above |
| The hub tracker and pin node, and the hub's pin mailbox (the mailbox is proposed: no page sends it frames in 0.3.0) | IP addresses, message tags, sizes and times; the ciphertext of held and pinned items; the plaintext of public files they pin | when a hub runs them and a person uses chat, files or a personal site on that hub | the hub operator, named on the card |
| The owner's TURN relay (only if the owner runs one) | both IP addresses of a relayed pair, how many bytes, and when | only for a call whose direct connection fails (calls are in the C2 register below; direct chat channels are not built) | off; the operator is named on the card and states its retention (R 2.7.8) |
| An external age verifier (designed, not built: 0.3.0 has no age method, and nothing reads `_mw.cfg.age`) | once it exists, a yes or no attestation only; no document would pass through the loader | never in 0.3.0 | none |
| Other people on a chat lane, in a group or in a file swarm | the IP address, that the visitor uses chat on this site, padded sizes and times; for recipients and group members everything the visitor sends; the visitor's signed chat key, which names their key for this site, only when there is a reason (a contact, group member or call-roster key, a key the page looks for, open message requests, public presence), so a neighbour that is none of these does not learn the site key from chat (review round PRIV-2; `src/loader/api.js:2156`) | while the visitor has chat or files on and the page is open | off until the visitor opts in |
| Opt-in holders | encrypted messages they cannot read, for up to 7 days (chosen, R 2.7.5); the address that deposited a message and the address that collected it | only if a visitor turns on "Hold messages for others" | off |

The design has no analytics, no error reporting and no account at an identity company. The root is kept wrapped on
the person's own devices; the sites a person signs in to hold only opaque wrapped copies (escrow) that they cannot
open, and only of a root wrapped by a passkey: a passphrase identity is never escrowed, so after a browser deletes the
identity page's data it comes back from the 12 words or the backup file (code review v0.3). The DNS-over-HTTPS resolvers of the register above are unchanged.

### What stays on the device, v0.3

| What | Where | Removed by |
|---|---|---|
| The wrapped root and the vault (random chat, record and own-media keys, contacts, links) | the identity page's IndexedDB | "Remove my identity from this device" at the identity page, per device; clearing the identity page's site data. Other devices and the 12 words still restore the public identities |
| This site's working keys | memory; IndexedDB as non-extractable keys only with "Stay signed in" (30 days at most, chosen, R 2.4.1) | Sign out; "Remove from this device" |
| Escrow blobs: opaque copies of the wrapped root and vault that the identity page hands to each site the person signs in to | each site origin's IndexedDB | "Remove from this device" |
| Caches sealed under a local key: history if kept, the seen-set of messages, a contacts cache | the site origin's IndexedDB | "Remove from this device"; deleting history |
| Other people's encrypted envelopes held for them, up to 7 days and 4 MiB (chosen, R 2.7.5) | a holder's memory, while the page is open: nothing is written to disk | collected by the recipient, expiry, turning holding off, or closing the page |
| Ciphertext pieces of other people's files, while the visitor chose "Help share this file" | the file chunk store, inside the storage budget | stopping sharing; leaving the file torrent; "Remove from this device" |
| Chat key private halves, one per epoch | the vault | deleting a key retires it; "Remove my private data on this site" |
| Files and media chunks (ciphertext for private items) | the site origin's IndexedDB, inside the storage budget (files take at most half of what remains after the site and its ledger, chosen, R 2.8.8) | "Remove from this device"; deleting the item |
| Playback keys | the Service Worker's memory, for the session | sign out; closing the page; 12 hours at most (chosen, R 2.9.6) |
| The passkey | the person's password manager or platform | deleting it there |

### Retention, v0.3

| Data | Kept by | How long |
|---|---|---|
| Sealed items on the ledger, and chat-key records the person chose to publish there | every visitor who holds a copy of the ledger | until removed from copies that sync; a deleted item leaves a stub (who signed it and when) until the owner writes a checkpoint |
| Allow-list entries and bans in the current state | every visitor who holds a copy | until removed or, for a ban, until its `until` time |
| A recovery commitment (`keyinfo`, the hash of a recovery public key) and key changes (`rotate`) | every copy | for good: the commitment cannot be redacted by a moderator, so that recovery cannot be taken away |
| Held envelopes | opt-in holders | 7 days at most (chosen) |
| Local history | the visitor's browser | until the visitor deletes it |
| Hub pins and mailbox contents | the hub operator | as the operator states; a hub that pins is central storage the operator pays for and can be compelled to empty |

### Who is responsible, v0.3

The same limits as above apply: the roles come from a reading of the research, not from advice.

| Feature | Who decides how the data is processed (research reading, not confirmed by a lawyer) |
|---|---|
| Chat lanes, the purpose of holders' storage, the pin mailbox, the pin node and the TURN relay | the site owner as controller; with a hub that runs them, most likely the owner and the hub as joint controllers (GDPR Art. 26: an arrangement whose essence visitors can read; none ships) or the hub as the owner's processor if it holds data strictly on the owner's instructions (Art. 28(3): a written contract; none ships); the operator's own logs of IP addresses are its own processing |
| The identity origin | whoever operates the host, for its own logs: a named person or organisation (for a default one, whoever the owner decides will run it; until then there is none), or the operator of a self-hosted one. Not a hosting service under the DSA and not a user-to-user service under the Online Safety Act: it stores nothing users provide, and nobody posts to anybody on it |
| A visitor who holds envelopes for others or helps share a file | not "just relaying": the visitor chose to store or share on a consent card, and the documents never describe it otherwise |
| The ledger and sealed items | the site owner decides the purpose; visitors who copy it pass on what it contains |

The research also reads an owner who runs an open ledger with chat and profiles as likely to be treated as a
controller for what visitors post, even with no server holding it
(`docs/research/v03/R6-legal-compliance.md`, F3). The reading rests on the Russmedia judgment (CJEU, C-492/23, Grand
Chamber, 2025-12-02, paragraphs 66 to 75, on a commercial online marketplace) and on EDPB Guidelines 02/2025, version
2.0, paragraphs 38 to 40, both read on 2026-10-22. No lawyer has reviewed it, and it is not legal advice.

### Public by design, v0.3

- membership lists and bans;
- public file listings and the names on them;
- chat-key records the person chose to publish on the ledger ("public and permanent");
- the metadata of sealed items: who wrote one, when, and its fixed size;
- the fact that a key rotated or committed to a recovery key.

### Your rights, and what removal reaches

User-facing copy says "hide from copies that sync" and "remove". It does not say "erase" or "delete everywhere"
(R 2.15).

| Action | Where it is | On this device | On the ledger and peers | What it cannot do |
|---|---|---|---|---|
| Sign out | `mw.auth.signOut()`, the site's own button | deletes this site's working keys | nothing | |
| Remove from this device | the loader's Settings, "Remove from this device" | deletes working keys, escrow blobs, caches and chunks | nothing | |
| Remove my private data on this site | `mw.me.erase()` from the site's page; the identity page confirms | deletes caches; the identity page deletes the record and own-media keys for this site | tombstones every sealed item the person wrote there | copies kept by peers that never sync stay; nobody can open them with the identity as it is after the removal (see below for what can bring the key back) |
| Leave this site | **(proposed)**: no method, card or page offers it yet (R 2.15). Today a site can tombstone the person's own entries itself, as the social example's "Delete my page" does | as above, plus local media and files | would also tombstone every payload this key wrote, empty the profile, stop seeding and revoke grants | signed public posts would remain as stubs until the owner's next checkpoint |
| An owner checkpoint | `node tools/ledger-admin.mjs checkpoint`, by the owner | | honest copies that apply it drop every earlier block and stub | copies on devices that never sync, and software that ignores checkpoints |
| Remove my identity from this device | the identity page's Settings, "Remove my identity from this device" | wipes the root and vault on this device | nothing by itself ("Replace my keys on all sites" first, if wanted) | other devices and the 12 words still restore the public identities. Destroying every copy of the words and of the backup file is the only full shredding |

A removed record key cannot be recovered from the identity as it stands after the removal. Two things made before the
removal still hold it: a backup file, and the copies of the identity's vault that sites keep for the identity page
(R 2.2.5). If the identity page later restores from one of them (from the backup file, or from a site's copy after the
identity page lost its own storage), the key comes back, and remaining copies of the record can be opened again with
that identity (`docs/deviations/idp.md`, item 18). People a message or a file was shared with may have kept it, and
revoking a share works in honest apps only.

What these texts may and may not say about erasure. They may say "hide from copies that sync", "remove" and "tombstone",
and must say what remains: the outline of a deleted post (the author's key, the minute and the list's name) until an
owner checkpoint; copies on devices that never sync again; what other people kept; and a backup file or an earlier copy
of the identity. They may not say "erase", "delete everywhere" or "forgotten"; that a deleted entry no longer exists;
that the outline is anonymous or holds no personal data; that destroying a key makes data gone without its conditions;
or that the site meets a right to erasure. The reasons (EDPB Guidelines 02/2025, version 2.0): a public key is personal
data wherever the person can be identified by means reasonably likely to be used (paragraph 26); a salted hash is
personal data (52); deleting a key makes encrypted data unreadable only until the algorithm is broken or if the key
was already leaked, and encrypted data stays personal data (51); technical impossibility does not excuse
non-compliance (50). GDPR Art. 17(2) asks a controller that made data public for reasonable steps, including technical
measures: a tombstone, a new snapshot and a checkpoint are those steps here. The UK's guidance on distributed ledgers
is under review.

### Transfers outside the EEA, the UK and Quebec

Peers can be anywhere in the world, and every peer a visitor connects to receives IP addresses, keys, sealed items and
chat frames. Nothing in the software can restrict where that is. The default resolvers and STUN servers are run outside
Canada: Cloudflare, Inc., Google LLC and Twilio Inc. are US companies, and DNS.SB says it is operated by xTom GmbH in
Germany (its privacy page, read 2026-10-22). Where the four default trackers are hosted can change. The questions below
come from the privacy judge of the design review (PRIV M6) and the legal research note R6 (open questions 1 to 5). No
lawyer has answered them; the research answers that follow the list say how far the sources go:

1. Are peers outside the EEA, the UK and Quebec recipients of a transfer that needs a safeguard under GDPR Chapter V,
   UK GDPR Chapter V or Quebec's Law 25 s. 17, and what can a static site lawfully say about that?
2. Is the author public key and timestamp that a stub keeps personal data that must be erasable, and does retiring a
   per-site key (with a checkpoint) satisfy a supervisory authority?
3. Does a visitor who seeds a site's public ledger become a controller for other people's entries, a recipient, or
   fall within the household exemption?
4. Who is the "provider" of a site served from a swarm and a static host, for the UK Online Safety Act and the DSA?
5. Does Quebec s. 28.1 apply to a peer-replicated ledger, and how does an owner honour it for copies they do not hold?

Answers from the research of 2026-10-22 (AI research agents; no lawyer has reviewed them):

1. **A transfer that needs a safeguard?** EU and UK: yes for trackers, STUN servers and resolvers outside the EEA or the
   UK. Data that a visitor's browser sends because the owner's code told it to is read as the owner's transmission (EDPB
   Guidelines 05/2021, version 2.0, paragraph 9 and note 15, on cookies, by analogy; the ICO's international transfers
   guide), so they need an adequacy decision, a safeguard or a derogation. Peers acting for themselves are probably not
   importers; no authority has said. For public services the only tool is explicit consent after a warning of the risks
   (Art. 49(1)(a) of the GDPR and the UK GDPR), which the gate and the card ask for. The EDPB reads derogations narrowly
   (2/2018) and the ICO says that without an exception "you must not make the transfer", so this stays open for sites
   aimed at the EU or the UK. Medium to low. Quebec: s. 17 bars an enterprise from communicating personal information
   outside Quebec until an assessment finds adequate protection and a written agreement follows. Whether the owner
   "communicates" what the visitor's own browser sends is not settled; the prudent reading for a Quebec audience is that
   it does, so peer connections must wait for the visitor's explicit choice on a card that says other visitors and
   servers can be anywhere and offers "Load from host only" as an equal choice, which is what `--aud qc`, the gate and
   the card do. A written agreement with the operator of a tracker or STUN server you name is yours to make. PIPEDA has
   no such ban, but an organization stays responsible for information it passes to a third party for processing
   (Schedule 1, clause 4.1.3), and the OPC expects it to say plainly that information may be processed in another
   country and reached there by its courts, police and security agencies (cross-border guidelines, 2009).
2. **Are the stub's author key and timestamp personal data?** Treat them as such: a public key is, where the person can
   be identified by means reasonably likely to be used, and a salted hash is for whoever kept the value and the salt
   (EDPB Guidelines 02/2025, version 2.0, paragraphs 26, 52). Whether retiring a per-site key with a checkpoint leaves
   data "effectively rendered anonymous" (paragraph 103) is unsettled. The texts never say erased or anonymous. Medium.
3. **A seeding visitor:** under the GDPR at most a recipient, and not clearly within the household exemption. Low to
   medium. In Canada neither an organization (PIPEDA covers commercial activities, and s. 4(2)(b) leaves personal or
   domestic use out) nor an enterprise (Quebec's Act).
4. **The provider:** under the Online Safety Act, whoever controls who can use the user-to-user part (the owner, an
   individual if no organisation does; a hub for the parts it controls; a hub that only opens sites is an access
   facility, which a court can order to restrict a site; the loader's author is not) (ss. 226(2), (3), (12), 144, 146).
   Under the DSA, whoever stores what visitors post at their request is a hosting provider (Art. 3(g)(iii)). Medium.
5. **Quebec s. 28.1** lets a person require an enterprise to stop disseminating personal information, or to de-index a
   link attached to their name, when the dissemination contravenes the law or a court order, or seriously harms their
   reputation or privacy in a way that clearly outweighs the public's interest and the free expression of others. Section
   32 applies: a written answer within 30 days, and silence counts as a refusal. An owner of an open ledger disseminates
   its entries. On a valid request, tombstone the entry and ban the key, write a checkpoint, remove the entry from the
   snapshot (`cs=`) and from any pin node you run, answer in writing, and say plainly that copies on other devices stay.

The DPIA (GDPR) and the Quebec privacy impact assessment sections of this page gain a transfers part that states
this and lists what reaches peers: IP addresses, keys, sealed items and chat frames. Chat and synced records are off
by default on every site (legal research note R6, recommendation 4; PRIV M6, fix 3). If you declare an EEA, UK or
Quebec audience (`--aud`), do both assessments before you turn chat or synced records on. That is the owner's duty:
the tools do not check it, and `--aud` changes only the consent gate.

### Defaults

The defaults are the most private ones, with one exception. The research reads that as what Quebec's Law 25 s. 9.1
requires of a service offered to the public (the highest level of confidentiality by default, with no action by the
person), as what the UK expects of a service that children may use and, for Canada, as what the OPC's Children's
Privacy Code expects (MF-60; legal research note R6; not legal advice). The exception is the Echo lane: on a desktop,
once the visitor has chosen "Share and load", a private photo or video the visitor opened stays in its swarm, and 0.3.0
has no `_mw.cfg` setting for the owner to turn that off (the C2 section below). For a site declared `--aud qc` or
`--aud kids`, that is a default that is not the most private one:

- message requests from strangers are off;
- public file listings, private files and private media are separate switches for the owner and separate opt-ins for
  each visitor; chat and files are off until the owner turns them on;
- presence is off;
- "Stay signed in" is a choice the visitor makes, and it is off in shared-computer mode;
- visitors' profiles follow the ledger's writer policy: off under the default `owner`, on once the owner allows other
  writers.

The design review asks for children's defaults on a site with no age method (`_mw.cfg.age` is `none`, the default; R
2.5.5, MF-60). In 0.3.0 that is only the list above, which applies to every site whatever the age setting: no code
reads `_mw.cfg.age`, so setting an age method changes nothing, and nothing stops an owner from turning features on
with it at `none`. The owner confirms the full list before release, against the children's rules of "Children" above;
no lawyer has confirmed it. This software cannot check anyone's age. Do not turn on chat, uploads or open writing for a
site that children use unless you check age yourself, outside felinar, and have completed an assessment. For children
under 13 in the United States that is not enough: COPPA also needs verifiable parental consent before you collect their
personal information, and an age check that flags a child gives you actual knowledge. This software cannot obtain that
consent.

### Impact assessments, v0.3

Chat, files and profiles on an open ledger meet several of the criteria that suggest a DPIA: an innovative technology,
large scale (it depends on the site), systematic monitoring (swarm membership is visible) and vulnerable data subjects
(children). A site that turns them on should run one. The "No personal data in the ledger" rule above has one
exception by design: a synced sealed record is personal data even though it is encrypted (EDPB Guidelines 02/2025,
as cited above), which is why the vault at the identity page is the default home of the record and ledger sync is a
separate opt-in (`_mw.cfg.records`, off by default) with a cap on the number of items.

### v0.3 C2: seeding, the pin node, dock mode and calls

> **Status: v0.3 C2, built and reviewed.** What phase C2 adds to the question "who receives what"
> ([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), "SZ"; ARCHITECTURE 8.1 and 15.14). Built and
> integrated on 2026-10-20 and tested on loopback only; no lawyer has reviewed the sentences, as for the rest of v0.3. The premise is the one stated above: peers see each
> other's IP address. This part says what else they learn, and when.

In short:

- **Sharing a file shows which file you hold.** When your browser shares a file it holds (the Keep and Echo lanes), the peers it connects to and
  the site's tracker see your IP address and which file it is: more than an address (S1 D1). Every file you chose to keep sharing carries the
  sentence "Others can see which files you share". What your browser passes on after you open something differs by kind. A public or
  private file you fetched is never shared again unless you turn on "Help share this file". A private photo or video you opened joins the
  Echo lane: on a desktop that is the default once you chose "Share and load"; on a phone it needs your agreement ("Share on this network"),
  and a phone default waits for owner decision SZ-1. One site-level sentence covers that lane.
- **A call shows your IP address to every participant once you accept.** The ring carries no address. The callee's connection does not exist
  before the callee accepts, and the caller sends no candidate before the accept, so a declined or ignored call shows nobody's address. After
  an accept, the two sides see each other's address; in a group call every participant learns every other's, and the caller sends the
  roster (up to 5 public keys of the other participants) to each person who accepts, so each learns who else was invited. A relay, only if
  the owner runs one, sees both addresses of a relayed pair, how much they send and when, never what is said. A call goes through the relay
  only when a direct connection fails. A choice to send every call through it, so that the other participants see the relay's address and
  not yours, is planned and not built: 0.3.0 has no switch for it.
- **The people who carry the signalling can see that a call is being set up.** A SIG frame is sealed, but its type, its size, the time and the day's
  tag for the pair are in the clear (R 2.7.3), and an offer or an answer is padded only to the smallest of the four sizes (256, 1,024, 4,096
  or 16,000 bytes) that holds it, so its size can hint at what the call carries. The chat-lane neighbours that pass it
  on can tell that a call is being set up between two tags, roughly which message it is and when. They cannot read the offer, the addresses in it or
  who the tags belong to.
- **A pin node's status file is public.** The owner's pin writes a signed heartbeat at `<web seed>/pin-status.json`. It names the site, the
  pin's public key, the time, the bytes sent this month against the cap and the pinned items as hashes: the first 16 bytes of SHA-256 of a
  domain-separated infohash, so a private infohash is never in the clear. Whoever already knows an infohash can test whether the node holds it.
  The counts are of keys and bytes, not of people.
- **Dock mode keeps a phone visible.** While it is on (2 hours by default and 8 at most, chosen), the screen stays on and the browser shares what you keep,
  so the peers see your IP address for that time. It ends when you leave the page, unplug the phone, let the battery fall under 20% (where the
  browser reports it) or reach the cap.
- **The counters stay on the device.** The seeding meters (bytes by lane for the session and the month) are local. The loader never sends them to a
  tracker or a peer, and never ranks them. The site's own script can read them, because `mw.net.seeding()` returns them
  to it like any other read method of the SDK, so a site could send them to its own server. There is no reward for sharing (ARCHITECTURE section 8).
- **Without a domain, a DNS service learns the site's name.** A site on a name such as `203-0-113-7.nip.io` is found through that free service,
  which two volunteers run with no uptime promise and no privacy statement (S2 F1). The resolver of each visitor asks it for the name, and the
  name contains the server's IP address.

#### The recipients register, C2

These rows are added to the registers above. As in R 2.14.3, each must be named on the card for the feature that reaches it before any data
flows.

| Recipient | What it receives | When | Default |
|---|---|---|---|
| The other people in a call | your IP address; your key for this site; what you say and show; the roster keys of a group call | after you accept (a callee) or after the callee accepts (a caller) | calls are off (`_mw.cfg.calls`) until the owner turns them on, and need chat and the site's own tracker and STUN |
| The chat-lane neighbours that carry the signalling of a call | the type, size and time of each sealed SIG frame and the day's tag for the pair; not the offer, the addresses or the names | while a call is being set up | the same neighbours as for chat; calls are off until the owner turns them on |
| A call relay (only if the owner runs one) | both IP addresses of a relayed pair, how many bytes and when; never the content | only when a direct connection fails (a choice to relay every call is planned, not built) | none: no relay unless the owner sets `_mw.cfg.turn`; the operator is named on the card (R 2.7.8) |
| The peers you re-share a file with, and the site's tracker | your IP address and the infohash of each file torrent your browser announces, so which files you hold | while the page is open and the lane has a budget | files you chose to keep sharing; the Echo lane on desktops, and on phones only after your agreement |
| The owner's or a hub's pin node, when you hand off an upload | the file (ciphertext for a private item, the bytes for a public one), your IP address, and the item's infohash for a receipt | when you upload and `_mw.cfg.pin` names a pin | no pin, no hand-off: the card says "No always-on copy exists for this site." |
| Readers of the pin's `pin-status.json` | the site, the pin's public key, the time, hashed item ids, bytes this month and the cap | any time, for anyone who can load the web seed's folder | written only when the owner runs the pin with `--status` |
| The operators of the doors a page contacts: the owner's signed doors (`org=`, `dr=`), the ledger's `_doors`, the last door that served the site and, from a link, unsigned `#mwd=` hints (public hosts only) | the visitor's IP address and the time of a `door.json` request, to up to three doors at a time; a door asked for this site's bytes (only an `org=` door, the last good door or a host the pointer names in `ws=` or `xs=`) also learns which site is opened | when the page's own address stops answering, and a check of the page's own address after each load; these are HTTP requests made whatever the sharing choice, so host-only visitors are included | the owner's lists; a hint comes from the link, not from the site owner, and gets no request for the site's bytes |
| The operators of nip.io or sslip.io (only for a site on such a name) | the lookups of the site's name by visitors' resolvers: the name, which holds the server's IP address, and the resolver's address | when a visitor's resolver looks the name up | a free service with no uptime or privacy statement; an own domain avoids it |

#### What stays on the device, C2

| What | Where | Removed by |
|---|---|---|
| The seeding meters: bytes by lane for the session and for the UTC month | the loader's per-origin store | clearing site data; the month counter starts again in a new UTC month |

Call signalling is not kept: SIG messages are never remembered in the history and never acknowledged (ARCHITECTURE 15.14). The design has no
feature that records a call.

#### The sentences the cards use, C2

These are the texts of `src/loader/strings.js` (`SEED_TEXT` and `CALL_TEXT`, English and French). A test pins the English of the design's tables.

| Subject | The sentence |
|---|---|
| Starting a call | "Call {name}? Your browsers connect directly, so {name} will see your IP address. Nobody else is in the media path." |
| Answering | "{name} is calling ({kind}). Accepting shows your IP address to {name}." |
| A group call | "Join a call with {names}? Each of them will see your IP address." |
| A relay | "If a direct connection fails, the call goes through {operator}'s relay, which sees both IP addresses and how much you send, not what you say." |
| Sharing a screen | "Everyone in this call will see the screen or window you pick." |
| Helping to keep a file | "Help keep this available? While this page is open and your phone charges on Wi-Fi, it shares what you keep, up to {cap} a month on this site. Others can see your IP address and which files you share." |
| A file only you have | "Only on this device. Keep this page open until it is sent." |
| Counts of holders | "Kept by you and at least {n} others online now (reported)": a count from the bitfields of the peers you are connected to, which can lie |
| A tracker's count | "{n} connected to this site (tracker report, {time})" |

#### Who is responsible, C2

The same limits as above apply: the roles are a reading of the research, which no lawyer has reviewed. A person who
runs a pin node for others is also a hosting provider under the EU Digital Services Act for what it stores (Art.
3(g)(iii)).

| Feature | Who decides how the data is processed (research reading) |
|---|---|
| Whether calls exist on the site, and the relay | the site owner, who sets `_mw.cfg.calls` and `_mw.cfg.turn`; the operator of a relay it names |
| The pin node and its status file | whoever runs `tools/pin.mjs`: the owner, or a hub operator as joint controller where a hub runs it |
| Re-sharing a file | the visitor who chose to share it, on a card that says so; the Echo lane on desktops is a default the owner and the loader set |
| The people in a call | each participant decides what to do with what they see and hear; the documents never describe them as "just relaying" |

## A privacy-notice template

Adapted from [PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md) 9.2 (b) to what 0.3.0 does on a site that turns on none
of the v0.3 features; the additions after it cover those features. Replace every `<...>`,
delete what doesn't apply, make every sentence true for your deployment and, if you can, have a lawyer qualified where
your visitors are review it: no lawyer has reviewed this template. Link it from your own pages and put its URL in the
pointer with `publish --lg <URL>`; `publish` signs `lg=` into the pointer, but the 0.3.0 loader does not show it to
visitors. If you
serve Quebec, publish the notice in French too: the Charter of the French language asks an enterprise that offers goods
or services to consumers to inform and serve them in French (s. 50.2), and the OPC expects privacy information for a
service that children may use to be available in both official languages.

> **1. Who we are.** <Name or entity>, <postal address>, <privacy@...>. EU or UK representative, if any:
> <name, address>. Canada: the person accountable for our compliance with privacy law (PIPEDA, Schedule 1, clause
> 4.1): <name or title, address, contact>. For Quebec visitors, the person in charge of the protection of personal
> information: <title, contact>.
>
> **2. What this site does.** It loads <site> from <host> and, if you choose to share, from other visitors'
> browsers. It keeps a shared, public log of posts (the site ledger) that every visitor's browser copies.
>
> **3. Who receives what.**
>
> | Recipient | What they see | Why | Kept |
> |---|---|---|---|
> | <Static host> | your IP address, the pages and files you request, your browser's request headers | to serve the site | <N days or none> |
> | <Web seed host, if different> | your IP address, the files you request | to deliver the site when no other visitor can | <N days or none> |
> | Connection servers (WebSocket trackers): <names> | your IP address, this site's address (its infohash), the time | to introduce you to other visitors, only if you choose to share | set by each operator: <links> |
> | STUN servers: Cloudflare, Twilio | your IP address | to work out how other visitors can reach you, only if you choose to share | set by each operator: <links> |
> | DNS-over-HTTPS: Cloudflare, dns.sb, Google | your IP address and the name `_magnet.<site>` | to check for updates of this site's address, only if you choose to share (or, if we publish the address only in DNS, to find the site) | set by each operator: <links> |
> | Other visitors | your IP address, that you view this site, your posting key and posts, the files your browser uploads | to share the site and its log, only if you choose to share | until they delete it |
> | Us, the site owner | posts you write | to run the site | as long as the site keeps them |
>
> **3b. Why, and on what basis.** Connecting you to other visitors, to connection servers and to the DNS service
> happens only if you choose "Share and load". That is your consent, and you can withdraw it any time in Settings.
> We keep our host's logs for <N days or none> to run and secure the site. We keep what a report to us contains, and
> our reply, for <3 years> to deal with it and to show that we did. <Name the legal basis of each purpose that applies
> in your country, and add a line for every other purpose.>
>
> **3c. Reports.** If you report something to us, we keep your report, your contact details and our reply for <3
> years>. If a report is about you or your post, we may keep it and tell the person who reported it what we decided.
>
> **4. What is stored on your device.** The site's loader (a service worker), the site's files, its address
> record and our signing key, your sharing choice and a copy of the site's shared log; if you sign in to write, this
> site's working keys while you stay signed in (see 4b). "Forget this site" in Settings deletes the site's files;
> clearing this site's data in your browser deletes everything. These stay on your device whichever you choose in
> item 5, so that the site loads faster next time, until you use "Forget this site" or clear this site's data. <If you
> add a setting that stops the storage, say where it is.>
>
> **5. Your choice.** Your browser connects to other visitors and connection servers only if you choose "Share
> and load". "Load from host only" never connects you to other visitors. You can change your choice any time in
> Settings. On phones, uploading stays off until you turn on "Share on this network".
>
> **6. Public by design.** Posts and your posting key are visible to everyone who opens this site and are copied
> by their browsers. You can delete your own posts, and browsers that receive the deletion remove the text. A deleted
> post leaves its outline (who signed it, the minute it was written and the list's name) until we write a checkpoint,
> and we cannot reach copies on devices that never connect again or what other people kept.
>
> **7. Others may record IP addresses.** Anyone can join this site's swarm and record the addresses they see. We
> do not control this.
>
> **8. Children.** <Use this only if it is true: This site is not directed to children under 13, and we do not knowingly
> collect personal information from them. If we learn that a child under 13 has given us personal information, we hide
> it from the site and ban the key; copies on other visitors' devices that never sync again may stay. / If this site is
> directed to children, do not use this template, and do not turn on felinar's peer connections, chat, uploads or
> profiles.>
>
> **9. Transfers.** The people you connect to, and some of the connection servers, can be anywhere in the world,
> including outside Canada and Quebec and in countries with no adequacy decision from the European Commission or the UK
> government. We cannot put safeguards in place with them. Connecting to them is your choice (item 5), and by choosing
> it you agree to the transfer after this warning. Servers in other countries are subject to those countries' laws,
> and their courts, police and security agencies may be able to get what they hold. Our own hosts and resolvers:
> <where they are, and the safeguard for each: an adequacy decision, standard contractual clauses or, for the UK, the
> International Data Transfer Agreement>.
>
> **10. Your rights.** You can ask for access, correction or erasure of what we hold, for restriction, to object, and to
> withdraw your consent (Settings). We answer within one month, and in Canada within 30 days of a written request. We
> cannot link a posting key to a person: to use these rights for a post, show us that you control the key (we will send
> you a text to sign). What deleting a post reaches, and what it cannot, is in item 6. You can complain to us first at
> <privacy@...>; <UK only: we acknowledge a complaint within 30 days and tell you the outcome.> You can also complain to
> <supervisory authority; in Canada, the Office of the Privacy Commissioner of Canada (priv.gc.ca) and, for Quebec, the
> Commission d'accès à l'information (cai.gouv.qc.ca)>.
>
> **11. Changes.** If the connection servers change, your browser asks for your choice again. Other changes to
> this notice are dated here: <date>.

### Additions to the notice template, v0.3

> **Status: v0.3, built and reviewed.** No lawyer has reviewed these additions. Use these only for the features your
> site actually turns on; every sentence must be true for your deployment.

Add these rows to the table in section 3 ("Who receives what") of the template:

> | Identity page: <operator> | your IP address and the time you open it, when it is not already cached on your device | to let you sign in with one identity on many sites | set by the operator: <link> |
> | Your passkey provider: <name> | that you have a felinar identity at the identity page | only if you choose a passkey | set by the provider: <link> |
> | Our tracker and STUN server: <hosts> | your IP address and when you are active on this site's chat or file lanes | to introduce you to the people you chat or share with, only if you turn chat or files on | <N days or none> |
> | Our pin and mailbox service: <operator> | your IP address, message tags, sizes and times; the encrypted messages and files it holds for you | to keep encrypted items available when you are offline, only if you use it | <N days> |
> | The people you write to and share with | everything you send, and your IP address while you are connected | to deliver it | until they delete it; they can keep what you send |
> | Relay (TURN): <operator>, if we run one | both IP addresses of a relayed pair, how much you send, and when | only for a call whose direct connection fails | <N days or none> |

Add these to the other items:

> **4c. What is encrypted, and who can still read it.** <Say this only if you turn on chat, files or private media.>
> Messages, private files and private media are encrypted on your device before they are sent. The code of this site,
> which your browser runs, can read them while the page is open and you are signed in, and so can the people you send
> them to, who can keep them. They are not readable from the site ledger or by the other visitors who carry the encrypted
> copies. Your IP address, when you are active and the sizes of what you send stay visible to the people you connect to.
>
> **4b. What is stored on your device.** The identity you create (a wrapped root and a vault of keys), kept at the
> identity page; this site's working keys while you stay signed in; opaque copies of your wrapped identity that this
> site keeps so that you can recover it if your browser clears its data; other people's encrypted messages, held for up
> to 7 days if you turn that on; and pieces of other people's files while you help share them. Each can be removed:
> "Sign out" and "Remove my private data on this site" on this site, "Remove from this device" in the loader's Settings,
> and "Remove my identity from this device" at the identity page.
>
> **6b. Public by design.** Membership lists, bans, public file listings, the chat keys you choose to publish, and who
> wrote an encrypted item and when are visible to everyone who opens this site and are copied by their browsers.
>
> **9b. Transfers.** The people you connect to can be anywhere in the world and receive your IP address, your keys for
> this site, encrypted items and chat frames. <The safeguards we use, if any.>
>
> **10b. Removing your data.** "Remove my private data on this site" hides your encrypted record from copies that sync
> and destroys the key for this site, so remaining copies can no longer be opened by you or anyone who later gets
> your 12 words. A backup file made before the removal, or an earlier copy of your identity that a site keeps for the
> identity page, still holds the key, and restoring from it brings the key back. We cannot reach copies on devices that
> never connect again, or things that people you shared with kept.
>
> **Age (add before item 11).** <We use <method> to ask for an age. / We do not check anyone's age. Chat and uploads are off for
> everyone, and only we write to this site.>

### Doors (v0.3 C2)

> **Status: v0.3 C2, built and reviewed.** ARCHITECTURE 15.15; tested on loopback only.

A door sees the visitor's IP address, the time and the requests to `/_mw/*` (the loader and `door.json`); it does not see which site in
those requests, because a link's fragment never leaves the browser (RFC 3986 3.5). A door that serves altered code can
read the fragment in the visitor's browser and send it home, which is why a first door is trusted ("Trust on first door"
in SECURITY-MODEL.md). A site's bytes from a full door (`/ws/<name>/`, `/_mw/t/<btih>.torrent`)
name the site to that door. When a page's own address stops answering, the page contacts up to three other doors of that site (one
`door.json` request each, no credentials, no referrer). The door page keeps, per door origin: a small health list of door hosts it
contacted, the last door that served each site's `.torrent`, the owner's accepted `_doors` list, the visitor's choice per site, and copies
flagged `viaDoor` (at most four, deleted first). Identity at a door lasts for this visit only. A network observer still sees which door
host a visitor contacts.

### Additions to the notice template, v0.3 C2

> **Status: v0.3 C2, built and reviewed.** Use these only for the features your site turns on. No lawyer has reviewed them.

Add these rows to the table in section 3 of the template:

> | The other people in a call | your IP address once you accept, your key for this site, and what you say and show | to connect the call, only if you place or accept one | until they delete it; any of them can record |
> | Relay for calls: <operator>, if we run one | both IP addresses of a relayed pair, how much you send, and when | only if a direct connection fails | <N days or none> |
> | Pin node: <operator>, if we run one | the files you hand off, your IP address and the infohash; its public status file lists the site, a key, the time, hashes of the items it keeps and how many bytes it sent this month | to keep files available when nobody who has them is online | <N days> |
> | Name service of <name>.nip.io or <name>.sslip.io, only if this site has no domain | the name of this site, from each visitor's resolver | to find our server | set by the service: <link> |

Add these to the other items:

> **5b. Your choice.** On a phone your browser shares what you keep only after you agree, and only while the page is open. "Keep this screen
> on and share for 2 hours" keeps the screen on and shares until you leave the page, unplug the phone, or the time is up. Calls are off unless
> we turned them on; a call starts only when you press the button, and everyone in it sees your IP address once you accept.
>
> **7b. Others can see which files you share.** Anyone connected to a file's swarm can see your IP address and that your browser holds that file.
