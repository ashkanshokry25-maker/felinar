<p align="center">
  <img src="docs/assets/logo.svg" width="112" height="112" alt="felinar logo: a horseshoe magnet holding a globe">
</p>

<h1 align="center">felinar</h1>

<p align="center"><strong>felinar: websites loaded by magnet link, verified in your browser, from a plain static host. No backend. The light web.</strong></p>

<p align="center">
  <a href="https://github.com/ashkanshokry25-maker/felinar/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/ashkanshokry25-maker/felinar/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://www.npmjs.com/package/felinar"><img alt="npm version" src="https://img.shields.io/npm/v/felinar.svg"></a>
</p>

No backend means there's no application server or database for you to run. You still need an HTTPS static
host, which serves the loader on every visit and keeps the site loading when nobody else is online. Visitors
find each other through WebSocket trackers and STUN servers, public ones or your own. If you publish the
pointer in DNS, a DNS-over-HTTPS service reads it for the browser, and once a visitor chooses to share, a shell page
asks a DNS-over-HTTPS service for a newer pointer whether or not you publish one.

Shared data lives in the **site ledger**: a signed, hash-linked log that every visitor copies and verifies.
No mining, no consensus, no finality.

**Status: 0.3.0, a pre-release.** Every automated suite passes on one development machine, but the release gate
on real phones and browsers has not run. Read [what it is not](#what-it-is-not) before you rely on it. No lawyer has reviewed the
privacy and legal texts: in place of a lawyer's review, AI research agents checked them against the code and against
published law and regulator guidance (2026-10-24). That is research, not legal advice ([docs/PRIVACY.md](docs/PRIVACY.md),
"About this text").

## Why

| What you get | The condition attached |
|---|---|
| **Hosting that costs next to nothing.** The site stays a folder of files on GitHub Pages, Cloudflare Pages, Netlify or a bucket behind a CDN. | Peers carry a real share of the bytes only for large sites with many visitors online at once: a site under about 16 MiB gets about 0% of its first-load bytes from peers (a model, not a measurement: [the economics](docs/WHY.md#honest-economics)). Choose it for resilience, not to cut a small site's bill. |
| **Shared data without a backend.** Guestbooks, comments, notices and visitor names through `mw.db`, moderated with your keys. | Everything written is public, there's no finality, and new entries spread only while someone with a copy is online. A snapshot on your host (`cs=`) or a pin node keeps the ledger loadable. |
| **Your domain and your key stay in charge.** The site is named by its infohash, every piece is checked, and the pointer is signed with an owner key that never enters a browser (the exception is a personal page on a hub, whose owner key is the person's working key in their browser). | Your HTTPS host and your DNS stay the trust root on every visit: whoever controls them controls what visitors run. |
| **Existing sites switch with one script tag.** In drop-in mode your HTML, URLs, redirects and search results stay on your host, and a failed runtime leaves the pages as they were. | New visitors still need the host, and filling each visitor's copy can multiply host egress (in a model, a 20 MB copy completed after a 1.5 MB page view costs 13.3 times that view); `publish --dropin` prints the copy size for your site. |
| **Returning visitors keep working when the host is down.** In shell mode the Service Worker serves a verified copy at the site's own URLs, online or offline. | Only for visitors who loaded the site before and still hold the copy (Safari may clear it after 7 days without a visit). Crawlers see the loader, not your content. |
| **The site loads when nobody else is online.** Your host doubles as the web seed. | A shell site's pointer needs `ws=` and `xs=` (`publish --ws` adds both); without them it loads only while another visitor is online. Drop-in pages come from your host anyway. |
| **No tracking added by the loader.** The loader has no analytics, no telemetry and no third-party scripts, and nothing connects to a peer, tracker, STUN server or DNS-over-HTTPS service before the visitor's choice in the first-run card (on a site found only through DNS, either choice allows the DNS-over-HTTPS lookup, and the card says so). | Your host still sees each visitor's IP address, as any web host does, and "Load from host only" sits right next to "Share and load". Once a visitor shares, other visitors and the connection servers see their IP address and that they're viewing your site. |

The long case, with every number and its source: [docs/WHY.md](docs/WHY.md).

## What it is not

Twelve plain statements; the long versions are in [docs/CRITIQUE.md](docs/CRITIQUE.md) and
[docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

1. **It still needs a host.** There's no backend for you to run, but every visit downloads a small loader from
   your HTTPS host, and a DNS record can't replace that host. Trackers and STUN servers, public or your own,
   introduce visitors to each other.
2. **Your host is the trust root.** A first visit trusts your HTTPS host and your DNS. Later visits also check the
   remembered site key. Peer-to-peer delivery protects the site's files from tampering by other visitors, not by
   your host.
3. **Only WebRTC peers share.** BitTorrent clients that don't speak WebRTC can't seed your site to visitors. The
   swarm is your visitors, your web seed and, if you run them, a pin node (`tools/pin.mjs`) or a Node seeder
   (`tools/seed.mjs`, with `node-datachannel` installed).
4. **Sharing lasts while the page is open.** Phones load the site and sync the ledger while the page is open and
   on screen. iOS stops peer connections within seconds of switching apps or locking the screen, and Android can
   do the same. On phones, sharing is off until the visitor turns it on.
5. **It isn't a cryptocurrency chain.** There's no proof-of-work consensus; the small proof-of-work on each post
   is a spam fee, not security. There's no finality: an entry that arrives late can change what 'latest' means.
   Nothing is available while nobody with a copy is online, so the snapshot on your host and a pinned node are
   the floor. There's no anonymity: peers see each other's IP addresses.
6. **Everything written is public.** Everything written with mw.db is public and copied to every visitor.
   Deleting an entry hides it for visitors who receive the deletion. Copies on devices that never sync again stay
   where they are.
7. **There's no private mode.** Peers, trackers and STUN servers see each visitor's IP address, and anyone who
   knows the site's infohash can see who's online. The loader says so and asks first. While the page is open,
   visitors pass on your site's files and its posts. To remove files, publish a new version; visitors drop the old
   one on their next load. To remove a post, delete it; visitors honour that when they receive it.
8. **There are no relay (TURN) servers for the site.** Some visitors, often on mobile data, can't reach peers and
   load from your host instead. Only a call can go through a relay, and only one that you set up yourself.
9. **DNS-over-HTTPS involves a third party.** The default pointer, a `<meta>` tag in the loader page, loads the
   site without a lookup. But once a visitor chooses "Share and load", a shell page on a public hostname asks a
   DNS-over-HTTPS service (Cloudflare first, then dns.sb or Google) for a newer pointer, whether or not you
   publish one in DNS: right after the choice (on later visits, after the site renders), then every 5 minutes
   or the record's TTL while the page is open, and at most once a minute when the tab gets the focus back. That
   service sees the site's name and the visitor's IP address, and the first-run card names it. "Load from host
   only" makes no lookup on a site with a page tag; on a site found only through DNS, either load button makes
   the lookup and the page keeps checking. Drop-in pages never query DNS. A site needs no domain of its own: its key
   is its address, and its light link opens it at any door; a guest door gives a limited view with an identity for that visit
   only, and a door kit needs the pinned release key ([docs/DEPLOY.md](docs/DEPLOY.md#doors-without-a-domain)).
10. **Browser storage is a cache, not a backup.** Safari may delete the site's local copy after 7 days without a visit,
    and the identity page's data after 7 days without a visit there. The identity lives at the identity page, so
    adding the site to the Home Screen is not a way to keep it: a passkey identity comes back from a site's sealed copy, a
    passphrase identity only from the 12 words or the backup file.
11. **Open writing invites spam.** With open writing, every visitor stores and passes on posts by strangers. You
    moderate what your site makes visitors redistribute: writer policy, allow lists, moderators, bans and the
    posting fee are your tools.
12. **Full mode needs HTTPS, the root of a domain and a Service Worker.** On plain HTTP or under a sub-path the
    loader stops with a message. Without a Service Worker (Lockdown Mode, in-app browsers) it renders the site in
    limited mode: no offline copy, and the site's own scripts can't fetch its files by relative URL.

### Why the site ledger has no mining or global agreement

Because a website doesn't need them, and a browser can't provide them. The site ledger is
hash-linked and signed, so it has the familiar shape, but it deliberately has no global agreement, no finality,
no ordering that resists fake identities and no availability while nobody with a copy is online
([design review, 4.1](docs/review/DESIGN-REVIEW.md)). Proof-of-work in a browser secures nothing: one RTX 4090
hashes about 1,650 times faster than a browser using five workers on an M3 laptop
([research digest](docs/research/RESEARCH-DIGEST.md), verdict 8). A site needs less: entries nobody can forge,
one order that every visitor computes the same way, and an owner who can moderate. The ledger does exactly that.

## Try it in 90 seconds

You need Node 22 or newer and git. Run everything from the root of your clone: there, `npx felinar <command>`
runs this clone's `bin/felinar.mjs`; outside a clone it runs the `felinar` package from npm.

```sh
git clone https://github.com/ashkanshokry25-maker/felinar.git
cd felinar
npm ci
npx felinar demo
```

The demo builds the loader and the identity page, publishes the example guestbook for `localhost`, starts a tracker,
a dev server and the identity page (`http://localhost:8081/`), seeds from a headless browser (after
`npx playwright install chromium`; without it the site loads from the local web seed) and prints
`http://localhost:8080/`. Open it in two different browsers (or two browser profiles: the windows of one profile are
one visitor), choose "Share and load" in both, and sign the guestbook in one: the post opens the identity page in a
window, where you create an identity or choose "For this visit only", and the entry appears in the other browser,
both showing the same ledger line. For phones on your network, run `npx felinar demo --tls` (it needs mkcert; the
demo prints the steps); that tier serves no identity page, so phones there read and share, and post through the
desktop tier over USB.

To publish the same guestbook for your own domain:

```sh
npx felinar keygen --out owner.jwk
npx felinar build
npx felinar publish examples/peer-guestbook --name peer-guestbook --scope example.com \
  --key owner.jwk --policy open --bits 16 --ws https://example.com/ws/ --tr public \
  --shell --out dist-publish
```

Visitors sign in before they post, at an identity page the site names with `--idp https://<identity origin>`. By
design, the project hosts no identity page: run your own ([DEPLOY.md](docs/DEPLOY.md#the-identity-origin-running-your-own-with-toolsbuild-idpmjs))
or use one you trust, and add the flag, or nobody can sign the guestbook. No domain? The site lives at its key, and
domains are doors: add `--chain peer-guestbook --door <host>` (any host that serves the loader, such as your
`<user>.github.io`, a friend's host or a door on your own computer) and hand out the light link that publish writes to
`dist-publish/link.txt`, or its QR code ([DEPLOY.md](docs/DEPLOY.md#doors-without-a-domain)); at a guest door a visitor gets a limited view and an identity for that visit only. `owner.jwk` is your site key: keep it offline (`*.jwk` is in `.gitignore`). `dist-publish/shell/` goes at the
root of your host and the web seed (`peer-guestbook/` and `peer-guestbook.torrent`) under `/ws/`. `publish` prints
a warning for every decision still open, such as the missing snapshot URL (`--cs`) and abuse contact (`--ct`).
[docs/QUICKSTART.md](docs/QUICKSTART.md) takes it from there to a live site.

## How it works

<p align="center">
  <img src="docs/assets/architecture.svg" width="900" alt="Diagram of a first visit in six steps. 1: the browser downloads the loader from your static HTTPS host. 2: the loader checks the signed pointer, from a page tag or optionally a DNS record read over DNS-over-HTTPS, and the remembered site key. 3: it downloads pieces from the host's web seed and, after the visitor agrees, from other visitors over WebRTC, introduced by WebSocket trackers and STUN servers; every piece is checked. 4: the verified copy and the ledger entries are stored in IndexedDB. 5: the Service Worker serves the copy at the site's own URLs to the unchanged site. 6: the site reads and writes the site ledger through mw.db.">
</p>

1. **Loader.** Every visit gets a small loader from your HTTPS host (in drop-in mode, one script tag on your pages).
2. **Pointer.** The loader checks the site's signed pointer, from a `<meta>` tag or a `_magnet` TXT record, and the
   key remembered on the first visit. The pointer names the torrent, the web seed and the trackers, and it expires
   after 90 days by default.
3. **Pieces.** They come from your host's web seed and, after the visitor agrees, from other visitors over WebRTC.
   Every piece is checked against the infohash before it is used or passed on.
4. **Serve.** The verified copy goes into IndexedDB, and the Service Worker answers the site's own URLs from it,
   so links, `fetch('/data.json')` and History-API routers work unchanged.
5. **Ledger.** `mw.db` entries are signed by the visitor's key, pay a small proof-of-work fee, travel over the same
   peer connections and are ordered the same way on every copy; the owner and moderators can remove entries and
   ban authors.
6. **Doors.** The site lives at its key; domains are doors: any host that serves the loader can open a site from its signed link, in a
   limited view, though a link cannot reroute itself when its first door is down ([DEPLOY.md, "Doors"](docs/DEPLOY.md#doors)).

The specification is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Modes

| Mode | What visitors load | Use it for | What it gives up |
|---|---|---|---|
| **Shell** | the loader at your domain; your site in a same-URL frame, from its torrent | new or peer-first sites; returning visitors who must ride out a host outage | crawlers and link previews see the loader, not your content |
| **Drop-in** | your host's own HTML plus one script tag; other files from the verified copy after the first page view | existing static sites; SEO, redirects and 404s stay exactly as they are | new visitors still need the host; sharing happens in page-view bursts |
| **Hub, subdomain** | each site at `https://<label>.<hub>/`, after a gate | loading magnet links from many publishers | needs wildcard TLS, a Public Suffix List entry and abuse handling |
| **Hub, shared origin** | sites under `/_mw/s/<btih>/` on one origin, after a gate | one publisher, demos | no isolation: sites on it share one browser origin and can access each other's data; root-relative URLs don't work |
| **Door** (v0.3 C2) | any site by its signed link at `/_mw/open.html` of any loader host, after a gate, in a sandboxed frame | opening a site when its own address is blocked or down | a limited view: no storage and no offline engine for that site, an identity for this visit only, no relative `fetch` |

## Backend-free CRUD in 20 lines

Publish with `--policy open` so visitors can write, and with `--cs` pointing at `genesis.json` (or a ledger
snapshot) on your host so the first visitor can write too. Then any page of the site can do this:

```html
<form id="add"><input name="note" maxlength="280" required> <button>Add</button></form>
<ul id="notes"></ul>
<script type="module">
  import mw from '/_mw/sdk.js';
  const me = await mw.ready();                       // { identity, role, peers, height, ... }

  // Read: runs now and again whenever any visitor's entry arrives
  mw.db.subscribe(({ lists }) => {
    document.querySelector('#notes').replaceChildren(...(lists.notes || []).map((item) => {
      const li = document.createElement('li');
      li.textContent = String(item.v?.note ?? '') + ' ';
      if (item.author === me.identity?.pub) {        // Delete: your own entries
        const del = li.appendChild(document.createElement('button'));
        del.textContent = 'Delete';
        del.onclick = () => mw.db.tombstone(item.h);
      }
      return li;
    }));
  });

  // Create: signed with this visitor's key, fee paid, stored, then sent to peers
  document.querySelector('#add').onsubmit = async (event) => {
    event.preventDefault();
    await mw.db.append('notes', { note: event.target.elements.note.value });
    event.target.reset();
  };
  // Update one shared key (the last writer in ledger order wins): await mw.db.set('topic', 'Ideas')
  // Read it back: await mw.db.get('topic'); delete it: await mw.db.del('topic')
</script>
```

Keys and lists starting with `_` are written only by the owner and moderators; everyone reads them. Errors carry
a `code` such as `E_POLICY`, `E_RATE` or `E_LIMIT`. The guide is [docs/CRUD.md](docs/CRUD.md), and every method is
in [docs/SDK.md](docs/SDK.md).

## Move an existing site

Drop-in mode keeps your pages on your host and adds the verified copy, offline revisits of visited pages and the
site ledger:

```sh
npx felinar publish ./public --name my-site --scope example.com --key owner.jwk \
  --dropin --inject-script --tr public --out dist-publish
#   upload dist-publish/site/ to the host root: every non-HTML file first, the HTML pages last
npx felinar check-site https://example.com/
```

Each visitor on an unmetered network downloads the whole copy of your non-HTML files from your host once, so
budget egress for copies, not page views. Comments and guestbooks move to the ledger; email, payment webhooks and
secrets stay on a server. The full path, CMS exports and rollback are in [docs/MIGRATION.md](docs/MIGRATION.md);
frameworks, hosts and browsers in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) and the
[recipes](docs/recipes/); a worked example in [examples/existing-site-dropin/](examples/existing-site-dropin/).

## Who it is for

**A good fit:** documentation, blogs and project sites that want offline revisits and comments without a database;
communities and events (guestbooks, comments, notices and simple polls, all public); mirrors, archives and course
material that many people open at the same time; anyone publishing from GitHub Pages, Cloudflare Pages or a bucket
on no budget.

**Not a fit:** private or personal data; accounts, payments, email, webhooks, server-side secrets or strong
consistency; visitors who need anonymity; streaming media (a shell site downloads whole before it renders, within
128 MiB on desktop and 24 to 48 MiB on phones); cutting the hosting bill of a small site.

How it compares with static hosting, backend services, IPFS, Nostr and a CMS:
[docs/WHY.md](docs/WHY.md#how-it-compares).

## Status and roadmap

Version 0.3.0, pre-release, and the first public release: 0.2.1 was never published. 0.3.0 runs the
v0.3 and C2 code: one identity for many sites through an identity origin, sign-in for any site, sealed records,
chat and calls encrypted between the people in them, private photos and videos encrypted before they enter the swarm,
smart seeding, zero-setup hosting and doors ([CHANGELOG.md](CHANGELOG.md)). The encryption has limits: the site's own code can
read your messages and files while you are signed in, the people you write to can keep what you send, messages held for
later delivery have no forward secrecy, and none of this new cryptography has had an outside review
([docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), "Honest limits"). Peers still see each other's IP address. On one
development machine with loopback networking only, the unit, browser and end-to-end suites passed in the last full
runs recorded in [docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md), except the failing and flaky rows it
names with their counts and dates, and no test request left 127.0.0.1. The browser floor is Safari and iOS 15.4, Chromium 110 and Firefox 115 ESR, but so far the suites ran
only in Playwright Chromium, WebKit and (since 2026-10-22) Firefox: the release gate on real phones and browsers has not run
([docs/DEMO-RESULTS.md](docs/DEMO-RESULTS.md)). The review round of the v0.3 design review ran from 2026-10-22 to
2026-10-24, and the blockers it confirmed are fixed ([CHANGELOG.md](CHANGELOG.md)). Until the gate passes nothing here is
called production-ready. What comes next, for 0.4 and for 1.0, is in
[docs/ROADMAP.md](docs/ROADMAP.md).

## Documentation

| Start with | For |
|---|---|
| [WHY](docs/WHY.md), [FAQ](docs/FAQ.md), [CRITIQUE](docs/CRITIQUE.md) | the case for it, short answers, and the case against it |
| [QUICKSTART](docs/QUICKSTART.md), [ONBOARDING](docs/ONBOARDING.md) | publishing a site; a team's decision tree, roles and pilot plan |
| [CRUD](docs/CRUD.md), [SDK](docs/SDK.md) | shared data on the site ledger, and every `mw` method |
| [MIGRATION](docs/MIGRATION.md), [COMPATIBILITY](docs/COMPATIBILITY.md), [recipes](docs/recipes/) | moving an existing site, frameworks and hosts |
| [DEPLOY](docs/DEPLOY.md), [OPERATIONS](docs/OPERATIONS.md), [RUNBOOK](docs/RUNBOOK.md) | hosts, DNS, deploy order, owner duties, monitoring, incidents, the kill switch |
| [PRIVACY](docs/PRIVACY.md), [SECURITY-MODEL](docs/SECURITY-MODEL.md) | who receives what; what is protected and what is not |
| [ARCHITECTURE](docs/ARCHITECTURE.md), [INTERFACES](docs/INTERFACES.md) | the specification and the module contracts |
| [docs/README.md](docs/README.md) | every document, in reading order |

Examples: [examples/peer-guestbook/](examples/peer-guestbook/) (a shell-mode site with a live guestbook),
[examples/existing-site-dropin/](examples/existing-site-dropin/) (an existing multi-page site in drop-in mode) and
[examples/landing/](examples/landing/) (this project's homepage, published through felinar).

## Contributing, security and license

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md);
decisions follow [GOVERNANCE.md](GOVERNANCE.md). Every browser the tests start is local-only
([docs/DEV-NETWORK.md](docs/DEV-NETWORK.md)). Report vulnerabilities privately, through GitHub's private vulnerability
reporting, as described in [SECURITY.md](SECURITY.md), never in a public issue: the project holds no domain and runs no
mailbox. If that route fails you, SECURITY.md gives the fallback, with the OpenPGP key [SECURITY-KEY.asc](SECURITY-KEY.asc)
(fingerprint `4C44 C2A8 D935 27B7 4C88 1E20 A46F 0FB0 E1F8 0C26`) to encrypt the details. Changes are listed in
[CHANGELOG.md](CHANGELOG.md). Releases are signed with the release key `p256:BCHNewmajl6XLH2R_GitiO3TJ5bQQQCEK6ljHGk-y5ZBnZ7iVk_dnkRQWcMrvy-LAbwQ5UTfQTBOpDKxz-YvtS4`, the key that
`PINNED_RELEASE_KEYS` in `tools/verify-release.mjs` holds; [SECURITY.md](SECURITY.md#checking-a-release) says how
to check a download from GitHub or from any other copy, and that no release is signed while this line shows no `p256:`
key.

felinar builds on [WebTorrent](https://github.com/webtorrent/webtorrent) and learned from ZeroNet, Beaker, IPFS
gateways, PeerTube and an earlier project with the same name and a similar idea,
[KayleePop/magnet-web](https://github.com/KayleePop/magnet-web) ([docs/WHY.md](docs/WHY.md#prior-art)).

Released under the [MIT License](LICENSE). The source contains encryption: [SECURITY.md](SECURITY.md#cryptography-and-export-rules)
says what the owner decided about US and Canadian export rules, and that no lawyer reviewed it.
