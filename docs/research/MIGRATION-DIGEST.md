# Migration digest: moving existing sites onto magnet-web (wave 2A)

Written 2026-10-19 from the wave 2A research files. It adds no new measurements: every number below comes from a
research file, its lab output on disk, the normative spec, or the current code (marked "code 2026-10-19").
Normative baseline: `docs/ARCHITECTURE.md` v0.2, `docs/INTERFACES.md` v0.2, `docs/review/DESIGN-REVIEW.md`
(wording rules in its section 4: "site ledger", "no backend", none of the banned marketing terms listed there, no em dashes, straight quotes).
Citations use the file prefix and the section or finding id, for example `w2a-07 F21` or `w2a-04 §3`.

## Source status and coverage

| Source | State | What it contributes |
|---|---|---|
| `w2a-01-site-generator-output.md` | INTERIM (4 summary points). Its lab is complete: `labs/w2a-01-lab/results/` (`tables.json` T1 to T3, `lint-table.txt`, `sw-lab*.json`, `mirror.*.json`, `base-lab.*.txt`) and the reference lint `labs/w2a-01-lab/lint/mw-lint.mjs` | URL forms of 10 real tools (24 build variants), 3 serving models x 2 engines, site-SW coexistence, history mirroring |
| `w2a-02-cms-export.md` | Final | CMS exporters, feature loss, URL and file-name hazards, metadata cost, re-export deltas, host ceilings (R1 to R19) |
| `w2a-03-dynamic-feature-replacements.md` | Final | N / C+ / E / S catalogue of dynamic features, ledger sizing, EDPB guidance, passkeys, Pagefind, media (R1 to R24) |
| `w2a-04-dropin-embedded-mode.md` | Final | Rule-by-rule verdict on v0.2 §3.4 with measurements (SW cold start, bfcache, CSP, Web Locks, web-seed cache), script-tag design (R1 to R17) |
| `w2a-05-seo-crawlers.md` | Final, written against ARCHITECTURE v0.1 names (`--embed`, `/_mw/boot.js`) | Crawler matrix, SEO-01 to SEO-31, test matrix T1 to T16 (R1 to R20) |
| `w2a-06-cicd-automation.md` | Final, read ARCHITECTURE v0.1 §4 | Pipeline order, deterministic pack, seed verification, DNS providers, signing, reference workflows (R1 to R27) |
| `w2a-07-hosting-cost-bandwidth.md` | Final | 24-host real-browser matrix, list prices of 2026-10-17, cost and offload models (R1 to R17) |
| `w2a-09-migration-checklists-and-conventions.md` | INTERIM (summary and source list only; labs and recommendations were never written) | `_redirects`/`_headers` semantics, SPA-fallback incident, trailing-slash probe, PWA install rules |
| `w2a-10-large-sites-media.md` | INTERIM (checkpoint 1: 13 raw findings). Raw memory runs in `labs/w2a-10-lab/results/e5-memory*` have no write-up | WebTorrent selection internals, piece length, web-seed latency, media and SW Range |
| `w2a-*-VERIFY.md` | None exist | No adversarial verification pass ran for wave 2A. Section 4 is a cross-check made for this digest |
| Topic 08 (multipage UX in the shell) | Never researched. `labs/w2a-08-lab/results/` holds orphan raw runs (history mirroring, sandbox tokens, external links; Chromium and WebKit) with no write-up; not used as evidence | See below |
| Topic 11 (updates and versioning) | Never researched | See below |
| Topic 12 (shell performance, accessibility, PWA) | Never researched | See below |

### Which source wins when files contradict

1. ARCHITECTURE v0.2 and INTERFACES v0.2 are normative. Where a research file read v0.1 (w2a-05 and w2a-06 on the
   pointer grammar and drop-in mode), v0.2 wins; a research proposal that contradicts v0.2 is listed as a candidate
   amendment, not as a rule.
2. Between research files: a measurement beats a source reading, which beats inference; a larger sample beats a
   smaller one; a final file beats an interim draft unless the interim item is a measurement with raw output on disk;
   an explicit "SUPERSEDES" backed by evidence (w2a-07 Appendix C) wins.
3. Where a file describes code that changed after its snapshot (2026-10-14 tree), the current code wins and is cited.
4. Where two measurements disagree and nothing explains the difference, the conservative rule wins and the question
   stays open (example: 206 for media, section 4 row V7).

### Missing topics: what the architecture already decided

**08, multipage UX in the shell.** Decided in v0.2: one full-viewport iframe whose `src` is the top-level URL
(§3.1, §7.2); sandbox `allow-scripts allow-same-origin allow-forms allow-popups allow-downloads
allow-top-navigation-by-user-activation` (no `allow-modals`; the shared-origin hub also drops `allow-downloads`);
mirror the frame path into the address bar with `history.replaceState` only, copy `document.title`, open
cross-origin links without a target in a new tab with `noopener`, blank the frame with "This site tried to open
an external page" when it navigates away; `popstate` moves the frame (§7.2); every top-level navigation is answered
with the shell, uncontrolled shells reload once (§5.2, §7.1); framing protection (DESIGN-REVIEW item 8); mobile
viewport (S10); soft navigation for drop-in is LATER/v2 (DESIGN-REVIEW §3). Evidence elsewhere: the v0.2 text
mirrors only on frame `load`, which loses History-API routes on reload in Chromium and WebKit (w2a-01-lab
`mirror.*.json`); the current code already wraps the frame's `pushState`/`replaceState` and listens to its
`popstate` (code 2026-10-19, `src/loader/render.js` 597-605), so the code is ahead of the spec text;
`alert`/`confirm`/`prompt` are silently ignored without `allow-modals` (w2a-01-lab `sw-lab4` C; lint rule MW-X05
found call sites in the Docusaurus build); back-button hijacking is a Google spam-policy violation since
2026-04-13 (w2a-05 F51). Not covered: scroll restoration, focus management, find-in-page, printing, downloads,
`target=_top` links, form posts with redirects, multiple tabs of one site.

**11, updates and versioning.** Decided in v0.2: pointer `seq` monotonic per scope, lower `seq` refused, `exp`
required on signed records (at most 400 days, publish default 90), expired cached records still render with a
banner, `rot=` key succession, TOFU pin (§4); DNS re-check per TTL (minimum 5 min) and on `focus`, "Update
available: reload", stop seeding the old btih at once, keep current and previous version (§5.8); drop-in pins
each document to its stamped btih, keeps the previous deploy 7 days, uploads non-HTML before HTML and fills a new
version from the HTTP cache and the previous version by path and SHA-256 (§3.4.5); the SW URL never changes,
`no-cache` on the SW, kill switch, CDN purge per deploy (§7.1, DESIGN-REVIEW item 20); takedown of superseded
versions (item 21); ledger gossip across versions through the anchor torrent (S1). Evidence elsewhere: rollback
must be a roll-forward with a higher `seq` (w2a-06 F30, R5); channels as hostnames, promotion = re-sign (w2a-06
R14); file-granular prefill reuses 98.3 % of pieces (w2a-02 F22); mode handshake for drop-in to shell moves
(w2a-04 §5.5); kill switch kept at least a month (w2a-04 §5.6); replacing a site's existing precaching worker
only works at the same script URL with `skipWaiting` + `clients.claim` (w2a-01-lab `sw-lab2`, `sw-lab3`). Not
covered: user-facing update UX, version skew between open tabs, ledger schema migrations, staged rollouts.

**12, shell performance, accessibility, PWA.** Decided in v0.2: classic ES2017 boot with feature checks, polyfills
and a declared floor (Safari/iOS 15.4, Chromium 110, Firefox 115 ESR) (§5.1); a cached complete site renders
immediately, a first visit downloads the whole torrent into `MemoryChunkStore` and mounts after every file is done
(§5.4); size caps 128 / 48 / 24 MiB (§8); degraded mode without a SW (§7.4); UI with `aria-live` status, system
fonts, dark and light, `textContent` only (§5.10); the build ships the loader's own `manifest.webmanifest` (§10);
the `magnet:` protocol handler is LATER (DESIGN-REVIEW §3). Evidence elsewhere: loader budget LCP +100 ms and TBT
+50 ms at most against a no-loader baseline, WebTorrent bundle 64,428 B gzip (w2a-05 F46-F49, R8); SW dispatch 1.5
to 4.3 ms and a fresh client 150 to 170 ms of JS before the first wire (w2a-04 F9, F24); 256 KiB pieces make a
400-file web-seed fetch 12x faster than 16 KiB (w2a-10 checkpoint 9); PWA installability needs a manifest linked
from the top document, which in shell mode is the shell (w2a-09 §Summary 7; lint MW-S02); a site's own SW cannot
register under the shell (w2a-01 §Summary 4); raw, unreviewed memory runs show the renderer at about 548 MB while
building Blobs for a 128 MiB site with `MemoryChunkStore` versus about 438 MB with an IndexedDB-backed store
(Chromium 156 desktop, `labs/w2a-10-lab/results/e5-memory.log`). Not covered: accessibility of the shell or the frame
(focus, screen readers across the iframe boundary), the site's manifest and install flow in shell mode, mobile
memory ceilings, Lighthouse runs with the loader.

## 1. Executive verdict

1. **Same-URL serving is the precondition for migrating anything, and v0.2 already has it.** Real builds of 10 tools
   (24 build variants) passed home render, client navigation and deep link under same-URL dispatch in 24 of 24
   Chromium runs and 23 of 24 WebKit runs (the miss stalls with no SW too), against 5 of 15 root-mounted and 0 of 9
   sub-path builds under the v0.1 `/_mw/s/<btih>/` prefix (w2a-01-lab `tables.json` T3). CMS exports reach the same
   conclusion (w2a-02 F14, F29). The prefix stays a demo-hub-only mode (v0.2 §3.3).
2. **Drop-in is the default migration target; shell mode is for P2P-first sites that do not need search traffic or
   link previews.** Crawlers, unfurlers, Snipcart's validator and no-JS clients see only host HTML; shell mode gives
   every URL the same title, no Open Graph tags and a hard or soft 404 on deep links (measured on this repo, w2a-05
   §1, §4; w2a-02 F25; w2a-03 F44). Drop-in also has the cleanest rollback: the host files never moved (w2a-04 §5.6).
3. **The v0.2 drop-in skeleton holds against precedents and labs, with seven rule edits.** One script tag, HTML left
   on the host, a root-scope SW, fail-open and no reload match Planktos, SwarmCloud, OneSignal and Workbox, but the
   cold-start pass-through rule, the CSP meta, the bfcache rule for `no-store` pages and the web-seed rewrite must
   change (w2a-04 §1, §3).
4. **For small sites the web seed is the CDN, and drop-in can multiply host egress.** Modelled: a 5 MB site gets
   about 0 % of first-visit bytes from peers at any traffic level; a 25 MB site 7.1 % at 10,000 visits/day (w2a-07
   §Summary 6, F22-F25). Completing a 20 MB copy after a 1.5 MB page view costs the host 13.3x that view with no
   peer help (w2a-07 F21). Peers buy resilience, large-payload speed and ledger gossip, not a smaller bill.
5. **Web-seed hosting is where migrations will fail silently.** The stock WebTorrent 3.0.21 seed request is
   preflighted; 6 of 24 hosts pass it, 13 of 24 once two headers are dropped (w2a-07 F2-F3). Cloudflare Pages
   answers Range with 200, jsDelivr returns wrong bytes as 206, and WebTorrent re-requests a failed piece at once
   with no ban (23,240 requests in 4 s on loopback, w2a-06 F7). A single verification gate and a seed circuit
   breaker are P0.
6. **Publishing must be deterministic and policy-checked before anything becomes irreversible.** `create-torrent`
   6.1.3 drops dot-entries, follows `readdir` order, turns `creationDate: new Date(0)` into now and bakes in 8
   trackers (w2a-06 F2); WebTorrent pastes file paths unescaped into seed URLs, so `?`, `#`, `%`, NFD and case
   twins break (w2a-02 F16); WordPress exports carry commenter emails and IPs (w2a-02 F11); a torrent cannot be
   recalled once peers hold it (w2a-02 Gotcha 1).
7. **Dynamic features fall into four classes.** Works with v0.2 (comments and guestbook on the site ledger with
   `--policy open`, Pagefind search, local personalization); needs new code (reactions, approval queue, lazy media,
   rooms); third party from the browser (form relays, newsletters, Stripe Payment Links and Buy Button, cookieless
   analytics); stays on a server (email sending, payment webhooks, secrets, paywalls, cron) (w2a-03 §1-2, F60). No
   personal data goes into the ledger, even encrypted (EDPB Guidelines 02/2025, w2a-03 F25).
8. **CMS coverage is WordPress-first.** WordPress is 39.6 % of all sites and has two live exporters released
   2026-10-16 (Simply Static 3.8.18 with a reusable per-URL manifest API, Staatic 1.14.0); WP2Static is dead and
   Strattic is gone; Ghost and Drupal exporters churn or are minimally maintained; Squarespace, Wix and Webflow mean
   re-platforming content; hosted builders cannot serve a root `/mw-sw.js`, so no drop-in there (w2a-02 §Summary,
   F26).
9. **Large sites and media need a P2P subset, not a bigger torrent.** v0.2 downloads the whole torrent within 128 /
   48 / 24 MiB caps before mounting; real WordPress sites exceed that; metadata costs about 82 B per file plus 20 B
   per piece and peer-only bootstrap fails above 10 MB of metadata (w2a-02 F20-F21). Build the torrent from flagged
   files and leave video on HTTP; BEP 53 `so=` and `file.select()` do not achieve this in 3.0.21 (w2a-10 checkpoint
   2, 6, 7). PeerTube dropped WebTorrent playback for HLS (w2a-03 F51).
10. **The evidence has known holes.** No VERIFY pass ran for wave 2A; w2a-01, w2a-09 and w2a-10 are interim; topics
    08, 11 and 12 were never researched; Firefox never launched in any lab; no real iPhone, Android device, R2
    bucket, CloudFront distribution or live DNS zone was tested. Every browser statement here is Chromium 156 or
    Playwright WebKit 27.2 (not Safari) unless stated.

## 2. Decisions table

"v0.2" says whether the decision is already in the spec (Already), needs a spec edit (Amend) or is new (New).

| # | Decision | Evidence | Source file § | v0.2 |
|---|---|---|---|---|
| D1 | Same-URL serving for shell and subdomain hub; the path prefix only for the shared-origin demo hub | Same-URL 24/24 builds (Chromium); prefix 5/15 root and 0/9 sub-path; a client-remap patch fails for workers, module graphs and routers | w2a-01-lab T2-T3; w2a-01 §Summary 1-3; w2a-02 F14 | Already (§3.1, §3.3) |
| D2 | Drop-in is the default for any site that wants search, link previews, crawl-validated checkout or easy rollback; shell for P2P-first apps and demos | Crawlers and unfurlers see only host bytes; the shell gives one title to every URL and 404 or soft-404 on deep links | w2a-05 §1, §4, Appendix B; w2a-02 F25; w2a-04 §5.6 | Amend (state the default in README and DEPLOY) |
| D3 | In drop-in, HTML stays out of the torrent and the pointer is a stamped `<meta>`; origin/swarm byte identity applies to non-HTML files | A document cannot carry the pointer to a torrent that contains it | v0.2 §3.4.1; w2a-06 F6b; w2a-05 R1 (corrected) | Already |
| D4 | Every pointer carries `xs=` (drop-in: same-origin `/_mw/t/<btih>.torrent`) | `ws=` alone never got metadata (0 peers in 6 s; with `xs` 205 ms); peers reject metadata above 10 MB, `xs` has no cap | w2a-06 F5; w2a-02 F21 | Already (§0, §4) |
| D5 | Pack from an explicit manifest: UTF-8 byte-order sort, fixed name, 256 KiB pieces, `creationDate` pinned and > 0, `announce: []`, explicit dot-file policy; pack twice and compare | Directory mode drops dot-files and follows `readdir`; 16 KiB default pieces under 16 MiB; `Date(0)` becomes now | w2a-06 F2-F4, Appendix C.1, C.7 | Amend (§10 has a blanket dotfile ignore) |
| D6 | Keep 256 KiB pieces | 400 files / 6.6 MB at 50 ms latency: 6,869 ms with 16 KiB pieces, 542 ms with 256 KiB; 16 KiB metadata is 3.5x larger at 20,000 files | w2a-10 checkpoint 9; w2a-02 F21 | Already (§3.4.1, §10) |
| D7 | No BEP 47 padding; keep path-sorted order; version deltas by file-granular prefill (path + SHA-256) | 227 of 231 pieces verified from a prefilled store; padding adds 481 MiB (+341 %) | w2a-02 F22, Appendix A.2-A.3 | Already (§3.4.5), evidence added |
| D8 | The P2P set is its own torrent built from `p2p`-flagged files; large media stays on HTTP by default | Size caps and host per-file limits; `so=` is a no-op and deselecting a middle file strands its neighbours in 3.0.21 | w2a-02 F20, F23, R5; w2a-10 checkpoint 2, 6, 7; w2a-03 F47 | New (§3.4.1 packs every non-HTML file) |
| D9 | The SW answers media Range with exact 206 slices; streaming before completion stays a v1 non-goal; later P2P media uses HLS segments as lazy files | Chromium could not seek on a 200 in one lab; PeerTube abandoned WebTorrent playback | w2a-03 F49, F51-F52; w2a-10 checkpoint 10-12 | Already (§7.1 Range); media policy New |
| D10 | The web-seed fetch sends only `Range` (plus `cache: 'no-store'` and the abort signal) | Usable hosts go from 6 to 13 of 24; no preflight in Chromium 156 and WebKit 27.2 | w2a-07 F2-F3, R1 | New (override of `webconn.js`) |
| D11 | One verification tool with three modes (origin parity by full GET, seed by preflight + per-piece Range + SHA-1, live host bytes vs `files.json`), a hard gate before any pointer is printed or changed | Byte-altering CDNs, Range-ignoring hosts, wrong-bytes 206 and failed preflights all look like hangs | w2a-04 F15, R12; w2a-05 R2; w2a-06 F9-F13, R3; w2a-07 R2 | Amend (§10 `--verify-ws`, `check-webseed.mjs` are weaker) |
| D12 | The loader demotes a failing web seed (failure budget, backoff, visible message) | A hash failure re-requests at once with no ban; the 10 s `RETRY_DELAY` covers only HTTP errors | w2a-06 F7, R12; w2a-07 R11; code `webconn.js` 14 and 61-75, `torrent.js` 2010-2012 | New |
| D13 | Rollback = roll forward: re-sign the old btih with `seq = published + 1` and a fresh `exp`; take `seq` from the published record, never the clock | Loaders refuse a lower `seq`; a far-future `seq` locks the channel | w2a-06 F30, R5, Gotcha 30; v0.2 §4 | New (procedure) |
| D14 | Search = Pagefind 1.5.x at publish time; SW matches by pathname; SDK sets `baseUrl: "/"` and `metaCacheTag` = site version | Runs unchanged in the SW-served frame incl. its Worker and WASM; index 20 % to 43 % of HTML bytes, 200+ files | w2a-02 F10; w2a-03 F34-F35 | New (module) |
| D15 | Forms default to a relay or `mailto:`; a sealed ledger inbox is opt-in, off by default, with a legal note | EDPB 02/2025: encrypted personal data is still personal data; 1,437 B plaintext at 2,048 B values | w2a-03 F18-F25; w2a-02 F12 | New |
| D16 | Legacy comments ship as static JSON without email or IP; new comments go to a ledger list (`--policy open`) with moderation | WXR carries email and IP; 2 KiB values and an 8 MiB default ledger | w2a-02 F11; w2a-03 F7-F14 | New |
| D17 | Commerce = Stripe Payment Links or Buy Button; Snipcart only where the host serves product HTML (drop-in); checkout sessions, webhooks, fulfilment stay on the owner's server | Snipcart validates carts with a cookie-less GET of `data-item-url` | w2a-02 F13; w2a-03 F42-F46 | New (docs) |
| D18 | Analytics: none by default; tracker scrape for swarm size; opt-in cookieless beacon | Browser private-measurement APIs are being retired; DAP needs two servers; local DP needs 10k to 40k visitors | w2a-03 F36-F39 | New (docs) |
| D19 | Adopt the `_redirects` and `_headers` file names (Netlify-superset line grammar), compile them at publish time into `/.mw/site.json` with an explicit `force` flag; the SW never parses text | Cloudflare, Netlify and IPFS differ on default status, forcing and error policy; Netlify lines make an IPFS parser reject the whole file | w2a-09 §Summary 1-3; w2a-02 F18 | Already (`site.json`); compile semantics New |
| D20 | SPA fallback only for navigations; multi-page sites answer unknown paths with a real 404 | IPFS SW gateway reload-loop incident (#1155); soft-404 traps on static hosts | w2a-09 §Summary 4; w2a-05 SEO-07; code `src/sw/lib.js` `applyRouting` | Already (code) |
| D21 | Hub origins send `noindex, nofollow`; previews only through per-domain or drop-in URLs | IPFS SW gateway precedent; fragment hubs collapse every site into one URL | w2a-05 §4, F34-F36, R7 | New |
| D22 | Out of scope: Ghost(Pro), Squarespace, Wix, Webflow as live drop-in hosts (export or rebuild first); no WP2Static or Strattic adapters | No way to serve a root `/mw-sw.js`; WP2Static last release 2023-01-31 | w2a-02 F2, F6-F7, F26; w2a-04 §6 item 1 | New (docs) |
| D23 | Cross-origin seeds: default R2 behind a custom domain (or B2 behind a partner CDN, or DigitalOcean flat rate) after a real-bucket check; never Cloudflare Pages, jsDelivr, public IPFS gateways, Storacha | Price matrix and Range/CORS measurements | w2a-07 F18-F20, R3, R7 | New |
| D24 | Drop-in copy completion is budgeted and peer-first, with a delayed host fallback (about 8 s) | 13.3x multiplier; model: 27.8 % of payload bytes from peers with no change to first paint | w2a-07 F21, F24, R4-R5 | Amend (§3.4.7) |
| D25 | Drop-in SW: bounded 40 ms await for the index and a persisted client-to-btih map instead of "never delay" | Cold-start index read about 1 ms; multi-page sites cold-start the SW constantly | w2a-04 F9-F10, R1 | Amend (§3.4.2) |
| D26 | No CSP `<meta>` in drop-in; `publish --dropin` prints the measured additions and an `integrity` hash for `strict-dynamic` sites | A script-inserted meta CSP restricts the host page at once; ICE is outside `connect-src` | w2a-04 F27-F30, R3 | Amend (§5.1 step 6, §3.4.9) |
| D27 | Pages served `Cache-Control: no-store` run host-only; sockets and peers close on `pagehide`, hidden and `freeze` | Chromium excludes `no-store` pages from bfcache for life after any WebSocket or WebRTC use | w2a-04 F20-F21, R5 | Amend (§3.4.6) |
| D28 | Script-tag attributes can only reduce capability; site-level exclusions and build options live in the signed torrent (`/.mw/site.json`) | The tag is unsigned HTML | w2a-04 §5.1 | New |
| D29 | Mode = build-time constant plus a page/worker handshake; the worker stops serving on mismatch | The permanent `/mw-sw.js` URL makes silent mode mixing possible | w2a-04 §5.5, R8 | New |
| D30 | Signing: KMS-held P-256 key with DER-to-raw conversion as default; three OIDC roles behind separate environments; no third-party action receives DNS or signing credentials | 120 of 120 DER signatures verified after conversion; tj-actions credential theft | w2a-06 F24-F29, R6-R7 | New |
| D31 | IPFS land: copy the patterns (CAR artifact, DNSLink sandbox zone, PR previews), not the tools | `ipfs-deploy-action` has no maintainer; Shipyard IPFS maintenance ended 2026-09-30 | w2a-06 F34; w2a-07 F16 | New |

## 3. Prioritised recommendations (merged and deduplicated)

Priority: **P0** before anything is called production-ready or "migrates existing sites"; **P1** needed for a
credible migration story; **P2** valuable next; **P3** later or on demand. Effort: **S** about a day, **M** a few
days, **L** a week or more (w2a-03 uses a coarser scale; where files disagreed the larger estimate is kept). Each
row names the files that justify it; rows that merge several files' items list all of them.

### P0

| ID | Eff | Recommendation | Justified by |
|---|---|---|---|
| M01 | M | **Migration fixture suite as the acceptance test.** The w2a-01 lab builds (10 tools, root and `/repo/`), four CMS-export fixtures (Simply Static Absolute, Relative, Offline; Tome `dir/index.html`) with `?ver=` assets, trailing-slash variants, a 404 page, `.well-known/`, a History-API page and Pagefind, plus a Workbox site, a strict-CSP site, a `no-store` page and an edge-altered image; each run in shell and drop-in, Chromium and WebKit | w2a-01-lab T3; w2a-02 R1; w2a-04 R16; w2a-05 §5.3 |
| M02 | S | **Path policy in publish.** NFC only; reject `? # % \`, control and Windows-reserved characters, dot segments, leading or trailing space or dot, segments over 255 bytes, paths over 1,024 bytes, case and normalization collisions, reserved paths (`_mw/`, `mw-sw.js`, `.mw/`, `ws/`); alias map from the spelling used in HTML (with query) to the file; enumerate dot-files explicitly and report every dropped path (replaces the v0.2 §10 blanket ignore) | w2a-02 F16, R2 (`labs/w2a-02-experiments/pathlint.mjs`); w2a-06 F2-F3; lint MW-H03, MW-F05 |
| M03 | S | **Budget gates.** File count (warn 5,000, fail 20,000 unless overridden), metadata size (warn 1 MB; 10 MB is the peer ceiling), largest file against the host profile (25 MiB on Cloudflare Pages), total bytes against `maxSiteBytes`; print which host tier fits | w2a-02 F21, F24, R3 |
| M04 | S | **Publish from a crawl allowlist; secrets and PII lint.** Refuse `wp-config.php*`, `.env`, `.git/`, `*.sql`, backups; warn on unreferenced uploads; strip `comment_author_email` and `comment_author_IP` from any imported WXR | w2a-02 F3, F11, F20, R4 |
| M05 | M | **Deterministic `pack`.** Manifest-driven list, UTF-8 byte sort, fixed `name`, 256 KiB pieces, `creationDate` = commit time (> 0), `announce: []`; the staged `tree/` is the only thing uploaded; CI packs again from another path and fails on any btih difference; per-generator reproducibility checklist (lockfile, pinned Node, `SOURCE_DATE_EPOCH`, Next.js `generateBuildId` = git sha, telemetry off) | w2a-06 F2-F4, R2, R19, Appendix C.7 |
| M06 | M | **One verification tool, three modes.** `origin`: full GET of every file against the torrent hashes, flags Range-200 hosts. `seed`: preflight with `cache-control,range,user-agent`, per-piece Range with `Accept-Encoding: identity`, exact `Content-Range`, SHA-1; result PASS / PASS-needs-patched-client / FAIL range-ignored / FAIL wrong-bytes / FAIL cors; preflight skipped for same-origin seeds. `host`: live host bytes (browser-like `Accept` and `Accept-Encoding`) against `files.json` before a drop-in pointer is printed. Gate every pointer change including rollback; reuse in the daily canary. Supersedes the `Range: bytes=0-0` probe of `check-webseed.mjs` | w2a-04 F15, §5.2, R12; w2a-05 R2; w2a-06 F7-F13, R3; w2a-07 R2; v0.2 §10 |
| M07 | S | **Web-seed fetch sends only `Range`** (plus `cache: 'no-store'` and the abort signal), by overriding `WebConn.prototype.httpRequest`; E2E against a server that answers every OPTIONS with 405 | w2a-07 F2-F3, R1 |
| M08 | M | **Web-seed circuit breaker in the loader.** After 3 consecutive piece failures from one `ws=` URL within 30 s, stop for 5 minutes, record `webseed:<host>:E_<code>`, show "web seed is serving the wrong bytes"; support several `ws=` ordered cheapest first. Raised from P1 (w2a-06) and P2 (w2a-07) because hash failures re-request at once with no ban, and a Range-ignoring host returns the whole file each time | w2a-06 F7 (E6), R12; w2a-07 R11; code `torrent.js` 2010-2012 |
| M09 | S | **Drop-in spec edits (ARCHITECTURE v0.2).** §3.4.2 capped 40 ms await plus a persisted client-to-btih map; §3.4.6 `no-store` documents run host-only, cleanup on `pagehide`, hidden and `freeze`; §3.4.7 per-file in-flight coalescing, LRU of 2 to 3 files within a memory cap, size cap, egress counter; §3.4.9 the measured CSP set; §5.1 step 6 "not in drop-in"; the `data-mw-*` attribute table; tag found by selector (never `document.currentScript`), `setTimeout` fallback for `requestIdleCallback`, `prerenderingchange` guard, `data-cfasync="false"` before `src` | w2a-04 §3, R1-R5, R17 |
| M10 | S | **Document the drop-in egress multiplier** in README, DEPLOY and `publish --dropin` output: M = (S_site x (1 - p) + p x B_visit) / B_visit, with the 13.3x example; free on zero-egress hosts | w2a-07 F21, R4 |
| M11 | S | **Compatibility statement before users build.** The N / C+ / E / S classes, the "stays on a server" list, the no-personal-data rule, default `writers: 'owner'` (visitor posts need `--policy open`), the 8 MiB ledger budget, "shell mode is invisible to crawlers, unfurlers and crawl-validated checkout", per-CMS verdicts (re-platform Squarespace, Wix, Webflow CMS; hosted builders cannot host drop-in), "run mirrors on Linux" | w2a-03 R3; w2a-02 R10; w2a-05 SEO-02 |
| M12 | M | **Crawler-inert loader.** Never replace, hide or reorder host DOM; one appended status container created with `data-nosnippet`; a static `/_mw/sdk.js` stub resolving `{mode: 'static'}`; no developer text in the body; always handle the registration promise (Google's renderer exposes `serviceWorker` but rejects registration) | w2a-05 R3, Gotcha 2-3 |
| M13 | M | **One `publish --check` report** merging the generator lint (`labs/w2a-01-lab/lint/mw-lint.mjs`, rules MW-*), M02 to M04, and an `seo-lint` CI gate: identical bodies across a UA matrix, title, description, absolute self-canonical, no raw `noindex`, Open Graph completeness and image checks, JSON-LD parses, no hash routes, unknown path = 404, valid robots and sitemap, size budgets, rendered-vs-raw diff with the SW blocked | w2a-05 R4, §5.3; w2a-01-lab lint |
| M14 | S | **Host recipes and tiered host list in DEPLOY.md.** GitHub Pages (real 404, `.nojekyll`, no headers, OPTIONS 405, non-commercial), Cloudflare Pages (top-level `404.html` or it becomes an SPA, `.html` redirects to extensionless, Range answered 200), Netlify, S3 + CloudFront (REST origin, function for subdirectory index, custom response-headers policy), the `_redirects` semantics split, tiers 1 to 3 with dated prices, tested CORS JSON for S3, R2, B2 and CloudFront | w2a-05 R5, F42-F44; w2a-02 R11, F17-F18; w2a-06 R8; w2a-07 R3 |
| M15 | S | **Rollback as roll-forward** (`rollback.yml`): `seq` from the authoritative record, DELETE + CREATE compare-and-swap on DNS, `concurrency: { queue: max }` | w2a-06 F30, R5 |
| M16 | M | **CI security baseline and signing paths.** `permissions: {}`; unprivileged build; three OIDC roles (seed writer, signer, DNS writer) behind separate environments; SHA-pinned actions; `persist-credentials: false`; CODEOWNERS on workflows; gate on `workflow_run.event == 'push'`; signer default KMS P-256 with DER-to-raw, JWK secret documented as weaker, offline signing path | w2a-06 F24-F29, R6-R7 |
| M17 | S | **Immutable seed bytes.** Cross-origin seeds at `r/<semver>-<btih8>/<name>/...` with conditional writes where supported, retention and GC. Drop-in: a naming audit (share of non-HTML bytes without a content hash in the file name) and the keep window, because a file overwritten in place is served to old-version visitors and fails their hashes | w2a-06 F8, R4, Gotcha 23; w2a-04 §5.2 item 4, F13; v0.2 §3.4.5 |

### P1

| ID | Eff | Recommendation | Justified by |
|---|---|---|---|
| M18 | M | **`p2p` flag and `--exclude` in `files.json`**: torrent built from flagged files only; by default never P2P for video, audio, archives and files over 25 MiB; the host keeps the full site | w2a-02 F23, R5; w2a-03 F47, R11; w2a-10 checkpoint 2, 6, 7 |
| M19 | M | **Budgeted, peer-first copy completion in drop-in.** `copy.hostBudgetBytes` default min(S_site, 2 x B_visit, 5 MB) on non-zero-egress hosts (unlimited with a pointer flag such as `egress=free`); `/_mw/ws/` only after about 8 s (jittered) for still-missing pieces; render-critical files keep the race policy | w2a-07 F21, F24, R5 |
| M20 | M | **Delta updates by file-granular prefill** from the previous version (path + SHA-256), optional startup bitfield, UI progress from the bitfield not `torrent.downloaded` | w2a-02 F22, R6; v0.2 §3.4.5 |
| M21 | S | **Query policy.** Match by pathname; record `ver` tokens and pass through to the host on a mismatch; ignore `ts`, `_`, `utm_*` | w2a-02 F15, R7 |
| M22 | S | **Search module.** `publish --search pagefind` before stamping, pin 1.5.x, delete unused UI bundles (about 0.42 MB), `baseUrl: "/"`, `metaCacheTag`, a shim for the legacy `?s=` form; test whether Pagefind's Worker requests come from the torrent in drop-in | w2a-02 F10, R8; w2a-03 F34-F35, R10 |
| M23 | S | **Forms adapters** (`formspree`, `web3forms`, `formsubmit`, `mailto`, `webhook`): a plain `<form action=relay>` works without JS; visible `mailto:` fallback; CSP `form-action` and `connect-src` notes | w2a-03 F18-F20, R8; w2a-02 R13 |
| M24 | M | **Ledger features for migrated sites.** `react` op with reducer counts labelled "devices", visible budget and `E_CAP` handling, a 10,000-block performance test; approval queue (`moderated` writers, `approve`, `report`, local mute) | w2a-03 F10-F17, F56, R7, R9 |
| M25 | M | **SDK web components** with static fallback children: `<mw-comments>`, `<mw-reactions>`, `<mw-form>`, `<mw-search>`, `<mw-counter>` | w2a-03 R5 |
| M26 | M | **WordPress adapter**: read Simply Static `GET /wp-json/simplystatic/v1/exports/latest` (static path, type, status, `sha1`, redirect target) to seed `files.json`, redirects and the audit; crawl-based audit for Staatic and mirrors | w2a-02 F3, R9 |
| M27 | M | **Feature audit** (`tools/audit.mjs`): forms and their `action`, `fetch`/XHR URLs, third-party origins and embeds, `data-item-url`, media over the caps, same-origin absolute URLs; each finding tagged N / C+ / E / S with the mode that suits it | w2a-03 R4; w2a-02 §pipeline stage 2 |
| M28 | M | **`--base /repo/` for drop-in**: worker and `_mw/` under the base, base-prefixed stamps, `pathname.slice(base.length)`, "shared origin" notice | w2a-04 F17-F18, R6; w2a-01-lab T3 sub-path rows |
| M29 | S | **Foreign-SW kit and PWA exit rule.** Detection, Workbox `importScripts` and `injectManifest` lines, permanent SW path, fixture (the first listener that calls `respondWith` wins, so import the core first). For a site moving to shell mode from its own precaching worker: replace that worker at its own URL (kill switch, or `importScripts` of the core) with `skipWaiting` + `clients.claim`; a loader worker at a new URL left visitors on the old precache for 6+ navigations | w2a-04 F4, F33, R7; w2a-01-lab `sw-lab` E4, `sw-lab2`, `sw-lab3` |
| M30 | S | **Mode handshake**: build-time `MODE` in both entry points and worker bundles; the worker stops serving on mismatch | w2a-04 §5.5, R8 |
| M31 | S | **Shell history: align the spec with the code.** v0.2 §7.2 says "mirror on frame `load`", which loses History-API routes on reload; the code already wraps the frame's `pushState`/`replaceState` and listens to `popstate` (code 2026-10-19). Amend §7.2 and keep an A to B to Back E2E in every mode, including the first SW install | w2a-01-lab `mirror.*.json`; w2a-05 F51, R9; code `render.js` 597-605 |
| M32 | M | **Loader lifecycle and performance**: peers after `load` + idle and never while prerendering; lazy `import()` of WebTorrent; `pageshow(persisted)` re-init without reload; SW-served HTML gets `Cache-Control: no-cache`, not `no-store`; budget LCP +100 ms and TBT +50 ms at most against a no-loader baseline | w2a-05 F46-F49, R8; w2a-04 F24 |
| M33 | M | **Crawl files and hub hygiene**: `sitemap.xml` with `lastmod` from content hashes, `robots.txt` template with `Sitemap:`, optional IndexNow; per-site metadata stamped into the shell for the root URL; `X-Robots-Tag: noindex, nofollow` recipe for hubs (200 and 301) | w2a-05 R7, R11, R12 |
| M34 | M | **DNS publisher modules** behind `read / cas / wait` (Route 53 first; Cloudflare through a sandbox-zone CNAME; deSEC; then Gandi, OVH, Porkbun), 255-byte string splitting, refuse names holding several TXT values; `mw dns plan` for manual registrars; TTL 300 s; verify authoritative servers, then two DoH resolvers, then `AD` | w2a-06 F15-F23, R10, R11, R15 |
| M35 | S | **`exp` default**: raise the publish default from 90 to 180 days (inside v0.2's 400-day bound) and pair any renew workflow with an external heartbeat; "no `exp`" is not allowed by v0.2 | w2a-06 F31, R16; v0.2 §4 |
| M36 | M | **Production canary and provenance**: daily job plus external uptime check (DoH quorum, `seq`, `exp` margin, signature, `AD`, sampled seed verification, headless load, issue on failure); GitHub Release with torrent, `release.json` and pointer; `actions/attest` on public repositories | w2a-06 R17-R18; w2a-07 R17; DESIGN-REVIEW S13 |
| M37 | M | **Split `tools/publish.mjs` into file-interfaced stages** (`pack`, `pointer build`, `pointer finish`, `seed-verify`, `dns publish`, `dns check`, `smoke`, `gc`) with `--dry-run`; PR previews through a hub URL without DNS; channels as hostnames, promotion = re-sign | w2a-06 R13, R14, R20, Appendix B |
| M38 | S | **Seed recipe and cost estimator**: R2 default (custom domain on a Cloudflare zone, Cache Everything, `application/octet-stream`, `Cache-Control: public, max-age=31536000, immutable, no-transform`, CORS JSON), verified on a real bucket before it ships; `publish --estimate` with a dated `prices.json` and the P + F - 1 (+ F preflights) request formula; CloudFront guidance (REST origin; managed SimpleCORS suffices after M07) | w2a-07 F5, F7, F20, R7-R9 |
| M39 | M | **Decide the archive layout** (`layout=archive`, index at the head) for shell-mode cross-origin seeds: 8 MB / 200 files drops from 431 to 33 requests per cold visit (CloudFront $28.79 to $0, Pinata $798 to $81 a month in the example). Weigh against per-file verification and delta prefill before building (open question Q1) | w2a-07 F5, F20, R6; w2a-02 F22 |
| M40 | M | **Real-device and missing-engine matrix**: iPhone Safari (SW media with and without 206, hls.js vs native HLS, PRF, 7-day eviction, background suspend), Android Chrome, Firefox and Samsung Internet, Firefox desktop, Windows Hello; host and Range/Accept-Encoding matrix on Firefox and Safari | w2a-03 R17; w2a-04 §9 Q1-Q2; w2a-07 R10; w2a-06 open question 1 |
| M41 | S | **Privacy and legal pack**: data map (ledger, IndexedDB, host logs, peers), notice template, retention and erasure statement, EDPB references, salted value hashes, "no personal data in ledger values", counsel review before open posting | w2a-03 F25, F59, R15 |
| M42 | S | **Origin rules and key hygiene**: document which origin-bound services (Buy Button domains, Snipcart domains, CAPTCHA keys, OAuth redirects, passkey RP ID) work per mode; treat imported moderator keys as hot keys | w2a-03 F1-F2, R1-R2 |
| M43 | M | **`_redirects` and `_headers` compiler**: Netlify-superset grammar into `/.mw/site.json` with an explicit `force` flag and a default status per source host; per-line errors reported; a host-specific `_redirects` emitted; unexpressible rules (query matching, over 2,100 rules on Cloudflare) flagged as SW-only, so crawlers and no-JS clients do not get them | w2a-09 §Summary 1-3; w2a-02 F18 |
| M44 | M | **Recoverable identity**: passkey-wrapped seed (PRF, HKDF, AES-GCM) with the recovery phrase as master backup, per-site salt from the ledger id, signed `link` op | w2a-03 F26-F28, R12 |

### P2

| ID | Eff | Recommendation | Justified by |
|---|---|---|---|
| M45 | M | Comments import `mw comments import <wxr>` to `comments/<slug>.json` (sanitized, parent ids, no email or IP), merged with ledger comments; verify Disqus, Staticman and Giscus formats first | w2a-02 F11, R12; w2a-03 R23 |
| M46 | M | Sealed inbox, opt-in only (HPKE with DHKEM P-256 or age; 1,437 B plaintext; rotating owner-signed inbox key; throw-away sender keys; warning that ciphertext is public and cannot be erased) | w2a-03 F23-F25, R14; w2a-02 F12, R13 |
| M47 | S | Commerce presets: Payment Link and Buy Button snippets with `script-src`/`frame-src https://js.stripe.com`; Snipcart only with host-served product HTML or JSON; "checkout sessions, webhooks and fulfilment need your own endpoint" | w2a-02 F13, R14; w2a-03 R18 |
| M48 | S | Analytics page and `mw.net.swarm()` from the 90 s scrape keepalive; opt-in cookieless beacon that reports iframe navigations | w2a-03 F36-F39, R16 |
| M49 | M | Other CMS adapters: Ghost (gssg or Content API), Drupal (Tome), Squarespace (XML to Markdown), Webflow (code export) | w2a-02 F4-F7, R15 |
| M50 | S | Normalize options: strip `api.w.org`, `xmlrpc`, dead form actions; vendor `s.w.org` emoji; fail on `http:`, IP or `localhost` URLs and `srcset` entries with `http:` | w2a-02 F19, R16 |
| M51 | M | Exporter determinism check (`--check-determinism`: export twice, diff) and a pinned WordPress + Simply Static fixture container | w2a-02 F28, R17 |
| M52 | S | Drop-in hardening: navigation preload only after a phone measurement and always consuming `preloadResponse`; offline-HTML hygiene (skip `Set-Cookie`, `Vary: Cookie` or `*`, `private`/`no-store`, redirected responses); rollback docs (kill switch also deletes `mw-*` databases, kept at least a month, `Clear-Site-Data` on a dedicated path only); optional visit budget and tracker etiquette | w2a-04 R9-R11, R13 |
| M53 | S | SEO hygiene: seed copies get `X-Robots-Tag: noindex` and a canonical `Link` header (or a 200 rewrite to root); "do not do" list (`llms.txt`, FAQ schema, UA-sniffing prerender, hash routes, robots `Disallow` to de-index, JS-changed canonical); hub topology guide; publish-time snapshot of moderated ledger content into static HTML with `rel="ugc nofollow"` | w2a-05 R14, R16-R18 |
| M54 | L | Optional preview edge function for hub operators (allow-listed bot user agents get the web-seed HTML, identical bytes) | w2a-05 R15 |
| M55 | M | Release-key delegation slot `del=` (reserved now, built after v1), peer-carried pointer gossip so rollback is not bounded by DNS TTL, GitLab template, Terraform drift guidance, bucket lifecycle and cost report, drop-in seed-layout decision table | w2a-06 R21-R26 |
| M56 | S | Honest P2P paragraph and status line ("you are the only visitor online; loading from the web seed"); remove public IPFS gateway examples; shell-host picks by profile | w2a-07 R13, R14, R16 |
| M57 | M | Measure instead of model: per cold visit, bytes by source, seeders at completion, consent state and dwell, plus a replay script | w2a-07 R15 |
| M58 | M | Optional Blossom publishing of a single-file archive (experimental, Range check per server) | w2a-07 R12 |
| M59 | L | Opt-in API route table answered by page-held handlers; ephemeral rooms (`mw_room`); local-only store `mw.local`; WebAuthn-signed moderator ops | w2a-03 R6, R13, R19, R20 |
| M60 | S | Decide `allow-modals` for the shell sandbox: `alert`, `confirm` and `prompt` are silently ignored today and some generator bundles call them | w2a-01-lab `sw-lab4` C, lint MW-X05; w2a-03 Gotcha 2; code `render.js` 10-13 |

### P3

| ID | Eff | Recommendation | Justified by |
|---|---|---|---|
| M61 | M | `--min-bytes`: serve small text assets from the host (brotli on the host vs uncompressed pieces) | w2a-04 R14, §9 Q6 |
| M62 | L | Opt-in soft navigation for drop-in multi-page sites (`data-mw-nav="soft"`) | w2a-04 R15; DESIGN-REVIEW §3 |
| M63 | S | Compressed text assets in the torrent, decompressed by the SW with `DecompressionStream` (needs a measurement) | w2a-02 R18 |
| M64 | L | Query-aware redirect engine for Plain-permalink sites (`/?p=N`, `?page_id=`) with meta-refresh stubs on the host | w2a-02 R19 |
| M65 | S | Iframe-aware LCP reporting in shell mode; owner onboarding checklist (Search Console, Bing Webmaster Tools, CrUX) | w2a-05 R19-R20 |
| M66 | M | Cross-site moderation lists, display-only SIWE and Nostr links, `mw.experiment` bucketing, optional IPFS interop | w2a-03 R21, R22, R24; w2a-06 R27 |

## 4. Verified vs refuted or nuanced claims

No `w2a-*-VERIFY.md` file exists, so no wave 2A claim has been through an adversarial verification pass. This table
is the cross-check made for this digest: each claim was compared with the normative spec, another file's
measurement, the raw lab output on disk, or the current code (2026-10-19). The "Correction" column says what wins.

| # | Claim (file §) | Checked against | Verdict | Correction |
|---|---|---|---|---|
| V1 | "The pointer grammar has no `xs=`; add it" (w2a-06 §Summary 2a, F5, R1) | v0.2 §4 lists `xs` as repeatable; `src/common/pointer.js` parses it | REFUTED (read v0.1) | `xs` exists. Keep from R1 only the `.torrent` upload headers and the optional informational `rel=` (unknown keys are kept and signed) |
| V2 | "A drop-in pointer cannot be a `<meta>`; it must be DNS or a pointer file outside the tree" (w2a-06 F6b, R9) | v0.2 §3.4.1 (HTML out of the torrent, stamped meta), §4 source 2 | NUANCED | True only if HTML is packed. Under v0.2 the stamped meta is the primary drop-in bootstrap; no pointer file is needed and no-DNS is already first-class |
| V3 | "Inject meta and script, then build the torrent from the post-injection tree so origin and swarm are identical" (w2a-05 R1, SEO-03, invariant I2) | w2a-06 F6b (hash self-reference); v0.2 §3.4.1 | REFUTED for HTML | Byte identity applies to non-HTML files; HTML is host-only. Names are `publish.mjs --dropin` and `/_mw/mw.js` (v0.2), not `--embed` and `/_mw/boot.js` |
| V4 | "Range is applied to compressed bytes; the client cannot opt out" (w1-10 F12; w2a-06 F11 verified only Chromium) | w2a-07 F1: Fetch Standard plus server logs in Chromium 156 and WebKit 27.2 | SUPERSEDED (w2a-07 wins) | Browsers send `Accept-Encoding: identity` with Range. Remaining hazards are server bugs (jsDelivr serves brotli bytes labelled identity) and non-browser clients |
| V5 | "None of five probed hosts answers WebTorrent's preflight" (w2a-06 F9) | w2a-07 F2-F3 (24 hosts, real browser) | NUANCED (both stand) | 6 of 24 pass the stock request, 13 of 24 after M07. Cross-origin seeds work only on configured or patched paths |
| V6 | "WebTorrent retries a bad seed every 10 s forever" (w2a-07 Gotcha 5, R2 rationale) | code `webconn.js` 14, 61-75 (`RETRY_DELAY` only on request errors); `torrent.js` 2010-2012 (hash failure resets the piece, re-request on the next tick); w2a-06 F7 E6 | REFUTED for hash failures | 10 s applies to HTTP errors. Wrong bytes (Range-200, wrong 206) cause an immediate loop bounded only by RTT and `maxWebConns` (23,240 requests in 4 s on loopback). w2a-06 wins; M08 is P0 |
| V7 | "Chromium cannot seek a SW-served video unless the SW answers 206" (w2a-03 F49) vs "a 200 with the full body plays and seeks fine" (w2a-10 checkpoint 12) | Raw labs: `labs/w2a-03-experiments/media-exp` (200 with `Content-Length`, no `Accept-Ranges`, 96 KB 6 s clip: seekable [0,0]); `labs/w2a-10-lab/e4-media/results/e4-matrix.json` (variant `ignore`, same headers, 20 s clips: `seeked: true` in Chromium and WebKit) | CONTESTED | Both labs agree that 206 always works. Rule: answer every Range with an exact 206 (v0.2 §7.1 does). Do not rely on 200 until the difference (clip size, timing) is explained on real devices |
| V8 | "BEP 53 `so=` is implemented; partial P2P sets are possible with select and deselect" (w2a-02 F23) | w2a-10 checkpoint 2, 6, 7 (measured with 3.0.21) | NUANCED | `so=` is a no-op for fresh downloads (`_markUnverified` re-selects every piece); `file.select()` changes nothing under the default whole-torrent selection; deselecting a middle file strands its neighbours (stuck at 94.35 %). Build a smaller torrent from flagged files (M18) or use `deselect: true` plus explicit non-adjacent selects |
| V9 | "`file.stream({start,end})` marks cursor pieces critical, so a seek is served first" (w2a-03 F48) | w2a-10 checkpoint 1, 3 | NUANCED | `torrent.critical()` only lets a slow peer's block be stolen; stream selections are what reorder (priority 1, never merged): a hot file finished at 39 ms instead of 566 to 668 ms |
| V10 | "The SW tries `p/index.html` before `p.html`, unlike GitHub Pages, Netlify and Cloudflare Pages" (w2a-09 §Summary 5) | code `src/sw/lib.js` `resolveStatic` | FIXED SINCE | Current order: exact file, then `p.html`, then `p/index.html` (with `trailingSlash` and `cleanUrls`), matching those hosts and the Next.js `try_files $uri $uri.html $uri/` recipe |
| V11 | "SPA fallback must apply to navigations only" (w2a-09 §Summary 4) | code `src/sw/lib.js` `applyRouting` | VERIFIED IN CODE | `spa` and `notFound` apply only to navigations; Angular's extra rule (skip URLs with a file extension) was not checked |
| V12 | "The SW decides synchronously, never delays, passes through after a cold start" (v0.2 §3.4.2) | w2a-04 F9-F10 (15 forced cold starts per cell; index read about 1 ms; Chromium idle limit 30 s) | CHALLENGED | Bounded 40 ms await plus a persisted client map (M09). v0.2 governs until edited |
| V13 | "Insert the CSP meta" (v0.2 §5.1 step 6) applied to drop-in pages | w2a-04 F30 (measured) | REFUTED for drop-in | Never insert a CSP meta into host pages |
| V14 | "Close peers on `pagehide` to keep bfcache eligibility" (v0.2 §3.4.6) | w2a-04 F20-F21 (Chromium measured; Firefox and WebKit from source) | HOLDS, NUANCED | Holds for ordinary HTML; `Cache-Control: no-store` pages lose bfcache for life after any WebSocket or WebRTC use, so they run host-only. w2a-05 Gotcha 15 ("the loader reloads on a persisted `pageshow`, the SW stamps `no-store`") describes v0.1 code |
| V15 | "Copy completion costs about one extra download of the non-HTML files" (v0.2 §3.4.7; DESIGN-REVIEW) | w2a-07 F21 | REFINED | Host egress multiplier S_site / B_visit: 13.3x for a 20 MB site and a 1.5 MB page view |
| V16 | "In drop-in, CORS, Range and compression do not apply to the seed" (w2a-07 §Summary 1, F4) | w2a-04 F34 (measured); w2a-07 Gotcha 17 | NUANCED | True for CORS and Range semantics, but the SW fetches whole files and slices: files of 10 MB and up were not kept by the HTTP cache in ephemeral contexts and `no-store` defeats it, so without coalescing each piece can re-download the file (M09) |
| V17 | "Every web-seed request is CORS-preflighted" (ARCHITECTURE §1) | w2a-07 F3 | NUANCED | Only with the stock headers; M07 removes it |
| V18 | "A 200-character comment is 701 to 1,170 B" (w2a-02 F29, citing a partial w2a-03) | w2a-03 §1 item 3 (final, v0.2 block shape) | SUPERSEDED | 798 B with one parent head, 1,267 B with eight |
| V19 | "Sealed-form plaintext about 1,425 B" (w2a-02 F12, derived) and "Pagefind UI bundles about 0.5 MB" (w2a-02 F10) | w2a-03 §1 item 4 (1,437 B measured), F34-F35 (about 0.42 MB) | SUPERSEDED (minor) | Use 1,437 B and about 0.42 MB |
| V20 | "v1 default: no `exp`, or at least 180 days" (w2a-06 R16) | v0.2 §4 (signed records require `seq` and `exp`, at most 400 days; expired cached records still render) | PARTLY REFUTED | "No `exp`" is not allowed; 180 days fits v0.2, and stale-but-usable already exists for cached records (M35) |
| V21 | "Ignore list: dotfiles, `README.md`, `node_modules`" (v0.2 §10) | w2a-06 F2-F3; w2a-02 F16 | CHALLENGED | `.well-known/security.txt` and `assetlinks.json` vanish from the torrent and from artifact uploads; use an explicit manifest and report every dropped path (M02, M05) |
| V22 | "Googlebot ignores service workers" (w2a-05 crawler matrix) vs "cannot be claimed" (w2a-02 F25) vs "unverified" (w2a-04 §2) | w2a-05 sources: Splitt 2019/2020 and Mueller 2023 via secondary reports; Search Console test shows the registration "Rejected" | PLAUSIBLE, not primary | Treat as likely; it does not matter for fail-open drop-in; the w2a-05 R10 probe page settles it |
| V23 | "PeerTube removed WebTorrent redundancy in v7.1.0" (w2a-10 checkpoint 10) vs "in v8.0.0" (w2a-03 F51) | Both read the PeerTube changelog | MINOR CONFLICT | Version differs; the conclusion agrees (WebTorrent playback removed in v6.0.0, P2P now only through HLS and P2P Media Loader) |
| V24 | "The OPFS `createWritable` polyfill is needed for Safari 15.2 to 18.1" (v0.2 §1, `browser-mobile.md`) | MDN BCD 8.1.6 says native from Safari/iOS 26 (w2a-04 Gotcha 21, §9 Q5) | CONTESTED | Irrelevant while `MemoryChunkStore` is always passed; never use the bundle's default store |
| V25 | "SharedWorker is not in iOS Safari" (task premise in w2a-04) | MDN BCD (w2a-04 F23) | REFUTED | iOS Safari has it since 16, but it cannot create `RTCPeerConnection`, so it is no mitigation for per-navigation engine restarts |
| V26 | Shell history: "mirror on frame `load` with `replaceState`" (v0.2 §7.2) | w2a-01-lab `mirror.*.json`; code `render.js` 597-605 | SPEC BEHIND CODE | Load-only mirroring loses SPA routes on reload; the code already wraps `pushState`/`replaceState`; amend §7.2 (M31) |

## 5. Constraints discovered

### Compatibility

| # | Constraint | Consequence | Source |
|---|---|---|---|
| C1 | Almost every generator and exporter emits root-absolute URLs (`/_next/`, `/_astro/`, `/assets/`, `/wp-content/`) and client routers read `location.pathname` | Same-URL serving is mandatory; the path-prefix hub cannot host real sites | w2a-01-lab T1, T3; w2a-02 F14 |
| C2 | A SW's maximum scope is its own directory unless the script carries `Service-Worker-Allowed`, which GitHub Pages and many static hosts cannot send (SecurityError reproduced in both engines) | v0.2 supports origin-root deployments only; GitHub project sites need `--base` and are a shared origin with the user's other project sites | w2a-04 F17; w2a-01-lab `sw-lab4` B; v0.2 §5.1 step 3 |
| C3 | A site's own SW cannot register under the shell (SW script fetches bypass SWs and the host has no such file) | PWAs moving to shell mode lose their worker; in drop-in they must import the core (`importScripts('/_mw/sw-core.js')` first, because the first `respondWith` wins) | w2a-01 §Summary 4; w2a-01-lab `sw-lab` E4; v0.2 §3.4.4 |
| C4 | Replacing an existing precaching worker works only at the same script URL with `skipWaiting` + `clients.claim` (switch at the third navigation); at a new URL the old precache stayed for 6+ navigations | Shell migrations of PWAs must ship a same-URL replacement or kill switch for the old worker | w2a-01-lab `sw-lab2`, `sw-lab3` |
| C5 | Hosted builders (Ghost(Pro), Squarespace, Wix, Webflow) show no way to serve a root file | No drop-in on them; export or rebuild first | w2a-02 F26; w2a-04 §6 item 1 |
| C6 | WebTorrent 3.0.21 builds web-seed URLs by string concatenation without percent-encoding; NFC and NFD are different URLs; APFS merges case and normalization twins; `create-torrent` and `upload-artifact` drop dot-entries | File names must be a validated alphabet with an alias map; mirrors run on Linux | w2a-02 F8, F16; w2a-06 F2-F3 |
| C7 | Size and metadata: caps 128 / 48 / 24 MiB; about 82 B per file plus 20 B per piece; peers reject metadata above 10 MB; Cloudflare Pages Free stops at 20,000 files and 25 MiB per file; GitHub Pages at 1 GB; WordPress makes up to 8 files per photo | A P2P subset and `xs` are needed for real CMS sites | w2a-02 F20-F21, F24; v0.2 §8 |
| C8 | Query strings: WordPress adds `?ver=` to every asset, Pagefind adds `?ts=`, Plain permalinks are `/?p=N` | Pathname lookup plus recorded version tokens; Plain-permalink sites need a permalink change and a redirect table | w2a-02 F15 |
| C9 | The shell sandbox has no `allow-modals`; `allow-scripts allow-same-origin` is not isolation | Dialogs are silently ignored in shell mode; identity and money features must assume hostile site code | w2a-01-lab `sw-lab4` C; w2a-03 F1, Gotcha 2-3 |
| C10 | Media: answer Range with 206 (conservative rule, V7); iPhone Media Source is partial (ManagedMediaSource from iOS 17.1); iPhone Safari untested | Media stays on HTTP by default; HLS for any later P2P media | w2a-03 F49-F50; w2a-10 checkpoint 11-12 |
| C11 | WebTorrent stream selections reorder pieces, `torrent.critical()` does not; the first request on any new wire is the last piece of the last selection (one extra RTT before piece 0); every torrent announce opens up to 5 pending peer connections | Time to first useful byte has a fixed RTT tax; each extra torrent per page (per-section shards) multiplies pending connections | w2a-10 checkpoint 1, 3, 5, 13 |
| C12 | CSP: the unmodified bundle runs under `script-src 'self'; connect-src 'self' <trackers>; worker-src 'self'`; STUN/TURN is outside `connect-src`; `strict-dynamic` or nonce policies need an `integrity` hash or nonce for the tag; a `sandbox` CSP or a cross-origin frame cannot run the engine | Print additions, never edit the site's CSP | w2a-04 F27-F30, §6 item 5 |
| C13 | `<embed>`/`<object>`, shift-reload navigations and cross-origin requests never reach the worker | Those resources always come from the host | w2a-04 §6 item 7; lint MW-X06 |
| C14 | `Cache-Control: no-store` pages lose bfcache for life after any WebSocket or WebRTC use (Chromium) | Run host-only on them | w2a-04 F20 |
| C15 | `document.currentScript` is null in module scripts; WebKit 27.2 lacks `requestIdleCallback`, `document.prerendering`, `navigator.connection`; Lockdown Mode disables Web Locks; Rocket Loader needs `data-cfasync="false"` before `src` | Tag and platform guards (M09) | w2a-04 F7, F22, F26, F29 |
| C16 | Crawlers: Google's renderer has no WebRTC or WebSocket, keeps no storage between loads and rejects SW registration; Googlebot reads 2 MB per file uncompressed; Meta needs Open Graph tags in the first 1 MB and sends `Range: bytes=0-524288`; Apple Messages reads 1 MB, runs no JavaScript and ignores meta refresh; most AI crawlers run no JavaScript (Dec 2024 study) | Indexable content must be complete host HTML; shell and hub are not indexable | w2a-05 §1, §2 matrix, F8, F18-F19 |
| C17 | Seed hosts: stock requests are preflighted; Cloudflare Pages and Primal Blossom ignore Range; jsDelivr returns wrong bytes as 206; S3, DigitalOcean and Vercel default CORS rules lack `cache-control`; WebTorrent accepts any 2xx and hashes it | Verification gate (M06), header patch (M07), circuit breaker (M08) | w2a-07 F1-F3, Gotcha 4-5; w2a-06 F9-F12 |
| C18 | Byte-altering edges (Cloudflare Polish, edge minify, `Accept`-dependent formats, Rocket Loader, Email Obfuscation) and SRI `integrity=` attributes | Altered bytes fail piece hashes and the seed URL is useless; any normalize rewrite breaks SRI | w2a-04 F15; w2a-06 F13; lint MW-F01 |
| C19 | Engines covered: Chromium 156 and Playwright WebKit 27.2 only (no Firefox, no Safari proper, no phones) | Every compatibility promise needs M40 first | all wave 2A method sections |

### Operational

| # | Constraint | Consequence | Source |
|---|---|---|---|
| O1 | Drop-in copy completion multiplies host egress (13.3x in the example) | Budget and peer-first completion (M10, M19) | w2a-07 F21 |
| O2 | Peers carry almost nothing for small sites (model: 0 % for 5 MB at any traffic; 100 MB reaches 41.4 % at 100,000 visits/day); the consent click and ICE setup take about 6 s while a 5 MB site completes in 2.4 s at 20 Mbit/s | Budget for 100 % of first-visit bytes on the host | w2a-07 F22-F25 |
| O3 | Request count, not bytes, sets the bill on per-request hosts: P + F - 1 range GETs (+ F preflights) per cold visit; 431 requests for an 8 MB, 200-file site | Choose flat-price hosts or the archive layout (M39) | w2a-07 F5, F20 |
| O4 | Deploy order: upload before publishing the pointer; drop-in uploads non-HTML first and HTML last and keeps the previous deploy 7 days; an in-place overwrite plus `immutable` caching serves mixed bytes | Immutable prefixes for cross-origin seeds; content-hashed names for drop-in (M17) | w2a-06 F1, F8, Gotcha 23; v0.2 §3.4.5 |
| O5 | `seq` is monotonic; rollback is a roll-forward; a far-future `seq` locks the channel; key rotation without delegation shows every visitor a "publisher key changed" prompt | Derive `seq` from the published record (M15); reserve `del=` (M55) | w2a-06 F30, Gotcha 30-31 |
| O6 | A signed pointer is 246 to 487 bytes: two TXT strings is normal; Route 53 needs `"a" "b"` quoting | Every DNS module splits at 255 bytes | w2a-06 F6, Gotcha 8 |
| O7 | DNS providers differ: Route 53 change batches and record-scoped IAM; deSEC server-set minimum TTL (example 3600 s) and 100 writes/hour; Cloudflare tokens scope only to a zone; Porkbun `editByNameType` replaces all matching records; OVH needs a zone refresh; Namecheap and GoDaddy unverified | DNS modules behind one interface; CNAME delegation for weak APIs (M34) | w2a-06 F15-F21, Appendix D |
| O8 | GitHub changed the OIDC `sub` format for repositories created after 2026-07-15; KMS returns DER while the loader verifies raw r\|\|s; scheduled workflows stop after 60 days without activity; default concurrency cancels the older pending run; `workflow_run.head_branch` is forgeable | Decode a real token before writing trust policies; `queue: max`; gate on `event == 'push'` | w2a-06 F25-F29, Gotcha 15-20 |
| O9 | Prices and plans changed within 12 months (AWS Free plan, CloudFront flat-rate plans, Netlify credits since 2025-09-04, Vercel Flat Rate, Storj, Storacha to Fil One); Netlify Free pauses every project when credits run out | Date every price; re-read before publishing a recommendation | w2a-07 Gotcha 12, 19 |
| O10 | IPFS tooling and gateways are unstable: Shipyard IPFS maintenance ended 2026-09-30, the IPFS SW gateway changed maintainers in Q3 2026, ipfs.io and dweb.link answer 429 or a challenge, Storacha redirects to Fil One without public buckets | Patterns only, no dependencies | w2a-06 F34; w2a-07 F16; w2a-05 Gotcha 19 |
| O11 | The CMS does not disappear: the owner still runs WordPress, Ghost or Drupal somewhere to author and export; exporter incremental modes are mostly paid; exporter determinism is unproven | "No backend of ours" stays true; "no server for the owner" does not | w2a-02 Gotcha 26, 28-29, F28 |
| O12 | Host logs undercount once repeat visitors are served from IndexedDB and peers | Analytics: none by default (D18) | w2a-03 F36; w2a-04 §6 item 13 |
| O13 | Next.js, Astro, Nuxt and Angular send build telemetry unless disabled (`NEXT_TELEMETRY_DISABLED`, `ASTRO_TELEMETRY_DISABLED`, `NUXT_TELEMETRY_DISABLED`, `NG_CLI_ANALYTICS=false`, `DO_NOT_TRACK`) | Set in CI | w2a-01-lab `RUN.txt`, `lab/gen/build-all.sh` |

### Legal

| # | Constraint | Consequence | Source |
|---|---|---|---|
| L1 | Publication is permanent: once a peer holds a file it cannot be deleted; takedown is best effort | Publish from a crawl allowlist; never from raw upload directories (M04) | w2a-02 Gotcha 1; DESIGN-REVIEW item 21 |
| L2 | WordPress WXR (and the Squarespace export, same format) carries `comment_author_email` and `comment_author_IP` | Strip on import (M04, M45) | w2a-02 F11 |
| L3 | EDPB Guidelines 02/2025 (v2.0, adopted 2026-07-07): encrypted personal data is still personal data; para 48 calls storing personal data on such a log "not advisable"; applicability to a no-consensus browser log is unverified | No personal data in ledger values; sealed inbox opt-in only; counsel before open posting (M41) | w2a-03 F25 |
| L4 | Premium themes and plugins may restrict redistribution; Wix and Squarespace terms on copying their output were not read | Check licences before promising migration of such sites | w2a-02 Gotcha 27, open question 13 |
| L5 | GitHub Pages forbids sites "primarily directed at facilitating commercial transactions"; Vercel Hobby is non-commercial; Cloudflare's terms require a Developer Platform product for "video and other large files" | Host choice depends on the site's business use | w2a-05 F42; w2a-07 F14, F26 |
| L6 | Google spam policy: back-button hijacking is a violation since 2026-04-13 (enforced from 2026-06-15); a SW that rewrites titles or structured data invites a cloaking reading | History replace-only (M31); SW never touches SEO-relevant head content | w2a-05 F50-F51, Gotcha 23-24 |
| L7 | ePrivacy/GDPR consent for IndexedDB and Cache Storage writes and IP exposure to peers on EU sites, and cookieless-analytics consent, are unresolved | Treat as open (Q33) | w2a-04 §9 Q9; w2a-03 open question 17 |

## 6. Open questions

Grouped and deduplicated; the file that raised each question is named.

**Architecture decisions pending**
- Q1. Archive (single-file) layout for shell-mode seeds: adopt it (431 to 33 requests per cold visit) given its cost to per-file verification, `files.json` and delta prefill? (w2a-07 R6, Q13; w2a-02 F22)
- Q2. Drop-in seed layout: same-origin SW rewrite only, or also a second copy, an internal rewrite or a separate seed hostname? (w2a-06 R26, open question 11)
- Q3. Pointer additions: `rel=`, a reserved `del=`, `layout=`, an `egress=free` flag, an archive sha256 for mirror verification? (w2a-06 R1, R21; w2a-07 R5, R6, Q13)
- Q4. Who owns the seed circuit breaker and pointer gossip (loader vs chain-net agents)? (w2a-06 open question 12)
- Q5. Should drop-in verify HTML parity for query-versioned assets, so a stale seed cannot serve an old asset against new HTML? (w2a-02 open question 16)
- Q6. Default drop-in visit budget, and soft navigation vs "upgrade to shell after the first page" for multi-page sites. (w2a-04 §9 Q3, Q14; DESIGN-REVIEW §3)
- Q7. `allow-modals` in the shell sandbox (M60), and whose web manifest the shell links so a migrated site stays installable. (w2a-01-lab `sw-lab4`; w2a-09 §Summary 7)
- Q8. One site torrent per version (plus the ledger anchor) or core plus per-section torrents for large sites, given 5 pending connections per announce per torrent? (w2a-10 checkpoint 13; Planktos precedent in w2a-10 checkpoint 10)
- Q9. Does `maxChainBytes` count wire bytes, canonical bytes or stored bytes? It decides how many likes fit in 8 MiB. (w2a-03 open question 19)
- Q10. Staged rollouts (percentages) in DNS, given that two valid records are treated as a conflict. (w2a-06 open question 13)
- Q11. Do framed drop-in pages get partitioned storage in practice (decides whether to stay inert in frames)? (w2a-04 §9 Q12)

**Browsers and devices**
- Q12. Phone costs: SW cold start, the 40 ms cap, navigation preload, LCP within 5 %; verify + PoW + recount on phones; prefill verification time for 100 MB on a mid-range phone. (w2a-04 §9 Q1; w2a-03 open question 4; w2a-02 open question 7)
- Q13. Firefox and Safari: bfcache with live peers, Web Locks under Lockdown Mode, `resultingClientId` on iOS, `Accept-Encoding: identity` on Range, preflight header lists, `Access-Control-Allow-Headers: *`. (w2a-04 §9 Q2; w2a-06 open question 1; w2a-07 Q3)
- Q14. iPhone media through a SW (206 need, native HLS, ManagedMediaSource fed from SW-served segments), and the V7 conflict on 200 responses. (w2a-03 open question 3; w2a-10 checkpoint 12)
- Q15. Safari PRF on `get()` (MDN vs Corbado) and PRF consistency across synced passkeys. (w2a-03 open questions 1-2)
- Q16. What Google's renderer exposes for `serviceWorker`, `indexedDB`, `caches`, WebRTC, WebSocket; Bingbot, Applebot and Twitterbot behaviour; 2025-2026 AI-crawler rendering. (w2a-05 Q1-Q4, Q7)
- Q17. Are Pagefind's Worker requests served from the torrent or the host in drop-in? (w2a-03 open question 18; w2a-02 open question 10)
- Q18. Memory ceiling of whole-torrent download on phones: the unreviewed desktop run shows about 548 MB renderer memory for a 128 MiB site with `MemoryChunkStore`. (w2a-10-lab `results/e5-memory.log`)
- Q19. Does Chrome defer WebRTC and WebSocket during prerender, or only expose `document.prerendering`? (w2a-05 Q11)

**Hosts and providers**
- Q20. R2 through a custom domain with Cache Everything: correct 206 for `application/octet-stream` + `no-transform`; are cache hits billed as Class B? (w2a-07 Q1-Q2)
- Q21. CloudFront custom response-headers policy end to end; Cloudflare Workers static assets and Range; Bunny OPTIONS and HTTP/3; Filebase public objects; Netlify single-site wildcard alias; Storj rate limits; Blossom operators' caps; DigitalOcean CORS rule; Cloudflare's large-files clause for B2 or S3 origins. (w2a-06 open question 2; w2a-07 Q4-Q9, Q11-Q12)
- Q22. A catalogue of edge features that alter bytes (Polish, Mirage, Rocket Loader on module scripts). (w2a-04 §9 Q7, Q13)
- Q23. DNS: live propagation latency to Cloudflare and Google DoH; Namecheap, GoDaddy and Squarespace Domains APIs; TXT above 255 bytes at Porkbun, Gandi and OVH; record-level Cloudflare tokens; the environment-scoped OIDC `sub` string; `queue: max` for reusable workflows. (w2a-06 open questions 3-8)
- Q24. Real P2P offload on a live small site (consent rate, dwell time, pair success). (w2a-07 Q10)

**CMS and generators**
- Q25. Can Squarespace, Wix, Webflow or Ghost(Pro) serve `/mw-sw.js` at the root? (w2a-02 open question 1)
- Q26. Exporter behaviour on real sites: Simply Static Relative mode, Staatic URL rewriting, Tome redirect output, determinism of Simply Static, Staatic, Tome and gssg across unchanged runs. (w2a-02 open questions 3-6)
- Q27. Real WordPress site sizes (uploads vs referenced files) from a sample of 20 public sites. (w2a-02 open question 9)
- Q28. Unresearched platforms: Shopify (5.3 %), Joomla (1.1 %), Tilda, Duda, Blogger, GoDaddy; Gatsby never researched; Jekyll never lab-tested. (w2a-02 open question 14; this digest §7)
- Q29. Disqus, Staticman and Giscus export formats for comment import. (w2a-03 open question 10)

**Legal**
- Q30. Does EDPB 02/2025 apply to a no-consensus browser log; are visitors' browsers "nodes" with controller roles; hosting liability for relayed user content? (w2a-03 open question 6; w2a-02 open question 15)
- Q31. ePrivacy/GDPR consent for drop-in storage writes and IP exposure on EU sites, and CMP integration. (w2a-04 §9 Q9; w2a-03 open question 17)
- Q32. PCI DSS 4.0.1 script-integrity duties for pages that embed the Buy Button. (w2a-03 open question 8)
- Q33. Is serving byte-identical HTML from IndexedDB through a SW ever read as cloaking? (w2a-05 Q13)

## 7. Per-framework migration recipes

Generic recipe for every tool: build at the origin root with the final HTTPS origin configured (canonical, Open
Graph and sitemap URLs are absolute), run `mw-lint` and the same-URL fixture (M01, M13), publish with `--dropin`
for any site that wants search traffic, keep the host's own 404 and redirects, and set the reproducibility and
telemetry variables in CI (M05, O13). "Lab" = Chromium 156 and WebKit 27.2 runs of `w2a-01-lab` (letters are home /
client navigation / deep link; same-URL is the v0.2 model, prefix is v0.1). Sub-path builds (`/repo/`) passed
same-URL in the lab for every tool when the SW stripped the base, but v0.2 has no `--base` yet (M28).

| Tool (version tested) | Flags to set | What breaks or needs care | Drop-in fit | Shell fit | Evidence |
|---|---|---|---|---|---|
| Hugo 0.168.0 (lab) | `baseURL = "https://<final domain>/"`; keep root-absolute output (`relativeURLs` only for the demo hub); `enableRobotsTXT = true`; sub-path: `baseURL .../repo/` plus `--base` | SRI `integrity=` (MW-F01): any byte rewrite by a normalize stage or CDN breaks it, so publish bytes untouched; canonical/OG/sitemap carry the build origin (MW-U04); `robots.txt` must be a host file (MW-H02); `dir/index.html` output, so the host's trailing-slash redirect sets canonical URLs | Strong (static MPA, host 404 and redirects stay) | Works (same-URL PPP both engines; prefix PFP), not indexable | w2a-01-lab T1, T3, `lint-table.txt`; w2a-09 S21 |
| Jekyll 4.4.1 (docs only, no lab run) | `url` = final origin, `baseurl: ""` at the root (`/repo` needs `--base`); build in CI and publish `_site/`; on GitHub Pages add `.nojekyll` or `/_mw/` is dropped | GitHub Pages: no custom headers, OPTIONS 405, fixed `max-age=600`, non-commercial use only | Good on a user/org site at the root or a custom domain | Not tested | w2a-05 F42, Gotcha 18; w2a-09 S21-S22 |
| Eleventy 3.1.7 (lab) | `pathPrefix: "/"`; use the `url` filter consistently; sub-path: `pathPrefix` plus `HtmlBasePlugin` and `--base` | Root-absolute HTML (10 URLs) and JS literals (MW-U03): fine same-URL, fatal under a prefix | Strong | Works (same-URL PPP; prefix PFP) | w2a-01-lab T1, T3 |
| Astro 7.4.0 with ClientRouter (lab) | `site` = final origin; `base: "/"` (or `/repo/` plus `--base`); `trailingSlash` and `build.format` to match the host's clean-URL behaviour; `ASTRO_TELEMETRY_DISABLED=1` | ClientRouter soft navigations need History mirroring in the shell (in code, M31); 4 root-path JS literals | Strong (soft navigations fetch host HTML) | Works (same-URL PPP; prefix PFP) | w2a-01-lab T1, T3, `mirror.*.json`; w2a-09 S21 |
| Next.js 16.4.2 `output: 'export'` (lab) | `output: 'export'`, `images: { unoptimized: true }`, `trailingSlash` to match the host, `basePath` only with `--base`; `generateBuildId` = git sha; `NEXT_TELEMETRY_DISABLED=1` | Heaviest root-absolute use (37 HTML URLs, 52 JS literals); `404.html` must answer with 404 (MW-R03); resource hints (MW-P01); the host must map `/about` to `about.html` (GitHub Pages, Netlify and Cloudflare Pages do); features that need the Next server are absent from a static export | Strong | Works (same-URL PPP; prefix PFP) | w2a-01-lab T1, T3; w2a-05 F29; w2a-06 F4, R19; w2a-09 §Summary 5 |
| Nuxt 4.6.2 (lab) | `nuxt generate` with `ssr: true` (prerendered); `app.baseURL` only with `--base`; `NUXT_TELEMETRY_DISABLED=1` | `<script type=importmap>` (MW-X04, resolves against the document base); router fallback (MW-R01); `ssr: false` gives an empty-root SPA: prefix FFF and not indexable (SEO-24) | Strong with `ssr: true`; weak for SEO with `ssr: false` | Works both ways (same-URL PPP) | w2a-01-lab T1, T3, `lint-table.txt` |
| Gatsby (not researched) | No wave 2A evidence. Apply the generic recipe and prove it with M01 before claiming support | Unknown | Unknown | Unknown | none (gap, Q28) |
| SvelteKit 3.1.0 + adapter-static 4.0.0 (lab) | Prerender every route; adapter-static `fallback` only for SPA-only builds; `paths.base` only with `--base` | Nothing failed: output uses relative URLs (28), so even the v0.1 prefix passed | Strong | Works (PPP in every model) | w2a-01-lab T1, T3 |
| Docusaurus 3.10.2 (lab) | `url` = final origin, `baseUrl: "/"`, explicit `trailingSlash` matching the host; keep the browser router (hash router only for the demo hub) | 12 absolute own-origin URLs (canonical, `og:url`, `hreflang`, sitemap); i18n `hreflang` (MW-I01); `alert`/`confirm`/`prompt` call sites ignored in the shell sandbox (MW-X05); the hash router passes everywhere but hash routes are not indexable (SEO-06) | Strong | Works (same-URL PPP; prefix FFP, remap FFF) | w2a-01-lab T1, T3, `sw-lab4` C; w2a-05 SEO-06 |
| MkDocs 1.6.1 + Material 9.7.7 (lab) | `site_url` = final origin; `use_directory_urls` matching the host; `theme.font: false` (self-host fonts) | 9 third-party URLs (Google Fonts, theme author: MW-U06, privacy and offline); the Google Fonts build stalled in WebKit in every model and without a SW (lab environment); the 7 root-absolute URLs are all in `404.html`; 49 files / 2,480 KiB with source maps or precompressed siblings that only bloat the torrent (MW-F04) | Strong | Works (PPP, even under the prefix) | w2a-01-lab T1, T3, `lint-table.txt` |
| Vite 8.3.4 + React Router 8 SPA; Create React App | Indexable sites: prerender every route or move to an SSG or static export (CRA is deprecated since 2025-02-14); `base: "/"` (`./` only for the demo hub); router `basename` with `--base`; shell: routing manifest `spa` fallback (navigations only); drop-in: the host must provide the deep-link fallback | Empty-root HTML is not indexable (SEO-24); load-only shell mirroring loses routes on reload (fixed in code, M31); under the v0.1 prefix the router shows its 404 route | Medium (host fallback needed; SEO only after prerendering) | Good (same-URL PPP; prefix FFF) | w2a-01-lab T3, `mirror.*.json`; w2a-05 F29, R6; w2a-09 §Summary 4 |
| Angular 22.2.3 (lab) | `ng build --base-href /` (`/repo/` with `--base`); prerender routes for SEO; an app using Angular's service worker follows the foreign-SW recipe (M29) | A `<base href>` is present (MW-B01): never inject a second one; Angular's worker skips URLs with a file extension in its navigation fallback; `ngsw` and `/mw-sw.js` cannot share scope `/` | Medium (foreign worker, SPA fallback) | Good (same-URL PPP; prefix FFF) | w2a-01-lab T1, T3; w2a-09 §Summary 4; v0.2 §3.4.4 |
| WordPress via Simply Static 3.8.18 (recommended) or Staatic 1.14.0 | Pretty permalinks (Plain `/?p=N` is not exported; record a redirect table); Simply Static "Absolute" URLs with `https://<final domain>`; include `robots.txt`, the 404 export and unlinked files; page-builder backgrounds via `ss_match_tags`; read `exports/latest` (M26). Staatic: raise the 4 h limit and rely on the audit (its URL rewriting is undocumented) | Lost: WooCommerce, EDD, MemberPress, Restrict Content Pro, bbPress, BuddyPress, `?s=` search, comment and contact forms, REST, oEmbed, XML-RPC, login; `?ver=` on every asset (M21); `s.w.org` emoji, `api.w.org` link and `wpApiSettings` absolute URLs (M50); WXR emails and IPs (M04); up to 8 files per photo; "Relative Path" mode breaks OG/canonical/sitemap and "Offline" mode is for archives | Strong after export to a host you control; live WordPress with drop-in for subresources only is an untested proposal (path D) | Only for sites that do not need search traffic | w2a-02 F2-F3, F9, F15, F19-F20, §Recipes WordPress |
| Ghost 6.71 via gssg or a Content-API exporter (StaticGhost) | gssg `--domain http://localhost:2368 --productionDomain https://<domain>`; Private Site Mode on the origin; Pagefind, Giscus or ledger comments, a third-party Portal replacement; Ghost 6 caps page size at 100 for custom exporters | Lost: members, paid subscriptions, gating, native comments, analytics, offers, trials; exporters lag Ghost releases (gssg tested on 4.48.2; SnapStatic quit) | Strong after export; live Ghost(Pro) drop-in unverified (root worker file) | Only for sites that do not need search traffic | w2a-02 F4, F26, §Recipes Ghost |
| Drupal via Tome 8.x-1.16 | `drush tome:static --uri=https://<domain>` (from a search snippet, not run); output `../html`; add a 404 page | Only anonymous-accessible content; non-200 responses are not written (no 404 page); query strings stripped; `path/index.html`; Webform, search and login lost; "minimally maintained" | Strong | Only for sites that do not need search traffic | w2a-02 F5, §Recipes Drupal |

Not in the requested list but covered by w2a-02 §Recipes: Squarespace exports content only (WordPress-format XML,
no store or media files; download images before the subscription ends), Wix has no official code export, Webflow's
code export drops CMS content, ecommerce, forms and search. All three are content re-platforming, not exports.

## 8. Dynamic features: loss and replacement

Class (w2a-03 §2): **N** works with the v0.2 site ledger and SDK as specified; **C+** needs new magnet-web code;
**E** hosted third party called from the browser; **S** needs a server or edge function of the owner.

| Feature | What a static export loses | Replacement for magnet-web | Class | Mode notes | Hard limits | Sources |
|---|---|---|---|---|---|---|
| Site search | `GET /?s=` reloads the home page; Ghost and Drupal search need their backends | Pagefind 1.5.x at publish time plus a legacy-form shim; MiniSearch, FlexSearch, Orama for small sites; Lunr unmaintained since 2020-08 | N | Both; in drop-in the Worker's requests may go to the host | Index 20 % to 43 % of HTML bytes, 200+ files, renamed every build | w2a-02 F9-F10; w2a-03 F34-F35 |
| Comments, guestbook | The comment form posts to a dead endpoint | Legacy comments as static JSON without email or IP; new ones as a ledger `append` list per page (`--policy open`) with moderation; Giscus if a GitHub account is acceptable | N (+C+ approval queue) | Both | 2 KiB values, 8 MiB default ledger (64 MiB ceiling); Sybil and spam; no erasure | w2a-02 F11; w2a-03 F7-F14 |
| Likes, reactions | Server counts | `react` op (last-writer-wins per author and target), reducer-maintained counts labelled "devices" | C+ | Both | 570 to 1,039 B per like; 8 MiB holds about 8,000 to 14,700 | w2a-03 F15-F17 |
| View and download counters | Server counts | Not on the ledger: tracker scrape for concurrent peers; opt-in cookieless beacon | E | Both | Host logs undercount; no unique-visitor truth | w2a-03 F36 |
| Contact forms | `action` points at the CMS origin | Relay through `fetch` (Formspree, FormSubmit, Web3Forms) or `mailto:`; sealed ledger inbox opt-in only | E (C+ sealed) | Both; site CSP must allow the relay in `form-action` | Formspree free 50/month; FormSubmit exposes the address in source; 1,437 B sealed plaintext; EDPB guidance | w2a-02 F12; w2a-03 F18-F25 |
| Newsletter signup | Ghost Portal and plugins need server code | Provider embed form (Buttondown, Beehiiv); RSS/Atom as static files | E (S for sending) | Both | Double opt-in and sending need a mail system | w2a-02 F9; w2a-03 F21-F22 |
| Login, members, paywall, private or per-user content | Impossible without a server | External membership service or a dynamic subdomain; a ledger identity is a device key, not an account | S | Neither | Torrent and host copy are public to anyone with the infohash | w2a-02 F9; w2a-03 F26-F33, F60 |
| Password-protected pages | Stop working | Build-time encryption with a browser prompt (StaticGhost uses AES-256) | C+ | Both | Ciphertext is public forever; only as strong as the password | w2a-02 F9 |
| E-commerce | WooCommerce and EDD incompatible | Stripe Payment Links or Buy Button; Snipcart with host-served product HTML; hosted crypto processors | E (S for checkout sessions, webhooks, fulfilment) | Snipcart needs drop-in (crawler sees host HTML) | No secrets, webhooks or inventory in the browser | w2a-02 F13; w2a-03 F42-F46 |
| Media streaming | Server-side range serving | Default: media excluded from the torrent and served over HTTP; opt-in lazy tier with exact 206 slices; HLS segments with hls.js | C+ | Both; iPhone Media Source is partial (ManagedMediaSource from iOS 17.1) | v1 non-goal; whole-torrent-first caps | w2a-03 F47-F52; w2a-10 checkpoint 10-12 |
| Chat, live rooms | Server sockets | Ephemeral rooms on a `mw_room` wire extension (Trystero is the precedent) | C+ | Foreground only on iOS | Mesh size | w2a-03 F53-F55 |
| Moderation tooling | Admin panel | Owner ops, approval queue, local mute, subscribable label lists | C+ | Both | Cannot erase bytes peers already hold | w2a-03 F56-F59 |
| Analytics | Server logs | None by default; scrape count; opt-in cookieless beacon | E | Both | DAP needs two servers; local DP needs 10k to 40k visitors | w2a-03 F36-F39 |
| A/B testing, personalization | Server-side variants | Deterministic local bucketing shipped in the torrent; local-only storage, never on the ledger | N | Both | No outcome measurement without telemetry; Safari 7-day eviction | w2a-03 F40-F41 |
| Pretty URLs, redirects, headers | `.htaccess` and Nginx rules | Shell: `_redirects`/`_headers` compiled into `/.mw/site.json`; drop-in: the host keeps its own rules; meta-refresh stubs where nothing else works | C+ | The drop-in SW never synthesizes redirects, 404s or headers | Cloudflare: 2,000 static + 100 dynamic rules, no query matching | w2a-02 F18; w2a-09 §Summary 1-3; w2a-03 F5-F6 |
| REST API, oEmbed, XML-RPC | Dead endpoints; discovery links and absolute URLs remain in HTML and inline JS | Pre-rendered JSON for read-only needs; strip the links; later an opt-in route table answered by page-held handlers | Lost (snapshots possible) | Both | Read-only | w2a-02 F9, F19; w2a-03 R6 |
| Scheduled posts, drafts, previews | Only what was public at export time | Re-export on a schedule in CI | Changed | Both | Cron only at build time or on the owner's machine | w2a-02 F9; w2a-03 F60 |
| On-demand image resizing | Only referenced and crawled sizes exist | Pre-generate the sizes the HTML references | Changed | Both | Up to 8 files per WordPress photo | w2a-02 F9, F20 |
| Feeds, sitemap, robots | Copied by exporters | Real files on the host (and in the torrent) | Supported | Must never depend on a SW | Sitemap 50,000 URLs or 50 MB; robots.txt 500 KiB | w2a-02 F9; w2a-05 SEO-08, SEO-21 |
| Archives, pagination, tag pages | Only what the crawler reaches | Exporter "additional URLs"; the audit reports unreachable listings | Mostly supported | Both | | w2a-02 F9 |
| Multilingual | Plugin-dependent | Language subdirectories; `lang` on `<html>` for Pagefind | Supported | Both | | w2a-02 F9 |
| Email sending, payment webhooks, secrets, IP rate limits, geo-blocking, cron, server-side personalization | Everything | Stays on the owner's server or edge function | S | n/a | Anything in the torrent or on the host is public | w2a-03 F60 |

## 9. SEO rules for migrated sites

Condensed from w2a-05 §5.2 (rule ids kept) and corrected for v0.2 (HTML is not in the drop-in torrent). MUST rules
block cutover; the test matrix is w2a-05 §5.3 (T1 to T16).

**Serving model**
1. MUST (SEO-01): every URL meant to be found or shared returns complete final HTML from the host with HTTP 200 and
   needs no JavaScript, SW, WebRTC, IndexedDB or cookies.
2. MUST (SEO-02): any site that wants search or social traffic uses drop-in; shell mode is for apps and demos; hub
   origins are never indexable.
3. MUST (SEO-03, corrected): for every non-HTML path the swarm bytes equal the host bytes; one build output feeds
   host, web seed and torrent; CI verifies after every deploy (M06). HTML is host-only in drop-in (V3).
4. MUST NOT (SEO-04): titles, descriptions, canonicals, robots directives, structured data or Open Graph tags come
   only from the loader, SDK, SW or ledger state.
5. SHOULD (SEO-05): HTML navigations are network-first and an origin 404 is never answered with a cached page
   (v0.2 §3.4.2 already passes navigations through).

**URLs, status codes, routing**
6. MUST (SEO-06): every route is a real URL; no `#/` or `#!` routes; links are `<a href>`; client routing uses the
   History API on real URLs.
7. MUST (SEO-07): unknown URLs return 404 per the host recipe, never a 200 shell or a redirect to the home page
   (GitHub Pages gives a real 404; Cloudflare Pages without a top-level `404.html`, Netlify `/* /index.html 200`
   and CloudFront 404-to-200 mappings give soft 404s).
8. MUST (SEO-08): `robots.txt`, `sitemap.xml`, the IndexNow key, favicon, manifest, OG images and verification
   files are real files at the host root.
9. SHOULD (SEO-09): one URL form per page that matches the host (Cloudflare Pages redirects `/x.html` to `/x`); no
   trailing-slash flip-flops.
10. MUST (SEO-10): loader pointers (`#magnet:...`, `?mw=...`) never appear on indexable or shared URLs.
11. SHOULD (SEO-11): keep every public URL unchanged (drop-in needs no redirects); moving the canonical host to a hub
    or gateway is a site move.

**Metadata**
12. MUST (SEO-12): the raw head has a unique `<title>`, a meta description, an absolute self-referential canonical
    and no `noindex` unless intended; JavaScript never changes canonical or robots tags.
13. MUST (SEO-13): `og:title`, `og:description`, `og:url` (= canonical), `og:type`, `og:site_name`, `og:image` (absolute
    HTTPS URL on the host, never `blob:`, SW-only or under `/_mw/`) with width and height, `twitter:card`; image at
    least 1200x630 and 900 px wide (Apple), at most 5 MB (LinkedIn), preferably under about 600 KB (WhatsApp,
    third-party figure); a square icon of at least 108 px.
14. MUST (SEO-14): HTML under 1 MB (Apple, Meta) and each JS/CSS file under 2 MB uncompressed (Googlebot); share
    metadata early in `<head>` (project convention: within the first 32 KB).
15. MUST (SEO-15): share URLs use only server-side redirects (Apple ignores meta refresh).
16. SHOULD (SEO-16, SEO-17): JSON-LD in static HTML only for types that still have features (FAQ rich results ended
    2026-05-07); content-hashed JS/CSS names; the loader URL changes with each release.

**Crawl control**
17. MUST NOT (SEO-18): block JS, CSS or XHR needed for rendering; `Disallow: /_mw/` only after the static stub
    exists (M12).
18. MUST (SEO-19): de-index with `noindex` (meta or `X-Robots-Tag`), not `Disallow`, and never both on one URL.
19. SHOULD (SEO-20 to SEO-23): hub and wildcard-hub origins send `X-Robots-Tag: noindex, nofollow`; sitemaps use
    absolute same-host URLs and change `lastmod` only on a real content change; separate seed copies get
    `X-Robots-Tag: noindex` and a canonical `Link` header; IndexNow is optional and does not notify Google.

**Content migration**
20. MUST (SEO-24): SPAs prerender every route at build time; verify with JavaScript off; no UA-sniffing prerender
    services.
21. MUST (SEO-25): CMS exports rewrite canonical, OG and sitemap URLs to the final origin (Simply Static "Absolute"
    mode; never "Relative Path" for a live site).
22. SHOULD (SEO-26): ledger-driven areas are either non-indexable by design or snapshotted at publish time
    (moderated, escaped, `rel="ugc nofollow"`).

**Loader behaviour**
23. MUST (SEO-27): the loader is inert for crawlers by construction (capability probes with timeouts, no
    user-agent sniffing), never replaces, hides or reorders content, and its UI is one appended container marked
    `data-nosnippet`.
24. MUST (SEO-28): start peers after `load` and idle, never during `document.prerendering` (prerender would expose
    the IP of someone who may never arrive); close WebRTC, sockets and IndexedDB work on `pagehide`; re-initialise
    on `pageshow(persisted)` without a reload.
25. MUST (SEO-29): history is replace-only; first-install activation adds no entries; an E2E covers Back (back-button
    hijacking is a spam-policy violation since 2026-04-13).
26. SHOULD (SEO-30): SW-served HTML carries `Cache-Control: no-cache`, not `no-store` (bfcache, C14).
27. MUST (SEO-31): run the T1 to T16 matrix before cutover and on each release; time sinks to skip: `llms.txt`
    (ignored by Google), FAQ and HowTo markup, X Card specifics (first-party docs removed).

## 10. Reference CI/CD outline

Merged from w2a-06 (Summary 1, Appendix A and B), w2a-02 (§The migration pipeline), w2a-04 §5.2 and w2a-05 §5.1,
and aligned with v0.2 (drop-in stamps HTML after packing because HTML is not in the torrent). Every stage is a file-in,
file-out step of `tools/mw.mjs` or `tools/publish.mjs` that can run locally with `--dry-run` (M37).

| Stage | Drop-in lane (host is the seed) | Shell or hub lane (cross-origin seed) | Gate |
|---|---|---|---|
| 0 plan | Version and channel from the tag; `seq` = published `seq` + 1 | Same; `seq` read from the authoritative DNS record | Never from the clock |
| 1 build | Unprivileged job, no secrets, lockfile install, pinned Node, `SOURCE_DATE_EPOCH`, telemetry off | Same | Build passes |
| 2 export (CMS only) | Adapter produces a directory plus the exporter manifest (Simply Static `exports/latest`) | Same | Manifest saved |
| 3 check | `publish --check`: path policy, budgets, secrets/PII, `mw-lint` generator rules, feature audit, static SEO lint | Same | No blocking finding |
| 4 normalize and enhance | Alias map, strip dead endpoints and PII, vendor chosen third-party assets; Pagefind; `robots.txt`, `sitemap.xml`, `404.html` if absent | Same | Idempotent (second run changes nothing) |
| 5 pack | Torrent of non-HTML files (minus `p2p: false` files), `files.json`, `site.json`, `release.json`; pack again from another path | Torrent of the whole staged tree; same double pack | Identical btih |
| 6 upload non-HTML | Host deploy of non-HTML files, `/_mw/`, `/mw-sw.js`, `/_mw/t/<btih>.torrent`; previous deploy kept at least 7 days | Staged `tree/` and `.torrent` to `r/<semver>-<btih8>/` (`application/octet-stream`, `public, max-age=31536000, immutable`, no `Content-Encoding`, conditional writes) | Prefix empty before write |
| 7 verify seed | `seed` mode against the host (same origin, no preflight) and `host` mode against `files.json` | `seed` mode on the PUBLIC URL with preflight, every piece by Range, SHA-1 | All PASS |
| 8 sign | Separate job and environment; KMS P-256 `Sign`, DER to raw, check with the browser's `verifyPointer` | Same | Signature verifies |
| 9 publish pointer | Stamp `<meta name="mw-pointer">` and the script tag (`data-cfasync="false"`, `integrity` when needed) into every HTML file; upload HTML last; optional DNS TXT as the update channel | Shell host deploy, then DNS write by compare-and-swap with 255-byte strings | Upload ordering respected |
| 10 verify from outside | `origin` mode (full GET parity, Range-200 flag); live `seo-lint` (UA matrix, status codes, OG) | `dns check`: authoritative servers, then two DoH resolvers, then `AD`; `origin` mode | Zero unexplained differences |
| 11 smoke | Headless Chromium resolves the pointer, downloads, renders, reports the source | Same | Renders |
| 12 release | GitHub Release with `site.torrent`, `release.json`, `pointer.txt`; `actions/attest` on public repositories; GC past retention | Same | Recorded |

Side flows: **rollback** re-signs the old btih with `seq + 1` and a fresh `exp`, then reruns stages 7, 9 and 10
(never republish a stored signed pointer); **PR previews** run an unprivileged build, then a `workflow_run` deploy
(same-repository PRs only, `event == 'push'` gate for production) to `pr/<n>/<btih8>/` with a hub URL comment and a
14-day expiry; **canary** runs daily plus an external heartbeat (M36); **promotion** from beta to prod is a re-sign
for the other hostname, not a copy.

Trust boundaries (w2a-06 Appendix A): `plan`, `pack` and `smoke` hold no credentials; `build` runs site dependencies
with no credentials; `seed` assumes `mw-seed-writer` (`s3:PutObject` under `r/*`) in the `production` or `beta`
environment; `sign` assumes `mw-signer` (`kms:Sign` on one key plus read-only DNS) behind a second approval;
`dns` assumes `mw-dns-writer` limited by record name, type and action; `release` has `contents: write` only.
Workflow-level `permissions: {}`, SHA-pinned actions, `persist-credentials: false`, `concurrency` with
`queue: max`, `include-hidden-files` on artifact uploads, and upload the staged tree, never `dist/` (`aws s3 sync`
uploads `.DS_Store` and every dotfile) (w2a-06 F3, Gotcha 6-7, 19).

## 11. Hosting provider matrix

List prices of 2026-10-17 from w2a-07 F18-F19 unless another source is named. "Stock" = the unmodified WebTorrent
3.0.21 seed request; "after M07" = only `Range` sent. "SW at root" = the host can serve `/mw-sw.js` at the root of
the site's own HTTPS origin, which shell and drop-in need (derived from v0.2 §3.1, §3.4.2 and w2a-04 F17; w2a-07
did not probe this per host). In drop-in mode the seed is the host itself read same-origin through the SW, so only
the egress column and byte fidelity matter there (w2a-07 F4).

| Provider | Role fit | HTTPS custom domain | Wildcard | CORS + Range as a cross-origin seed | Egress cost | SW at root | Notes |
|---|---|---|---|---|---|---|---|
| GitHub Pages | Shell or drop-in host (non-commercial) | Yes (Let's Encrypt) | No | Stock FAIL (OPTIONS 405); after M07 PASS (identity 206) | $0, soft 100 GB/month, 1 GB site | Yes on a user/org root or custom domain; project sites only under their sub-path (shared origin, M28) | Real 404; fixed `max-age=600`; no custom headers; `.nojekyll` needed for `/_mw/` (w2a-05 F42) |
| Cloudflare Pages | Shell or drop-in host; never a cross-origin seed | Yes (100 per project on Free) | No | Range answered with 200 (documented, page updated 2026-10-10): wrong bytes | $0 "unlimited" | Yes | SPA mode without a top-level `404.html` (soft 404s); `.html` redirects to extensionless; 20,000 files Free (100,000 paid), 25 MiB per file (w2a-05 F44; w2a-02 F24) |
| Cloudflare Workers static assets | Shell host; hub via Workers routes | Yes | Yes (Workers routes such as `*.hub.example/*`) | Range unverified (Q21) | $0 for static requests | Yes | w2a-07 pick for small commercial sites (R16) |
| Netlify | Shell or drop-in host | Yes | Automatic wildcard certificate with Netlify DNS; single-site wildcard alias unverified | Stock FAIL (OPTIONS without CORS); `_headers` can add CORS; identity 206 measured; ignores user-set `Accept-Ranges`, `Content-Encoding`, `Content-Length`, `Content-Range` | 20 credits/GB and 2 credits per 10k requests; Free 300 credits (about 15 GB) then every project pauses; Pro $20 = 3,000 credits | Yes | Pretty URLs serve `/both` from `both.html`; matched `/FILE.html` case-insensitively (w2a-09 §Summary 5) |
| Vercel | Shell, drop-in or hub host | Yes | Yes (Vercel DNS or NS delegation of `_acme-challenge`) | Stock FAIL (OPTIONS without Allow-Headers); after M07 PASS (static ACAO `*`, 206) | Hobby 100 GB and 1 M requests, non-commercial; Pro $0.15 to $0.35/GB or Flat Rate tiers ($20 / $100 / $300) | Yes | `vercel.json` headers |
| Amazon S3 (REST endpoint) | Cross-origin seed only | No (CloudFront needed) | Via CloudFront | No CORS by default; rules need `AllowedHeaders: ["*"]` (the documented `["Range"]` fails the stock request); 206 measured; HTTP/1.1 only | $0.09/GB direct after 100 GB free; GET $0.40/M; storage $0.023/GB-month | No (website endpoint is HTTP only; REST is a shared bucket host) | Conditional writes (`If-None-Match: *`) enforce immutable prefixes (w2a-06 F8) |
| S3 + CloudFront | Seed and site host; hub with an ACM wildcard | Yes (ACM in us-east-1) | Yes (one label, 100 alternate names) | Managed CORS-With-Preflight sends no `Access-Control-Allow-Headers`: custom policy (Business tier on flat plans) or managed SimpleCORS after M07; a Range probe with gzip got a full compressed 200 (browsers send identity) | $0.085/GB first 10 TB (US), $1.00/M HTTPS requests, always-free 1 TB and 10 M requests; flat plans Free / $15 / $200 / $1,000 | Yes | Default root object only for `/`; subdirectory index needs a function (w2a-02 F17; w2a-06 F10) |
| Cloudflare R2 | Recommended cross-origin seed | Yes, the zone must be on Cloudflare (partial CNAME setup is Business and up); `r2.dev` is dev-only and rate-limited | Per hostname (100 per bucket); Universal SSL covers first-level subdomains | No CORS by default (bucket JSON); S3 API Range; the edge answers 200 when it must decompress (use `octet-stream` + `no-transform`); Range through the cache untested (Q20) | $0 egress; storage $0.015/GB-month; Class A $4.50/M, Class B $0.36/M; free 10 GB, 1 M A, 10 M B | Not researched as a site host | Default seed recipe after a real-bucket check (M38) |
| Backblaze B2 | Seed behind a partner CDN | Via a CDN only | Via a CDN | Denies preflight by default (100 rules max); single-range 206 (200 when the range covers the whole file); `f00X` hosts HTTP/1.1 | $6.95/TB-month; free egress up to 3x stored bytes, then $0.01/GB; free through Cloudflare, Fastly, bunny.net, CacheFly | No (seed host) | "3x free egress" is tiny for a small site |
| Bunny Storage + CDN | Seed (site hosting not researched) | Yes (free Let's Encrypt or your own) | Automatic wildcard only with Bunny DNS | CORS by extension in the Headers tab or an Edge Rule; OPTIONS unverified; identity 206; "Optimize for large object delivery" for uncached Range | $0.01/GB EU/NA, $0.03 Asia/Oceania, $0.045 South America, $0.06 Middle East/Africa; Volume tier $0.005; $1/month minimum | Not researched | The edge compresses listed types (Range with gzip returns 200) |
| DigitalOcean Spaces + CDN | Seed | Yes (CDN custom subdomain) | Let's Encrypt wildcard only with DigitalOcean DNS | No CORS by default; the default rule lacks `cache-control`; 206 measured | $5/month includes 250 GiB storage and 1 TiB transfer, then $0.01/GiB | No (seed host) | One CDN per bucket; 800 ops/s on new buckets |
| Storj linksharing | Zero-configuration seed | Pro plan only | No | Stock PASS (ACAO `*`, Allow-Headers `*`); 206 | $7/TB egress; $7/TB-month storage; $5/month minimum | No | Rate limits and SLA unknown (Q21) |
| Pinata / Filebase IPFS gateways | Seed only after M07 | Pinata dedicated gateway with a custom domain; Filebase Pro | n/a | ACAO `*` but Allow-Headers without `Cache-Control`: needs M07; 206 | Pinata 500 GB then $0.10/GB plus request fees ($798/month in the 8 MB example); Filebase IPFS 250 GB then $0.015/GB, object egress free | No (Pinata serves HTML only through a dedicated gateway) | w2a-07 R14 removes public IPFS gateway examples |
| Blossom servers | Single-file archive seed (experimental) | Operator's domain | n/a | BUD-01 mandates ACAO `*` and Allow-Headers `Authorization, *` (passes stock); Range is only a SHOULD (Primal ignores it) | Operator-defined, usually free, no SLA | No | Single-file blobs only |
| jsDelivr, cdnjs | Do not use | n/a | n/a | jsDelivr returns brotli bytes labelled identity as 206; cdnjs ignores Range | Free | No | Tier 3 (w2a-07 R3) |
| ipfs.io, dweb.link, Cloudflare IPFS, Storacha / Fil One | Do not use | n/a | n/a | 429 or a challenge; `cloudflare-ipfs.com` no longer resolves; Fil One has no public buckets | n/a | No | w2a-07 F16 |

Choosing (w2a-07 R3, R16; w2a-05 R5): for drop-in, keep the host you have, check its egress price against the
multiplier (M10) and its ability to keep the previous deploy; for cross-origin seeds use tier 1 (R2 behind a custom
domain, B2 behind Cloudflare or Bunny, Bunny, DigitalOcean, S3 + CloudFront with few files, Storj) and tier 2 only
after M07 (GitHub Pages non-commercial, Vercel, Pinata or Filebase); for hubs with wildcard origins use CloudFront +
ACM, Vercel or Cloudflare Workers routes, never Cloudflare Pages or GitHub Pages. Run M06 against whatever is chosen.
