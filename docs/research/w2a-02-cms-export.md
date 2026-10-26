# w2a-02 - Migrating CMS-driven sites (WordPress, Ghost, Drupal, Squarespace, Wix, Webflow) to static files plus client-side features

- Project: magnet-web (static loader, WebTorrent site delivery, visitor-replicated signed ledger)
- Wave 2A, topic 02. Research date: 2026-10-17 (all "today" statements mean this date). Older sources are flagged "(OLD)".
- Question: how do CMS-driven sites move onto magnet-web with minimal change, which dynamic features are lost, what replaces them client-side, and what must the migration path (shell mode and the new drop-in mode) handle?
- Baseline read before researching: `docs/ARCHITECTURE.md` (v0.1; it was replaced by the normative v0.2 during this run and v0.2 is cited wherever it matters), `docs/INTERFACES.md`, `docs/review/DESIGN-REVIEW.md` (2026-10-17, the v0.2 plan: items 7, 13, 14, 21, 22, 23 and section 5 "drop-in mode"), `docs/research/01` and `04`, and the code in `src/sw`, `src/loader/render.js`, `node_modules/{create-torrent,webtorrent,piece-length}`. This document adds evidence to that plan; where the plan already covers something it says so.
- Evidence tags: **[DOC]** vendor documentation page read; **[CODE]** raw source code read; **[FEED]** GitHub Atom release/commit feed; **[EXP]** my own measurement (scripts and raw results in `docs/research/labs/w2a-02-experiments/`); **[SNIP]** search-result snippet only, page not fetched; **[DERIVED]** arithmetic or logic from the other tags.
- Confidence: **High** = primary source read, or measured, or two independent sources agree. **Medium** = one primary source, or secondary sources that agree with each other. **Low** = single secondary source, snippet only, or inference.
- Honest limits of this run: the shared WebSearch budget for the session ran out part-way (a search was refused; I did not work around it), so after that point only direct fetches of known URLs were possible. Webflow's help center is behind a Cloudflare challenge and returned 403, and I could not locate any official Wix export page. Both are therefore secondary-source only (see F7). `wget`, `httrack` and a WordPress instance are not installed here and I did not install them, so mirroring behaviour is quoted from the manuals, not executed.

---

## Summary

1. **Who matters.** W3Techs (survey date 2026-10-17): WordPress 39.6 % of all websites (58.4 % of sites with a known CMS), Shopify 5.3 %, Wix 4.2 %, Squarespace 2.4 %, Joomla 1.1 %, Webflow 0.8 %, Drupal 0.6 %, Ghost 0.1 %; 32.1 % use no monitored CMS. Web Almanac 2025 puts WordPress at about 64 % of CMS-driven sites and says about 60 % of WordPress sites use a page builder (Elementor 43 %). One deep recipe (WordPress), thin recipes for the rest. (F1)
2. **"Any existing site can migrate" is true only where a static export exists.** WordPress (Simply Static 3.8.18, Staatic 1.14.0, both released 2026-10-16), Ghost (wget-style crawler or Content API exporters), Drupal (Tome 8.x-1.16, "minimally maintained") produce a directory of files. Squarespace exports content only (a WordPress-format XML, no theme, no products, no media files), Wix has no official code export, Webflow's code export drops CMS content, ecommerce, forms and search. For those three, migration means re-platforming content, not exporting a site. (F2 to F7)
3. **WP2Static is dead** (last release 7.2 on 2023-01-31, last commit 2024-02-14) and Strattic hosting was sunset (2024 to 2025). Do not build an adapter for either. (F2)
4. **The cheapest integration point already exists:** Simply Static 3.8.18 stores a per-URL deploy manifest (type, static path, HTTP status, redirect target, `sha1` content hash, size) and serves it at `GET /wp-json/simplystatic/v1/exports/latest` (admin-only). magnet-web can seed `files.json`, redirects and its audit from that instead of re-crawling. (F3)
5. **Design-critical gap 1: URL forms.** Exporters emit absolute URLs (same origin once the site keeps its domain), root-relative URLs (Simply Static "Relative Path" mode is `relative_path + /path`), or document-relative URLs (only Simply Static "Offline" mode and `wget -k`). The v0.1 code serves only `/_mw/s/<btih>/...`, so root-relative assets and links miss the Service Worker. DESIGN-REVIEW item 7 already plans the same-URL fix; this research shows it is mandatory for every CMS export, not an edge case. (F14)
6. **Design-critical gap 2: file names.** `webtorrent` 3.0.21 builds web-seed URLs by string concatenation with no percent-encoding, so a file named `style.css?ver=6.4.2`, `img#1.png` or `100%.png` is requested as a different URL; NFC and NFD spellings are different URLs; macOS APFS silently merges names that differ only by case or normalization (all measured). `create-torrent`'s directory walker also drops every dot-entry (`.well-known`, `.htaccess`). A path-policy linter is a P0 publish step. (F16)
7. **Design-critical gap 3: size and metadata.** A `.torrent` costs about 82 bytes per file plus 20 bytes per piece (measured): 20,000 files at the project's 256 KiB pieces is 1.94 MB of metadata (122 `ut_metadata` blocks of 16 KiB), 50,000 files is 4.86 MB. WordPress generates up to 8 files per photo, so about 2,500 photos reach Cloudflare Pages' 20,000-file free ceiling. `xs=` (already planned) is mandatory above a few hundred files, and a P2P set that is smaller than the site (media on HTTP only) is needed in v1, not v2. (F20, F21, F23, F24)
8. **Re-export deltas work without protocol changes, and ordering is second-order.** Measured with the real `webtorrent@3.0.21`: a store pre-filled file-by-file from the previous version verified 227 of 231 pieces (98.3 %), leaving 4 pieces to download for a 129 KiB file-level change. In a 141 MiB synthetic WordPress-like site, a one-post re-export needs 3.0 MiB with the current path-sorted layout and 1.25 MiB with a generational layout (256 KiB pieces; 64 KiB pieces halve both), but a loader that relies on same-index piece equality would re-download 93 % of the site. BEP 47 padding is a net loss for WebTorrent (it adds 481 MiB, +341 %, at 256 KiB pieces). (F22)
9. **Search is solved by Pagefind (v1.5.2, 2026-04-12), and it is compatible with SW-served files.** Source-level facts: it fetches `pagefind-entry.json?ts=<Date.now()>`, per-hash `.pf_index` / `.pf_fragment` / `.pf_filter` files, and `wasm.<lang>.pagefind` as bytes it decompresses itself (no MIME or `Content-Encoding` dependence). The SW must ignore query strings and the SDK must set `baseUrl`. (F10)
10. **Comments, forms, login, paywall, checkout are the real feature loss.** Ghost's own docs say membership, paid subscriptions, gating, comments, analytics, offers and trials require its frontend layer; Simply Static lists WooCommerce, EDD, MemberPress, Restrict Content Pro, bbPress and BuddyPress as incompatible. Replacements exist (Giscus needs a public GitHub repo and a GitHub account; Staticman's last release is 2020-12; Stripe Payment Links and the buy button are the lowest-friction checkout), but none of them is peer-to-peer. Ledger-backed comments are feasible within the v0.2 limits (2 KiB per value, 8 MiB per ledger by default); for forms a relay or `mailto:` is the default, and a sealed ledger inbox is optional and off by default because the sibling document w2a-03 argues, citing EDPB guidance, that even encrypted personal data should stay off a replicated log (F12, F29). (F9, F11 to F13)
11. **Privacy trap in WordPress exports.** The WXR export (and so every comment import path) carries `comment_author_email` and `comment_author_IP` for each comment (WordPress core `export.php`). A torrent is public and effectively permanent, so the importer must strip these and the publisher must publish from a crawl allowlist, never from the raw `wp-content/uploads` directory. (F11, F20, Gotcha 1)
12. **Crawler parity separates the two modes.** Google's rendering service keeps no state across loads and does not support WebSockets or WebRTC; Meta's crawler reads Open Graph tags from the first 1 MB of the HTML response; Snipcart validates every cart item by a plain, cookie-less GET of `data-item-url`. Shell mode (the loader answers every URL) is invisible to all three; drop-in mode (host keeps serving the HTML) is not. Checkout validated by crawling must use drop-in. (F25)
13. **Root-scope Service Worker is the platform gate for drop-in.** A SW cannot control a scope broader than its script's directory unless the server sends `Service-Worker-Allowed` (MDN). Ghost (Settings > Code Injection) and Squarespace (Core, Plus, Advanced plans) let you add a script tag, but I found no evidence either platform can serve `/mw-sw.js` from the origin root; treat live Ghost(Pro), Squarespace and Wix sites as "export or rebuild first" until tested. (F26)
14. **The migration pipeline should be one tool with CMS-specific adapters in front:** export, audit, normalize, enhance, package, verify, deploy (section "Concrete recommendations"). Everything after export operates on a plain directory, so shell and drop-in modes share it.

---

## Findings

Source IDs (S#, P#, E#) are listed with URLs and dates in Appendix B. "Source date" is the date printed on or implied by the source; "fetched" means read on 2026-10-17.

**Findings index** (claim, confidence, sources, source date). Each finding below repeats this with its evidence; "undated" means the page prints no date and was read on 2026-10-17.

| ID | Claim (short) | Conf. | Sources | Source date |
|---|---|---|---|---|
| F1 | WordPress 39.6 % of sites; priority order of CMS recipes | High | S50, S51 | 2026-10-17; 2026-01-15 (data to 2025-07) |
| F2 | Simply Static and Staatic live; WP2Static dead; Strattic hosting sunset | High (Strattic dates Medium) | S1, S6, S7, S8 | 2026-10-16; 2023-01-31 and 2024-02-14 (commits); S8 undated |
| F3 | Simply Static: URL modes, path mapping, `__qs/`, deploy manifest over REST, crawl gaps | High | S1 to S5 | plugin 3.8.18 (2026-10-16); docs undated |
| F4 | Ghost: membership and comments need the frontend; exporters churn | High / Medium | S9 to S14 | 2026-10-15 (Ghost 6.71.0); 2026-03-06 and 2026-05-01 (forum); 2025-08-04 (gssg commit) |
| F5 | Drupal Tome 8.x-1.16: anonymous-only, `index.html` mapping, queries stripped, minimal maintenance | High | S15 to S17 | 2026-07-09 (release); dev 2026-09-27 |
| F6 | Squarespace exports content only, in WordPress XML | High | S18, S19 | 2026-10-09; 2026-08-27 |
| F7 | Wix has no official export; Webflow export drops CMS, ecommerce, forms, search | Low to Medium | S20 (snippets), S21 | undated |
| F8 | wget and HTTrack naming and conversion behaviour; APFS merges names | High (manuals), measured (APFS) | S48, S49, E3 | wget 1.25.0 man page (undated); 2026-10-17 |
| F9 | Feature-loss table | High / Medium (S20 rows) | S1, S2, S4 to S6, S10, S12, S16, S18, S20, S22 to S29, S36, S38 | 2026 (Staticman 2020-12; Lunr 2020-08) |
| F10 | Pagefind loading pattern works from SW-served files; three settings | High | S22, S23 | v1.5.2, 2026-04-12 |
| F11 | Comments: WXR carries email and IP; ledger limits; alternatives not P2P | High / Medium | S29, S24, S25, S23, S53, P1, P3 | WordPress trunk 2026-10-17; Staticman 2020-12-23; Remark42 2026-10-11 |
| F12 | Sealed form submissions: HPKE-shaped, about 1.4 KB budget | High (RFC), Medium (budget) | S52, P1 | RFC 9180, 2022-02 |
| F13 | Stripe Payment Links and buy button; Snipcart crawl validation | High | S1, S26, S27 | undated (fetched 2026-10-17) |
| F14 | Exporters emit absolute or root-relative URLs; v0.1 code serves only the prefix path | High | S3, S5, S6, S9, S17, S48, S49, P3, P5 | 3.8.18; tree of 2026-10-14; plan of 2026-10-17 |
| F15 | Query strings: `?ver=`, `?ts=`, wget, HTTrack, Tome, Plain permalinks | High | S5, S17, S22, S29, S31, S48, S49 | trunk 2026-10-17; S31 2025-06-28 |
| F16 | Torrent paths pasted unescaped into URLs; NFC, case, dot-files, S3 key rules | High | P6, S34, S39, E3, E5, E6 | measured 2026-10-17; S34 undated |
| F17 | `index.html`, trailing slash, S3 versus CloudFront behaviour | High | S32, S33, P5, P4 | undated |
| F18 | `_redirects` semantics differ (Cloudflare versus IPFS); limits | High | S35 to S38, S5 | undated |
| F19 | Mixed content rules and third-party or dead endpoints in WordPress output | High | S44, S29, S5 | trunk 2026-10-17; MDN current |
| F20 | Real page weights; WordPress image sub-sizes; fit against `maxSiteBytes` | High (illustration derived) | S51, S29, S30, S4, P1 | 2026-01-15; S30 2019-10-09 (OLD) |
| F21 | Metadata cost 82 B per file plus 20 B per piece; 10 MB `ut_metadata` ceiling; `xs` | High | E1, P6, S41 | measured 2026-10-17 |
| F22 | File-granular prefill reuses 98 % to 99 % of pieces; padding is a net loss | High (synthetic site) | E2, E4, P6 | measured 2026-10-17 |
| F23 | Partial P2P sets are already possible in WebTorrent 3.0.21 | High (API), policy is a recommendation | P6, P3, P1 | 3.0.21; plan of 2026-10-17 |
| F24 | Host ceilings: Cloudflare Pages, GitHub Pages, S3, CloudFront | High | S32 to S35, S37 | undated (current docs) |
| F25 | Crawlers, unfurlers and Snipcart see only host HTML | High (Service Worker handling undocumented) | S27, S45, S46, S47, P1 | undated |
| F26 | Root-scope worker needs the origin root; per-platform ability unverified | High (rule), Low (per platform) | S43, S13, S19, S1, P1 | S19 2026-08-27; others undated |
| F27 | Precedents: Simply Static Pro, StaticGhost, `_redirects`, Tome cache, ZeroNet | Medium | S2, S5, S10, S16, S36, S38, S53 | 2026 |
| F28 | Incremental export features are paid or exporter-specific; determinism unproven | High (features), Low (determinism) | S1, S2, S5, S6, S9, S11, S16 | 2026 |
| F29 | Cross-checks with sibling wave-2A documents: root-absolute URLs confirmed by a generator lab; Pagefind measured; forms default changed | Medium (siblings not re-verified) | w2a-01 (interim), w2a-03 (partial), w2a-05 | 2026-10-17 |

### Part A - The 2026 landscape: what can be exported, and how well

#### F1. Market share decides how much recipe each CMS deserves
- **Claim.** WordPress 39.6 % of all websites (58.4 % of sites with a known CMS); Shopify 5.3 %; Wix 4.2 %; Squarespace 2.4 %; Joomla 1.1 %; Tilda 0.8 %; Webflow 0.8 %; Duda 0.7 %; Drupal 0.6 %; Ghost 0.1 %; no monitored CMS 32.1 %. Independent cross-check: Web Almanac 2025 says CMS-driven sites are over 54 % of observed sites and WordPress is about 64 % of those (mobile: Shopify 7.3 %, Wix 5.2 %, Squarespace and Joomla below 3 %); about 60 % of WordPress sites use a page builder (Elementor 43 % mobile, Block Editor 18 %, WPBakery 13 %, Divi 10 %; Elementor was about 56 % in 2024).
- **Confidence.** High. **Sources.** S50 (survey date 2026-10-17, [DOC]), S51 (published 2026-01-15, [DOC]). The two surveys measure different things (all sites versus CMS-driven sites), so only the ranking is comparable.
- **So what.** Build the WordPress path properly (it is also where page builders produce the nastiest HTML/CSS), keep Ghost, Drupal and Webflow to thin adapters, and say plainly that Shopify, Wix and Squarespace sites are not auto-migratable. Shopify has no static export path that I researched; it is marked "not researched".

#### F2. WordPress exporters in 2026: two live, one dead, one hosted service gone
| Tool | State on 2026-10-17 | Free vs paid (as stated by the vendor) | Source |
|---|---|---|---|
| Simply Static | 3.8.18, modified 2026-10-16; tested up to WordPress 7.1.3; min WP 6.2, PHP 7.4; "30,000+" active installs (page also says "40,000+ users"); rating 4.5 from 195 reviews | Free: one-click generation, ZIP or local directory, URL replacement, Elementor/Bricks/Gutenberg, SEO-plugin support. Pro "$99/year (1 site)": deploy to GitHub, Netlify, Cloudflare Pages, AWS S3, BunnyCDN, SFTP; "Changes Only" incremental pushes; "Single Push"; WP-CLI; forms; Fuse.js or Algolia search; comments integration; minify and image optimization; multilingual (WPML, Polylang, TranslatePress). Studio "$12/month per site" = managed hosting. Free version: "Forms, search, and comments do not work ... because they need server-side processing"; ZIP must be uploaded by hand. | S1, S2 [DOC] |
| Staatic | 1.14.0 released 2026-10-16; tested up to WP 7.1.3; min WP 5.0, PHP 7.1; "2,000+" installs; rating 4.4 from 21 reviews | Community: crawls "like a visitor", redirects, custom 404 pages, additional URLs/paths, exclude rules, HTTP headers, WP-CLI, Multisite, WPML, HTTP Basic Auth origins; targets: local directory, S3 or S3-compatible, GitHub, Netlify, SFTP, zip. Premium/Cloud: forms, search, scheduled publications, change-based publications. Lists native comments, some search, forms that post back to WordPress, eCommerce and membership as likely incompatible. Default publication time limit 4 hours. | S6 [DOC] |
| WP2Static | Effectively unmaintained: latest GitHub release 7.2 on 2023-01-31 (before that 7.1.7 on 2022-05-25); latest commit on `develop` 2024-02-14 ("Update CONTRIBUTING.md"); README says Strattic keeps it "available and maintained", but nothing has shipped for 2.5 years | n/a | S7 [FEED] |
| Strattic | Hosting service sunset (Elementor): sources say "mid-2023 acquired by Elementor" and "sunset 2024" or "effective Jan 1, 2025"; the sources disagree on the exact date | n/a | S8 (secondary, undated, vendor-biased), search snippets [SNIP] |
- **Confidence.** High for the two live plugins and for WP2Static's activity (primary pages and Atom feeds); Medium for the Strattic dates (secondary sources disagree).
- **So what.** Target Simply Static first (largest install base, a machine-readable manifest, see F3), accept any crawl-based exporter's directory output, and never depend on WP2Static or Strattic.

#### F3. Simply Static internals that matter for migration (read from the 3.8.18 source)
- **Claim A - URL modes.** `destination_url_type` is `absolute`, `relative` or `offline`. `get_destination_url()` returns `scheme + host` (absolute), the configured `relative_path` (relative; empty means root-relative `/path`), or `./` (offline). So only Offline produces document-relative links; Relative produces root-relative links with an optional path prefix. The docs recommend Absolute for a site on its own domain and warn that Relative breaks "Open Graph images, link, and canonical tags", and that Offline "is meant for local previewing or archiving, not for publishing". S5 [CODE] (`class-ss-options.php` lines 276-290, `class-ss-url-extractor.php` `convert_url`), S3 [DOC]. High.
- **Claim B - path mapping.** A URL with no extension becomes a directory with `index.html` (or `index.xml` for XML), via `build_relative_filename_for_static_page()`: `/about/` is `about/index.html`. S5 [CODE]. High.
- **Claim C - query strings.** Page URLs with a query are written under `__qs/<md5(query)[0:12]>/` (non-hashed `__qs/` for native search `?s=`), but only when the Search Results Page feature is enabled; otherwise the function returns `null` and no file is written (so `/?p=123` pages vanish). Local asset URLs with a query (cache-busting `?ver=`) are NOT given a hash directory and are written to the plain path. S5 [CODE] (`class-ss-url-fetcher.php` lines 502-548). High.
- **Claim D - export manifest.** Each export is stored as a "deploy manifest" (`manifest_version 1.0`; fields include `deploy_id`, `domain`, `mount_path`, `wp_version`, `theme`, `detected_builders`, `export_config_hash` (sha256), `url_counts`, `root_files`, and per-URL records `{url, static_path, type, status_code, content_hash "sha1:<hex>", file_size, redirect_target, found_on, in_sitemap, warnings, errors}`; `type` is one of page, asset, redirect, sitemap, root_file, api, markdown, other). REST routes in namespace `simplystatic/v1`: `GET /exports/latest`, `/exports/<id>`, `/exports/<id>/urls`, `/exports/<id>/files`, `/exports/<id>/warnings`, `/unpushed-changes`, `/export-404`; permission is `manage_options` (filterable). S5 [CODE]. High. Whether the routes are documented for third parties: not found.
- **Claim E - what the crawler misses.** It follows links from the homepage; unlinked pages and files are not picked up; page builders put images in CSS backgrounds that the extractor does not see unless an `ss_match_tags` filter is added; "Additional URLs" and "Additional Files & Directories" (absolute server paths, recursive) are the escape hatches. The docs do not address URLs built by JavaScript. S4 [DOC]. High (JS-built URLs: unaddressed, so unknown).
- **Claim F - inline origin URLs.** The 3.8.9 changelog fixes "bare origin host replacement in inline scripts, including Google Site Kit linker domains", and 3.8.14 fixes "runtime origin URLs ... and excluded form actions": origin hosts do leak into inline JS and form actions in practice. S5 [CODE] (`readme.txt` changelog, 2026). High.
- **Claim G - incremental.** "Changes Only" and "Single Push" are Pro features (S1, S2). The manifest's per-URL `content_hash` is the exporter's own change detector. High.
- **Claim H - scale.** The plugin FAQ says it "has successfully generated static sites with 100,000+ pages", limited by server memory and execution time (vendor claim, not verified). Medium.
- **So what.** (1) Choose Absolute with the production scheme and host, so every link is same-origin once the site keeps its domain, and (2) read `exports/latest` to build `files.json`, the redirect table and the audit report instead of re-crawling. (3) A site on Plain permalinks (`/?p=N`, WordPress's default per S31) must switch to pretty permalinks before export, or its pages are not exported.

#### F4. Ghost: crawl-based and API-based exporters exist but churn with Ghost; the official docs list what static loses
- **Claim.** Ghost is at v6.71.0 (2026-10-15) [FEED S14]. The official docs say: "Ghost's membership functionality is **not** compatible with headless setups"; paid subscriptions, content gating, comments, analytics, offers, complimentary plans and trials require Ghost's frontend layer; a static frontend must re-implement tag and author archives and routes, `sitemap.xml`, SEO metadata, Open Graph and Twitter Cards, custom routes and pagination, and front-end code injection; since Ghost 6.0 `?limit=all` is gone and the page size maximum is 100 (S12 [DOC], no date printed). Exporters:
  - `ghost-static-site-generator` (Fried-Chicken): wget-based crawler (needs wget), README "still a work in progress", tested on Ghost 4.48.2, "themes other than Casper are not fully supported", flags `--domain`, `--productionDomain`, `--dest`, `--subDir`, `--ignore-absolute-paths`, `--fail-on-error`, `--saveAsReferer`; latest tagged release v1.1.4 on 2022-01-11, but master still merged PRs on 2025-08-04 [DOC S9, FEED S9].
  - StaticGhost (desktop app, MIT): Content API based (needs an API key), ships Pagefind search (`/search/search-index.js`), Giscus comments (public repo + Discussions), `rss.xml` and `sitemap.xml`, AES-256 build-time encryption for password-protected posts, tells you to embed Buttondown or Beehiiv for signup because Ghost Portal "cannot" work, recommends other hosts for "gigabytes of raw images/video"; uses a `ghost:5-alpine` container, does not mention Ghost 6; no release date [DOC S10].
  - SnapStatic (browser-based exporter, forum post 2026-03-06): the author announced on 2026-05-01 that it pivoted away from the Ghost exporter because of "the cost of keeping up with upstream Ghost changes" [DOC S11, author claims unverified].
- **Confidence.** High for the docs and feeds; Medium for the tool capability claims (project READMEs and one forum post).
- **So what.** Ghost exporters are a maintenance liability; the durable contract is "a directory of files". Treat the exporter as a replaceable first stage and put the value (audit, normalize, enhance, package) behind it. Ghost's code-injection feature (Settings > Code Injection: site header, site footer, per post) is the natural place for the drop-in script tag, but I did not find which Ghost(Pro) plans include it (S13 is silent).

#### F5. Drupal: Tome is the exporter, and it is in maintenance mode
- **Claim.** Tome 8.x-1.16 released 2026-07-09 (dev branch updated 2026-09-27); Drupal ^10 and ^11 (1.13 added Drupal 11; 1.14 dropped Drupal 8/9; 1.15 and 1.16 fix a fatal error with Drupal 11.4.0); security-team covered; project status "Minimally maintained" and "Maintenance fixes only"; 1,796 reporting sites [DOC S15]. Behaviour from the docs and the source (`StaticGenerator.php`): only entities and routes accessible to anonymous are exported; only responses with status 200 are written (redirect responses are also handled and their targets queued); a path with no extension gets `/index.html` appended; query strings and fragments are stripped from the output file name (`preg_replace(['/\?.*/', '/#.*/'], '', $path)`); same-host absolute URLs are converted to local ones by `makeExternalUrlLocal()`; assets are discovered from HTML (pager links, images, `srcset`, stylesheets, scripts, favicons) and CSS `url(...)`; `cache.tome_static` skips paths already cached and present in the static build (a built-in incremental mode); output directory defaults to `../html` (setting `tome_static_directory`); extra paths come from the `COLLECT_PATHS` event [DOC S16, CODE S17].
- **Confidence.** High. What Tome writes for a redirect response (meta refresh stub or nothing) is not visible in the lines I read: unverified.
- **So what.** Tome output is already `dir/index.html` with absolute-or-local URLs; the only extra work is a 404 page (non-200 responses are never saved) and replacing Drupal's search, forms and login.

#### F6. Squarespace: the export is a content dump in WordPress format, not a site
- **Claim.** Official Help Center article (updated 2026-10-09): one `.xml` file "in a WordPress format"; included: layout pages, one blog page with its posts and up to 1000 comments per post, text and image blocks, text from embed and Instagram blocks "with minimal structure", gallery pages (York project pages in 7.0 only), linked PDFs export in the XML but "can't import to a WordPress site". Excluded: album, cover, index, info, calendar, portfolio and store pages; page-specific headers, footers and sidebars; any blog beyond the primary one; dropdowns; audio, video and product blocks; drafts; style settings; custom CSS. "Many features rely on our platform's JavaScript and CSS, so some content doesn't export." Images may remain hotlinks to Squarespace and stop working when the subscription ends. You cannot export a trial site [DOC S18].
- Code injection exists on the Core, Plus and Advanced plans, and Squarespace "doesn't support server-side code" (S19 [DOC], updated 2026-08-27).
- **Confidence.** High.
- **So what.** There is no Squarespace static export. The only real route is XML to Markdown or WordPress, new theme, then the normal static pipeline.

#### F7. Wix and Webflow: weak evidence, and the conclusion is "rebuild"
- **Wix.** I found no official Wix page describing a site-code export. Secondary sources agree on: no full-site HTML export; blog posts "can typically" be exported as XML from Blog Manager; Wix Stores product data as CSV; third-party "Wix to HTML" crawlers exist but produce a static snapshot that loses forms, ecommerce and member areas and "could ... violate Wix's terms of service" (one source). A direct fetch of Wix's Terms of Use returned 404, so the ToS wording is **unverified**. Confidence: Low to Medium. Sources: S21 (fetched article, undated) plus [SNIP] of several vendor blogs.
- **Webflow.** The official help center page is behind a Cloudflare challenge (403 "Just a moment...") and was NOT read. Search-result snippets of that page (and of third-party posts) state: code export needs a paid Workspace plan (Site plans cannot export); the export contains HTML, CSS, JavaScript and assets; CMS content and collection lists, ecommerce (products, checkout), user accounts, localized content, site search and forms (including file upload and reCAPTCHA) do not work; page password protection stops working. Confidence: Medium (consistent snippets, primary page unread). Source: S20 [SNIP].
- **So what.** Document Wix as "not auto-migratable" and Webflow as "code export gives layout and static pages; CMS items must be exported as CSV and rebuilt with a static generator".

#### F8. Mirroring tools (wget, HTTrack): useful fallback, sharp edges (from the manuals; not executed here)
- **wget 1.25.0 man page [DOC S48].** `--mirror` is "equivalent to `-r -N -l inf --no-remove-listing`" (it does NOT include `-k`, `-p` or `-E`); `--convert-links` runs "after the download is complete"; `--adjust-extension` saves "http://site.com/article.cgi?25 will be saved as article.cgi?25.html" (so a query stays in the file name); `--restrict-file-names=unix` escapes only `/` and control characters (so `?` stays in the name), while `windows` mode escapes `\ | / : ? " * < >` and uses `@` in place of `?`; `--trust-server-names` bases the local name on the redirect target; `--default-page` replaces `index.html` for URLs ending in a slash; `-H` spans hosts, `--no-parent` stops ascent. Confidence: High that the manual says this; the interaction with real WordPress output was not tested.
- **HTTrack manual [DOC S49].** `-K0` (default) keeps relative links and renames query URLs: "foo.cgi?q=45 -> foo4B54.html?q=45"; `-K3` absolute URI; `-K4` original URL; `-N` structure options (`-N4` puts html in `web/` and other files in `web/<ext>`), user-defined structure `%h%p/%n%q.%t`; `-s` robots handling (0 never, 1 sometimes, 2 always, 3 always even strict). Confidence: High (manual text); behaviour not tested.
- **Measured here [EXP E3].** On macOS 27.0 / APFS: creating `caf\u00e9.html` (NFC) after `cafe\u0301.html` (NFD) fails with `EEXIST` (one file), `readdir` returns the spelling you created, and `README.txt` after `Readme.txt` also fails with `EEXIST`. A mirror run on a default macOS volume therefore silently merges names that differ only by case or Unicode normalization. Run mirrors on Linux (or on a case-sensitive APFS volume) and normalize afterwards.
- **So what.** Mirroring is the fallback for sites where no exporter plugin can be installed (for example WordPress.com below the Business plan, per S1's FAQ), and it needs the normalize and audit stages more than any exporter does.

---

### Part B - Features that a static export loses, and what replaces them

#### F9. Feature-loss table
Status key: **Supported** = a replacement exists and fits magnet-web as designed; **Partial** = replacement exists but needs new magnet-web work or a third party; **Unsupported** = no serverless replacement; **Changed** = the workflow changes, the feature stays.

| Feature | What a static export does | Client-side replacement (with precedent) | Fit with magnet-web (v0.2) | Status |
|---|---|---|---|---|
| Site search | WordPress search form is `GET /?s=term` (core `general-template.php`); a static host ignores the query and returns the home page. Ghost and Drupal search need their backends. | Pagefind (F10); Simply Static Pro offers Fuse.js or Algolia; MiniSearch, FlexSearch, Orama for small sites; Lunr is unmaintained (last release 2020-08) | Index files ship as ordinary files; loading pattern verified in source (F10) | Supported |
| Comments | Comment form posts to `/wp-comments-post.php` (core `comment-template.php`), dead after export; existing comments can be rendered as static HTML; Ghost comments need the frontend (S12); Staatic lists native comments as incompatible (S6) | Giscus (public GitHub repo, giscus app, GitHub account to comment; script from giscus.app); Disqus and Remark42 need servers; Staticman last release 2020-12 | Ledger `append` list per post for new comments; legacy comments as a static JSON archive (F11) | Partial |
| Contact forms | `action` points at the CMS origin (core `site_url('/wp-comments-post.php')` for comments; contact-form plugins also post to the origin, not checked per plugin; Simply Static's changelog mentions "excluded form actions") | Third-party form endpoints; Netlify Forms work only on Netlify (build-time form detection, JSON not supported, 8 MB request cap); Simply Static Pro: submissions "stored in WordPress, sent to external webhooks, or embedded as live forms" | Default: third-party relay or `mailto:`; optional sealed ledger inbox, off by default (personal data on a replicated log, F12, F29); payload budget in F12 | Partial |
| Login, members, paywall | Impossible without a server: Ghost docs (S12); Simply Static FAQ lists MemberPress, Restrict Content Pro, bbPress, BuddyPress as incompatible | External identity or membership SaaS, or keep that part on a dynamic subdomain ("dynamic island") | A ledger identity is a device key, not an account; no server-side secrecy exists | Unsupported |
| Ecommerce cart and checkout | WooCommerce and Easy Digital Downloads are listed as incompatible (S1); Webflow ecommerce excluded (S20 snippet); Squarespace store pages excluded (S18) | Stripe Payment Links and the embeddable buy button (no code; hosted checkout); Snipcart (crawls product page, F13) | Works in drop-in; Snipcart-style crawl validation fails in shell mode (F25) | Partial |
| Newsletter signup, subscriptions | Ghost Portal "cannot" work on a static site (S10); WordPress plugins need server code | Buttondown or Beehiiv embeds (recommended by StaticGhost) | Third-party script; needs CSP allowance | Partial |
| Scheduled posts, drafts, previews | A static site contains only what was public at export time (Tome exports only anonymous-accessible content, S16) | Re-export on a schedule in CI | Publish pipeline (F28) | Changed |
| Redirect manager, old URLs | `.htaccess` and Nginx rules are lost; plugin redirects are exported only for some plugins (Simply Static: Redirection, Yoast, Rank Math, Safe Redirect Manager, Page Links To, per changelog 3.1.8, 3.8.10, 3.8.12) | `_redirects` (Cloudflare Pages, IPFS gateways), meta-refresh stubs | Routing manifest (`/.mw/site.json`) in the SW plus `_redirects` on the host (F18) | Supported (limits) |
| Feeds, sitemap, robots | Exporters crawl and copy them (Simply Static handles feed paths, sitemaps, `robots.txt`); absolute URLs inside are rewritten to the destination host | Static files | Pass-through; must be in the host copy for crawlers | Supported |
| REST API, oEmbed, XML-RPC | Endpoints are dead; `<link rel="https://api.w.org/">` remains in `<head>` (core `rest-api.php`) and `wpApiSettings.root` is an absolute URL in inline JS (core `script-loader.php`) | Pre-rendered JSON files for read-only needs; strip the links | Normalize stage removes them (F19) | Lost (snapshots possible) |
| On-demand image resizing | Ghost `/content/images/size/wNNN/` and WordPress sub-sizes exist only if referenced and crawled | Pre-generate the sizes the HTML references | Only referenced sizes enter the torrent (F20) | Changed |
| Archives, pagination, tag and date pages | Only what the crawler reaches; Simply Static 3.8.17 added pagination discovery for date archives; Tome collects entity and route paths | Make exporters enumerate them (Additional URLs) | Audit stage reports unreachable listings | Mostly supported |
| Server-side analytics | Gone | Client-side analytics (third party) or none; magnet-web's design has none | n/a | Lost |
| Multilingual | Simply Static Pro: WPML, Polylang, TranslatePress; Staatic: WPML; Tome has a multilingual page | Language subdirectories | Pagefind needs the `lang` attribute on `<html>` (S22) | Supported |
| Password-protected pages | Webflow password protection stops working (S20 snippet) | Build-time encryption with a browser prompt (StaticGhost: AES-256) | Possible, but secrecy is only as strong as the password; the ciphertext is public forever | Partial |
- **Confidence.** High for rows with [DOC]/[CODE] sources named; Medium for rows resting on S20 snippets. **Sources.** S1, S2, S4, S5, S6, S10, S12, S16, S18, S20, S22, S24 to S29, S36, S38. **Source dates.** 2026 unless a source says otherwise (Staticman 2020-12; Lunr 2020-08).

#### F10. Search: Pagefind works from SW-served files, with three settings to get right
- **Claim.** Pagefind v1.5.2 (2026-04-12; v1.5.0 on 2026-04-06 replaced the Default UI with a Component UI). Verified in `pagefind_web_js/lib/coupled_search.ts` at tag v1.5.2 [CODE S22]:
  1. Entry: `fetch(basePath + "pagefind-entry.json?ts=" + Date.now())` (or `?ts=<metaCacheTag>` if the option `metaCacheTag` is set). The query is a cache-buster, so path lookup **must ignore the query string** (the v0.1 SW does, because `splitSitePath` reads `url.pathname`).
  2. Data files: `pagefind.<hash>.pf_meta`, `index/<hash>.pf_index`, `filter/<hash>.pf_filter`, `fragment/<hash>.pf_fragment`, `wasm.<lang>.pagefind` (language `unknown` if none). All are fetched with plain `fetch` (up to 100 concurrent) and decompressed in JavaScript (`gunzip`, signature `pagefind_dcd`); the WebAssembly is instantiated from the decompressed bytes with `wasm_bindgen({module_or_path: bytes})`, **not** with `instantiateStreaming`. Therefore no `application/wasm` MIME type and no `Content-Encoding` header are needed; the SW's `application/octet-stream` default for unknown extensions is fine.
  3. `basePath` defaults to `/pagefind/` and, for the primary instance, is derived from `import.meta.url` (the directory of `pagefind.js`); `baseUrl` (the prefix put in front of result URLs) is derived by matching `^(.*\/)_?pagefind` in `basePath`, so under `/_mw/s/<btih>/pagefind/` result URLs would carry the `/_mw/s/<btih>/` prefix unless the page sets `baseUrl: "/"`.
- **Sizes.** The docs' sample run reports "Created 27 index chunks" for 2,496 pages (22,852 words); fragments are per page by construction (`fragment/<hash>.pf_fragment`), so a Pagefind index adds roughly one small file per page plus a few dozen chunks [DOC S22; per-page fragment count is [DERIVED], not verified by running the indexer, which I did not install].
- **Alternatives and their maintenance (release feeds).** MiniSearch 7.2.0 (2025-09-16); FlexSearch 0.8.2 (2025-05-21); Fuse.js 7.5.0 (2026-07-13; 7.6.0-beta.0 on 2026-08-09); Orama 3.2.0 (2026-06-27); Lunr 2.3.9 (2020-08-19, no release since). [FEED S23]
- **Cross-check from a sibling document (not re-verified here).** w2a-03 (same wave, 2026-10-17) reports running Pagefind 1.5.2 unchanged inside the SW-served iframe in Chromium 156, including its Web Worker and WASM, with unknown extensions served as `application/octet-stream`, and measures the index at 20.0 % to 43.3 % of the HTML bytes (corpora of 168 and 194 pages), over 200 files, effectively incompressible, plus about 0.5 MB of unused UI bundles in the output directory. That agrees with the source reading above and supplies the browser run that this document lacks.
- **Confidence.** High (primary source code, plus the measured run reported by w2a-03). Behaviour inside magnet-web was not run by me.
- **So what.** Make Pagefind the documented search path: `publish --search` runs the indexer on the staged directory; the SDK or drop-in script sets `baseUrl: "/"` and `metaCacheTag` to the site version (so `pagefind-entry.json` has a stable, versioned URL instead of a timestamp); the SW matches by pathname. Ship a small shim for the legacy WordPress form (`form[role=search]`, input `name="s"`, `GET /`) that sends visitors to a Pagefind results page, because without it a search silently reloads the home page.

#### F11. Comments: static archive for the past, ledger for the future, and a privacy rule
- **Claim A - PII in WordPress exports.** The WXR exporter writes `<wp:comment_author_email>` and `<wp:comment_author_IP>` for every comment (core `wp-admin/includes/export.php` lines 706-709, trunk 7.2-alpha) [CODE S29]. Any importer that reads WXR (including the Squarespace export, which uses the same format, S18) must drop both fields and any `comment_author_url` that the author did not publish.
- **Claim B - capacity.** v0.2 defaults are `writers:'owner'`, `maxValueBytes:2048`, `maxChainBytes:8 MiB` (owner may raise to the 64 MiB ceiling), `maxBlockBytes:4096`; owner blocks are exempt from proof-of-work [P1 `docs/ARCHITECTURE.md` lines 333-336, P3 item 4]. A large WordPress site has tens of thousands of comments with bodies that can be longer than 2 KiB, so legacy comments do not belong in the ledger. [DERIVED]
- **Claim C - alternatives are not peer-to-peer.** Giscus needs a public repository, the giscus app and a visitor GitHub account, and loads `giscus.app/client.js` [DOC S24]; Staticman's last release is v1.7.1 (2020-12-23) and its README steers you to run your own instance [FEED S23, DOC S25]; Remark42 1.18.0 (2026-10-11) is a server [FEED S23].
- **Claim D - precedent.** ZeroNet-style sites (owner-signed `content.json`, files fetched from BitTorrent peers) are the closest prior art; the original project is "abandoned by its creator", the surviving fork says it is "in deeper crisis than ever", and lists "No reliable spam protection" among its limits [DOC S53, undated]. The lesson for a ledger-backed comment system is moderation and quotas from day one, which v0.2 already specifies.
- **Confidence.** High for A to C; Medium for D (README statements).
- **So what.** `mw comments import <wxr>` should write one JSON file per post (`comments/<slug>.json`, sanitized HTML, parent ids, no email, no IP) into the torrent, and the SDK should merge that static list with the ledger list for new comments. The ledger id must stay owner-bound across re-exports (DESIGN-REVIEW item 3) so new comments survive a new infohash. Erasure requests cannot be honored for bytes that peers already hold (w2a-03 raises the same point; DESIGN-REVIEW item 21 limits takedown to best effort), so the comment import should publish only what was already public on the old site and nothing more.

#### F12. Forms: the serverless options, and the payload budget for sealed submissions
- **Claim.** Third-party endpoints and Netlify Forms are the existing options (F9). The peer-to-peer option is to encrypt each submission to the owner's public key before appending it to a ledger list, so a public replicated log carries only ciphertext. RFC 9180 (HPKE, February 2022) defines DHKEM(P-256, HKDF-SHA256) = KEM id 0x0010, HKDF-SHA256 = KDF id 0x0001, AES-128-GCM = AEAD id 0x0001, base mode 0x00 [DOC S52]. The project already standardizes on P-256 for WebCrypto availability (ARCHITECTURE section on identity), so an HPKE-shaped construction (ephemeral ECDH P-256, HKDF-SHA256, AES-GCM) uses only primitives that SubtleCrypto provides. Assumed universal; not re-verified here.
- **Budget [DERIVED].** HPKE base mode adds a 65-byte uncompressed ephemeral point and a 16-byte GCM tag (81 bytes); base64url inflates by 4/3; with `maxValueBytes: 2048` and about 40 bytes of JSON wrapper, the plaintext cap is about 1.4 KB (floor((2048 - 40) x 3/4) - 81 = 1,425 bytes). A contact form with a long message needs splitting across blocks or a higher per-list `maxValueBytes`.
- **Confidence.** High for the RFC identifiers; Medium for the budget (assumed wrapper size).
- **Caution from a sibling document (not re-verified here).** w2a-03 cites the EDPB's Guidelines 02/2025 (v2.0, adopted 2026-07-07: "encrypted personal data is still personal data", and storing personal data on a blockchain is "not advisable") and concludes that personal data should stay off the ledger even when encrypted, with a form relay or `mailto:` as the default. Whether the guidance applies to a log without consensus is, by w2a-03's own account, unverified. I adopt its default and treat the sealed inbox as an opt-in for owners who accept that risk.
- **So what.** Make a third-party relay or `mailto:` the default path (keep third-party `action` URLs working; the site CSP must then allow them in `form-action`), offer `data-mw-form` sealed submissions as an optional, off-by-default feature with an explicit legal note, and never log plaintext submissions anywhere other than the owner's UI.

#### F13. Commerce and membership: what is cheap, and the crawl trap
- **Stripe.** Payment Links are "Accept payments online without writing code": Stripe-hosted page, "limited" customization, 40+ payment methods; the buy-button embed is a `<script src="https://js.stripe.com/v3/buy-button.js">` plus `<stripe-buy-button buy-button-id=... publishable-key=...>`; required CSP is `script-src https://js.stripe.com` and `frame-src https://js.stripe.com`; "Rendering the buy button requires a website domain" (it does not render from `file:`) [DOC S26, pages fetched 2026-10-17].
- **Snipcart.** Before an order exists, Snipcart fetches each cart item's `data-item-url` with a plain `GET` "with no cookies and no authentication", sends `User-Agent: Snipcart/1.0`, follows one redirect hop, strips the `#fragment`, and, unless the response is `application/json`, parses the HTML "for the buy button carrying the item's id" and compares id, price, custom fields and dimensions. "Every item has to pass. If a single one fails, the payment is refused." The page does not say the crawler runs JavaScript [DOC S27].
- **Incompatible plugin list** (Simply Static FAQ): WooCommerce, Easy Digital Downloads, MemberPress, Restrict Content Pro, bbPress, BuddyPress [DOC S1].
- **Confidence.** High.
- **So what.** Document "static catalogue plus Payment Links or buy button" as the supported commerce pattern, include CSP snippets, and state that Snipcart-style validation requires the product HTML (or a JSON file) to be served by the host, i.e. drop-in mode or a JSON endpoint, not shell mode.

---

### Part C - URL structure, file names, query strings, redirects

#### F14. Exporters emit absolute or root-relative URLs; the v0.1 code only handles document-relative ones
- **Claim.** What each tool writes into the HTML:

| Tool and mode | URL form in output | Source |
|---|---|---|
| Simply Static, Absolute (recommended by its docs for a site on its own domain) | `https://<destination host>/path` | S3 [DOC], S5 [CODE] |
| Simply Static, Relative Path | `<relative_path>/path`, i.e. root-relative (`/path`) when the path field is empty | S5 [CODE] `convert_relative_url` -> `safe_join_url(relative_path, path)` |
| Simply Static, Offline | document-relative (`./../../10/page-b/index.html`), with `index.html` appended to every non-file path | S5 [CODE] `convert_offline_url` |
| Tome | same-host absolute URLs converted to local paths (`makeExternalUrlLocal`) | S17 [CODE] |
| Ghost Static Site Generator | `--productionDomain` swaps links to the public domain; `--ignore-absolute-paths` converts domain URLs to relative paths; `--subDir` rewrites for a subdirectory | S9 [DOC] |
| wget `-k` / HTTrack `-K0` | relative links "suitable for local viewing" / relative links | S48, S49 [DOC] |
| Staatic | not described; "publishes the output that WordPress already renders for visitors" from a configurable origin URL | S6 [DOC] |

- **Status of the code.** At the time of the baseline read (2026-10-14 tree), the Service Worker intercepts only `/_mw/*`, navigations and shell assets (`src/sw/sw.js` fetch handler), and `mountSite` sets `iframe.src = /_mw/s/<btih>/<entry>` and mirrors only frame locations under that prefix (`src/loader/render.js`). The example site is written with document-relative links only ("only `/_mw/sdk.js` is absolute", `docs/deviations/example.md`). A root-relative `<link href="/wp-content/themes/t/style.css">` therefore bypasses the SW, and `<a href="/about/">` loads the shell into the iframe. [CODE P5]. DESIGN-REVIEW item 7 and ARCHITECTURE v0.2 section 3.1 already specify the fix (same-URL iframe; SW answers iframe navigations and subresources with site files; `/_mw/s/<btih>/` kept only for the shared-origin demo hub, where root-relative URLs are "documented as unsupported"). [P1, P3]
- **Confidence.** High on the exporter table and the code read; the fix is planned, not verified (the v0.2 code is not written at time of reading).
- **So what.** The CMS-export fixture suite (Recommendation R1) is the acceptance test that item 7 actually delivers "existing sites run unchanged": it must include an Absolute-mode export (same-origin absolute URLs), a Relative-mode export (root-relative) and an Offline-mode export (document-relative with explicit `index.html`), plus a History-API page. Hub shared-origin mode cannot host CMS exports and the docs should say so.

#### F15. Query strings are everywhere in CMS output, and each tool treats them differently
- **Claim.** (1) WordPress core appends `?ver=<version>` to every enqueued stylesheet and script by default (`class-wp-styles.php` `build_src()` line 527, `class-wp-scripts.php` line 523: `$src .= ( str_contains( $src, '?' ) ? '&' : '?' ) . 'ver=' . rawurlencode( $ver_to_add )`) [CODE S29]. (2) Simply Static writes local assets that carry a query to the plain path, never to a hashed directory ("their query strings are usually just for cache busting") [CODE S5]. (3) Tome strips `?...` and `#...` from the output path [CODE S17]. (4) wget `-E` appends `.html` after the query (`article.cgi?25.html`), unix mode keeps `?` in the name, windows mode writes `@` instead [DOC S48]. (5) HTTrack renames `foo.cgi?q=45` to `foo4B54.html` and keeps `?q=45` in the link [DOC S49]. (6) Pagefind requests `pagefind-entry.json?ts=<Date.now()>` (F10). (7) The WordPress default permalink structure is Plain: `http://example.com/?p=N`; "Pretty" and "Almost Pretty" (`/index.php/yyyy/mm/dd/post-name/`) need server rewrite support [DOC S31, updated 2025-06-28]. (8) Simply Static puts other query-string pages under `__qs/<md5[0:12]>/` only when its search-results feature is on, else writes nothing (F3).
- **Confidence.** High (code and manuals).
- **So what.** Path lookup by `pathname` only (what the v0.1 SW does) is the right default, but it creates a staleness risk when a file changes at the same path: `?ver=6.5` becomes `?ver=6.6` after a plugin update while the path stays, and a torrent-served copy would silently outlive the change. The manifest should therefore record the query for each referenced asset (or its version token) and the SW should pass through to the host when a request carries a different `ver` than the one recorded, while still ignoring known throw-away parameters (`ts`, `_`, `utm_*`). Plain-permalink sites (`/?p=N`) cannot be expressed in a static file tree and need a pre-export permalink change plus a redirect table (F18).

#### F16. File names: the torrent path is pasted into a URL unescaped, and three filesystems disagree about what a name is
- **Claim.** `webtorrent@3.0.21` `lib/webconn.js` builds a multi-file web-seed URL as `this.url + '/' + requestedFile.path.replace(this._torrent.path, '')` and passes it to `fetch` with `Range`; there is no percent-encoding [CODE P6]. BEP 19 only says the client appends the torrent `name` and the file path and defines no encoding rules [DOC S39]. Measured with the WHATWG URL parser in Node 24.22 [EXP E5]:
  - `style.css?ver=6.4.2` becomes pathname `/ws/site/style.css`, search `?ver=6.4.2` (a different object is requested);
  - `img#1.png` becomes pathname `/ws/site/img`, hash `#1.png` (the fragment is dropped);
  - `100%.png` and `a%41.png` stay as written, so the server decodes `%41` to `A` (wrong file);
  - `dir\file.png` becomes `dir/file.png`; `a/../b.png` becomes `b.png`; tab and newline are deleted;
  - `caf\u00e9.html` (NFC, one code point) and `cafe\u0301.html` (NFD, `e` plus combining acute) look identical but give different pathnames (`caf%C3%A9.html` versus `cafe%CC%81.html`);
  - `a%2Fb.png` stays encoded in the URL but the SW's `decodeURIComponent` turns it into `a/b.png` (an encoded slash becomes a separator).
- AWS gives the same advice independently: avoid backslash, `%`, `#`, non-printable characters, and note that `?`, `&`, `$`, `@`, `=`, `;`, `:`, `+`, `,` and space "might require additional code handling"; a key is at most 1,024 bytes of UTF-8; period-only path segments are unsafe [DOC S34].
- `create-torrent@6.1.3` `get-files.js` filters directory entries with `notHidden` (`file[0] !== '.'`) and `isNotJunk`: when given a directory path it silently drops `.well-known/`, `.htaccess` and every other dot-entry [CODE P6]. In-memory inputs with explicit paths keep them (the junk filter only removes known junk names such as `.DS_Store`).
- Measured on APFS: NFC and NFD spellings are one file, and case-only differences collide [EXP E3] (F8).
- Reference linter [EXP E6, `pathlint.mjs`]: rejects NFC violations, `? # % \`, control characters, Windows-reserved characters, dot segments, leading or trailing space or dot, segments over 255 bytes, paths over 1,024 bytes, case and normalization collisions, and the reserved magnet-web paths (`_mw/`, `mw-sw.js`, `.mw/`). Run on 19 exporter-style names it rejected 12, including `style.css?ver=6.4.2`, `index.php?p=123.html`, `img/a#b.png`, the NFD twin of `caf\u00e9.html`, and the case twin `img_001.jpg`; it accepted `style.css@ver=6.4.2` (wget windows mode) and `foo4B54.html` (HTTrack), which are legal names that no longer match the URLs in the HTML and so need an alias map.
- **Confidence.** High (code read, parser behaviour measured, AWS guidance agrees).
- **So what.** The publish step must treat file names as a typed, validated alphabet (NFC, no `? # % \`, no controls), keep an alias map from the URL spelling used in HTML (including its query) to the canonical file, and enumerate dot-files itself. The design review's SW rewrite for the drop-in web seed (`/_mw/ws/<name>/<path>`) receives the unescaped string too, so the same rules apply to it.

#### F17. Directory URLs, trailing slashes and `index.html`: hosts, exporters and the SW must agree
- **Claim.** S3 website endpoints return the index document for the root and for any subfolder; for `/photos` without a trailing slash, S3 first looks for an object named `photos`, then for `photos/index.html`, and if found returns `302 Found` pointing to `photos/` [DOC S32]. CloudFront's default root object applies **only** to the root URL: "an end-user request for a subdirectory of your distribution does not return the default root object", and the page contrasts this explicitly with S3 index documents [DOC S33]. So a CMS export (`about/index.html`) behind CloudFront with an S3 REST origin needs a CloudFront Function or similar rewrite (I could not fetch the AWS sample after the search budget ran out; the need is documented, the exact sample is not read). Exporters write `dir/index.html` (Simply Static, Tome). The v0.1 SW resolves `''` or `dir/` to `index.html`, an existing file to itself, and an extensionless miss to `p/index.html` then `p.html`, and answers `dir` with `301` to `dir/` when `dir/index.html` exists [CODE P5]; this addresses the same problem the IPFS SW gateway listed in its epic #31 as "missing trailing-slash normalization for directories (breaks relative links on `index.html` pages, #62)" (wave-1 doc 04). v0.2 moves these switches into the routing manifest (`cleanUrls`, `trailingSlash`) [P1].
- **Confidence.** High.
- **So what.** Emit the manifest's `cleanUrls` and `trailingSlash` from the observed export (Simply Static and Tome: directory style with trailing slash; offline mode: explicit `index.html`), and put the CloudFront rewrite into DEPLOY.md so the host copy and the torrent copy answer the same URLs.

#### F18. Redirects: `_redirects` is a de-facto format, with different semantics per host
- **Claim.** Cloudflare Pages: `[source] [destination] [code?]`, default 302, codes 301/302/303/307/308 (and 200 for proxying), up to 2,000 static plus 100 dynamic redirects (2,100 total), 1,000 characters per rule, **no query-string matching**, "Redirects ... always applied" even when a static asset matches, not applied to Pages Functions [DOC S36, S35]. IPFS gateways (web-redirects-file spec): same line shape but default 301, supports 200, 301, 302, 303, 307, 308, 404, 410, 451; rules are evaluated "only if the requested path is not present in the DAG"; file at most 64 KiB; custom 404 via a `404` rule [DOC S38]. GitHub Pages' limits page does not mention redirect or header files [DOC S37]. The Simply Static manifest records redirects with `type: redirect` and `redirect_target`; the plugin exports rules from Redirection, Yoast, Rank Math, Safe Redirect Manager and Page Links To (changelog) [CODE S5].
- **Confidence.** High.
- **So what.** A WordPress site with a redirect plugin can exceed Cloudflare's 2,100-rule ceiling, and the two semantics differ on "force": `publish` should emit the routing-manifest redirects with an explicit `force` flag and a host-specific `_redirects`, warn when a rule cannot be expressed (query matching, over limits) and say that such rules live only in the SW (so crawlers and no-JS clients do not get them).

#### F19. Mixed content and dead or third-party endpoints in exported HTML
- **Claim.** MDN (current categories): "upgradable" content (`<img src>`, CSS image properties, `<audio src>`, `<video src>`, `<source>`) is auto-upgraded from HTTP to HTTPS; everything else is "blockable", explicitly including `<img>` set via `srcset` or `<picture>`, all CSS `url()` uses (`@font-face`, `cursor`, ...), `<script>`, `<link>`, `<iframe>`, `fetch()` and XHR; and "Mixed content requests that would otherwise be upgraded are blocked if the URL's host is an IP address" [DOC S44]. WordPress core ships these third-party or origin-dependent defaults: emoji images from `https://s.w.org/images/core/emoji/17.0.2/72x72/` and `.../svg/` (filterable), `<link rel="https://api.w.org/" href="<rest root>">` in `<head>`, `wpApiSettings.root = get_rest_url()` and `ajaxurl` in inline scripts, a comment form whose action is `site_url('/wp-comments-post.php')`, and a search form `GET home_url('/')` with input `s` [CODE S29]. Simply Static's own changelog shows origin hosts leaking into inline scripts and form actions (F3).
- **Confidence.** High.
- **So what.** The audit stage should fail on: any `http://` URL, any URL whose host is an IP or `localhost`, any absolute URL on a hostname that is not the final domain or an allow-listed third party, `srcset` entries with `http:` (the case browsers do not upgrade), and report third-party hosts (including `s.w.org`) so the owner can vendor them. The normalize stage removes `api.w.org`, `xmlrpc`, `wp-json` links and dead form actions, or replaces them with SDK hooks.

---

### Part D - Size, media, metadata and re-export deltas

#### F20. What a real CMS site weighs, and what that does to the v0.2 size caps
- **Claim.** HTTP Archive Web Almanac 2025 (data to July 2025, published 2026-01-15): median home page 2,862 KB desktop and 2,559 KB mobile; by type (mobile / desktop): HTML 22 / 22 KB, CSS 77 / 82 KB, fonts 122 / 139 KB, JavaScript 632 / 697 KB, images 911 / 1,059 KB (about 36 to 37 % of bytes, [DERIVED]), video 384 / 247 KB (the text says 315 KB; the chapter is internally inconsistent in places); 72 to 80 requests per page; median single image 8 KB. WordPress median mobile page 2,894 KB (JavaScript 638 KB, CSS 119 KB); Squarespace is the heaviest at 3,974 KB [DOC S51]. WordPress core registers these image sizes for every upload: thumbnail 150x150 (cropped), medium 300x300, medium_large 768 wide, large 1024x1024, plus `1536x1536` and `2048x2048` (`media.php` lines 5870 and 5872; defaults in `schema.php`), and since 5.3 images beyond the big-image threshold (2560 px) get a scaled copy while the original is kept (make.wordpress.org, 2019-10-09, OLD) [CODE S29, DOC S30]. A photo large enough for every size therefore yields up to 8 files (original, `-scaled`, six sub-sizes) [DERIVED]; `max_srcset_image_width` defaults to 2048, so `srcset` lists most of them and a crawl-based export includes them.
- **Against the caps.** v0.2 default `maxSiteBytes` is 128 MiB desktop, 48 MiB mobile Wi-Fi, 24 MiB cellular [P1 line 494]. With the median page at about 2.6 to 2.9 MB, 50 pages that each carry 1 MB of unique images already weigh about 50 MB and 200 such pages exceed the desktop cap (illustrative arithmetic, not a measurement of any site). A crawl-based exporter includes only referenced files (Simply Static's own docs: an unlinked file "will not have a chance to be picked up", S4); copying `wp-content/uploads` wholesale includes every size of every upload, including files no page references.
- **Confidence.** High for the numbers quoted; the site-size illustration is arithmetic on stated assumptions.
- **So what.** (1) Publish from the crawl, not from the uploads directory. (2) A single all-or-nothing torrent that must fit `maxSiteBytes` will exclude most real WordPress sites; the publish step needs a P2P set that is a subset of the site (F23).

#### F21. Torrent metadata grows linearly with file count and must be bootstrapped over HTTP above a few hundred files
- **Measured [EXP E1]** with the project's `create-torrent@6.1.3` on synthetic WordPress-style paths (95 % uploads sub-size names, 4 % post pages, 1 % theme assets), `announce: []`:

| Files | Site size | Piece size | `.torrent` size | of which piece hashes | `ut_metadata` 16 KiB blocks |
|---|---|---|---|---|---|
| 1,000 | 215 MiB | 256 KiB | 97 KB | 17 KB | 7 |
| 5,000 | 1,054 MiB | 256 KiB | 485 KB | 82 KB | 31 |
| 10,000 | 2,125 MiB | 256 KiB | 971 KB | 166 KB | 61 |
| 20,000 | 4,236 MiB | 256 KiB | 1,941 KB | 331 KB | 122 |
| 50,000 | 10,708 MiB | 256 KiB | 4,864 KB | 837 KB | 304 |
| 20,000 | 4,236 MiB | 16 KiB | 6,906 KB | 5,295 KB | 432 |

The file list costs about 82 bytes per file with these path lengths (81 KB per 1,000 files); each piece costs 20 bytes. The auto piece length of `piece-length@2.0.1` is `max(16384, 2^round(log2(bytes/1024)))` capped at 4 MiB by `create-torrent` (`maxPieceLength`), i.e. about 1,000 pieces per torrent [CODE P6]; the project fixes 256 KiB (ARCHITECTURE section 10), which is why it stays small.
- **Protocol limits [CODE P6, DOC S41].** BEP 9 moves the info dictionary in 16 KiB blocks. `ut_metadata@5.0.1` requests **all** blocks at once (`_requestPieces` loops over every piece) and rejects any peer advertising `metadata_size` above `MAX_METADATA_SIZE = 1E7` (10 MB) with "Peer gave invalid metadata size"; BEP 9 allows peers to rate-limit requests ("flood protection"). The `xs=` path (`_getMetadataFromServer`) is an ordinary HTTP GET of the `.torrent` with an infohash check and no such cap, and webseeds attach only after metadata exists (also confirmed in wave-1 doc 01 F10).
- **Confidence.** High (measured, code read).
- **So what.** Treat `xs=` as mandatory for any site above roughly 500 files or 64 KB of metadata (v0.2 already adds `xs` whenever `--ws` or `--dropin` is given), cap the file count in `publish` (warn at 5,000, fail at 20,000 unless overridden: that is also Cloudflare Pages' free ceiling, F24), and note the hard 10 MB info-dict ceiling for peer-only bootstrap (roughly 100,000 files at 256 KiB). Pagefind adds about one file per indexed page plus a few dozen chunks (F10; w2a-03 measured over 200 files for 168 to 194 pages), which matters for a page-heavy site that is near the limits.

#### F22. Re-export deltas: file-granular reuse works with today's WebTorrent, ordering is second-order, padding is a net loss
- **Setup [EXP E2].** Synthetic site v1: 2,428 files, 141.0 MiB (400 post pages of 10 to 120 KiB, 14 home/archive/feed/sitemap/category pages, 60 CSS/JS files, 1,500 images, 20 fonts, 434 Pagefind-style files, 432 of them with hashed names). v2 is a typical "publish one post" re-export: 1 new post, 3 new images, regenerated home/archives/feed/sitemap/category pages, one old post edited by +37 bytes, regenerated search index with renamed hashed files: 2,433 files, 141.3 MiB. The file-level change (new plus changed files) is 858 KiB.
- **Result (256 KiB pieces; piece sizes 64 KiB and 16 KiB behave the same, see `results_reuse.txt`).** "Same-index reuse" counts v2 pieces identical to the v1 piece at the same index (what you would keep if the old store is simply re-used); "file-prefill reuse" counts v2 pieces that verify when the loader copies every unchanged file to its new offset in an otherwise empty store and lets WebTorrent hash-verify (what a loader that keeps per-file Blobs, as `cache.js` does, can do).

| Layout of v2 | Same-index reuse | File-prefill reuse | Download needed (file-prefill) | Overhead |
|---|---|---|---|---|
| A. path-sorted (ARCHITECTURE section 10 as written) | 6.9 % | 97.9 % | 3.0 MiB | none |
| B. grouped by class (media, code, search, html, volatile) | 74.0 % | 98.1 % | 2.75 MiB | none |
| C. generational (unchanged files first in old order, changed and new files last) | 80.6 % to 86.7 % (depends on whether the search index sorts before or after the HTML) | 99.1 % | 1.25 MiB | none |
| F. path-sorted with BEP 47 padding at every file boundary | 16.0 % | 99.2 % | 5.0 MiB | 481 MiB of padding (+341 %) |

(At 64 KiB pieces: A 1.5 MiB, C 0.94 MiB, F 1.5 MiB with 93.4 MiB of padding; at 16 KiB: A 1.03 MiB, C 0.86 MiB, F 1.02 MiB with 20.4 MiB of padding.)
- **Real-client check [EXP E4].** `webtorrent@3.0.21` in Node, `client.add(torrentFile, { preloadedStore, skipVerify: false })` with a `memory-chunk-store` pre-filled file-by-file from v1: 227 of 231 pieces (98.3 %) were already verified when `ready` fired, 4 pieces (0.25 MiB) missing for a 129 KiB file-level change. `torrent.downloaded` reports the verified bytes (14.9 MB), so UI progress must come from the bitfield, not from that counter. This ran in Node; the in-browser store (IndexedDB-backed) and verification time on a phone were not measured.
- **Related API [CODE P6].** `opts.bitfield` (a startup bitfield of `ceil(pieces/8)` bytes) makes `_verifyPiecesUsingBitfield` trust the bitfield and spot-check about one piece per file, which would let the loader mark pieces inside unchanged files as present from `files.json` hashes without re-hashing everything (not exercised here).
- **Confidence.** High that the mechanism works and for the measured ratios; the absolute numbers depend on the synthetic site (media-heavy, uniform random content).
- **So what.** (1) DESIGN-REVIEW 3.4.5 already says a new version is filled "from the previous version in IndexedDB (same path and same SHA-256)"; this is the evidence that it works and a warning against the alternative designs: do not use padding files; do not depend on piece-index equality. (2) Keep deterministic path-sorted ordering for reproducible infohashes (wave-1 doc 01 F22) unless measurements on a real site show the boundary cost matters: class or generational ordering saves 1.5 to 2 MiB in this example, which is real on cellular but does not change the architecture. (3) The pieces that cannot be reused are the boundary pieces around every changed file, so smaller pieces (64 KiB) halve that cost at the price of 4 times the piece-hash bytes (F21 table).

#### F23. Partial P2P sets are already possible in WebTorrent 3.0.21 and are needed in v1 for CMS sites
- **Claim.** By default the whole torrent is selected at metadata time (`this.select(0, this.pieces.length - 1)`) unless `client.add(id, { deselect: true })` is given; `File.select(priority)` and `File.deselect()` exist; reading a file through `arrayBuffer({start,end})`, `stream()`, `createReadStream()` or the async iterator drives a `FileIterator` that fetches the needed pieces; BEP 53 `so=` (select only) is implemented [CODE P6]. DESIGN-REVIEW lists "Streaming media before the download completes; partial copies that seed only viewed files" under LATER / v2 [P3 section 3], and ARCHITECTURE v0.2 section 5.4 downloads the whole torrent into a `MemoryChunkStore`, builds each file's Blob on `file.on('done')`, enforces `maxSiteBytes` as `E_TOO_LARGE` when metadata arrives, and mounts only after every file is done (so the full site must also fit in memory during the first download).
- **Why v1 needs a minimal form.** F20 (sites exceed the caps), F21 (file-count budget), F24 (hosts cap file count and size) and Cloudflare Pages' 25 MiB per-file limit all push the same way: the torrent should contain what benefits from peers (CSS, JS, fonts, the images that pages actually use, search index), and large or rare media (video, audio, archives, big PDFs) should stay HTTP-only on the host. This needs no lazy fetching: a `p2p` flag per file in `files.json` and a torrent built from the flagged files only.
- **Confidence.** High on the API; the policy is a recommendation.

---

### Part E - Hosts, crawlers, platforms, precedents, re-export workflows

#### F24. The static host that serves the web seed and the crawler fallback has hard ceilings
| Host | Limit that matters for a CMS export | Source |
|---|---|---|
| Cloudflare Pages | 20,000 files per deployment on Free, 100,000 on Pro/Business/Enterprise (needs `PAGES_WRANGLER_MAJOR_VERSION=4`); 25 MiB per asset; builds 500/month on Free (1 concurrent), 20 minute build timeout; `_redirects` 2,000 static + 100 dynamic; `_headers` 100 rules, 2,000 characters per header; Workers static assets: up to 100,000 files each | S35 [DOC, no date] |
| GitHub Pages | published site at most 1 GB; source repo recommended at most 1 GB; soft 100 GB/month bandwidth; soft 10 builds/hour (not for custom Actions workflows); deployment times out after 10 minutes; no per-file maximum stated; redirect and header files not mentioned | S37 [DOC, no date] |
| Amazon S3 | key at most 1,024 bytes of UTF-8; website endpoint serves `index.html` for the root and subfolders and answers `/photos` with `302` to `photos/` | S32, S34 [DOC] |
| CloudFront in front of S3 | default root object applies only to the root URL; subdirectory index needs a function or the website endpoint | S33 [DOC] |
- **Derived [DERIVED].** 20,000 files / 8 files per full-size photo = 2,500 photos (fewer if the Pagefind index adds one fragment per page); the free tier of the most convenient host stops fitting a photo-heavy WordPress site long before the site is large in bytes.
- **Confidence.** High (current vendor documentation; Cloudflare's page prints no date).
- **So what.** `publish` should compute file count, largest file and total bytes, compare them with the chosen host profile, and say which tier or host fits. The web seed in drop-in mode is the site's own origin (ARCHITECTURE 3.4.7), so the host must hold the entire site, not just the P2P set.

#### F25. Crawlers, unfurlers and crawl-validated checkout see only what the host sends
- **Google.** "Google Search runs JavaScript with an evergreen version of Chromium", renders later in a headless Chromium, "can only see content that's visible in the rendered HTML", and recommends server-side or pre-rendering because "not all bots can run JavaScript" [DOC S45]. The rendering service is stateless ("HTTP Cookies are cleared across page loads", Local and Session Storage likewise, "WRS does not retain state across page loads"), declines permission requests, may ignore caching headers, and "does not support other types of connections" such as WebSockets or WebRTC [DOC S46]. Neither page mentions Service Workers, so nothing is documented about them; the practical reading is that a page cannot rely on state or a worker from an earlier load. (Not independently tested.)
- **Meta.** The crawler reads title, description and thumbnail and requires "Open Graph properties ... before the first 1 MB of your website", honoring or ignoring a `Range` header; the page does not say whether it runs JavaScript [DOC S47].
- **Snipcart.** Plain, cookie-less `GET` of `data-item-url` before each order; HTML parsed for the buy button; one redirect hop; JSON alternative (F13) [DOC S27].
- **Design consequence.** ARCHITECTURE v0.2 3.4.8 already says it: drop-in keeps every file at its URL on the host, so crawlers, unfurlers and no-JS clients see today's site; shell mode answers every URL with the shell, so they see no content. [P1 3.4.8]
- **Confidence.** High on the vendor statements; Service Worker behaviour of Googlebot is undocumented.
- **So what.** Put this in the compatibility matrix: shell mode is for P2P-first sites that do not depend on search traffic, social previews or crawl-validated checkout; migrating an existing CMS site that has any of those should use drop-in.

#### F26. Where the script tag can go, and where a root-scope Service Worker cannot
- **Rule.** A Service Worker "can't have a scope broader than its own location, unless the server specifies a broader maximum scope in a `Service-Worker-Allowed` header on the service worker script"; without the header, registration with a broader scope fails [DOC S43]. v0.2 therefore ships `/mw-sw.js` at the origin root because static hosts cannot send that header [P1 3.4.2].
- **Per platform.**
  - Self-hosted WordPress and Drupal: files can be placed in the web root; the pointer meta can be stamped at export time (drop-in) or output by a small plugin or theme hook for live sites. Not tested.
  - WordPress.com: Simply Static requires the Business plan or higher (S1 FAQ); whether a root-path file can be served there is unverified.
  - Ghost: Settings > Code Injection has a Site Header and Site Footer (output in `<head>` and before `</body>`) and per-post injection [DOC S13, undated]; which Ghost(Pro) plans include it, and whether Ghost(Pro) can serve `/mw-sw.js` from the root, are unverified. Self-hosted Ghost behind a reverse proxy could add a root location (inference, not tested).
  - Squarespace: code injection on Core, Plus and Advanced; "Squarespace doesn't support server-side code"; JavaScript in code blocks on the same plans [DOC S19, updated 2026-08-27]. Whether a root-path file can be served is unverified.
  - Wix and Webflow: not researched at primary level.
- **Confidence.** High on the rule; Low on the per-platform ability to serve a root file (absence of evidence).
- **So what.** The honest compatibility statement is: drop-in needs the owner to control the origin root (or a CDN in front of it). A site on a hosted builder either exports to a host the owner controls, or cannot use drop-in at all. Do not promise "paste one script tag into Squarespace/Wix/Ghost(Pro)" until a test proves the root-scope worker can be served there.

#### F27. Precedents worth borrowing from
| Precedent | What it shows | Use for | Source |
|---|---|---|---|
| Simply Static Pro | The market bundles incremental push, forms, Fuse.js/Algolia search, comments integration, redirects and a deploy manifest as the paid layer of a static export | Define our boundary: P2P delivery of the static output; search, forms, comments as optional modules | S2, S5 |
| StaticGhost | A CMS-to-static tool that ships Pagefind, Giscus and build-time AES-256 for protected posts, and tells you to use third parties for Portal and media-heavy sites | Same module choices, same honesty about what is lost | S10 |
| `_redirects` in Cloudflare Pages and IPFS gateways | One file name and line grammar already honoured by two unrelated hosts, with different semantics (always applied versus only when missing) | Emit one `_redirects` plus an explicit routing manifest; document the semantic split | S36, S38 |
| Tome `cache.tome_static` | A built-in "skip what did not change" crawl keyed on cache tags | Exporter-level incremental mode where available; otherwise diff by hash | S16 |
| ZeroNet | Owner-signed `content.json`, files fetched from BitTorrent peers, user-generated content; original abandoned, fork struggling, "no reliable spam protection" | Cautionary precedent for ledger-backed comments: ship moderation and quotas first | S53 |
| IPFS Service Worker Gateway (wave-1 doc 04) | SW serving content-addressed sites, `_redirects` support, subdomain origin isolation, trailing-slash issues | Already incorporated into v0.2 | P4 |

#### F28. Incremental re-export workflows and the determinism check
- **What exporters offer.** Simply Static Pro: "Changes Only" (update pages and files changed since the last push), "Single Push" (one page from the editor), `GET /unpushed-changes`, and a manifest with per-URL `content_hash` [S1, S2, S5]. Staatic: change-based publications and scheduled publications are Premium; the Community edition re-crawls [S6]. Tome: skips cached paths [S16]. Ghost Static Site Generator regenerates the whole site (wget-based) [S9]. A forum post claims webhook-driven incremental Ghost builds (SnapStatic, since abandoned) [S11].
- **What they do not offer.** A portable, exporter-independent notion of "changed" that also covers the files the P2P layer needs (hashes of every file, sizes, MIME types). v0.2 defines `/.mw/files.json` with SHA-256 per file for exactly this [P1 3.4.1].
- **Risk (not verified).** Re-exports are only cheap if unchanged inputs give byte-identical outputs. I found no source showing whether Simply Static, Staatic, Tome or gssg output is deterministic (embedded timestamps, nonces, random ids); the vendors' own `content_hash` fields suggest they rely on it for their own change detection. Test by exporting twice without changes and diffing.
- **Workflows.**
  1. WordPress, manual: edit -> Simply Static export (Pro: Changes Only) to a local directory -> `publish --dropin` -> upload non-HTML first, HTML last -> switch pointer (v0.2 deploy order) -> keep the previous version's files for at least 7 days.
  2. WordPress, CI: WordPress runs on a staging origin the owner controls; a CI job triggers the export (WP-CLI or REST), reads `exports/latest`, runs the pipeline, deploys. Not tested.
  3. Ghost: webhook on publish -> exporter (Content API or gssg) -> pipeline.
  4. Drupal: `drush tome:static --uri=https://example.com` in CI -> pipeline.
- **Confidence.** High on the feature list; Low on determinism.

#### F29. Cross-checks against the other wave-2A documents (state of the files on 2026-10-17; two were still being written)
- **w2a-01 (site generators, interim draft).** An independent lab with real builds of nine generators in Chromium 156 reports that almost every generator emits root-absolute URLs by default and that the prefix design (`/_mw/s/<btih>/...`) renders a working page for 3 of 9 default builds, while same-URL dispatch passed home render, client navigation and deep links for every default build. This is the same conclusion as F14 reached from the CMS side: root-absolute support is a compatibility requirement for the whole product, not for WordPress alone. It also reports that a site's own Service Worker cannot register under the loader, which matches DESIGN-REVIEW 3.4.4 for drop-in mode.
- **w2a-03 (dynamic-feature catalogue, partial).** Agrees on: Pagefind as the search answer (F10), Stripe Payment Links and Buy Button plus the Snipcart crawl needing host-served product pages (F13), media needing correct `206` slicing and lazy files (F23). **Differs on forms:** it advises against sealed inboxes on the ledger for legal reasons (F12), and I changed R13 accordingly. It also measures block sizes (a 200-character comment is 701 to 1,170 bytes), which supports keeping legacy comments out of the ledger (F11).
- **w2a-05 (SEO and crawlers).** Same verdict as F25 with far more detail (Googlebot's 2 MB HTML limit, Apple Messages, Slack, AI crawlers, back-button-hijacking policy, soft-404 traps on static hosts); read it for crawler specifics, and treat F25 here as the migration-side summary. Its conclusion that embedded (drop-in) mode is the only SEO-safe production mode matches the CMS recommendation in R10.
- **w2a-06 (CI/CD).** A 501-byte placeholder at the time of reading; nothing to cross-check.
- **Confidence.** Medium: the siblings' numbers were not re-verified by me.

---

## Migration recipes per CMS

Every recipe ends in the same place: a directory of static files plus an optional exporter manifest, which then goes through the pipeline in the next section. "Verified" means the step is backed by a source read in this run; "not run" means standard practice that I did not execute. In every case the CMS stops being the production origin and becomes the owner's private authoring and build tool: someone still has to run WordPress, Ghost or Drupal somewhere the exporter can reach (or use a managed option such as Simply Static Studio at $12/month per site, S1).

### WordPress (39.6 % of sites) - four paths, in order of preference
**A. Simply Static (recommended).**
1. Work on a staging copy the owner controls. Settings > Permalinks: use a Pretty structure; Plain `/?p=N` is WordPress's default and is not exported (F3, F15, S31). If the live site used Plain, record every old `?p=N` and its new URL for the redirect table (the SW can match query strings; Cloudflare `_redirects` cannot, F18).
2. Simply Static > General > Replacing URLs: **Absolute**, scheme `https://`, host = the production domain (its docs recommend this for a site on its own domain; Relative breaks Open Graph, canonical and sitemap URLs; Offline "is meant for local previewing or archiving, not for publishing") [S3, verified].
3. Include list: `/robots.txt`, the 404 export (REST route `export-404`), unlinked PDFs and uploads (Additional Files & Directories); for page-builder background images add the documented `ss_match_tags` filter [S4, verified].
4. Export to a local directory (free) or ZIP; Pro adds "Changes Only" pushes and direct deployment (S1, S2).
5. Read the manifest: `GET /wp-json/simplystatic/v1/exports/latest` as an administrator (`manage_options`): per-URL `static_path`, `type`, `status_code`, `content_hash` (`sha1:`), `redirect_target` [S5, verified in source; not run against a live site].
6. Run the pipeline (audit, normalize, enhance, package, verify, deploy).
- **Lost or changed.** WooCommerce, Easy Digital Downloads, MemberPress, Restrict Content Pro, bbPress, BuddyPress are incompatible (S1); search (`?s=`), comment form, contact forms, REST API, oEmbed, login (F9).
- **Needs a decision.** Page builders (about 60 % of WordPress sites; Elementor 43 %, S51): check the audit report for CSS-background images and JS-built URLs (S4 is silent on JS-built URLs).

**B. Staatic.** Crawls "like a visitor" from the front page or a Custom Origin URL; Community edition covers redirects, 404 pages, headers, additional URLs; forms, search, scheduled and change-based publications are Premium; default publication time limit is 4 hours (raise it for large sites) [S6]. URL rewriting is not described in the plugin page, so the audit stage is mandatory.

**C. Mirror fallback (no plugin possible, for example WordPress.com below the Business plan).** `wget --mirror` is only `-r -N -l inf --no-remove-listing`; add `--page-requisites` and `--convert-links`, and decide on `--adjust-extension` knowing it appends `.html` after a query (`article.cgi?25.html`) [S48]. Run on Linux, not on a default macOS volume (F8, E3), then normalize names (F16). Not run here.

**D. Keep WordPress dynamic and add drop-in on top (proposal, untested).** Build the P2P set from a crawl of the referenced static assets only (never the raw `uploads` directory), stamp the pointer into every HTML response with a small plugin, and record each asset's `?ver=` so a plugin or theme update does not leave stale torrent copies (F15). Use only when the site cannot go static (a shop, a membership site). HTML and all dynamic endpoints stay on WordPress, so only subresources are peer-delivered.

### Ghost (0.1 % of sites)
1. Choose an exporter: `ghost-static-site-generator` (wget-based; run against the local Ghost with `--domain http://localhost:2368 --productionDomain https://example.com --dest static`; tested on Ghost 4.48.2; Casper-centred) or a Content-API exporter (StaticGhost: needs an API key; ships Pagefind and Giscus) [S9, S10]. Both churn with Ghost releases (6.71.0 on 2026-10-15; SnapStatic quit citing that cost, S11, S14).
2. Set Private Site Mode on the origin to avoid duplicate content [S12]. Remember `?limit=all` is gone in Ghost 6 (max page size 100) if you write your own exporter [S12].
3. Replace Portal signup with a third-party embed, search with Pagefind, comments with Giscus or ledger comments [S10, S12].
- **Lost.** Members, paid subscriptions, gating, native comments, analytics, offers, trials: "Ghost must be used with its frontend layer" [S12].
- **Live-Ghost drop-in.** Settings > Code Injection takes the script tag [S13]; serving `/mw-sw.js` from the root on Ghost(Pro) is unverified (F26).

### Drupal (0.6 % of sites)
1. Tome static export with `drush tome:static` (the `--uri` option sets the site URL; per search snippet, not run); output defaults to `../html` (`tome_static_directory`) [S16, S17].
2. Only anonymous-accessible routes and entities are exported; non-200 responses are not written, so there is no 404 page unless you add one; paths without an extension become `path/index.html`; query strings are stripped from file names; `cache.tome_static` skips unchanged paths [S16, S17].
3. Lost: Drupal search, Webform and other forms, user login, anything personalised. Tome is "Minimally maintained" (8.x-1.16, 2026-07-09) [S15].

### Squarespace (2.4 % of sites) - content migration, not export
1. Export from the Import & export panel (WordPress icon): one XML with layout pages, one blog (up to 1000 comments per post), text and image blocks, gallery pages; no store, album, cover, index, info, calendar or portfolio pages, no extra blogs, no audio, video or product blocks, no drafts, styles or custom CSS [S18, verified, updated 2026-10-09].
2. Download images yourself before the subscription ends (imported images can remain hotlinks) [S18].
3. Convert the XML to Markdown or import into WordPress, pick a theme, then follow the WordPress or static-generator path. Comments in that XML carry the same email and IP fields as any WXR (F11).
- **Do not** mirror a live Squarespace site with wget or HTTrack and expect it to work: "Many features rely on our platform's JavaScript and CSS" [S18]; third-party mirrors depend on platform scripts and CDNs (not tested).

### Wix (4.2 % of sites) - rebuild
No official code export found; blog posts as XML and Stores products as CSV per secondary sources; third-party crawlers produce a non-interactive snapshot and may conflict with Wix's terms (unverified wording) [S21]. Recommendation: rebuild content in a static generator; treat any crawler output as a one-off archive.

### Webflow (0.8 % of sites)
Code export (paid Workspace plan) yields HTML, CSS, JavaScript and assets; CMS content and collection pages, ecommerce, user accounts, localization, site search, forms and password protection do not carry over (snippets of the official help center; page itself not read) [S20]. Export CMS items separately and rebuild collection pages with a static generator; replace forms and search with the F10 and F12 modules.

### Not researched
Shopify (5.3 %), Joomla (1.1 %), Tilda, Duda, Blogger, GoDaddy Website Builder: no source read. Say "not supported" until someone checks.

---

## The migration pipeline (proposal)

| Stage | What it does | Findings behind it | Gate |
|---|---|---|---|
| 1. Export | CMS-specific adapter produces a directory plus, where available, a manifest (Simply Static) | F2 to F8 | Exporter finished; manifest saved |
| 2. Audit | Crawl the staged directory offline: absolute URLs by host, `http:` URLs, IP/localhost hosts, `srcset` with `http:`, dead endpoints (`wp-json`, `xmlrpc`, `wp-comments-post.php`, `?s=`), third-party hosts (including `s.w.org`), query-bearing asset URLs, missing 404 page, case or NFC collisions | F14, F15, F16, F19 | No blocking finding |
| 3. Normalize | Apply the file-name policy (alias map), rewrite or strip what the audit flagged, vendor chosen third-party assets, strip PII from imported comments, secrets lint, exclude unreferenced uploads | F11, F16, F19, F20 | Idempotent: a second run changes nothing |
| 4. Enhance | Pagefind index; comments archive; forms and search shims; `robots.txt`, `sitemap.xml`, `404.html` if absent | F10 to F13 | Search returns a known page offline |
| 5. Package | `files.json` (path, size, SHA-256, MIME, `p2p` flag, recorded query/version token), routing manifest from `_redirects` and CMS redirects, torrent from the P2P set, `xs` URL, pointer | F18, F21, F22, F23 | Budgets met (files, metadata, per-file size, bytes) |
| 6. Verify | No-JS parity (host copy equals torrent copy byte for byte), web-seed probe, determinism check (export twice, diff), delta report against the previous version | F22, F25, F28 | Zero unexplained differences |
| 7. Deploy | Upload non-HTML first and HTML last, run the probe, switch the pointer, keep the previous version's files at least 7 days (ARCHITECTURE v0.2) | F17, F24 | Probe passes |

---

## Concrete recommendations for magnet-web

Priorities: **P0** before anything is called production-ready or "migrates existing sites"; **P1** next; **P2** after; **P3** optional. Effort: **S** under a day, **M** one to three days, **L** a week or more. "Where" names the plan item or module it extends.

| ID | Pri | Eff | What to build or change | Why (findings) | Where |
|---|---|---|---|---|---|
| R1 | P0 | M | **CMS-export fixture suite** as the acceptance test for "existing sites run unchanged": four fixtures generated from real exporter output (Simply Static Absolute, Relative, Offline; Tome-style `dir/index.html`) plus `?ver=` assets, trailing-slash and clean-URL variants, a 404 page, `.well-known/`, a History-API page, Pagefind files. Run each in shell and drop-in mode. | F14, F15, F17, F10 | DESIGN-REVIEW items 7 and 23; `test/e2e` |
| R2 | P0 | S | **File-name policy in `publish`** (start from `docs/research/labs/w2a-02-experiments/pathlint.mjs`): NFC only; reject `? # % \`, control and Windows-reserved characters, dot segments, leading or trailing space or dot, segments over 255 bytes, paths over 1,024 bytes, case and normalization collisions, reserved paths (`_mw/`, `mw-sw.js`, `.mw/`); keep an alias map from the URL spelling in HTML (with query) to the canonical file; enumerate dot-files explicitly (the `create-torrent` directory walker drops them). | F16 | `tools/publish.mjs`; `/.mw/site.json` aliases |
| R3 | P0 | S | **Budget gates in `publish`**: file count (warn 5,000, fail 20,000 unless overridden), metadata size (warn 1 MB; note the 10 MB `ut_metadata` ceiling), largest file (25 MiB for Cloudflare Pages), total bytes against `maxSiteBytes`; always set `xs` above about 500 files; print the host profile that fits. | F21, F24 | `tools/publish.mjs`; DEPLOY.md |
| R4 | P0 | S | **Publish only from a crawl allowlist; lint for secrets and PII**: refuse `wp-config.php*`, `.env`, `.git/`, `*.sql`, backup archives; warn on files in `wp-content/uploads` that no page references; strip `comment_author_email` and `comment_author_IP` from any imported WXR. Publication in a torrent is not reversible once peers hold copies. | F3, F11, F20; DESIGN-REVIEW item 21 | `tools/publish.mjs`; importer |
| R5 | P1 | M | **`p2p` flag per file** in `/.mw/files.json`; build the torrent from flagged files only; default policy: never P2P for video, audio, archives and anything over 25 MiB; fill the rest by budget; non-P2P files fall through to the host. Pull this minimal part of the "partial copies" idea forward from v2. | F20, F23, F24 | ARCHITECTURE 3.4; `publish --dropin` |
| R6 | P1 | M | **Delta update by file-granular prefill**: when a newer version of a site is fetched, build the store for the new torrent from the old version's per-file Blobs matched by path and SHA-256, optionally pass a startup `bitfield` for pieces inside unchanged files, let WebTorrent verify, and download the rest. Do not add BEP 47 padding. Drive progress from the bitfield. Keep path-sorted deterministic ordering unless a real-site measurement justifies class grouping. | F22 | ARCHITECTURE 3.4.5; `torrent.js` |
| R7 | P1 | S | **Query policy**: match by pathname; record the version token (`ver`) for assets referenced with one and pass through to the host on mismatch; ignore `ts`, `_`, `utm_*`; set Pagefind `metaCacheTag` to the site version. | F15, F10 | `sw/core.js`; `/.mw/site.json` |
| R8 | P1 | M | **Search module**: `publish --search` runs Pagefind on the staged directory before packaging; SDK sets `baseUrl: "/"`; document the file-count cost; ship a shim that turns a legacy `form[role=search] input[name=s]` submit into a Pagefind results view. | F10 | `publish`; `src/dropin/mw.js` |
| R9 | P1 | M | **WordPress adapter**: read the Simply Static `exports/latest` manifest (static path, type, status, `sha1` content hash, redirect target) to seed `files.json`, redirects and the audit; fall back to the crawl-based audit for Staatic and mirrors. | F3 | `tools/migrate/wordpress.mjs` |
| R10 | P1 | S | **Compatibility matrix and per-CMS recipes in the user docs**: the F9 table and the recipes above; explicit verdicts "re-platform first" for Squarespace, Wix, Webflow CMS; "shell mode is invisible to crawlers, unfurlers and crawl-validated checkout"; "run mirrors on Linux". | F6, F7, F9, F25, F26 | README, DEPLOY.md, CRITIQUE.md |
| R11 | P1 | S | **Host profiles in DEPLOY.md**: S3 website endpoint versus CloudFront (the default root object does not apply to subdirectories; add a function), Cloudflare Pages and GitHub Pages ceilings, and the `_redirects` semantics split (always applied versus only when missing; query matching unsupported; 2,100-rule cap). | F17, F18, F24 | DEPLOY.md |
| R12 | P2 | M | **Comments module**: `mw comments import <wxr>` writes `comments/<slug>.json` (sanitized HTML, parent ids, no email, no IP) into the torrent; the SDK merges that static list with the ledger list for new comments; document the 2 KiB value and 8 MiB ledger limits. | F11 | SDK; tools |
| R13 | P2 | S (M for the optional sealed inbox) | **Forms module**: default path is a third-party relay or `mailto:` (keep third-party `action` URLs working and tell the owner which `form-action` CSP to add); optional, off by default: `data-mw-form` encrypts to the owner key (ephemeral ECDH P-256, HKDF-SHA256, AES-GCM, HPKE-shaped) and appends to a ledger list, with an owner inbox, about 1.4 KB plaintext at current limits, and a legal note (w2a-03 on EDPB 02/2025). | F12 | SDK; owner UI |
| R14 | P2 | S | **Commerce presets**: CSP snippets for the Stripe buy button (`script-src` and `frame-src https://js.stripe.com`), Payment Links recipe, and the Snipcart caveat (needs host-served product HTML or a JSON endpoint). | F13 | DEPLOY.md |
| R15 | P2 | M | **Other adapters**: Ghost (gssg or Content API), Drupal (Tome), Squarespace (XML to Markdown), Webflow (code export); each a thin script plus a recipe. | F4 to F7 | `tools/migrate/*` |
| R16 | P2 | S | **Normalize options**: strip `api.w.org`, `xmlrpc` and dead form actions; optionally vendor third-party assets (WordPress emoji from `s.w.org`); fail on `http:`, IP or localhost URLs and on `srcset` entries with `http:`. | F19 | `tools/migrate/normalize.mjs` |
| R17 | P2 | M | **Determinism check and reproducible fixtures**: `publish --check-determinism` (export twice, diff) and a container recipe that builds the WordPress and Simply Static fixture from pinned versions. | F28 | CI |
| R18 | P3 | S | **Compressed text assets in the torrent** (gzip sidecars decompressed by the SW with `DecompressionStream`): HTML, CSS and JS are about 28 % of a median desktop home page (22 + 82 + 697 of 2,862 KB, S51); needs a support check and a measurement. | F20 | SW |
| R19 | P3 | L | **Query-aware redirect engine** for Plain-permalink sites (`/?p=N`, `?page_id=`) in the SW, with meta-refresh stubs for the host copy. | F15, F18 | SW; `/.mw/site.json` |

---

## Gotchas

1. **Publication is permanent.** Once a peer holds a file, "delete" does not exist; DESIGN-REVIEW item 21 limits takedown to best effort. Export from a crawl of public pages, not from directories (R4).
2. **WordPress's default permalinks are `/?p=N`.** Static trees cannot represent them; Simply Static writes nothing for query-string pages unless its search-results feature is on (F3, F15).
3. **`wget --mirror` does not convert links, fetch page requisites or add extensions.** You must add `-k -p -E` yourself, and `-E` turns the manual's example `article.cgi?25` into `article.cgi?25.html`, so a query stays inside the file name (F8).
4. **A default macOS volume merges names.** NFC and NFD spellings, and names that differ only in case, are the same file on APFS (measured); mirrors of Linux-hosted sites lose files silently (F8, F16).
5. **`create-torrent` drops dot-entries when given a directory.** `.well-known/` (certificates, `security.txt`, app association files) and `.htaccess` vanish; enumerate files yourself (F16).
6. **`webtorrent` does not percent-encode web-seed paths.** `?`, `#`, `%`, `\` in torrent file names mis-route; NFC and NFD are different URLs; the SW's `decodeURIComponent` turns `%2F` into a separator (F16).
7. **`?ver=` is added by WordPress core to every script and stylesheet.** Ignoring the query is right for lookup but hides same-path changes; record the version token (F15).
8. **Pagefind appends a timestamp query to its entry file and derives result URLs from the script location.** Without `metaCacheTag` the entry is never cacheable; without `baseUrl: "/"` results may carry `/_mw/s/<btih>/`; a stale cached `pagefind.js` against a new index logs a version-mismatch warning (F10).
9. **Simply Static "Relative Path" is root-relative with a prefix, and breaks Open Graph, canonical and sitemap URLs; "Offline" is document-relative with `index.html` appended to every directory link** (duplicate URLs `/page/` and `/page/index.html`). Use Absolute with the final domain (F3, F14).
10. **Absolute URLs to the old origin survive in inline scripts, JSON, form actions and `srcset`.** Simply Static fixed several of these only in 3.8.9 and 3.8.14 (F3, F19).
11. **`srcset` with `http:` is blocked, not upgraded** (MDN); the same page's `<img src="http:...">` is upgraded, which hides the problem in testing (F19).
12. **Third-party defaults ship in core.** WordPress emoji load from `s.w.org`; the REST discovery link and `wpApiSettings` carry absolute URLs; these are dead or third-party after export (F19).
13. **Comments exports carry email and IP.** Squarespace's XML uses the same WordPress format (F11, F6).
14. **v0.2 ledger limits make bulk comment import impractical.** 2 KiB per value and 8 MiB per ledger by default (ceiling 64 MiB): import legacy comments as a static file (F11).
15. **Sealed form submissions are small, and legally contested.** About 1.4 KB plaintext at 2 KiB values (derived); w2a-03 cites EDPB Guidelines 02/2025 against personal data on a replicated log even when encrypted, so keep a relay or `mailto:` as the default (F12, F29).
16. **Metadata is not free.** 82 bytes per file plus 20 per piece; peer-only bootstrap fails above 10 MB of metadata (`MAX_METADATA_SIZE`); 16 KiB pieces make it 3.5 times larger than 256 KiB pieces at 20,000 files (F21).
17. **Host ceilings arrive early.** Cloudflare Pages Free stops at 20,000 files and 25 MiB per file; about 2,500 full-size photos hit that (derived) (F24).
18. **CloudFront's default root object only covers `/`.** A directory-style export behind CloudFront with an S3 REST origin returns errors for `/about/` until a function rewrites it; S3's website endpoint redirects `/photos` with a 302 (F17).
19. **`_redirects` is not one format.** Cloudflare applies rules even when a file exists, defaults to 302, caps at 2,000 static plus 100 dynamic rules and cannot match query strings; IPFS applies rules only when the path is missing and defaults to 301 (F18).
20. **Tome exports only what anonymous users can see and writes only 200 or redirect responses**, so there is no 404 page and drafts or private nodes are absent by design (F5).
21. **Ghost exporters track Ghost.** gssg is tested on 4.48.2 and Casper; StaticGhost on a Ghost 5 container; Ghost is at 6.71.0; SnapStatic quit over the maintenance cost (F4).
22. **Squarespace images may be hotlinks** and die with the subscription; PDFs in the XML cannot be imported by WordPress (F6).
23. **Webflow and Wix are not verified at primary level.** Treat every claim about them as Medium or Low until their help pages are read (F7).
24. **Shell mode is invisible to anything that does not run the loader.** Googlebot's renderer is stateless and has no WebRTC; Meta reads Open Graph from the first 1 MB of the HTML; Snipcart parses plain HTML; drop-in keeps the host HTML (F25).
25. **A root-scope worker needs the origin root.** Do not promise "one script tag" on hosted builders until the worker file can be served there (F26).
26. **The CMS does not disappear.** The owner still needs somewhere to run it for authoring and exporting; "no backend of ours" stays true, but "no server for the owner" does not.
27. **Premium themes and page-builder assets may have redistribution terms.** Not researched; peer distribution of licensed assets is a legal question to check before promising migration of such sites.
28. **Exporter incremental modes are mostly paid** (Simply Static Pro "Changes Only", Staatic Premium change-based publications) and none is portable across CMSs; use the hash diff from `files.json` (F28).
29. **Re-export determinism is unproven.** If embedded timestamps or nonces change every HTML file, every delta is a full delta; test before relying on deltas (F28).
30. **Pagefind renames files on every content change** (hash in the name): each re-export deletes some search files and adds others, which is normal and small, but it means the file list never matches the previous one exactly (F10, F22).

---

## Open questions

1. Can Squarespace, Wix, Webflow or Ghost(Pro) serve `/mw-sw.js` from the origin root, or any worker script with `Service-Worker-Allowed`? (F26) Needs a test on a trial site per platform.
2. What do Wix's and Webflow's own help pages and terms say about export and automated copying? The Webflow help center blocks my fetcher (Cloudflare challenge); Wix pages I guessed returned 404.
3. Does Simply Static's Relative Path mode behave as the code suggests on a real site (root-relative `/wp-content/...` everywhere, including inline CSS, JS and `srcset`)? Export a sample in each mode and run the audit (R1).
4. How does Staatic rewrite origin URLs? The plugin page does not say.
5. What does Tome write for redirect responses (stub HTML or nothing)? The lines I read do not show it.
6. Is the output of Simply Static, Staatic, Tome and gssg deterministic across two unchanged runs? (F28)
7. In a browser, how long does hash verification of a file-prefilled store take for 100 MB on a mid-range phone, and does the startup `bitfield` path remove it? (F22) The Node check says the mechanism works; timing is unmeasured.
8. Does a browser-side store (IndexedDB-backed) behave like `memory-chunk-store` for `preloadedStore` verification? (F22)
9. What do real WordPress sites look like in file count and bytes (uploads versus referenced files)? I used synthetic distributions plus Web Almanac medians; a sample of 20 public sites would replace the assumptions in F20 to F22.
10. Pagefind inside a SW-served origin: not run. Confirm in a browser that `pagefind.js` loaded with `import()` resolves `import.meta.url` to the site path and that the 100-way concurrent fetches do not starve the SW's IndexedDB reads.
11. Is Googlebot's treatment of Service Workers documented anywhere? Google's two pages say nothing, so the claim "ignores workers" cannot be made.
12. Are HPKE-shaped sealed boxes acceptable for form submissions, or should the owner key be separate from the signing key? (F12; see DESIGN-REVIEW item 3 on key roles.)
13. Licensing and ToS: premium WordPress themes and plugins, Wix and Squarespace terms on copying their output. Not researched.
14. Which of the unresearched CMSs (Shopify, Joomla, Tilda, Duda, Blogger, GoDaddy) deserve a recipe, given 5.3 % and 1.1 % shares for the first two?
15. Does the EDPB guidance that w2a-03 cites (Guidelines 02/2025) apply to a replicated log without consensus, and does it also cover legacy comments republished inside a torrent? Not researched by me; it decides whether the optional sealed form inbox (R13) should exist at all.
16. Should drop-in verify HTML parity at deploy time (host copy versus what the exporter wrote) so a stale web seed cannot serve an old asset against new HTML? DESIGN-REVIEW 3.4.5 pins each document to its stamped btih; confirm that holds for query-versioned assets (F15).

---

## Appendix A - Experiments (reproducible; raw output)

Environment: macOS 27.0 (APFS), Node 24.22.0, `create-torrent@6.1.3`, `webtorrent@3.0.21`, `bencode@4.0.1`, `memory-chunk-store` from the project's `node_modules`. Scripts, outputs and run instructions are in `docs/research/labs/w2a-02-experiments/` (`RUN.txt`). All data is synthetic: pseudo-random bytes, WordPress-style paths. SHA-1 piece hashes are real.

### A.1 E1 - torrent metadata size versus file count and piece length (`exp_meta.mjs`)
```
┌─────────┬───────┬───────┬──────────┬────────┬───────────┬────────┬───────────────┬────────────┬────────────────────────┐
│ (index) │ files │ MiB   │ pieceKiB │ pieces │ torrentKB │ infoKB │ pieceHashesKB │ fileListKB │ ut_metadata_16KiB_msgs │
├─────────┼───────┼───────┼──────────┼────────┼───────────┼────────┼───────────────┼────────────┼────────────────────────┤
│ 0       │ 1000  │ 215   │ 16       │ 13756  │ 349       │ 349    │ 269           │ 81         │ 22                     │
│ 1       │ 1000  │ 215   │ 64       │ 3439   │ 148       │ 148    │ 67            │ 81         │ 10                     │
│ 2       │ 1000  │ 215   │ 256      │ 860    │ 97        │ 97     │ 17            │ 81         │ 7                      │
│ 3       │ 1000  │ 215   │ 1024     │ 215    │ 85        │ 85     │ 4             │ 81         │ 6                      │
│ 4       │ 5000  │ 1054  │ 16       │ 67464  │ 1720      │ 1720   │ 1318          │ 403        │ 108                    │
│ 5       │ 5000  │ 1054  │ 64       │ 16866  │ 732       │ 732    │ 329           │ 403        │ 46                     │
│ 6       │ 5000  │ 1054  │ 256      │ 4217   │ 485       │ 485    │ 82            │ 403        │ 31                     │
│ 7       │ 5000  │ 1054  │ 1024     │ 1055   │ 423       │ 423    │ 21            │ 403        │ 27                     │
│ 8       │ 10000 │ 2125  │ 16       │ 135997 │ 3461      │ 3461   │ 2656          │ 805        │ 217                    │
│ 9       │ 10000 │ 2125  │ 64       │ 34000  │ 1469      │ 1469   │ 664           │ 805        │ 92                     │
│ 10      │ 10000 │ 2125  │ 256      │ 8500   │ 971       │ 971    │ 166           │ 805        │ 61                     │
│ 11      │ 10000 │ 2125  │ 1024     │ 2125   │ 847       │ 847    │ 42            │ 805        │ 53                     │
│ 12      │ 20000 │ 4236  │ 16       │ 271116 │ 6906      │ 6906   │ 5295          │ 1610       │ 432                    │
│ 13      │ 20000 │ 4236  │ 64       │ 67779  │ 2934      │ 2934   │ 1324          │ 1610       │ 184                    │
│ 14      │ 20000 │ 4236  │ 256      │ 16945  │ 1941      │ 1941   │ 331           │ 1610       │ 122                    │
│ 15      │ 20000 │ 4236  │ 1024     │ 4237   │ 1693      │ 1693   │ 83            │ 1610       │ 106                    │
│ 16      │ 50000 │ 10708 │ 16       │ 685298 │ 17412     │ 17412  │ 13385         │ 4027       │ 1089                   │
│ 17      │ 50000 │ 10708 │ 64       │ 171325 │ 7374      │ 7374   │ 3346          │ 4027       │ 461                    │
│ 18      │ 50000 │ 10708 │ 256      │ 42832  │ 4864      │ 4864   │ 837           │ 4027       │ 304                    │
│ 19      │ 50000 │ 10708 │ 1024     │ 10708  │ 4237      │ 4236   │ 209           │ 4027       │ 265                    │
└─────────┴───────┴───────┴──────────┴────────┴───────────┴────────┴───────────────┴────────────┴────────────────────────┘
```

### A.2 E2 - piece reuse between two consecutive exports (`exp_reuse.mjs`)
Columns: "reuse@same-index" = v2 pieces equal to the v1 piece at the same index; "reuse via file-prefill" = v2 pieces that verify after copying every unchanged file to its v2 offset into an empty buffer; "download MiB" = unreused pieces times piece size. Layout letters: A path-sorted, B class order with path order inside each class, C generational (unchanged files first in v1 order, changed and new files last), F path-sorted with zero-filled padding files at every piece boundary (what BEP 47 padding does to the piece hashes).
```
v1 files=2428 bytes=141.0 MiB | v2 files=2433 bytes=141.3 MiB | theoretical file-level delta (new+changed files) = 858 KiB
┌─────────┬──────────┬───────────────────────────────────────────────┬──────────┬────────────────────┬──────────────────────────┬─────────────────────────────┬────────────┬───────────┐
│ (index) │ pieceKiB │ layout                                        │ v2Pieces │ reuse@same-index % │ reuse via file-prefill % │ download MiB (file-prefill) │ paddingMiB │ torrentKB │
├─────────┼──────────┼───────────────────────────────────────────────┼──────────┼────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┼───────────┤
│ 0       │ 256      │ 'A path-sorted'                               │ 566      │ 6.9                │ 97.9                     │ 3                           │ 0          │ 184       │
│ 1       │ 256      │ 'F path-sorted + piece padding'               │ 2491     │ 16                 │ 99.2                     │ 5                           │ 481.2      │ 316       │
│ 2       │ 256      │ 'B class[media>code>pf>html>volatile]'        │ 566      │ 74                 │ 98.1                     │ 2.75                        │ 0          │ 184       │
│ 3       │ 256      │ 'C generational[media>code>pf>html>volatile]' │ 566      │ 80.6               │ 99.1                     │ 1.25                        │ 0          │ 184       │
│ 4       │ 64       │ 'A path-sorted'                               │ 2262     │ 6.9                │ 98.9                     │ 1.5                         │ 0          │ 217       │
│ 5       │ 64       │ 'F path-sorted + piece padding'               │ 3756     │ 15.7               │ 99.4                     │ 1.5                         │ 93.4       │ 336       │
│ 6       │ 64       │ 'B class[media>code>pf>html>volatile]'        │ 2262     │ 74.1               │ 98.9                     │ 1.56                        │ 0          │ 217       │
│ 7       │ 64       │ 'C generational[media>code>pf>html>volatile]' │ 2262     │ 80.7               │ 99.3                     │ 0.94                        │ 0          │ 217       │
│ 8       │ 16       │ 'A path-sorted'                               │ 9045     │ 6.9                │ 99.3                     │ 1.03                        │ 0          │ 350       │
│ 9       │ 16       │ 'F path-sorted + piece padding'               │ 10348    │ 17.5               │ 99.4                     │ 1.02                        │ 20.4       │ 462       │
│ 10      │ 16       │ 'B class[media>code>pf>html>volatile]'        │ 9045     │ 74.1               │ 99.3                     │ 1.05                        │ 0          │ 350       │
│ 11      │ 16       │ 'C generational[media>code>pf>html>volatile]' │ 9045     │ 80.8               │ 99.4                     │ 0.86                        │ 0          │ 350       │
│ 12      │ 256      │ 'B class[media>code>html>pf>volatile]'        │ 566      │ 74                 │ 98.1                     │ 2.75                        │ 0          │ 184       │
│ 13      │ 256      │ 'C generational[media>code>html>pf>volatile]' │ 566      │ 86.7               │ 99.1                     │ 1.25                        │ 0          │ 184       │
│ 14      │ 64       │ 'B class[media>code>html>pf>volatile]'        │ 2262     │ 74.1               │ 98.9                     │ 1.5                         │ 0          │ 217       │
│ 15      │ 64       │ 'C generational[media>code>html>pf>volatile]' │ 2262     │ 86.8               │ 99.3                     │ 0.94                        │ 0          │ 217       │
│ 16      │ 16       │ 'B class[media>code>html>pf>volatile]'        │ 9045     │ 74.1               │ 99.3                     │ 1.05                        │ 0          │ 350       │
│ 17      │ 16       │ 'C generational[media>code>html>pf>volatile]' │ 9045     │ 86.9               │ 99.4                     │ 0.86                        │ 0          │ 350       │
└─────────┴──────────┴───────────────────────────────────────────────┴──────────┴────────────────────┴──────────────────────────┴─────────────────────────────┴────────────┴───────────┘
```

### A.3 E4 - real WebTorrent verifies a file-prefilled `preloadedStore` (`exp_wt_prefill.mjs`)
```
{
 "webtorrent": "3.0.21",
 "pieces": 231,
 "piecesAlreadyVerified": 227,
 "pct": 98.3,
 "progress": 0.9831,
 "done": false,
 "downloadedBytesCounter": 14876672,
 "unchangedFileBytes": 14999912,
 "totalBytes": 15131736,
 "missingPieces": 4,
 "missingMiB": 0.25,
 "fileLevelDeltaKiB": 129
}
```

### A.4 E3 - APFS Unicode normalization and case (`exp_norm.mjs`)
```
platform darwin 27.0.0
second write (NFC after NFD, wx): error EEXIST
readdir count: 1
 readdir name codepoints: 63 61 66 65 301 2e 68 74 6d 6c | isNFC: false | isNFD: true
case-colliding create (README.txt after Readme.txt): error EEXIST | readdir: [ 'Readme.txt' ]
```

### A.5 E5 - how the WHATWG URL parser treats exported file names (`exp_url.mjs`)
```
space                      {"pathname":"/ws/site/a%20b.png","search":"","hash":""}
query-style name           {"pathname":"/ws/site/style.css","search":"?ver=6.4.2","hash":""}
hash in name               {"pathname":"/ws/site/img","search":"","hash":"#1.png"}
lone percent               {"pathname":"/ws/site/100%.png","search":"","hash":""}
percent-escape lookalike   {"pathname":"/ws/site/a%41.png","search":"","hash":""}
backslash                  {"pathname":"/ws/site/dir/file.png","search":"","hash":""}
dot segment                {"pathname":"/ws/site/b.png","search":"","hash":""}
tab+newline                {"pathname":"/ws/site/abc.png","search":"","hash":""}
encoded slash              {"pathname":"/ws/site/a%2Fb.png","search":"","hash":""}
NFC e-acute                {"pathname":"/ws/site/caf%C3%A9.html","search":"","hash":""}
NFD e-acute                {"pathname":"/ws/site/cafe%CC%81.html","search":"","hash":""}

NFC === NFD (JS strings): false | URL pathnames equal: false
decodeURIComponent("a%2Fb.png") -> a/b.png (the SW decodes before IndexedDB lookup, so an encoded slash becomes a path separator)
```

### A.6 E6 - file-name policy linter on exporter-style names (`pathlint.mjs`)
```
ok     "wp-content/themes/t/style.css"
REJECT "wp-content/themes/t/style.css?ver=6.4.2"  <- forbidden character in "style.css?ver=6.4.2"
ok     "wp-content/themes/t/style.css@ver=6.4.2"
REJECT "index.php?p=123.html"  <- forbidden character in "index.php?p=123.html"
ok     "blog/foo4B54.html"
ok     "blog/café/index.html"
REJECT "blog/café/index.html"  <- not NFC (APFS preserves NFD but treats NFC/NFD as one name; URL paths never normalize); case/normalization collision with "blog/café/index.html"
ok     "img/IMG_001.JPG"
REJECT "img/img_001.jpg"  <- case/normalization collision with "img/IMG_001.JPG"
REJECT "img/a#b.png"  <- forbidden character in "a#b.png"
REJECT "img/100%.png"  <- forbidden character in "100%.png"
REJECT "img/a%41.png"  <- forbidden character in "a%41.png"
REJECT "img\\dir.png"  <- forbidden character in "img\dir.png"
REJECT "img/../x.png"  <- dot segment ".." (URL parser removes it); leading/trailing space or trailing dot in ".."
ok     ".well-known/security.txt"
ok     ".htaccess"
REJECT "_mw/sdk.js"  <- collides with reserved magnet-web path
REJECT "mw-sw.js"  <- collides with reserved magnet-web path
REJECT "blog/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...(310 chars)"  <- segment > 255 bytes

12 of 19 test paths rejected
```

## Appendix B - Sources (URL, date of source, how it was read)

"Fetched" = page text read through the fetch tool on 2026-10-17 (the tool summarizes against my prompt; quotes above come from that output). "Raw" = raw file text read. "Feed" = GitHub Atom feed read. Dates are the page's own date when it prints one; "none printed" otherwise.

**Project (local)**
- P1 `docs/ARCHITECTURE.md` v0.2 (2026-10-17; v0.1 of 2026-10-14 read first and now at `docs/review/ARCHITECTURE-v0.1.md`), sections 3, 3.4, 5.4, 6, 8, 10. P2 `docs/INTERFACES.md`. P3 `docs/review/DESIGN-REVIEW.md` (2026-10-17): items 3, 4, 7, 13, 14, 21, 22, 23, section 3 "LATER", section 5 drop-in spec. P4 `docs/research/01-webtorrent-browser.md` (F9, F10, F22) and `04-service-worker-serving.md` (F5, F12), read by search for the cited points only. P5 `src/sw/sw.js`, `src/sw/lib.js`, `src/loader/render.js`, `examples/peer-guestbook/` and `docs/deviations/example.md` as of the 2026-10-14 tree. P7 sibling wave-2A documents read for cross-checks only, in the state they had on 2026-10-17: `w2a-01-site-generator-output.md` (interim draft), `w2a-03-dynamic-feature-replacements.md` (sections 0 to 2 only), `w2a-05-seo-crawlers.md` (summary and headings), `w2a-06-cicd-automation.md` (placeholder). P6 `node_modules/create-torrent@6.1.3` (`index.js`, `get-files.js`), `piece-length@2.0.1`, `webtorrent@3.0.21` (`lib/webconn.js`, `lib/torrent.js`, `lib/file.js`), `ut_metadata@5.0.1`.

**WordPress**
- S1 https://wordpress.org/plugins/simply-static/ (fetched; version 3.8.18, last modified 2026-10-16). S2 https://simplystatic.com/simply-static-pro/ (fetched; none printed). S3 https://docs.simplystatic.com/article/97-how-to-replace-urls (fetched; none printed). S4 https://docs.simplystatic.com/article/54-add-missing-pages-files-to-your-static-website (fetched; none printed).
- S5 Simply Static 3.8.18 source, https://github.com/Simply-Static/simply-static master tarball from https://codeload.github.com/Simply-Static/simply-static/tar.gz/refs/heads/master (raw, extracted into an isolated scratch directory and only read, never executed): `src/class-ss-url-fetcher.php`, `src/class-ss-deploy-manifest-service.php`, `src/class-ss-url-extractor.php`, `src/class-ss-options.php`, `src/class-ss-util.php`, `src/admin/inc/class-ss-admin-rest.php`, `readme.txt`; header `Version: 3.8.18`.
- S6 https://wordpress.org/plugins/staatic/ (fetched; version 1.14.0, 2026-10-16). S7 https://github.com/WP2Static/wp2static (fetched) with feeds https://github.com/WP2Static/wp2static/commits/develop.atom and https://github.com/WP2Static/wp2static/releases.atom (feed; last release 7.2 on 2023-01-31, last commit 2024-02-14). S8 https://headlesshostman.com/what-happened-to-wp2static-and-strattic/ (fetched; secondary, vendor-biased, none printed).
- S29 WordPress core, https://github.com/WordPress/wordpress-develop trunk (version.php shows `7.2-alpha-63166-src`), raw files under `src/`: `wp-includes/media.php`, `wp-admin/includes/schema.php`, `wp-admin/includes/export.php`, `wp-includes/formatting.php`, `rest-api.php`, `comment-template.php`, `general-template.php`, `class-wp-styles.php`, `class-wp-scripts.php`, `script-loader.php`, `class-wp-dependencies.php`, `version.php` (raw, 2026-10-17). S30 https://make.wordpress.org/core/2019/10/09/introducing-handling-of-big-images-in-wordpress-5-3/ (fetched; 2019-10-09, OLD). S31 https://wordpress.org/documentation/article/customize-permalinks/ (fetched; updated 2025-06-28).

**Ghost, Drupal, Squarespace, Wix, Webflow**
- S9 https://github.com/Fried-Chicken/ghost-static-site-generator (fetched) with feeds https://github.com/Fried-Chicken/ghost-static-site-generator/commits/master.atom and /releases.atom (last tag v1.1.4 2022-01-11; last commit 2025-08-04). S10 https://github.com/Swapp-Technologies-LLC/staticGhost (fetched; no release date). S11 https://forum.ghost.org/t/built-a-browser-based-static-site-exporter-for-ghost-anyone-else-going-fully-static/62118 (fetched; 2026-03-06, update 2026-05-01). S12 https://docs.ghost.org/jamstack (fetched; none printed). S13 https://ghost.org/tutorials/use-code-injection-in-ghost (fetched; none printed). S14 https://github.com/TryGhost/Ghost/releases.atom (feed; v6.71.0 on 2026-10-15).
- S15 https://www.drupal.org/project/tome and https://www.drupal.org/project/tome/releases (fetched; 8.x-1.16, 2026-07-09). S16 https://tome.fyi/docs/technical/static/ and https://tome.fyi/docs/ (fetched). S17 https://git.drupalcode.org/project/tome/-/raw/8.x-1.x/modules/tome_static/src/StaticGenerator.php (raw).
- S18 https://support.squarespace.com/hc/en-us/articles/206566687-Exporting-your-site (fetched; "Last updated October 09, 2026"). S19 https://support.squarespace.com/hc/en-us/articles/205815928-Using-code-injection (fetched; "Last updated August 27, 2026").
- S20 Webflow help center code-export article https://help.webflow.com/hc/en-us/articles/33961386739347 and https://help.webflow.com/topic/code-export: **not read** (HTTP 403 Cloudflare challenge; the second URL 404); only search-result snippets. S21 https://elfsight.com/tutorials/how-to-export-a-wix-website/ (fetched; secondary, none printed) plus snippets of third-party vendor blogs.

**Search, comments, forms, commerce**
- S22 https://pagefind.app/docs/ (fetched), `pagefind_web_js/lib/coupled_search.ts` at tag v1.5.2 from https://raw.githubusercontent.com/Pagefind/pagefind/v1.5.2/ (raw), https://github.com/Pagefind/pagefind/releases.atom (feed; v1.5.2 on 2026-04-12). S23 feeds: https://github.com/lucaong/minisearch/releases.atom, https://github.com/nextapps-de/flexsearch/releases.atom, https://github.com/olivernn/lunr.js/releases.atom, https://github.com/krisk/Fuse/releases.atom, https://github.com/oramasearch/orama/releases.atom, https://github.com/eduardoboucas/staticman/releases.atom, https://github.com/umputun/remark42/releases.atom, https://github.com/giscus/giscus/releases.atom (no entries).
- S24 https://giscus.app/ (fetched). S25 https://github.com/eduardoboucas/staticman (fetched). S26 https://docs.stripe.com/payment-links and https://docs.stripe.com/payment-links/buy-button (fetched). S27 https://docs.snipcart.com/v3/setup/order-validation (fetched). S28 https://docs.netlify.com/forms/setup/ (fetched). S52 https://www.rfc-editor.org/rfc/rfc9180.html (fetched; February 2022).

**Hosting, protocols, platform rules**
- S32 https://docs.aws.amazon.com/AmazonS3/latest/userguide/IndexDocumentSupport.html, S33 https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DefaultRootObject.html, S34 https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html (all fetched; none printed). S35 https://developers.cloudflare.com/pages/platform/limits/ and S36 https://developers.cloudflare.com/pages/configuration/redirects/ (fetched; none printed). S37 https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits (fetched; none printed). S38 https://specs.ipfs.tech/http-gateways/web-redirects-file/ (fetched; none printed).
- S39 https://www.bittorrent.org/beps/bep_0019.html, S40 https://www.bittorrent.org/beps/bep_0047.html, S41 https://www.bittorrent.org/beps/bep_0009.html, S42 https://www.bittorrent.org/beps/bep_0052.html (fetched; BEP drafts and standards, undated pages).
- S43 https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register and S44 https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content (fetched). S45 https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics and S46 https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript (fetched; the WebSockets and WebRTC sentence re-fetched and confirmed verbatim). S47 https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/ (fetched).
- S48 https://manpages.debian.org/testing/wget/wget.1.en.html (fetched; wget 1.25.0; the GNU manual node https://www.gnu.org/software/wget/manual/html_node/Download-Options.html also fetched once for `--restrict-file-names`, the other GNU nodes returned HTTP 429). S49 https://www.httrack.com/html/httrack.man.html (fetched).
- S50 https://w3techs.com/technologies/overview/content_management (fetched; survey date 17 October 2026). S51 https://almanac.httparchive.org/en/2025/page-weight and https://almanac.httparchive.org/en/2025/cms (fetched; CMS chapter published 2026-01-15; data through July 2025; the page-weight chapter contains internal inconsistencies noted in F20). S53 https://github.com/zeronet-conservancy/zeronet-conservancy (fetched; none printed).

**Seen in search results only (not read; do not rely on)**: drupal.org `static_generator` (2.0.0-alpha4 "fixed Drupal 11 compatibility") and `static_node`; Acquia and Quant pages; tracxn and pitchbook Strattic profiles; websitebuilderinsider.com, nocodeexport.com, sitedin.io (Wix); flothemes.com, wpbeginner.com (Squarespace to WordPress); brixtemplates.com, flowninja.com (Webflow); GPL reseller pages for Simply Static Pro (version numbers there are unverified).

**Fetch attempts that failed (so the corresponding facts are absent)**: Webflow help center (403, Cloudflare challenge) and Webflow feature page (parser error); `https://www.wix.com/terms-of-use` (404) and a guessed Wix support URL (404); `https://docs.ghost.org/faq/code-injection` (404); a guessed Snipcart security URL (404, corrected from the docs index); `https://developer.wordpress.org/apis/handbook/media/` (404); GNU wget manual nodes (429, replaced by the Debian man page); GitHub REST API (rate-limited, replaced by Atom feeds and raw files); the W3C CSP3 specification (text truncated; the srcdoc-inheritance question was dropped); the AWS CloudFront Function directory-index sample (the search was refused after the shared budget ran out).

*End of document.*
