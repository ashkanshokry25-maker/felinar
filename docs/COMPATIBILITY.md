# Compatibility

Which browsers, hosts, frameworks, features and networks work with felinar 0.3.0 and how
well we know it. Read the status column of every table: the release gate on real devices has not run
([DEMO-RESULTS.md](DEMO-RESULTS.md)), so most cells are design and research, not field results. The section "v0.3" near
the end covers identity, chat and media as 0.3.0 builds them (the review round of the v0.3 design review ran from
2026-10-22 to 2026-10-24, and nothing ran on real devices). The section "v0.3 C2" after it covers what phones do in the background, calls and
the rungs without a domain (built, and tested on loopback only). To move a site, read this page, then
[MIGRATION.md](MIGRATION.md) and the [recipes](recipes/README.md).

## How to read the status column

| Status | Meaning |
|---|---|
| **Tested** | An automated test passes in Playwright Chromium 156 or Playwright WebKit 27.2 on one machine, with every connection on loopback ([INTEGRATION-STATUS.md](INTEGRATION-STATUS.md)) |
| **Code** | Implemented and covered by unit tests or read in the code; no end-to-end test |
| **Research** | Measured by the research waves against third-party deployments, vendor documents or a model of the rules, not with the shipped loader |
| **Not yet tested** | Nobody has run it. This includes every real phone, Safari itself, Firefox outside the automated harness (the harness runs Playwright Firefox on loopback since 2026-10-22) and every real host |

## Browsers

### The floor

The declared floor, with the loader's polyfills: **Safari and iOS 15.4, Chromium 110 (Chrome, Edge, Samsung
Internet, Brave, Android WebView) and Firefox 115 ESR** (`src/loader/config.js`, ARCHITECTURE section 5.1). Every
bundle is built for that target, and `npm test` fails when the source uses one of a list of APIs newer than the
floor. The vendored WebTorrent calls
`Uint8Array` hex and base64 methods that exist natively only from Chrome 140, Firefox 133 and Safari 18.2, so the
loader installs and self-tests polyfills for them and for `AbortSignal.timeout`
([w1-08](research/w1-08-mobile-constraints.md), F-03 to F-05). On 2026-10-13 caniuse put Safari and iOS below 15.4 at
0.10 % of global traffic and Chrome desktop below 110 at 1.23 % (w1-08, F-02).

### Browser matrix

"Shell" and "Drop-in" describe what a visitor gets; "Peers" whether the browser can connect to other visitors.

| Browser | Shell mode | Drop-in mode | Peers | Status |
|---|---|---|---|---|
| Chrome, Edge, Brave on desktop, 110 and later | full | full | yes, after "Share and load" | **Tested** in Playwright Chromium; real Chrome, Edge (sleeping tabs) and Brave (Shields set to aggressive) not yet tested |
| Chrome on Android, 110 and later | full; uploads off until "Share on this network"; site cap 48 MiB on confirmed Wi-Fi, 24 MiB otherwise | full; the copy fills from the host only on confirmed Wi-Fi | download-only by default | Not yet tested (phone layout **tested** in Chromium phone emulation, e2e VIEWPORT) |
| Samsung Internet 21 and later (Chromium 110) | as Chrome on Android | as Chrome on Android | as Chrome on Android | Not yet tested |
| In-app browsers and WebViews on Android | Custom Tabs are Chrome itself; a WebView behaves like Chrome on Android where it has Service Workers and falls back to limited mode where it doesn't | pages from the host, plus the copy where Service Workers exist | depends on the app | Not yet tested |
| Firefox desktop, 115 ESR and later | full | full | yes | Not yet tested |
| Firefox for Android | full; no network type is exposed, so it counts as an unknown network: download-only, 24 MiB cap until the visitor's opt-in | full; the copy fills from peers only until the opt-in | download-only by default | Not yet tested |
| Safari on macOS, 15.4 and later | full | full | yes | engine **tested** as Playwright WebKit 27.2 (cold start W7, download with polyfills 14); Safari itself not yet tested |
| Safari on iPhone and iPad, 15.4 and later | full while the page is on screen; unknown network, so download-only and a 24 MiB cap until the opt-in | full while the page is on screen | download-only by default; peer connections stop within seconds of switching apps or locking the screen | Not yet tested (release gate: iOS 18, and iOS 16 or 17) |
| Other iPhone browsers (Chrome, Firefox, Edge, Brave) | WebKit underneath; Service Workers available to browsers with the default-browser capability | as Safari | as Safari | Not yet tested |
| Home Screen web app on iOS | as Safari, with its own storage: it starts empty and isn't cleared after 7 days without a visit | the same | as Safari | Not yet tested |
| In-app browsers on iPhone (Instagram, Facebook, Gmail, X, LinkedIn) | no Service Worker: limited mode | pages from the host as before | unknown | Not yet tested (Research: [w1-08](research/w1-08-mobile-constraints.md), F-25) |
| Safari with Lockdown Mode | no Service Worker and no WebRTC: limited mode, with the banner "Turn off Lockdown Mode for this website" | pages from the host as before | no | Not yet tested (Research: WebKit's preference table, [03](research/03-webrtc-nat-privacy.md), F-21) |
| Chrome incognito, Edge InPrivate, Brave private window | full; nothing is kept after the window closes | full, same | yes | Playwright contexts work the same way (**Tested**); the real windows not yet tested |
| Firefox private window | full from Firefox 140; limited mode on 115 and 128 ESR (no Service Workers there) | full from 140; pages from the host on ESR | yes | Not yet tested |
| Safari private browsing | full; nothing is kept after closing. WebKit's private sessions refuse to store Blobs in IndexedDB, so the loader stores ArrayBuffers instead | full, same | yes | **Tested** in Playwright WebKit's ephemeral context (the session type Safari uses for private browsing); Safari not yet tested |
| Tor Browser | no WebRTC, no Service Worker: limited mode | pages from the host as before | no | Not yet tested (Research) |
| Brave with "Disable non-proxied UDP" | renders from the host's web seed | pages from the host, the copy from the host | no: no direct candidates ([w2b-03](research/w2b-03-turn-connectivity.md), summary 10) | Research |
| Below the floor | a browser that lacks a required feature gets "Use Safari or iOS 15.4, Chrome, Edge, Samsung Internet or Brave based on Chromium 110, or Firefox 115, or newer."; one that has the features but is older is not supported or tested | the engine stays off with one console line (or the module never runs) and every page loads from the host | n/a | Code |

### What degrades, and how

| Missing | Shell mode | Drop-in mode | Status |
|---|---|---|---|
| Service Worker (Lockdown Mode, in-app browsers, Tor, old Firefox private windows, blocked registration) | **limited mode**: the site renders through `blob:` URLs with "Limited mode: this browser has no offline engine"; no offline copy; the site's scripts can't `fetch()` its files by relative URL; by code reading, form posts are blocked; on Safari and iOS 15.4 to 16.3 (no import maps) a lazy chunk inside a module cycle breaks | pages and files from the host as before; nothing is served from a copy | shell **Tested** in Chromium with Service Workers blocked (e2e 14); drop-in Code |
| WebRTC | "Host only, not sharing": the site loads from the web seed, the ledger doesn't sync with peers | no peers; the copy fills from the host | Code |
| Storage (IndexedDB blocked, quota exceeded) | limited mode for the session | the engine goes off: "browser storage is not available"; the host serves every file | Code |
| A secure context (plain `http://` other than localhost) | stops with "This page must be served over HTTPS (or localhost)" | the engine stays off; the host serves every file | Code |
| Being the top page (the site is framed by another page) | stops with "Open this page directly" | the engine stays off | Code |

### Phones in particular

- **Sharing only while the page is open and on screen.** iOS stops peer connections within seconds of switching
  apps or locking the screen, and Android can do the same ([w1-08](research/w1-08-mobile-constraints.md), summary 2).
  The loader rebuilds its connections when the page comes back after more than 10 seconds hidden.
- **Download-only by default.** Every phone keeps uploads off until the visitor turns on "Share on this network"
  for that site; then uploads are capped at 128 KiB/s. iPhones and Firefox for Android expose no network type, so
  they count as an unknown network.
- **Size caps.** A shell site must fit 48 MiB for a phone on confirmed Wi-Fi and 24 MiB for any other phone, or the
  phone shows "This site is larger than allowed here". Desktop allows 128 MiB.
- **Storage is a cache.** Safari may delete the site's copy after 7 days without a visit, unless the site is added to
  the Home Screen; a Home Screen app has its own storage and starts empty. In 0.3.0 the identity lives at the identity
  page, not in the site, so adding the site to the Home Screen is not a way to keep it, and Settings has no identity export
  (only a build without the identity service keeps the 0.2.1 export and import). Safari may delete the identity page's
  data after 7 days without a visit there: a passkey identity comes back from a site's sealed copy, a passphrase
  identity only from the 12 words or the backup file.
- **Memory.** In desktop Chromium a 128 MiB site raised the tab to about 434 MB while its files were assembled
  (w1-08, summary 5); phone limits weren't measured.

## Features by mode

| Feature | Shell | Drop-in | Hub, per-site subdomain | Hub, shared origin |
|---|---|---|---|---|
| Who serves the HTML | the torrent, in a same-URL frame | your host | the torrent | the torrent, under `/_mw/s/<btih>/` |
| First visit | the whole site downloads (web seed first, peers after consent), then renders | your page from the host; the copy fills at idle | a gate before anything loads, then as shell | a gate, then as shell |
| Host down, returning visitor | the whole site | pages already visited (at most 100, none sent `no-store`) | the whole site | the whole site |
| Host down, new visitor | can't load | can't load | can't load | can't load |
| Seeding while open | yes, one long-lived page | yes, in page-view-sized bursts | yes | yes |
| Site ledger and `mw.db` | yes | yes | yes | yes, but every site on the hub can read and change the others' data |
| Search engines and link previews see your content | no: one loader page for every URL | yes, unchanged | no; hub origins should send `noindex` | no |
| Root-relative URLs, `fetch('/data.json')` | yes | yes | yes | no |
| History-API routers | yes in code, no end-to-end test in SW mode | yes (e2e 10) | as shell | no |
| `_redirects` and `_headers` | compiled into `/.mw/site.json`, applied by the worker (a subset) | your host applies them as today | as shell | as shell |
| The site's own Service Worker | can't run | runs; add two lines to share the copy | can't run | can't run |
| Video and audio with `Range` | 206 slices from the copy (e2e 1) | from the copy once complete, else the host | as shell | as shell |
| Size limit | the whole site within the visitor's cap, or it doesn't load | the copy within the cap; pages load from the host anyway | as shell | as shell |
| Without a Service Worker | limited mode | the site as today | limited mode | limited mode |
| Consent | first-run card | the same card at the bottom of the page, after 3 s on screen | the gate | the gate, which says "Load anyway: this site can read and change everything other sites stored on this hub" |
| Kill switch | yes (e2e 9) | yes (e2e 9) | yes | yes |
| Status | **Tested**: e2e 1 to 7, 12 to 14 | **Tested**: e2e 9, 10, 10B | Code (needs wildcard DNS; no end-to-end test) | **Tested**: e2e 8 (the gate) |

A shared-origin hub has no isolation: sites on it share one browser origin and can access each other's data. It is
for one publisher and demos. A hub that serves many publishers gives each site its own subdomain, with a wildcard
certificate and a Public Suffix List entry ([DEPLOY.md](DEPLOY.md)).

## Hosting providers

No row has been deployed with felinar yet. The cells come from vendor documents and from the research probes of
2026-10-17 against third-party sites on each provider ([w2a-07](research/w2a-07-hosting-cost-bandwidth.md),
[w1-10](research/w1-10-static-hosting-bootstrap.md), [w2a-05](research/w2a-05-seo-crawlers.md)). Prices are list
prices in USD on 2026-10-17; check the vendor's page before you rely on them.

| Provider | HTTPS on your domain | Wildcard (for hubs) | `/mw-sw.js` at the root | Unknown paths | As a cross-origin web seed | Egress price | Use it for |
|---|---|---|---|---|---|---|---|
| [GitHub Pages](recipes/github-pages.md) | yes, Let's Encrypt | no | yes on a user, organisation or custom-domain site; not on a `/<repo>/` project site | your `404.html`, status 404 | `OPTIONS` answered 405; `Range` 206 for browsers; works only without a preflight | free, soft limit 100 GB a month, sites up to 1 GB, no commercial use | shell (same-origin web seed under `/ws/`) and drop-in, non-commercial |
| [Cloudflare Pages](recipes/cloudflare-pages.md) | yes (zone on Cloudflare for an apex) | no | yes | your `404.html`, or SPA mode (200) when the deploy has no top-level `404.html` | no: answers `Range` with 200 and the whole file | free, unlimited static requests; 20,000 files and 25 MiB per file on the free plan | shell host and drop-in host; never the web seed |
| Cloudflare Workers static assets | yes | yes, with Workers routes | yes | configurable (`not_found_handling`) | `Range` unverified | free static requests | shell host, hubs; not covered by a recipe yet |
| [Cloudflare R2](recipes/cloudflare-r2.md) | yes, the zone must be on Cloudflare; `r2.dev` is rate-limited and for development | per hostname | not researched as a site host | n/a | yes once its CORS rules are set; `Range` through the cache not yet verified | $0 egress; $0.015/GB-month; reads $0.36 per million | the recommended web seed for shell sites |
| [S3 and CloudFront](recipes/s3-cloudfront.md) | yes, ACM certificate in us-east-1 | yes, one label | yes | CloudFront error responses or a function | yes with a CORS rule (`AllowedHeaders: ["*"]`) | CloudFront $0.085/GB (first 10 TB, US) and $1.00 per million HTTPS requests, 1 TB and 10 million requests free each month; S3 direct $0.09/GB | shell, drop-in and hub host; web seed with few files |
| [Netlify](recipes/netlify.md) | yes | wildcard certificate with Netlify DNS; a wildcard alias is unverified | yes | your `404.html`, or a `_redirects` rule | no CORS by default; bandwidth costs credits | 20 credits per GB; the free plan's 300 credits (about 15 GB) pause every project when used up | drop-in or shell host on a paid plan; not a web seed |
| [Vercel](recipes/vercel.md) | yes | yes, with Vercel DNS or delegation | yes | your `404.html`, or `vercel.json` rewrites | `OPTIONS` without `Allow-Headers`; works only without a preflight | Hobby: free, 100 GB, non-commercial; Pro $20 a month, then $0.15 to $0.35/GB | shell, drop-in or hub host; not a web seed at scale |
| [Backblaze B2](recipes/backblaze-b2.md) | only through a CDN | through a CDN | no (storage only) | n/a | yes once CORS rules are set (B2 refuses preflights by default); its download hosts speak HTTP/1.1 | $6.95/TB-month; free egress up to 3 times what you store, then $0.01/GB; free through Cloudflare, Fastly, bunny.net and CacheFly | a cheap web seed behind a partner CDN |
| [Bunny Storage and CDN](recipes/bunny.md) | yes, free Let's Encrypt | automatic only with Bunny DNS | not researched as a site host | storage can rewrite 404 to 200 | `Range` 206 measured; CORS by file extension or an edge rule; preflight unverified | $0.01/GB in Europe and North America, $0.03 Asia, $0.045 South America, $0.06 Middle East and Africa; $1 a month minimum | a web seed for little money |

How to read the web seed column:

- **Drop-in mode doesn't need it.** The drop-in worker reads your own host same-origin and slices files itself, so
  CORS and `Range` don't apply; only the egress price and unchanged bytes matter
  ([w2a-07](research/w2a-07-hosting-cost-bandwidth.md), F4). Any host that serves the site works, Cloudflare Pages
  included.
- **A web seed on the loader's own host needs no CORS**, only `Range` answered with 206 (shell mode with
  `--ws https://example.com/ws/`).
- **A cross-origin web seed needs CORS and `Range`.** Since v0.2.1 the loader's web-seed requests carry only a
  `Range` header, and Chromium 156 and WebKit 27.2 then send no preflight at all (e2e PUBLISH-WS). How Firefox and
  Safari treat that request wasn't measured, so `check-webseed` requires a working preflight by default;
  `--allow-no-preflight` accepts a host that can't answer one, such as GitHub Pages or Vercel.
- **Never use as a web seed**: jsDelivr (wrong bytes as 206), cdnjs and Cloudflare Pages (200 for `Range`), public
  IPFS gateways (`ipfs.io` and `dweb.link` answer 429 or a challenge) and Storacha, now Fil One, which has no public
  buckets ([w2a-07](research/w2a-07-hosting-cost-bandwidth.md), R3 tier 3).

Picking a host by profile ([w2a-07](research/w2a-07-hosting-cost-bandwidth.md), R16): a small non-commercial site
on GitHub Pages or Cloudflare; a small commercial site on Cloudflare Pages or Workers static assets, or a paid
Netlify or Vercel plan; an AWS shop on S3 and CloudFront; a hub with wildcard origins on CloudFront, Vercel or
Cloudflare Workers routes, never Cloudflare Pages or GitHub Pages. Run `check-site` (and `check-webseed` for a
cross-origin web seed) against whatever you choose.

## Frameworks and site generators

"Research lab" means the research built the tool's default output and ran it through a model of the v0.2 serving
rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), section 7); the shipped
loader hasn't served these builds. The recipes give the exact settings.

| Tool (version researched) | Drop-in | Shell | Settings that matter | Known issues | Status | Recipe |
|---|---|---|---|---|---|---|
| Hugo 0.168.0 | strong | works, not indexable | `baseURL` = the final origin; keep `relativeURLs` off; `enableRobotsTXT = true` | `integrity=` on assets breaks under any byte rewrite; canonical and Open Graph URLs carry `baseURL` | Research lab | [hugo](recipes/hugo.md) |
| Jekyll 4.4.1 | good at a root or custom domain | not tested | `url` = the final origin, `baseurl: ""` | GitHub Pages sends no custom headers | Not yet tested (documents only) | [jekyll](recipes/jekyll.md) |
| Eleventy 3.1.7 | strong | works | `pathPrefix: "/"` | none found | Research lab | [eleventy](recipes/eleventy.md) |
| Astro 7.4.0 | strong | works | `site` = the final origin, `base: "/"`, `trailingSlash` and `build.format` matching the host | client-router soft navigations rely on the shell's history mirroring | Research lab | [astro](recipes/astro.md) |
| Next.js 16.4.2, static export | strong | works | `output: 'export'`, `images: { unoptimized: true }`, `trailingSlash` matching the host | `404.html` must be answered with 404; server features are absent from an export | Research lab | [nextjs-export](recipes/nextjs-export.md) |
| Nuxt 4.6.2 | strong with `ssr: true` (`nuxt generate`) | works | `ssr: true` | `ssr: false` gives an empty page to crawlers | Research lab | [nuxt](recipes/nuxt.md) |
| Gatsby | unknown | unknown | the generic recipe | `gatsby-plugin-offline` registers its own Service Worker | Not yet tested (not researched) | [gatsby](recipes/gatsby.md) |
| SvelteKit 3.1.0 with adapter-static 4.0.0 | strong | works | prerender every route; a `fallback` page only for SPA builds | nothing failed in the lab | Research lab | [sveltekit-static](recipes/sveltekit-static.md) |
| Docusaurus 3.10.2 | strong | works | `url` = the final origin, `baseUrl: '/'`, an explicit `trailingSlash` | `alert()` and `confirm()` in the bundle are ignored in shell mode; a hash router isn't indexable | Research lab | [docusaurus](recipes/docusaurus.md) |
| MkDocs 1.6.1 with Material 9.7.7 | strong | works | `site_url` = the final origin, `use_directory_urls` matching the host, `theme.font: false` | Google Fonts is a third party; source maps only make the torrent bigger | Research lab | [mkdocs](recipes/mkdocs.md) |
| Vite 8.3.4 with React Router 8 (single-page app); Create React App | medium: the host must answer deep links, and crawlers see an empty page until you prerender | good | `base: '/'` | Create React App is deprecated | Research lab (Vite); not yet tested (Create React App) | [vite-spa](recipes/vite-spa.md) |
| Angular 22.2.3 | medium | good | `ng build --base-href /` | it ships a `<base href>`; its own Service Worker (`ngsw`) needs the two-line integration | Research lab | [angular](recipes/angular.md) |
| WordPress through Simply Static 3.8.18 or Staatic 1.14.0 | strong, after export | only for sites that don't need search traffic | Absolute URLs, pretty permalinks | comments, forms, search, shop and login are lost | Not yet tested (exporter documents and source) | [wordpress-static](recipes/wordpress-static.md) |

Generic recipe for any tool ([MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), section 7): build at the origin root
with the final HTTPS origin configured, so canonical, Open Graph and sitemap URLs are absolute and correct; publish
with `--dropin` if the site wants search traffic; keep the host's 404 page and redirects; turn build telemetry off in
CI (`NEXT_TELEMETRY_DISABLED=1`, `ASTRO_TELEMETRY_DISABLED=1`, `NUXT_TELEMETRY_DISABLED=1`, `NG_CLI_ANALYTICS=false`).

## CMS and hosted builders

| Platform | Path | Status |
|---|---|---|
| WordPress (self-hosted) | export with Simply Static or Staatic, publish the export with `--dropin` ([recipe](recipes/wordpress-static.md)) | Not yet tested |
| WordPress.com below the Business plan | a `wget --mirror` of the site, then the same; run the mirror on Linux | Not yet tested |
| Ghost | export with `ghost-static-site-generator` or a Content-API exporter ([MIGRATION.md](MIGRATION.md#ghost)) | Not yet tested |
| Drupal | export with Tome ([MIGRATION.md](MIGRATION.md#drupal-with-tome)) | Not yet tested |
| Ghost(Pro), Squarespace, Wix, Webflow as live hosts | no drop-in: the research found no way to serve `/mw-sw.js` at the root on any of them; re-platform the content first | Research |
| Shopify, Joomla, Tilda, Duda, Blogger, GoDaddy's builder | not researched: treat as not supported | n/a |

## Features that need a server

Every dynamic feature of a migrated site falls into one of four classes
([DIGEST-AMENDMENTS.md](review/DIGEST-AMENDMENTS.md), F1; the full table is in
[MIGRATION.md](MIGRATION.md#dynamic-features-and-their-replacements)):

| Class | Examples |
|---|---|
| **Works now** with the site ledger and the SDK | comments and guestbooks on the ledger (`--policy open`), Pagefind search, per-visitor reactions counted by your page, local preferences |
| **Needs new code** | a dedicated reaction operation, an approval queue, lazy media, live rooms, a sealed contact inbox |
| **Third party from the browser** | form relays, newsletter embeds, Stripe Payment Links and Buy Button, opt-in cookieless analytics |
| **Stays on a server** | sending e-mail, payment webhooks and checkout sessions, secrets, accounts and per-user content, rate limits by IP, cron jobs |

Rules that hold in every mode: visitors can write to the ledger only when you publish with `--policy open` or `allow`
(the default lets only the owner and moderators write); a value is at most 2 KiB and the ledger 8 MiB unless you raise
it; everything written is public and copied to every visitor; and no personal data goes into the ledger, even
encrypted (EDPB Guidelines 02/2025, [w2a-03](research/w2a-03-dynamic-feature-replacements.md), F25).

## Network conditions

felinar uses WebRTC with STUN only: it ships no relay (TURN) servers. A visitor who can't reach peers loads from
the host's web seed instead, so the site still loads; only sharing is lost.

| Condition | What happens | Source |
|---|---|---|
| Both visitors behind ordinary home routers | a direct connection after the visitor's consent | Research ([w2b-03](research/w2b-03-turn-connectivity.md), F-03) |
| One side behind a hard NAT (mapping that varies by destination) and the other not reachable | the pair fails without a relay; both keep loading from the host. A peer with a public address or an easy NAT connects to everybody, so one always-on node on a public address (`tools/pin.mjs`) helps | Research (w2b-03, F-03) |
| How many pairs fail | no rigorous recent measurement exists; vendors estimate that 10 % to 30 % of sessions need a relay, more on corporate networks and carrier-grade NAT | Research (w2b-03, F-01) |
| UDP blocked (some corporate networks, Brave's "Disable non-proxied UDP") | no peers; the host serves everything | Research (w2b-03, summary 10) |
| Mobile data or Save-Data | download-only; a drop-in copy fills from peers only; 24 MiB cap; a soft cap of 4 peer connections per site | Code (ARCHITECTURE section 8) |
| A phone whose network type is unknown (every iPhone, Firefox for Android) | treated like mobile data until the visitor turns on "Share on this network" | Code |
| A phone in the background or locked | peer connections stop within seconds; the loader rebuilds them when the page is back on screen | Research (w1-08, summary 2) and Code |
| A hidden desktop tab | keeps sharing; on battery the client is destroyed after 10 minutes hidden | Code |
| A STUN server that doesn't answer | each offer waits at most 1.5 s instead of stalling about 5 s per announce | Code (the 5 s stall is Research, w2b-03 summary 6) |
| A tracker that drops its connection | the loader announces again within seconds (1.3 to 1.6 s in the loopback runs of e2e PEER-BLIP), not minutes | **Tested** |
| Trackers unreachable or blocked by a filter list | no peers; the web seed still loads the site. Whether filter lists block the default public trackers has not been checked | Not yet tested |
| Few visitors online at once | the host carries nearly every byte: in the research model a 5 MB site got 0.0 % of first-visit bytes from peers at up to 30,000 visits a day | Research (model, [w2a-07](research/w2a-07-hosting-cost-bandwidth.md), F23) |
| IPv6 on mobile networks | many carriers are above 90 % IPv6-capable; the effect on connection success wasn't measured | Research (w2b-03, summary 9) |

The economics behind the last rows are in [WHY.md](WHY.md#honest-economics).

## v0.3: key storage and the compatibility matrix

> **Status: v0.3, built and reviewed.** The tables below come from the v0.3 design review
> ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), cited "R"; 2.12 and 2.13). They say what the design
> expects of each browser and how well that is known. Nothing in them is a field result. The sections above describe
> the parts of 0.3.0 that came before v0.3.

Labels, as the design review uses them:

| Label | Meaning |
|---|---|
| **lab** | verified in the w2c-03 research lab, in Playwright Chromium 156 or WebKit 27.2, over loopback. Not a real device |
| **flag only** | only the browser's own capability report (`getClientCapabilities`) was read; no authenticator was exercised, because WebKit has no virtual authenticator |
| **untested** | nobody has run it |
| **not run** | Firefox. Since 2026-10-22 the automated harness runs Playwright Firefox 157.0 on loopback ([deviations/firefox.md](deviations/firefox.md)), but the cells below were not re-checked there, so every Firefox cell is "not run" and never "pass" until someone runs it. A version in brackets is a claim from MDN browser-compat-data or the review's research that nobody re-checked |
| **expected** | what vendor documentation says, without a run. It is not a result |
| **ITP** | Safari deletes an origin's script-writable storage after 7 days of Safari use without interaction with that site, unless the site is a Home Screen app (webkit.org/tracking-prevention, accessed 2026-10-20, as cited in R 2.2.5) |

"MDN BCD" figures are as the design review's honesty judge cited them; they were not re-fetched, and the gate must
confirm them before anyone quotes them as fact. **The floor** is Safari and iOS 15.4, Chromium 110 and Firefox 115
(INTERFACES header; [the floor above](#the-floor)). Every untested cell is a gate row of
[DEMO-RESULTS.md](DEMO-RESULTS.md) or a forced-fallback test that deletes the feature locally (R 2.13).

### Key storage per browser

The identity origin holds the wrapped root and vault; a site origin holds only the working keys of its own label.

| Item | Where | Chromium desktop | Android Chrome | Safari on macOS | iOS Safari | iOS Home Screen app | Firefox | Notes |
|---|---|---|---|---|---|---|---|---|
| Wrapped root and wrapped vault | the identity origin's IndexedDB | expected persistent | expected persistent | ITP: deleted after 7 days of Safari use without interaction with the identity origin | the same | not shown to be exempt: the exemption covers a Home Screen app's own site (webkit.org/tracking-prevention, via R 2.2.5), and 0.3.0 no longer offers the identity page for the Home Screen, so nothing shows that adding a site there keeps the identity origin's data; untested until row G-ID-1 | not run (expected persistent) | escrow copies on site origins ([PRIVACY.md](PRIVACY.md#what-stays-on-the-device-v03)) |
| Working keys of a label | site origin memory; IndexedDB as non-extractable `CryptoKey`s only with "Stay signed in" | expected yes | untested | lab (w2c-03) | `DataCloneError` failures reported by a research claim: memory only, fetched again from the identity origin with one tap | the same as iOS Safari until row G-ID-1 | not run | a self-test at import (put, get, sign, verify, ECDH) picks the path |
| Escrow blobs (opaque) | site origin IndexedDB | expected yes | expected yes | ITP | ITP | exempt | not run (expected yes) | |
| Local caches (history if kept, seen-set, contacts cache) | site origin IndexedDB, sealed under a local key from the bundle | expected yes | expected yes | ITP | ITP | exempt | not run (expected yes) | |
| Playback keys | Service Worker memory | expected yes | untested | lab | untested (row G-MD-6) | untested | not run | falls back to raw bytes over the worker's port |
| File and media chunks | site origin IndexedDB (ciphertext for private items) | expected yes | expected yes | ITP | ITP | exempt | not run (expected yes) | inside the storage budget ([ARCHITECTURE.md](ARCHITECTURE.md), 15.10) |
| Passkey | the platform or a password manager | expected yes | Google Password Manager | iCloud Keychain | iCloud Keychain | the same | not run (the provider) | the provider is a recipient ([PRIVACY.md](PRIVACY.md#the-recipients-register-v03)) |

Firefox private windows and Tor Browser were not examined; both default to "this visit only" when IndexedDB is
unavailable. Tor Browser does not run WebRTC (R's research, to be confirmed from a primary source), so in Tor Browser a
person can sign in and read and cannot chat or fetch from peers.

### Compatibility matrix with fallbacks

Floors are Safari and iOS 15.4, Chromium 110 and Firefox 115. Where the review names the version that introduced a
feature, the floor cell says "absent" if the floor is older; where it names none, the review's single statement for
"the floor" is repeated.

| Capability | Safari and iOS 15.4 (floor) | Chromium 110 (floor) | Firefox 115 (floor) | Chromium 156 | WebKit 27.2 | Firefox now | Fallback |
|---|---|---|---|---|---|---|---|
| WebCrypto ECDSA and ECDH P-256, HKDF, AES-GCM | expected, untested | expected, untested | not run | lab | lab | not run (did not launch) | `E_UNSUPPORTED`; read-only |
| JWK `{d, x, y}` import as non-extractable | untested | untested | not run | lab | lab | not run | memory-only working keys |
| A top-level popup with `opener` messaging | untested | untested | not run | untested | untested | not run | redirect round trip (R 2.3.1); row G-ID-7 |
| Third-party iframe storage | not checked | not checked | not run | partitioned per top-level site (vendor documentation, not re-checked) | the same | not run | the reason the identity origin is a top-level window and never a frame |
| Passkey PRF | absent | absent | not run (absent at the floor, per R) | lab (`getClientCapabilities` reports prf) | flag only | not run (reported 139+ on macOS) | the identity origin's passphrase, then "this visit only" |
| `getClientCapabilities` | absent (arrives in Safari 17.4) | absent (arrives in Chrome 133) | not run (arrives in Firefox 135, MDN BCD) | yes | yes | not run (MDN BCD: 135+) | detect PRF from `getClientExtensionResults().prf.enabled` after `create()` |
| WebAuthn `largeBlob` | untested | untested | not run | untested | untested | not run | escrow blobs |
| Related Origin Requests | absent (arrives in Safari 18, MDN BCD) | absent (arrives in Chrome 128, MDN BCD) | not run (treated as no) | yes | yes | not run (treated as no) | not needed: one RP ID at the identity origin |
| `'wasm-unsafe-eval'` | absent (arrives in Safari 16, MDN BCD) | no gap named | not run | yes | 16 and later | not run (expected yes) | PBKDF2 at the identity origin, named on the card |
| `navigator.userActivation` | absent (arrives in Safari 16.4, MDN BCD) | no gap named | not run (arrives in Firefox 120, MDN BCD) | yes | yes | not run (MDN BCD: 120+) | the identity origin's own button; no forwarded activation |
| Camera QR scan (`BarcodeDetector`) | absent (MDN BCD) | no gap named | not run (absent, MDN BCD) | yes | no | not run (MDN BCD: absent) | a bundled JavaScript decoder; a camera-denied string; a typed code as the last resort |
| A Service Worker streaming `206` for media | untested | untested | not run | untested | lab: a desktop run plays MP4 with `Range` from the worker (e2e 1); iOS Safari not verified (rows G-MD-2, G-MD-3) | not run | a Blob URL up to the class cap |
| Canvas re-encode (`toBlob`, JPEG) | expected | expected | not run | yes | yes (the media lane exercised image stripping in Chromium only) | not run (expected yes) | refuse a public upload of that image |
| `createImageBitmap` with resize options | untested | untested | not run | yes | untested | not run | decode through an `<img>` on a path with no worker, under the pixel cap |
| WebRTC | yes | yes | not run (expected yes) | yes | yes | not run (expected yes) | none in Tor Browser (stated) |

Things the landed code adds to these tables (lane notes, not results):

- **Passphrase wrapping** runs as plain JavaScript Argon2id, so the identity origin does not need `'wasm-unsafe-eval'`
  for it today; the PBKDF2 fallback exists and is named in the header. Measured on an Apple M3: Argon2id (64 MiB, 3
  passes) 1.3 to 2.5 s in Node, Chromium and WebKit; PBKDF2 with 600,000 iterations 57 ms in Node. Phones and iOS 15.4
  are not measured (row G-ID-6) ([deviations/idcore.md](deviations/idcore.md)).
- **Playback keys.** The media lane assumes a `CryptoKey` can be cloned into the Service Worker, and switches to raw bytes
  over the worker's port on a `DataCloneError`; both paths are covered by Node tests. Browsers are row G-MD-6
  ([deviations/media.md](deviations/media.md)).
- **Cross-origin isolation.** A site whose routing sets `Cross-Origin-Opener-Policy: same-origin` signs in through the
  redirect round trip, not a popup.

Rows of the matrix that need a person with a device are in [DEMO-RESULTS.md](DEMO-RESULTS.md) (G-ID-1 to G-ID-8, G-MD-2
to G-MD-7).

## v0.3 C2: background behaviour, calls and the zero-setup ladder

> **Status: v0.3 C2, built and reviewed.** Built and integrated on 2026-10-20 (loopback tests only: Chromium 156 and WebKit 27.2, e2e E-PS-*,
> E-CL-*, E-ZS-1, DOOR-*; [deviations/integration-c2.md](deviations/integration-c2.md)). What each platform allows or forbids for the features of phase C2: smart seeding on phones, dock
> mode, peer-to-peer calls and the rungs without a domain ([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), "SZ",
> section 1.1; [S1](research/v03/S1-smart-phone-seeding.md) F1 to F4; [S2](research/v03/S2-zero-setup-hosting.md)). Nothing here is a field result: no phone has been
> tested ([DEMO-RESULTS.md](DEMO-RESULTS.md), rows G-PS, G-ZS and G-CL). Browser only: nothing asks a member to install anything.

Labels used in this part: **documented** (a vendor, standards or bug-tracker page that the research opened; the id resolves in "Sources, C2" below),
**reported** (a bug report or a community report, not verified), **lab** (measured on 2026-10-20 in the
[c2-calls-lab](research/labs/c2-calls-lab/README.md): Playwright 1.64.1, Chromium 156 and WebKit 27.2, over loopback, no real device), **inference** (no source
says it) and **untested**. "MDN data" is MDN browser-compat-data as the research read it; it was not run on a device.

### Platform behaviour

| Platform | Allows | Forbids or lacks | Label |
|---|---|---|---|
| iOS Safari tab | Screen Wake Lock since 16.4 [ST1] | the page is suspended 20 s after WebKit's prepare-to-suspend message [WK6], and then networking stops [AP1: Apple's statement about apps, applied to the web process by inference]; no Background Sync, Periodic Sync or Background Fetch [ST1]; no battery or network API [WK5]; tab storage deleted after 7 days unused [WK5] | documented, inference |
| iOS Home Screen web app | Web Push since 16.4 [WK2, WK3]; Wake Lock since 18.4 [WK3, ST1]; exempt from the 7-day deletion [WK5] | the same suspension rules (inference: no source gives it more background time); every push must show a notification [WK1] | documented, inference |
| iOS during a call | a page capturing the microphone "will not get suspended if in the background" (a WebKit engineer, 2020-03-23) [WKB1] | video stops in the background; Home Screen apps "lose the microphone as soon as they go into background (or screen locked)" (a report of 2023-12-26, open) [WKB2]; a phone call mutes capture [WKB1] | documented, reported |
| Android Chrome tab | `getBattery`, `connection.type` and `saveData` [ST1]; one-off Background Sync (Chrome 49 and later) [ST1] | cached processes "may receive limited or no execution time" (Android 13 and later) [AN2]; Doze suspends the network when the phone is unplugged, still and dark [AN1]; what Chrome does to an open data channel when the screen goes off is unmeasured (G-PS-3, G-CL-3) | documented, untested |
| Android installed web app | Periodic Sync, only when installed, "a few minutes at a time" [CH1]; Background Fetch (Chrome 74 and later) [CH2, ST1] | as the tab; the only official Background Fetch page (2018) says it "currently only accepts requests without a body", and a later change is unverified | documented |
| Desktop Chromium | a hidden page with an open data channel escapes intensive timer throttling [CH3]; Chrome 133 and later Energy Saver freezing of hidden CPU-heavy tabs exempts it too, platform unnamed [CH5] | nothing after the browser closes or the laptop sleeps | documented |
| Firefox for Android | | `getBattery` removed in Firefox 52 and the network type in 99 [ST1] | documented |
| Service Worker, every platform | short HTTP event handlers: fetch, push, sync, background fetch | `RTCPeerConnection` is `[Exposed=Window]` (W3C WebRTC Recommendation of 2025-03-13) [ST2]: a Service Worker cannot seed, relay, hold or ring | documented |

### Capabilities the C2 features use

| Capability | Where it is, and what the sources say | Lab (Chromium 156 / WebKit 27.2) | What the loader does |
|---|---|---|---|
| `getUserMedia` (microphone, camera) | on iOS see the call rows above; Android with the screen off is unmeasured; desktop untested | Chromium gives fake devices only with both `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`: the second flag alone granted the machine's real camera and microphone. WebKit gives mock devices under context permissions, and a second capturing page of one browser mutes the first | audio only on a metered or unknown network; muted or ended tracks are re-acquired with `replaceTrack` when the page is visible again [WKB1; WKB3 was seen as a search result only]; the card says `call.paused`; `E_MEDIA_DENIED` and `E_NO_DEVICE` |
| `getDisplayMedia` (screen share) | MDN data: Chrome 72, Firefox 66, Safari 13, iOS Safari 27 (unverified on a device); Chrome and Firefox for Android: none [BCD]. At the floor, iOS Safari 15.4 lacks it | Chromium: a fake 1280x720 monitor without a gesture. WebKit: one run refused it outside "a user gesture handler", and a separate check (3 of 3) succeeded without a click: do not rely on it | called inside the click handler; the screen button is hidden where the API is missing |
| Media Session `togglemicrophone` and `togglecamera` | | ok / ok | set where supported |
| Media Session `hangup` | | ok / TypeError | set only where it works (Chromium in the lab) |
| Media Session `enterpictureinpicture` | | ok / TypeError | not used in C2 |
| Document Picture-in-Picture | | present / absent | desktop Picture-in-Picture calls are P1 (SZ section 4) |
| `navigator.audioSession` | W3C Editor's Draft of 2024-11-13 (S1 ST3) | absent / present | never written (ARCHITECTURE 8.1.9): the audio-session trick is rejected |
| Screen Wake Lock | iOS Safari 16.4 and Home Screen 18.4 [ST1]; the only documented way to keep a page in the foreground (S1 F2) | present / present | dock mode and a visible video call only; dock mode is unavailable where it is missing |
| Background Sync | iOS none [ST1]; Android Chrome, one-off, since Chrome 49 [ST1] | | **(proposed, P3)**: nothing yet; it would retry HTTP requests only (ARCHITECTURE 8.1.8), and nothing depends on it |
| Periodic Sync | iOS none [ST1]; Android Chrome only for an installed app, "a few minutes at a time", and not fired at all unless the engagement score is above zero [CH1] | | **(proposed, P3)**: nothing yet; it would refresh the pointer and the `cs=` snapshot over HTTP and never open a peer wire |
| Background Fetch | iOS none [ST1]; Chrome 74 and later; the only official page (2018) says it "currently only accepts requests without a body", and a later change is unverified [CH2] | | **(proposed, P3)**: nothing yet; it would download web-seed bytes over HTTP and never open a peer wire |
| Battery Status API | iOS none [WK5]; Android Chrome 38 and later; Firefox for Android removed; desktop Chromium only [ST1] | | where it is missing the person declares "My phone is plugged in" |
| Network Information API | iOS none [WK5]; Android Chrome `connection.type` 38 and later and `saveData` 65 and later; Firefox for Android removed (type, in 99); Chrome desktop: ChromeOS only; Wi-Fi is "a poor proxy" for unmetered [AN8] | | where it is missing the person declares "I am on Wi-Fi"; the four classes of ARCHITECTURE section 8 stay |
| Candidate pair type (`getStats`) | on all browsers; `networkType` was deprecated for privacy (search result only) | | `isLocalPair` decides a local wire; local wires sit outside the month cap |

### What "reliable" can mean, per platform

From S1 D9. It says what the C2 features can honestly promise.

| Platform | Reliable can mean | Reliable cannot mean |
|---|---|---|
| iOS Safari tab or Home Screen app | the member's post reaches a pin while the page is visible (G-PS-8); what they read stays on the device (7 days of no use in a tab, exempt in a Home Screen app); labels tell the truth | seeding with the screen locked or the page hidden for more than about 20 s; waking the page; any battery or network signal |
| Android Chrome tab or installed app | the same, plus a charging window in dock mode (Doze ends on a charger) and battery and network gating | seeding with the screen off and unplugged; Periodic Sync as a seeder (it makes HTTP requests only); every phone maker's battery manager behaving |
| Desktop tab | seeding while the tab stays open | surviving a closed browser or a sleeping laptop |
| A pin node (the owner's or a hub's) | always on while the machine is on and reachable: the durability tier | surviving a switched-off machine or an operator who removes it |

### The rungs without a domain

SZ 3.2 and S2 give the ladder; this table says where each rung works. The F-numbers are findings of S2.

| Rung | Works in | Limits |
|---|---|---|
| 0 try (`npm run demo`) | any browser on the same computer, at `localhost` | this computer only; open `localhost`, not `127.0.0.1` |
| 1 share on my LAN (mkcert) | phones that trust the local authority | Service Workers need a secure context (https, `localhost`, `127.0.0.0/8`, `::1` or `*.localhost`), so `http://192.168.x.x` fails (F10); iOS trusts an installed root only after Settings, General, About, Certificate Trust Settings; Android 7.0 and later apps trust only system authorities by default (F10); routers with DNS rebinding protection drop the private answer for `192-168-1-20.nip.io` (F11); Wi-Fi client isolation could block phone to laptop traffic (unmeasured) |
| 1 share on my LAN (Android over USB) | one Android phone | `adb reverse tcp:8080 tcp:8080` and `adb reverse tcp:8000 tcp:8000` |
| 2a rented server, `nip.io` or `sslip.io` name | any browser | ports 80 and 443 must be reachable (HTTP-01 and TLS-ALPN-01, F7); Let's Encrypt allows 50 certificates per registered domain per 7 days and 5 per exact name set (F5); neither name is on the Public Suffix List, so sibling names are same-site (F4); one DNS filter list names `sslip.io` and not `nip.io` (F6); an identity page on an IP origin gets no passkeys and offers the passphrase card instead (reported, F8; identities still work); a home connection behind carrier-grade NAT cannot be reached (F12: 10% of the ISPs tested, 2017) |
| 2b GitHub Pages | any browser | shell mode passes with a same-origin web seed (`Range` answers 206); no custom headers; 1 GB, a 100 GB a month soft limit, no commercial sites (F14) |
| 2b Cloudflare Pages | any browser | cannot be the web seed: it answers `Range` with 200 (F14) |
| 2b Netlify Drop, Surge, Codeberg Pages | any browser | Netlify measured earlier with 206; Surge and Codeberg Pages unverified (F14) |
| Tunnels (not started by any tool) | any browser | a quick tunnel renames itself on every run, the provider decrypts, and it has "no uptime guarantee" (F13) |

The signed address record is the only pointer on rungs 0 to 2, and it expires (ARCHITECTURE section 4): after its date new visitors cannot load the site
until the owner publishes again.

### Sources, C2

Read 2026-10-20; the ids resolve in S1 and SZ section 7.

- [BCD] MDN browser-compat-data, `api/MediaDevices.json`: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/MediaDevices.json
- [WKB1] WebKit bug 204681: https://bugs.webkit.org/show_bug.cgi?id=204681. [WKB2] WebKit bug 239602: https://bugs.webkit.org/show_bug.cgi?id=239602. [WKB3] WebKit bug 208516
  (a search result only): https://bugs.webkit.org/show_bug.cgi?id=208516
- [WK1] https://webkit.org/blog/12945/meet-web-push/. [WK2] https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/. [WK3]
  https://webkit.org/blog/16574/webkit-features-in-safari-18-4/. [WK5] https://webkit.org/tracking-prevention/. [WK6]
  https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/ProcessThrottler.cpp. [AP1] https://developer.apple.com/forums/thread/799259
- [ST1] MDN browser-compat-data, `api/` (SyncManager, PeriodicSyncManager, BackgroundFetchManager, WakeLock, BatteryManager, NetworkInformation):
  https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/. [ST2] https://www.w3.org/TR/webrtc/
- [CH1] https://developer.chrome.com/docs/capabilities/periodic-background-sync. [CH2] https://developer.chrome.com/blog/background-fetch. [CH3]
  https://developer.chrome.com/blog/timer-throttling-in-chrome-88. [CH5] https://developer.chrome.com/blog/freezing-on-energy-saver
- [AN1] https://developer.android.com/training/monitoring-device-state/doze-standby. [AN2]
  https://developer.android.com/guide/components/activities/process-lifecycle. [AN8]
  https://developer.android.com/develop/connectivity/network-ops/reading-network-state
- The lab: [c2-calls-lab](research/labs/c2-calls-lab/README.md) (`probe.mjs`, `results-2026-10-20.json`).

## Known limitations

Each item says where the work is tracked. Report a failure on a real device as an issue with the `needs-device`
label ([CONTRIBUTING.md](../CONTRIBUTING.md)).

1. **No real-device results.** iOS, Android, Samsung Internet, Firefox and Safari wait for the release gate
   ([DEMO-RESULTS.md](DEMO-RESULTS.md); [ROADMAP.md](ROADMAP.md), 1.0).
2. **No sub-path deployments.** A site must sit at the root of its origin; `--base` for drop-in is planned with the
   migration tooling ([ROADMAP.md](ROADMAP.md), 1.0).
3. **Drop-in copies can multiply host egress.** A budgeted, peer-first copy isn't built ([ROADMAP.md](ROADMAP.md),
   1.0; [MIGRATION.md](MIGRATION.md#egress-budget-for-copies-not-page-views)).
4. **A new drop-in version isn't filled from the previous one on the device** ([ROADMAP.md](ROADMAP.md), "Left open by
   code review round 1").
5. **No relay servers.** Pairs behind hard NATs don't connect; TURN with short-lived credentials is under "Later" and
   starts with a measurement ([ROADMAP.md](ROADMAP.md)). v0.3 makes a relay an owner option (`publish --turn`) that
   is off by default ([DEPLOY.md](DEPLOY.md#turn-off-by-default)).
6. **Shell sites download whole before they render**, within 128, 48 or 24 MiB; streaming media before completion
   is a non-goal of v1 ([ARCHITECTURE.md](ARCHITECTURE.md), section 2).
7. **No single lint report.** `publish` checks paths, size and secrets, but not scripts, third-party hosts or
   routing rules, and it skips unsupported `_redirects` lines without a message
   ([MIGRATION.md](MIGRATION.md#not-checked-yet-look-yourself)).
8. **Untested integrations:** a module Service Worker that imports `sw-core.js` ([ROADMAP.md](ROADMAP.md), Next),
   Workbox, a drop-in to shell switch on one origin, a router in shell SW mode, and every framework and host on this
   page.
9. **Dialogs are ignored in shell mode** (no `allow-modals` in the frame's sandbox); whether to allow them is an open
   decision ([MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), M60).
10. **Limited mode is limited:** no offline copy, no relative `fetch()`, form posts blocked by code reading, and a
    module-cycle limit on Safari and iOS before 16.4.
11. **Hubs:** the per-site subdomain hub has no end-to-end test; a shared-origin hub has no isolation and is for one
    publisher and demos. A hub operating layer is on the [roadmap](ROADMAP.md) under 1.0.
12. **A visitor's consent choice can be lost** on a reload in the instant after "Share and load"; the card then asks
    again ([ROADMAP.md](ROADMAP.md), "Left open by code review round 1").
13. **Identity durability:** Safari may clear the posting identity after 7 days without a visit; a recoverable
    identity is planned ([ROADMAP.md](ROADMAP.md), 1.0). The v0.3 identity origin, escrow copies and recovery
    kit address this (built, not yet run on real devices); see the key-storage table below.
14. **Hosts:** none has been deployed end to end; `Range` through R2's cache is unverified
    ([w2a-07](research/w2a-07-hosting-cost-bandwidth.md), open question 1).
15. **Crawlers:** what Google's renderer does with Service Workers comes from secondary reports
    ([MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md), V22); drop-in fails open either way.
16. **Phones are not seeders of record (v0.3 C2).** A phone shares only while the page is on screen, and in dock mode while the screen
    stays on; a closed or suspended page seeds, relays, holds and rings nothing, and no website can wake it. Durability needs a pin node
    ([the C2 platform tables](#v03-c2-proposed-background-behaviour-calls-and-the-zero-setup-ladder); rows G-PS-1 to G-PS-4).
17. **Calls need the page open (v0.3 C2).** iPhone call video stops when the page is left, a Home Screen app can lose the microphone, Android
    browsers cannot share the screen, and a call rings only while the callee has the site open (rows G-CL-2, G-CL-3 and G-CL-6).

## Sources

- Specification: [ARCHITECTURE.md](ARCHITECTURE.md) sections 1 (facts), 3 (modes), 5.1 (floor), 7.4 (limited mode),
  8 (policy).
- Test results: [INTEGRATION-STATUS.md](INTEGRATION-STATUS.md); the release gate: [DEMO-RESULTS.md](DEMO-RESULTS.md).
- Research: [MIGRATION-DIGEST.md](research/MIGRATION-DIGEST.md) (sections 5, 7 and 11),
  [w1-08](research/w1-08-mobile-constraints.md) (mobile), [w2a-07](research/w2a-07-hosting-cost-bandwidth.md) (hosts,
  prices of 2026-10-17, offload model), [w2b-03](research/w2b-03-turn-connectivity.md) (connectivity),
  [03](research/03-webrtc-nat-privacy.md) and [04](research/04-service-worker-serving.md) (WebRTC and Service Worker
  availability).
