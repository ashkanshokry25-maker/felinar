# w2a-09 - Existing conventions to adopt: IPFS website rules, `_redirects`/`_headers`, Beaker/Dat, PWA and migration checklists

> **STATUS: INTERIM DRAFT, saved 2026-10-17 ~18:30 ET after an interrupted run, so nothing is lost.** The final version replaces this file.
> Verified so far (primary sources read, URLs below): IPFS `_redirects` spec + reference parser + gateway + conformance fixtures (decoded), IPFS SW gateway,
> Cloudflare Pages/Workers, Netlify, Vercel, Firebase, Beaker/Hyperdrive resolver, web.dev/MDN PWA pages, Workbox/Angular navigation rules,
> Google site-move docs, trailing-slash matrix (own live re-probe 2026-10-17), generator flags.
> Still pending when this banner is present: executed labs (reference `_redirects`/routing engine + vectors; headers on SW-synthesized responses; manifest in shell mode), final recommendations table.
> Method limit: the shared WebSearch budget (200 per turn, all agents) was exhausted before this task started, so every source below is a direct fetch of a known primary URL.
> Anything that needed discovery by search is listed under Open questions.

## Summary (interim)

1. **Adopt the file names and the Netlify-superset line grammar of `_redirects` and `_headers`, but compile them at publish time into `/.mw/site.json`; the Service Worker should never parse text.**
   The same two file names are honoured by Netlify, Cloudflare Pages, Cloudflare Workers static assets (identical docs) and, for `_redirects` only, by IPFS gateways (spec dated 2025-03-19) and by the
   IPFS Service Worker Gateway (TypeScript, in a SW). Their grammars and semantics differ, and the differences are exactly where migrated sites break (S1, S3, S9, S12, S13).
2. **Three semantic splits must be resolved per site at publish time, not guessed at runtime:** (a) Cloudflare applies redirects even when a file exists, Netlify and IPFS only when it does not (Netlify `!` forces);
   (b) the default status (Cloudflare 302, Netlify 301, IPFS 301) and the valid code sets; (c) the error policy (IPFS: any bad line makes the whole file invalid and every missing path answers 500;
   Netlify: per-line errors; Cloudflare: invalid lines ignored).
3. **A Netlify-style file can brick an IPFS-style engine.** The IPFS reference parser rejects any line with more than three fields and any `!` status, so Netlify query matching (`/store id=:id /blog/:id 301`),
   conditions (`Country=us`) and forced rules make the whole file invalid (verified in source and in the conformance fixture `forced/_redirects`, `/a /b 301!`) (S3, S5).
4. **SPA fallback must be limited to navigations.** The IPFS Service Worker Gateway removed its own `/* /index.html 200` catch-all after a production incident (issue #1155, 2026-07-09/10): missing hashed assets answered 200 text/html,
   the edge cached that for 24 h and browsers entered a reload loop (S7). Cloudflare's SPA mode applies only to `Sec-Fetch-Mode: navigate` requests, Workbox `NavigationRoute` only to `mode === 'navigate'`, and Angular's
   service worker additionally skips URLs with a file extension (S10, S18).
5. **Directory and clean-URL behaviour is not standardised; measured on 2026-10-17:** GitHub Pages, Netlify (Pretty URLs) and Cloudflare Pages all serve `/both` from `both.html` when `both.html` and `both/index.html` both exist, Render serves
   `both/index.html`; canonical redirects are 301 (GitHub Pages, Netlify), 308 (Cloudflare Pages); Netlify matched `/FILE.html` case-insensitively while GitHub Pages and Render returned 404 (S20, own probe). Next.js's official nginx recipe
   is `try_files $uri $uri.html $uri/ =404;` (file, then `.html`, then directory). The current `entryFor` in `src/sw/lib.js` tries `p/index.html` before `p.html`; that matches IPFS/Render, not the three hosts most exports come from.
6. **Beaker/Hyperdrive (archived 2022-12-27) is a precedent for a manifest-driven site root**: `/index.json` with `web_root`, `fallback_page`, `csp`, plus Accept-based extension negotiation and `.goto` redirect files (S16). Its vocabulary maps one-to-one onto `/.mw/site.json`; do not adopt Accept-based extension negotiation.
7. **PWA checklists (web.dev 2024-09-19, MDN 2026-10-06) do not require a service worker for installability**; they require a manifest linked from every page, 192 px and 512 px icons, `start_url`, `display` (S17). In shell mode the top-level document is the shell, so the site's manifest link must be provided by the shell.
8. **IPFS's own DNSLink guide recommends exactly the drop-in topology:** keep a conventional host (Cloudflare Pages, GitHub Pages) AND publish the content pointer in `_dnslink.<host>` TXT, "essentially getting the benefits of both" (S8).

(Full findings, vectors, recommendations and gotchas follow in the final version.)

## Sources actually read (all fetched 2026-10-17 unless noted)

- S1 IPFS Web `_redirects` File Specification, date 2025-03-19, maturity "reliable": https://specs.ipfs.tech/http-gateways/web-redirects-file/ and raw https://raw.githubusercontent.com/ipfs/specs/main/src/http-gateways/web-redirects-file.md
- S2 IPFS Path Gateway Specification, 24 August 2026: https://specs.ipfs.tech/http-gateways/path-gateway/
- S3 Reference parser: https://raw.githubusercontent.com/ipfs/go-ipfs-redirects-file/main/redirects.go
- S4 boxo gateway: https://raw.githubusercontent.com/ipfs/boxo/main/gateway/handler_unixfs_redirects.go , .../handler_unixfs_dir.go , .../handler.go
- S5 Conformance: https://raw.githubusercontent.com/ipfs/gateway-conformance/main/tests/redirects_file_test.go ; fixtures https://github.com/ipfs/gateway-conformance/raw/refs/tags/v0.13.2/fixtures/redirects_file/redirects.car , .../redirects-spa.car ; https://github.com/ipfs/boxo/raw/refs/tags/v0.42.1/gateway/testdata/redirects-query-params.car (decoded locally)
- S6 verified-fetch: https://raw.githubusercontent.com/ipfs/helia-verified-fetch/main/packages/verified-fetch/src/utils/apply-redirect.ts and test/utils/apply-redirects.spec.ts
- S7 IPFS Service Worker Gateway: https://raw.githubusercontent.com/ipfs/service-worker-gateway/main/public/_redirects ; test-e2e/redirects.test.ts ; issue https://github.com/ipfs/service-worker-gateway/issues/1155 ("Cyclic reload", opened 2026-07-09, closed 2026-07-10)
- S8 IPFS docs (ipfs/ipfs-docs main, last touching commit 2026-09-27): https://docs.ipfs.tech/how-to/websites-on-ipfs/redirects-and-custom-404s/ , .../static-site-generators/ , .../custom-domains/ , https://docs.ipfs.tech/how-to/address-ipfs-on-web/ , https://docs.ipfs.tech/concepts/dnslink/ (read as raw markdown)
- S9 Cloudflare Pages: https://developers.cloudflare.com/pages/configuration/redirects/ , .../headers/ , .../serving-pages/ (raw MDX from cloudflare/cloudflare-docs, branch production)
- S10 Cloudflare Workers static assets: .../workers/static-assets/routing/advanced/html-handling/ , .../routing/single-page-application/ , .../routing/static-site-generation/ , .../workers/static-assets/redirects/ , .../headers/
- S11 Cloudflare migration guides: .../pages/migrations/migrating-from-netlify/ (reviewed 2022-07-26), -from-vercel (2025-04-10), -from-firebase (2020-09-28), -jekyll-from-github-pages (2021-07-27)
- S12 Netlify docs: https://docs.netlify.com/routing/redirects/ , .../redirect-options/ , .../rewrites-proxies/ , https://docs.netlify.com/routing/headers/
- S13 Netlify parsers (netlify/build): packages/redirect-parser/src/{line_parser,status,conditions,normalize}.js , packages/headers-parser/src/line_parser.ts
- S14 Vercel: https://vercel.com/docs/project-configuration (last_updated 2026-08-25), https://vercel.com/docs/project-configuration/vercel-json (last_updated 2026-08-14)
- S15 Firebase Hosting: https://firebase.google.com/docs/hosting/full-config (undated in fetched text)
- S16 Beaker: https://github.com/beakerbrowser/beaker (archived, last push 2022-12-27) app/bg/protocols/hyper.js ; https://github.com/beakerbrowser/docs.beakerbrowser.com (archived, last push 2021-01-20) docs/developers/{index.json-manifest,content-type-negotiation,goto-files,frontends-.ui-folder}.md ; npm @beaker/dat-serve-resolve-path@1.0.1 (modified 2022-04-04) ; npm pauls-dat-api2@1.2.1 (modified 2022-05-12)
- S17 web.dev: https://web.dev/articles/pwa-checklist and /install-criteria (both "Last updated 2024-09-19"), /offline-ux-design-guidelines (2016-11-10, old), /service-worker-lifecycle (2016-09-29, old), https://web.dev/learn/pwa/ ; MDN https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable (last modified 2026-10-06)
- S18 Workbox https://developer.chrome.com/docs/workbox/modules/workbox-precaching (2017-11-27, old) and /workbox-routing ; Angular https://angular.dev/ecosystem/service-workers/config
- S19 Google Search Central: https://developers.google.com/search/docs/crawling-indexing/site-move-no-url-changes (2025-12-10), .../site-move-with-url-changes (2026-08-20)
- S20 https://github.com/slorber/trailing-slash-guide (README; last commit 2024-11-19) plus own live re-probe 2026-10-17 (raw output under the lab folder)
- S21 Generators: Hugo https://gohugo.io/configuration/all/ and /content-management/urls/ (hugo v0.168.0 released 2026-10-13); Jekyll docs/_docs/{configuration/default,structure}.md (jekyll v4.4.1, 2025-01-29); Next.js static exports (docs/01-app/02-guides/static-exports.mdx); Docusaurus docusaurus.config.js `trailingSlash`; MkDocs `use_directory_urls`; Vite build "Public Base Path"; Astro configuration reference (`base`, `trailingSlash`, `build.format`); Eleventy `pathPrefix`
- S22 GitHub Pages docs (github/docs): creating-a-custom-404-page, github-pages-limits, using-custom-workflows-with-github-pages
- S23 vercel/serve-handler README (options: cleanUrls, rewrites, redirects, headers, trailingSlash, public)
- S24 Project: docs/ARCHITECTURE.md v0.2 (sections 3.1, 3.4, 7.1), docs/INTERFACES.md, src/sw/lib.js, src/sw/sw.js
- S25 Sibling research: w2a-02-cms-export.md (F18), w2a-06-cicd-automation.md (F2, F34), w2a-05-seo-crawlers.md (F36, F37), w1-07-prior-art.md, w2c-06-standards-and-ecosystem.md, w1-13-toolchain.md

(Interim: findings table, labs and recommendations are being written; see scratch notes. If you read this banner the run did not finish.)
