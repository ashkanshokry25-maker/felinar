# felinar runbook (0.3.0)

How to build, test and demo felinar, publish a site, put its pointer in DNS, deploy in the right order, switch
it off, and move an existing static site to drop-in mode. ARCHITECTURE.md says what the system does and why;
this file says what to type. Everything here was checked on macOS with Node 24.22 on 2026-10-19, before v0.3, unless
marked otherwise; the test counts below are those of 0.3.0 (2026-10-21).

What felinar needs, said plainly: an HTTPS static host (it serves the loader on every visit, it is the trust
root, and its files are the web seed that keeps the site loading when no visitor is online), WebSocket trackers and
STUN servers (public ones or your own), a DNS-over-HTTPS service (shell pages on a public hostname ask it for updates
once a visitor shares, whether or not the pointer is published in DNS), and for the site ledger a snapshot file on the
host or a pinned node. There is no backend of ours. The site ledger is a signed,
hash-linked log that every visitor copies and verifies. No mining, no consensus, no finality.

## 1. Setup

    export PATH=$HOME/.local/share/node/current/bin:$PATH     # Node 24.22 on this machine; any Node >= 22 works
    npm ci                                                     # .npmrc has ignore-scripts=true

Dependencies are pinned in `package-lock.json`; the vendored `webtorrent.min.js` is pinned by sha256 in
`build.lock.json` and the build fails if it changes. Playwright's Chromium and WebKit are needed only for the
browser tests and the demo seeder (`npx playwright install chromium webkit`).

## 2. Build

    npm run build          # = node build.mjs; writes dist/

`dist/` is the shell host: `index.html`, `404.html`, `mw-sw.js` (classic Service Worker), `mw-sw-kill.js` (the kill
switch), `_mw/` (boot.js, loader.js, sdk.js, sdk-static.js, mw.js for drop-in, sw-core.js, pow-worker.js,
webtorrent.min.js, ui.css, manifest, icon) and `build.json`. Every bundle targets Safari/iOS 15.4, Chromium 110 and
Firefox 115, except `boot.js`, which is built at ES5 so that older browsers can parse it and show why they stop.

## 3. Tests

| Command | What | Expect |
|---|---|---|
| `npm test` | post-floor API lint of `src/` + every non-browser unit test | 2,314 tests: 2,305 pass, 0 fail, 1 skipped, 8 todo (publish preparation runs of 2026-10-26) |
| `npm run test:browser` | `*-browser` unit files in Chromium and WebKit (127.0.0.1 only) | 42 tests: 41 pass, 1 skipped (`sw-browser`, v0.1), after `npm run build`; before a build `tools-v03-pin-browser` skips too |
| `npm run test:example` | the example sites' own checks (Chromium and WebKit) | 186 pass |
| `npm run test:e2e` | `node test/e2e/run.mjs`: ARCHITECTURE section 12 end to end in Playwright Chromium, plus the v0.2.1, v0.3, C2 and review-round scenarios (the media and files rows need `ffmpeg` on PATH for their fixtures: `brew install ffmpeg`; the CI workflow installs it) | 102 scenarios, 102 PASS, 1,189.6 s with the WebKit and Firefox runs on the same machine |
| `npm run test:e2e:webkit` | the same plus W7 (cold start in WebKit) and the WebKit variants | 107 scenarios, 107 PASS after one alone rerun (E-MD-6), 1,137.4 s with the other two runs |
| `npm run test:e2e:firefox` | the same plus F7, the Firefox variants and 33 scenarios in a Firefox context | 140 scenarios, 140 PASS, 1,445.9 s with the other two runs |

The counts are those of the independence round of 2026-10-25 (10:00 to 10:30 ET, on checkpoint `0507946`);
the end-to-end suites ran at the same time, and the scenarios that missed a wait under that load passed alone right after.
[INTEGRATION-STATUS.md](INTEGRATION-STATUS.md) has the latest run.

E2E flags: `--only 9,10B` (scenarios 2 to 6 build on the visitors 1 and 2 leave open, so run them with their
predecessors; 8 and later are self-contained), `--keep` (leaves `.tools/e2e/run-*/` with keys and publish output),
`--headed` (local debugging only). On a failure the run prints the console, page errors, loader log and worker state of
every open visitor. The run fails if any request leaves 127.0.0.1. Scenario 11 (a peer declaring an oversized
message) runs as `PEER-11`; the 256 KiB length cap is also unit-tested (`loader-app-torrent`).

Unit files are listed explicitly by `tools/run-unit.mjs` (`node --test <directory>` does not work on Node 24). To
run a few: `node --test --test-timeout=180000 test/unit/sw-core.test.mjs test/unit/dropin-swreg.test.mjs`.

## 4. Demo

    npm run demo                          # desktop tier: http://localhost:8080/ on this computer (full mode)
    npm run demo -- --tls                 # LAN tier: https://<lan-ip>:8080/ for phones and other computers

The demo builds the loader, publishes `examples/peer-guestbook/` with `--policy open` (so the guestbook takes posts), starts a
tracker (port 8000) and the dev server, seeds the site from a headless page, and prints the tier and the URL. On the desktop
tier it also builds the identity page (`dist-idp/`) and serves it on port 8081 (`--idp-port`), and the pointer names it: a
post signs in there first. The LAN tier serves no identity page, so a post there fails. One demo
key (`.tools/demo/owner.jwk`) signs every site, and each site folder gets its own ledger: a chain label made up once
per folder and kept in `.tools/demo/sites.json`, with its publish output in `.tools/demo/publish/<label>/`.

- Desktop tier: `localhost` is a secure context, so the Service Worker, WebCrypto and the ledger all work.
- LAN tier (`--tls`): browsers only run the loader on HTTPS (or localhost). The certificates come from mkcert:
  `brew install mkcert nss && mkcert -install`, then install the mkcert root CA on the phone (the demo prints the
  iOS and Android steps; `mkcert -CAROOT` shows where it is). Without a trusted certificate the phone shows "This page
  must be served over HTTPS (or localhost)". Your own certificate: `--cert <file> --key <file>`. A specific address:
  `--lan-host <ip or name>`; listen address: `--bind`.
- Android without certificates: `adb reverse tcp:8080 tcp:8080 && adb reverse tcp:8000 tcp:8000 && adb reverse tcp:8081 tcp:8081`
  and open `http://localhost:8080/` on the phone (desktop tier, with its identity page).
- The real test is a real host (GitHub Pages, Cloudflare Pages, or S3 behind CloudFront): see `docs/DEMO-RESULTS.md`
  for the release gate, which needs real phones.

## 5. Publish a site (shell mode)

    node tools/keygen.mjs --out owner.jwk          # P-256 owner key, file mode 600; prints the fingerprint
    node tools/publish.mjs ./site --name my-site --scope example.com --key owner.jwk \
      --ws https://example.com/ws/ --tr wss://tracker.example.com \
      --cs https://example.com/ws/genesis.json --shell --out dist-publish --verify-ws

- Keep `owner.jwk` off every web server and out of every browser; it never needs to be in one. Moderators get their
  own keys (`keygen`, then `--moderator <pub>`) and import them in the loader's Settings.
- `--ws` is the web seed base: upload `dist-publish/<name>/` there (files are addressed `<ws>/<name>/<path>`) and
  `dist-publish/<name>.torrent` next to it (the default `xs=`). With `--ws` and no `--xs`, `xs=<ws>/<name>.torrent`.
  A pointer with neither `ws=` nor `xs=` only loads while another visitor is online.
- `--tr` is the exact tracker list visitors use for a signed pointer; `--tr public` adds the four public defaults.
  Your own tracker: `node tools/tracker.mjs --host 0.0.0.0 --allow dist-publish/summary.json --tls <cert> <key>`
  (`summary.json` allows both the site torrent and the ledger rendezvous swarm, `rendezvousBtih` since v0.2.1; the tracker refuses to start without `--allow`
  unless `--open`).
- `--cs` points at the ledger snapshot. Upload `dist-publish/genesis.json` to that URL: without it, visitors cannot
  write to an `open` or `allow` ledger until the genesis block reaches them from another visitor. Later snapshots:
  `node tools/snapshot.mjs <url|export.json> --out genesis.json`.
- Ledger policy: `--policy owner|allow|open`, `--bits <n>` (the proof-of-work fee for non-owners), `--moderator`,
  `--allow`. The genesis block is minted on the first publish and reused from `<out>/genesis.json` afterwards.
- `--shell` writes `dist-publish/shell/`: the loader with the pointer stamped into `index.html` and `404.html`.
  That directory is the host root in shell mode.
- `--verify-ws` withholds the pointer until `tools/check-webseed.mjs` passes against `--ws` (it contacts the web
  seed host; it prints the targets first).
- Pointers are signed and expire: `--exp <days>` (default 90, at most 399, one day under the format's 400-day limit)
  and `--seq <n>` (default: Unix time, never later than it).
  The loader warns the owner 14 days before expiry; re-run publish (same files give the same infohash) to re-sign.
- Outputs: `site.torrent`, `<name>.torrent`, `<name>/`, `magnet.txt`, `pointer.txt`, `meta.html`, `dns.txt`,
  `webseed-layout.txt` (keys, S3 CORS JSON, CloudFront note; shell mode only), `genesis.json`, `summary.json`,
  `csp.txt`.

## 6. The pointer: page tag and DNS

The page tag (`<meta name="mw-pointer" content="...">`, in `meta.html`, already stamped by `--shell`) is the primary
bootstrap. DNS is the update channel:

- Record: TXT at `_magnet.<your hostname>`; the value is in `dns.txt`, split into quoted strings of at most 255 bytes
  (resolvers join them), with a zone-file line, a Route 53 change batch and a Cloudflare API example. TTL 300 is fine;
  the loader caches answers for at least 5 minutes.
- Visitors read it over DNS-over-HTTPS (Cloudflare, then dns.sb, then Google with `edns_client_subnet=0.0.0.0/0`);
  `<meta name="mw-doh" content="<url template>">` overrides that. Nothing is looked up for IP addresses, `localhost`,
  `.local`, `.localhost`, `.test` or single-label names.
- When: never before the visitor's choice. After "Share and load" (or the gate's "Load") a shell page asks right
  after the choice (on later visits after the site renders, unless a cached answer is still fresh), then every
  5 minutes or the record's TTL while the page is open, and on focus at most once a minute, whether or not the
  record exists. "Load from host only" makes no lookup on a page-tag site. The first-run card and the gate name
  the service on every page that will ask it.
- A DNS record wins over the page tag only when it is signed by the pinned owner and has a higher `seq`.
- Returning visitors also learn about a new page tag: their Service Worker re-fetches the shell in the background and
  the page asks for the host's current tag after it renders and when it regains focus (integration-2). Either way a
  newer signed record shows "Update available: reload".
- Key rotation: `publish --prev-key old.jwk` adds `rot=` so the change is silent; without it visitors see "publisher
  key changed" with both fingerprints. The ledger survives a rotation: `--prev-key` reuses the ledger's genesis
  (publish into the same `--out`, or pass `--genesis`) and writes `lo=<genesis owner>`, so the ledger id, its
  entries and its rendezvous swarm stay (code review round 1, F09; without the genesis `publish` refuses, and
  `--new-genesis` starts a new ledger on purpose). The ledger's own owner hand-over is `ledger owner`
  ([OPERATIONS.md, "The owner key is stolen"](OPERATIONS.md#the-owner-key-is-stolen)).

## 7. Deploy order (shell mode)

1. Upload the site files and the `.torrent` to the web seed location (`<name>/`, `<name>.torrent`), and
   `genesis.json` for `cs=`. Drop-in: every non-HTML file before any HTML file (section 10).
2. Check the web seed: `node tools/check-webseed.mjs https://example.com/ws/ dist-publish/site.torrent`
   (OPTIONS preflight and a `Range: bytes=0-0` request per file; exit 0 when all pass).
3. Switch the pointer: deploy `dist-publish/shell/` (the page tag) to the host root, and/or publish the TXT record.
4. Keep the previous version's files for at least 7 days (`--keep-days`): pages and visitors still on it need them.

Host rules: `/mw-sw.js` at the origin root, never renamed, served as `text/javascript` with `Cache-Control: no-cache`;
HTML with `no-cache` too; every unknown path answered with the shell (SPA fallback or `404.html` as a copy of
`index.html`); HTTPS only (S3 website endpoints are HTTP-only: put CloudFront in front, or use GitHub/Cloudflare Pages);
purge the CDN on every deploy. The web seed host must answer the CORS preflight (`Access-Control-Allow-Headers`) and
serve `Range` requests with 206. Then run the whole check from outside:
`node tools/check-site.mjs https://example.com/` (pointer from the page tag and DoH, the `.torrent`, the web seed,
each tracker; `--headless` also loads the page). It contacts the internet and prints its targets first.

Shell mode answers every URL with the loader, so crawlers that do not run JavaScript see no content: keep
`robots.txt` and Open Graph fallbacks on the host, or use drop-in mode for pages that must be indexed.

## 8. A new version

Publish again with a higher `seq` (the default, Unix time, is higher) into the same `--out`, upload in the order
above, then switch the pointer. Visitors on the old version see "Update available: reload"; seeding of the old
version stops at once, and after the reload the old copy is deleted from the browser. Checked end to end by E2E
scenario 13. To take content down, publish a version without it: visitors drop the old one on their next load;
devices that stay offline keep it until they reconnect. Posts are taken down with a tombstone (moderator or owner).

## 9. Keeping a site reachable

- Nobody online and no `ws=`/`xs=`: the site does not load. Keep the web seed in the pointer.
- `node tools/pin.mjs https://example.com/` keeps a real loader open in Playwright Chromium (logs every 60 s;
  `--snapshot <file>` also writes ledger snapshots). It is one of the three tools allowed to contact the internet.
- `node tools/seed.mjs <site.torrent> <dir>` seeds from Node when `node-datachannel` is installed; otherwise it
  prints instructions (it is not installed in this repository).

## 10. Drop-in mode: migrating an existing static site

Drop-in keeps the host serving every HTML page exactly as today (redirects, clean URLs, 404s, headers, SEO) and
delivers the other files peer-to-peer after the first page view, plus offline use of visited pages and the site
ledger with the SDK. It does not keep the site up for new visitors while the host is down.

1. Add one tag to every HTML page, in `<head>`:
   `<script data-cfasync="false" type="module" src="/_mw/mw.js" async></script>` (or let publish add it:
   `--inject-script`; `data-cfasync="false"` keeps Cloudflare's Rocket Loader off it, and publish warns when a page
   lacks it). Nothing may already live under `/_mw/` or at `/mw-sw.js`.
2. Publish: `node tools/publish.mjs ./public --name my-site --scope example.com --key owner.jwk --dropin
   --tr wss://tracker.example.com --out dist-publish`. This builds a torrent of every non-HTML file, writes
   `dist-publish/site/` (your site with the pointer stamped as the first child of every `<head>`, the runtime under
   `/_mw/`, `/mw-sw.js`, and `/_mw/t/<btih>.torrent`), and prints the deploy order.
3. If the site sends a Content-Security-Policy, add what `dist-publish/csp.txt` lists (`worker-src 'self'`,
   `connect-src` for the trackers). Drop-in pages never read DNS, so `csp.txt` names no DNS-over-HTTPS endpoint,
   and a drop-in publish writes no `webseed-layout.txt` (the host's own files are the web seed).
4. Deploy `dist-publish/site/`: every non-HTML file first (including `/_mw/`, `/.mw/` and `/mw-sw.js`), then the HTML
   pages. Keep the previous deploy's files for at least 7 days. Example:
   `aws s3 sync dist-publish/site/ s3://<bucket>/ --exclude "*.html" --exclude "*.htm"`, then the same with
   `--exclude "*" --include "*.html" --include "*.htm"`.
5. A site with its own Service Worker: felinar does not register over it and logs one console line with the recipe.
   To let your worker serve files from the visitor's copy, add `importScripts('/_mw/sw-core.js')` as its first line
   (a module worker, registered with `{ type: 'module' }`, cannot call `importScripts()`: use
   `import '/_mw/sw-core.js'` as its first statement instead)
   and `if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event))` at the top of its fetch handler.
   Register your worker during page load (before `load`): the runtime waits 1 s for a registration to appear before
   it registers `/mw-sw.js` into an empty scope. To keep felinar's worker off entirely: `data-mw-sw="off"`.
6. Consent: by default the runtime shows its first-run card (in a closed shadow root) after 3 s on screen, and
   connects to no tracker or peer before the visitor chooses "Share and load". A site with its own explanation adds
   `data-mw-consent="site"` and calls `mw.consent.request()` from a click: that opens the same loader-owned card,
   and the visitor decides there (v0.2.1 removed `mw.consent.accept()`; the card ignores clicks a script makes).
7. Verify: with JavaScript off the pages must look exactly as before; the second page view's assets come from the
   visitor's copy. `examples/existing-site-dropin/EXPECTED.md` lists every check (E2E scenarios 9, 10 and 10B run them).

The first page view of a browser is never controlled by the worker: it loads entirely from the host, then the runtime
registers the worker and builds the copy at idle. Visitors on cellular or Save-Data fill the copy from peers only.

## 11. Kill switch

Deploying the self-unregistering worker as `/mw-sw.js` takes felinar's Service Worker off every returning visitor:
on its next update check the browser installs it; it deletes the `mw-*` caches, unregisters, and reloads each page the
old worker controlled once, which then loads straight from the host. It leaves IndexedDB alone, so a later deploy can
reuse saved sites.

- Shell mode: deploy the plain site (your site's own files at the host root, instead of the shell) together with
  `dist/mw-sw-kill.js` (also written to `dist-publish/mw-sw-kill.js`) as `/mw-sw.js`, and purge the CDN. If the host
  keeps serving the shell, visitors get no reload loop but also no site: deploy the plain site.
- Drop-in: copy `mw-sw-kill.js` over `/mw-sw.js` and purge. Pages the old worker controlled reload once; pages that
  still carry the `/_mw/mw.js` tag recognise the kill switch on later views, do not register it again, and log one
  console line asking you to remove the tag. Remove the tag in the next deploy.
- To come back, deploy the normal `/mw-sw.js` (and the shell, in shell mode) again.

What visitors see (v0.2.1, DIGEST-AMENDMENTS D3; PRODUCTION-DIGEST P0-14): the browser checks `/mw-sw.js` on the
next navigation, so the first page view after the deploy may still be the old one; the page is healthy about 3 s
later (measured in Chromium: E2E scenario 9 reports the plain host page after 2 navigations in about 2.7 s). Tell
people to wait a few seconds rather than reload repeatedly, and purge every CDN copy of `/mw-sw.js` first.

Last resort, only when the kill switch cannot be deployed or does not take: have the host send
`Clear-Site-Data: "storage"` on its HTML responses for a few days. It unregisters every worker of the origin and
deletes all of its IndexedDB and caches, which includes the visitors' ledger identity keys, pinned publisher keys,
consent choices and saved sites; the identities are gone for good unless visitors exported them.

Drill: run the kill switch once per release on a staging host (deploy, time the recovery, redeploy the normal
worker) and write the measured times into `docs/DEMO-RESULTS.md`.

Checked end to end by E2E scenario 9 (shell, shell kept by mistake, drop-in).

## 12. Firewall note (developer machines)

Every test, the demo seeder and the E2E run stay on 127.0.0.1 (docs/DEV-NETWORK.md): Chromium is started with
`chromiumArgs()` from `test/e2e/browser-args.mjs` (no hostname except localhost resolves), WebKit and Firefox only load
`http://127.0.0.1` pages, and unreachability is tested against local listeners. Only `tools/check-site.mjs`,
`tools/check-webseed.mjs` and `tools/pin.mjs` contact other hosts, they print their targets first, and no test runs
them. With an outbound firewall such as LuLu or Little Snitch you may block Playwright's Chromium ("Google Chrome for
Testing" and its Helper under `~/Library/Caches/ms-playwright/`) and Playwright's WebKit networking process; loopback
is not filtered, so the tests keep working. Leave Safari's own WebKit under `/System` alone. Allow
`~/.local/share/node/current/bin/node` only while running `check-site`, `check-webseed`, `pin` or `npm install`.

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "This page must be served over HTTPS (or localhost)" | plain HTTP on a LAN address | demo `--tls` with a trusted mkcert root, or a real HTTPS host |
| "This link has no web seed or torrent URL. It only loads while another visitor is online." | pointer without `ws=`/`xs=` | publish with `--ws` |
| "Web seed misconfigured (no Range support)" or unreachable | CORS preflight or `Range` not served | `tools/check-webseed.mjs`; S3 CORS JSON in `webseed-layout.txt` |
| Diagnostics: "Connection servers unreachable" | trackers down or blocked | add a tracker to `tr=` or run `tools/tracker.mjs` |
| "Limited mode: this browser has no offline engine" | no Service Worker (in-app WebView, Lockdown Mode, blocked registration) | expected; the site renders without offline use |
| Guestbook posts fail for every visitor | genesis block missing (`open`/`allow` ledger without `cs=`) | upload `genesis.json` and publish with `--cs` |
| "publisher key changed" | new owner key without `rot=` | publish with `--prev-key` |
| Returning visitors stay on an old version | the new pointer was not deployed, or its `seq` is not higher | check `pointer.txt`, deploy the shell or TXT record |
