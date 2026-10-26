# S3: adoption mechanics for the light web

- **Date:** 2026-10-20. **Status:** research and design proposal for the owner; nothing here is shipped or binding. **Applies to:** magnet-web 0.2.1 plus the v0.3 build in progress. The project is being renamed Lightweb; file and command names below are today's.
- **Question:** which mechanics make the light web something people adopt and keep alive, inside the honesty rules?
- **Method:** read the files named in the brief plus `tools/seed.mjs`, `pin.mjs`, `tracker.mjs` and the research notes cited inline. Fetched primary pages on 2026-10-20 through a summarising tool, so quoted strings are its quotation (Medium); I extracted the FIDO PDF myself (High). "Snippet" means a search-result summary only (Low). No browser was opened at a non-local address.
- **Wording:** the project wording rules are followed, including in negation; no em dashes.
- **Marks on every idea:** `[B]` builds on what exists (named); `[N:S]`, `[N:M]`, `[N:L]` needs new code (S under a week, M one to four weeks, L more: the R5 scale); `[C]` a claim we cannot back yet.
- **Siblings:** S1 (phone seeding) and S2 (zero-setup hosting) are written in parallel; they win on their topics.

## Summary

1. **Growth came from shocks, bundles and one-click starts, and stalled without a reason to return.** Bluesky gained 2.6 million users in the week after X was banned in Brazil [ap-bluesky]; Mastodon fell from 2.5 million monthly active users (December 2022) to under 1.4 million two months later [thurrott]; Brave's built-in IPFS was used by under 0.1% [brave]; Beaker had "no stickiness" [beaker-notice].
2. **Build first what works with no peers online and starts in one click:** a static-site comments template, a clone-and-go start (ZeroNet: "Clone websites in one click" [zeronet-readme]; Bluesky starter packs: up to 43% of follows at peaks [lancaster]) and one wedge with evidence, Beaker's only helped group, "teachers on a LAN".
3. **Defaults decide participation, so reliability needs its own deliberate tier, the keeper.** Of 15.9 million NetSession installs shipped with uploads off, 99.96% never turned them on (w2c-07 summary 1).
4. **Keeper in three forms:** CLI and container first (`[B]` `tools/seed.mjs`, `tools/pin.mjs`; `[N:M]`), Chromium extension second (`[N:M]`), desktop app last (`[N:L]`). Plan for hundreds in year one `[C]`: IPFS Companion has 40,000 Chrome users and Snowflake 90,000 after years. On iOS no supported way was found.
5. **"Every reader is a mirror" is false as a slogan `[C]`:** the repo baseline has about 8 in 100 visits able to serve files (0.3 x 0.35 x 0.8). Say "every consenting desktop reader, while the tab is open"; a meter built from existing counters is `[N:S]`.
6. **Badges do not recruit:** Snowflake's web badge is 0.22% of its proxies (306 of 139,657). Use badges and pledges for measured status, and count only keepers that pass a random-piece probe (`[N:M]`).
7. **Light links:** only a plain https link with the pointer in the fragment works everywhere; `web+lightweb:` registers only in desktop Chromium and Firefox; link previews need the crawler shell (R5 F12).
8. **The hub:** start as a curated static host with a tracker, listed by pull request, with no upload service. Open sign-up waits for the denylist, counsel, a Public Suffix List entry and the identity origin. Glitch ended hosting on 2025-07-08 citing costs and misuse.
9. **Sign-in as the viral loop is a claim we cannot back yet `[C]`:** per-site keys give a site no audience, Persona closed for "low, declining usage", and passkeys are already 36% of sign-ins (FIDO 2026). The loop with a chance runs comments, then members, then a personal site.
10. **Plug-ins by share of sites:** WordPress 39.6%, Astro 0.2%, Hugo 0.1% [w3techs]; Hugo and Astro first (`[N:S]`), WordPress last.
11. **Metrics measure owners, not visitors:** sites live at day 90, owner re-sign rate (the 90-day pointer expiry is a free retention clock), probed keepers, members per site; no visitor telemetry on the ledger (w2b-04 summary 6).
12. **P0:** see Recommendations; first are the release gate, the `lightweb` name and `ship`, `init`, `try`.

## Findings with sources

### F1. What drove installs and what killed retention

Bracketed keys are in Sources; keys like "w1-07 F3" are repo files and findings.

| System | Drove installs or reach | Killed retention or reach | Source |
|---|---|---|---|
| Beaker, 2016 to 2022 | A browser that hosted sites from your computer | "no stickiness"; "didn't solve a problem for people"; slow first paint; users "don't stay consistently online"; "the only demographic that Beaker actually helped was teachers on a LAN"; archived 2022-12-27 | [beaker-notice] |
| ZeroNet, 2015 on | "Clone websites in one click"; password-less BIP32 authorisation; Tor; the copy "Impossible to shut down"; a 2019 emergency copy of 8chan (reach with legal exposure; DarkOwl 2019-08-07, w1-07 F3) | A Python client on 127.0.0.1; creator silent (issue 2749, 2021-04-28); "no reliable spam protection"; last release 2019-09-06 | [zeronet-readme]; w1-07 F1, F3 |
| IPFS Companion and Brave IPFS | Bundling: native `ipfs://` in Brave 1.19 (post of 2021-01-19); the extension in the main stores | Under 0.1% of Brave users used it; removed 2024-08-22 (v1.69.153). Companion today: 40,000 Chrome users, rating 3.9 from 52 ratings; 2,666 Firefox daily users | [brave] [companion-cws] [companion-amo] |
| Nostr | Not established in this survey | Counts depend on the metric: about 144,202 daily active pubkeys (two weeks to December 2025) against 4.96 million publishing users in one week (August 2026, down 22.4%); clients show or download the nsec at sign-up, with no reset | R4 F6 (snippets); R7 section 3 |
| Bluesky | Shocks: +2.6 million in the week after X was banned in Brazil (85% from Brazil); +1 million the week after the US election, 15 million in all (AP, November 2024). Starter packs: over 335,000 in six months, up to 43% of follows at peaks, nearly 20% of all follows June 2024 to January 2025 | Registered is not active: mobile monthly users 10.4 million in June 2026, down 27.2% on the year (Similarweb, secondary) | [lancaster] [ap-bluesky]; R4 F6 |
| Mastodon | The Twitter takeover: 2.5 million monthly active users in December 2022 | Under 1.4 million two months later (little interaction, a "technical challenge" to start, server costs); 750,000 to 1 million by 2026-02-18 (own site: about 785,000). Its response: simpler onboarding, promote smaller servers, creator profiles | [thurrott] [techcrunch-masto] |
| Scuttlebutt | Offline-first appeal | Planetary's team (2023-03-19): "hard for me to recommend it to friends", cores "clunky and it was hard to run them on phones", offline-first "cool, but rarely used". Manyverse's lead stepped away 2024-04-05: "7 years of FOSS donation income is tough" | [planetary] [manyverse] |
| Hypercore, Pear, Keet; Urbit | Corporate backing (Pear Runtime, 2024-02-14, Holepunch, Tether-backed; snippet); a scarce owned identity (Urbit, first user version April 2020) | No Hypercore usage figure found; the field's answer to "nobody online" is the always-on blind peer, a server (w1-07 F6). Urbit: "a few thousand" active users in September 2022 (The Point, via Wikipedia) | [pear-pr] [wikipedia-urbit] |
| PeerTube | A clear job for a community; Framasoft crowdfunding of EUR 53,100 (2018) and EUR 60,000 (2020); 113 instances and 10,000 videos by June 2018; close to 800 instances by 2021 | WebTorrent player removed in 6.0.0 ("the P2P aspect of WebTorrent is not really used", w1-07 F21). SIGCOMM CCR 2025: about 70% hosted in Germany, the USA and France; over 92% of videos stored without redundancy | [wikipedia-peertube] [ccr25] |
| Local-first apps (Obsidian) | A job (notes) on plain files you own; about 1 million users in 2023 (GitHub download counts); paid Sync and Publish (web hosting for notes) fund it | People adopt the app, not the idea; Ink & Switch (April 2019): "not yet advisable" to replace a proven product with experimental local-first tools | [wikipedia-obsidian] [ink-switch] |
| Neocities (free static host) | Free, zero-setup, a clear identity (a GeoCities revival) | Slow, not viral: about 55,000 sites in 2015, over 1 million on 2025-02-10, over 1.76 million on 2026-05-25; free tier 1 GB storage and 200 GB soft bandwidth | [neocities] |
| Snowflake (a cause) | Volunteers run a proxy: extension 90,000 Chrome users, 14,255 Firefox daily users | Web badge: 306 of 139,657 proxy IPs (24 h to 2026-10-17; 0.22%; extension 80,704; w2c-07 summary 7); 459 of 175,155 (window 2024-12-14; 0.26%; extension 66,211) | [snowflake-cws] [snowflake-amo] [snowflake-broker] |
| Persona (sign-in) | Free sign-in for sites | Closed 2016-11-30 for "low, declining usage"; by March 2014 Mozilla judged that without email-provider support sites lacked interest | [lwn-persona] |

### F2. Patterns across the table

1. **A shock brings the wave; a job keeps people.** Build importers and landing pages before the next shock; the job must work with no peers online (CRITIQUE, "What would make it succeed").
2. **Install walls cap reach in the tens of thousands, even with a cause.** Snowflake's Firefox listing dates from 2019-06-26 and Companion's from 2015-03-22 [snowflake-amo] [companion-amo]; both are small after 7 and 11 years.
3. **Cold start is solved by curation, not protocol** (starter packs, ZeroNet's clone button); Mastodon's server choice taxed every newcomer.
4. **"Nobody is online" killed Beaker and ZeroNet.** The fix everywhere is an always-on tier; for Lightweb that is keepers and hub pins, called what they are.
5. **Free hosting run by a project ends** (Glitch 2025-07-08 [glitch]; Fleek Hosting 2026-01-31, w1-07; IPFS public gateways 2026-09-21, CRITIQUE).
6. **People run out first:** ZeroNet and Manyverse lost maintainers; PeerTube had an NGO, Obsidian paid services.
7. **Federation concentrates:** over half of PeerTube instances sit on 7 networks [ccr25]; Mastodon now promotes small servers. A project-run hub will be most of the early web; say so.

### F3. What browsers and operating systems forbid or limit

| Item | Rule | Source |
|---|---|---|
| Hidden desktop tab | Chrome Memory Saver "deactivates tabs that you aren't currently using". Chromium exempts data-channel pages from intensive timer throttling | [chrome-memsaver]; w1-08 table (hidden tab row) |
| iOS | A hidden page loses the network within seconds; UIKit gives "five seconds" before suspension. No supported way found to keep a swarm running in the background | w1-08 F-07 |
| Android | `dataSync` foreground services run 6 hours in 24 for apps targeting Android 15 or higher; after that the app must be brought to the foreground | [android-fgs] |
| Safari storage | Script-writable storage (IndexedDB, Service Worker registrations and cache) is deleted after seven days of Safari use without interaction; Home Screen web apps keep their own counter | [webkit-itp] |
| Peers | In a browser, WebTorrent "can only download torrents that are seeded by a WebRTC-capable torrent client"; a keeper needs `node-datachannel` (present in `node_modules`, used by `tools/seed.mjs`) | [webtorrent-faq] |
| Extensions | Chromium: an offscreen document with reason `WEB_RTC` has no lifetime limit (only `AUDIO_PLAYBACK` closes after 30 s without audio), one per extension; data channels are not named on that page `[C]`. Firefox: MV3 allows only non-persistent background scripts that "unload after a few seconds of inactivity"; MV2 persistent pages stay supported "for the foreseeable future" with 12 months notice | [chrome-offscreen] [mdn-bg] [mozilla-mv2] |
| Protocol handlers | `registerProtocolHandler` works in desktop Chromium and Firefox (not Firefox private windows); absent in Safari, in Chromium on Android and in iOS browsers on WebKit; a silent no-op on Firefox Android. `magnet` is safelisted; other names need `web+` | w1-09 VERIFY claim 6 (2026-10-17) |

## Design options with costs

### 2.1 The desktop keeper

**What.** ROADMAP lists an always-on native seeder under "Later"; this pulls it forward. A program that holds complete copies of sites the person chose, checks each against its signed pointer and serves it to browsers over WebRTC while the computer is on. It never signs, never holds an owner key and keeps only listed sites. Keeping makes the person the site's host (DEPLOY, pin node) and shows their IP address to the people who fetch it, which the owner accepts as the premise of the light web.

**What it can do that a tab cannot.**

| A tab | A keeper |
|---|---|
| Hidden tabs are deactivated or suspended (F3) | Runs with no tab open |
| 40 wires across all swarms on desktop, 8 on phones (`policy.js`); site cap 128 MiB, storage budget 512 MiB with LRU eviction (ARCHITECTURE 8) | Many sites; disk, not browser quota |
| Safari may delete the copy after 7 days (F3) | Files on disk |
| Cannot accept TCP or UDP peers (F3) | On a public IP it is an "easy peer" for visitors whose NAT blocks others (`deploy/pin/README.md`) |
| Battery and network APIs are Chromium-only (w1-08 R-11) | Reads power and network state from the OS |
| Nothing writes the ledger snapshot unattended | Snapshot on a timer, upload, heartbeat |

It cannot hide an IP address, run while the computer sleeps or, as far as found, run on iOS; on Android a `dataSync` service is capped (F3). Default stance: WebRTC only, the site's own trackers, no DHT, no ordinary BitTorrent peers (the owner decides whether that ever changes; it would expose the IP address beyond the site's swarm).

| Form | Builds on | New code | Effort | Limits |
|---|---|---|---|---|
| K1 CLI and container: `keep add <link>`, `keep run` | `[B]` `tools/seed.mjs`, `tools/pin.mjs`, `deploy/pin`, `src/chain` (transport-agnostic) | `tools/keep.mjs`: fetch by pointer with `TorrentManager` on Node deps, disk chunk store, Node ledger store, keep list, caps (bytes a month, hours, AC power), `status.json`, signed heartbeat, random-piece probe responder | `[N:M]` | Owners, homelab, VPS, NAS. A multi-profile wrapper over `pin.mjs` is `[N:S]` but needs Chromium per site |
| K2 Chromium extension | `[B]` loader engine; K1 heartbeat and probe | Seed-only engine mode with no Service Worker and no render (one engine per origin, ARCHITECTURE 5.9, rules out running many sites as sites inside the extension origin); keep list UI | `[N:M]` | Chrome, Edge, Brave; only while the browser runs. Firefox needs an MV2 persistent page |
| K3 Desktop app | `[B]` K1 | Packaging, signing, start at login, tray UI, optional OS `lightweb:` handler, auto-update (a supply-chain risk) | `[N:L]` | Install friction is Beaker's wall. Apple distribution is a benefit of the $99 annual membership [apple-dev]. Build only if K1 and K2 show demand |

**Expected size `[C]`.** Plan for hundreds of keepers in year one (chosen, not a forecast); comparables are in F1.

**Keeper pods `[B]` K1 `[N:S]` docs.** Five owners each run K1 for all five sites. If each keeper is online a fraction p of the day, independently, at least one is online with probability 1 - (1 - p)^n: p = 1/3 gives 33% (n = 1), 70% (n = 3), 87% (n = 5). Keepers in one time zone sleep together, so these are ceilings.

### 2.2 Every reader is a mirror, in the page and on the owner's dashboard

**The wording.** Say "every consenting desktop reader can help carry this site while the tab is open". The baseline puts the share of visits that can serve files at 0.3 x 0.35 x 0.8 = 0.084 (consent, upload policy, connection; judge-scale-and-economics 2.4; consent 0.3 is a planning figure, CRITIQUE), and median dwell may be 21.6 s against a 60 s mean (model, w2c-07 summary 10). The unqualified slogan is `[C]`.

**In the page `[B]` `[N:S]`.** The loader already says "Sharing with other visitors" and "From other visitors / From the host" and counts peers (`strings.js`; `progress.peerBytes`, `webseedBytes`, `uploaded`). Add one line after load: "This visit: 62% of the bytes came from 3 visitors, 38% from the host. 7 visitors are connected (tracker report, 14:02)." Two labelled sources: peers connected to this tab (local truth) and the tracker's complete plus incomplete count (anyone can announce, so it is a report, not proof). Phones read "Sharing only while this page is open and on screen". One thanks message at most; no streaks, rankings or guilt copy (w2c-07 summary 12; ARCHITECTURE 8).

**On the owner's dashboard `[B]` `[N:M]`.** `lightweb status <url>` composes what exists: tracker seeders and leechers (`check-site`), pointer days left, snapshot age and, once K1 ships, keeper heartbeats. It prints a table and can write a signed `status.json` (the owner-signed `_health` aggregate, w2b-04 F44) to the host. No visitor reports leave the page; the peer-delivered share stays local unless the owner adds an opt-in k-thresholded endpoint, which is the owner's own backend and is labelled as such (w2b-04 summary 8).

### 2.3 Light links, the protocol handler and the file

| Layer | Form | Works where | Mark |
|---|---|---|---|
| L1 | `https://<host>/#<pointer>`; for a site on its own domain the site URL is the link; QR in Settings (V03 3.4) | Every browser | `[B]` |
| L2 | `web+lightweb:<pointer>` via `registerProtocolHandler` from the loader origin | Desktop Chromium and Firefox only, after a prompt (F3). Never the only path | `[N:S]` |
| L3 | OS-level `lightweb:` registered by the keeper app | Desktops with K3 | `[N:L]` |
| L4 | "Light Drop": a single `.lightweb` file (torrent plus pointer) opened by file picker or drop; verified against the pointer, then seeded. For USB, email and classrooms | Any browser with the loader | `[B]` ROADMAP "single-file bundle mode"; `[N:M]` |

Do not register `magnet:` from a web page: it would offer to take over every torrent link (ROADMAP lists it only for installed desktop Chromium apps). Shell mode shows crawlers and link previews the loader (CRITIQUE), so a shared link has no title or image until the crawler shell exists (R5 F12, `[N:M]`).

### 2.4 Badges and "keep this site alive" pledges, with measured counts

Snowflake's web badge is 0.22% to 0.26% of its proxies against an extension that is 144 to 264 times larger (F1), so a badge is a status display, not a recruiter. Its honest job is a measured number and a link to "Keep this site".

| Idea | What is measured | Mark |
|---|---|---|
| B0 static "Carried by Lightweb" image | Nothing; it states what the site is | `[B]` README badge pattern; `[N:S]` |
| B1 live badge from the drop-in | This visit only: peers connected and bytes by source (2.2) | `[B]` `[N:S]` |
| B2 signed status badge | The owner's cron writes `status.json` with seeders, leechers, verified keepers and a time, signed by the owner or pin key; the badge verifies it and shows "as reported by the owner at 14:02" | `[B]` `check-site`; `[N:M]` |
| P1 owner-approved keepers | The owner lists keeper keys; the owner's probe asks each for K random pieces (for example 4 x 256 KiB a day) and checks them against the torrent's SHA-1 hashes; the count is "keepers that passed in the last 48 hours" | `[B]` `check-webseed` logic; `[N:M]` |
| P2 open pledges | A keeper signs a heartbeat appended to a ledger list, paying the usual fee. Without the probe this is a claim, not a measurement | `[N:M]`; `[C]` as a count |

Rules that keep this inside ARCHITECTURE 8: counts are of keys, never people (SYB A13, V03 2.17.1); no per-keeper ranking, credits or public uptime of strangers; only aggregates and the owner's own keepers are shown. A public per-keeper display would break "no API that reports one visitor's contribution to anyone else" and needs an RFC (GOVERNANCE).

### 2.5 One-command publish and templates

**Order of templates, by evidence.** (1) **Comments for static sites `[B]` `[N:S]`** need no peers (CRITIQUE). The incumbent giscus (12.2k stars) makes every commenter authorise a GitHub app [giscus]; Lightweb asks for a tap and a key. `<mw-comments>` wraps the CRUD.md guestbook recipe and `<mw-signin>`; `lightweb add comments ./site` injects the drop-in tag and sets the policy. Limits: public text; phone spam-fee time unmeasured (G20); new comments reach readers only through a holder or the `cs=` snapshot (R5 F2). (2) **Forum `[N:M]`:** boards, threads, moderators, optional chat panel (a High-fit audience, DIFFERENTIATORS 4). (3) **Social showcase** `examples/social` `[B]`, as a template `[N:L]`, only after the hub gates in 2.6 (ceilings: V03 3.6).

**Publish.** The CLI has no `ship`, `init` or `try` yet; build them as R7 5.1 to 5.3 (`[N:M]` each; `try` is `[N:L]` with packaging). The npm names `lightweb` and `magnet-web` both returned 404 on 2026-10-20 [npm-404]: reserve one now (`[N:S]`).

**Classroom room `[B]` `demo --tls`, `tracker.mjs`; `[N:M]`.** `lightweb room ./lesson` runs a tracker and the site on the LAN and prints a QR code; each student browser joins the swarm. It is the one wedge with a first-hand success report (Beaker). Limits: phones need HTTPS (S2 owns it, including `<ip>.nip.io` names: per-hostname certificates, no wildcard [nip-io]; the pointer is signed per hostname, so an IP-named address changes with the IP: a trial rung, not a home); Chrome's Local Network Access may prompt (R5 F18); unmeasured `[C]`.

### 2.6 The hub as the first home

**H1 `[B]` `[N:M]`: a curated static host with a tracker.** Apex serves the loader; each listed site is `<label>.hub.<domain>` or its own domain; listing is a pull request with `pointer.txt`, `ct=` contact and the size report; CI runs `check-site`, `check-webseed` and the publish lint, then deploys static files; `tools/tracker.mjs --allow` is generated from the repo. No upload endpoint, no accounts. Start as **H1a**, the project's own showcase sites (`[N:S]`, plus domain and wildcard TLS); **H1b** takes outside sites after counsel, because a curated list is a directory (ROADMAP "Not planned").

**Gates before any outside site:** edge rule for 32-character labels, a Public Suffix List entry, the v0.3 `_deny/` denylist and takedown path, an abuse contact and program, a hub data-processing template (R6 recommendation 10). ROADMAP: "A hub without these is a phishing host." **H2** (open sign-up, personal sites, `examples/social`) is `[N:L]` and waits for the identity origin.

**The honest statement.** "This hub is a static host with a tracker. It serves the loader and the files of the sites it lists, and it introduces visitors of the same site to each other. It does not hold your identity or your posts. If it went away, sites on their own domains would keep loading, and visitors who already hold a hub site could still open their own copy."

**Cost (judge-scale-and-economics 2.7).** Loader and shell about $2.40 per million cold visits (Workers Paid) to about $21 (CloudFront); tracker $0 (Oracle A1) to about $65 a month at 20,000 sockets; R2 pins $0.015 per GB-month, about $1,610 a month for 100,000 members at 1 GiB (arithmetic).

### 2.7 Sign-in anywhere as the viral loop

Verdict `[C]`. Per-site keys are the default (V03 2.3.5), so a member brings no audience, and a site can already offer passkeys itself: 36% of successful sign-ins (average of 12 reporting Index participants), 93% success against 78% for passwords and traditional MFA [fido-2026]. Persona shows the failure shape: without providers and members, sites saw no reason to add it [lwn-persona]. What is true: the widget adds sign-in with no password table and no identity vendor, and the same key signs the member's ledger items (`[B]` `src/widget/signin.js`, `packages/verify`). The loop that can work: comments, then members with a root, then one-tap sign-in on the next site. Test it with a lab panel of 20 or more (members who sign in on two sites within 30 days): the identity origin keeps its site list local by design (V03 2.3.5). Copy and docs `[N:S]`.

### 2.8 Plug-ins

| Target | Share of sites [w3techs] | Shape | Effort |
|---|---|---|---|
| Hugo | 0.1% | Module with a comments partial and a `lightweb ship public/` CI step; builds on `docs/recipes/hugo.md` | `[B]` `[N:S]` |
| Astro | 0.2% | Integration: `injectScript` in `astro:config:setup`; `astro:build:done` gives `dir` to ship [astro-ref]; builds on the recipe | `[B]` `[N:S]` |
| WordPress | 39.6% | Plugin that outputs the widget and hooks a Simply Static export; never stores the owner key. Directory rules [wp-guidelines]: GPL-compatible licence (MIT is), scripts shipped locally (guideline 8), no contact with external servers without explicit consent (guideline 7), which the consent card must satisfy. | `[B]` `--from-wxr`; `[N:M]` to `[N:L]` with review and support |

WordPress is where the sites are and the poorest fit: its owners use dynamic features a static export removes. Lead with the 32.1% of sites with no CMS.

### 2.9 Readiness for shocks, and site packs

**Be the lifeboat `[B]` `docs/recipes/`, MIGRATION.md, `--from-wxr`; `[N:S]` per page.** One page for each ended service, written before the next one: Glitch (hosting ended 2025-07-08), Fleek Hosting (2026-01-31), IPFS public gateways (2026-09-21), Supabase free projects (pause after one week idle, R1 3.13). Each says what to export and gives five commands to a static host with comments. The waves in F1 followed events, not products.

**Site packs `[N:S]` to `[N:M]`; effect `[C]`.** A signed list of up to 20 pointers shared as a light link; opening it shows each site's title, size and owner key and asks "Keep these 12?" before anything is fetched. Bluesky's evidence concerns following people, not keeping sites. The project publishes packs of its own showcase sites only until counsel reviews (ROADMAP: directory).

### 2.10 The why copy that converts

Root sentence, unchanged from DIFFERENTIATORS-AND-WHY 3.1: "Keep your site a folder of static files and still give it comments, a guestbook or members, without running or renting a backend and without handing your readers to a vendor." Each line carries its price in the same breath (3.2).

| For | Line |
|---|---|
| Static-site owner | "Add comments to a static site with no database, no vendor and no GitHub account for your readers. Visitors' browsers keep and check a signed log. What they write is public, and your host stays in the loop." |
| Community | "A board for your club or class that you moderate with one key. Posts live in members' browsers and in your pin node." |
| Keeper | "Keep the sites you read available while your computer is on. Keeping makes you their host and shows your IP address to the people who fetch them." |
| Page meter | "While this page is open this browser helps carry it. 3 other visitors are connected." |
| Teacher | "Run a lesson from your laptop. Students scan a code and their browsers share it. It works on the classroom network." |
| Developer | "Sign-in for your site with no password table and no identity vendor: your server checks a signature." |

Conversion is `[C]` until tested: a five-person comprehension test (can they say what it is and what it costs; R4 open question 4), then two landing URLs on a static host read from host logs only, comparing the comments line against "cheaper hosting", which is false for small sites (R4 F3). Never use the banned words, "private" without its exposure sentence, or the unqualified mirror slogan.

### 2.11 Metrics that would prove the web is growing

No visitor telemetry on the ledger (w2b-04 summary 6) and no vanity counts (registered accounts, stars, tracker peer counts anyone can inflate). Thresholds are chosen, not sourced.

| Metric | How, without a backend | Day-180 gate |
|---|---|---|
| M1 Sites live 90 days or more | Weekly `check-site` from outside, over hub-listed and opted-in sites | 10 independent sites |
| M2 Owner re-sign rate | The probe sees `seq` and `exp` change; the 90-day expiry is the clock | At least half re-sign before expiry |
| M3 Time to first live site | Moderated trials (n >= 8); `ship` prints elapsed time locally and sends nothing | Median 15 min with a host and domain; 5 min on `try` |
| M4 Verified keepers | Keeper keys that passed a random-piece probe in 48 h (2.4) | 5 outside the project |
| M5 Members per site | Distinct keys with a signed item in 30 days, public lists only; keys, not people | One site with 20 |
| M6 Peer-delivered bytes, consent rate | Owner opt-in aggregates with k >= 20 (w2b-04 F17), or lab; replaces the 0.30 planning figure and the offload model | Report what is measured |
| M7 Sign-in popups per day | Static-host logs at the identity origin, daily counts, no IPs kept | Trend only |
| M8 Independent detection | A `meta` fingerprint for `mw-pointer` in the Wappalyzer-continuation repo [enthec]; ingestion by HTTP Archive or W3Techs not verified `[C]` | Trend only |

M1 to M3 are `[B]` `check-site` plus `[N:S]` schedule; M4 `[N:M]`; M5 to M7 `[N:S]`. The web is "growing" only if M1, M2, M4 and M5 pass together at day 180; otherwise report which failed.

## Recommendations P0 to P3

Effort: S under a week, M one to four weeks, L more.

| Pri | Item | Effort | Mark |
|---|---|---|---|
| P0 | Run the release gate first pass (R5 F1: G2, G4, G6, G11, G16, G20, G22) and publish failures too; no adoption claim before it | M | `[B]` |
| P0 | Reserve `lightweb` on npm and the hub and identity domains (2.5) | S | `[B]` |
| P0 | `ship`, `init`, `try` (R7 5.1 to 5.3) | M; `try` L | `[N]` |
| P0 | `<mw-comments>` and `add comments` (2.5) | S to M | `[N:S]` |
| P0 | Mirror meter with labelled sources; the qualified slogan in docs and UI (2.2) | S | `[N:S]` |
| P0 | Keeper K1 with signed heartbeat and random-piece probe (2.1, 2.4) | M | `[N:M]` |
| P0 | Classroom room kit, after S2's TLS answer (2.5) | M | `[N:M]` |
| P0 | The why page and the five-person comprehension test (2.10) | S | `[N:S]` |
| P1 | Hub H1a showcase (2.6); H1b only after denylist, PSL entry, abuse program and counsel | S; M | `[N]` |
| P1 | Owner `status` with signed `status.json` (2.2); probe schedule for M1 to M3 (2.11) | M; S | `[N]` |
| P1 | Hugo and Astro plug-ins (2.8); lifeboat pages for ended services (2.9) | S each | `[N:S]` |
| P1 | Crawler shell for link previews (R5 F12); light links L1 and L2 (2.3) | M; S | `[N]` |
| P1 | Keeper K2, the Chromium extension (2.1) | M | `[N:M]` |
| P2 | Forum template; site packs; Light Drop; badges B1, B2; owner-approved pledges; keeper pods guide; sign-in lab panel; detection fingerprint; WordPress plug-in (2.1 to 2.9, 2.11) | M each; S for guides | `[N]` |
| P3 | Desktop app K3 and OS handler (2.1, 2.3); open hub H2 and social template (2.6); open pledges P2 (2.4) | L | `[N:L]` `[C]` |

For all of them: no tokens, points, rankings or public per-keeper uptime; keepers and hub pins named as hosts; no unqualified mirror slogan; no visitor telemetry on the ledger; no hidden seeding.

## Open questions

1. Who are the first ten sites, and from which wedge (comments, classroom, event files)?
2. Will the project run a hub: legal entity, counsel, budget? H1a needs a domain and wildcard TLS; H1b needs counsel.
3. Does a count of probed keepers stay inside ARCHITECTURE 8 and the GOVERNANCE RFC rule?
4. Is a WebRTC keeper extension acceptable under Chrome Web Store policy, and do data channels survive days in an offscreen document? A lab row.
5. Can sign-in be a growth loop with per-site keys, or only with hub-scoped identity (V03 3.1)? The lab panel decides.
6. Would HTTP Archive or W3Techs ingest a Lightweb fingerprint, and is public detection wanted? Is the name cleared beyond npm?

Not verified here: Urbit and Keet usage; Pear's press release and the AP Bluesky figures (search text only; the AP page returned 403).

## Sources

All fetched 2026-10-20 unless dated; every URL begins https://.

- [beaker-notice] raw.githubusercontent.com/beakerbrowser/beaker/master/archive-notice.md
- [brave] brave.com/ipfs-support/
- [companion-cws] chromewebstore.google.com/detail/ipfs-companion/nibjojkomfdiaoajekhjakgkdhaomnch ; [companion-amo] addons.mozilla.org/api/v5/addons/addon/ipfs-companion/
- [snowflake-cws] chromewebstore.google.com/detail/snowflake/mafpmfcccpbjnhfhjnllmmalhifmlcie ; [snowflake-amo] addons.mozilla.org/api/v5/addons/addon/torproject-snowflake/ ; [snowflake-broker] snowflake-broker.torproject.net/metrics (window 2024-12-14)
- [zeronet-readme] raw.githubusercontent.com/HelloZeroNet/ZeroNet/py3/README.md
- [lancaster] lancaster.ac.uk/news/starter-packs-have-played-a-central-role-in-blueskys-rapid-growth-new-study-shows (2025-06-24; paper: ojs.aaai.org/index.php/ICWSM/article/view/35810)
- [ap-bluesky] wabe.org/bluesky-has-added-1-million-users-since-the-us-election-as-people-seek-alternatives-to-x/ (AP; search text only)
- [thurrott] thurrott.com/cloud/social/279094/mastodon-continues-to-lose-users (2023-02-07) ; [techcrunch-masto] techcrunch.com/2026/02/18/mastodon-a-decentralized-alternative-to-x-plans-to-target-creators-with-new-features/
- [planetary] relay.nos.social/blog/pivoting-from-ssb-to-nostr (2023-03-19) ; [manyverse] manyver.se/blog/2024-04-05 ; [pear-pr] aap.com.au/aapreleases/cision20240214ae36435/ (search text only)
- [wikipedia-urbit], [wikipedia-peertube], [wikipedia-obsidian], [neocities]: en.wikipedia.org/wiki/Urbit, /PeerTube, /Obsidian_(software), /Neocities ; [ccr25] aqualab.cs.northwestern.edu/publication/2025/mpolinksi-ccr25 ; [ink-switch] inkandswitch.com/essay/local-first/
- [glitch] alternativeto.net/news/2025/5/glitch-to-shut-down-web-app-hosting-by-july-2025-introduces-project-url-redirects/ (2025-05-24) ; [lwn-persona] lwn.net/Articles/670733/ (2016-01-13)
- [fido-2026] fidoalliance.org/wp-content/uploads/2026/10/Passkey-Index-October-2026.pdf (results compiled 2026-09-21)
- [giscus] github.com/giscus/giscus ; [w3techs] w3techs.com/technologies/overview/content_management (survey 2026-10-20) ; [wp-guidelines] developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/ ; [astro-ref] docs.astro.build/en/reference/integrations-reference/ ; [enthec] github.com/enthec/webappanalyzer
- [chrome-offscreen] developer.chrome.com/docs/extensions/reference/api/offscreen ; [mdn-bg] developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts ; [mozilla-mv2] blog.mozilla.org/addons/2024/03/13/manifest-v3-manifest-v2-march-2024-update/
- [android-fgs] developer.android.com/develop/background-work/services/fg-service-timeout ; [chrome-memsaver] support.google.com/chrome/answer/12929150 ; [webkit-itp] webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ (2020-03-24) ; [webtorrent-faq] webtorrent.io/faq
- [nip-io] nip.io/ ; [npm-404] registry.npmjs.org/lightweb and /magnet-web (both 404) ; [apple-dev] developer.apple.com/programs/
