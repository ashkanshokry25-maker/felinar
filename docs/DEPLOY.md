# Deploying a felinar site

This page takes a published site from `dist-publish/` to a live host. It covers what the host must do, recipes
for four hosts, a rented server with no domain, the DNS record at four DNS providers, the deploy order, updates,
rollback, the kill switch, takedown, your own tracker and pin node, CI, and what it all costs. How to build and publish is in
[QUICKSTART.md](QUICKSTART.md) and [RUNBOOK.md](RUNBOOK.md). Day-2 work (monitoring, incidents, abuse notices,
privacy requests) is in [OPERATIONS.md](OPERATIONS.md). The rules behind all of it are in
[ARCHITECTURE.md](ARCHITECTURE.md).

> [!IMPORTANT]
> No recipe on this page has been run end to end against a real account, for 0.3.0
> or before it. The release gate on real hosts and devices ([DEMO-RESULTS.md](DEMO-RESULTS.md)) hasn't run yet. The recipes follow vendor
> documentation as read for the research digests (dates are given) and the behaviour of the tools in this
> repository. Whatever host you choose, `check-webseed` and `check-site` are the test: run them before you
> switch the pointer and after every deploy.

`npx felinar <command>` runs the matching tool, from a clone of this repository or from
the npm package `felinar`: `npx felinar publish` is `node tools/publish.mjs`, `npx felinar ledger` is
`node tools/ledger-admin.mjs`. Every command below works either way.

## What you need

Each part below is a party that can stop or watch a site; the last column names what replaces it.

| Part | Needed for | Run by | Condition | Replace it with |
|---|---|---|---|---|
| An HTTPS static host | every visit: it serves the loader | you (GitHub Pages, Cloudflare Pages, Netlify, S3 + CloudFront) | it is the trust root: whoever controls it controls what visitors run | more doors: the same build on other hosts, reached by the light link ([Doors](#doors)), so no one host is the only way in |
| A web seed (`ws=`) and the `.torrent` URL (`xs=`) | loading when nobody else is online | you: the same host under `/ws/`, or a bucket such as R2 | without both, the site loads only while another visitor is online | a pin node, or a full door that serves the same bytes; every piece is checked against the infohash |
| WebSocket trackers (`tr=`) | visitors finding each other | the four public ones, or your own | the public ones publish no service level and all four are on at least one DNS block list ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), verdict 3) | your own ([Your own tracker](#your-own-tracker)); a signed pointer uses its `tr=` list exactly |
| STUN servers | peer connections through NAT | Cloudflare and Twilio, built into the loader | the site's files and ledger never go through a relay (TURN) server; only a call can, and only through one you set up ([TURN: off by default](#turn-off-by-default)) | for chat, files, media and calls, your own (`publish --stun`, [Your own tracker and STUN servers](#your-own-tracker-and-stun-servers-for-chat-and-files)); for the site's files and ledger, nothing yet: the two are built into `src/loader/config.js` |
| A DNS-over-HTTPS service | a pointer published in DNS; shell pages also use it to check for updates once a visitor shares | Cloudflare, then dns.sb, then Google | the resolver sees the visitor's IP address and the site's name; drop-in pages never use it, and no page asks it for a name that cannot carry a TXT record (localhost, IP addresses, nip.io and sslip.io, and hosting-platform names such as `*.github.io`, `*.netlify.app`, `*.pages.dev` or `*.ts.net`) | a resolver the site names with `<meta name="mw-doh">`; a site with no DNS pointer needs none, because its page tag is the pointer |
| A ledger snapshot (`cs=`) | shared data with nobody online, and the first post on an open ledger | you, on the host | upload `genesis.json` at least | a copy on any host (`--cs` names its URL) or a pin node |
| A pin node | an always-on copy of the files and the ledger | you, on a small server (optional) | see [Pin node](#pin-node) | another pin node; `tools/seed.mjs` or an open page holds a copy too |
| The owner key | signing pointers, withdrawals and ledger control blocks | you, offline | never on a host, in a browser or in a repository | nothing: the key is the site's name; a hand-over (`ledger-admin owner`) moves the ledger to a new key |
| An identity origin | sign-in, for anyone who writes from a browser | whoever the site names with `--idp`; by design the project hosts none | whoever serves it can change the page that unlocks roots, and sees the IP address and time of loads that miss its cache ([PRIVACY.md](PRIVACY.md), the identity origin's row) | your own ([The identity origin](#the-identity-origin-running-your-own-with-toolsbuild-idpmjs), with hosts that cost nothing); a site whose visitors only read needs none |
| A name | an address visitors can type, and its HTTPS certificate | your registrar and DNS provider; with no domain, nip.io or sslip.io (one free service under two names, run by volunteers) or a platform name such as `<user>.github.io` | whoever runs the name can point it elsewhere or block it | the light link: the site lives at its key and any door opens it ([Doors](#doors)), so losing a name loses one door |
| A certificate authority | HTTPS on every public door | Let's Encrypt on the one-box (`deploy/one-box/Caddyfile`); the platform's own on GitHub Pages, Netlify or Cloudflare Pages | on the one-box one authority issues every certificate, and all one-box sites under one service name share its limits | doors with other providers; `LW_ACME_CA` in the one-box `.env` names another ACME directory (not tried; `ship` writes Let's Encrypt) |
| The code at deploy time | a fresh build or deploy | GitHub (the clone, also on the server for `ship`), the npm registry (`npm ci`), Docker Hub (the one-box images) and, for the optional pin profile, Playwright's browser download and the Debian package mirrors (`deploy/pin/Dockerfile`) | an outage or a removed package stops a fresh deploy, not a running site; `npm-shrinkwrap.json` and `build.lock.json` pin bytes, not availability | the signed release files, from any mirror, checked offline with `tools/verify-release.mjs` |

## What the host must do

| Path | Rule | Why |
|---|---|---|
| everything | HTTPS, at the root of a domain or subdomain (`https://example.com/`, not `https://example.com/site/`) | the loader runs only in a secure context, and `/mw-sw.js` needs the origin root |
| `/mw-sw.js` | status 200, a JavaScript MIME type (`text/javascript`), `Cache-Control: no-cache`, never a redirect, never an HTML page when it is missing | a redirect, an HTML fallback or a stale edge copy silently keeps visitors on the previous worker ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), D15) |
| `/index.html`, `/404.html` (shell mode) | `Cache-Control: no-cache` | they carry the page tag, the signed pointer |
| `/_mw/*` | JavaScript and CSS with their real MIME types; `no-cache` or a short cache; purge on every deploy | the file names don't change between builds; the static page checks two of them with SRI, and the worker refuses a precache whose files don't match the build's hashes (ARCHITECTURE 7.1), so a stale copy blocks first visits and updates |
| unknown paths (shell mode) | answer with the shell: an SPA fallback, or `/404.html` (a copy of `index.html`) with status 404 | every URL of the site is answered by the loader; a 404 status still renders |
| a missing `/mw-sw.js`, `/_mw/*` or web seed file | a real 403 or 404, never the shell as `200 text/html` | an HTML page served as 200 in place of a script or a file poisons caches and fails the piece hashes |
| the web seed | `Range` answered with `206` and the exact bytes; CORS when it is on another origin | see [The web seed contract](#the-web-seed-contract) |

Shell mode answers every URL with the loader, so crawlers and link previews that don't run JavaScript see
only the loader. Keep `robots.txt`, a favicon and `.well-known/` files next to the shell on the host, and use
drop-in mode for pages that must be indexed.

Hosts that can send headers (CloudFront, Netlify, Cloudflare) should add these to the shell pages
`/index.html` and `/404.html`. A `<meta>` policy can't carry `frame-ancestors`, so only a header can say it.

```text
Content-Security-Policy: frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000
```

`boot.js` inserts the shell's full Content-Security-Policy as a `<meta>` tag itself. If your host sends its own
CSP header for the shell pages, it must allow at least the policy in `dist-publish/csp.txt`. In drop-in mode
your pages keep your headers; add what `csp.txt` lists to your policy if you send one.

### The web seed contract

**Shell mode.** `publish` lays the files out as `<ws>/<name>/<path>` and the torrent at `xs=` (by default
`<ws>/<name>.torrent`). `dist-publish/webseed-layout.txt` lists every key to upload.

- `GET` with `Range: bytes=a-b` answers `206 Partial Content` with `Content-Range: bytes a-b/<length>` and the
  bytes as stored: no `Content-Encoding`. A `200` with the whole file ("Range ignored") fails: Cloudflare Pages
  and cdnjs do this ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), section 11).
- On another origin, every response carries `Access-Control-Allow-Origin: *`, and an `OPTIONS` preflight
  answers 2xx with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, HEAD, OPTIONS` and
  `Access-Control-Allow-Headers: *` (or a list that includes `range`). Add `Access-Control-Expose-Headers:
  Content-Range, Content-Length, Accept-Ranges, ETag`; without it the check only warns.
- The vendored WebTorrent bundle is patched to send `Range` only (ARCHITECTURE section 1, item B3), and
  Chromium 156 and WebKit 27.2 then sent no preflight at all. Whether every browser at the floor treats a plain
  `Range` header the same way is not measured, so `check-webseed` requires a preflight answer unless you pass
  `--allow-no-preflight` (ARCHITECTURE section 14).
- Never let the edge rewrite bytes. Image optimisation (Cloudflare Polish, Mirage), minification, Email
  Obfuscation, Rocket Loader and `Accept`-dependent formats change what browsers receive and fail the piece
  hashes ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), C18).
- A web seed on the loader's own origin (`--ws https://example.com/ws/`) needs no CORS at all.

**Drop-in mode.** The site's own host is the web seed. The Service Worker reads `/<path>` from the same origin
and slices it (ARCHITECTURE 3.4.7), so neither CORS nor `Range` matters. The files just have to reach browsers
byte for byte as they are in the torrent.

```sh
# Shell mode, web seed on another origin (for example R2 on seed.example.com)
npx felinar check-webseed https://seed.example.com/ws/ dist-publish/site.torrent

# Shell mode, web seed on the loader's own origin: --origin tells the tool the requests are same-origin
npx felinar check-webseed https://example.com/ws/ dist-publish/site.torrent --origin https://example.com

# Drop-in: the live host serves browsers the torrent's bytes (catches edge transforms)
npx felinar check-webseed https://www.example.com/ dist-publish/site.torrent --mode host
```

| Verdict | Meaning | Exit code |
|---|---|---|
| `PASS` | every file answers `Range` with 206 and the first and last piece hash correctly | 0 |
| `PASS-needs-patched-client` | only the `Range`-only request passes; fine for felinar, which sends only `Range` | 0 |
| `PASS-no-preflight` | the host has no preflight answer (only with `--allow-no-preflight`) | 0 |
| `FAIL-range-ignored` | the host answered a range with the whole file | 1 |
| `FAIL-wrong-bytes` | a piece hash failed: compressed or rewritten bytes, or a file overwritten in place | 1 |
| `FAIL-cors` | the preflight or a response lacks the CORS headers | 1 |
| `FAIL` | anything else (unreachable, a 404) | 1 |

`npx felinar publish ... --verify-ws` runs the same gate and withholds the pointer until it passes; in
drop-in mode `--verify-host <url>` does the same against the live host.

## Choose a layout

| Layout | Mode | What goes where | Good for | Watch out for |
|---|---|---|---|---|
| One host | shell | the shell at `/`, the web seed under `/ws/` on the same origin | the simplest setup; no CORS | the host carries all egress |
| Host plus seed bucket | shell | the shell on Pages; the files and the `.torrent` on R2 (or S3 + CloudFront) under a custom domain | zero-egress storage; bytes on a second provider | CORS rules on the bucket; one more thing to watch |
| The site's own host | drop-in | your pages and assets where they are, plus `/_mw/`, `/.mw/`, `/mw-sw.js` and `/_mw/t/<btih>.torrent` | existing sites, search traffic | each visitor fills a copy from the host once ([Costs](#costs)) |

**Keeping the previous version.** Visitors who opened the previous version keep needing its files for a while:
open pages fetch lazy chunks, and visitors on the old version serve each other. Keep every file of the
previous version reachable for at least 7 days.

- Shell mode lays files out at `<ws>/<name>/<path>`, so the next version overwrites every changed file at the
  same URL. To keep the previous version whole, give each release its own base, for example
  `--ws https://seed.example.com/r/2026-10-20/`. A per-release base also lets you cache seed files as immutable.
  If you keep one base, a visitor still downloading the old version during the deploy gets wrong bytes for the
  changed files: the loader skips that web seed for 5 minutes after 3 failures in 30 seconds
  (`src/loader/config.js`) and finishes from peers, and a reload brings the new version.
- Drop-in mode keeps your asset URLs. Content-hashed file names (`app.9c0d2e.js`) keep old and new versions
  side by side; a file overwritten in place gives visitors on the old version the new bytes, as it would
  without felinar.
- Hosts that deploy a whole tree at once (GitHub Pages, Cloudflare Pages, Netlify) drop whatever the new tree
  doesn't contain. Copy the previous release's web seed folder into the new tree until it is 7 days old.

## Host recipes

Pick a host for the loader and, in shell mode, a place for the web seed. Prices and limits below were read on
2026-10-17 ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), section 11); check the vendor's page before you
rely on one. Step-by-step recipes for hosts and frameworks are in [recipes/](recipes/).

| Host | Loader (shell) | Drop-in host | Web seed on its own origin | Web seed for another origin |
|---|---|---|---|---|
| GitHub Pages | yes (user, organisation or custom-domain site) | yes | yes | no: `OPTIONS` answers 405 |
| Cloudflare Pages | yes | yes | no: `Range` answered with 200 | no |
| Cloudflare R2 | not researched as a site host | no | n/a | yes, on a custom domain |
| S3 + CloudFront | yes | yes | yes | yes, with the CORS setup below |
| Netlify | yes | yes | yes | only with CORS added in `_headers` |
| jsDelivr, cdnjs, public IPFS gateways | no | no | no | no: wrong bytes, ignored ranges or rate limits |

### GitHub Pages

- Use a user or organisation site (`<user>.github.io`) or a repository with a custom domain. A project site
  lives under `/<repo>/`, and the loader needs the root of the origin.
- Add `.nojekyll` at the root of what you publish. Without it Jekyll drops `/_mw/` and `/.mw/`.
- GitHub Pages sends no custom headers and serves every file with `Cache-Control: max-age=600`
  ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), 5.2). A new page tag, a new `/mw-sw.js` and the kill switch can
  take up to 10 minutes to reach returning visitors. You can't add the frame or HSTS headers above.
- Unknown paths get your `404.html` with status 404. In shell mode that file is the loader, which is what you
  want.
- As a web seed on its own origin it works: browsers get 206 with identity bytes for ranges
  ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), section 11). For another origin it doesn't, because
  `OPTIONS` answers 405.
- Limits: a 1 GB site and a soft 100 GB of traffic a month. GitHub's terms exclude sites "primarily directed at
  facilitating commercial transactions".

Assemble the deploy tree as in [QUICKSTART.md](QUICKSTART.md) (steps A3 and A4), push it, then check it. The
step-by-step recipe is [recipes/github-pages.md](recipes/github-pages.md).

```sh
npx felinar check-site https://example.com/
```

### Cloudflare Pages, with R2 as the web seed

Cloudflare Pages can serve the loader and drop-in sites, but not the web seed: it answers `Range` requests
with the whole file and status 200, which `check-webseed` reports as `FAIL-range-ignored`. Step-by-step recipes:
[recipes/cloudflare-pages.md](recipes/cloudflare-pages.md) and [recipes/cloudflare-r2.md](recipes/cloudflare-r2.md).

- Keep the top-level `404.html` from `dist-publish/shell/`. Pages then serves it with status 404 for unknown
  paths, which is the loader. In drop-in mode keep your site's real `404.html` too; without one, Pages answers
  every unknown path with your home page and status 200.
- Pages redirects `/page.html` to `/page`. Drop-in sites keep that behaviour, because the host still serves
  their pages.
- Turn off what rewrites bytes on the zone: Rocket Loader (or keep `data-cfasync="false"` on the drop-in tag,
  which `publish --dropin --inject-script` writes), Auto Minify, Email Obfuscation, and Polish or Mirage on the
  web seed hostname.
- Free plan limits: 20,000 files and 25 MiB per file. `publish` prints whether the site fits.

Put a `_headers` file in the deploy root next to the shell (not in the folder you publish: `publish` reads a
`_headers` file there into the site's own routing manifest):

```text
/mw-sw.js
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/404.html
  Cache-Control: no-cache
/_mw/*
  Cache-Control: no-cache
```

**R2 as the web seed.** Serve the bucket from a custom domain on a Cloudflare zone (`seed.example.com`); the
`r2.dev` addresses are rate-limited and meant for development. In the bucket's CORS policy (dashboard, JSON):

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "Cache-Control", "User-Agent"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

The headers are listed one by one because R2 doesn't document `*` there (research w1-10, appendix CFG-7).
Upload each release under its own prefix as `application/octet-stream` with
`Cache-Control: public, max-age=31536000, immutable, no-transform`, so the edge never compresses or changes the
bytes ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), M38). With the S3-compatible API:

```sh
export AWS_ACCESS_KEY_ID=<R2 access key id> AWS_SECRET_ACCESS_KEY=<R2 secret>
R2=https://<account id>.r2.cloudflarestorage.com
aws s3 sync dist-publish/my-site s3://<bucket>/r/2026-10-20/my-site --endpoint-url "$R2" \
  --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable, no-transform"
aws s3 cp dist-publish/my-site.torrent s3://<bucket>/r/2026-10-20/ --endpoint-url "$R2" \
  --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable, no-transform"
npx felinar check-webseed https://seed.example.com/r/2026-10-20/ dist-publish/site.torrent
```

Publish with `--ws https://seed.example.com/r/2026-10-20/` so the pointer names that prefix (with no `--xs`,
`xs=` becomes `<ws>/<name>.torrent`). Add a Cache Rule that caches everything on the seed hostname, and purge it
after any CORS change. Whether a `Range` request is answered correctly through Cloudflare's cache was not
tested ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), Q20): the check above is the test. R2 list prices:
no egress fee, $0.015 per GB-month of storage, $4.50 per million Class A and $0.36 per million Class B
requests, with 10 GB, 1 million Class A and 10 million Class B requests free each month.

### Amazon S3 and CloudFront

S3 website endpoints serve plain HTTP only, so the loader can't run from them. Use a private bucket (REST
endpoint) behind CloudFront with origin access control (OAC), and an ACM certificate requested in us-east-1
([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), 5.2). The step-by-step recipe is
[recipes/s3-cloudfront.md](recipes/s3-cloudfront.md).

Bucket: Block Public Access on, Object Ownership "Bucket owner enforced", and this bucket policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontServicePrincipalReadOnly",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::<bucket>/*",
    "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::<account id>:distribution/<distribution id>" } }
  }]
}
```

If the web seed in this bucket is read from another origin, add a CORS rule. S3 answers the `OPTIONS` preflight
from these rules itself (`AllowedMethods` can't list `OPTIONS`). `"AllowedHeaders": ["Range"]` alone is not
enough for the stock WebTorrent request; `*` covers it.

```json
{"CORSRules": [{"AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"], "MaxAgeSeconds": 86400}]}
```

```sh
aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://s3-cors.json
```

CloudFront: HTTPS only, HTTP/2 and HTTP/3 on, the default root object set to `index.html`, and these behaviours:

| Path pattern | Allowed methods | Cache policy | Response headers policy | Compress |
|---|---|---|---|---|
| `/mw-sw.js`, `/index.html` and `/404.html` (one behaviour each) | GET, HEAD | `CachingDisabled` | security headers (above) | yes |
| `/_mw/*` | GET, HEAD | `UseOriginCacheControlHeaders` (minimum TTL 0), objects uploaded with `Cache-Control: no-cache` | security headers | yes |
| `/ws/*` (or a separate seed distribution) | GET, HEAD, OPTIONS, with OPTIONS cached | `CachingOptimizedForUncompressedObjects` | `mw-webseed-cors` (below) | no |
| `*` (default) | GET, HEAD | `CachingOptimized` | security headers | yes |

A minimum TTL above 0 makes CloudFront keep `/mw-sw.js` for at least that long even with `no-cache`
([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 5.2). Compression is off for the web seed, because
CloudFront computes ranges of a compressed object on the compressed bytes (research w1-10, F12).

The managed `CORS-With-Preflight` policy sends no `Access-Control-Allow-Headers` (research w1-10, F5), so create
your own policy for the web seed:

```json
{"Comment": "felinar web seed CORS", "Name": "mw-webseed-cors", "CorsConfig": {"AccessControlAllowOrigins": {"Quantity": 1, "Items": ["*"]}, "AccessControlAllowHeaders": {"Quantity": 1, "Items": ["*"]}, "AccessControlAllowMethods": {"Quantity": 3, "Items": ["GET", "HEAD", "OPTIONS"]}, "AccessControlAllowCredentials": false, "AccessControlExposeHeaders": {"Quantity": 4, "Items": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"]}, "AccessControlMaxAgeSec": 86400, "OriginOverride": true}}
```

```sh
aws cloudfront create-response-headers-policy --response-headers-policy-config file://cf-cors.json
```

CloudFront's flat-rate Free and Pro plans offer managed policies only (custom response headers policies start
at Business). There, forward `OPTIONS` to S3 with the managed origin request policy `CORS-S3Origin`, use a cache
policy that keys on `Origin` (`UseOriginCacheControlHeaders`), and let the bucket's CORS rule answer; with the
managed `CORS-With-Preflight` policy and "origin override" off, S3's `Access-Control-Allow-Headers` should pass
through. That variant is untested (research w1-10, appendix CFG-3); `check-webseed` tells you whether it works.

**SPA fallback for shell mode.** Add custom error responses for 403 and 404 that return `/404.html` with
response code 404 (a private bucket behind OAC answers 403 for a missing key). They apply to the whole
distribution, so a missing web seed or loader file also returns the shell, but with status 404, so it stays a
miss. Never map them to response code 200: a missing piece would then arrive as `200 text/html`.

**Deploy and purge:**

```sh
# 1. the web seed files, the .torrent and the snapshot
aws s3 sync dist-publish/my-site s3://<bucket>/ws/my-site/
aws s3 cp dist-publish/my-site.torrent s3://<bucket>/ws/
aws s3 cp dist-publish/genesis.json s3://<bucket>/ws/
# 2. the gate
npx felinar check-webseed https://example.com/ws/ dist-publish/site.torrent --origin https://example.com
# 3. the loader with the new page tag, then purge the files that don't change their names
aws s3 sync dist-publish/shell/ s3://<bucket>/ --cache-control no-cache
aws cloudfront create-invalidation --distribution-id <distribution id> --paths /index.html /404.html /mw-sw.js "/_mw/*"
# 4. from outside
npx felinar check-site https://example.com/
```

`aws s3 sync` without `--delete` keeps the files of the previous version. The first 1,000 invalidation paths
each month are free, then $0.005 each (research w1-10, F7). Upload only the publish output: `aws s3 sync` also
uploads `.DS_Store` and every other dot file it finds.

**A wildcard for hubs.** Request one ACM certificate in us-east-1 for `hub.example` and `*.hub.example`, add both
as alternate domain names, and point the apex and `*` at the distribution with Route 53 alias records. A
wildcard covers one label and not the apex (research w1-10, F3). Hubs need more than a certificate: see
[Hubs](#hubs).

### Netlify

- Netlify can serve the loader and drop-in sites. For a web seed on another origin, its `OPTIONS` answer has no
  CORS headers; you can add them with `_headers`. Identity 206 answers were measured
  ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), section 11). The recipe is
  [recipes/netlify.md](recipes/netlify.md).
- Unknown paths get your `404.html` with status 404 (the loader, in shell mode). Netlify serves `/page` from
  `page.html`, and drop-in sites keep that.
- Put `_headers` in the deploy root, as for Cloudflare Pages above. For a web seed on another origin, add:

```text
/ws/*
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Headers: *
  Access-Control-Allow-Methods: GET, HEAD, OPTIONS
  Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, ETag
```

Whether these headers also reach Netlify's own `OPTIONS` answer was not tested; run `check-webseed` against
the live URL.

- Deploy with the Netlify CLI. Deploys are atomic, so the files and the new page tag go live together:

```sh
netlify deploy --dir deploy-root --prod
npx felinar check-site https://example.com/
```

- Pricing: 20 credits per GB and 2 credits per 10,000 requests; the Free plan has 300 credits (about 15 GB) and
  then pauses every project; Pro is $20 for 3,000 credits. A paused project takes the loader, and so the site,
  offline for every new visitor.

### Other hosts

Recipes: [recipes/vercel.md](recipes/vercel.md), [recipes/backblaze-b2.md](recipes/backblaze-b2.md),
[recipes/bunny.md](recipes/bunny.md).

| Host | Use it as | Notes |
|---|---|---|
| Vercel | loader, drop-in host, hub (wildcard domains) | Hobby is non-commercial; the stock request fails the preflight, the `Range`-only request passes |
| Cloudflare Workers static assets | loader; hub through Worker routes such as `*.hub.example/*` | `Range` handling not verified |
| Backblaze B2 | web seed behind a CDN (Cloudflare, Fastly, bunny.net) | denies preflights by default; up to 100 CORS rules |
| Bunny Storage and CDN | web seed | CORS added in the Headers tab or an Edge Rule; the edge compresses listed types |
| DigitalOcean Spaces and CDN | web seed | the default CORS rule lacks `cache-control`; $5 a month includes 1 TiB of transfer |
| jsDelivr, cdnjs, `ipfs.io`, `dweb.link` | nothing | jsDelivr returns brotli bytes labelled identity, cdnjs ignores `Range`, the public IPFS gateways answer 429 or a challenge |

## Zero-setup: a server without a domain

> **Status: v0.3 C2, written together with its code and not yet run on a real server.** `ship`, `name-check` and `deploy/one-box/` are in
> this tree and are tested with canned answers on loopback. No certificate was requested from Let's Encrypt for them and no phone opened a
> nip.io name; the release gate rows are G-ZS1 to G-ZS4 in [DEMO-RESULTS.md](DEMO-RESULTS.md). The research is
> [S2](research/v03/S2-zero-setup-hosting.md), cited here as F1, F2 and so on, and the design is
> [SEEDING-AND-ZERO-SETUP-DESIGN](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), sections 3.2 and 3.4.

You can put a site online without owning a domain: rent a small server and name the site after its IP address. The step-by-step page is
[QUICKSTART.md, "Start without a domain"](QUICKSTART.md#start-without-a-domain). This section holds the facts behind it.

### One box

`deploy/one-box/` ([README](../deploy/one-box/README.md)) is a Docker Compose file and a Caddyfile for one machine. Caddy serves the loader
and the web seed over HTTPS and passes the tracker's WebSocket through at `/tracker`; the tracker (`tools/tracker.mjs`) serves only your
site and its ledger swarm; an optional `pin` profile keeps an always-on copy ([Pin node](#pin-node)). One command does the sequence from your
own computer, and `--dry-run` first prints every host and every command and contacts nothing:

```sh
npx felinar ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org --dry-run
npx felinar ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org
```

The server needs a public IPv4 address, Docker with Compose 2.17 or newer, rsync, ports 80 and 443 reachable from the internet, and a clone of
this repository (the tracker image is built from it). Use an ssh key: every step is its own ssh or rsync call.

`ship` looks at the server first, before it makes or publishes anything, and then sends in the order of [Deploy order](#deploy-order): the web
seed (added to, never pruned), then the allow list, then the loader with the pointer. The owner key stays on your computer: `ship` makes or
reuses it there, copies only the site tree and the allow list, and stops if the key's secret turns up in either. Keep its work directory
(`dist-ship/<name>`): it holds the ledger's first block, and an update without it stops instead of starting a new ledger.

List prices read on 2026-10-20 (F15): a droplet with 500 GiB of transfer and an IPv4 address from $4.00 a month at DigitalOcean, and from EUR 5.99
and 6.49 a month excluding VAT at Hetzner. Free and cheap offers change under you: Glitch ended hosting on 2025-07-08, and Oracle cut its Always
Free A1 allowance on 2026-06-15.

### The name

- `203-0-113-7.nip.io` answers `203.0.113.7`. So do `203.0.113.7.nip.io` and any label in front of the name, and the same names under
  `sslip.io` (F2, measured with `dig` on 2026-10-20).
- nip.io and sslip.io are one free DNS service run by two volunteers, with no terms, privacy statement or uptime promise (F1). If it stops,
  new visitors cannot open the address; people who already opened the site keep their saved copy.
- It keeps a block list of addresses used in phishing, and for those the name answers a block page instead of your server (F3). A recycled
  server address can be on the list before you use it, so `ship` looks the name up first. If the name answers anything but your address it tries
  sslip.io, and if that fails too it stops with a plain sentence and sends nothing. One DNS filter list, HaGeZi's DynDNS list (version
  2026.1016.0959.51), covers sslip.io and not nip.io (F6, measured 2026-10-20), which is why nip.io comes first.
- Neither name is on the Public Suffix List (F4). Storage and Service Worker scope are per origin either way, but sibling names count as the same
  site: a hostile page on another nip.io name could set cookies for the shared domain, and your same-origin web seed requests would carry them
  (an inference). Whether the loader should turn persistent identity off for such names is open (S2 Q3).
- Nobody can set a TXT record under these names, so there is no DNS pointer. The loader makes no DNS-over-HTTPS request for them, and
  `check-site` reports "not possible for this name (page tag only)" and the date the page tag expires.

### Certificates and ports

Caddy needs only the name. It asks for a certificate with HTTP-01 on port 80 or TLS-ALPN-01 on port 443; neither needs DNS credentials, and
DNS-01 through a DNS provider is not possible for these names (F7; F9 describes a delegation trick that was not tried end to end). So ports 80
and 443 must be reachable from the internet. A computer at home usually is not
reachable: its router needs a port forward, some providers block port 80, and behind carrier-grade NAT nothing can connect in (10% of the ISPs
tested in 2017 had some form of it, F12; the figure is old and counts ISPs, not subscribers). Use a rented server, a free static host or a
tunnel.

Let's Encrypt (its limits page, updated 2026-08-05, F5) allows 50 certificates per registered domain and 5 per exact set of names in 7 days, and
5 failed validations per name per hour. Neither service name is on the Public Suffix List, so every site under the same name shares one registered
domain's limit (an inference). `ship` therefore starts the box on the Let's Encrypt **staging** directory (`LW_ACME_CA` in the server's `.env`),
waits for a staging certificate, and only then switches to production: a closed port or a wrong address costs no production certificate. Keep the
`caddy_data` volume; losing it requests the certificate again, and the limit of 5 duplicate certificates has no override.

Let's Encrypt has issued certificates for bare IP addresses since 2026-01-15, with a 6-day lifetime (F8). The one-box does not use them: the
variant was parsed by Caddy and never run, a 6-day certificate must renew without fail, and the box would depend on Let's Encrypt alone for it.
Passkeys are not the obstacle for the site: they live at the identity origin, not at the site. Browsers do not accept an IP address as a
passkey's relying party (reported), so an identity page on an IP address keeps identities through the passphrase card and loses only passkeys
([The identity origin](#hosting-it-without-buying-a-domain)), and a site on an IP address that names an identity page on another host keeps them.

### The signed address record expires

Without a DNS record, the signed page tag is the only pointer, and it expires. `ship` signs it for 399 days, the longest `publish` allows
(owner decision SZ-3, accepted on 2026-10-25 together with a calendar reminder file planned for 0.3.x; `--exp <days>` picks
another number), and prints the date:

> Your signed address record expires on 2027-11-23. After that new visitors cannot load the site until you publish again. Add this date to your calendar.

(That date is for a run on 2026-10-20.) Returning visitors keep their saved copy and see "Pointer expired on" the date, with the last known
version ([QUICKSTART.md](QUICKSTART.md#keep-it-running)). Publishing again is the same `ship` command: same key, same files, a new signature, and
only the files are sent. `check-site` prints the days left, and warns 14 days before the end.

### If the address changes

> If this server gets another IP address, the address changes and visitors start again. A domain you own does not have this problem.

The new name is a new origin: saved copies, consent and key pins start over. To move the site to a domain, or to another address, publish with the
same key and the same `--chain` (`ship` and `publish` set it to the site name for names made from an address). The ledger, its rendezvous swarm
and the infohash stay the same (F16), and the old and the new address can run together as one swarm. On a domain you own, add the DNS record of
[The DNS TXT record](#the-dns-txt-record) at the new name.

### Taking it down

`ship` gives the site the ledger label of its name, so a withdrawal carries the same label:
`node tools/publish.mjs --withdraw --scope 203-0-113-7.nip.io --chain my-site --key ~/keys/my-site.jwk --why "<reason>"`
([Takedown](#takedown)). For these names the pointer lives only in the page tag of the shell: restamp the pages of
`dist-ship/<name>/one-box/site/` with the script in Takedown and send that folder with the `rsync` line of the by-hand steps in
[deploy/one-box/README.md](../deploy/one-box/README.md) (running `ship` again would publish the site again). To stop the box, run
`docker compose down` in `deploy/one-box/` on the server; `-v` also deletes the certificates.

### Other ways to start without a domain

| Way | Name | What to know |
|---|---|---|
| A free static host: GitHub Pages, Netlify | `<user>.github.io`, `*.netlify.app` | passes the shell contract (same-origin web seed, `206`); public trackers only; GitHub Pages sends no custom headers; Cloudflare Pages cannot be the web seed (F14). Publish with `--exp 399`, see [QUICKSTART.md](QUICKSTART.md#start-without-a-domain) |
| A computer at home | none stable | Tailscale Funnel gives a stable name without inbound ports and is in beta; a quick tunnel gets a new name on every run (F13) |
| A link on a hub | the hub's | needs a hub that exists, and loads only while a pin or a seeder holds it (v0.4) |

> This address belongs to GitHub. They can remove it, change their limits or close the account. Your files and your key stay yours: publish the same site elsewhere with the same key.

A tunnel is something you start yourself; the repository's tools never open one ([HTTPS and phone demos](#https-and-phone-demos)).

### Open questions

Not yet answered by a run (S2): whether Let's Encrypt issues for a fresh nip.io name under the shared limits and whether Caddy falls back to
ZeroSSL if not (Q1); how iOS Safari, Android Chrome and Firefox treat `*.nip.io` names (Q2); whether the pin container can open its own public
name from inside the machine (Q10); and who answers abuse notices for sites on rented servers when a hub lists them.

## The DNS TXT record

The page tag is enough to load a site. A TXT record is a second update channel for shell-mode sites: after a
visitor has chosen "Share and load", the loader also reads `_magnet.<hostname>` over DNS-over-HTTPS, and a
record signed by the remembered key with a higher `seq` than the page tag wins (ARCHITECTURE section 4).
Shell pages make this lookup whether or not the record exists, and drop-in pages never read DNS. The
DNS-over-HTTPS service sees the visitor's IP address and the site's name, so name it in your privacy notice
either way ([PRIVACY.md](PRIVACY.md)). Since 0.3.0 no page makes the lookup for a name where no user can publish a TXT record:
`github.io`, `gitlab.io`, `codeberg.page`, `pages.dev`, `workers.dev`, `netlify.app`, `vercel.app`, `surge.sh`,
`trycloudflare.com` and `ts.net` and every name under them (`NO_TXT_SUFFIXES` in `src/loader/doh.js`), as for nip.io and sslip.io;
the page tag is the only pointer there and `check-site` says "page tag only". The list is an inference from how these platforms run
their zones, not yet checked by a lookup (the owner checks each zone with `dig` before the release); `dedyn.io` and `duckdns.org`
are not on it, because their users can set TXT records.

`dist-publish/dns.txt` holds the record: name `_magnet.<scope>`, type TXT, TTL 300, and the value split into
character-strings of at most 255 bytes. Resolvers join the strings with no separator. A signed pointer with
the four public trackers is about 570 bytes, three strings; `publish` warns above 450 bytes and refuses above
900. `dns.txt` also has a zone-file line, an Amazon Route 53 change batch and a Cloudflare API call.

- Create the record before anyone visits. Resolvers remember a missing record for the zone's negative TTL,
  measured at 300 to 1,800 seconds ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), 5.3).
- Keep exactly one TXT value at `_magnet.<hostname>`. The loader takes the highest valid `seq` if there are
  several, but updates are simpler with one.
- Update it after every publish, after the files and before you announce the new version.
- DNSSEC is shown when your zone has it, and it isn't required.

Check the authoritative servers first, so a check doesn't make a resolver cache "no record", then DNS-over-HTTPS,
then the whole site:

```sh
dig +short NS example.com
dig +short TXT _magnet.example.com @<one of those name servers>
curl -sS -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=_magnet.example.com&type=TXT'
npx felinar check-site https://example.com/
```

The provider notes below come from each provider's documentation as read for research w2a-06 on 2026-10-17
(its findings F15 to F18). None was run against a live zone. In the commands, `<pointer.txt>` stands for the
text of that file.

### Amazon Route 53

`dns.txt` has a change batch with `UPSERT` and the strings already quoted inside `Value` (`"\"a\" \"b\""`), as
Route 53 wants them. Copy that JSON from `dns.txt` into `route53.json`, then:

```sh
CHANGE=$(aws route53 change-resource-record-sets --hosted-zone-id <zone id> --change-batch file://route53.json \
  --query ChangeInfo.Id --output text)
aws route53 wait resource-record-sets-changed --id "$CHANGE"
```

For updates from CI, a batch that deletes the exact old value and creates the new one is a compare-and-swap:
Route 53 applies all of a batch or none of it, and a `DELETE` must match the old value exactly, so the batch
fails if the record changed under you:

```json
{"Comment": "felinar pointer", "Changes": [
  {"Action": "DELETE", "ResourceRecordSet": {"Name": "_magnet.example.com.", "Type": "TXT", "TTL": 300, "ResourceRecords": [{"Value": "<the old quoted strings>"}]}},
  {"Action": "CREATE", "ResourceRecordSet": {"Name": "_magnet.example.com.", "Type": "TXT", "TTL": 300, "ResourceRecords": [{"Value": "<the new quoted strings from dns.txt>"}]}}
]}
```

An IAM policy can limit a CI role to this one record with the condition keys
`route53:ChangeResourceRecordSetsNormalizedRecordNames` (`_magnet.example.com`),
`route53:ChangeResourceRecordSetsRecordTypes` (`TXT`) and `route53:ChangeResourceRecordSetsActions`.

### Cloudflare

`dns.txt` has the `curl` call that creates the record; Cloudflare splits strings longer than 255 bytes itself.
To update it, save that call's `--data` body as `cloudflare-record.json`, look up the record's id, and send the
body with `PATCH`:

```sh
curl -sS "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?type=TXT&name=_magnet.example.com" \
  -H "Authorization: Bearer $CF_API_TOKEN"
curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" --data @cloudflare-record.json
```

Cloudflare API tokens are scoped to a zone, not to a record. For CI, put `_magnet.example.com` behind a `CNAME`
to a TXT record in a separate zone that holds nothing else, and give CI a token for that zone only (research
w2a-06, F20). The DNS-over-HTTPS resolvers follow the `CNAME`, and the loader reads the TXT answer behind it.
The minimum TTL is 60 seconds.

### Porkbun

API access is switched on per domain, the API keys travel in the JSON body, and writes accept `"dryRun": true`.
The minimum TTL is an account setting, typically 600 seconds.

```sh
curl -sS -X POST https://api.porkbun.com/api/json/v3/dns/create/example.com -H 'Content-Type: application/json' \
  --data '{"apikey": "<key>", "secretapikey": "<secret>", "name": "_magnet", "type": "TXT", "ttl": "600", "content": "<pointer.txt>"}'
# later versions: replaces every TXT record at _magnet.example.com
curl -sS -X POST https://api.porkbun.com/api/json/v3/dns/editByNameType/example.com/TXT/_magnet -H 'Content-Type: application/json' \
  --data '{"apikey": "<key>", "secretapikey": "<secret>", "ttl": "600", "content": "<pointer.txt>"}'
```

Porkbun doesn't document how it stores a TXT value longer than 255 bytes. After the first write, read the
record from the authoritative servers with `dig` and check that its strings join to exactly `pointer.txt`;
`check-site` does the same through DNS-over-HTTPS.

### deSEC

Give the CI token a policy that allows writing only `(example.com, _magnet, TXT)`. deSEC wants TXT values in
double quotes and splits strings longer than 255 bytes itself. The minimum TTL is set by the server (its
documentation's example is 3,600 seconds), and writes are limited per domain to 2 a second, 15 a minute, 100
an hour and 300 a day.

```sh
curl -sS -X PATCH https://desec.io/api/v1/domains/example.com/rrsets/ \
  -H "Authorization: Token $DESEC_TOKEN" -H 'Content-Type: application/json' \
  --data '[{"subname": "_magnet", "type": "TXT", "ttl": 3600, "records": ["\"<pointer.txt>\""]}]'
```

## HTTPS and phone demos

Browsers run the loader only on HTTPS or `localhost`. Without either, the page shows "This page must be served
over HTTPS (or localhost)".

| Tier | How | Full mode? |
|---|---|---|
| This computer | `npx felinar demo`, then `http://localhost:8080/` | yes: `localhost` is a secure context |
| Phones on your network | `npx felinar demo --tls`, with the mkcert root certificate installed on the phone (the demo prints the iOS and Android steps) | yes, once the phone trusts the certificate; the tracker is on the same address and port at `/tracker`. This tier serves no identity page, so a post fails |
| Android over USB | `adb reverse tcp:8080 tcp:8080 && adb reverse tcp:8000 tcp:8000 && adb reverse tcp:8081 tcp:8081` (the desktop demo, with its identity page on 8081), then `http://localhost:8080/` on the phone | yes |
| A tunnel you run yourself | Tailscale Serve, a Cloudflare quick tunnel or ngrok | yes, but a quick tunnel allows 200 requests in flight and gives a new origin each run (every run is a first visit), and ngrok's free plan has a 1 GB and 20,000-request cap and an interstitial page ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), 5.2) |
| A real host | this page | the release gate runs here |

The repository's tools never open tunnels: everything they run stays on 127.0.0.1
([DEV-NETWORK.md](DEV-NETWORK.md)). A tunnel is something you start yourself, and the address of one belongs to its operator:

> This address belongs to the provider of the tunnel. They can see everything sent through it. It changes every time you restart, so each restart is a new site to your visitors. Use it to show a friend, not to publish.

**Phones on your network.** The LAN demo (`demo --tls`) starts the tracker on 127.0.0.1 only and lets the dev server pass WebSocket upgrades on
`/tracker` to it (`dev-server --tracker-proxy <port>`). The pointer then names `wss://<lan-ip>:8080/tracker`: one address, one port and one certificate
for the phone, because an `https://` page cannot open a `ws://` address on the LAN (mixed content) and a second TLS port would be a second thing to
trust. Phones run the site only over https. Trust the certificate on each phone once, or connect an Android phone by USB.

> Whoever gets the key of this local certificate authority can read the secure traffic of every phone that trusts it: keep it on this computer and remove the certificate afterwards.

Wi-Fi client isolation, a router setting that keeps devices apart, can stop a phone from reaching your computer; the USB route does not need the network.
A phone on a rented server's name instead needs none of this: see [Zero-setup](#zero-setup-a-server-without-a-domain).

## Deploy order

**Shell mode:**

1. Upload the web seed: `<name>/`, `<name>.torrent` and `genesis.json` (or a newer snapshot) under the web
   seed base.
2. Run `check-webseed` against the live web seed (or publish with `--verify-ws`).
3. Switch the pointer: deploy `dist-publish/shell/` to the host root, purge `/index.html`, `/404.html`,
   `/mw-sw.js` and `/_mw/*` at the CDN, and update the TXT record if you use one.
4. Keep the previous version's files for at least 7 days.

**Drop-in mode:**

1. Upload every non-HTML file of `dist-publish/site/`, including `/_mw/`, `/.mw/`, `/mw-sw.js` and
   `/_mw/t/<btih>.torrent`.
2. Run `check-webseed --mode host` against the live host (or publish with `--verify-host <url>`).
3. Upload the HTML pages last: they carry the new pointer.
4. Keep the previous version's files for at least 7 days.

```sh
aws s3 sync dist-publish/site/ s3://<bucket>/ --exclude "*.html" --exclude "*.htm"
npx felinar check-webseed https://www.example.com/ dist-publish/site.torrent --mode host
aws s3 sync dist-publish/site/ s3://<bucket>/ --exclude "*" --include "*.html" --include "*.htm"
```

Then check the whole site from outside, and keep checking it from CI or cron ([OPERATIONS.md](OPERATIONS.md)):

```sh
npx felinar check-site https://example.com/
```

`check-site` exits non-zero when anything is wrong: the page and its loader files (including the SRI hashes of
the two static script tags), the pointer in the page and in DNS, its expiry, the `.torrent`, the web seed, each
tracker and the snapshot.

## Updates

Publish again into the same `--out` directory (it reuses `genesis.json`) and deploy in the order above. The
default `seq` is the current Unix time, so each publish is newer than the last as long as your clock is right;
`publish` refuses a `--seq` later than the clock, and loaders refuse one more than a day ahead of theirs.

What visitors see: a page on the old version shows "Update available: reload" and stops sharing the old
version at once; after the reload the new version renders and the old copy is deleted (E2E scenario 13). A
shell page notices a new page tag after it renders and whenever it regains focus, and a DNS record within the
cached TTL (at least 5 minutes).

Pointers expire: 90 days by default, at most 399 (`--exp <days>`). Re-run `publish` before then; the same files
and name give the same infohash, so this only re-signs. `check-site` warns 14 days before expiry, and the loader
writes a line to its diagnostics log. After expiry, visitors with a saved copy see "Pointer expired on <date>;
showing the last known version." and new visitors can't load the site.

## Rollback

Loaders refuse a pointer with a lower `seq` than the one they have seen, so a rollback is a roll forward:
publish the earlier version's files again with a new `seq`.

1. Check out the source of the version you want back and publish it with the same `--name` and `--out`. The
   same files give the same infohash, and the new `seq` is the current time.
2. Deploy in the usual order. If you kept the previous version's web seed files, they are already there.
3. For DNS, use the compare-and-swap update above.

Never re-upload an old `pointer.txt`, `meta.html` or stamped page: its `seq` is lower, and every visitor who saw
the newer one refuses it. If the problem is the loader rather than the site (a bad `dist/`), deploy the previous
loader build and purge the CDN, or use the kill switch.

## Kill switch

Deploying `mw-sw-kill.js` as `/mw-sw.js` takes felinar's Service Worker off every returning visitor and
restores the plain site. `publish` writes it to `dist-publish/mw-sw-kill.js` (the build writes
`dist/mw-sw-kill.js`).

- Shell mode: deploy your site's own files at the host root in place of the shell, with `mw-sw-kill.js` as
  `/mw-sw.js`. If the host keeps serving the shell, visitors get no reload loop but no site either.
- Drop-in mode: copy `mw-sw-kill.js` over `/mw-sw.js`, then remove the script tag in your next deploy.
- Purge every CDN copy of `/mw-sw.js` first. On GitHub Pages a cached copy can live for up to 10 minutes.

What visitors see: the browser checks `/mw-sw.js` on the next navigation, so the first page view after the
deploy may still be the old one, and the page is healthy about 3 seconds later. That figure is from Chromium in
E2E scenario 9, about 2.7 seconds over 2 navigations; Firefox and WebKit are not measured. Tell people to wait
a few seconds rather than reload again and again. The kill switch leaves IndexedDB alone, so a later deploy
can reuse saved sites.

Last resort, only when the kill switch can't be deployed or doesn't take: send
`Clear-Site-Data: "storage"` on your HTML responses for a few days. It removes every worker of the origin and
deletes all its storage, including visitors' posting identities, remembered site keys, consent choices and
saved sites; identities are gone for good unless visitors exported them.

Run the kill switch once per release on a staging host and record the times in [DEMO-RESULTS.md](DEMO-RESULTS.md)
(row G14). The full procedure is in [RUNBOOK.md section 11](RUNBOOK.md#11-kill-switch).

## Takedown

| To remove | Do this | Reaches |
|---|---|---|
| a file, or a page of a shell site | publish a version without it | visitors drop the old version on their next load; devices that stay offline keep it until they reconnect |
| the whole site | publish a withdrawal (below) | loaders that see it stop sharing the site and delete every stored version |
| a post | delete it with a moderator key or `npx felinar ledger tombstone` | visitors who receive the deletion |
| everything an author wrote | `npx felinar ledger ban` or a moderator's ban | visitors who receive the ban |

A withdrawal is a signed record with `st=withdrawn` and an infohash of 40 zeros, so loaders that predate `st=`
have nothing to fetch either. Reason codes for `--why` are `owner`, `copyright`, `court` and `tos`; anything
else is shown to visitors as written.

```sh
npx felinar publish --withdraw --scope example.com --key ~/keys/owner.jwk --why copyright \
  --ct mailto:abuse@example.com --out withdraw
```

A site that committed to a next owner key (`--next-key`, `nx=`) gets a withdrawal that keeps the same `nx=`: publish reads
the record it replaces from `--prev-pointer <file>`, or from `<out>/pointer.txt` of the earlier publish, and checks the
withdrawal the way a returning visitor's loader does. It refuses one that such a device would ignore and writes nothing
(for example a withdrawal signed by a key that is neither the current one nor the committed next one). An owner who lost
the current key signs it with the committed next key: `--key <next key> --prev-key <current key>` when both are at hand,
or `--key <next key>` with `--prev-pointer`, which visitors accept because the key matches `nx=`.

It writes `pointer.txt`, `meta.html`, `dns.txt` and `summary.json`. Publish it everywhere the pointer lives:
the shell's `index.html` and `404.html`, every stamped drop-in page, and the TXT record. This short script
replaces the pointer in every page of a deploy tree:

```js
// restamp-pointer.mjs <deploy dir> <meta.html>: put the pointer from meta.html into every page that has one.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [root, metaFile] = process.argv.slice(2);
const meta = readFileSync(metaFile, 'utf8').trim();
const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
let pages = 0;
for (const file of walk(root).filter((f) => /\.html?$/i.test(f))) {
  const html = readFileSync(file, 'utf8');
  const next = html.replace(/<meta name="mw-pointer"[^>]*>/, meta);
  if (next !== html) {
    writeFileSync(file, next);
    pages++;
  }
}
console.log('replaced the pointer in ' + pages + ' page(s)');
```

```sh
node restamp-pointer.mjs deploy-root withdraw/meta.html
```

A shell page that is open applies the withdrawal when it regains focus or re-checks DNS; every other page on
its next load. Shell visitors see "This content is no longer available here." with your reason and contact. In
drop-in mode the runtime turns itself off, deletes its copies and logs one console line, while your host keeps
serving its own pages: remove the content from the host too. Keep the withdrawal published and re-sign it
before it expires (399 days by default).

What no withdrawal can do: recall bytes from a device that stays offline or from software that ignores the
signal, stop someone from publishing the same files again under a new infohash or domain, or delete what
trackers, STUN servers and DNS-over-HTTPS resolvers logged. The notice process (who answers, how fast, what to
record) is in [OPERATIONS.md](OPERATIONS.md).

## Your own tracker

Run one for any site you care about. The four public trackers publish no service level or abuse policy, a
DNS block list (HaGeZi Anti-Piracy) blocks all four by name, and a site whose visitors can't reach a tracker
still loads from its web seed but its visitors stop meeting, so the ledger stops syncing between them
([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), verdict 3 and D3).

- Give it a neutral hostname such as `rtc.example.com`. Avoid names containing `tracker`, `torrent`, `peer` or
  `bt`, and free dynamic-DNS suffixes: block lists match on them.
- `npx felinar tracker` refuses to start without `--allow` unless you pass `--open`. Allow the
  `summary.json` of every version you still serve (repeat `--allow`): it lists that version's infohash and the
  ledger's rendezvous infohash, the tracker serves the site's chat lane with them (derived from the ledger id), and it
  re-reads allow files when they change. A hub adds `--hub <its host name>` for its follow lane.
- File, private media and member ledger swarms get a new infohash with every upload, so no list can name them in
  advance. The tracker serves them in **uploads mode**: on by itself when an allowed `summary.json` has files or media on,
  or with `--uploads` (or an `uploads` line in an allow file). Listed infohashes are always served; an unlisted one is
  accepted while its connection is in fewer than 256 unlisted swarms (`--max-swarms-per-connection`; a browser uses one
  connection per tracker for all its torrents, so raise it for a pin node that holds more files) and the tracker holds
  fewer than 10,000 (`--max-swarms`), and a closed connection takes every peer it announced. The cost: anyone who can
  reach the tracker can use those slots to relay WebRTC offers for infohashes of their own, up to the caps; a flood can
  fill the 10,000 but never refuses your listed site, ledger and chat lane. Raise `--max-swarms` for a large hub (each
  swarm costs little memory; the sockets are what cost, see below).
- List it first in the pointer, then two public trackers: `--tr wss://rtc.example.com
  --tr wss://tracker.webtorrent.dev --tr wss://tracker.openwebtorrent.com`. Fewer trackers also keep the
  pointer under 450 bytes.
- `deploy/tracker/` has a Docker Compose setup with Caddy in front for TLS; its
  [README](../deploy/tracker/README.md) covers the allow list, sizing, monitoring and upgrades.

```sh
npx felinar tracker --host 127.0.0.1 --port 8000 --allow /srv/magnet/summary.json
```

What `tools/tracker.mjs` does and doesn't do: it validates offers, caps a message at 128 KiB, caps unlisted swarms
at 256 per connection and 10,000 in all, and refuses unknown infohashes outside uploads mode; it has no server ping or idle close, no per-IP quota (behind a proxy every connection has the proxy's address), no
`Origin` allow list and no metrics ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 7.1, which also has a
hardened reference deployment). Put it behind a proxy that closes idle sockets, and know that `caddy reload`
drops every WebSocket after 71 ms unless `stream_close_delay` is set. Visitors' loaders reconnect within one to
two seconds after a drop (the reconnect shim in `src/loader/torrent.js`; E2E scenario PEER-BLIP measured 1.3 s).

Capacity and cost, measured on `bittorrent-tracker` 11.2.3, which `tools/tracker.mjs` also runs on: about
25 KiB of memory per socket plus about 70 MB, so 20,000 sockets fit in about 0.6 GB; small sites expect 10 to
1,400 concurrent sockets; hosting runs from $0 (Oracle Always Free, which reclaims instances idle for 7 days)
to about $4 to $7 a month ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 7.1). A tracker sees visitors'
IP addresses and the infohash: list it in your privacy notice and don't log infohash and IP together.

## Pin node

A pin node is `tools/pin.mjs` running unattended: it keeps the real loader open in Playwright Chromium, so the
site's files and its ledger have one copy that is always online. It also serves visitors whose NAT blocks other
peers, when it runs on a public address, and it can write the ledger snapshot for `cs=` on a timer.

```sh
npx playwright install chromium
npx felinar pin https://example.com/ --headless --profile /var/lib/mw-pin/example.com \
  --snapshot /var/lib/mw-pin/ledger.json.gz --snapshot-every 600
```

- It clicks "Share and load" once with a real mouse click and keeps the choice in its profile.
- It logs the loader's status every 60 seconds (`--interval`), restarts Chromium with a backoff from 5 seconds
  up to 5 minutes, and reloads when the page shows "Update available: reload".
- Copying the snapshot to the URL that `cs=` names is up to you (a sync job); the tools don't do it.
- Without `--pin-key` it sends no heartbeat; watch it as [OPERATIONS.md](OPERATIONS.md) describes.
- It sees visitors' IP addresses like any peer. Run it for your own sites; pinning other people's content makes
  you their host.
- `deploy/pin/` has a Dockerfile and a [README](../deploy/pin/README.md). A small VM is enough to start ($0 to
  about $6 a month in the research, [PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 7.2); the cost per
  pinned site in Chromium is not measured.
- A hub's pin and mailbox in v0.3 is central storage with its own page:
  [Central storage](#central-storage-the-hub-pin-and-snapshot-service) and
  [recipes/hub-pin.md](recipes/hub-pin.md).

Since v0.3 C2 a pin node can also prove what it keeps ([SEEDING-AND-ZERO-SETUP-DESIGN](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), 3.1.6).
It is infrastructure that you or a hub run beside the static host and the tracker; the people who visit a site never run one.

- **A key of its own.** `node tools/keygen.mjs --out pin.jwk`, then `node tools/pin.mjs --pin-key pin.jwk` prints the public key and the command
  that names it in the site's settings, which you run where the owner key is: `node tools/ledger-admin.mjs cfg --key owner.jwk --file ledger.json --pin p256:...`.
  It is never the owner key, and the key file must not be readable by others. Visitors trust the node's hello, receipts and heartbeat only for the
  key `_mw.cfg.pin` names.
- **Receipts and a heartbeat.** With `--pin-key` the node answers `mw_pin1` challenges on the site's wires and signs a receipt once it holds a
  file whole. With `--status <file>` it writes a signed heartbeat every 300 seconds (`--status-every`, at most 600) that lists hashed ids, never an
  infohash in the clear; publish it at `<ws base>/pin-status.json`. A visitor's page says "Kept by the site" only on a receipt, or on a heartbeat at
  most 15 minutes old that lists the file.
- **The owner's own files at once.** `--files --auto-accept owner` pins the file requests whose author is the owner key without waiting in the
  moderator queue (owner decision SZ-6, awaiting sign-off). Every other request waits for `--approve`, and files are still never opened or rendered.
- **Not built yet: the request path.** In this release nothing in a visitor's page sends a pin request: `mw.files.pinRequest` and
  `mw.media.pinRequest` answer `E_POLICY` (C2 integration, [deviations/integration-c2.md](deviations/integration-c2.md) O-1). The pinned page's
  bridge (`file.request`) takes a request only when its author signed it for this ledger (`src/pin/frames.js` `makePinRequest`, checked with
  `verifyPinRequest` over the ledger id, infohash, size, SHA-256, time and name; unsigned and forged requests are refused, code review v0.3). Any
  script on the pinned page reaches that bridge, the site's own code included (a same-origin frame calls `window.top.__mwPinCall`), so the
  signature, not a top-frame check, is the boundary. `--auto-accept owner` pins at once only a request the owner key signed. Until a member's page
  can sign and send one, `--files` keeps what an operator enters at the node (`--queue`, `--approve`) and the site torrent; the end-to-end test
  E-PS-1 checks that the bridge refuses an unsigned request, then enters the request at the node's store and approves it as you would.
- **A monthly cap.** `--month-cap 500GiB` stops seeding pinned files once they have uploaded that much in a UTC calendar month and starts them
  again in the next; the site torrent always seeds.
- In Docker the same settings are environment variables (`PIN_KEY`, `PIN_STATUS`, `PIN_MONTH_CAP`, `PIN_AUTO_ACCEPT`; see
  [deploy/pin/README.md](../deploy/pin/README.md)), and the `pin` profile of [deploy/one-box/](../deploy/one-box/README.md) uses them on a rented server.

## CI/CD

`deploy/github-actions/publish-site.yml` is a GitHub Actions template for site owners. Read it before you use
it, and keep to these rules in any pipeline ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), section 10 and
M16):

- Set `permissions: {}` for the workflow and give each job only what it needs.
- Pin third-party actions to a full commit SHA, check out with `persist-credentials: false`, and protect the
  workflow files with CODEOWNERS.
- Build in a job without secrets. Upload and DNS writes run in jobs that assume narrow roles through OIDC,
  each behind its own environment with required reviewers. Never give a secret to a job that runs code from a
  fork's pull request.
- Serialise publishes with a `concurrency` group: the default `seq` is the clock, and two overlapping runs
  could deploy out of order.
- Make the pack reproducible (`--date` or `SOURCE_DATE_EPOCH`, else the git commit time) and run
  `--double-pack`, which packs twice and fails on any difference.
- Gate on `--verify-ws` (or `--verify-host` in drop-in mode) before any pointer is written, and run
  `check-site` after the deploy.
- Check the loader before the job that holds the key reads it: the template runs `tools/verify-release.mjs verify`
  on the built loader against the signed list of the pinned release (`FELINAR_RELEASE_KEY`, `--expect-version`), and
  `publish --release-list` checks it again. `publish` and `ship` from the command line refuse a `--dist` that is not
  the checkout's own build unless its signed list is given (`--release-list`, `--release-sig`, `--release-key`) or
  `--allow-unverified-loader` says to send it unchecked.
- Install with `npm ci --ignore-scripts` in every job, whatever `.npmrc` says.

The owner key is the hard part. `publish` signs with a key file, so signing in CI means storing the owner key
as a secret, and whoever can change the workflow can then sign for your site. The template signs in a job of its
own, in an environment you give required reviewers, and deletes the key file when the job ends; that limits who can
start a signature, not who can change the workflow. Signing through a key service (KMS) is not supported by the
tools yet. The safer pattern today: publish on your own machine and let CI upload, verify and deploy what you
published (the template's header says which jobs to drop).

## Hubs

A hub loads sites by magnet link from many publishers. A production hub serves each site from its own origin,
`https://<label>.<hub>/` with a 32-character base32 label, and needs:

- a domain the operator owns. A subdomain hub cannot run without one: a platform name such as `github.io` gives no
  wildcard certificate and no labels of your own, and neither nip.io nor sslip.io is on the Public Suffix List. Without a
  domain, use [doors](#doors) and light links instead;
- a wildcard certificate (CloudFront with ACM, Vercel, or Cloudflare Worker routes; not Cloudflare Pages or
  GitHub Pages) and a separate registrable domain without cookies;
- the built loader (`dist/`) on the apex and on every label, with `<meta name="mw-hub" content="subdomain">`
  added to the apex's `index.html` and `404.html` (no tool writes it yet);
- an edge rule that answers only the apex and names matching `^[a-z2-7]{32}\.` under the hub, so nobody can
  mint `bank-login.<hub>`;
- a Public Suffix List entry for the hub domain, which stops cookie tossing between sites. It does not stop a
  Safe Browsing listing of the hub domain from covering every label ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 06V claim 7);
- an abuse program: a contact, a notice process and a way to block a site.

0.3.0 has no hub denylist, so a hub operator has no way to block a site, neither at the gate nor for visitors who
already hold it. Don't run a public multi-publisher hub with it. The rules a v0.3 denylist must follow before it is
built are in [OPERATIONS.md](OPERATIONS.md#hubs-safeguards-and-the-rules-for-a-denylist-before-any-list-exists). The operating layer is on the
[ROADMAP](ROADMAP.md) for 1.0. A shared-origin hub is for one publisher and demos only: sites on it share one
browser origin and can access each other's data.

## Doors

> **Status: v0.3 C2, written together with its code, tested on loopback only.** The door page, the light link, `publish --door`,
> `publish --door-kit` and `check-site --door` are in this tree, with unit tests and a local probe in Chromium 156 and WebKit 27.2 on
> 127.0.0.1 (two doors, one stopped). No real host, no phone and no installed app has been tried. Two changes outside the doors lane are
> pending with the integrator: the SDK's handshake from the door view, and `ledger-admin doors` (until then no tool here writes `_doors`).
> The research is [S4](research/v03/S4-doors.md), cited here as F1, D3 and so on.

The site lives at its key; domains are doors. A door is any host that serves the loader. Every build has a door page,
`/_mw/open.html`, that opens any site from its **light link**:

    https://<door>/_mw/open.html#<the signed record, percent-encoded>[#mwgen=<blocks>][#mwd=<host>,<host>]

The record is signed for the hub scope `btih:<infohash>`, so it verifies on every door, and a link rewriter cannot add or remove a
door it names (that changes the signed text). `#mwd=` holds at most four unsigned hints from whoever shared the link: they are tried
last, only for bytes that are checked by hash, and only when they are public host names.

| Door | Where | The site runs | Identity there |
|---|---|---|---|
| Owner door | the site's own address and the origins in `org=` | in full: Service Worker, storage, the site's URLs | the site's own |
| Guest door | any loader host, the doors in `dr=` and the ledger's `_doors` | in the door view: a frame with `sandbox="allow-scripts"` | for this visit only |
| Hub door | a wildcard hub label (see [Hubs](#hubs)) | in full, one origin per site | the hub's |
| Emergency viewer | a `file:` or `data:` page on a computer | not built: data: has no `crypto.subtle` and nothing is kept (F9) | none |

### Light links: `publish --door`

    node tools/publish.mjs site --name my-site --scope example.com --key owner.jwk --chain my-site \
      --ws https://example.com/ws/ --org https://example.com \
      --door mirror.example.org --door door.example.net:8443

Besides the page tag, publish signs the same record for `btih:<infohash>` with `dr=mirror.example.org,door.example.net:8443` and
writes `link.txt` (the main link, at the first `--door`), `link-card.txt` (the main link, two fallback links, the `web+felinar:` form
and a QR code), `link-qr.svg` and `doors.json`. `--chain` is required: the infohash changes with every version, and the ledger id is
owner plus chain, so the site keeps one ledger on every door and across versions. `dr=` takes at most 8 hosts; the 450-byte warning and
the 900-byte limit apply to the link record as to the page tag. S4 measured a signed hub record at 457 bytes, 586 with four `org=`
origins, 601 with eight doors in `dr=`, and 730 with both, which fits a QR code of version 19 at level L (F1).

Put only your own origins in `org=`: an origin there receives the site's shared identity label, so a third-party host in `org=` could
take a visitor's key for your site. Doors other people run go in `--door` (`dr=`) and `_doors`.

### Doors without a domain

A site does not need a domain of its own. Publish it once with `--chain` and `--door`, and hand out `link.txt` or the QR
code in `link-qr.svg`: the site lives at its key, and any door opens it. Three doors need no purchase today:

- **Your `<user>.github.io` or `<name>.netlify.app` site with a door kit** ([Door kits](#door-kits-publish---door-kit)):
  upload the kit to the root of that free site. GitHub Pages sends no custom headers, so other doors see it as
  "answering, not checked".
- **A friend's host** that serves a door kit at the root of its name. A door can serve a hostile loader, so use doors run
  by people you trust, and check them with `check-site --door`.
- **A door on your own computer.** After `npx felinar build`, `npx felinar dev` serves the built loader on
  `http://127.0.0.1:8080/`; open `/_mw/open.html` there, choose "Open a link" and paste the light link. It serves only
  you, and only while that computer runs.

What a door costs, wherever it runs: a site opened at a guest door runs in the door view, with an identity for this visit
only and no storage (the table above); and a door kit is checked against the release key pinned in
`tools/verify-release.mjs`, which the release fills in (a copy of the tools from before that needs `--release-key` by
hand). No
release gate row G-DR has run on a real host or phone ([DEMO-RESULTS.md](DEMO-RESULTS.md)): doors are tested on loopback
only (e2e DOOR-DOWN, DOOR-HASH and DOOR-GUEST).

### What a door must serve

- HTTPS at the root of a host name (not a sub-path), like every loader host ([What the host must do](#what-the-host-must-do)).
- `/mw-sw.js` with status 200, a JavaScript type, `Cache-Control: no-cache` and no redirect.
- `/_mw/*` byte for byte, with real types: no minifier, image optimiser or other transform that changes bytes.
- `/_mw/door.json` with `Access-Control-Allow-Origin: *` and `Cache-Control: no-cache`. It lists every file of the build with its
  sha256 and SRI value. A page probes it to see whether a door answers (a block page answers 200 too, so the content is checked), and
  the Service Worker never answers or keeps it, so a probe of a page's own address reaches the host.
- A **full door** also serves a site's bytes: its web seed copy under `/ws/<name>/` (Range requests answered with 206) and its
  `.torrent` at `/_mw/t/<btih>.torrent`. A page on a door takes the `.torrent` from the first door whose copy hashes to the infohash
  (250 ms between starts, at most 3 at once, 4 s to the first byte and 12 s per door, then a 10-minute pause for a door that failed)
  and adds up to three doors to its web seeds; every piece is checked against the torrent.

| Host (S4 F5) | Loader door | Full door | Door settings |
|---|---|---|---|
| GitHub Pages | yes | yes | no custom headers: other doors see this door as "answering, not checked"; `/mw-sw.js` is cached for up to 10 minutes |
| Cloudflare Pages | yes | no (Range gives 200) | `_headers` and `_redirects` are read |
| Netlify | yes | yes | `_headers` and `_redirects` are read |
| Vercel | not tried | not tried | the kit writes `vercel.json` |
| A rented server | yes | yes | the kit's Caddyfile |

Spread doors over providers, registrars and countries: free plans close (S3 lists one that ended in 2025).

### Door kits: `publish --door-kit`

    node tools/publish.mjs --door-kit door-kit --dist dist \
      --release-list hashes-dist.json --release-sig hashes-dist.json.sig --release-key <pinned release key>

The kit is the loader exactly as released. Publish refuses unless every file of `dist` matches the signed release list under the
pinned key (`tools/verify-release.mjs`), copies `dist` unchanged and adds the list and its signature, `.nojekyll`, `_headers`,
`_redirects` (the root opens `/_mw/open.html`, and a link's fragment stays with the browser through the redirect), `vercel.json`, a
`Caddyfile` and `README-DOOR.txt`. `--door-site <publish output>` (repeatable) also lays out a site's web seed copy and `.torrent`, which
makes it a full door. Upload the folder to the root of a host name. Anyone can check a kit offline:

    node tools/verify-release.mjs verify door-kit --list hashes-dist.json --sig hashes-dist.json.sig --pubkey <pinned key> \
      --door-kit --expect-version <version>

`--door-kit` accepts the host settings only as the kit makes them, byte for byte (`_headers`, `_redirects`, `vercel.json`, the
`Caddyfile` and the README), refuses any other host settings file, any unlisted file under `_mw/` except a site's `.torrent`, and
code at the root that is not in the list, and prints every file outside the signed list. A handed-over kit whose `_redirects` was
changed to serve another worker therefore fails here, not only at `check-site --door`.

### Checking a door: `check-site --door`

    node tools/check-site.mjs https://mirror.example.org/ --door [--allow-no-cors]

It contacts that host only: the address must be the HTTPS root of its name, `/mw-sw.js` must answer 200 as JavaScript without a
redirect, `/_mw/door.json` must be a door list with `Access-Control-Allow-Origin` (`--allow-no-cors` makes a missing header a warning,
for GitHub Pages), and every `/_mw/*` file it lists, and `/mw-sw.js`, must have exactly the bytes it names. Exit code 1 on a failure.

### When a door stops answering

A page that already runs (from its Service Worker, an installed app, or an open tab) probes its own `/_mw/door.json` after each load.
When that fails it probes up to three other doors, 250 ms apart, and shows "This address is not answering. The owner lists: ...", with
one button per door. Nothing switches by itself, because the visitor's data on this address stays here. The doors come from, in this
order: the current door, the last door that served this site's `.torrent`, the record's `org=` and `dr=`, the ledger's `_doors`, then
the link's hints; at most 12. Settings has a Doors section with the same list, each door's state, and "Copy link with doors", which
copies this door's light link with the doors the record does not sign as hints.

**The ledger's `_doors`** is an owner-only key, `{ "v": 1, "d": ["<host>", ...] }`, at most 24 hosts and 2,048 bytes. Readers ignore a
moderator's `_doors` and an invalid one (its block stays valid), and take at most one change an hour on each device. It tells an open
page or a stored copy where else the site lives; it cannot move a link.

### The installed door app

The door page links its own manifest (`/_mw/door.webmanifest`): a separate app with `protocol_handlers` for `web+felinar` to
`/_mw/open.html#%s`, a share target (GET) and `launch_handler` `navigate-existing`. The site manifest keeps none of them (code review
round 1: a site app must not claim links and then show only itself). Desktop Chrome and Edge ask once before they hand
`web+felinar:` links to the app; Firefox desktop has no manifest handler; Safari, iOS and Android browsers ignore `web+felinar:`.
Android Chrome opens https links inside the app's scope (`/_mw/`) in the app. On iOS, add the app from the Home Screen and open it once
while online; no way was found to open it from a link (F4, unverified on a device). Without a handler, the door page offers "Open a link"
(paste a light link). Nothing that arrives by a handler, a share or a paste loads before the visitor clicks Load (C3).

### What doors cannot do

- A link cannot reroute itself: with its first door down and nothing cached, the visitor sees the browser's error page and no code of
  ours runs. Give people more than one link.
- A door cannot be proven good on first use. A hostile or altered door can serve a hostile loader; the checks help only after a good
  first load, or when someone verifies the door out of band (`verify-release.mjs`, `check-site --door`).
- Doors do not beat a whitelist or a shutdown: at least one door must be reachable and not intercepted by a certificate the device trusts.
- `web+felinar:` does nothing on iOS, Chrome Android or Firefox Android.
- A site at a guest door runs reduced: no storage, no Service Worker, no relative `fetch`, links that change the address bar inside the
  site (History API) do not work. Full mode needs the site's own address or a wildcard hub.
- A signed list of doors cannot reach someone who never loaded the site, and cannot recall a link that was already shared.
- The kill switch needs a host the operator controls; an immutable host has none.
- A phone cannot be made to keep a site: Safari deletes script data after seven days unless the app is on the Home Screen, and Android
  clears it with the browser's site data. Offline use on iOS is not promised.
- Human-readable names still need DNS, and a network observer still sees which door a visitor contacts. A door sees the visitor's IP
  address and the time, not which site: the light link's fragment never leaves the browser.
- `data:` and `file:` pages are desktop last resorts as far as tested, and this release ships no viewer for them: the browser refuses a
  Service Worker to a `file:` page, and treats a top-level `data:` page as not a secure context, so it gets no `crypto.subtle` and no
  storage (measured in Chromium and WebKit, research S4 F9).
- Not measured or verified: Firefox on `file:` and `data:` pages (when this was written Firefox would not start under Playwright on the
  test machine; it runs in the harness since 2026-10-22, and no scenario covers these pages there); any phone
  (iOS first launch, Android installing the door app with an SVG icon, `file:` and `data:` on mobile); whether a worker can register from
  a Signed Exchange (the specification is silent); whether messaging apps make `web+felinar:` text clickable.

## Owner duties

With open writing, every visitor stores and passes on posts by strangers. You moderate what your site makes
visitors redistribute.

- You are the publisher of the site. For the data your loader makes visitors' browsers send (their IP address to
  trackers, STUN servers, the DNS-over-HTTPS service and other visitors) you are most likely a controller under the
  GDPR and the UK GDPR, if they apply to you: they apply if you are in the EU or the UK, or offer the site to people
  there or monitor them (Art. 3 of each). With open writing you may be a hosting provider under the EU Digital Services
  Act, if the site has a substantial connection to the EU, and the provider of a user-to-user service under the UK
  Online Safety Act, if UK people use it: the Act names the individual who controls who can use the service when no
  organisation does (s. 226(3)). In Canada, PIPEDA applies to you if you handle personal information in the course of
  commercial activities, and Quebec's private-sector Act if you carry on an enterprise, which includes an organized
  activity that is not commercial. Then you need a person accountable for privacy, a privacy notice in clear language
  (and in French for Quebec visitors), a way to answer access requests within 30 days, a record of breaches and, for
  Quebec, an assessment before personal information goes outside Quebec. If you store other people's files or posts for
  the public (a pin node, a snapshot of an open ledger), Canada's Mandatory Reporting Act may apply to you
  ([OPERATIONS.md](OPERATIONS.md#the-worst-content)). The loader, the identity page and `@felinar/verify` send no
  e-mail or text messages, so Canada's anti-spam law (CASL) is not engaged by them; if you add anything that sends
  messages on a visitor's behalf, CASL asks for consent, your identity and an unsubscribe in commercial messages. These
  are the research's readings from the laws' texts and the regulators' guidance
  ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 5.3; research w2b-06, section 2; the AI research review of
  2026-10-22). No lawyer has reviewed them, and they are not legal advice. Details:
  [OPERATIONS.md](OPERATIONS.md#positions-by-jurisdiction) and [PRIVACY.md](PRIVACY.md#who-is-responsible-for-what).
- Name who answers abuse and legal notices: `publish --ct <https: or mailto: URL>` puts the contact into the
  signed pointer, and `publish` warns when the ledger is open (`--policy open`) and there is no `--ct`. Link
  your privacy and terms page with `--lg <URL>`.
- Declare the audience with `--aud`: `personal`, `eea`, `eu`, `uk`, `qc`, `quebec`, `kids` or `sensitive` make
  the blocking consent gate the default for visitors; `general` changes nothing. There is no owner switch that
  forces host-only, so do not publish a site directed to children with felinar: peers would receive their IP
  addresses, and in the US COPPA needs a parent's consent first ([OPERATIONS.md](OPERATIONS.md), children's content).
- Keep personal data out of keys and values, even encrypted: everything written with mw.db is public and
  copied to every visitor.
- Keep the default `--policy owner` unless you will moderate. Open writing invites spam, and the
  proof-of-work fee on each post slows a flood but doesn't stop a determined writer.
- Remove posts with your moderator key (Settings, "Import moderator key" in the loader) or with
  `npx felinar ledger`, and ban an author when you need to. Bans and deletions can't be undone. The owner
  key never enters a browser; moderators get their own keys.
- To take the site down, publish a withdrawal ([Takedown](#takedown)). Loaders stop sharing the site and delete
  every stored version.
- Keep the owner key offline and backed up. A key rotation (`publish --prev-key <old key>`) keeps the ledger,
  because the pointer names the ledger owner (`lo=`); the rotation steps are in [OPERATIONS.md](OPERATIONS.md).
- Keep the snapshot (`cs=`) current, answer notices within the times in [OPERATIONS.md](OPERATIONS.md), and
  publish a privacy notice ([PRIVACY.md](PRIVACY.md)).
- v0.3, if you turn chat, files, private media or calls on: name your own tracker and STUN servers, write your
  illegal-content risk assessment and decide on public uploads yourself with the duties of
  [OPERATIONS.md](OPERATIONS.md#abuse-and-legal-operations) in front of you (no lawyer reviewed them for you), moderate the
  pin queue and reports, and leave the children's defaults on unless you check age yourself, outside felinar ([OPERATIONS.md](OPERATIONS.md#owner-settings), [PRIVACY.md](PRIVACY.md#defaults)). Never ask visitors
  for their 12 words.

## v0.3: what a v0.3 deployment adds

> **Status: v0.3, built and reviewed.** This section describes the parts a v0.3 deployment adds to the ones
> above: central storage for a hub, a relay that stays off by default, an identity origin you can host yourself, and
> the sign-in widget. Source: [review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), cited "R"; a number after R
> is its section. The tools it names are in this tree, and 0.3.0 carries them; where
> this page and a tool differ, its `--help` is the reference. Everything above stays true in 0.3.0.

### Central storage: the hub pin and snapshot service

A hub that wants its members' sites to stay reachable when their owners are offline runs a **pin and snapshot
service**. It pins each member's recent ledger window and public media and writes the `cs=` snapshots. Acting as the pin mailbox
that holds encrypted messages and join requests for people who are offline (R 3.2.4, MF-66) is **(proposed)**: the node has the
mailbox store (`--mailbox`), but no page sends it frames yet (code review v0.3, round 2;
[recipes/hub-pin.md](recipes/hub-pin.md)).

**It is central storage that the operator pays for, and the operator can be compelled to remove what it holds.** On a hub
with pins on, "nothing central holds everyone's data" is no longer true, and the hub's pages and privacy notice say so.
Each item in the social example shows which case it is in: "Kept by the hub" when a pin holds it, "Available only
while someone who has it is online" when none does.

Why a hub would pay for it: without a pin, for a typical person whose ledger 20 followers read three times a day with
each session open for 120 seconds, nobody who holds the ledger is online 98 percent of the time, and nobody who holds
their media is online 99 percent of the time (the scale judge's Little's-law model, which uses the w2c-07 lab; a
model, not a measurement, and the real figure is row G-SC-4 of [DEMO-RESULTS.md](DEMO-RESULTS.md)).

| What | Figure | Source |
|---|---|---|
| Storage price on Cloudflare R2 | US$0.015 per GB-month, with no egress fee | list price read on 2026-10-17 (the Costs table below; [w2a-07](research/w2a-07-hosting-cost-bandwidth.md), F7, as used by the scale judge) |
| 100,000 members with 1 GiB each | about US$1,610 a month | arithmetic: 100,000 x 1.0737 GB x US$0.015, the scale judge's section 2.7 (a model of the stored bytes; requests and a pin node's own machine are extra) |

The pin sees IP addresses, message tags, sizes and times, holds the ciphertext of private items and the plaintext of
public files it pins, and cannot read direct messages, private records or private media. A lighter alternative for one
file is a web seed on plain hosting (`tools/webseed-file.mjs` fills the listing's optional `ws` field; for private media
the copy is ciphertext). Without a pin on disk or a web seed, a file has no durability.

### TURN: off by default

A relay lets two browsers talk when no direct path exists. Nothing in v0.3 turns one on for you, and the loader does not
use one unless the owner sets one up (R 2.7.8). Direct channels for chat are a later feature (P2) and are not built in the
chat code (`docs/deviations/chat.md`, D-15); calls (v0.3 C2, below) are the first use of a relay. When an owner wants one, they
choose between two options, which the design labels (a) and (b):

| Option | What it is | Rules |
|---|---|---|
| (a) static credentials | the site ships fixed relay credentials (set with `publish --turn ...`; `_mw.cfg.turn` names the relay's URLs and `mode` `static`) | allowed with a low bit rate and session quotas, `allowed-peer-ip` deny lists for private address ranges, credentials rotated with every release, and a consent card that names the operator and says the relay is open to anyone who loads the site. The relay's compose file ships with peer-address logging off and a stated retention |
| (b) a credential endpoint | the site asks an endpoint for short-lived credentials (`mode` `endpoint`) | the endpoint is a backend and is labelled one |

Static credentials were rejected as the recommended default because an open relay invites abuse (R 1.4, SYB A17). A relay
sees both IP addresses of a pair, how many bytes pass and when, and never the content. Say which operator runs it in the
privacy notice ([PRIVACY.md](PRIVACY.md#the-recipients-register-v03)). The cost of running one is not measured.

**Calls (v0.3 C2).** The first thing that can use a relay is a call between two signed-in contacts
([SEEDING-AND-ZERO-SETUP-DESIGN](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), 3.5). The two browsers connect directly, using the site's own STUN
server, and a call goes through a relay only when the owner has set one up as above and the pair cannot connect without it. With no relay, some
calls will not connect; plan for 10% to 30% of pairs needing one (a planning range from vendor estimates and 2016 data in the research, not a
measurement). A choice to send a call through the relay on purpose, so that the other person sees the relay's address and not yours, is
planned and not built: 0.3.0 has no switch for it. A site turns calls on in two steps: `publish --calls` (it implies
`--chat` and needs the site's own tracker and STUN), and `node tools/ledger-admin.mjs cfg --key owner.jwk --file ledger.json --chat members --calls contacts`.
Calls above 6 people, or 4 with video, need a mixing server, which v0.3 does not have.

### Your own tracker and STUN servers for chat and files

When you turn chat, files or calls on, the site must name its own tracker and STUN servers (`publish --tracker wss://...
--stun stun:...`; `--calls` implies `--chat`). The four public trackers and the two default STUN servers are not used for chat, groups or private
media, because they would learn which addresses talk to which (R 2.7.1, MF-44). The tracker is the one in
[Your own tracker](#your-own-tracker); a STUN server only tells a browser its public address, and you choose and name one. Files and
private media need its uploads mode (on by itself when the allowed `summary.json` has files or media on): without it the tracker
refuses every file swarm and nobody finds a peer.

### The identity origin: running your own with `tools/build-idp.mjs`

The identity origin is the one place where a person's root lives. Anyone may run one: a company, a hub, a site owner or
a person (R 1.5, N-1). By design, the project hosts no identity page: run your own or use one you trust. Owner decision
N-2 is decided for 0.3.0 as "none" ([PUBLISH-CHECKLIST.md](PUBLISH-CHECKLIST.md), section 16.6), so no default exists and
no document names one; the release carries the page as `felinar-<version>-idp.zip` for site owners to serve. Run your own
if you do not want a third party in that position, or if you want sign-in under your own name. A site whose visitors
only read needs no identity page at all: the owner changes it by publishing again or with `tools/ledger-admin.mjs`, which
uses the owner key offline (moderators who write from a browser sign in like anyone else).

A site names the identity origin it uses: `publish --idp <origin>` puts `idp=` in the pointer, or a `<meta name="mw-idp"
content="https://...">` tag in the page names it. With neither, sign-in fails with `E_IDP_UNREACHABLE` ("no identity page is
configured for this site"), so visitors cannot sign in to write. Servers choose which identity origins they accept
(`allowIdps` in the verifier of [recipes/signin-server-node.md](recipes/signin-server-node.md)).

1. **Build it** from a checkout: `node tools/build-idp.mjs` produces the static bundle with its own Service Worker, a
   build id and a bundle hash. Publish the hash with every release; the cards show the build id and the hash
   (R 2.19). A hub that offers one identity on all of its labels is named at build time:
   `--hub-suffix <suffix>` for each one-operator hub suffix you run alone and have on the Public Suffix List (never a
   platform suffix such as `github.io`, where strangers register labels), and `--shared-origin <https origin>` for each
   hub that serves many publishers on one origin (keys there are for this visit only). Without them every hub gets
   per-site keys; both enter the build id and `build.json` (code review v0.3).
2. **Serve it on a host name of its own,** over HTTPS, as static files only. It must be opened only as a top-level
   window, so it sends `frame-ancestors 'none'`. R 2.2.4 gives its script policy as `script-src 'self'
   'wasm-unsafe-eval'` and asks for `Referrer-Policy: no-referrer`; use the headers the build documents. Today's
   passphrase hashing runs as plain JavaScript and does not need the second token
   ([deviations/idcore.md](deviations/idcore.md), item 2).
3. **Know what the host name does.** A passkey is bound to the identity origin's host name (its WebAuthn RP ID). People who
   create a passkey at your host cannot use it at another one. Moving the host means everyone restores from the 12 words
   or the backup file.
4. **Know what the host sees.** The IP address and the time of popup loads that miss the cache and of update checks
   (the bundle is cached by its own Service Worker, so by design most sign-ins make no request; unmeasured). Name
   yourself as a recipient in your privacy notice, say how long the host keeps its access log, and name the person who
   answers requests to see or correct what it holds (PIPEDA, Schedule 1, clause 4.8.2; for Quebec visitors, ss. 3.1 and
   8.2 of the private-sector Act). The identity page itself names no operator and links no notice in 0.3.0; until a
   build option adds that line, name the identity page in the privacy notice of every site that uses it.
5. **Keep it boring.** No analytics, no third-party scripts and no other site on the same origin. The origin that holds
   roots must run nothing else.
6. **Be ready for a bad build.** The runbook is in [OPERATIONS.md](OPERATIONS.md#runbooks-for-v03-incidents).

#### Hosting it without buying a domain

None of these hosts costs money. None was tried with a passkey on a real device: the passkey column follows from how a
passkey is bound to the host name (`src/idp/passkey.js` takes the RP ID from the page's host name), not from a measurement.

| Host | The headers of `dist-idp/_headers` | Passkeys | What it costs you |
|---|---|---|---|
| `<name>.pages.dev` (Cloudflare Pages) or `<name>.netlify.app` (Netlify) | sent: both read `_headers` | bound to that name | one company each, which can close the account or the name; both suffixes are on the Public Suffix List, so other customers' pages are other sites |
| `<user>.github.io` (GitHub Pages) | not sent: GitHub Pages sends no custom headers ([recipes/github-pages.md](recipes/github-pages.md)), so no CSP and no `frame-ancestors`; only the page's own refusal to run inside a frame protects it | bound to that name | not recommended for the page that unlocks roots |
| An HTTPS origin on an IP address, such as `https://203.0.113.7` | whatever your server sends | none: browsers refuse an IP address as a passkey's relying party (reported), and the identity page offers the passphrase card in the same window | identities work with a passphrase; people lose passkeys, not identities |
| A sibling name on the one-box (`id-<a-b-c-d>.nip.io`, never a child, path or port of the site) | | | planned for 0.3.x, not built and unmeasured |

**Moving to another host.** Passkeys, and the passkey-wrapped copy a site keeps for a person, do not move: a passkey belongs
to the host name it was made at. The 12 words restore the public identity (the keys a site knows a person by do not depend
on the identity page's host name, [ARCHITECTURE.md](ARCHITECTURE.md), 15.1), and the backup file restores everything,
the per-site vault included. On a host that is not your long-term one, make the backup file at the first sign-in. Sites
then name the new host with `publish --idp`.

### The sign-in widget and its self-hosted tag

A site that offers "Sign in with felinar" serves the widget from its own origin with a Subresource Integrity hash and
never loads it from a shared host: a shared widget host would see every site that uses it (R 2.3.6, SC-7, STALK A7).
`publish --signin-widget` copies the widget to `/_mw/signin.js` and prints the tag:

```html
<script type="module" src="/_mw/signin.js" integrity="sha384-..." crossorigin></script>
```

Send `Cross-Origin-Opener-Policy: same-origin-allow-popups` on the pages that have the button, never `same-origin`, or
the identity window cannot reach the page. Update the `integrity` value whenever you update the widget file.
The step-by-step page is [recipes/signin-widget.md](recipes/signin-widget.md).

## Costs

| Host | Role | List price (read 2026-10-17) |
|---|---|---|
| GitHub Pages | loader, drop-in host, same-origin web seed | $0; 1 GB site, soft 100 GB a month, no commercial sites |
| Cloudflare Pages | loader, drop-in host | $0; 20,000 files and 25 MiB per file on Free |
| Cloudflare R2 | web seed | no egress fee; $0.015 per GB-month; $4.50 and $0.36 per million Class A and B requests |
| S3 + CloudFront | everything | $0.085 per GB (first 10 TB, US) and $1.00 per million HTTPS requests; 1 TB and 10 million requests a month free; flat plans at $0, $15, $200 and $1,000 |
| Netlify | loader, drop-in host | Free: 300 credits (about 15 GB), then every project pauses; Pro: $20 for 3,000 credits |
| DigitalOcean droplet | one-box: loader, web seed, tracker (no domain needed) | from $4.00 a month with 500 GiB of transfer and an IPv4 address (read 2026-10-20) |
| Hetzner cloud | one-box, as above | from EUR 5.99 and 6.49 a month excluding VAT (read 2026-10-20); its cheapest line was marked "Currently not available" |

Source: [MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), section 11; the two server rows: [S2](research/v03/S2-zero-setup-hosting.md), F15.

- **Shell mode** downloads each version once per visitor, from peers and from the web seed together. With
  nobody online the web seed carries all of it, and for a site under about 16 MiB it carries nearly all of it
  anyway: peers start only after the visitor's choice and a first connection, by when the web seed has
  finished ([WHY.md](WHY.md#honest-economics)).
- **Drop-in mode** fills a visitor's copy from the host's web seed only on unmetered networks at idle, once per
  device, so the host serves the whole set of non-HTML files to every new device, not only the pages it opens.
  The multiplier is M = (S x (1 - p) + p x B) / B, where S is the size of the copy, B the bytes of a typical
  visit and p the share that peers fill. For a 20 MB copy and a 1.5 MB visit with no peer help, M is 13.3
  ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), M10; a model, not a measurement).
  `publish --dropin` prints the copy size for your site; on zero-egress hosts it costs nothing.
- **Per-request billing**: a cold visit to a shell site makes about one ranged request per piece plus one per
  file, and the stock WebTorrent client adds a preflight per file: 431 requests for an 8 MB site of 200 files
  ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), O3). felinar's patched client sent no preflights in
  Chromium 156 and WebKit 27.2, which leaves about 230 by the same arithmetic. Flat-rate or zero-egress hosts
  avoid that bill.
- **Your own tracker and a pin node** cost $0 to about $7 a month each (the sections above). Monitoring as
  [OPERATIONS.md](OPERATIONS.md) describes costs $0.
- **A hub's pin and snapshot service** (v0.3, proposed) is storage you pay for: see the figures, with their source, in
  [Central storage](#central-storage-the-hub-pin-and-snapshot-service).

## What publish writes

| File | What it is | Where it goes |
|---|---|---|
| `shell/` (with `--shell`) | the loader with the pointer stamped into `index.html` and `404.html` | the host root (shell mode) |
| `site/` (with `--dropin`) | your site with the pointer stamped into every page, the runtime under `/_mw/`, `/mw-sw.js`, `/.mw/` and `/_mw/t/<btih>.torrent` | your host (drop-in mode) |
| `<name>/`, `<name>.torrent` | the web seed files and the torrent | under the web seed base (shell mode) |
| `site.torrent` | the same torrent, for `check-webseed` | stays local |
| `genesis.json` | the ledger's first block, a snapshot | the `cs=` URL |
| `pointer.txt`, `meta.html`, `dns.txt` | the signed pointer as text, as a page tag, and as a TXT record | the shell, the stamped pages, DNS |
| `magnet.txt` | a magnet link (unsigned: no owner key) | for hubs and sharing |
| `webseed-layout.txt` (shell mode), `csp.txt` | the keys to upload with an S3 CORS rule, and the CSP additions | reading |
| `mw-sw-kill.js`, `sdk-static.js` | the kill switch, and a static `/_mw/sdk.js` for a plain copy of the site | the host, when needed |
| `summary.json` | everything above as JSON, including `rendezvousBtih` | the tracker's `--allow`, your scripts |
