# w2a-05 — SEO, crawlers and link previews for a P2P-delivered site

Wave 2A (migration), topic 05. Written 2026-10-17. Scope: what search crawlers, link-preview scrapers and AI crawlers can and cannot see of a magnet-web site, and the rules a migration guide must impose so that an existing website keeps its search traffic and its link previews after moving onto magnet-web.

Reading guide: Section 1 is the verdict. Section 2 gives the method, its limits and a crawler capability matrix. Section 3 is the evidence (each finding has claim, confidence, sources, source date). Section 4 says what the evidence means for the architecture. Section 5 is what to build (backlog, migration-guide rules, test matrix). Sections 6 and 7 are gotchas and open questions. Appendix A lists every source actually read; Appendix B has the raw output of the local experiments.

Conventions: `[DC]` marks a design-critical finding (would change the architecture or a compatibility promise if wrong). "Verbatim" quotes are copied from the page text I downloaded on 2026-10-17. "Undated" means the page shows no date. Anything I could not verify is labelled unverified.

---

## 1. Summary

**Verdict.** Crawlers and link-preview bots only see what the static origin returns over plain HTTP(S). None of them runs our service worker. Google's renderer has no WebRTC or WebSocket and keeps no storage between loads; link-preview scrapers and (as of the last measurement I could read, Dec 2024) most AI crawlers do not run JavaScript at all; a `#fragment` is not part of a URL's identity for Google or for Safe Browsing. Therefore:

1. The static origin must serve complete, final, per-URL HTML with correct HTTP status codes. The web-seed files are exactly that, so the web seed and the crawler fallback are the same bytes.
2. The P2P layer can only be progressive enhancement that starts after the page is already complete.
3. Shell mode (ARCHITECTURE §3 default) and hub mode are structurally not indexable and cannot produce per-site link previews. I measured this on this repo (Appendix B): the shell gives every URL the same `<title>magnet-web</title>`, no Open Graph tags, no canonical, and on a GitHub-Pages-like host every deep link answers HTTP 404.
4. The only SEO-safe production mode is **embedded (drop-in) mode**: the site's own HTML pages stay on the origin unchanged apart from one injected script tag and a pointer `<meta>`; the loader and service worker only accelerate later navigations and add the chain SDK.

**Precedents agree.** The IPFS Service Worker Gateway (closest analogue: in-browser verified retrieval through a service worker) answers crawlers with a bootstrap page and `X-Robots-Tag: noindex, nofollow` (measured 2026-10-17). peerweb.lol (WebTorrent site host) returns the same HTML, title and Open Graph tags for every hosted site, and has no robots.txt or sitemap. PeerTube (WebTorrent plus HTTP web seed) injects per-URL title, Open Graph, Twitter, oEmbed, JSON-LD, canonical and robots tags into its SPA HTML on the server. IPFS and ENS sites get SEO from a server-side gateway (eth.limo returns full HTML and the site's own robots.txt) or from a conventional origin published in parallel (docs.ipfs.tech answers from GitHub Pages while also publishing a DNSLink record).

**Numbers worth remembering** (all sourced in Section 3): Googlebot reads the first 2 MB of each HTML or text file, uncompressed, and fetches each CSS/JS file separately under the same limit; Apple Messages reads a 1 MB main resource and 10 MB of associated resources and runs no JavaScript; Meta wants Open Graph properties inside the first 1 MB and sends `Range: bytes=0-524288`; Slack fetches with Range and caches about 30 minutes and ignores robots.txt; robots.txt is capped at 500 KiB; a sitemap at 50,000 URLs or 50 MB; Core Web Vitals pass at LCP 2.5 s, INP below 200 ms, CLS below 0.1 at the 75th percentile; WebTorrent's browser bundle is 222,929 B raw, 64,428 B gzip, 55,969 B brotli (measured), about 0.28 to 0.32 s of pure transfer at Lighthouse's 1.6 Mbps.

**What changed in 2025–2026 and matters here.**
- Google JS docs (Dec 2025): pages with a non-200 status "might" skip rendering; `noindex` in the raw HTML may stop rendering and cannot be reliably removed by JS; JS must not change a canonical set in HTML. Mar 2026: docs state Google "has been rendering JavaScript for multiple years".
- Google file-size documentation was reorganised on 2026-02-03 (2 MB for Googlebot Search, 15 MB default for other crawlers).
- "Back button hijacking" became an explicit spam-policy violation on 2026-04-13, enforced from 2026-06-15. The loader's history handling must stay replace-only.
- FAQ rich results stopped appearing on 2026-05-07; Google says it ignores `llms.txt` (2026-06-15); Google uses `og:image` as a thumbnail source (2026-03-02).
- Applebot documentation published 2026-09-04; web.dev bfcache guide updated 2026-10-16 (open WebRTC, IndexedDB and in-flight fetches can block bfcache).
- X's first-party Cards documentation is gone (old URL redirects to the developer overview). The IPFS Service Worker Gateway changed maintainers in Q3 2026.

**Top actions** (details in Section 5): make embedded mode the default migration target and make the swarm bytes identical to the origin bytes (P0); make the loader inert for crawlers and never let a loader failure change visible content (P0); ship an SEO lint and origin-verification gate in the publish tooling (P0); write host recipes that avoid soft-404 and fake-404 traps (P0); make hub mode `noindex` by default (P1); fix bfcache, prerender and history behaviour in the loader (P1).

---

## 2. Method, limits and crawler matrix

**Method.** Primary sources were downloaded with curl (stripped to text and grepped) or fetched with WebFetch, and read; Google documentation pages carry "Last updated" stamps which I record. Two local experiments ran the repo's example site and shell through Playwright Chromium with JavaScript off and with service workers blocked. Header probes were plain GET/HEAD requests to public sites.

**Limits (be honest).**
- The WebSearch tool hit its shared per-turn cap (200 calls, shared by every sibling agent) after 9 successful searches. After that I only fetched known primary URLs; I did not search through other means. Items that needed more searching are in Section 7.
- Bing's help center and Meta's developer docs block or do not render for curl. Meta pages were read through WebFetch (two passes returned the same verbatim sentences). Bing's current guidelines page could not be read (it is a client-rendered app); only Bing's 2018 and 2019 blog posts are first-party.
- Several Google-engineer statements (Splitt, Mueller on service workers) were read through secondary reports, not the original Reddit and Mastodon posts.

**What each consumer does with a magnet-web page** (every row is derived from the cited findings):

| Consumer | Runs JS | Service worker | WebRTC / WebSocket | IndexedDB / localStorage | Fetch limits | Notes |
|---|---|---|---|---|---|---|
| Googlebot / WRS (Search) | Yes, evergreen Chromium, after a render queue | No (Splitt 2019/2020, Mueller 2023; Search Console test shows registration "Rejected") | No (official) | localStorage, sessionStorage, cookies cleared per load (official); IndexedDB undocumented, assume unavailable | 2 MB per file, uncompressed; resources fetched separately | Non-200 pages may skip rendering |
| Bingbot | Yes (Edge-based since 2019), "difficult at scale" | Unverified | Unverified | Unverified | Unverified | Bing recommended dynamic rendering for JS-heavy sites (2018) |
| Applebot | "May render … within a browser" (WebKit UA) | Unverified | Unverified | Unverified | Unverified | Needs JS, CSS, XHR not blocked; follows Googlebot robots rules if none for Applebot |
| Meta (facebookexternalhit) | Docs silent | n/a | n/a | n/a | OG within first 1 MB; sends `Range: bytes=0-524288` | May bypass robots.txt for integrity checks |
| Slackbot-LinkExpanding | No (Range fetch of markup) | n/a | n/a | n/a | Minimal bytes, then referenced media | ~30 min cache; ignores robots.txt |
| iMessage / Messages | No (official) | n/a | n/a | n/a | Main resource 1 MB; total 10 MB | No meta-refresh redirects; server redirects followed |
| X / Twitterbot | Unverified | n/a | n/a | n/a | Unverified | First-party Cards docs removed |
| LinkedInBot | Reads OG tags | n/a | n/a | n/a | Image 5 MB | Fails if image behind protected path |
| Discord, WhatsApp, Telegram | Third-party reports only: raw HTML | n/a | n/a | n/a | WhatsApp image ~600 KB (third party) | Unverified |
| AI crawlers (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Meta-ExternalAgent, Bytespider, CCBot) | No (Dec 2024 study) | n/a | n/a | n/a | n/a | Gemini uses Googlebot's renderer; Applebot renders |
| Browser agents (real Chrome) | Yes, everything | Yes | Yes | Yes | n/a | Read screenshots, DOM, accessibility tree (Google AI guide) |


---

## 3. Findings

### A. Google Search: what the Web Rendering Service can and cannot do

**F1 [DC] Rendering is real but queued, and an "app shell" is only indexable if JS alone can produce the content.**
Googlebot first fetches the URL over HTTP and parses the raw HTML for links; "Googlebot queues all pages with a 200 HTTP status code for rendering, unless a robots meta tag or header tells Google not to index the page. The page may stay on this queue for a few seconds, but it can take longer than that. Once Google's resources allow, a headless Chromium renders the page and executes the JavaScript." (verbatim). "Some JavaScript sites may use the app shell model where the initial HTML does not contain the actual content and Google needs to execute JavaScript before being able to see the actual page content that JavaScript generates." The same page says "server-side or pre-rendering is still a great idea because it makes your website faster for users and crawlers, and not all bots can run JavaScript." Implication: a shell whose content appears only after service-worker, WebRTC or IndexedDB work cannot be rendered by Google (F2–F4), so the app-shell tolerance does not apply to us.
Confidence: High. Sources: [Google: JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) (Last updated 2026-03-04); [Search Central changelog](https://developers.google.com/search/updates) (entry 2026-03-04: "Google Search has been rendering JavaScript for multiple years now").

**F2 [DC] The renderer does not support WebSockets or WebRTC.**
Verbatim: "Googlebot uses HTTP requests to retrieve content from your server. It does not support other types of connections, such as WebSockets or WebRTC connections. To avoid problems with such connections, make sure to provide an HTTP fallback to retrieve content and use robust error handling and feature detection." This is the strongest official statement for our topic: WebTorrent in the browser is WebRTC-only, so a crawler can never fetch content from peers. The HTTP fallback is the web seed and the origin.
Confidence: High. Sources: [Google: Fix Search-related JavaScript problems](https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript) (Last updated 2025-12-18).

**F3 [DC] The renderer is stateless; localStorage, sessionStorage and cookies are cleared across page loads. IndexedDB is not documented.**
Verbatim: "WRS does not retain state across page loads: Local Storage and Session Storage data are cleared across page loads. HTTP Cookies are cleared across page loads." The current Google page says nothing about IndexedDB or Cache Storage. A vendor write-up lists "IndexedDB & WebSQL: Not available" and "WebRTC", but that is a third-party claim. Treat IndexedDB, Cache Storage and any persisted state as unavailable, so a crawler can never see "cached from the swarm" content. Open question Q1 proposes a probe page to settle it.
Confidence: High for web storage and cookies; Low-Medium for IndexedDB. Sources: [Google: Fix Search-related JavaScript problems](https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript) (2025-12-18); [searchVIU: Service Workers and Google Search](https://www.searchviu.com/en/service-worker-what-seos-need-to-know/) (created 2020-12-11, updated 2026-06-25; vendor, secondary).

**F4 [DC] Google Search does not run service workers, and says it will not.**
Martin Splitt (Google I/O 2019 and a July 2020 Reddit AMA): "as we have to assume that someone clicking on your page from a SERP is a first-time visitor, running a service worker is usually not going to do much good - because Googlebot would then likely see a different experience of some sort than a first time visitor would". John Mueller, 2023: "I don't think anything has changed. I wouldn't expect it to change - it's computationally expensive to run service-workers in the background like this for indexing." A vendor test in Search Console shows `Registration failed: Rejected` for a service-worker registration, and reports that `'serviceWorker' in navigator` is still true in the renderer, so feature detection alone is not enough (the registration promise must be handled). The design principle behind it is the useful part: every crawl is modelled as a first-time visit. Anything that only exists after the first visit (cached swarm content, SW-rewritten HTML) is invisible to Google by design.
Confidence: Medium-High (consistent statements by Google staff; read through secondary reports; no current first-party doc page). Sources: [Search Engine Roundtable](https://www.seroundtable.com/google-search-service-workers-29753.html) (2020-07-10, updated 2023); [searchVIU](https://www.searchviu.com/en/service-worker-what-seos-need-to-know/) (updated 2026-06-25).

**F5 [DC] URL fragments are not URL identity for Google.**
Verbatim: "Don't use fragments to change the content of a page, as Google Search generally doesn't support URL fragments." and "The AJAX-crawling scheme has been deprecated since 2015, so you can't rely on URL fragments to work with Googlebot." Also: "Don't specify a URL fragment as canonical" and "Google can only discover your links if they are `<a>` HTML elements with an `href` attribute." Consequence: hub URLs of the form `hub.example/#btih:…` or `#host:example.com` all collapse to one URL, cannot be canonicals or sitemap entries, and cannot be indexed per site.
Confidence: High. Sources: [Google: URL structure](https://developers.google.com/search/docs/crawling-indexing/url-structure) (2025-12-10); [Google: Fix JS problems](https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript) (2025-12-18); [Google: Canonicalization](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) (2026-07-10); [Google: JS basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) (2026-03-04).

**F6 [DC] Directives in the raw HTML win; JS cannot be relied on to undo them.**
Verbatim: "When Google encounters the noindex tag, it may skip rendering and JavaScript execution, which means using JavaScript to change or remove the robots meta tag from noindex may not work as expected. If you do want the page indexed, don't use a noindex tag in the original page code." Canonical: "you shouldn't use JavaScript to change the canonical URL to something else than the URL you specified as the canonical URL in the original HTML"; if the canonical cannot be in HTML, leave it out of the HTML and set it by JS. The changelog explains why: "Canonicalization happens before and after rendering" (2025-12-17) and noindex behaviour "is not well defined and might change" (2025-12-15). For us: the loader must never add, remove or change `robots` or `canonical` tags on a page that has a stable value in static HTML, and a shell must never ship `noindex` in raw HTML if the page is meant to be indexed.
Confidence: High. Sources: [Google: JS basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) (2026-03-04); [Search Central changelog](https://developers.google.com/search/updates) (entries 2025-12-15 and 2025-12-17).

**F7 [DC] Status codes decide whether a page is rendered at all; SPA fallbacks create soft 404s or fake 404s.**
"If the HTTP status code is non-200 (for example, on error pages with 404 status code), rendering might be skipped." (JS basics; clarification added 2025-12-18.) For SPAs that answer 200 for everything the docs prescribe: JS redirect to a URL that really returns 404, or inject `<meta name="robots" content="noindex">` on error views. The opposite trap is real too: measured 2026-10-17, GitHub Pages answers an unknown path with HTTP 404 plus the custom 404 page body (E3). A shell copied to `404.html` therefore gives every deep link a 404 status, and Google will not render or index it. Cloudflare Pages does the reverse: without a top-level `404.html` it assumes an SPA and "serves the root (/) for any incoming path that does not correspond to a static asset", a soft-404 factory (F44).
Confidence: High. Sources: [Google: JS basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) (2026-03-04); [changelog entry 2025-12-18](https://developers.google.com/search/updates); [Cloudflare Pages: serving pages](https://developers.cloudflare.com/pages/configuration/serving-pages/) (undated); local probe E3.

**F8 Googlebot file-size limits.**
Verbatim: "When crawling for Google Search, Googlebot crawls the first 2MB of a supported file type, and the first 64MB of a PDF file. From a rendering perspective, each resource referenced in the HTML (such as CSS and JavaScript) is fetched separately, and each resource fetch is bound by the same file size limit … The file size limit is applied on the uncompressed data." The default for all other Google crawlers and fetchers is 15 MB. Google calls the 2026-02-03 change a clarification (docs moved); some SEO blogs claim the practical limit shrank, which I could not verify. Relevance: an HTML page with large inline state, and any single JS bundle over 2 MB uncompressed, is truncated for Search.
Confidence: High (documentation); behaviour change unverified. Sources: [Google: Googlebot](https://developers.google.com/search/docs/crawling-indexing/googlebot) (2026-02-03); [Google: crawlers overview](https://developers.google.com/crawling/docs/crawlers-fetchers/overview-google-crawlers) (2026-06-12); changelog entry 2026-02-03.

**F9 The renderer caches aggressively and may ignore caching headers.**
Verbatim: "Googlebot caches aggressively in order to reduce network requests and resource usage. WRS may ignore caching headers. This may lead WRS to use outdated JavaScript or CSS resources. Content fingerprinting avoids this problem". Relevance: loader and SDK assets must carry content hashes in their file names (already the plan for `BUILD_ID`), and the injected script URL in HTML pages must change when the loader changes.
Confidence: High. Sources: [Google: JS basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) (2026-03-04); [Google: Fix JS problems](https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript) (2025-12-18).

**F10 Blocked resources are not rendered.**
"Google Search won't render JavaScript from blocked files or on blocked pages." Applebot says the same (F16). Do not `Disallow` assets the page needs to render; `/_mw/` content is not needed for visible content if the page is progressive (R3), but a stub must exist so requests do not 404 (E1).
Confidence: High. Sources: [Google: JS basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) (2026-03-04).

**F11 Structured data injected by JavaScript is processed after rendering; static is more robust.**
Google "can understand and process structured data that's available in the DOM when it renders the page", including JSON-LD created by script or Tag Manager; for Product markup "dynamically-generated markup can make Shopping crawls less frequent and less reliable". Bing, Apple and AI crawlers (F14 to F17) do not necessarily render, so JSON-LD belongs in the static HTML. Do not spend effort on FAQ markup (F26).
Confidence: High (Google); the cross-engine point is an inference. Sources: [Google: Generate structured data with JavaScript](https://developers.google.com/search/docs/appearance/structured-data/generate-structured-data-with-javascript) (2025-12-10).

**F12 Google can show you what it rendered.**
The URL Inspection tool's live test lets you "View tested page" for the screenshot, rendered HTML, HTTP response, JavaScript console output and loaded resources; the crawler identifies as Google-InspectionTool; the Rich Results Test gives the same view. The Google-selected canonical can only be read from indexed data, not from the live test. This is the only authoritative check that the renderer sees what we think it sees.
Confidence: High. Sources: [Search Console: URL Inspection](https://support.google.com/webmasters/answer/9012289) (undated); [Google: Fix JS problems](https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript) (2025-12-18).

**F13 Generative AI features in Google Search add no special requirements, and ignore `llms.txt`.**
"To be eligible to be shown in generative AI features on Google Search, a page must be indexed and eligible to be shown in Google Search with a snippet." "Google is able to process content within JavaScript as long as it isn't blocked. That said, working on SEO with a website that uses JavaScript frameworks is generally more complex." On `llms.txt`: "Google Search ignores them." (guide updated 2026-07-10; changelog 2026-06-15). Browser agents "may access your website … analyzing visual renderings (like screenshots), inspecting the DOM structure, and interpreting the accessibility tree", which are real browsers where service workers and WebRTC do run.
Confidence: High. Sources: [Google: optimizing for generative AI features](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) (2026-07-10); [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) (2025-12-10); changelog entries 2026-05-15 and 2026-06-15.


### B. Other search engines and AI crawlers

**F14 Bing renders JavaScript with an Edge-based engine but has recommended dynamic rendering for JS-heavy sites. Only 2018 and 2019 first-party statements could be read (old).**
Bing blog, 2018-10-31: "bingbot is generally able to render JavaScript. However, bingbot does not necessarily support all the same JavaScript frameworks that are supported in the latest version of your favorite modern browser. Like other search engine crawlers, it is difficult for bingbot to process JavaScript at scale on every page of every website, while minimizing the number of HTTP requests at the same time. Therefore, … we recommend dynamic rendering as a great alternative for websites relying heavily on JavaScript." The same post says rendering the same content on the server for bots and on the client for people "is acceptable and not considered cloaking". Bing blog, 2019-10-09: "Bing is adopting Microsoft Edge as the Bing engine to run JavaScript and render web pages … Bingbot will be evergreen." Bing's current Webmaster Guidelines page is a client-rendered app and could not be read, so the present wording is unverified. Whether Bingbot registers service workers, runs WebRTC or keeps IndexedDB is unverified; assume not.
Confidence: Medium (first-party but old). Sources: [Bing blog 2018-10-31](https://blogs.bing.com/webmaster/october-2018/bingbot-Series-JavaScript,-Dynamic-Rendering,-and-Cloaking-Oh-My); [Bing blog 2019-10-09](https://blogs.bing.com/webmaster/october-2019/The-new-evergreen-Bingbot-simplifying-SEO-by-leveraging-Microsoft-Edge).

**F15 IndexNow is the fast-notification path for Bing and friends; Google is not a participant.**
Participating endpoints listed in the FAQ: Bing, Naver, Seznam.cz, Yandex, Yep (no Google mention on either page). Up to 10,000 URLs per POST; the key is 8 to 128 characters (`a-z A-Z 0-9 -`); ownership is proven by a UTF-8 text file `{key}.txt` at the host root (recommended); "Each subdomain is treated as a separate host" and needs its own key file; "Submitting a URL does not guarantee immediate indexing" and "Every URL submitted through IndexNow counts toward your site's crawl quota." A published pointer `seq` bump or a new build is a natural trigger. Microsoft also states (vendor claim, 2026-02-12) that "Microsoft grounding powers nearly every major AI assistant in the market", which, if true, makes the Bing index matter beyond Bing.
Confidence: High (IndexNow mechanics); Low-Medium (grounding claim). Sources: [IndexNow documentation](https://www.indexnow.org/documentation) and [FAQ](https://www.indexnow.org/faq) (both undated); [Bing: Elevating the Role of Grounding on the AI Web](https://blogs.bing.com/search/February-2026/Elevating-the-Role-of-Grounding-on-the-AI-Web) (2026-02-12).

**F16 Applebot may render, wants JS/CSS/XHR unblocked, and follows Googlebot's robots rules if none target it.**
Verbatim: "Applebot may render the content of your website within a browser. If javascript, CSS, and other resources are blocked via robots.txt, it may not be able to render the content properly. This includes XHR, JS, and CSS that the page might require. … make sure that the website renders cleanly, even if all of the resources are not available. This is often referred to as graceful degradation." The search user agent is WebKit-flavoured (`… Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)`). "If robots instructions don't mention Applebot but mention Googlebot, the Apple robot will follow Googlebot instructions." Applebot-Extended opts out of AI training; `nosnippet` keeps content out of AI answers. Whether it runs service workers or WebRTC is unverified.
Confidence: High. Sources: [Apple Support: About Applebot](https://support.apple.com/en-us/119829) (Published 2026-09-04).

**F17 [DC] AI crawlers mostly do not execute JavaScript (last measurement read: Dec 2024).**
Vercel and MERJ: "The results consistently show that none of the major AI crawlers currently render JavaScript." The crawlers listed are OpenAI (OAI-SearchBot, ChatGPT-User, GPTBot), Anthropic (ClaudeBot), Meta (Meta-ExternalAgent), ByteDance (Bytespider) and Perplexity (PerplexityBot). Gemini uses Googlebot's infrastructure (renders); Applebot renders; Common Crawl's CCBot does not. ChatGPT and Claude requested JS files (11.50% and 23.84% of fetches) without executing them. Volumes over one month on Vercel's network: Googlebot 4.5 B fetches (Search and Gemini), GPTBot 569 M, Claude 370 M, Applebot 314 M, PerplexityBot 24.4 M. ChatGPT spent 34.82% of its fetches on 404 pages (Claude 34.16%) and ChatGPT a further 14.36% on redirects, so soft-404 and redirect hygiene matters for them too. This is about 22 months old; I could not read a newer re-run (search budget), so re-verify before quoting as current.
Confidence: Medium-High, dated. Sources: [Vercel: The rise of the AI crawler](https://vercel.com/blog/the-rise-of-the-ai-crawler) (2024-12-17).

### C. Link-preview scrapers

**F18 [DC] Apple Messages previews run no JavaScript, do not follow meta-refresh redirects, and cap the main resource at 1 MB.**
Verbatim from TN3156: "Link previews do not follow `meta` redirects, nor run JavaScript; metadata must be available directly on the linked page. Server-side redirects are followed, however, and are a good alternative." "The main resource located at the previewed link is limited to 1 MB. The total size of associated resources (icons, images, and videos, etc) is limited to 10 MB." "Images should be at least 900 pixels in width. Images less than 150 pixels in width may be ignored or presented as icons." "Icons should be square, at least 108 pixels per side." "Serve the same metadata to both mobile and desktop versions of the page. Clients shouldn't have to change the User-Agent header". Titles: put the site name in `og:site_name`, not in `og:title`. Limits are labelled "guidelines only".
Confidence: High. Sources: [Apple TN3156: Create rich previews for Messages](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages) (republished 2024-04-30; first published 2017-09-08 as TN2444). I read it from Apple's JSON data endpoint because the HTML page is a client-rendered shell.

**F19 Meta (Facebook, Instagram, Messenger) reads Open Graph from the first 1 MB, sends Range requests, and caches by URL.**
Verbatim: "Any Open Graph properties need to be listed before the first 1 MB of your website or app, or it will be cutoff." "Your app or website should either generate and return a response with all required properties according to the bytes specified in the `Range` header of the crawler request or it should ignore the `Range` header altogether." with the test command `curl -v --compressed -H "Range: bytes=0-524288" …`. User agents: `facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)` and `facebookexternalhit/1.1`. "the FacebookExternalHit crawler might bypass robots.txt when performing security or integrity checks." Servers must support gzip and deflate. Other Meta fetchers are documented too (meta-webindexer, meta-externalads, meta-externalagent, meta-externalfetcher; the last "may bypass robots.txt because it performs fetches that were requested by the user"). Images "are cached based on the URL and won't be updated unless the URL changes"; the Sharing Debugger "refreshes any scraped content … more often than the standard 24 hour update period"; specify `og:image:width` and `og:image:height`; `og:url` should be "the undecorated URL, without session variables, user identifying parameters, or counters". The pages are silent on whether the crawler executes JavaScript (unverified; assume it does not, per F18, F20).
Confidence: High for the quoted limits; unverified for JS. Sources: [Meta: web crawlers](https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/), [Meta: webmasters sharing](https://developers.facebook.com/docs/sharing/webmasters/), [Meta: sharing best practices](https://developers.facebook.com/docs/sharing/best-practices/) (all undated; read via WebFetch because curl gets HTTP 400).

**F20 Slackbot-LinkExpanding fetches as little as it can with Range, caches about 30 minutes, and ignores robots.txt.**
Verbatim: "It fetches as little of the page as it can (using HTTP Range headers) to extract meta tags about the content. Specifically, we are looking for oEmbed and Twitter Card / Open Graph tags. If a page's tags refer to an image, video, or audio file, we will fetch that file as well to check validity and extract other metadata." "Responses to these requests are cached globally across the service for around 30 minutes." "We do not currently honor robots.txt files." User agent `Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)`; images go through `Slack-ImgProxy`. The page does not say "no JavaScript", but a Range fetch of markup implies it; the origin should support Range on HTML (GitHub Pages does, measured in F42; Cloudflare Pages documents 200 with a full body, F44; S3 and CloudFront were not tested in this run).
Confidence: High (quotes); the no-JS reading is an inference. Sources: [Slack Robots](https://api.slack.com/robots) (undated).

**F21 LinkedIn requires four `og:` tags and a large image, and cannot fetch images behind protected paths.**
Required: `og:title`, `og:image`, `og:description`, `og:url`. Image: max 5 MB, minimum 1200 × 627, recommended ratio 1.91:1; "Images less than 401 pixels wide display as a thumbnail image"; if the image meets the rules but does not show, "your website may be blocking us from pulling the image or the image may be located on a protected directory or website."
Confidence: Medium-High (help page shows "Last updated: 2 years ago", about 2024). Sources: [LinkedIn Help: Make your website shareable on LinkedIn](https://www.linkedin.com/help/linkedin/answer/a521928).

**F22 X (Twitter) Cards: first-party documentation is no longer published.**
The old documentation URL `developer.twitter.com/en/docs/twitter-for-websites/cards/overview/summary` (still referenced by Apple's TN3156) now redirects (307, then 308) to the X developer overview, and the docs.x.com index (`llms.txt`) lists no Cards or "X for Websites" pages (checked 2026-10-17). Current image limits, JS behaviour and cache rules for Twitterbot are therefore unverified. Slack and Apple still read `twitter:card` tags. Third-party notes say Twitterbot reads `twitter:*` first and falls back to `og:*`.
Confidence: High that first-party docs are gone; Low on behaviour. Sources: [docs.x.com llms.txt](https://docs.x.com/llms.txt); redirect probe of the old URL (E3); [arfct/link-previews crawlers.md](https://raw.githubusercontent.com/arfct/link-previews/main/docs/crawlers.md) (third party, undated).

**F23 Discord, WhatsApp, Telegram: third-party information only.**
One MIT-licensed guide ("distilled from several production implementations") lists the user agents (`Discordbot`, `WhatsApp`, `TelegramBot`), says Discord uses `theme-color`, WhatsApp skips `og:image` files "much over ~600 KB", Telegram can be re-fetched via @WebpageBot, and that "Crawlers don't execute scripts. Everything must be in the raw HTML." I found no first-party documentation for these three.
Confidence: Low-Medium (single third-party source). Sources: [arfct/link-previews README](https://raw.githubusercontent.com/arfct/link-previews/main/README.md) and [crawlers.md](https://raw.githubusercontent.com/arfct/link-previews/main/docs/crawlers.md) (undated).

**F24 [DC] Common denominators for link previews.**
(a) Every scraper reads the raw HTML of the exact URL shared, with no JS and no service worker (Apple, Slack, Meta; third-party for others). (b) `og:image` must be an absolute, publicly fetchable HTTPS URL on the origin, never `blob:`, never SW-only, never behind `/_mw/`. (c) Caches are sticky: Slack about 30 min, Meta by URL until debugger refresh, iMessage per conversation (third party). Publish final metadata before the URL is shared. (d) Redirects must be server-side (Apple ignores meta refresh; a JS redirect from a hub to a domain gives no preview). (e) Hash URLs, `magnet:` links and `?mw=` pointer URLs have no per-site preview.
Confidence: High for a to d; (c) iMessage part is third-party. Sources: F18 to F23.

**F25 Google also reads `og:image`.**
Changelog 2026-03-02: "Google uses both schema.org markup and the og:image meta tag as sources when determining image thumbnails in Google Search and Discover." So one well-formed Open Graph block serves both previews and Search thumbnails.
Confidence: High. Sources: [Search Central changelog](https://developers.google.com/search/updates) (entry 2026-03-02).

### D. Search-feature churn (do not build on these)

**F26 Several structured-data features ended in 2025–2026; `llms.txt` has no effect on Google.**
FAQ rich results: deprecation notice 2026-05-08, "will no longer appear in Google Search starting May 7, 2026", documentation removed 2026-06-15. Documentation removed 2025-09-09 for course info, estimated salary, learning video, special announcement, vehicle listing ("no longer shown in Google Search results"). Practice problems deprecated 2025-11-05 and removed 2026-01-06; Dataset markup "is only used by Dataset Search, and not Google Search". `llms.txt`: ignored by Google Search, neither helps nor hurts (2026-06-15; guide 2026-07-10). Plan Organization, Article, Product, BreadcrumbList style markup only if the content genuinely fits; do not add FAQ or `llms.txt` work to the migration checklist.
Confidence: High. Sources: [Search Central changelog](https://developers.google.com/search/updates); [Google AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) (2026-07-10).

### E. Prerendering and dynamic rendering: status

**F27 [DC] Dynamic rendering is a "workaround … not a recommended solution". It is not literally labelled "deprecated", and build-time rendering is the recommendation.**
Verbatim: "Dynamic rendering was a workaround and not a long-term solution for problems with JavaScript-generated content", "Dynamic rendering is a workaround and not a recommended solution, because it creates additional complexities", "Instead, we recommend that you use server-side rendering, static rendering, or hydration as a solution." Cloaking: "Googlebot generally doesn't consider dynamic rendering as cloaking. As long as your dynamic rendering produces similar content, Googlebot won't view dynamic rendering as cloaking. … Using dynamic rendering to serve completely different content to users and crawlers can be considered cloaking." Dynamic rendering "requires your web server to detect crawlers (for example, by checking the user agent)", which a static host without a backend cannot do; a static export (static rendering) is the fit for us. The JS basics page no longer discusses dynamic rendering in its body.
Confidence: High. Sources: [Google: Dynamic rendering as a workaround](https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering) (Last updated 2025-12-10); [Google: JS basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) (2026-03-04).

**F28 Rendertron is deprecated; engines disagree about dynamic rendering.**
Google Chrome Labs' README: "Rendertron is deprecated. Please note that this project is deprecated. Dynamic rendering is not a recommended approach and there are better approaches to rendering on the web. Rendertron will not be actively maintained at this point." Bing recommended dynamic rendering in 2018 (F14) and I could not read a newer Bing position. Commercial prerender services still exist but would need a backend or edge function we do not have.
Confidence: High (Rendertron); Medium (Bing). Sources: [Rendertron README](https://raw.githubusercontent.com/GoogleChrome/rendertron/main/README.md) (undated); [Bing blog 2018](https://blogs.bing.com/webmaster/october-2018/bingbot-Series-JavaScript,-Dynamic-Rendering,-and-Cloaking-Oh-My).

**F29 Static export frameworks produce one HTML file per route; Create React App is deprecated.**
Next.js static export: "When running next build, Next.js generates an HTML file per route" (e.g. `/out/index.html`, `/out/blog/post-1.html`); Client Components are prerendered to HTML at build time (docs updated 2026-08-09). React team, 2025-02-14: Create React App is deprecated; "we're deprecating Create React App for new apps, and encouraging existing apps to migrate to a framework, or to migrate to a build tool like Vite, Parcel, or RSBuild"; the recommended frameworks "can be deployed to a CDN or static hosting service without a server". Migration consequence: a CRA-style SPA (empty root element in the delivered HTML) needs a prerendering step or framework move before it can be a magnet-web site that is also searchable.
Confidence: High. Sources: [Next.js: Static Exports](https://nextjs.org/docs/app/guides/static-exports) (updated 2026-08-09); [React: Sunsetting Create React App](https://react.dev/blog/2025/02/14/sunsetting-create-react-app) (2025-02-14).


### F. Robots, canonicals, sitemaps and hub URLs

**F30 [DC] robots.txt is per host, must be a real file, and cannot be served by a service worker.**
Verbatim: "The rules listed in the robots.txt file apply only to the host, protocol, and port number where the robots.txt file is hosted." Status handling: 2xx is processed as served; "Google's crawlers treat all 4xx errors, except 429, as if a valid robots.txt file didn't exist. This means that Google assumes that there are no crawl restrictions."; on 5xx "For the first 12 hours, Google stops crawling the site", then uses the last good copy for up to 30 days. It follows at least five redirect hops but "doesn't follow logical redirects in robots.txt files (frames, JavaScript, or meta refresh-type redirects)". Cached up to 24 hours; maximum 500 KiB. A `Sitemap:` line may point to another host. Consequence: every hosted origin (each wildcard hub subdomain too) needs its own `/robots.txt`; a SPA fallback that answers `/robots.txt` with the shell and HTTP 200 would be processed as a robots file (behaviour for an HTML body is unverified; do not rely on it).
Confidence: High. Sources: [Google: robots.txt specification](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt) (Last updated 2026-08-31).

**F31 robots.txt blocks crawling, not indexing, and hides `noindex`; use `X-Robots-Tag` or a meta tag to keep pages out.**
Verbatim: "If a page is disallowed from crawling through the robots.txt file, then any information about indexing or serving rules will not be found and will therefore be ignored. If indexing or serving rules must be followed, the URLs containing those rules cannot be disallowed from crawling." And: "Don't use the robots.txt file for canonicalization purposes. Google may still index URLs that are disallowed in robots.txt without their content." `X-Robots-Tag` "can be used as an element of the HTTP header response for a given URL" and accepts every robots-meta rule; `data-nosnippet` works on `span`, `div` and `section`, and "do not add or remove the data-nosnippet attribute of existing nodes through JavaScript" (add it when the node is first created). `indexifembedded` (see F41) exists only together with `noindex`. Link-preview bots mostly ignore robots.txt (Slack: does not honour it; Meta: may bypass), so robots.txt is not a way to hide pages from previews.
Confidence: High. Sources: [Google: robots meta tag, data-nosnippet, X-Robots-Tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) (2026-03-24); [Google: Canonicalization](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) (2026-07-10).

**F32 Canonical signals: redirects and `rel=canonical` are strong, sitemaps weak; an HTTP `Link` header works; the URL must not be a fragment.**
Order of influence per Google: redirects are "A strong signal", `rel="canonical"` link annotations are "A strong signal", and sitemap inclusion is "A weak signal". The `rel="canonical"` HTTP header is supported ("Only works for HTML pages, not for files such as PDF. In such cases, you can use the rel="canonical" HTTP header."). Use one method consistently; self-referential canonicals; "When linking within your site, link to the canonical URL rather than a duplicate URL." Parameters such as tracking or a loader pointer (`?mw=…`) are consolidated through canonicals. Use `noindex` only when you want a page excluded entirely, not to choose between duplicates within a site.
Confidence: High. Sources: [Google: Canonicalization](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) (2026-07-10).

**F33 Sitemap rules.**
"All formats limit a single sitemap to 50MB (uncompressed) or 50,000 URLs." UTF-8; absolute URLs; "unless you submit your sitemap through Search Console, a sitemap affects only descendants of the parent directory", so root is recommended. "Google ignores `<priority>` and `<changefreq>` values. Google uses the `<lastmod>` value if it's consistently and verifiably … accurate" (significant changes only; a copyright-year bump is not significant). Cross-site submission works through Search Console or a `Sitemap:` line in each verified site's robots.txt. Submission "is merely a hint". An RSS or Atom feed can be submitted as a sitemap.
Confidence: High. Sources: [Google: Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) (Last updated 2026-07-08).

**F34 [DC] Hub-mode URL identity: fragments collapse for Google and for Safe Browsing; subdomain hubs have their own limits.**
(a) Google: F5. (b) Safe Browsing canonicalization says "if the URL ends in a fragment, remove the fragment" (its example shortens `http://google.com/#frag` to `http://google.com/`), and clients also test host-suffix expressions (for `http://a.b.c/1/2.html` they try `a.b.c/…` then `b.c/…`). Inference: a blocklist entry for `hub.example/` covers every fragment-addressed site on that hub and every `*.hub.example` host; per-site subdomains allow an entry for just one subdomain. (c) Search Console: Domain properties need DNS verification and "We don't support domain-property verification of public suffixes." (d) The operator of eth.limo (ENS gateway, 2026-09-10) lists Search Console domain properties and Google Safe Browsing among consumers of the Public Suffix List (Safe Browsing under the ICANN section, so a private PSL entry would not change it) and argues PSL inclusion is slow, opaque and hard to roll back. That article is a single, opinionated source.
Confidence: High for (a) to (c); Medium for the inference and (d). Sources: [Google Safe Browsing: URLs and Hashing](https://developers.google.com/safe-browsing/v4/urls-hashing) (undated); [Search Console: property types](https://support.google.com/webmasters/answer/34592) (undated); [eth.limo: The Public Suffix List is a Disaster](https://ethlimo.substack.com/p/the-public-suffix-list-is-a-disaster) (2026-09-10); F5.

**F35 Site-reputation policy argues for `noindex` on third-party content hosted under a shared hub.**
Policy text: it "applies where third-party content is published on a host site mainly because of that host's already-established ranking signals". "Sites designed to allow user-generated content, such as a forum website or comment sections" are not inconsistent. A public hub that lets arbitrary third-party sites be indexed under its (possibly reputable) domain risks being treated as such a host; default `noindex` on hub origins removes the question. Medium (policy text is clear; its application to a hub is my inference).
Sources: [Google: Spam policies](https://developers.google.com/search/docs/essentials/spam-policies) (Last updated 2026-08-28).

### G. Precedents: how other decentralised or P2P sites handle crawlers

**F36 [DC] The IPFS Service Worker Gateway, our closest analogue, opts out of indexing entirely. (Measured 2026-10-17.)**
A GET of `https://<CID>.ipfs.inbrowser.link/` (sent with a Googlebot-like User-Agent) returned HTTP 200, `x-robots-tag: noindex, nofollow`, `cache-control: public, max-age=0, must-revalidate`, `server: cloudflare`, a 12,008-byte bootstrap page titled "IPFS Service Worker Gateway | HEAD@7256355" whose meta description is "Static HTML page that bootstraps a verifiable IPFS gateway in your browser", no Open Graph tags and no `<noscript>`. The path-style URL `https://inbrowser.link/ipfs/<CID>/` returned a 301 to the subdomain URL, also with `x-robots-tag: noindex, nofollow`. The README describes a service worker registered on first load that intercepts `/ipfs/*` and `/ipns/*`, runs only in subdomain mode, and says its goals are robustness and lower hosting cost; SEO is not a goal. It also records that Shipyard "maintained it in 2024, 2025 and 2026" and that "Shipyard's IPFS maintenance work ended in Q3 2026"; two named maintainers now act for the IPFS Foundation. Lesson: the team that built the pattern treats in-browser retrieval as non-indexable and says so in headers.
Confidence: High (measured; README). Sources: [service-worker-gateway README](https://raw.githubusercontent.com/ipfs/service-worker-gateway/main/README.md) (fetched 2026-10-17); header probe E3.

**F37 docs.ipfs.tech publishes to IPFS and to a conventional origin in parallel.**
DNSLink maps a name to content with a TXT record: `_dnslink.docs.ipfs.tech` carries `"dnslink=/ipfs/<CID>"` (the docs show a 30 s TTL; the live record I resolved is reached through a CNAME into `dnslinks.ipshipyard.tech`). Yet an HTTPS request to `docs.ipfs.tech` is answered with `server: GitHub.com`, `cache-control: max-age=600`, `access-control-allow-origin: *` and full static HTML. So the project's own documentation relies on an ordinary static host for browsers and crawlers and treats the content-addressed copy as an additional channel, which is exactly the posture proposed for embedded mode. The `_dnslink.<host>` TXT pattern also parallels our `_magnet.<host>` pointer.
Confidence: Medium-High (the dual-hosting reading is an inference from headers). Sources: [IPFS Docs: DNSLink](https://docs.ipfs.tech/concepts/dnslink/) (undated); header and DNS probe E3.

**F38 ENS sites get SEO from a server-side gateway that returns normal HTML and the site's own robots.txt. (Measured.)**
`https://vitalik.eth.limo/` returned HTTP 200 with the full HTML document in the first bytes (no JavaScript needed), `etag` equal to the content CID, `x-ipfs-path` and `x-ipfs-roots` headers, `cache-control: max-age=300, must-revalidate`, `content-security-policy: frame-ancestors 'self'`, `server: eth.limo`; `/robots.txt` returned 200 with the site's own rules (`Disallow: /wiki/ …`). The site owner controls files inside the content, not HTTP headers: `X-Robots-Tag` or a canonical `Link` header cannot be set per site. Contrast with magnet-web: a gateway is a server that fetches on behalf of the crawler, we have none, so the web-seed host takes that role. Whether Google indexes `*.eth.limo` content is unverified (no search).
Confidence: High (measured). Sources: [eth.limo](https://eth.limo/) (undated); header probe E3.

**F39 peerweb.lol (WebTorrent site host) gives every hosted site the loader's own metadata.**
`https://peerweb.lol/?orc=<infohash>` returned the same 48,254-byte HTML as the home page, titled "PeerWeb - Decentralized Website Hosting", with 5 Open Graph tags, no canonical, no robots meta, and no `X-Robots-Tag`; `/robots.txt` and `/sitemap.xml` returned 404. Its page says sites run "in isolated iframe" after DOMPurify sanitisation and that a tab must stay open to host. Every shared peerweb link would preview as "PeerWeb", and the hosted sites are not indexable. This is the failure mode of shell/hub mode without any SEO design.
Confidence: High (measured). Sources: [peerweb.lol](https://peerweb.lol/) (undated); probe E3.

**F40 [DC] PeerTube (WebTorrent in the browser with an HTTP web-seed fallback) solves crawlers and previews on the server by injecting tags into its SPA shell for each URL.**
In `server/core/lib/html/shared/tags-html.ts` (develop branch, read 2026-10-17) the server replaces placeholder comments in the SPA's `index.html` with: `<title>`, `<meta name="description">`, Open Graph (`og:type`, `og:site_name`, `og:title`, `og:image` plus width and height, `og:url`, `og:description`, `og:video:*`), Twitter Card (`twitter:card`, `twitter:site`, `twitter:title`, `twitter:description`, `twitter:image:url`, `twitter:player*`), an oEmbed `<link rel="alternate" type="application/json+oembed">`, schema.org JSON-LD (`<script type="application/ld+json">`), `rel="me"`, RSS alternates, favicon and apple-touch-icon, and either `<meta name="robots" content="noindex">` (`forbidIndexation`), `<meta name="robots" content="noindex, indexifembedded">` (embed pages) or `<link rel="canonical">`. Values are escaped (`escapeAttribute`, `escapeHtmlJSONStr`). `sendHTML` sets `Cache-Control: max-age=0, no-cache, must-revalidate`, `serveIndexHTML` answers non-HTML `Accept` headers with 406, and `/sitemap.xml` is generated dynamically (videos, channels, accounts). A mature P2P video platform therefore still produces its crawler and preview HTML server-side; for a backend-free system the equivalent is build-time generation (publish step), never client-side injection.
Confidence: High (source code). Sources: PeerTube source: [tags-html.ts](https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/server/core/lib/html/shared/tags-html.ts), [client-html.ts](https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/server/core/lib/html/client-html.ts), [sitemap.ts](https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/server/core/controllers/sitemap.ts) (fetched 2026-10-17).

**F41 Google documents `indexifembedded`, which implies iframe content is considered part of the embedding page; our iframe URL is unreachable for crawlers anyway.**
For `indexifembedded` the docs say: "Google is allowed to index the content of a page if it's embedded in another page through iframes or similar HTML tags, in spite of a noindex rule." and "indexifembedded only has an effect if it's accompanied by noindex." I found no first-party statement beyond this on how iframe content is attributed. In shell mode the content lives in an iframe at `/_mw/s/<btih>/…`, a path only the service worker answers; a crawler's request for it reaches the static host and gets a 404 or the shell. So the iframe route offers no indexable content whatever Google's attribution rule is.
Confidence: Medium (official text; implication inferred). Sources: [Google: robots meta tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) (2026-03-24).

### H. Static-host behaviours that decide whether the origin can act as crawler fallback

**F42 GitHub Pages: real 404 for unknown paths, CORS `*`, correct 206 Range. (Measured 2026-10-17 on pages.github.com.)**
Unknown path: `HTTP/2 404` with a 9,379-byte custom page. Known page: `HTTP/2 200`, `cache-control: max-age=600`, `access-control-allow-origin: *`, `accept-ranges: bytes`. A Range request returned `HTTP/2 206` with `content-range: bytes 0-99/14446`. Limits per docs: published sites up to 1 GB, soft bandwidth limit 100 GB per month, soft limit 10 builds per hour (not applied to custom Actions workflows), and "GitHub Pages is not intended for or allowed to be used as a free web-hosting service to run your online business, e-commerce site, or any other website that is primarily directed at either facilitating commercial transactions or providing commercial software as a service". Jekyll drops files and directories whose names start with an underscore unless a `.nojekyll` file is present (GitHub blog, 2016, so older): a physical `/_mw/` stub would vanish without it. I found no documented way to set custom response headers on GitHub Pages (absence not proven).
Confidence: High (measured, docs); Medium for the Jekyll note (2016). Sources: probe E3; [GitHub Docs: Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits); [GitHub Docs: custom 404 page](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-custom-404-page-for-your-github-pages-site); [GitHub Blog: Bypassing Jekyll on GitHub Pages](https://github.blog/news-insights/the-library/bypassing-jekyll-on-github-pages/) (2016).

**F43 Netlify and CloudFront can both produce soft 404s; both offer header control.**
Netlify: "When you assign an HTTP status code of 200 to a redirect rule, it becomes a rewrite" (the standard SPA fallback), custom headers through `_headers` or `netlify.toml`. CloudFront custom error responses can return a chosen page and change the response code; response headers policies add CORS and custom headers. Static multi-page sites must not map 404 to 200.
Confidence: High. Sources: [Netlify: rewrites and proxies](https://docs.netlify.com/routing/redirects/rewrites-proxies/); [Netlify: headers](https://docs.netlify.com/routing/headers/); [CloudFront: custom error responses](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GeneratingCustomErrorResponses.html); [CloudFront: response headers policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-response-headers.html) (all undated).

**F44 [DC] Cloudflare Pages defaults are hostile to both the SEO fallback and the web seed.**
(a) "If your project does not include a top-level 404.html file, Pages assumes that you are deploying a single-page application … serves the root (/) for any incoming path that does not correspond to a static asset", so unknown URLs, including `/robots.txt` if absent, answer 200 with the app shell (soft 404). (b) "Pages will also redirect HTML pages to their extension-less counterparts: for instance, /contact.html will be redirected to /contact", so canonical URLs must be the extension-less form and a web seed path ending `.html` is redirected. (c) "Pages currently returns 200 responses for HTTP range requests; however, the team is working on adding spec-compliant 206 partial responses." This matters for the web seed: in this repo's webtorrent 3.0.21, `lib/webconn.js` sends `range: bytes=<start>-<end>`, accepts any `res.ok` response (200 or 206) and uses the whole body as that block's data without checking `Content-Range` or slicing, so a full-file 200 would hand it the wrong bytes for every file larger than the requested range and the piece-hash check would reject them (reading of the code; not run against Pages). Slack and Meta Range fetches would merely receive full bodies. The Cloudflare page is undated, so re-test with `curl -r 0-99` before choosing Pages as a web-seed host. (d) A `_headers` file can add `X-Robots-Tag` and CORS headers but the docs say the file's headers "are not applied to responses generated by Pages Functions".
Confidence: High that the documentation says this; behaviour today unverified. Sources: [Cloudflare Pages: serving pages](https://developers.cloudflare.com/pages/configuration/serving-pages/) and [headers](https://developers.cloudflare.com/pages/configuration/headers/) (both undated).


### I. Performance, Core Web Vitals and browser lifecycle

**F45 Core Web Vitals thresholds and how PageSpeed Insights measures them.**
Google: LCP within 2.5 seconds, INP below 200 ms, CLS below 0.1, and Core Web Vitals "aligns with what our core ranking systems seek to reward". PageSpeed Insights reports field data from the Chrome UX Report (trailing 28 days, 75th percentile; a page passes if the 75th percentile of each metric is good) and lab data from Lighthouse, which "simulates the page load conditions of a mid-tier device (Moto G4) device on a mobile network" (the page may lag the current Lighthouse emulation profile). Lighthouse's default simulated "Slow 4G" is latency 150 ms and throughput 1.6 Mbps down and 750 Kbps up, with CPU throttling expressed relative to the host (the doc's table suggests a 4x slowdown for a high-end desktop host emulating a mid-tier mobile).
Confidence: High. Sources: [Google: Core Web Vitals and Search](https://developers.google.com/search/docs/appearance/core-web-vitals) (2025-12-10); [PageSpeed Insights: about](https://developers.google.com/speed/docs/insights/v5/about) (undated); [Lighthouse throttling](https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/docs/throttling.md) (undated).

**F46 [DC] Lab tests are first visits with no service worker and no cache, so the loader is pure overhead there.**
The Lighthouse CLI documents `--disable-storage-reset: Disable clearing the browser cache and other storage APIs before a run`, so by default storage is cleared before every run. A lab run (including PageSpeed Insights) therefore never benefits from a registered service worker, an IndexedDB copy or swarm data; only the first-visit path (origin HTML, origin assets, loader cost) is scored. Field data (CrUX) mixes first and repeat visits, where the swarm and cache can help. Measured cost of the biggest dependency: `webtorrent.min.js` is 222,929 B raw, 64,428 B gzip -9, 55,969 B brotli -11 (E4), roughly 0.28 to 0.32 s of pure transfer at 1.6 Mbps before RTT, parse and execution. The repo's boot code says "the loader is about 300 KB on first visit". It must not compete with the LCP resource or add main-thread time before LCP.
Confidence: Medium-High (the default is inferred from the documented opt-out flag); sizes measured. Sources: [Lighthouse README](https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/readme.md) (undated); E4.

**F47 CrUX counts LCP inside iframes; the in-page JavaScript API does not.**
Verbatim: "The API does not consider elements within iframes but the metric does as they are part of the user experience of the page. In pages with an LCP within an iframe—for example a poster image on an embedded video—this will show as a difference between CrUX and RUM. … Sub-frames can use the API to report their largest-contentful-paint entries to the parent frame for aggregation." The `web-vitals` library does not cover the iframe case and cross-origin frames cannot be measured from JS. In shell mode (full-viewport iframe) the Chrome metric follows the iframe's content while any RUM script in the shell sees only the shell, so lab, field and in-page numbers will disagree. Embedded mode has no iframe and avoids this.
Confidence: High. Sources: [web.dev: Largest Contentful Paint](https://web.dev/articles/lcp) (undated).

**F48 bfcache: open WebRTC, IndexedDB and in-flight fetches can block it; `Cache-Control: no-store` on the page can too.**
web.dev: browsers may not put a page in bfcache with "an open IndexedDB connection", "in-progress fetch() or XMLHttpRequest" or "an open WebSocket or WebRTC connection. Chrome (as of 149) and Safari do no [sic] block on open WebSockets but other browsers do."; recommended: close connections on `pagehide` or `freeze`, reopen on `pageshow` or `resume`. "Historically, when `Cache-Control: no-store` is set on the page resource itself … browsers have chosen not to store the page in bfcache", with Chrome work underway to change that. Back/forward restores are fast navigations that raise field LCP quality, so a P2P loader that holds sockets open, or a service worker that stamps `no-store` on HTML, gives up that win (see E5 for the repo's current behaviour).
Confidence: High. Sources: [web.dev: Back/forward cache](https://web.dev/articles/bfcache) (published 2023-05-25, updated 2026-10-16).

**F49 Chrome may prerender a page before the user visits it; side effects must wait.**
Chrome "may automatically prerender the page for you, if it has high confidence you will visit that page", including search-results pages when the search engine asks for it; use `document.prerendering` and the `prerenderingchange` event "to prevent—or delay—certain activities during the prerender until the page is actually activated"; Google Analytics already waits for activation. A loader that opens WebRTC connections, announces to trackers or starts hashcash work during a prerender exposes the visitor's IP and burns CPU for a page they may never open, and contradicts the privacy notice in ARCHITECTURE §8.
Confidence: High. Sources: [Chrome for Developers: Prerender pages](https://developer.chrome.com/docs/web-platform/prerender-pages) (published 2022-12-02, updated 2026-01-23).

### J. Policy risks that constrain the design

**F50 [DC] Cloaking is judged by intent to manipulate and mislead; equivalent content from different delivery paths is not cloaking.**
Verbatim: "Cloaking refers to the practice of presenting different content to users and search engines with the intent to manipulate search rankings and mislead users." and "If your site uses technologies that search engines have difficulty accessing, like JavaScript or images, see our recommendations for making that content accessible to search engines and users without cloaking." Dynamic rendering with similar content is not cloaking (F27); Bing says the same (F14). Consequence: the swarm-delivered copy and the origin copy of the same URL must be the same bytes. A service worker that rewrites HTML for returning visitors (as one case study in the searchVIU piece did with titles and structured data) can be read as showing crawlers and users different content.
Confidence: High (policy text); the SW-rewrite consequence is an inference. Sources: [Google: Spam policies](https://developers.google.com/search/docs/essentials/spam-policies) (2026-08-28); F27; F14.

**F51 [DC] "Back button hijacking" is an explicit spam-policy violation (announced 2026-04-13, enforced from 2026-06-15).**
Policy text: "Back button hijacking is when a site interferes with user browser navigation by manipulating the browser history or other functionalities, preventing them from using their back button to immediately get back to the page they came from." Blog: pages may get "manual spam actions or automated demotions"; "If you're currently using any script or technique that inserts or replaces deceptive or manipulative pages into a user's browser history that prevents them from using their back button to immediately get back to the page they came from, you are expected to remove or disable it"; and "some instances of back button hijacking may originate from the site's included libraries", so injected loader code is the site owner's responsibility. A loader that mirrors an iframe path into the top URL, runs bootstrap redirects (hub to wildcard host, SW first-install reload) or uses `pushState` can trip this if it ever leaves an intermediate entry that bounces the visitor forward again.
Confidence: High. Sources: [Google Search Central Blog](https://developers.google.com/search/blog/2026/04/back-button-hijacking) (2026-04-13); [Google: Spam policies](https://developers.google.com/search/docs/essentials/spam-policies) (2026-08-28).

**F52 User-generated content must be qualified and moderated if it is ever made indexable.**
"We recommend marking user-generated content (UGC) links, such as comments and forum posts, with the ugc value." (`rel="ugc"`; `nofollow` is also accepted). Google's spam policies include a user-generated spam section ("Spammy posts on forum threads", "Comment spam on blogs"). Chain content (guestbook, comments) is user-generated by an open writer set; owner moderation (tombstones) must be applied before any publish-time snapshot, and PeerTube-style escaping (`escapeAttribute`) applies to anything interpolated into meta tags.
Confidence: High. Sources: [Google: Qualify your outbound links](https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links) (2025-12-10); [Google: Spam policies](https://developers.google.com/search/docs/essentials/spam-policies) (2026-08-28).

### K. Local evidence (this repo and this machine, 2026-10-17)

**E1 [DC] The example site seen as a JS-capable crawler without a service worker (Playwright Chromium, clean profile, SW blocked, GitHub-Pages-like static server where unknown paths return 404 with `404.html`).**
Status 200, title "Peer Guestbook", meta description present. No canonical, no Open Graph, no Twitter tags, no JSON-LD. `#standalone` notice visible. `GET /_mw/sdk.js` returned 404 (a failed resource in any crawler report). Rendered body text (897 characters) began: "Peer Guestbook Delivered by magnet link. Kept alive by its visitors. Guestbook About Open this site through the magnet-web loader. You are viewing the static files directly, so the live parts (peers, chain, guestbook) are off. The loader SDK at /_mw/sdk.js is not served here. Live Visitors online — Chain height — …" and the notice repeats under the guestbook. The same page with JavaScript off (what link-preview bots and most AI crawlers see) is 615 characters of skeleton with placeholders ("Waiting for the loader…", "Connecting to the loader…", "Version …, built …") and no guestbook content. So today a crawler indexes a developer-facing notice, and link previews are title and description only.
**E2 [DC] The production shell (`src/loader/index.html`) as a no-JS bot, behind a GitHub-Pages-like host.**
Root URL: status 200, title "magnet-web", description "Loads a website by magnet link from other visitors, with a shared signed log as its database.", canonical none, Open Graph 0, body text "Loading the peer-to-peer loader… JavaScript is required This site is delivered peer-to-peer by a small in-browser loader. Enable JavaScript …". Deep link `/about.html`: status 404 with the identical page. So in shell mode every URL has the same title and description, no per-site metadata exists, and every deep link is a 404.
**E3 Header and DNS probes (plain GET/HEAD).** pages.github.com: unknown path 404, ACAO `*`, Range 206 (F42). `docs.ipfs.tech`: `server: GitHub.com`; TXT `_dnslink.docs.ipfs.tech` returns a `dnslink=/ipfs/…` value (F37). `vitalik.eth.limo`: 200, `x-ipfs-path`, site robots.txt (F38). `<CID>.ipfs.inbrowser.link`: `x-robots-tag: noindex, nofollow` (F36). `peerweb.lol/?orc=…`: 48,254 B generic page, `/robots.txt` and `/sitemap.xml` 404 (F39). `developer.twitter.com/…/cards/overview/summary`: 307 then 308 to docs.x.com overview (F22).
**E4 Bundle sizes (measured with gzip -9 and brotli -q11).** `node_modules/webtorrent/dist/webtorrent.min.js`: 222,929 B raw, 64,428 B gzip, 55,969 B brotli. The unminified loader, SW and SDK sources total 153,577 B (`src/loader/*.js`, `src/sw/*.js`, `src/sdk/sdk.js`). `dist/` has not been built yet, so the real first-visit transfer is unmeasured.
**E5 Code reading: behaviours that matter to this topic.**
(a) `src/loader/app.js:812-817`: `pagehide` always sets `S.destroyed`, closes the chain node and the torrent manager; `pageshow` with `e.persisted && S.destroyed` calls `location.reload()`, so a bfcache restore is followed by a full reload (the instant restore is wasted). (b) `src/sw/sw.js:156-166`: every site response carries `Cache-Control: no-store`; fine for iframe sub-documents, harmful for bfcache if the SW ever serves top-level HTML in embedded mode. (c) `src/sw/sw.js:83-84, 214-227`: navigations are network-first with a 3 s timeout, a 404 from the host is answered with the cached shell, so embedded mode's existing-file navigations already pass through to the origin. (d) `src/loader/render.js:243` uses `history.replaceState` only; `:305` uses `location.replace` for popstate-driven iframe navigation; no `pushState` anywhere. Good against F51. (e) `src/loader/boot.js:43-53` feature-checks IndexedDB and `RTCPeerConnection` (required) and `serviceWorker` (optional) and renders a static error message when a required feature is missing; in embedded mode that message must never replace page content. (f) `examples/peer-guestbook/js/app.js:85-91, 266` shows the `#standalone` developer notice whenever `/_mw/sdk.js` cannot be imported (E1). (g) `examples/peer-guestbook/404.html` carries `<meta name="robots" content="noindex">`, which is correct for an error page.


---

## 4. What the evidence means for the architecture

**Delivery modes against search and previews.**

| Mode | What a crawler fetches | What it gets | Indexable? | Per-page link previews? | Verdict |
|---|---|---|---|---|---|
| Shell, per-domain (ARCHITECTURE §3 primary) | `https://example.com/about.html` | GitHub Pages: HTTP 404 plus the shell. Cloudflare Pages without 404.html or CloudFront 404→200: HTTP 200 plus the same shell. Same title for every URL (E2) | No (404 is not rendered; 200 shell is a soft-404 duplicate) | No (generic) | Apps, demos, members-only. Never for a site that needs search or social traffic |
| Hub, fragment (`hub.example/#btih:…`) | `hub.example/` | One generic page for every site (F5, F34, F39) | No | No | Mark `noindex`; share button should copy the per-domain URL |
| Hub, wildcard subdomain (`<hash>.hub.example`) | Per-site host | Bootstrap shell (F36) | A URL exists but has no content | No | `X-Robots-Tag: noindex, nofollow`, as the IPFS SW gateway does |
| **Embedded (drop-in)** | The site's existing URLs | The site's own HTML, byte-identical to the swarm copy | Yes, exactly as today | Yes, if OG tags are in the HTML | **Default migration target** |
| Embedded plus optional preview edge function (hub operators only) | Hub URLs | For allow-listed bot user agents the web-seed HTML for that path (dynamic rendering with identical bytes) | Only if equivalent and the operator opts in | Yes | Optional (R15) |

**Promises the architecture should make to site owners (compatibility invariants).**
- I1 Origin completeness: every indexable URL returns full final HTML with a correct status code without JS, service worker, WebRTC, IndexedDB or cookies.
- I2 Byte identity: for any path, the swarm copy and the origin copy are the same bytes; one build output feeds origin, web seed and torrent.
- I3 Honest status codes: unknown paths return 404; no SPA-style 200 fallback on a multi-page site.
- I4 Root control files (`robots.txt`, `sitemap.xml`, IndexNow key, favicon, OG images) are real origin files.
- I5 The loader never edits SEO-relevant head tags or visible content; its UI is appended, labelled `data-nosnippet`, and its failures are silent to the document.
- I6 History is replace-only; Back always returns to the previous page in one step.
- I7 Hub origins are `noindex` unless the operator explicitly opts a site in.
- I8 No loader pointer (`#magnet:…`, `?mw=…`) on any indexable or shareable URL.

**ARCHITECTURE.md sections that should change.** §3 add embedded mode and make it the production default; §4 note that `<meta name="mw-pointer">` is harmless to crawlers and the DNS TXT is invisible to them; §5 loader start after `load` and idle, and not while prerendering, with `pagehide`/`pageshow` re-init instead of reload; §7 service worker: pass HTML through, never answer an origin 404 with the cached page in embedded mode (today's `handleNavigation` does), `no-cache` not `no-store` for HTML; §10 add `publish --embed`, `seo-lint`, `verify-origin`, sitemap/robots/IndexNow outputs; §13 note that the shell's CSP meta tag does not apply to embedded pages, whose own policy must allow the same-origin loader script.

---

## 5. Concrete recommendations for magnet-web

### 5.1 Backlog

Effort: S under 2 days, M 2 to 8 days, L over 8 days. Priority: P0 blocks any "production-ready" claim for sites that need search or previews; P1 needed before public launch; P2 valuable; P3 later.

| ID | Pri | Effort | What to build or change | Why (findings) | Acceptance test |
|---|---|---|---|---|---|
| R1 | P0 | M | Define **embedded mode** as the default migration target and write its contract. `tools/publish.mjs --embed` copies the site tree unchanged, injects into every `*.html` (idempotent marker): `<meta name="mw-pointer">` and `<script type="module" src="/_mw/boot.js" async>`, then builds the torrent from the post-injection tree so origin and swarm are identical; deploys static `/_mw/` stubs (R3). Keep shell mode for apps/hub | F1–F4, F24, F36, F39, E1, E2 | `curl` of every page returns full HTML. With SW blocked and WebRTC unavailable the rendered text equals the raw text |
| R2 | P0 | M | `tools/verify-origin.mjs <site.torrent> <origin-url>`: fetch every file over HTTP and compare to torrent hashes; run after each deploy and in CI; flag hosts that answer Range with 200. The SW must serve swarm HTML only when its hash matches, otherwise the network | F50, F27, F44 | Changing one byte on the origin fails CI; a Range-200 host is reported |
| R3 | P0 | S–M | **Crawler-inert loader (embedded mode)**: never replace/hide/reorder existing DOM; one appended status container with `data-nosnippet` (created with the attribute); failures to console and status chip only; ship a static `/_mw/sdk.js` stub that resolves `{mode:'static'}`; reword or `hidden` the example site's `#standalone` notice; keep `boot.js` hard-fail messages for shell mode only | F2–F4, F16, F31, E1, E5(e,f) | Re-run E1: rendered text equals raw text; no failed `/_mw/*` requests |
| R4 | P0 | M | `tools/seo-lint.mjs` CI gate: UA matrix GETs (Googlebot-like, facebookexternalhit, Slackbot, Twitterbot, curl) must return identical bodies; title, description, absolute self-canonical, no raw `noindex`; OG/Twitter completeness and image fetch/size/dimensions; JSON-LD parses; no hash routes; unknown path is 404; robots.txt/sitemap valid; size budgets; rendered-vs-raw diff via Playwright (SW blocked, storage cleared); Lighthouse SEO category | F5–F8, F18–F24, F30–F33 | Fails on each seeded defect, passes on the example site |
| R5 | P0 | S | Host recipes in DEPLOY.md for GitHub Pages, Cloudflare Pages, Netlify, S3+CloudFront: real 404, no SPA 200 fallback on multi-page sites, root control files, header mechanism (`_headers`, response-headers policy), `.nojekyll`, Range check, extension-redirect quirk, web-seed path | F7, F42–F44 | Each recipe passes `seo-lint --probe-host` on a throwaway deployment |
| R6 | P0 | M | **SPA and CMS migration playbook**: prerender every route at build (SSG/static export), real `<a href>`, History API on real URLs, no `#/` routes; lint detects empty-root shells and hash links; CRA migration note; dynamic-rendering services are not offered | F1, F5, F17, F27–F29 | A sample CRA-style SPA is flagged; a Next/Vite static export passes |
| R7 | P1 | S | Hub origins `noindex, nofollow` by default through the host-header recipe (including 301s), plus a runtime `<meta name="robots" content="noindex">` in hub mode; the hub "share" action copies the per-domain HTTPS URL when the pointer's host is known and warns that hub URLs have no preview | F34–F36, F39 | `curl -I` shows the header on 200 and 301 |
| R8 | P1 | M | Loader lifecycle and performance: start P2P after `load` plus idle and not while `document.prerendering`; lazy `import()` of webtorrent; `pagehide` closes sockets/IDB/torrent and `pageshow(persisted)` re-initialises in place (no `location.reload()`); HTML from the SW gets `Cache-Control: no-cache` not `no-store`; Lighthouse A/B budget against a no-loader baseline | F46, F48, F49, E4, E5(a,b) | LCP +≤100 ms and TBT +≤50 ms vs baseline; bfcache test passes |
| R9 | P1 | S | History-hygiene E2E: A→B→Back returns to A in one step in embedded, shell and hub modes, including right after first SW install on a fresh profile | F51, E5(d) | Test green in CI |
| R10 | P1 | S | Static probe page `/mw-probe/` that writes availability of `serviceWorker.register`, `indexedDB.open`, `caches`, `RTCPeerConnection`, `WebSocket`, `localStorage` into visible DOM; owner runs Search Console URL Inspection live test and Bing URL inspection and records the output in docs | F3, F4, F14, F16, Q1–Q3 | Results recorded for Google, Bing, Apple (where testable) |
| R11 | P1 | M | `publish` emits `sitemap.xml` (absolute URLs; `lastmod` kept stable across rebuilds by a content-hash manifest, changed only when the file hash changes), a `robots.txt` template with the `Sitemap:` line, an optional `<key>.txt`, and `--indexnow` to ping changed URLs (≤10,000 per POST) | F15, F30–F33 | Re-publishing an unchanged tree changes no `lastmod` |
| R12 | P1 | S | Shell-mode metadata stamping: per-site title, description, OG block and the home page's text for the root URL, with an explicit "home only; deep links are not indexable" warning | E2, F24 | Shell root shows the site's own preview |
| R13 | P1 | S | Update ARCHITECTURE.md as listed in Section 4 and add the invariants I1–I8 as a normative "SEO contract" | all | Review sign-off |
| R14 | P2 | S–M | Web-seed placement guidance and defaults: separate host or path with `X-Robots-Tag: noindex` and a canonical `Link` header, or a 200 rewrite of `/<name>/*` to root; document Range behaviour per host; avoid Cloudflare Pages until Range is re-tested | F32, F42, F44 | `verify-origin` plus header probe pass on each recipe |
| R15 | P2 | L | Optional preview edge function for hub operators (CloudFront Function, Cloudflare Worker): for allow-listed bot user agents return the web-seed HTML for the path (identical bytes, cached). Documented as dynamic rendering that requires equivalence | F18–F24, F27 | Slack/iMessage/Meta show per-site previews for hub URLs; bytes equal the web seed |
| R16 | P2 | M | `tools/snapshot.mjs` renders owner-moderated chain state into static HTML/JSON at publish time; links get `rel="ugc nofollow"`; all interpolation escaped; default off | F52 | Snapshot contains no tombstoned content |
| R17 | P2 | S | "Do not do" list in the guide: `llms.txt`, FAQ schema, UA-sniffing prerender services, `#!` or hash routes, `noindex` via robots.txt, JS-changed canonical | F6, F26–F28, F31 | Guide published |
| R18 | P2 | M | Hub topology guidance: per-site subdomains, noindex, abuse contact, Safe Browsing and Public Suffix List trade-offs, Search Console limits | F34, F35 | Guide published |
| R19 | P3 | S | Iframe-aware LCP reporting for shell mode (sub-frame reports to parent) or rely on CrUX | F47 | Shell RUM matches CrUX within 10% |
| R20 | P3 | S | Owner onboarding checklist: Search Console and Bing Webmaster Tools verification (DNS TXT at the apex coexists with `_magnet`), sitemap submission, URL Inspection, CrUX monitoring | F12, F33 | Checklist published |

### 5.2 Rules for the migration guide

Each rule is MUST, MUST NOT, SHOULD or MAY. Bracketed references point to findings (F) and local evidence (E).

**Serving model**
- SEO-01 MUST: every URL meant to be found by search or shared in chat returns its complete final HTML from the static origin with HTTP 200, with no JavaScript, service worker, WebRTC, IndexedDB or cookie state required. [F1–F4, F18, F24, F36, E1, E2]
- SEO-02 MUST: use embedded mode for any site that wants search or social traffic. Shell mode is for apps, demos and members-only sites; hub mode is never indexable. [F36, F39, E2]
- SEO-03 MUST: the swarm bytes equal the origin bytes for the same path; one build output feeds origin, web seed and torrent; CI verifies after every deploy. [F50, F27, F14, F44]
- SEO-04 MUST NOT: produce content, titles, descriptions, canonicals, robots directives, structured data or Open Graph tags only through the loader, SDK, service worker or chain state. [F4, F6, F11, F24]
- SEO-05 SHOULD: the service worker treats HTML navigations as network-first and never answers an origin 404 with a cached page in embedded mode. [F7, E5(c)]

**URLs, status codes, routing**
- SEO-06 MUST: every route is a real file or URL; no hash routes (`#/…`, `#!`); links are `<a href>`; client-side routing uses the History API on top of real URLs. [F1, F5]
- SEO-07 MUST: unknown URLs return HTTP 404 per the host recipe, never a 200 shell and never a redirect to the home page. [F7, F42–F44]
- SEO-08 MUST: `/robots.txt`, `/sitemap.xml`, the IndexNow key file, favicon, manifest, OG images and verification files are real files at the origin root; none may depend on a service worker. [F15, F30, F33]
- SEO-09 SHOULD: one URL form per page that matches the host (Cloudflare Pages redirects `/x.html` to `/x`, so use the extension-less canonical there); no trailing-slash flip-flops. [F32, F44]
- SEO-10 MUST: loader pointers (`#magnet:…`, `?mw=…`) never appear on indexable or shared URLs; the canonical omits them. [F5, F24, F32]
- SEO-11 SHOULD: keep every public URL unchanged (embedded mode needs no redirects); moving the canonical host to a hub or gateway is a site move with its own risk (Google's site-move guidance, updated 2026-06-17, was not read in detail). [F34, F38]

**Metadata**
- SEO-12 MUST: the raw HTML head has a unique `<title>`, a `<meta name="description">`, an absolute self-referential `<link rel="canonical">`, and no `noindex` unless intended; JavaScript never changes the canonical or robots tags. [F6]
- SEO-13 MUST: Open Graph and Twitter Card tags are in the raw HTML: `og:title` (without site name), `og:description`, `og:url` (= canonical), `og:type`, `og:site_name`, `og:image` (absolute HTTPS URL on the origin) with `og:image:width` and `og:image:height`, `twitter:card=summary_large_image`. Image at least 1200×630 (1.91:1), never under 900 px wide (Apple), at most 5 MB (LinkedIn), preferably under about 600 KB (WhatsApp, third-party figure); a square icon of at least 108 px for Apple. [F18–F23, F25]
- SEO-14 MUST: keep HTML under 1 MB (Apple and Meta) and every JS/CSS file under 2 MB uncompressed (Googlebot); move large inline JSON to files; put share metadata early in `<head>`. Our own conservative convention: all share metadata within the first 32 KB (hard limits are 1 MB and Meta's 512 KiB Range request). [F8, F18, F19]
- SEO-15 MUST: share URLs use only server-side redirects; no meta-refresh or JavaScript redirects. [F18, F24]
- SEO-16 SHOULD: JSON-LD lives in static HTML, only for types that still have features; skip FAQ and HowTo. [F11, F26]
- SEO-17 SHOULD: every JS and CSS file name carries a content hash; the injected loader URL changes with each loader release. [F9]

**Crawl control**
- SEO-18 MUST NOT: block JS, CSS or XHR needed for rendering in robots.txt; a `Disallow: /_mw/` is optional and only after the stub exists. [F10, F16]
- SEO-19 MUST: keep URLs out of the index with `noindex` (meta tag or `X-Robots-Tag`), not `Disallow`; never put both on one URL. [F31]
- SEO-20 SHOULD: hub and wildcard-hub origins send `X-Robots-Tag: noindex, nofollow`; owners who want search use per-domain embedded mode. [F34–F36]
- SEO-21 SHOULD: sitemap with absolute same-host URLs, `lastmod` only on real change (from a content-hash manifest), within 50,000 URLs or 50 MB, referenced from robots.txt; omit `priority` and `changefreq`. [F33]
- SEO-22 SHOULD: keep the web seed from becoming a second public copy (separate host or path with `X-Robots-Tag: noindex` and a canonical `Link` header, or a 200 rewrite to root); do not use robots.txt for this. [F31, F32, F42]
- SEO-23 MAY: notify Bing, Yandex, Naver, Seznam and Yep through IndexNow after each deploy; one key file per host. [F15]

**Content migration**
- SEO-24 MUST: SPAs prerender every route at build time so the delivered HTML contains the main content; verify with JavaScript disabled. UA-sniffing prerender services are not an accepted path. [F1, F17, F27–F29]
- SEO-25 MUST: CMS exports rewrite absolute URLs in canonical, OG tags and sitemap to the final origin; existing feeds keep working. [F32, F33]
- SEO-26 SHOULD: chain-driven areas are either non-indexable by design or snapshotted at publish time (moderated, escaped, `rel="ugc nofollow"`). [F52]

**Loader behaviour**
- SEO-27 MUST: the loader is inert for crawlers by construction (capability probes with timeouts, no user-agent sniffing); it never replaces, hides or reorders existing content; its UI is one appended container marked `data-nosnippet`; no developer-facing text in the document body. [F2–F4, F16, F31, E1]
- SEO-28 MUST: load after LCP (`async` module plus idle callback), not during `document.prerendering`; close WebRTC, IndexedDB and fetch work on `pagehide`; re-initialise on `pageshow(persisted)` without reload. [F46, F48, F49]
- SEO-29 MUST: history is replace-only; bootstrap redirects use `location.replace`; first-install service-worker activation adds no entries; an E2E test covers Back. [F51]
- SEO-30 SHOULD: HTML served by the service worker carries `Cache-Control: no-cache`, not `no-store`. [F48]

**Verification**
- SEO-31 MUST: run the test matrix in 5.3 before cutover and on each release.

### 5.3 Test matrix

| # | Check | How | Pass criteria |
|---|---|---|---|
| T1 | Raw HTML completeness | `curl -sS -A "<UA>" URL` for Googlebot-like, facebookexternalhit, Slackbot-LinkExpanding, Twitterbot and curl user agents | Bodies identical; title, description, canonical and OG present; no loader or standalone text |
| T2 | Status codes | Known URLs, a random path, `/robots.txt`, `/sitemap.xml` | 200 / 404 / 200 / 200; correct MIME types |
| T3 | Size budgets | Measure HTML, each JS/CSS, the OG image | HTML ≤ 1 MB; each JS/CSS ≤ 2 MB uncompressed; OG image ≤ 5 MB and ≥ 900 px wide |
| T4 | Range | `curl -r 0-99` an HTML page and a web-seed file | 206 with `Content-Range` (or documented exception for HTML only) |
| T5 | Crawler-like render | Playwright: JS on, SW blocked, clean profile, WebRTC unavailable | Visible text equals raw text apart from the status container; no failed `/_mw/*`; no loader console errors |
| T6 | No-JS render | Playwright with JavaScript off | Main content present |
| T7 | Lighthouse | Mobile, simulated throttling, with and without loader. The SEO category checks meta description, link text, a valid `rel=canonical`, indexability (`noindex` meta or `X-Robots-Tag`), HTTP status code and robots.txt validity | SEO category 100; LCP +≤100 ms, TBT +≤50 ms, no new CLS |
| T8 | Google render | Search Console URL Inspection live test on the home page and two deep pages; View tested page | Screenshot and HTML show content; no blocked resources |
| T9 | Structured data | Rich Results Test | No errors on pages with JSON-LD |
| T10 | Previews | Meta Sharing Debugger, LinkedIn Post Inspector, paste into Slack, Discord, iMessage, WhatsApp, Telegram, X | Correct title, description, image on each |
| T11 | Bing | Bing Webmaster Tools URL inspection; IndexNow submission | Rendered content OK; IndexNow returns 200 or 202 |
| T12 | Back button | Playwright A→B→Back on embedded, shell, hub, including first SW install | Lands on A in one step |
| T13 | bfcache | DevTools Back/forward cache test; `pageshow persisted` path | Eligible or only expected reasons; no reload on restore |
| T14 | Origin ≡ swarm | `verify-origin` | Every file hash matches |
| T15 | Hash routes | Search built HTML for `href="#/` and `href="#!` | None |
| T16 | Hub headers | `curl -I` hub URL and its redirects | `X-Robots-Tag: noindex, nofollow` on both |


---

## 6. Gotchas

1. **Two opposite fallback traps.** GitHub Pages answers unknown paths with a real HTTP 404 (measured), so a shell copied to `404.html` gives every deep link a 404 that Google will not render. Cloudflare Pages without a top-level `404.html`, Netlify `/* /index.html 200`, and CloudFront 404→200 mappings produce 200 soft-404 duplicates instead. [F7, F42–F44]
2. **`'serviceWorker' in navigator` is true in Google's renderer, but registration is rejected** (vendor test). Feature detection is not enough; the registration promise must be handled. [F4]
3. **Developer-facing text becomes indexed content.** The example site's standalone notice and "Connecting to the loader…" placeholders are what a crawler indexes, and a failed `/_mw/sdk.js` shows up as a broken resource. [E1]
4. **`noindex` in raw HTML cannot be reliably undone by JavaScript, and JS must not rewrite a canonical set in HTML.** A shell that ships `noindex` for hub reasons must not be reused for a per-domain deployment. [F6]
5. **robots.txt `Disallow` does not de-index and hides any `noindex` on the same URL.** Slack ignores robots.txt and Meta's fetcher may bypass it. [F31, F19, F20]
6. **Googlebot's 2 MB limit is per file, uncompressed, and applies separately to each JS and CSS file.** Large inline state blobs or one oversized bundle are truncated for Search. [F8]
7. **The renderer may ignore cache headers.** Content-hash every asset name, including the injected loader URL. [F9]
8. **Preview caches are sticky.** Slack about 30 minutes; Meta caches images by URL until the Sharing Debugger refresh; iMessage caches per conversation (third-party report). Publish final metadata before the URL is first shared; changing an `og:image` needs a new image URL for Meta. [F19, F20, F24]
9. **`og:image` must be an ordinary public HTTPS URL on the origin.** Never `blob:`, never service-worker-only, never under `/_mw/`; relative paths fail on many platforms (third-party report). [F24]
10. **Apple ignores meta-refresh.** A hub page that JS- or meta-redirects to a domain gives no preview; only server-side redirects are followed. [F18]
11. **Metadata built from user content is an injection sink.** Escape everything interpolated into tags (PeerTube does). [F40, F52]
12. **Fragment hubs collapse all sites into one URL** for Google, for Safe Browsing and for analytics; one bad site can taint the hub. Wildcard subdomains isolate better but Search Console cannot verify a Domain property on a public suffix and Public Suffix List inclusion has its own costs. [F34]
13. **Subdomain hubs need per-host files.** Each host needs its own `robots.txt`, sitemap and IndexNow key. [F15, F30]
14. **Chrome can prerender your page before the visitor opens it.** A loader that opens WebRTC or announces to trackers at load exposes the IP of someone who may never arrive. Gate on `document.prerendering`. [F49]
15. **bfcache is lost twice today.** The loader reloads on a persisted `pageshow`, the SW stamps `no-store`, and open WebRTC, IndexedDB and in-flight fetches can also block it. [F48, E5(a,b)]
16. **Lab, field and in-page numbers will disagree.** Lighthouse starts from cleared storage (first visit only); CrUX mixes first and repeat visits; the JS LCP API ignores iframe content that CrUX counts. [F46, F47]
17. **Cloudflare Pages: three surprises.** SPA mode by default, `.html` to extension-less 308 redirects, and 200 for Range requests (documented, undated). With webtorrent 3.0.21's `webconn.js`, which takes the whole response body as the block, a Range-200 host corrupts web-seed blocks for files bigger than the request. [F44]
18. **GitHub Pages as a web-seed host.** Jekyll drops underscore-prefixed paths (`/_mw/`) unless `.nojekyll` exists (2016 note); sites are capped at 1 GB with a soft 100 GB per month; commercial-transaction sites are not allowed; I found no documented custom-header mechanism. [F42]
19. **The closest precedent is in flux.** The IPFS Service Worker Gateway changed maintainers in Q3 2026 (Shipyard stopped IPFS maintenance). Do not treat it as a stable standard to track. [F36]
20. **X Cards documentation is gone.** Do not promise `twitter:*` specifics; always ship `og:*` as the base. [F22]
21. **Time sinks.** `llms.txt` (ignored by Google), FAQ markup (ended 2026-05-07) and HowTo-style markup. [F26]
22. **The AI-crawler no-JS result is from Dec 2024.** Re-verify before promising how AI search sees migrated sites; static HTML is the safe answer either way. [F17]
23. **A service worker that rewrites titles, descriptions or structured data for returning visitors invites a cloaking reading.** Keep the SW away from SEO-relevant head content. [F50]
24. **Back-button policy covers injected libraries.** Redirect or reload loops during first-install, hub bootstrap or the iframe URL mirror must use replace semantics and never bounce the visitor forward. [F51]
25. **An existing service worker on a migrating site conflicts with ours** (one service worker per scope). A stale offline cache from an old PWA can show old content to people but not to crawlers. This is outside this topic and was not researched; flag it for the migration-conflicts topic.
26. **IndexNow does not notify Google.** For Google rely on `lastmod` in the sitemap and Search Console. [F15]
27. **Applebot reuses Googlebot's robots rules when none target it**, so a rule written for Google also governs Apple Search. [F16]
28. **Current service-worker code masks origin 404s.** `handleNavigation` answers a host 404 with the cached shell; harmless for crawlers (they never run it) but in embedded mode it would show visitors the home page where the origin says "not found". [E5(c)]

---

## 7. Open questions

- **Q1** What exactly does Google's renderer expose for `navigator.serviceWorker`, `indexedDB`, `caches`, `RTCPeerConnection` and `WebSocket`, and how does it treat a hanging connection attempt? Current docs are silent on IndexedDB and service workers. Plan: R10 probe page plus URL Inspection live test.
- **Q2** Bingbot's current rendering behaviour and guideline wording (help center needs a browser), and its service-worker, WebRTC and IndexedDB behaviour. Plan: Bing URL inspection on the probe page; read the guidelines in a browser.
- **Q3** Applebot (WebKit-based) support for service workers, WebRTC and IndexedDB while rendering. Plan: probe page plus server logs.
- **Q4** Twitterbot / X: current requirements, image limits, cache lifetime and whether it uses Range. Plan: post a test URL from a throwaway account and read origin logs.
- **Q5** First-party limits for Discord, WhatsApp and Telegram (the WhatsApp ~600 KB image figure is a single third-party report).
- **Q6** How Google attributes same-origin iframe content to the embedding page, and how it treats `srcdoc` or `blob:` iframes (the shell's degraded render mode). Only relevant to shell mode; plan: URL Inspection on test pages.
- **Q7** Fresh measurements of AI-crawler JavaScript rendering for 2025–2026 (the only study read is Dec 2024). Blocked by the search cap.
- **Q8** Whether Google indexes content served through gateways (`*.eth.limo`, `*.ipfs.dweb.link`) and how it picks a canonical between a project's own domain and gateway hostnames. Blocked by the search cap; I measured only server behaviour (F36–F38).
- **Q9** Cloudflare Pages Range behaviour today (206 or 200) and S3/CloudFront Range behaviour for BEP 19 (expected fine, untested here).
- **Q10** Field behaviour of service-worker-served repeat visits (CrUX or RUM) for a P2P site: needs a prototype with real traffic.
- **Q11** Whether Chrome defers `RTCPeerConnection` or WebSocket during prerender or only exposes `document.prerendering` for the page to self-gate.
- **Q12** Real-world Safe Browsing and reputation behaviour for per-site subdomains versus fragment hubs; only the specification was read, no incident data.
- **Q13** Whether serving identical bytes from IndexedDB through a service worker, versus the origin, is ever read as cloaking. Policy is intent-based and identical bytes make the risk low, but there is no test.
- **Q14** Whether engines other than Google honour `X-Robots-Tag` and an HTTP `Link: rel="canonical"` header as documented for Google (R7 and R14 rely on them).
- **Q15** The original sources for the Splitt (I/O 2019, Reddit 2020) and Mueller (Mastodon 2023) statements were not read; I relied on Search Engine Roundtable and searchVIU.

---

## Appendix A. Sources actually read

All fetched on 2026-10-17. "Updated" is the date printed on the page when there is one; "undated" means none was shown.

**Google (Search Central, Safe Browsing, Search Console)**
- JavaScript SEO basics: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics (Updated 2026-03-04)
- Fix Search-related JavaScript problems: https://developers.google.com/search/docs/crawling-indexing/javascript/fix-search-javascript (2025-12-18)
- Dynamic rendering as a workaround: https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering (2025-12-10)
- URL structure best practices: https://developers.google.com/search/docs/crawling-indexing/url-structure (2025-12-10)
- Googlebot: https://developers.google.com/search/docs/crawling-indexing/googlebot (2026-02-03)
- Overview of Google crawlers and fetchers: https://developers.google.com/crawling/docs/crawlers-fetchers/overview-google-crawlers (2026-06-12)
- Canonicalization: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls (2026-07-10)
- robots.txt specification: https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt (2026-08-31)
- Build and submit a sitemap: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap (2026-07-08)
- Structured data with JavaScript: https://developers.google.com/search/docs/appearance/structured-data/generate-structured-data-with-javascript (2025-12-10)
- Robots meta tag, data-nosnippet, X-Robots-Tag: https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag (2026-03-24)
- Search Central documentation updates (changelog): https://developers.google.com/search/updates (entries through 2026-10-16)
- Core Web Vitals and Google Search: https://developers.google.com/search/docs/appearance/core-web-vitals (2025-12-10)
- Spam policies: https://developers.google.com/search/docs/essentials/spam-policies (2026-08-28)
- Back button hijacking blog post: https://developers.google.com/search/blog/2026/04/back-button-hijacking (2026-04-13)
- Optimizing for generative AI features: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide (2026-07-10)
- AI features and your website: https://developers.google.com/search/docs/appearance/ai-features (2025-12-10)
- Qualify outbound links: https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links (2025-12-10)
- URL Inspection tool: https://support.google.com/webmasters/answer/9012289 (undated)
- Search Console property types: https://support.google.com/webmasters/answer/34592 (undated)
- Safe Browsing URLs and hashing: https://developers.google.com/safe-browsing/v4/urls-hashing (undated)
- PageSpeed Insights about: https://developers.google.com/speed/docs/insights/v5/about (undated)
- Lighthouse SEO audits: https://developer.chrome.com/docs/lighthouse/seo/ and https://developer.chrome.com/docs/lighthouse/seo/is-crawlable (undated)
- Lighthouse README and throttling: https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/readme.md ; https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/docs/throttling.md (undated)
- web.dev LCP: https://web.dev/articles/lcp (undated); web.dev bfcache: https://web.dev/articles/bfcache (published 2023-05-25, updated 2026-10-16)
- Chrome prerender: https://developer.chrome.com/docs/web-platform/prerender-pages (published 2022-12-02, updated 2026-01-23)
- Rendertron README: https://raw.githubusercontent.com/GoogleChrome/rendertron/main/README.md (undated)

**Apple, Meta, Slack, LinkedIn, X, third parties on previews**
- Apple TN3156 (data endpoint): https://developer.apple.com/tutorials/data/documentation/technotes/tn3156-create-rich-previews-for-messages.json ; page: https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages (republished 2024-04-30)
- About Applebot: https://support.apple.com/en-us/119829 (Published 2026-09-04)
- Meta web crawlers, sharing webmasters, best practices (read via WebFetch; curl returns HTTP 400): https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/ ; https://developers.facebook.com/docs/sharing/webmasters/ ; https://developers.facebook.com/docs/sharing/best-practices/ (undated)
- Slack Robots: https://api.slack.com/robots (undated); Slack unfurl guide (read, nothing relevant beyond app unfurling): https://docs.slack.dev/messaging/unfurling-links-in-messages/
- LinkedIn Help, make your website shareable: https://www.linkedin.com/help/linkedin/answer/a521928 ("Last updated: 2 years ago")
- X docs index https://docs.x.com/llms.txt and old Cards URL https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/summary (redirects, 2026-10-17)
- arfct/link-previews (third party): https://raw.githubusercontent.com/arfct/link-previews/main/README.md ; https://raw.githubusercontent.com/arfct/link-previews/main/docs/crawlers.md (undated)

**Other engines, AI crawlers, commentary**
- Bing blog, JavaScript, dynamic rendering and cloaking: https://blogs.bing.com/webmaster/october-2018/bingbot-Series-JavaScript,-Dynamic-Rendering,-and-Cloaking-Oh-My (2018-10-31)
- Bing blog, evergreen Bingbot: https://blogs.bing.com/webmaster/october-2019/The-new-evergreen-Bingbot-simplifying-SEO-by-leveraging-Microsoft-Edge (2019-10-09)
- Bing blog, grounding: https://blogs.bing.com/search/February-2026/Elevating-the-Role-of-Grounding-on-the-AI-Web (2026-02-12). Bing Webmaster Guidelines page could not be read (client-rendered).
- IndexNow: https://www.indexnow.org/documentation ; https://www.indexnow.org/faq (undated)
- Vercel and MERJ, The rise of the AI crawler: https://vercel.com/blog/the-rise-of-the-ai-crawler (2024-12-17)
- Search Engine Roundtable on service workers: https://www.seroundtable.com/google-search-service-workers-29753.html (2020-07-10, updated 2023)
- searchVIU on service workers: https://www.searchviu.com/en/service-worker-what-seos-need-to-know/ (created 2020-12-11, updated 2026-06-25)

**Frameworks and hosts**
- Next.js static exports: https://nextjs.org/docs/app/guides/static-exports (updated 2026-08-09)
- React, sunsetting Create React App: https://react.dev/blog/2025/02/14/sunsetting-create-react-app (2025-02-14)
- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits ; custom 404: https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-custom-404-page-for-your-github-pages-site ; Jekyll bypass: https://github.blog/news-insights/the-library/bypassing-jekyll-on-github-pages/ (2016)
- Cloudflare Pages: https://developers.cloudflare.com/pages/configuration/serving-pages/ ; https://developers.cloudflare.com/pages/configuration/headers/ (undated)
- Netlify: https://docs.netlify.com/routing/redirects/rewrites-proxies/ ; https://docs.netlify.com/routing/headers/ (undated)
- AWS CloudFront: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GeneratingCustomErrorResponses.html ; https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-response-headers.html (undated)

**Decentralised-web precedents**
- PeerTube source (develop branch): https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/server/core/lib/html/shared/tags-html.ts ; .../server/core/lib/html/client-html.ts ; .../server/core/controllers/sitemap.ts ; also skimmed .../server/core/controllers/client.ts and .../server/core/lib/html/shared/page-html.ts
- IPFS docs: https://docs.ipfs.tech/concepts/ipfs-gateway/ ; https://docs.ipfs.tech/concepts/dnslink/ (undated); https://dnslink.dev/ and the link-a-domain page (a redirect stub) read without extra facts
- IPFS Service Worker Gateway README: https://raw.githubusercontent.com/ipfs/service-worker-gateway/main/README.md
- eth.limo: https://eth.limo/ ; operator article https://ethlimo.substack.com/p/the-public-suffix-list-is-a-disaster (2026-09-10); gateway basics page https://eth-limo.gitbook.io/documentation/introduction/what-is-eth.limo/gateway-basics read without extra facts
- peerweb.lol: https://peerweb.lol/ (undated)

**Local material**
- Repo: `docs/ARCHITECTURE.md`, `docs/INTERFACES.md` (skimmed), `src/loader/index.html`, `src/loader/app.js`, `src/loader/render.js`, `src/loader/boot.js`, `src/sw/sw.js`, `examples/peer-guestbook/*`, `node_modules/webtorrent/lib/webconn.js` (3.0.21), `node_modules/webtorrent/dist/webtorrent.min.js`.
- Header and DNS probes (curl, dig) listed in E3; two Playwright runs in Appendix B (Chromium build 1248 from the Playwright cache).

---

## Appendix B. Raw output of the local experiments

**E1: example site (`examples/peer-guestbook/`) served by a static server where unknown paths return 404 with `404.html`; Chromium via Playwright; Pass A with JavaScript off, Pass B with JavaScript on and service workers blocked in a fresh context.**

```json
{
  "A_noJS": {
    "status": 200,
    "title": "Peer Guestbook",
    "metaDescription": "Peer Guestbook: a static site delivered by magnet link and backed by a signed log that its visitors replicate.",
    "canonical": null,
    "ogTags": [],
    "twitterTags": [],
    "jsonLd": 0,
    "h1": ["Peer Guestbook"],
    "standaloneNoticeVisible": false,
    "bodyTextLen": 615,
    "failedRequests": [],
    "console": []
  },
  "B_jsNoSW": {
    "status": 200,
    "title": "Peer Guestbook",
    "canonical": null,
    "ogTags": [],
    "twitterTags": [],
    "jsonLd": 0,
    "standaloneNoticeVisible": true,
    "bodyTextLen": 897,
    "bodyTextHead": "Peer Guestbook Delivered by magnet link. Kept alive by its visitors. Guestbook About Open this site through the magnet-web loader. You are viewing the static files directly, so the live parts (peers, chain, guestbook) are off. The loader SDK at /_mw/sdk.js is not served here. Live Visitors online — Chain height — How this page reached you Served as plain static files, without the loader. …",
    "failedRequests": ["404 /_mw/sdk.js"],
    "console": ["error: Failed to load resource: the server responded with a status of 404 (Not Found)"]
  }
}
```

**E2: production shell `src/loader/index.html` as a no-JS client behind a GitHub-Pages-like host (root 200, any other path 404 with the same HTML).**

```json
{
  "root": {
    "httpStatus": 200,
    "title": "magnet-web",
    "description": "Loads a website by magnet link from other visitors, with a shared signed log as its database.",
    "canonical": null, "og": 0, "robots": null,
    "bodyText": "Loading the peer-to-peer loader… JavaScript is required This site is delivered peer-to-peer by a small in-browser loader. Enable JavaScript (and allow this origin in content blockers), then reload."
  },
  "deep_link_about": {
    "httpStatus": 404,
    "title": "magnet-web",
    "description": "Loads a website by magnet link from other visitors, with a shared signed log as its database.",
    "canonical": null, "og": 0, "robots": null,
    "bodyText": "(identical to root)"
  }
}
```

**E3: selected response headers (2026-10-17).**

```
GET https://pages.github.com/__mw_nope__/x.html   -> HTTP/2 404, content-type text/html, access-control-allow-origin: *, accept-ranges: bytes, content-length 9379
GET https://pages.github.com/                      -> HTTP/2 200, cache-control: max-age=600, access-control-allow-origin: *
GET https://pages.github.com/ (Range: bytes=0-99)  -> HTTP/2 206, content-range: bytes 0-99/14446
GET https://<CID>.ipfs.inbrowser.link/             -> HTTP/2 200, x-robots-tag: noindex, nofollow, server: cloudflare, 12008 bytes
GET https://inbrowser.link/ipfs/<CID>/             -> HTTP/2 301 -> subdomain URL, x-robots-tag: noindex, nofollow
GET https://vitalik.eth.limo/                      -> HTTP/2 200, x-ipfs-path: /ipfs/<CID>/, etag: "<CID>", server: eth.limo, cache-control: max-age=300, must-revalidate
GET https://vitalik.eth.limo/robots.txt            -> 200, "User-agent: * / Disallow: /wiki/ ..."
GET https://docs.ipfs.tech/concepts/dnslink/       -> HTTP/2 200, server: GitHub.com, cache-control: max-age=600
TXT _dnslink.docs.ipfs.tech                        -> CNAME to _dnslink.docs-ipfs-tech.dnslinks.ipshipyard.tech ; "dnslink=/ipfs/bafybeier6ud4…"
GET https://peerweb.lol/?orc=90c020bd…             -> 200, server: openresty, 48254 bytes, title "PeerWeb - Decentralized Website Hosting", 5 og tags, no canonical, no robots meta
GET https://peerweb.lol/robots.txt , /sitemap.xml  -> 404 , 404
GET https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/summary -> 307 -> https://docs.x.com -> 308 -> /overview -> 200
```

**E4: sizes.** `webtorrent.min.js` 222,929 B raw; `gzip -9` 64,428 B; `brotli -q 11` 55,969 B. Transfer time at 1.6 Mbps: gzip 0.32 s, brotli 0.28 s (pure serialisation).
