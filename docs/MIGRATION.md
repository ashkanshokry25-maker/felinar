# Pivot an existing website to felinar

You have a static site that works. This guide adds felinar to it without moving it: one script tag on your
pages, one publish command in your deploy, and an upload order. Your host keeps serving every page exactly as
today. After a browser's first page view, the site's other files come from a verified copy on the visitor's
device and from other visitors, visited pages open offline, and the site gains a shared, public site ledger for
comments and guestbooks.

No backend means there's no application server or database for you to run. You still need an HTTPS static host,
which serves the loader on every visit and keeps the site loading when nobody else is online. Visitors find each
other through WebSocket trackers and STUN servers, public ones or your own.

**Status (0.3.0, a pre-release).** Drop-in mode passes its end-to-end checks in Playwright Chromium and WebKit on one
machine, loopback only (scenarios 9, 10 and 10B in [INTEGRATION-STATUS.md](INTEGRATION-STATUS.md), listed in
`examples/existing-site-dropin/EXPECTED.md`). It has not run on real phones, on real hosts or in Firefox and Safari
([DEMO-RESULTS.md](DEMO-RESULTS.md)). Try it on a staging host first.

Contents: [the promise](#the-promise-and-its-limits) · [fit check](#before-you-start-does-your-site-fit) ·
[three steps](#the-drop-in-path-in-three-steps) · [local preview](#try-it-on-this-computer-first) ·
[egress](#egress-budget-for-copies-not-page-views) · [shell path](#the-shell-path-for-new-or-peer-to-peer-first-sites) ·
[hybrid](#the-hybrid-drop-in-now-shell-later) · [visitors and crawlers](#what-changes-for-visitors) ·
[checklist](#compatibility-checklist) · [dynamic features](#dynamic-features-and-their-replacements) ·
[SEO](#seo-rules-for-a-migrated-site) · [CMS exports](#cms-exports) · [versions and rollback](#versions-and-rollback) ·
[troubleshooting](#troubleshooting) · [what publish checks](#what-publish---dropin-checks)

## The promise and its limits

### What drop-in gives you

| You get | On this condition |
|---|---|
| Nothing about your pages changes: same URLs, redirects, 404 pages, response headers and search results. With JavaScript off every page renders as before (the end-to-end test compares full-page screenshots byte for byte). | The host keeps serving the HTML. `publish` adds one `<meta name="mw-pointer">` and, if you ask, the script tag to each page; nothing rewrites a page after that. |
| Later page views take their CSS, scripts, images, fonts and `fetch()` data from a verified copy on the visitor's device. | The browser runs a Service Worker, and the copy is complete. The copy fills at idle after the first page view: from your host on unmetered networks, from other visitors only on mobile data. A browser's first page view, and every hard reload, still come from your host. |
| Pages already visited open offline. | The worker kept them: at most 100 documents, never one your host sent with `Cache-Control: no-store`. A page never visited shows the worker's "You're offline" page. |
| Visitors pass the site's files and posts to each other. | Only after the visitor chooses "Share and load", only while a page is open, and in page-view-sized bursts: every navigation ends the page's connections. Phones upload nothing until the visitor turns on "Share on this network". |
| Shared data with no backend: comments, guestbooks, reactions, polls through `mw.db` ([CRUD.md](CRUD.md)). | Everything written is public and copied to every visitor. Visitors can write only if you publish with `--policy open` (or `allow`). |
| A cheap way back. | Your files never moved. Deploy the kill switch, then remove the tag ([rollback](#roll-back-the-migration)). |

### What drop-in does not do

- **It doesn't keep the site up for new visitors while your host is down.** Returning visitors keep the pages
  they already opened; nobody else can load anything.
- **It doesn't cut a small site's hosting bill, and it can raise your egress.** Each visitor on an unmetered
  network fills a copy of all your non-HTML files from your host once ([egress](#egress-budget-for-copies-not-page-views)).
- **It isn't private.** Peers, trackers and STUN servers see each visitor's IP address once the visitor chooses
  to share, and anyone who knows the site's infohash can see who is online.
- **It needs the root of an origin you control.** Hosted builders that offer no way to serve a file at
  `/mw-sw.js` (the research found none on Squarespace, Wix, Webflow or Ghost(Pro)) and sites under a sub-path such
  as `https://<user>.github.io/<repo>/` can't use it ([COMPATIBILITY.md](COMPATIBILITY.md)).
- **It doesn't replace a server.** Email, payments webhooks, accounts and secrets stay where they are
  ([dynamic features](#dynamic-features-and-their-replacements)).

### Which path: drop-in, shell, or both

| | Drop-in | Shell | Hybrid: drop-in now, shell later |
|---|---|---|---|
| Who serves the HTML | your host, unchanged | the site's torrent, through the loader's Service Worker | your host, until you switch |
| Search engines and link previews | see your pages as today | see the loader page only, one title for every URL | as today until the switch |
| Host down, returning visitor | pages already visited | the whole site | pages already visited |
| Host down, new visitor | can't load | can't load (the loader comes from your host) | can't load |
| What you change | one script tag, one publish step, upload order | the whole deployment: the loader at the root, the site behind it | both, at different times |
| Good for | existing sites, anything that needs search traffic | new or peer-to-peer-first sites and apps that don't need search traffic | sites that may later want the full offline copy |

Drop-in is the default for a migration: crawlers, link unfurlers, crawl-validated checkouts and no-JS clients see
only host HTML, and shell mode gives every URL the same title and no Open Graph tags
([MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), verdict 2).

## Before you start: does your site fit?

Five minutes with this table saves an afternoon. Details for browsers, hosts and frameworks are in
[COMPATIBILITY.md](COMPATIBILITY.md).

| Requirement | Why | If not |
|---|---|---|
| Served over HTTPS at the root of its origin (`https://www.example.com/`, not `https://example.com/site/`) | Browsers run Service Workers only in a secure context, and `/mw-sw.js` must sit at the origin root to control every page (static hosts can't send `Service-Worker-Allowed`). | Move the site to a custom domain or subdomain. Sub-path support (`--base`) is on the [roadmap](ROADMAP.md). |
| You can upload files at `/mw-sw.js`, `/_mw/` and `/.mw/` | The worker, the runtime and the file list live there. | Hosted builders: export the site first ([CMS exports](#cms-exports)). |
| Nothing of yours already lives at `/_mw/`, `/.mw/`, `/ws/` or `/mw-sw.js` | Reserved by felinar; `publish` refuses to run. | Rename those paths. |
| The host can keep the previous deploy's files for 7 days | Pages open on the old version still load their lazy files; peers still on it ask for them. | Merge the previous version's non-HTML files into each deploy ([step 3](#step-3-upload-non-html-files-first-then-html)). |
| Pages aren't sent with `Cache-Control: no-store` | Chromium keeps such a page out of the back/forward cache for life after any WebSocket or WebRTC use, so those pages run host-only (no peers). | Fine for a few pages (account pages); use `no-cache` for the rest. |
| The host or CDN doesn't rewrite file bytes (image optimisation, minification at the edge) | Altered bytes fail their piece hashes and are never served from the copy. | Turn the transform off, or leave those files out of the torrent with `--ignore`. `check-site` finds them. |
| You know whether the site has its own Service Worker | One worker controls a scope; felinar never registers over yours. | Add two lines to your worker ([recipe](#a-site-with-its-own-service-worker)). |
| You know whether the site sends a Content-Security-Policy | The runtime needs `worker-src 'self'` and the tracker URLs in `connect-src`. | Add what `csp.txt` lists ([CSP](#content-security-policy)). |
| Total non-HTML size | Visitors complete a copy only up to 128 MiB on desktop, 48 MiB on a phone on confirmed Wi-Fi and 24 MiB otherwise. | Larger sites still work from the host; leave big media out with `--ignore` ([large sites](#large-sites)). |

## The drop-in path in three steps

You need Node 22 or newer, a clone of this repository with `npm ci` and `npm run build` done
([QUICKSTART.md](QUICKSTART.md), step 0), and an owner key:

```sh
node tools/keygen.mjs --out ~/keys/my-site-owner.jwk
```

The key signs the pointer stamped into your pages. It never goes into a browser, a web server or a repository.
Back it up: visitors remember it on their first visit and warn before they accept a different one.

The examples assume your built site is in `~/my-site/public` and lives at `https://www.example.com/`.

### Step 1: add the script tag

Every HTML page gets one tag in its `<head>`:

```html
<script data-cfasync="false" type="module" src="/_mw/mw.js" async></script>
```

Add it to your layout template, or let `publish` add it to every page with `--inject-script`. `data-cfasync="false"`
must come before `src`: behind Cloudflare it keeps Rocket Loader from rewriting the tag. The tag takes two options:

| Attribute | Effect |
|---|---|
| `data-mw-sw="off"` | Never register `/mw-sw.js` (and remove ours if a browser has it). The ledger and sharing still run; nothing is served from the copy. |
| `data-mw-consent="site"` | No automatic consent card. Your site explains sharing itself and calls `mw.consent.request()` from a click, which opens the same loader-owned card; the visitor decides there ([SDK.md](SDK.md)). |

There are no other options. A site can't accept consent for the visitor: the card ignores clicks that a script
makes.

### Step 2: publish with `--dropin`

```sh
node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

| Flag | Meaning |
|---|---|
| `~/my-site/public` | your build output, the folder your host serves today |
| `--name my-site` | the torrent name; keep it the same for every version |
| `--scope www.example.com` | the hostname visitors use; the pointer is signed for it, and a page served from another hostname refuses it |
| `--dropin` | leave HTML out of the torrent, stamp every page, lay out the runtime |
| `--inject-script` | add the script tag to pages that don't have it |
| `--tr public` | the four public WebSocket trackers; add your own with `--tr wss://tracker.example.com` (repeatable). Without `--tr` visitors never find each other |
| `--ct mailto:abuse@example.com` | who answers abuse and legal notices, signed into the pointer ([DEPLOY.md](DEPLOY.md), "Owner duties") |
| `--out dist-publish` | the output folder; reuse it for every version so the ledger keeps its first entry (`genesis.json`) |

A site whose visitors post (comments, a guestbook) adds a ledger policy and a snapshot URL, for example
`--policy open --bits 16 --cs /ledger/genesis.json`, and uploads `dist-publish/genesis.json` to that path
([CRUD.md](CRUD.md)). Relative `--cs` URLs are allowed in drop-in mode.

What `publish` does, in order: it checks every path, the size budget and the files for secrets
([what publish checks](#what-publish---dropin-checks)); builds a torrent of every non-HTML file plus
`/.mw/files.json` (the SHA-256 of each file) and `/.mw/site.json`; writes `dist-publish/site/`, which is your site
with the pointer stamped into every page as the first child of `<head>`, the runtime under `/_mw/`, `/mw-sw.js`,
`/_mw/t/<btih>.torrent` and an empty `.nojekyll`; and prints the deploy order, the egress note and the CSP
additions. Abridged output of a run on the drop-in example's main site (7 files, 13 KiB), as
`test/fixtures/existing-site-dropin/stage.mjs` stages it. Publishing the folder itself also packs its
`EXPECTED.md` and the two Service Worker variants (12 files, 29 KiB) and prints a warning about the tag's missing
`data-cfasync="false"`:

```text
Left out of the torrent (2):
  _headers  host config (read into /.mw/site.json)
  _redirects  host config (read into /.mw/site.json)
felinar publish (dropin mode)
  btih      b15216ac2100de10d929eda672029e532efee1ce
  xs        /_mw/t/b15216ac2100de10d929eda672029e532efee1ce.torrent
  ws        (none)
  pointer   seq 1792457606, expires 2027-01-18 (90 days)
Egress: on unmetered networks each drop-in visitor downloads the whole copy (13 KiB of non-HTML files) from this host once, at idle after the first page view; cellular and Save-Data visitors fill it from peers only. [...]
Deploy dist-publish/site/ in this order: (1) every non-HTML file, including /_mw/, /.mw/ and /mw-sw.js,
(2) the HTML pages last. Keep the previous version's files for at least 7 days.
```

`_redirects` and `_headers` stay in `site/` for your host. There is no `ws=` in the pointer: the drop-in Service
Worker makes your host the web seed by answering `/_mw/ws/<name>/<path>` from your own files, so no CORS and no
`Range` support are needed on the host. Drop-in pages never read DNS, so you need no `_magnet` TXT record.

### Step 3: upload non-HTML files first, then HTML

Upload `dist-publish/site/` to the root of your host. When files go up one by one, upload every non-HTML file
(including `/_mw/`, `/.mw/` and `/mw-sw.js`) before any HTML page, so no stamped page points at files that aren't
there yet. With S3:

```sh
aws s3 sync dist-publish/site/ s3://<bucket>/ --exclude "*.html" --exclude "*.htm"
aws s3 sync dist-publish/site/ s3://<bucket>/ --exclude "*" --include "*.html" --include "*.htm"
```

Hosts that switch a whole deploy at once (GitHub Pages, Cloudflare Pages, Netlify, Vercel) take care of the
order, but they drop the previous deploy's files. Keep the previous version's non-HTML files for at least 7 days
by merging them into the new upload. `publish` replaces `dist-publish/site/` on every run, so copy it to
`previous-site/` before you publish the next version; then, before uploading the new one:

```sh
rsync -a --ignore-existing --exclude "*.html" --exclude "*.htm" previous-site/ dist-publish/site/
```

`--ignore-existing` never overwrites a new file, and the excludes keep deleted pages deleted. Files that change
in place under the same name (an un-hashed `data.json`) can only hold one version; content-hashed names avoid that
([hashed assets](#hashed-assets-and-files-that-change-in-place)).

Then, where your host lets you set headers, serve `/mw-sw.js` with `Cache-Control: no-cache`, and purge your CDN
after every deploy. Host-by-host steps: [GitHub Pages](recipes/github-pages.md),
[Cloudflare Pages](recipes/cloudflare-pages.md), [Netlify](recipes/netlify.md), [Vercel](recipes/vercel.md),
[S3 and CloudFront](recipes/s3-cloudfront.md).

### Check it

```sh
node tools/check-site.mjs https://www.example.com/
```

For a drop-in page, `check-site` reads the stamped pointer, fetches `/_mw/t/<btih>.torrent`, downloads every file of
the torrent from its own URL with browser `Accept` headers and checks every piece, which catches an edge that
changes bytes after you published. It also connects to each tracker and validates the snapshot. It exits 0 when
every check passes, 1 when one fails, 2 on a usage error. `--headless` also opens the page in Playwright Chromium.

To check the host before any stamped page goes live, upload the non-HTML files first and run the same check on
them alone:

```sh
node tools/check-webseed.mjs https://www.example.com/ dist-publish/site.torrent --mode host
```

Or let `publish` do it: with `--verify-host` it withholds every stamped page until your host serves the torrent's
exact bytes.

```sh
node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish --verify-host https://www.example.com/
```

Then look at it in a browser: with JavaScript off every page looks as before; after 3 seconds on screen the
first-run card appears at the bottom; the second page view gets its styles, scripts and images from the Service
Worker (the network panel shows it); and `window.__mwDropin.inspect()` in the console shows `copy`, `source`,
`consent` and `sw.mode`.

### Automate it

Run the publish step in your existing pipeline, after the build and before the upload. A GitHub Actions template
for site owners is [deploy/github-actions/publish-site.yml](../deploy/github-actions/publish-site.yml). Keep the owner
key out of the repository: store it as a secret, write it to a file with mode 600 in the job, and delete it at the
end. For reproducible `.torrent` files, publish from a git work tree or set `SOURCE_DATE_EPOCH`; `--double-pack`
packs twice and fails on any difference.

## Try it on this computer first

Everything below stays on your computer. Publish for `localhost` with a local tracker, then open the site:

```sh
node tools/publish.mjs ~/my-site/public --name my-site --scope localhost \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr ws://127.0.0.1:8000 --out .tools/preview
node tools/tracker.mjs --port 8000 --allow .tools/preview/summary.json &
node tools/dev-server.mjs --root .tools/preview/site --port 8080 &
node tools/check-site.mjs http://localhost:8080/ --headless --consent
```

`--headless` needs Playwright's Chromium once (`npx playwright install chromium`); the browser it starts can't
reach any host but localhost. Open `http://localhost:8080/` in two browsers (use `localhost`, not `127.0.0.1`: the
pointer is signed for the hostname). The dev server serves files with the right types and `Cache-Control: no-cache` on `/mw-sw.js`, but it
doesn't read `_redirects`, so routes that need your host's rewrite rules 404 here. Stop the two background
processes when you're done (`kill %1 %2`).

## Egress: budget for copies, not page views

In drop-in mode a visitor's browser loads the pages they read, then, at idle on an unmetered network, fills a copy
of every non-HTML file from your host so it can serve later pages and other visitors. Files already in the
browser's HTTP cache cost nothing, so the host serves at most the whole copy once per new device. The host-egress
multiplier per new device is

```text
M = (S_site x (1 - p) + p x B_visit) / B_visit
```

where `S_site` is the size of your non-HTML files, `B_visit` the bytes a visitor would have loaded anyway and `p`
the share of the copy that other visitors deliver ([w2a-07](research/w2a-07-hosting-cost-bandwidth.md), F21).

| Site (non-HTML) | Typical visit | Peer share `p` | Multiplier |
|---|---|---|---|
| 5 MB | 1 MB | 0 | 5.0 |
| 20 MB | 1.5 MB | 0 | 13.3 |
| 20 MB | 1.5 MB | 0.5 | 7.2 |
| 100 MB | 2 MB | 0 | 50 |

These rows are arithmetic from the formula, not measurements. For small sites `p` is close to 0: in the research
model peers delivered 0.0 % of a 5 MB site's first-visit bytes at up to 30,000 visits a day, because the host
finishes before the consent click and the peer connection setup are done
([w2a-07](research/w2a-07-hosting-cost-bandwidth.md), F23; a model, not a measurement). `publish --dropin` prints the
copy size of your site.

What limits it:

- **A zero-egress host makes it free**: Cloudflare Pages and Workers static assets, or R2
  ([COMPATIBILITY.md](COMPATIBILITY.md#hosting-providers)). On S3, CloudFront or Vercel it is billed per GB.
- **Leave heavy files out of the torrent**: `--ignore media/` keeps `media/` on your host only. Those files load
  from the host as today and never enter anyone's copy.
- **Phones on mobile data and Save-Data never fill from your host**; they fill from peers only. An iPhone counts
  as "unknown network" and fills from peers until its visitor turns on "Share on this network".
- A budgeted, peer-first copy (the host fills only what peers don't deliver within a few seconds) is on the
  [roadmap](ROADMAP.md) under migration tooling; it isn't built.

For the general economics of peers and web seeds, read [WHY.md](WHY.md#honest-economics).

## The shell path for new or peer-to-peer-first sites

Shell mode serves the loader at your domain and runs your site from its torrent in a same-URL frame: links,
root-relative assets, `fetch('/data.json')` and History-API routers work unchanged, and a returning visitor gets the
whole site even while your host is down. It suits sites that don't need search traffic or link previews: apps,
demos, community tools, mirrors. The full walk-through is [QUICKSTART.md](QUICKSTART.md), track A; in short:

```sh
node tools/publish.mjs ~/my-site/public --name my-site --scope example.com --key ~/keys/my-site-owner.jwk \
  --ws https://example.com/ws/ --tr public --cs https://example.com/ws/genesis.json \
  --ct mailto:abuse@example.com --shell --out dist-publish
```

Then deploy `dist-publish/shell/` at the host root and `dist-publish/my-site/`, `my-site.torrent` and
`genesis.json` under `/ws/`. What differs from drop-in:

- **The host serves the loader for every URL.** Configure it to answer unknown paths with the shell (a `404.html`
  copy of the shell is in `shell/`, or an SPA fallback). Keep `robots.txt`, the favicon and `.well-known/` at the
  host root next to the shell.
- **Your routing moves into the torrent.** `_redirects` and `_headers` are compiled into `/.mw/site.json` and applied
  by the worker. Routing flags: `--spa` (navigations that match nothing get `index.html` with 200), `--clean-urls`,
  `--trailing-slash auto|always|never`, `--not-found <file>|none`. The worker supports a subset of the
  `_redirects` grammar: `from to [status][!]`, splats and `:placeholders`, statuses 200, 301, 302, 303, 307, 308
  and 404. Lines with query matching, country, language or cookie conditions, or proxying to another origin are
  left out of `/.mw/site.json`, and `publish` names them (the count and the first line).
- **The whole site must fit every visitor's cap**: 128 MiB on desktop, 48 MiB on a phone on confirmed Wi-Fi and
  24 MiB on other phones, iPhones included until the visitor turns on "Share on this network". Above the cap a
  visitor sees "This site is larger than allowed here" and can't load it.
- **The web seed must answer `Range` with 206.** On the loader's own host (`--ws https://example.com/ws/`) it needs
  no CORS. Cloudflare Pages answers `Range` with 200, so put the web seed elsewhere there
  ([Cloudflare R2](recipes/cloudflare-r2.md)).
- **A site's own Service Worker can't run under the shell**, and a PWA install uses the shell's manifest.
- **Dialogs are ignored**: the frame's sandbox has no `allow-modals`, so `alert()`, `confirm()` and `prompt()` do
  nothing.
- **Without a Service Worker** (Lockdown Mode, in-app browsers) the shell renders in limited mode: no offline copy,
  the site's scripts can't `fetch()` its files by relative URL, and by code reading form posts are blocked
  (`form-action 'none'` in the shell's policy).

## The hybrid: drop-in now, shell later

You can start with drop-in and move the same origin to shell mode later. The code is built for it: `/mw-sw.js`
keeps its URL, the worker learns its mode from the page that talks to it, `/_mw/sdk.js` gives your scripts the same
`mw` API in both modes, and the ledger id stays the same as long as the scope, the owner key and the `--chain` label
do (publish both modes into the same `--out` so `genesis.json` is reused). **No test covers the switch yet.** Rehearse
it on a staging host with a browser that has used the drop-in site, keep the kill switch at hand, and remember
what the move costs: search engines and link previews then see only the loader page.

## What changes for visitors

| Moment | What a visitor sees |
|---|---|
| First page view | your page from your host, exactly as before |
| After 3 seconds on screen | a card at the bottom of the page: "This site is delivered peer-to-peer." with [Share and load] [Load from host only] [Settings]. Nothing connects to a tracker or another visitor before a choice. With `data-mw-consent="site"` the card appears only when your site calls `mw.consent.request()`. |
| On a phone | the card adds "On this phone sharing stays off until you turn on "Share on this network" in Settings." |
| Later page views | the same pages, with files from the copy on the device; no status bar, badge or banner |
| Your site changes its key without a rotation | a prompt that the publisher key changed, with both fingerprints |

There is no status bar in drop-in mode. To give visitors a way back to their sharing choice, add a link that calls
`window.__mwDropin.openSettings()`:

```html
<button type="button" id="sharing-settings">Sharing settings</button>
<script type="module">
  document.getElementById('sharing-settings').addEventListener('click', () => window.__mwDropin?.openSettings());
</script>
```

Visitors also store the copy, visited pages and a posting identity on their device, and on desktop they upload
while a page is open after choosing to share. Say so in your privacy notice ([PRIVACY.md](PRIVACY.md)).

## What changes for crawlers and link previews

Nothing in drop-in mode. Crawlers, link unfurlers and no-JS clients get your host's HTML, which differs from today
by one `<meta name="mw-pointer">` and the script tag. The runtime fails open: Google's renderer has no WebRTC, and
reports say it rejects Service Worker registration ([w2a-05](research/w2a-05-seo-crawlers.md)), so the page renders
from the host as before. The runtime never replaces, hides or reorders your content; its only UI is one element
appended to the page, marked `data-nosnippet`, so search engines don't quote it.

Shell mode is the opposite: every URL returns the loader page, so crawlers that don't run it see no content, one
title for every URL and no Open Graph tags.

## What you must keep on your host

In drop-in mode, everything you have today stays: `robots.txt`, `sitemap.xml`, the favicon, the web manifest, Open
Graph images, verification files and `.well-known/` (publish never puts `.well-known/` in the torrent and keeps it in
`site/`), your redirects and `_redirects` rules, your 404 page and your response headers. Add:

- `/_mw/`, `/mw-sw.js`, `/.mw/` and `/_mw/t/<btih>.torrent` from `site/`;
- the snapshot file named by `--cs`, if the ledger takes posts;
- the previous version's non-HTML files for at least 7 days;
- `dist-publish/mw-sw-kill.js`, kept somewhere safe for the day you need it.

## Compatibility checklist

| Site feature | Drop-in | Shell | What to do |
|---|---|---|---|
| Root-relative URLs (`/css/app.css`, `fetch('/data.json')`) | works | works (same-URL frame) | nothing |
| Page-relative URLs (`../about.html`) | works | works | nothing |
| Site under a sub-path (`/<repo>/`) | not supported | not supported | use a custom domain or subdomain |
| Content-hashed assets | best case | fine | keep them hashed |
| Un-hashed files that change in place | one version per URL | fine | hash them, or accept that a page open on the old version gets the new file |
| Its own Service Worker | add two lines | can't run | [recipe](#a-site-with-its-own-service-worker) |
| History-API router with a deep-link fallback | your host's rule keeps working | `_redirects` 200 rule or `--spa` | [routers](#history-api-routers-and-spa-fallback-rules) |
| Hash router (`/#/page`) | works | works | not indexable in any mode |
| Language subdirectories (`/en/`, `/fr/`) | works | works | host-side language redirects work only in drop-in |
| Forms posting to your host or a form relay | unchanged | work in SW mode; blocked in limited mode | [forms](#forms) |
| Downloads | from the host or the copy | from the torrent | keep big files out of the torrent |
| Video and audio with `Range` | host, or the copy | the copy, 206 slices | [media](#downloads-media-and-range-requests) |
| Pages sent with `Cache-Control: no-store` | host-only | n/a | use `no-cache` where you can |
| Content-Security-Policy | add `csp.txt` lines | the shell sets its own | [CSP](#content-security-policy) |
| `<embed>` and `<object>` files | always from the host | break: they bypass the worker, and the host has no file at that URL | use `<iframe>` or `<img>` |
| `alert()`, `confirm()`, `prompt()` | unchanged | ignored | replace with page UI |
| Frame-busting code (`top.location = ...`) | unchanged | breaks the site (it runs in a frame) | remove it for shell mode |
| Edge features that change bytes (image optimisation, minify) | files fail verification and come from the host | the web seed fails | turn them off for site files |
| Query strings on assets (`style.css?ver=6.4`) | matched by path, query ignored | matched by path | nothing |
| Dot files (`.well-known/`, `.htaccess`) | stay on the host | `.well-known/` must be on the host | `--include-dot <path>` publishes others |

### Paths: root-relative, relative and sub-paths

Both modes serve the site at its own origin and its own URLs, so root-relative and relative URLs both work. In the
research lab, real builds of 10 generators (24 build variants) passed home render, client navigation and a deep link
in 24 of 24 Chromium runs and 23 of 24 WebKit runs under same-URL serving; that lab ran a model of the serving rules,
not this loader ([MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), verdict 1). What doesn't work is a site under a
sub-path: `/_mw/` and `/mw-sw.js` are root paths. On a GitHub project site the tag 404s and the pages simply load
from the host, and `check-site` reports "non-root deployment".

### Hashed assets and files that change in place

Each page names its version through its stamped infohash, and the worker serves a file only from that version, so
one page never mixes versions. Content-hashed names (`app.3f2a1b.css`) make this cheap: unchanged files keep their
URL and their HTTP-cache entry, and the next copy reuses them. A file that changes under the same URL (`data.json`)
exists on the host in one version only, so a page still open on the old version gets the new file from the host.
The end-to-end test covers exactly this case ([EXPECTED.md](../examples/existing-site-dropin/EXPECTED.md), check 2).

### A site with its own Service Worker

felinar never registers over a site's worker. When `/_mw/mw.js` finds an active worker that isn't `/mw-sw.js`, it
runs the ledger and sharing without serving files and logs one console line with this recipe. Add two lines to your
worker so it can serve files from the visitor's copy:

```js
importScripts('/_mw/sw-core.js'); // first line of a classic worker

self.addEventListener('fetch', (event) => {
  if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event)); // first line of the fetch handler
  // ... your own routes, unchanged
});
```

A module worker (registered with `{ type: 'module' }`) can't call `importScripts()`: make
`import '/_mw/sw-core.js';` its first statement instead. `owns()` is synchronous and true only for files of the page's
stamped version that are complete in the visitor's copy, and for `/_mw/ws/`; your routes handle everything else. Rules:

- **Register your worker during page load.** The runtime waits 1 second for a registration to appear before it
  registers `/mw-sw.js` into an empty scope.
- **Keep `/_mw/sw-core.js` on the host** as long as your worker imports it. `importScripts()` of a missing file
  makes your worker's install fail. Remove the import before you remove `/_mw/`.
- **Known limit:** your worker never sees the navigation response, so the page's earliest requests (before the page
  maps itself to its version) come from the host; later ones come from the copy.
- **Workbox `generateSW`** can't take the fetch line, so put both lines in a file of your own, for example
  `/mw-glue.js`, and list it in the `importScripts` option, which runs before Workbox's routes:

  ```js
  // /mw-glue.js
  importScripts('/_mw/sw-core.js');
  self.addEventListener('fetch', (event) => {
    if (self.mw && self.mw.owns(event)) {
      event.respondWith(self.mw.handle(event));
      event.stopImmediatePropagation(); // a request answers once: Workbox's listener must not answer it too
    }
  });
  ```

  With `injectManifest`, add the two lines to your `swSrc` by hand, before Workbox's routes. Neither Workbox
  variant has been tested with felinar; the hand-written worker in
  `examples/existing-site-dropin/with-own-sw-integrated/` is.
- **To keep felinar's worker off entirely**, use `data-mw-sw="off"` on the script tag.

A site moving to shell mode loses its own worker: it can't register under the shell. Replace it at its own URL with
a worker that unregisters itself, or visitors can keep its old precache for several navigations
([MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), C4).

### History-API routers and SPA fallback rules

In drop-in mode the host answers deep links exactly as today, so keep your host's fallback rule (a `_redirects` line
such as `/app/*  /app.html  200`, Cloudflare Pages' SPA mode, a CloudFront function). The worker never invents
redirects, 404s or headers for your URLs, and the end-to-end test checks a deep link, `pushState`, a reload and Back
on a router page ([EXPECTED.md](../examples/existing-site-dropin/EXPECTED.md), check 4).

In shell mode the worker routes: a `_redirects` rewrite with status 200, or `--spa` for a single-page app. The SPA
fallback applies to navigations only; a missing script or image stays a plain 404, never an HTML page (the
IPFS Service Worker Gateway had a reload loop from exactly that, [w2a-09](research/w2a-09-migration-checklists-and-conventions.md)).
Multi-page sites should answer unknown paths with a real 404. The shell mirrors the frame's `pushState` and
`replaceState` into the address bar; no end-to-end test covers a router in shell SW mode yet.

### Languages under subpaths

Language subdirectories are plain paths and work in both modes. Keep `lang` on `<html>` and `hreflang` links in the
HTML. A host rule that redirects by `Accept-Language` or country keeps working in drop-in mode; in shell mode the
worker answers the navigation and skips conditional `_redirects` lines.

### Forms

In drop-in mode forms are untouched: the worker never handles non-GET or cross-origin requests, so a form that posts
to your host, to a form relay or to a `mailto:` behaves as today, and so do host form features such as Netlify
Forms (the HTML is still deployed to the host; not yet tested). In shell mode a form inside the frame can post (the
sandbox allows forms), but limited mode blocks form posts by code reading. A relay called with `fetch()` works in both. A form relay sees
what visitors type; name it in your privacy notice.

### Downloads, media and Range requests

The worker answers `Range` requests from the copy with exact 206 slices, so a `<video>` can seek; the shell-mode
end-to-end test plays an MP4 by range. In drop-in mode a media file comes from the host until the copy is complete,
then from the copy. Large files count against every visitor's copy and your egress, so keep video, audio, archives and
downloads out of the torrent with `--ignore`. In drop-in mode they stay on the host and load as today; in shell
mode the host has no file at their URL, so serve them from another address (a media host or a CDN) and link to it
there. Seeking video through a Service Worker on iPhones is not yet tested
([MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), Q14). Streaming before a file has fully arrived is a non-goal
of v1. In shell mode the frame's sandbox allows `<a download>`, except on a shared-origin hub.

### Large sites

| Non-HTML size | Desktop | Phone on confirmed Wi-Fi | Other phones (iPhone default, mobile data) | What to do |
|---|---|---|---|---|
| up to 24 MiB | copy completes | copy completes | copy completes from peers only | nothing |
| 24 to 48 MiB | copy completes | copy completes | no copy; pages from the host | consider `--ignore` for media |
| 48 to 128 MiB | copy completes | no copy | no copy | keep the torrent to what pages need |
| above 128 MiB | no copy; `publish` warns | no copy | no copy | `--ignore` large media |

In drop-in mode a visitor without a copy still gets every page from your host. In shell mode a visitor above the cap
can't load the site at all, so a shell site must fit the cap of the visitors it wants. Other limits from `publish`: a
warning at 5,000 files and a refusal above 20,000 (`--max-files` raises it; Cloudflare Pages' free plan stops at
20,000 files), a warning when the `.torrent` passes 1 MB and a refusal above 8 MiB, and a warning for a file above
25 MiB (Cloudflare Pages' per-file limit). Torrent metadata costs about 82 bytes per file plus 20 bytes per piece
([w2a-02](research/w2a-02-cms-export.md), F21).

### Content-Security-Policy

The drop-in script inserts no policy of its own; your host's policy stays yours. If your site sends one, add what
`dist-publish/csp.txt` lists:

```text
script-src   'self'        /_mw/mw.js and /_mw/sdk.js (with 'strict-dynamic' or nonces: a nonce on the tag,
                           or allow the integrity hash of /_mw/mw.js)
worker-src   'self'        /mw-sw.js and the proof-of-work worker /_mw/pow-worker.js
connect-src  'self' wss://<each tracker in the pointer>
```

STUN and TURN hosts, `blob:`, `data:`, `'unsafe-inline'` and `'unsafe-eval'` are not needed, and neither is any
DNS-over-HTTPS resolver: drop-in pages never read DNS.
Without `worker-src 'self'` the worker can't register and the pages load from the host; without the trackers in
`connect-src` nobody shares. A policy with `sandbox`, or a page inside another site's frame, runs host-only.

### Edge features that change bytes

Image optimisation (Cloudflare Polish and similar), minification at the edge and format negotiation by `Accept`
change the bytes your host serves after you published. Those files fail their piece hashes, are never served
from the copy and come from the host instead. `check-site` and `publish --verify-host` find them: they fetch every
file the way a browser asks for it and compare it with the torrent. Turn the feature off for site files, or
`--ignore` the paths. A file with an SRI `integrity=` attribute breaks under any byte rewrite anyway.

## Dynamic features and their replacements

A static export loses everything that ran on the server. Each feature falls into one of four classes
([MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), section 8; [DIGEST-AMENDMENTS.md](review/DIGEST-AMENDMENTS.md),
F1):

| Class | Meaning |
|---|---|
| **Works now** | works with the site ledger and the SDK as they are |
| **Needs new code** | possible on felinar, not built yet |
| **Third party from the browser** | a hosted service your pages call directly |
| **Stays on a server** | needs a server or edge function of yours, as today |

| Feature | Replacement on felinar | Class | Limits |
|---|---|---|---|
| Comments, guestbook | a ledger list per page (`mw.db.append`), published with `--policy open`; old comments as static JSON with `--from-wxr` | works now | public; values up to 2 KiB; 8 MiB ledger by default; moderation is yours |
| Likes, reactions | one ledger entry per visitor and post (`mw.db.set`), counted by your page; label the counts "devices", not people | works now; a dedicated reaction operation needs new code | about 570 to 1,039 bytes per like |
| Site search | Pagefind run at build time ([below](#search-with-pagefind)) | works now (third-party tool) | index 20 % to 43 % of HTML bytes |
| Contact form | a form relay (Formspree, Web3Forms, FormSubmit) or `mailto:` | third party | the relay sees the message; Formspree's free plan takes 50 a month |
| Newsletter signup | the provider's embed form; RSS or Atom as static files | third party (sending stays on a server) | double opt-in needs a mail system |
| Login, members, paywall, per-user pages | an external membership service, or a dynamic subdomain | stays on a server | the torrent and the host copy are public |
| Posting identity | a per-device key the loader creates; `mw.identity.setName` | works now | not an account: no password reset; Safari may clear it after 7 days |
| E-commerce | Stripe Payment Links or Buy Button; Snipcart only where the host serves product HTML (drop-in) | third party (checkout sessions, webhooks, fulfilment on a server) | no secrets in the browser |
| Analytics | none by default; tracker counts of who is online (`check-site` prints them) | third party if you add one | host logs undercount once files come from the copy |
| Redirects and headers | your host (drop-in); `/.mw/site.json` (shell) | works now | shell: no query matching or conditions |
| Scheduled posts, drafts | rebuild and republish on a schedule in CI | changed | only at build time |
| Email sending, payment webhooks, secrets, rate limits, cron | your server or edge function | stays on a server | anything in the torrent or on the host is public |

Never put personal data in the ledger, even encrypted: the European Data Protection Board's Guidelines 02/2025 treat
encrypted personal data as personal data, and a ledger entry can't be erased from devices that already hold it
([w2a-03](research/w2a-03-dynamic-feature-replacements.md), F25). Names in posts, e-mail addresses and IP addresses
don't belong there.

### Search with Pagefind

Pagefind indexes your built HTML and searches it in the browser, so it needs no server. Run it after your build and
before `publish`, so the index ships with the site:

```sh
npx pagefind --site ~/my-site/public
node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

The research found Pagefind 1.5.x running unchanged in the shell's frame, Worker and WebAssembly included; its
index is 20 % to 43 % of your HTML bytes and adds 200 or more files, renamed on every build
([w2a-03](research/w2a-03-dynamic-feature-replacements.md), F34 and F35). In drop-in mode, requests made from a Web
Worker don't map to a page version, so by code reading Pagefind's index comes from your host; not yet tested.

### Comments and guestbooks

New comments go to the site ledger. Publish with `--policy open --bits 16` (each post pays a 16-bit proof-of-work fee
as a spam cost), give the moderators their own keys (`--moderator <pub>`) and read [CRUD.md](CRUD.md). With open
writing, every visitor stores and passes on posts by strangers: you moderate what your site makes visitors
redistribute ([DEPLOY.md](DEPLOY.md), "Owner duties").

Old WordPress comments come along as static JSON without e-mail or IP addresses:

```sh
node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish --from-wxr ~/exports/wordpress.xml
```

It writes `comments/<slug>.json` and `comments/index.json` (`--wxr-dir` changes the folder) and prints what it dropped:
e-mail and IP addresses, unapproved, spam and trashed comments, pingbacks and comments on unpublished posts. Your
pages read the JSON with `fetch()` and render it next to the ledger's new comments.

A 200-character comment takes 798 to 1,267 bytes in the ledger (w2a-03 section 1), so the default 8 MiB ledger holds
roughly 6,600 to 10,500 of them before only the owner and moderators can add entries; `--max-chain-bytes` raises the
cap, up to 64 MiB.

## SEO rules for a migrated site

Condensed from [MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), section 9. In drop-in mode most of these hold
by construction; check them anyway before you switch.

1. Every URL meant to be found or shared returns complete HTML from the host with HTTP 200, without JavaScript, a
   Service Worker, WebRTC or IndexedDB.
2. A site that wants search or social traffic uses drop-in. Shell mode is for apps and demos; hub origins are never
   indexable.
3. Titles, descriptions, canonical links, robots directives, structured data and Open Graph tags are in the host's
   HTML, never added by scripts or the ledger.
4. Unknown URLs return a real 404 from the host, never a 200 page or a redirect to the home page. Cloudflare Pages
   without a top-level `404.html` and a catch-all `/* /index.html 200` give soft 404s.
5. `robots.txt`, `sitemap.xml`, the favicon, the manifest, Open Graph images and verification files are real files
   at the host root.
6. Every route is a real URL with an `<a href>`; no `#/` routes on indexable pages.
7. Keep every public URL unchanged. Drop-in needs no redirects; moving the canonical host to a hub is a site move.
8. Single-page apps prerender every route at build time. Check with JavaScript off.
9. CMS exports rewrite canonical, Open Graph and sitemap URLs to the final origin (Simply Static's "Absolute" mode,
   never "Relative" for a live site).
10. Don't use back-button tricks: Google's spam policy treats back-button hijacking as a violation since 2026-04-13.
    felinar only replaces history entries, never adds them.

## CMS exports

The CMS doesn't disappear: you keep running WordPress, Ghost or Drupal somewhere private to write and export, and
publish the export. "No backend of ours" stays true; "no server for the owner" doesn't. Hosted builders that can't
serve a root file get no drop-in at all.

### WordPress

Export with Simply Static (recommended) or Staatic, then publish the export with `--dropin`. Full steps, the settings
that matter and what you lose: [recipes/wordpress-static.md](recipes/wordpress-static.md).

### Ghost

1. Export with `ghost-static-site-generator` (wget-based) against a local or private Ghost:

   ```sh
   gssg --domain http://localhost:2368 --productionDomain https://www.example.com --dest static
   ```

   or with a Content-API exporter such as StaticGhost (needs an API key; ships Pagefind and Giscus).
2. Turn on Private Site Mode on the Ghost origin, so the export is the only public copy.
3. Replace Portal signup with a provider's embed, search with Pagefind, comments with Giscus or the ledger.
4. Publish `static/` with `--dropin` and deploy it to a host you control.

Lost: members, paid subscriptions, gating, native comments, analytics. Exporters lag Ghost releases (gssg was
tested on Ghost 4.48.2; Ghost 6 caps API pages at 100 items). Nothing here was run for felinar
([w2a-02](research/w2a-02-cms-export.md), recipes).

### Drupal with Tome

1. Export with Tome: `drush tome:static --uri=https://www.example.com`. The output goes to `../html` by default.
2. Add a 404 page: Tome writes only 200 responses. Paths become `path/index.html`; query strings are dropped.
3. Publish the output with `--dropin`.

Only anonymous-accessible content is exported; search, Webform and login are lost. Tome is "minimally maintained",
and the command comes from its documentation, not from a run.

### Squarespace, Wix and Webflow

These are content migrations, not exports. Squarespace exports a WordPress-format XML (pages, one blog, images as
links you should download before your subscription ends); Wix has no official code export; Webflow's code export
drops CMS content, e-commerce, forms and search. Rebuild the content with a static generator, then follow its recipe.
The research found no way to serve `/mw-sw.js` at the root on any of them, so a live site there can't use drop-in.

### Not researched

Shopify, Joomla, Tilda, Duda, Blogger and GoDaddy's builder: treat them as not supported until someone checks.

## Versions and rollback

### Publish a new version

Build, then run the same `publish` command with the same `--name` and `--out`. The new version gets a new infohash
and a higher `seq` (the current Unix time). Upload in the same order: non-HTML files first, HTML last, the previous
version's files kept for 7 days. What visitors see:

- A page that is already open keeps its version, lazy chunks included.
- The next page view loads the new HTML, which names the new version; the copy refreshes the changed files, and
  files with the same path and the same bytes come from the HTTP cache.
- The device keeps the previous version while any open page renders it, then deletes it.

Filling a new copy from the previous version already on the device is on the [roadmap](ROADMAP.md); today
unchanged files come from the HTTP cache or the host.

### Roll back a version: roll forward

A rollback is a new publish of the old source:

```sh
git checkout v1.4.2                     # the release you want back, in your site's repository
npm run build                           # your site's build
node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

Same files give the same infohash, and the stamp gets a fresh, higher `seq`. Upload as usual. **Never restore the
old HTML from a backup or a host's "rollback" button**: its stamps carry the old `seq`, and every browser that saw
the newer version refuses them ("the pointer is older than one this device has already seen") and runs host-only
until a newer stamp arrives. Pages still render, because drop-in fails open, but those browsers stop using their
copy and the ledger.

### Re-sign before the pointer expires

The stamped pointer is valid for 90 days by default (`--exp` up to 399). A drop-in page with an expired stamp runs
host-only. Before the date, publish the same files again: same infohash, a new signature. Upload the HTML pages (the
other files didn't change). `check-site` prints the days left and warns 14 days before the end.

### Roll back the migration

1. **Deploy the kill switch.** Copy `dist-publish/mw-sw-kill.js` over `/mw-sw.js` on the host and purge your CDN.
   On a visitor's next navigation the browser installs it; it deletes felinar's caches, unregisters itself and
   reloads each page the old worker controlled once, which then comes from the host. In Chromium the page was healthy
   about 3 seconds after the next navigation (end-to-end scenario 9).
2. **Remove the tag in the next deploy.** Pages that still carry it recognise the kill switch, don't register it
   again and log one console line asking you to remove the tag.
3. **Keep the kill switch at `/mw-sw.js` for at least a month**, so visitors who come back late still get it
   ([w2a-04](research/w2a-04-dropin-embedded-mode.md), section 5.6). It is a small file; keeping it longer costs
   nothing. Then you can delete `/_mw/` and `/.mw/`.
4. **Last resort**, only when the kill switch can't be deployed: have the host send `Clear-Site-Data: "storage"` on
   its HTML for a few days. It deletes everything the origin stored, your own site's data and visitors' posting
   identities included.

Your files never moved, so after step 1 the site is what it was. Procedure details and what visitors see:
[RUNBOOK.md](RUNBOOK.md), section 11.

## Troubleshooting

Start from outside, then look inside a browser:

```sh
node tools/check-site.mjs https://www.example.com/ --headless --consent
node tools/check-webseed.mjs https://www.example.com/ dist-publish/site.torrent --mode host
```

`check-webseed --mode host` requests every file of the torrent at its own URL the way a browser asks for it and
reports which files differ from the torrent; `--mode origin` does the same with plain requests and also probes
`Range`. In the browser console, `window.__mwDropin.inspect()` shows the state (`off` gives the reason the engine is
off, `sw.mode` the worker situation, `copy` and `source` the copy).

| Symptom | Likely cause | Fix |
|---|---|---|
| Console: `this page loads /_mw/mw.js but has no <meta name="mw-pointer"> tag` | the page wasn't published with `--dropin`, or the old HTML was uploaded | publish again and upload `site/` |
| `inspect().off` is `pointer:bad-sig` | the page is served from a hostname other than `--scope` (www vs apex) | publish with the hostname visitors use |
| Console: "the pointer is older than one this device has already seen" | old stamped HTML went live again (backup, host rollback) | publish the version you want with a new `seq` |
| Console: "the pointer has expired" | the stamp is past its `exp` | publish again before the date; `check-site` warns at 14 days |
| Second page view still loads everything from the host | no Service Worker, `data-mw-sw="off"`, a foreign worker, a phone without the opt-in, or the copy isn't complete yet | read `inspect().sw` and `inspect().copy`; wait for idle; check the host |
| `inspect().sw.mode` is `foreign` and one console line shows a recipe | your site has its own worker | add the two lines ([recipe](#a-site-with-its-own-service-worker)) |
| `check-site` fails "host files" for some files | a CDN or host feature changes bytes | turn it off or `--ignore` those paths |
| Nobody shares; no peers ever | no `--tr`, your CSP blocks the trackers, or visitors chose "Load from host only" | check `--tr` and `csp.txt`; most small sites have nobody online anyway |
| `check-site` reports "non-root deployment" | the site is under a sub-path | move it to the root of a domain |
| Visitors' guestbook posts fail | an open ledger without its first entry (`genesis.json`) reachable | upload `genesis.json` and publish with `--cs` |
| After the kill switch, pages reload once | expected: each page the old worker controlled reloads once | wait a few seconds; don't reload repeatedly |

More symptoms and the loader's own messages: [RUNBOOK.md](RUNBOOK.md), section 13.

## What `publish --dropin` checks

Publication can't be recalled once a peer holds a copy, so these checks run before anything is written.

### Refusals (nothing is written)

| Check | Example message |
|---|---|
| File names that break web-seed URLs or collide: `?`, `#`, `%`, `\`, control characters, dot segments, leading or trailing spaces, trailing dots, segments over 255 bytes, paths over 1,024 bytes, case or Unicode twins | `"img/What?.png": character "?" in "What?.png" (WebTorrent pastes paths into web-seed URLs unescaped [...])` |
| Reserved paths: `_mw/`, `.mw/`, `ws/`, `mw-sw.js` | `refusing --dropin: [...] already has /_mw/ (reserved for the felinar runtime; publish from the original site, not from an earlier output)` |
| Secrets and personal data by name (WordPress `wp-config.php`, `.env`, private keys and key stores, `id_rsa`, database dumps, backups, credentials files, `.htpasswd`) and by content (PEM private keys, cloud and API tokens, a private JWK, a WordPress export with commenter e-mail or IP addresses) | `refusing to publish: 1 finding(s) look like secrets or personal data, and a torrent cannot be recalled once a peer holds it` (`--allow-secret <path>` after you checked the file) |
| More than 20,000 files (`--max-files` raises it), a `.torrent` above 8 MiB, a site larger than `--max` | `refusing to publish (budget, v0.2.1 E2)` |
| A pointer longer than 900 bytes | `Use fewer --tr and --ws entries and shorter URLs` |
| `--verify-host` finds a file on the host that differs from the torrent | `--verify-host failed: the pointer was not written or printed and no page was stamped` |

### Warnings (publish continues)

| Warning | What to do |
|---|---|
| `N HTML page(s) do not load the runtime (first: ...)` | add the tag or use `--inject-script` |
| `... load /_mw/mw.js without data-cfasync="false" before src` | use the tag exactly as above |
| `... load /_mw/mw.js more than once` | harmless; one tag is enough |
| `<page>: the stamped pointer ends at byte N; the Service Worker reads only the first 4 KiB` | move large inline content out of the top of `<head>` |
| `skipping UTF-16 page ...` | save the page as UTF-8 |
| The list of dot paths left out, with reasons; `/.well-known/ is not put into the torrent; keep serving it from the host` | `--include-dot <path>` publishes a dot path the table drops (never VCS data, `.env` or credentials) |
| A name not in Unicode NFC form (published under its NFC spelling), characters reserved on Windows | rename if you can |
| 5,000 files or more, a `.torrent` of 1 MB or more, a file above 25 MiB, a site above the phone or desktop caps | see [large sites](#large-sites) |
| The pointer is over 450 bytes | fine; fewer trackers make it shorter |
| An open ledger without `--ct`, or an open or allow-list ledger without `--cs` | add the contact and the snapshot URL |
| No `--tr` | visitors will never find each other |

The report also prints the size report with the host profiles that fit, the egress note, the CSP additions and the
deploy order.

### Not checked yet: look yourself

`publish` doesn't read your scripts or your host configuration. Check these by hand: third-party hosts your pages
load (each one sees your visitors); `alert()`, `confirm()`, `prompt()` and frame-busting code (they matter in shell
mode); `<embed>` and `<object>` files; routes that need a fallback rule on the host; `_redirects` lines the shell
would skip; source maps and `.gz` or `.br` siblings that only make the torrent bigger; and SEO tags. A research
prototype of a migration lint checks several of these, but it isn't a supported tool and some of its messages
describe the research model rather than this code (for example, it says `_redirects` isn't honoured, while `publish`
now reads it):

```sh
node docs/research/labs/w2a-01-lab/lint/mw-lint.mjs ~/my-site/public --origin https://www.example.com
```

A single `publish --check` report with these rules is on the [roadmap](ROADMAP.md).

## Sources

- Specification: [ARCHITECTURE.md](ARCHITECTURE.md), section 3.4 (drop-in), section 4 (pointer), section 7.1 (the
  worker); the v0.2.1 amendments in [DIGEST-AMENDMENTS.md](review/DIGEST-AMENDMENTS.md) (D4, E1 to E5, F1).
- End-to-end checks: [EXPECTED.md](../examples/existing-site-dropin/EXPECTED.md) and
  [INTEGRATION-STATUS.md](INTEGRATION-STATUS.md).
- Research: [MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md) and the wave 2A files it cites:
  [w2a-02](research/w2a-02-cms-export.md) (CMS exports), [w2a-03](research/w2a-03-dynamic-feature-replacements.md)
  (dynamic features), [w2a-04](research/w2a-04-dropin-embedded-mode.md) (drop-in),
  [w2a-05](research/w2a-05-seo-crawlers.md) (crawlers), [w2a-07](research/w2a-07-hosting-cost-bandwidth.md) (hosts and
  cost). Prices and plan limits are list prices read on 2026-10-17.
- Browsers, hosts and frameworks in detail: [COMPATIBILITY.md](COMPATIBILITY.md) and the [recipes](recipes/README.md).
