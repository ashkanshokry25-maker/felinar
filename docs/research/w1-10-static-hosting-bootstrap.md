# 10 - Static hosting of the loader and web seed: S3/CloudFront, GitHub Pages, Cloudflare Pages/R2, wildcard origins, CSP/SRI, caching, cost, offline, phone demos

- Project: magnet-web (static loader, WebTorrent site delivery by magnet link, signed P2P log as DB)
- Topic: where the loader (and the optional HTTP web seed) can really be hosted, what each host does to Range/CORS/compression/headers, how to make the shell production-grade (CSP, SRI, caching, offline), what it costs at 10k visits/day, and how to demo on a phone
- Research date: 2026-10-17 (all "today" statements mean this date). Prefer 2024-2026 sources; nothing older than 2024 is relied on.
- Method: (1) vendor docs fetched with WebFetch (the tool returns a small-model extraction of the page, so quoted text is "as extracted"; every number that drives a decision was cross-checked against a second source where one exists); (2) **raw standards text** (Fetch Standard, HTML Standard, CSP3, Service Worker spec, browser-compat-data, Public Suffix List) downloaded and read as source; (3) **direct measurement** with curl against live hosts (GitHub Pages, Netlify, Vercel, Cloudflare, jsDelivr) on 2026-10-17; (4) the AWS Price List API offer files (CloudFront published 2026-10-03, S3 published 2026-10-15); (5) the project's own code (`webtorrent@3.0.21` `webconn.js`/`torrent.js`, `src/loader`, `src/sw`) and research files 01-06.
- Limits of this run: the WebSearch budget was exhausted part-way (200 calls per turn, shared), so a few facts that needed a search (Netlify wildcard domains, WAICT, GitHub Pages custom-header support) are marked unverified rather than guessed. No AWS/Cloudflare/GitHub account was used, so **no CloudFront, S3, R2 or B2 behaviour was tested end to end**; those rows are documentation-only and say so.
- Confidence legend: **High** = measured today and/or two independent sources (or spec text plus a measurement). **Medium** = one primary source, or measured on one deployment only, or derived from spec text by me. **Low** = inference or single secondary source. Source IDs like [S12] are listed with URL and date in Appendix A.
- Related earlier files: `01-webtorrent-browser.md` (F10 web-seed CORS/preflight, F5 secure context), `04-service-worker-serving.md` (F9 SW MIME/scope, F11-F12 iframe/SW, open question 7 on wildcard hosting), `05-doh-dns-txt.md` (DoH origins for `connect-src`), `03-webrtc-nat-privacy.md` (CSP cannot restrict WebRTC).

---

## Summary

1. **S3 website endpoints are HTTP-only, so "S3 only" hosting cannot serve the loader (a secure context is mandatory).** AWS (2026) says "Amazon S3 website endpoints do not support HTTPS" and points to Amplify Hosting or CloudFront. The correct AWS shape is a **private S3 REST bucket + CloudFront Origin Access Control + ACM certificate in us-east-1 + a CloudFront Function for the SPA fallback**, not the website endpoint (OAC cannot be used with website endpoints). [S1][S10]
2. **The task premise "a Range header triggers a CORS preflight" is wrong for WebTorrent, and the real trigger breaks the usual S3 CORS recipe (design-critical).** The Fetch Standard safelists `Range: bytes=N-M` (single range with a start), so Range alone does not preflight. WebTorrent 3.0.21 also sends `Cache-Control: no-store` and `user-agent`, which are not safelisted, so every cross-origin web-seed request is preflighted with `Access-Control-Request-Headers: cache-control[,user-agent]`. S3 requires every requested header to match `AllowedHeaders`, so the commonly quoted `AllowedHeaders: ["Range"]` makes **every web-seed request fail**. Use `["*"]` (JSON in Appendix CFG-1). The preflight cache is keyed per URL and defaults to 5 s, so set `MaxAgeSeconds`. [S53][S62][S2][S3][S58]
3. **Most static hosts fail that preflight by default (measured 2026-10-17).** GitHub Pages answers `OPTIONS` with **405** and no CORS headers (every header combination, with or without Origin). Netlify (vuejs.org) answers 200 with no CORS headers; Vercel (react.dev) answers 204 with Allow-Origin and Allow-Methods but no Allow-Headers; cdnjs and jsDelivr likewise lack Allow-Headers; only unpkg (Cloudflare) sends `Access-Control-Allow-Headers: *`. [S63]
4. **A second, silent web-seed failure: Range applied to the compressed bytes (design-critical).** Browsers always send `Accept-Encoding` (a forbidden header name, so page code cannot ask for identity). Measured: GitHub Pages (Fastly) returns `206`, `Content-Encoding: gzip`, `Content-Range: bytes 0-99/3412` where 3412 is the **gzip size** of a 12,226-byte file; jsDelivr does the same with brotli; cdnjs returns `200` with the whole body; unpkg, Netlify and Vercel returned identity `206`. AWS documents the same hazard for CloudFront ("the byte range request is based on the compressed size"). WebTorrent's `webconn.js` accepts any 2xx and takes the decoded body as the piece bytes without checking `Content-Range` or `Content-Encoding`, so the failure is a piece-hash mismatch, not a clear error. Web-seed hosts must serve **identity** bytes for ranges. [S63][S8][S9][S62]
5. **GitHub Pages is fine for the shell but not as a cross-origin web seed.** HTTPS via Let's Encrypt, service workers work, custom domain via A/AAAA/ALIAS, but: no wildcard custom domains, no custom response headers (measured: no HSTS, no nosniff, no CSP, fixed `Cache-Control: max-age=600`), the SPA fallback is an **HTTP 404** carrying the 404.html body, 1 GB site and 100 GB/month soft bandwidth limits, commercial use not allowed, project sites (`/repo/`) would break the loader's root-absolute URLs. [S23][S24][S63]
6. **Wildcard origins (hub isolation) are host-dependent.** CloudFront (ACM wildcard, `*.hub.example` is one of 100 alternate names), Vercel (wildcard domains with Vercel nameservers or delegated `_acme-challenge`) and Cloudflare **Workers routes** (`*.hub.example/*`, proxied wildcard DNS on all plans, Universal SSL covers first-level subdomains) work. **Cloudflare Pages and Workers Custom Domains do not support wildcards**, GitHub Pages does not document them and discourages wildcard DNS, Netlify is unverified. A wildcard certificate covers exactly one label, not the apex. [S5][S7][S33][S34][S39][S52]
7. **The shell's integrity story has a hole (design-critical).** `webtorrent.min.js` (223 KB, the largest code the shell runs) is loaded with dynamic `import()`, which has no integrity option, so the SRI in ARCHITECTURE section 13 does not cover it. The HTML Standard lets an **import map `integrity` key** protect module-graph imports (Chrome 127, Firefox 138, Safari 18), and `<link rel=modulepreload integrity>` (Chrome 66, Firefox 115, Safari 17) pre-fills the module map that a later `import()` reuses. iOS/Safari 16.x has neither. **Simplest robust fix: bundle webtorrent into `loader.js`** so the one SRI-checked file covers everything. [S54][S57]
8. **CSP:** keep `connect-src 'self' https: wss:` (CSP3: `https:` does not match `wss:`; both are needed). An inline import map needs a `sha256-` hash in `script-src`. A `<meta>` CSP cannot carry `frame-ancestors`, `report-uri` or `sandbox`, so header-capable hosts (CloudFront, Cloudflare, Netlify, Vercel) get a stronger baseline than GitHub Pages. WebRTC is outside CSP (03 F-38). Details and a ready policy: Findings G and Appendix CFG-10. [S55][S54]
9. **Caching:** the SW registers with the default `updateViaCache: "imports"`, so `sw.js` is always revalidated by the browser, but CDN edges still hold it (CloudFront CachingOptimized default TTL is 24 h; GitHub Pages is fixed at 10 min). Ship **`/index.html`, `/sw.js`, `/manifest.webmanifest` as `no-cache` (and invalidate those three paths, within the 1,000 free invalidations/month) and everything else under `/v/<build-id>/` as `immutable`**. [S56][S17][S63]
10. **Cost at 10k visits/day is dominated by web-seed fallback, not the shell.** Shell-only is 30-40 GB and 3-4 M requests per month, which costs between $0 and about $20 a month on any host. A 5 MB site with 0% P2P and every visit cold is about 1.5 TB/month: CloudFront pay-as-you-go about $49, Cloudflare R2 about $1.4, Backblaze B2 behind Cloudflare about $0, Vercel Pro about $105, Netlify and Amplify about $220. **Use a zero-egress store (R2, or B2 via Cloudflare) for the web seed**; CloudFront is acceptable for small sites. Two avoidable multipliers: per-file CORS preflights (+33% requests) and the SW's `cache:'reload'` precache re-fetch (2x first-visit shell). [Appendix C]
11. **Phone demos need HTTPS or `localhost`.** `http://192.168.x.x` is not a secure context, so there is no service worker and no `crypto.subtle` (WebTorrent hashing). ARCHITECTURE section 11 ("open the hub URL in any browser on the LAN") is only true over HTTPS. Ranked options: Android USB port-forward to `localhost`; mkcert + CA on the phone; Tailscale Serve (valid Let's Encrypt cert, tailnet only); Cloudflare quick tunnel (no account, 200 in-flight cap, no SSE); ngrok free is the worst fit (1 GB/month, 20k requests/month, interstitial). The tracker must also be `wss://`: proxy `/tracker` through the same HTTPS dev server. [S58][S65][S66][S67][S68]
12. **Biggest levers found (details in Recommendations):** write the correct web-seed CORS JSON everywhere (P0); build a "seed doctor" that checks OPTIONS, 206/Content-Range, no Content-Encoding, no redirects before and after publishing (P0); stop recommending GitHub Pages/Netlify/Vercel/Cloudflare Pages as a cross-origin web seed (P0); bundle webtorrent for SRI (P1); versioned immutable shell (P1); strip WebTorrent's two non-safelisted request headers so most hosts need no preflight at all (P1, with a measured spec basis and an exact patch site in the minified bundle); consider a single-file archive torrent layout to dodge three host-dependent failure modes (P2, needs a pointer-grammar decision).

---

## Findings

Each finding has: the claim, a confidence, the sources with their dates, and a design-critical flag when a wrong answer would change the architecture or a compatibility promise.

### A. S3 and CloudFront as the loader host

**F1. S3 static-website endpoints are HTTP-only; HTTPS needs CloudFront or Amplify Hosting.** Confidence: **High**. Design-critical: **yes** (answers 04 open question 7: "static S3 only" cannot work).
- AWS: "Amazon S3 website endpoints do not support HTTPS or access points. If you want to use HTTPS, you can do one of the following: (Recommended) Use AWS Amplify Hosting ... Use Amazon CloudFront". The same page's comparison table: website endpoint "Does not support SSL connections", "Supports only GET and HEAD requests on objects", "Supports only publicly readable content", error responses are HTML. [S1]
- The S3 website-endpoint domains are on the Public Suffix List (also verified in the PSL file, F25). [S1][S59]
- Source date: AWS page undated, fetched 2026-10-17; the "Amplify Hosting (Recommended)" wording is recent.

**F2. Use the S3 REST endpoint with Origin Access Control, not the website endpoint.** Confidence: **High**.
- "If your origin is an Amazon S3 bucket configured as a website endpoint, you must set it up with CloudFront as a custom origin. That means you can't use OAC (or OAI)." OAC signs requests with SigV4, needs a bucket policy for `cloudfront.amazonaws.com` conditioned on `AWS:SourceArn`, and Object Ownership "Bucket owner enforced". [S10]
- A website-endpoint origin means a public bucket and plain HTTP between CloudFront and S3; the REST + OAC shape keeps the bucket private. Bucket policy skeleton: Appendix CFG-2.

**F3. TLS and wildcard rules for CloudFront custom domains.** Confidence: **High**. Design-critical: **yes** for hub-mode isolation.
- ACM certificates used with CloudFront must be requested or imported in **us-east-1**; only **one certificate** per distribution; alternate domain names must be **lowercase** and covered by the certificate SAN. [S5][S6]
- A wildcard `*.example.com` certificate lets you add alternate names at **that one level** (`product.example.com`) but **not** `example.com` (list the apex on the certificate) and **not** `a.b.example.com`. [S5]
- A wildcard alternate domain name must begin with `*.`; `*domain.example.com` and `sub.*.example.com` are invalid; it may overlap a specific name (the more specific distribution wins); the same alternate name cannot be on two distributions. A wildcard counts as **one** of the default **100** alternate domain names per distribution. [S5][S7][S11]
- Apex records need Route 53 alias (or Anycast static IPs outside Route 53). [S5]
- The hub scheme `^[0-9a-f]{40}\.hub\.example` fits one label (DNS labels are limited to 63 octets per RFC 1035, which I did not re-fetch; a 64-hex BitTorrent v2 infohash would not fit, base32 would; 01 F9 says BEP 52 is not implemented in WebTorrent 2.x/3.x, so this is moot today).
- Source dates: all AWS pages undated, fetched 2026-10-17.

**F4. SPA fallback on CloudFront: custom error responses work but are distribution-wide, so prefer a viewer-request Function.** Confidence: **High** (mapping, TTL), **Medium** (the "distribution-wide" inference).
- Custom error responses can return a custom page with HTTP code `200` (allowed codes: 200, 400, 403, 404, 405, 414, 416, 500-504). The default error-caching minimum TTL is **10 seconds** (S3-origin errors never go below 1 s); `no-store`/`no-cache`/`private` on 404/410/414/501 errors prevent caching. [S4]
- With a private bucket behind OAC, S3 returns **403** (not 404) for a missing key unless the caller also has `s3:ListBucket`; so map both 403 and 404. [S12]
- `CustomErrorResponses` is a field of the distribution config, and the cache-behavior settings page lists no error-page setting, so it applies to **every path in the distribution**. [S4][S18] Consequence: the same rule would turn a **missing web-seed object into `200 index.html`**, which WebTorrent treats as piece data and fails hash verification on, silently. This is the reason to use a viewer-request CloudFront Function (allow-list of shell files, rewrite everything else that is not under `/v/` or `/ws/`) instead of custom error responses on any distribution that also serves the web seed. Function limits: 10 KB code, 2 MB memory, 2 M free executions/month then $0.10 per million. [S11][S21]

**F5. CloudFront managed policies: names, IDs and one trap.** Confidence: **High** (docs); end-to-end behaviour **untested**.
- Response headers: `CORS-With-Preflight` (5cc3b908-e619-4b99-88e5-2cf7f45965bd) adds, **for OPTIONS**, `Access-Control-Allow-Methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT`, `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: *`; for simple CORS only Allow-Origin. **It sets no `Access-Control-Allow-Headers`**, so on its own it cannot satisfy a preflight that lists `cache-control`. `SimpleCORS` 60669652-455b-4ae9-85a4-c4c02393f86c; `SecurityHeadersPolicy` 67f7725c-6f97-4210-82d7-5512b31e9d03 (HSTS `max-age=31536000` without includeSubDomains/preload, nosniff with override, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-XSS-Protection: 1; mode=block`); `CORS-and-SecurityHeadersPolicy` e61eb60c-9c35-4d20-a928-2b84e02af89c; `CORS-with-preflight-and-SecurityHeadersPolicy` eaab4381-ed33-4a86-88ca-d9558dc6cd63. [S13]
- A custom response headers policy can set `Access-Control-Allow-Headers` (incl. `*`, except `Authorization`), Expose-Headers, Max-Age, CSP (value limited to **1,783 characters**, adjustable), HSTS with preload/includeSubDomains, and has a per-header "origin override" flag. [S15][S11]
- Origin request policy `CORS-S3Origin` (88a5eaf4-2fd4-4709-b370-b4c650ea3fcf) forwards `Origin`, `Access-Control-Request-Headers`, `Access-Control-Request-Method`. Forwarding does not by itself make CloudFront cache per Origin: AWS says CORS with S3 needs those headers **in the cache policy** (and `OPTIONS` caching enabled if you want OPTIONS cached); otherwise a response cached without CORS headers can be served to later CORS requests (inference from "cache based on headers" semantics, Medium). [S14][S16]
- Cache policies: `CachingOptimized` 658327ea-f89d-4fab-a63d-7e88639e58f6 (min 1 s / default 24 h / max 365 d, key = normalized Accept-Encoding only, compression on); `CachingOptimizedForUncompressedObjects` b2884449-e4de-46a7-ac36-70bc7f1ddd6d (same, compression off); `CachingDisabled` 4135ea2d-6df8-44a3-9df3-4b5a84be39ad; `UseOriginCacheControlHeaders` 83da9c7e-98b4-4e11-a168-04f0df8e2c65 (min 0 / default 0, key includes Host, Origin, X-HTTP-Method*, all cookies). A minimum TTL above 0 means CloudFront caches for at least that long even with `no-cache`. [S17]
- Allowed methods per behavior: "GET, HEAD", "GET, HEAD, OPTIONS", or all; `OPTIONS` responses are cached separately and only if enabled. [S18]

**F6. CloudFront flat-rate plans exist (new) but gate the features this project needs.** Confidence: **High**. Source: AWS doc, undated, fetched 2026-10-17. [S19][S20]
- Free $0 (1 M requests, 100 GB, 5 behaviors, 5 WAF rules), Pro $15 (10 M, 50 TB, 10 behaviors), Business $200 (125 M, 50 TB, 50 behaviors), Premium $1,000 (500 M, 50 TB, 100 behaviors; configurable up to 6 B requests / 600 TB for $10,000).
- Allowances "are not hard limits"; "you will not incur overage charges"; the first spike up to 3x is tolerated; sustained excess is evaluated over 2-3 months and delivery "might be adjusted". Included: WAF (mandatory), DDoS protection, Route 53 DNS, TLS certificate, serverless edge compute, S3 credits.
- **Custom response-header policies (custom CSP, custom `Access-Control-Allow-Headers`) and custom cache policies are Business-tier features**; Free/Pro only get the managed ones (F5). One apex-level domain per plan; multi-tenant distributions, continuous deployment and OAI are unsupported.
- Pay-as-you-go always-free: 1 TB data transfer out, 10 M requests, 2 M Function executions per month. [S20]

**F7. AWS prices used in the model (Price List API).** Confidence: **High**. CloudFront file published 2026-10-03, S3 us-east-1 file 2026-10-15. [S21]
- CloudFront US: $0.085/GB first 10 TB (then $0.080 next 40 TB, $0.060 next 100 TB), HTTPS requests $0.0100 per 10,000 (HTTP $0.0075), data transfer out to origin $0.02/GB, invalidations first 1,000 URLs/month free then $0.005 each, Function executions $0.10 per million after 2 M.
- S3 Standard us-east-1: $0.023/GB-month (first 50 TB), GET $0.004 per 10,000 ($0.0004 per 1,000), PUT/COPY/POST/LIST $0.005 per 1,000, transfer from S3 to CloudFront $0.
- AWS Amplify Hosting (AWS's recommended HTTPS path for S3 sites): $0.15/GB served after 15 GB, $0.023/GB-month storage after 5 GB, $0.01 build minute, "Free for 12 months" tier. [S22]

### B. Web seed behaviour: CORS, preflight, Range, compression

**F8. What WebTorrent 3.0.21 really sends and accepts.** Confidence: **High**. Design-critical: **yes**.
- `webconn.js` (and the identical literal in the minified bundle, exactly one occurrence): `fetch(url, { cache: 'no-store', method: 'GET', headers: { 'Cache-Control': 'no-store', 'user-agent': 'WebTorrent/<ver> (https://webtorrent.io)', range: 'bytes=a-b' }, signal: AbortSignal.timeout(60000) })`; `if (!res.ok) throw ...`; `new Uint8Array(await res.arrayBuffer())`. **No check of 206, `Content-Range`, `Content-Length` or `Content-Encoding`.** On an error the connection marks the piece as missing and, after a 10 s `RETRY_DELAY`, advertises it again, so a persistently bad seed is retried indefinitely. [S62]
- The request URL for multi-file torrents is `this.url + '/' + file.path.replace(torrent.path, '')` with **no percent-encoding**; a file named `a#b.png` or `a?b.css` becomes a fragment or query, and `%` sequences are re-decoded. Spaces are encoded by the URL parser. `torrent.addWebSeed(urlOrConn)` also accepts a custom connection object with a string `connId`, but `WebConn` is not exported from the browser bundle. [S62]

**F9. `Range` alone does not trigger a preflight; WebTorrent's other two headers do.** Confidence: **High** (spec), **Medium** (per-browser behaviour). Design-critical: **yes** (corrects the task premise and the S3 CORS recipe).
- Fetch Standard (main, read 2026-10-17): `range` is CORS-safelisted if its value parses as a single range with a start (`bytes=N-` or `bytes=N-M`); suffix ranges (`bytes=-500`) are not safelisted; any safelisted value must be 128 bytes or less. MDN: "needs to have a value of a single byte range in the form of `bytes=[0-9]+-[0-9]*`". [S53][S58]
- `Cache-Control` is not safelisted. `User-Agent` is **not** on the current forbidden-header list (`Accept-Encoding`, `Origin`, `Referer`, `Cookie`, `Host`, `Connection`, `TE`, `Via`, `Sec-*`, `Proxy-*` and others are), so a conforming browser may send it and it is CORS-unsafe. Chromium 155 measured in research 01 F10: preflight asks only for `cache-control` (Chromium drops the `user-agent` override); Firefox and Safari are **unverified** and may list `user-agent` too. [S53][S64]
- The `cache: 'no-store'` fetch option makes the user agent add `Pragma: no-cache` and `Cache-Control: no-cache` inside "HTTP-network-or-cache fetch", which runs **after** the preflight decision, so the option itself does not preflight; only the author-set headers do. [S53]
- In "HTTP fetch" the CORS-preflight step runs only `If response is null`, i.e. when no service worker supplied a response. So a controlled page's request reaches the SW first; a SW that re-issues `fetch(url, { headers: { range } })` creates a new request with only safelisted headers and no preflight (spec-derived, **not yet tested**). [S53]

**F10. Preflight mechanics that drive cost and hosting.** Confidence: **High**. [S53]
- A preflight must return an **ok status (2xx)** with a passing CORS check and `Access-Control-Allow-Methods`/`-Headers` that cover the request; a redirect or 4xx/5xx is a network error (so S3 must not 301 to another region endpoint, and an OPTIONS 405 or 403 is fatal).
- The CORS-preflight cache entry is keyed by (network partition key, origin, **URL**, credentials, method, header name); `Access-Control-Max-Age` missing or invalid defaults to **5 seconds**; browsers may cap it (R2 docs: "Browsers may limit this to 2 hours or less, even if the maximum value (86400) is specified"). [S36]
- Net effect for a multi-file web seed: roughly one extra OPTIONS per distinct file URL per cold visit (model: +33% requests for a 20-file site, i.e. removing the preflight cuts about 25%), and `Access-Control-Max-Age` should always be set.

**F11. S3 CORS semantics (exact).** Confidence: **High**. [S2][S3]
- JSON array of rules, **up to 100**. S3 uses the first rule matching Origin, `Access-Control-Request-Method` and **every** header in `Access-Control-Request-Headers` ("Each header name ... must match a corresponding entry"); each `AllowedHeaders` string may contain at most one `*`; `AllowedMethods` accepts GET, PUT, POST, DELETE, HEAD (not OPTIONS, preflight is implicit); `AllowedOrigins` may contain one `*` per entry; `ExposeHeaders`, `MaxAgeSeconds` optional.
- Therefore the working rule for WebTorrent 3.0.21 is `AllowedHeaders: ["*"]` (or at least `Range`, `Cache-Control`, `User-Agent`). The recipe `["Range"]` fails the preflight. Console JSON (bare array) and CLI wrapper in Appendix CFG-1. `ExposeHeaders` (`Content-Range`, `Content-Length`, `Accept-Ranges`, `ETag`) is not needed by WebTorrent (it reads only `res.ok` and the body) but is harmless and future-proof.

**F12. Measured host behaviour for Range with compression and for preflight (2026-10-17).** Confidence: **High** for these deployments; **Medium** when generalised to "the vendor". Design-critical: **yes**. Source: my own curl probes [S63]; full log in Appendix E.

| Host (URL probed) | `Range: bytes=0-99` + `Accept-Encoding: gzip, br` | OPTIONS preflight (`ACRH: cache-control,range,user-agent`) |
|---|---|---|
| GitHub Pages (pages.github.com, Fastly) | `206`, `Content-Encoding: gzip`, `Content-Range: bytes 0-99/3412` (**compressed** length; identity length is 12,226) | **405**, no CORS headers (also 405 for `range` only, `cache-control` only, no ACRH, no Origin); GET has `ACAO: *` |
| jsDelivr (webtorrent.min.js) | `206`, `Content-Encoding: br`, `bytes 0-99/66074` (**compressed**; identity 222,929) | 200, `ACAO: *`, **no Allow-Headers** |
| cdnjs (Cloudflare) | **`200` full body**, `Content-Encoding: br` (Range ignored) | 200, `ACAO: *`, no Allow-Headers |
| unpkg (Cloudflare) | `206`, identity, `bytes 0-99/222929` | 200, `ACAO: *`, **`ACAH: *`**, `ACAM: GET, HEAD, OPTIONS, POST` |
| Netlify (vuejs.org) | `206`, identity (`bytes 0-99/83785`, no Content-Encoding) | 200, **no CORS headers**; GET has no ACAO |
| Vercel (react.dev) | `206`, identity (`bytes 0-99/272438`) | 204, `ACAO: *`, `ACAM: OPTIONS, GET, HEAD`, **no Allow-Headers** |
| S3 / CloudFront / R2 / B2 | not measured | not measured (docs only) |

- Consequences: (a) with WebTorrent's stock headers only an unpkg-like configuration passes the preflight, every other measured default fails; (b) GitHub Pages and jsDelivr would corrupt pieces of any compressible file (HTML, CSS, JS, JSON, SVG, text), cdnjs would return the wrong length; (c) the client cannot opt out because `Accept-Encoding` is forbidden; (d) because `webconn.js` takes any 2xx body, the symptom is "piece failed verification" and endless retries, not an HTTP error. A small file whose whole length is requested may well survive (a range end beyond the compressed length is normally clamped; not measured), which would hide the bug in small tests.
- CloudFront documents the same trap: "For a range request for a compressed object, the byte range request is based on the compressed size, and not the original size of the object"; compression applies only to 200/403/404 responses of 1,000 to 10,000,000 bytes and certain content types (the list includes text/html, javascript, css, json, svg, wasm, pdf, text/plain, xml, fonts; **not** `application/octet-stream`); it is a per-cache-behavior setting; if an uncompressed copy is already cached CloudFront may serve it. [S8][S9][S18]
- Mitigations, in order of robustness: serve web-seed objects as `Content-Type: application/octet-stream` from a behavior or host with compression disabled; run a "seed doctor" check that fails on any `Content-Encoding`, status other than 206, or `Content-Range` total different from the torrent's file length; or avoid per-file web seeds with a single-file archive layout (REC-10).

**F13. Cloudflare compression and Range.** Confidence: **Medium**. Cloudflare compresses with gzip, Brotli or Zstandard by content type and offers `Cache-Control: no-transform` on the origin response as the opt-out; the page does not say what happens with Range. Observed: unpkg returned identity `206`, cdnjs returned `200` with a full Brotli body, so behaviour depends on cache state and the zone's setup. [S43][S63]

### C. GitHub Pages

**F14. Limits and terms.** Confidence: **High**. Source: GitHub Docs, undated, fetched 2026-10-17. [S23]
- Published site "no larger than 1 GB"; source repository recommended 1 GB; "soft bandwidth limit of 100 GB per month"; "soft limit of 10 builds per hour" (not applied to a custom Actions workflow); deployments time out after 10 minutes; rate limiting returns 429; "not intended for or allowed to be used as a free web-hosting service to run your online business"; on overuse GitHub may stop serving or suggest a CDN or another host.

**F15. Custom domain and HTTPS.** Confidence: **High** (docs). [S24][S26]
- Apex: A `185.199.108.153`, `.109.153`, `.110.153`, `.111.153`; AAAA `2606:50c0:8000::153` to `8003::153`; or ALIAS/ANAME to `USER.github.io`; subdomain: CNAME to `USER.github.io`. DNS up to 24 h. Certificates come from Let's Encrypt; "Enforce HTTPS" redirects HTTP; the domain name must be under 64 characters; extra A/AAAA/ALIAS records on `@` can block certificate issuance. The docs "strongly recommend" against wildcard DNS records (takeover risk) and document no wildcard custom domain, so treat wildcard as unsupported (**Medium**: unsupported by omission plus warning, not by an explicit sentence).

**F16. Behaviour measured on GitHub Pages.** Confidence: **High** (pages.github.com, 2026-10-17); **Medium** for generalisation to every Pages site. [S63]
- A missing path returns **HTTP 404** with the site's 404 page (`content-type: text/html`); there is no way to return 200 for SPA routes. The project's SW already treats a 404 navigation as "serve the cached shell" (`sw.js handleNavigation`), so repeat visits work; the first visit to a deep link renders the shell with a 404 status code; browsers execute a document regardless of status and SW registration on it is expected to work, but that was not tested here.
- Fixed `cache-control: max-age=600`, `expires`, `ETag`, `accept-ranges: bytes`, `ACAO: *` on GET, `vary: Accept-Encoding`, gzip only (no brotli offered), JS served as `application/javascript; charset=utf-8` (acceptable for a SW script, 04 F9). **No** `Strict-Transport-Security`, `X-Content-Type-Options`, `Content-Security-Policy`, `Service-Worker-Allowed` or COOP/CORP headers were present, and the docs describe no way to add headers, so security headers must come from `<meta>` (limited, F26) or from a proxy such as Cloudflare in front (not tested).
- Jekyll skips files and folders starting with `_`, `.` or `#` by default (GitHub Docs), so ship `.nojekyll`, or deploy with a custom Actions workflow. [S27]
- Service workers are allowed (HTTPS). Without `Service-Worker-Allowed`, a SW's default scope is its script's directory (SW spec 6.5), so the loader works on a user/organisation site or a custom domain at the root, but **project sites (`user.github.io/repo/`) break** the loader's root-absolute URLs (`/sw.js`, `/loader.js`, `/_mw/...`). [S56][S64]

### D. Cloudflare: Pages, Workers static assets, R2

**F17. Pages configuration and limits.** Confidence: **High** (docs via extraction). [S28][S29][S30][S31]
- `_headers`: up to **100 rules**, **2,000 characters per line**; `*` splat (one per URL) and `:placeholders`; a request matching several rules inherits headers from all of them and **duplicate header names are joined with a comma** (so do not set `Cache-Control` in a `/*` rule and again in `/v/*`); `! Header` detaches; headers are not applied to Pages Functions responses; redirects run before headers.
- `_redirects`: 2,000 static + 100 dynamic = 2,100; codes 301/302/303/307/308; `200` makes a rewrite but "Proxying will only support relative URLs on your site"; "Rewrites with other status codes ... are not supported".
- SPA mode: "If your project does not include a top-level `404.html` file, Pages assumes that you are deploying a single-page application" and serves `/` for any non-asset path; the status code of that fallback is **not documented** (open question). If a top-level `404.html` exists (as the project's build emits for GitHub Pages) Pages serves it for misses instead, so build per-host flavours.
- Defaults: `ETag` always; `Cache-Control: public, max-age=0, must-revalidate` for cacheable assets when the request has no `Range`/`Authorization`.
- Limits: 20,000 files (Free) / 100,000 (paid, needs `PAGES_WRANGLER_MAJOR_VERSION=4`), **25 MiB per file**, 500 builds/month (Free), 100 custom domains per project (Free), 100 projects per account. Bandwidth limit not stated on the limits page.

**F18. No wildcard custom domains on Pages; use a Worker route.** Confidence: **High**. Design-critical: **yes** (hub-mode isolation on Cloudflare). [S32][S33][S34][S39][S40]
- Pages known issues: "It is currently not possible to add a custom domain with a wildcard, for example, `*.domain.com`." The DNS docs repeat: "If your project is on Cloudflare Pages, note that wildcard custom domains are not supported", and "Customers on all plans can create and proxy wildcard DNS records".
- Workers **Custom Domains** do not support wildcards ("do not support wildcard DNS records"); Workers **Routes** do: a host pattern starting `*.` "only matches all subhosts" (`*.example.com/` does not match `example.com`), needs a proxied DNS record for the host, and the most specific route wins.
- Universal SSL (full setup) covers the root domain and **first-level subdomains**; deeper levels need Total TLS or an advanced certificate. So `<btih>.hub.example` works with a Worker route + proxied wildcard record + Universal SSL; `<btih>.sites.hub.example` would not.
- Pages apex domains require the zone on Cloudflare nameservers; subdomains can use a CNAME to `<project>.pages.dev`.

**F19. Workers static assets are the current Cloudflare path for new static sites.** Confidence: **Medium-High**. [S39]
- SPA fallback: `assets.not_found_handling = "single-page-application"` returns `index.html` with **`200 OK`** for navigation requests (`Sec-Fetch-Mode: navigate`); `_headers` is supported (100 rules, 2,000 chars/line, not applied to Worker-generated responses); limits 20,000 files (Free) / 100,000 (Paid), 25 MiB per file; "Requests to static assets are free and unlimited" (Worker invocations are billed; Free plan 100,000 requests/day applies to invocations). Default `Cache-Control: public, max-age=0, must-revalidate`.
- Third-party summaries say Pages is not deprecated but new work is steered to Workers; Cloudflare publishes a Pages-to-Workers migration guide. (Medium: I read the migration guide's existence only through search snippets before the budget ended.)

**F20. R2 as a web-seed store.** Confidence: **High** (prices, CORS), **Medium** (Range through a custom domain). Source: R2 pricing page "Last updated Oct 1, 2026". [S35][S36][S37][S38]
- Standard storage **$0.015/GB-month**, Class A **$4.50 per million**, Class B (reads) **$0.36 per million**; free per month: 10 GB-month, 1 M Class A, 10 M Class B (Standard only); Infrequent Access $0.01/GB-month, $0.01/GB retrieval, A $9.00/M, B $0.90/M, 30-day minimum; "There are no charges for egress bandwidth for any storage class."
- CORS: JSON array with `AllowedOrigins` (at most one `*` wildcard, ports cannot contain wildcards), `AllowedMethods`, `AllowedHeaders` ("Custom request headers must be listed here"), `ExposeHeaders`, `MaxAgeSeconds`; requests need an `Origin` header; propagation "up to 30 seconds"; custom domains connected to a bucket with a CORS policy "automatically return CORS response headers"; purge the cache after changing CORS on a cached hostname. Whether `"*"` is accepted in `AllowedHeaders` is not stated, so list headers explicitly (Appendix CFG-7).
- Public access: `r2.dev` is "rate-limited and should only be used for development"; WAF, caching and Bot Management need a **custom domain**, whose zone must be in the **same Cloudflare account**; "To cache all files in your bucket, you must set a Cache Everything page rule" (default caching is by file extension). The S3 API marks `GetObject` `Range` and conditional requests as implemented. The pages are silent on Range behaviour and compression through a public custom domain (open question).

**F21. Cloudflare terms of use for large files.** Confidence: **Medium**. Service-Specific Terms (last updated 2026-09-28), CDN section: "Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN", otherwise Cloudflare may "disable or limit your access". The Self-Serve Subscription Agreement (last updated 2025-09-12) has, as extracted, no section 2.8 (section 2 ends at 2.7), so the large-file rule I expected there is carried by the Service-Specific Terms. Implication: a web seed of multi-megabyte files behind a **Free zone proxying B2/S3** is a policy risk; R2 (Developer Platform) is the sanctioned route. I did not read the Developer Platform terms. [S41]

### E. Backblaze B2, Netlify, Vercel

**F22. Backblaze B2.** Confidence: **High** (pricing page, undated), **Medium** (Cloudflare guide). [S46][S47][S48]
- "$6.95 / TB / mo"; free egress up to **3x average monthly storage**, then **$0.01/GB**; "unlimited free egress when downloading to or through partner content delivery networks" (Fastly, Cloudflare, bunny.net named); Class A/B/C calls free for pay-as-you-go, Class D $0.004 per 10,000 (first 2,500/day free); first 10 GB free; no minimum file size or storage duration.
- Cloudflare guide: proxied CNAME to the bucket origin (`f000.backblazeb2.com`), Transform Rule rewriting the path to `/file/<bucket>/...`, SSL mode Full (strict), B2 serves only HTTPS; the page's front matter is `stale: true`, and it does not cover Range, CORS or Cloudflare terms.
- B2 CORS: S3-style rules, max **100 rules**, each under 1,000 bytes, `maxAgeSeconds` at most **86,400**, `allowedHeaders` supports exact names, trailing `*` or a single `*`; rules created through the S3 API can only be modified through the native API, and S3 `GetBucketCors` does not return rules set through the native API. Whether the rules apply through a Cloudflare custom domain is not documented.

**F23. Netlify and Vercel limits changed shape; neither is a good web seed.** Confidence: **High** for what the pages say; both pages are undated. [S49][S50][S51][S52]
- Netlify (credit-based): Free plan "300 credit limit"; Bandwidth **20 credits per GB** (so about **15 GB/month** if nothing else is used); web requests 2 credits per 10,000; production deploy 15 credits; Personal $9/month for 1,000 credits; Pro $20/month for 3,000 credits; Pro top-up 1,500 credits for $10 (about $0.133/GB). Whether Free credits reset monthly and what happens at zero are not stated on the page. SPA rule `/*  /index.html  200` applies only when no static file matches (add `!` to force). Wildcard custom domains: **unverified** (docs URL returned 404).
- Vercel: Hobby 100 GB/month Fast Data Transfer and 1 M CDN requests, "personal, non-commercial" only, hard caps; Pro $20/month includes 1 TB, then "starting at $0.15 per GB", 10 M requests then from $2 per million; default on-demand budget $200. Wildcard domains (`*.acme.com`) are supported, need Vercel nameservers or delegating `_acme-challenge` via two NS records to `ns1/ns2.vercel-dns.com`, Hobby limit 50 custom domains per project (docs `last_updated: 2026-09-16`).
- Measured defaults: both fail the stock WebTorrent preflight (F12).


### F. Wildcard origins and the Public Suffix List

**F24. Wildcard custom-domain support by host (for hub-mode per-site origins).** Confidence: **High** for the "yes" rows and the Cloudflare/GitHub "no" rows, **Low** where marked unverified. Design-critical: **yes** (a compatibility promise: which hosts can run hub mode with real isolation). Dates: AWS and GitHub docs undated; Vercel 2026-09-16; Cloudflare docs fetched 2026-10-17.

| Host | `*.hub.example` | How / limit | Source |
|---|---|---|---|
| CloudFront | **Yes** | ACM wildcard cert in us-east-1, alternate name `*.hub.example` (counts 1 of 100), Route 53 wildcard alias; apex needs its own SAN | [S5][S6][S7][S11] |
| Cloudflare Workers **route** | **Yes** | route `*.hub.example/*` (matches subhosts only), proxied wildcard DNS (all plans), Universal SSL covers first-level subdomains | [S34][S39][S40] |
| Cloudflare Pages | **No** | "not possible to add a custom domain with a wildcard" | [S33][S34] |
| Cloudflare Workers Custom Domains | **No** | "do not support wildcard DNS records" | [S39] |
| GitHub Pages | **No** (not documented; wildcard DNS discouraged) | one custom domain per repo, takeover warning | [S24] |
| Vercel | **Yes** | Vercel nameservers, or NS-delegate `_acme-challenge`; Hobby 50 domains/project | [S52] |
| Netlify | **Unverified** | docs page not found in this run | - |
| S3 website endpoint | n/a | HTTP only (F1) | [S1] |
| Amplify Hosting | Unverified | not read | - |

- Consequence for ARCHITECTURE section 3: "wildcard certificate, i.e. CloudFront+ACM or Cloudflare" should read "CloudFront+ACM, Vercel, or a Cloudflare **Worker route** (not Pages)". Per-origin cost: every new subdomain is a fresh origin, so a fresh SW install and shell download (about 110 KB brotli, Appendix C) and its own IndexedDB.

**F25. Public Suffix List facts.** Confidence: **High**. PSL data `VERSION: 2026-10-16_23-32-13_UTC`; guidelines wiki read 2026-10-17. [S59]
- These provider suffixes are on the PSL (exact line match): `github.io`, `pages.dev`, `workers.dev`, `r2.dev`, `netlify.app`, `vercel.app`, `cloudfront.net`, S3 website endpoints (e.g. `s3-website-us-east-1.amazonaws.com`), `web.app`, `firebaseapp.com`, `surge.sh`, and the tunnel suffixes `trycloudflare.com`, `ngrok-free.app`, `ngrok.io`, `ts.net`. So tenants of those providers are already separated from one another as "sites"; **a hub's own wildcard children (`x.hub.example`) are not** unless `hub.example` is itself listed.
- Listing requirements (wiki): a `_psl` TXT record pointing at the PR (kept in place), domain registration more than **2 years** beyond the PR date, a minimal and justified entry, submitted by the domain owner (not a third party); "Changes to the PSL may take time to percolate to clients" and maintainers "do not control the frequency of updates". No timeline is promised; plan for weeks to months, and design hub mode so it still works (with weaker cookie/site separation) before the listing lands. The wiki itself makes no security-boundary claim ("The PSL is just a list").

### G. CSP

**F26. CSP facts that decide the policy text.** Confidence: **High** (spec text read directly). [S55][S54]
- Scheme matching (CSP3 6.7.2.9): a source `https:` matches only `https`; `wss:` matches `wss` and `https`; `ws:` matches `ws`, `wss`, `http`, `https`; "connect-src ws: is treated as connect-src ws: wss:". The shell's existing `connect-src 'self' https: wss:` is therefore correct and both schemes are required (DoH, `.torrent` `xs=` URLs and web seeds are https; trackers are wss).
- `<meta http-equiv="Content-Security-Policy">`: "Neither are the report-uri, frame-ancestors, and sandbox directives" supported there, and `Content-Security-Policy-Report-Only` is not supported in a meta element; meta policies do not apply to content that precedes them, so the meta must be the first element in `<head>` (the current `index.html` does this). Clickjacking protection (`frame-ancestors`), violation reporting and `sandbox` therefore need real response headers (CloudFront response headers policy, Cloudflare `_headers`/Transform Rules, Netlify, Vercel), which **GitHub Pages cannot provide**.
- An inline `<script type="importmap">` is an inline script for CSP purposes (HTML "prepare the script element": `cspType` is "script", blocked when the policy forbids inline), so it needs a `'sha256-...'` entry in `script-src`; **external import maps are unsupported** ("External import maps and speculation rules are not currently supported"). The build can compute the hash. [S54]
- CSP has no WebRTC directive (research 03 F-38; BCD lists none), so `RTCPeerConnection`, ICE and STUN/TURN are unaffected by `connect-src`. [S57]
- Directive support: `worker-src` Chrome 59, Firefox 58, Safari 15.5 (older Safari falls back to `child-src`/`script-src`); `'wasm-unsafe-eval'` Chrome 97, Firefox 102, Safari 16; `upgrade-insecure-requests` is fine in meta. [S57]

**F27. What the current code needs from the CSP.** Confidence: **High** (grep of `src/`). [S64]
- `worker-src blob:` is only needed for `fsa-chunk-store`'s Safari-below-26 polyfill (01 F12); the project's own `pow-worker.js` is same-origin. If the project keeps its own IndexedDB chunk store and never touches the default store, `blob:` can be dropped from `worker-src`.
- `style-src 'unsafe-inline'` is load-bearing for **degraded mode**: `render.js` renders via `iframe.srcdoc`, and a `srcdoc` document inherits the creator's CSP, and it sets `style` attributes and inlines stylesheets (`el.setAttribute('style', ...)`). Normal mode (SW-served iframe) is governed by the headers the SW emits instead. Plain `el.style.x = ...` assignments (used in `app.js`/`ui.js`) are not blocked by CSP.
- `boot.js` probes dynamic import with `new Function('return import(...)')`. Under a CSP without `'unsafe-eval'` that throws `EvalError`, produces a console violation and a `securitypolicyviolation` event on every load, and would also violate `require-trusted-types-for`. The code already falls back to "modules and BigInt imply import()", so the probe can be deleted.
- Recommended policy text (meta and header variants): Appendix CFG-10.

### H. Subresource Integrity

**F28. What SRI can and cannot cover in a module-based shell.** Confidence: **High** (spec text + BCD). Design-critical: **yes** (ARCHITECTURE section 13 shell-integrity claim). [S54][S57]
- `integrity` on `<script>`/`<link>`: Chrome 45, Firefox 43, Safari 11.1; module scripts Chrome 61, Firefox 60, Safari 10.1. The attribute covers the **one** file named in the tag. The project already puts SRI on `boot.js` and a `modulepreload` for `loader.js`, and `boot.js` copies the preload's integrity onto the module script it injects.
- Import maps: `html/elements/script/type/importmap` Chrome 89, Firefox 108, Safari 16.4; **import-map `"integrity"` key** Chrome **127**, Firefox **138**, Safari **18** (all standard-track, shipped; Edge follows Chromium; Samsung Internet unknown). The HTML Standard: "Import maps can also be used to provide modules with integrity metadata to be used in Subresource Integrity checks ... enforced on the modules `/a-1.mjs` and `/d-1.mjs`, even if the latter is not defined as an import in the map." `resolve a module integrity metadata` is applied to every imported module through `get the descendant script fetch options` inside `HostLoadImportedModule`, i.e. to **static and dynamic imports alike**, and to the root of `<script type=module src>` when the tag has no `integrity` attribute.
- `<link rel=modulepreload>`: Chrome 66, Firefox 115, Safari 17; and "fetch a single module script" returns an existing module-map entry (or waits on an in-flight one) without a second fetch. So a `modulepreload` with `integrity` that completes or is in flight when `import()` runs makes the later `import()` consume the already-verified module (spec-derived inference, **not tested**); if the preload failed the check the entry is a failure and `import()` rejects.
- A page with neither feature (Safari/iOS 16.x, the project's stated floor in 01) gets **no** integrity check for a dynamically imported module.

**F29. The current design leaves `webtorrent.min.js` unverified; three fixes.** Confidence: **High** (code + spec). Design-critical: **yes**. [S64][S54]
- `CONFIG.paths.webtorrent = '/webtorrent.min.js'` and `timeouts.webtorrentLoadMs` ("dynamic import of /webtorrent.min.js"): the 223 KB library (SRI `sha384-IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7`, recomputed today and equal to research 01) is the largest executable code in the shell and the part that parses all peer and tracker input, yet it is not covered by any `integrity`.
- Fix A (strongest, simplest): **bundle it into `loader.js`** so the single SRI-checked file covers it; cost: about 56 KB brotli re-downloaded on each release. Fix B: inline import map `integrity` for `webtorrent.min.js` and `loader.js` **plus** a `<link rel=modulepreload integrity>` for browsers without import-map integrity; needs the CSP hash and still leaves Safari/iOS below 17 unprotected. Fix C: fetch the bytes, hash with `crypto.subtle`, and import from a `blob:` URL; rejected because it needs `blob:` in `script-src`.
- A service worker script and the web app manifest cannot carry SRI at all. The SW's integrity rests on same-origin HTTPS and the update algorithm.

**F30. Watch list (not for v1).** Confidence: **Medium**. [S57][S58][S61]
- `Integrity-Policy` response header: Chrome 138, Firefox about 145 (partial), Safari 26; `blocked-destinations=(script)` blocks scripts without integrity metadata; MDN lists it "Limited availability" and does not mention meta delivery or import-map interaction (unverified). Header-capable hosts only.
- `integrity="ed25519-<key>"` signature-based SRI: Chrome 141, experimental, Firefox and Safari no. Would let the page pin a publisher **key** instead of a hash (updates without editing the HTML) but needs `Signature` headers per response, which S3/GitHub Pages cannot emit.
- Trusted Types (`require-trusted-types-for 'script'`): Chrome 83, Firefox 148, Safari 26. The loader has one HTML sink (`iframe.srcdoc` in degraded mode), so a trial in report-only mode on a header host is cheap.
- Precedent for shell tamper evidence outside the platform: Meta's **Code Verify** browser extension checks JS served by Facebook/WhatsApp Web against a manifest of hashes (extension-only; Chrome, Firefox, Edge, Safari). I could not research the W3C WAICT proposal (search budget); treat it as unverified.

### I. Caching, versioning and the service worker

**F31. Service-worker script update rules.** Confidence: **High** (spec text). [S56]
- A registration is "stale" when its last update check is older than **86,400 s**; the update fetch uses cache mode `no-cache` when the registration's `updateViaCache` is not `all` (default **`imports`**), when forced, or when stale. Even without `no-cache`, "the user agent obeys Cache-Control header's max-age value in the network layer". The project registers with `register(url, { scope: '/' })`, so the default applies and `sw.js` is always revalidated by browsers.
- It registers a **classic** script (no `{ type: 'module' }`) although `src/sw/sw.js` has static `import` statements: the build must emit a single bundled classic file (esbuild IIFE) or registration fails. (How module-SW static imports are cached under `updateViaCache: 'imports'` was not verified; a single bundled file avoids the question.)
- Browsers revalidating is not enough: the **CDN edge** can still hold the old `sw.js`/`index.html` (CloudFront CachingOptimized default TTL 24 h; GitHub Pages fixed 10 min). IPFS's service-worker gateway hit exactly this in 2026 (a stale CDN copy of the bootstrap caused a reload loop until Cloudflare was purged; 04 F6).

**F32. Cache headers per host and the recommended layout.** Confidence: **High**. [S17][S19][S28][S39][S63]
- Defaults: CloudFront `CachingOptimized` min 1 s / default 24 h / max 365 d and honours the origin's `Cache-Control`; objects uploaded to S3 without `Cache-Control` get the 24 h default; Cloudflare Pages and Workers assets `public, max-age=0, must-revalidate` + ETag; GitHub Pages `max-age=600` and no way to change it.
- Recommended deploy layout: `/index.html`, `/404.html`, `/sw.js`, `/manifest.webmanifest` at the root with `Cache-Control: no-cache`; every other file under `/v/<build-id>/` with `Cache-Control: public, max-age=31536000, immutable` (index.html references versioned URLs and carries their SRI hashes; `__PRECACHE__` already exists as a build-time injection point); keep the previous two or three version directories for a while so cached/CDN-held `index.html` files still resolve. On GitHub Pages `immutable` cannot be sent (fixed 600 s), which is acceptable because the SW precache serves cache-first.
- Invalidation on CloudFront: `aws cloudfront create-invalidation --paths /index.html /404.html /sw.js /manifest.webmanifest` (4 paths; 1,000 free per month, then $0.005 each) [S21].
- Upload hygiene for S3: set `Content-Type` explicitly (`text/javascript` for `.js`/`.mjs`, `application/manifest+json` for `.webmanifest`, `image/svg+xml`, `text/html; charset=utf-8`); a `binary/octet-stream` default for `sw.js` is rejected by browsers (04 F9).

**F33. Precache and offline.** Confidence: **High** (code) / **Medium** (precedent). [S60][S64]
- The SW installs by fetching every `PRECACHE` entry with `cache: 'reload'` (to bypass the HTTP cache) after the page itself has just downloaded most of them, so a cold visit transfers the shell twice (model: about +1 M requests/month and +10 GB at 30% cold visits). Workbox's rule: URLs that already contain a content hash are cache keys "without any further modification"; unversioned URLs get a `__WB_REVISION__` query parameter derived from a build-time content hash. With `/v/<build-id>/` URLs the install can use normal cache mode and hit the HTTP cache. [S60]
- Install tolerates a missing optional asset (`res.ok` check) but also tolerates a missing **required** one such as `/webtorrent.min.js`, which would break offline silently; split `PRECACHE` into required (fail the install) and optional.
- Offline navigation is already covered: network-first with a 3 s timeout, then the cached shell; a host 404 for deep links returns the cached shell (`handleNavigation`). The remaining gap is storage eviction: Safari ITP deletes script-writable storage after 7 days without interaction for sites opened in a Safari tab (04 F21); there the offline promise holds only for Home-Screen installs. `navigator.storage.persist()` was not researched.

### J. Cost at 10k visits per day (model, not measurement)

**F34. Result.** Confidence: **Medium** (prices High, traffic assumptions are mine). Full assumptions, formulas and script: Appendix C.
- 10,000 visits/day = 300,000/month. Planning size of a cold shell visit about 110 KB brotli (gzip 135 KB on GitHub Pages), 11 requests; a warm visit about 10 KB and 10 requests. The loader does not build yet (esbuild fails on missing `./cache.js`); measured: `webtorrent.min.js` 222,929 B raw, 64,571 gzip, 55,969 brotli; `boot.js` 1.8 KB, `sw.js` 3.7 KB, `sdk.js` 1.4 KB brotli after minification.
- Monthly cost by scenario (web seed on the named host; GitHub Pages cannot be a web seed):

| Scenario | GB/mo | Req/mo | CloudFront PAYG + Function | CloudFront flat plan | R2 + Pages/Workers | B2 + Cloudflare | Netlify | Vercel Pro | Amplify |
|---|---|---|---|---|---|---|---|---|---|
| Shell only (site fully via peers) | 32 | 3.3 M | $0.20 | $15 (Pro) | $0 | $0 | $12 (Personal) | $20 | $3 |
| 5 MB site, 30% cold, 90% P2P | 56 | 3.6 M | $0.23 | $15 (Pro) | $0 | $0 | $17 (Personal) | $20 | $6 |
| 5 MB site, 30% cold, 0% P2P | 451 | 7.2 M | $0.67 | $15 (Pro) | $0 | $0 | $70 (Pro) | $20 | $65 |
| 5 MB site, 100% cold, 0% P2P | 1,497 | 17.1 M | $49 | $200 (Business, see note) | $1.4 | $0 | $222 | $105 | $222 |
| 25 MB site, 100% cold, 0% P2P | 7,356 | 48.3 M | $582 | $200 (Business) | $12.6 | $0 | $1,045 | $1,046 | $1,101 |

- Reading: the shell is negligible everywhere (GitHub Pages shell traffic is 14-39 GB/month against its 100 GB soft limit). Cost is decided by web-seed egress when P2P fails, where **zero-egress storage wins by one to two orders of magnitude**. For the CloudFront flat plans the allowances are soft: at 17 M requests the $15 Pro plan is 1.7x over its 10 M allowance, which AWS says is tolerated for a first spike and evaluated over 2-3 months, so the strict rule shown ($200) is conservative; and only Business/Premium allow the custom response-header policy that the preflight-passing CORS setup needs (F5), unless the Function supplies the headers.
- Avoidable multipliers (5 MB, 30% cold, 0% P2P, CloudFront PAYG): no preflight and no double-fetch 5.43 M requests; add per-file CORS preflights 7.23 M (+33%); add the `cache:'reload'` double precache 8.22 M (+51%).
- Not modelled: Route 53 ($0.50/zone-month + queries), WAF on PAYG, CloudWatch, S3 request charges beyond 5% origin fetches, DoH/tracker costs (third-party), TLS (ACM free).

### K. Phone and LAN demos

**F35. Secure-context requirement.** Confidence: **High**. [S58][S64]
- MDN: potentially trustworthy origins are hosts `127.0.0.0/8`, `::1/128`, `localhost`, and `*.localhost`; a LAN IP such as `192.168.x.x` is not on that list (the page never names LAN addresses, so this is by omission), and "Only secure contexts are allowed to register service workers". Research 01 F5 established that WebTorrent's SHA-1 piece hashing is `crypto.subtle.digest` with no JS fallback. Therefore over `http://192.168.x.x` the loader has no SW **and cannot hash pieces**. The demo claim in ARCHITECTURE section 11 ("prints the hub URL to open in any browser on the LAN") must say "over HTTPS or via localhost forwarding".
- WebRTC between the laptop and phone on the same LAN does not pass through any tunnel; tunnels carry only the page and the tracker WebSocket.

**F36. Demo options (ranked for this project).** Confidence: see column. Details and commands: Appendix D.

| Option | Phone needs | Secure context how | Limits / cost | WebSocket (tracker) | Confidence |
|---|---|---|---|---|---|
| Android USB port-forward (`adb reverse` / Chrome DevTools port forwarding) | USB debugging, Chrome | `http://localhost:PORT` on the phone | none; Android only | `ws://localhost:PORT` is same-class as the page | High (DevTools doc: open `localhost:PORT` on the device); `adb reverse` itself is not on the cited adb page (only `adb forward` is) |
| mkcert local CA | CA installed and trusted on the phone | HTTPS cert for LAN IP / `.local` name | free; CA key must stay private ("gives complete power to intercept secure requests") | tracker needs TLS too (F37) | High for README steps; iOS "Certificate Trust Settings" path is Apple's page (Medium); whether Android Chrome honours user CAs is not stated in the README (Medium) |
| Tailscale Serve | Tailscale app on the same tailnet | `tailscale serve --https=443 localhost:8080` gives `https://<machine>.<tailnet>.ts.net` with an automatically provisioned Let's Encrypt cert; requires MagicDNS + HTTPS Certificates enabled; machine names are published in Certificate Transparency logs; 90-day certs | free tier; tailnet only | Go `httputil.ReverseProxy` in `ipn/ipnlocal/serve.go` (WebSocket upgrade supported by that library, not re-verified here) | Medium-High |
| Tailscale Funnel | nothing (public) | same cert, public internet | ports **443, 8443, 10000 only**; "non-configurable bandwidth limits"; needs `funnel` node attribute; macOS needs an open-source Tailscale variant | unverified | Medium |
| Cloudflare quick tunnel | nothing | `cloudflared tunnel --url http://localhost:8080` gives `https://<random>.trycloudflare.com` | no account; "up to 200 in-flight requests" (429 beyond), **no SSE**, "no uptime guarantee", "for testing and development"; new hostname per run, so each run is a new origin with an empty SW/IndexedDB | `cloudflared` source handles WebSocket upgrades; Cloudflare WebSockets "supported on all plans"; quick-tunnel page itself silent | Medium-High |
| ngrok Free | nothing | free `*.ngrok-free.app` dev domain | **1 GB/month** transfer, **20,000** HTTP requests/month (4,000/min), 3 endpoints; **interstitial** page for HTML browser traffic (7-day cookie after click-through, bypass with request header `ngrok-skip-browser-warning` or a custom User-Agent) | not covered by the docs read | High (limits), Low (WS, iframe/SW interplay) |
| Chromium flag `--unsafely-treat-insecure-origin-as-secure="http://host:port"` | Chrome on a desktop (`chrome://flags` on Android not verified) | treats that origin as secure for the session | developer-only | n/a | Medium (doc shows a single-origin example) |

**F37. Exposing the tracker as `wss://` for HTTPS pages.** Confidence: **Medium** (source read, not run). [S62]
- A page on `https://` cannot use `ws://` to a LAN host (mixed content), and `ws://localhost` from a phone refers to the phone. Options: (a) **proxy `/tracker` on the same HTTPS dev server** (one cert, one port, one tunnel; recommended); (b) give `bittorrent-tracker` its own TLS: `Server` builds `new WebSocketServer({ server: this.http, ..., ...opts.ws })`, so `ws: { server: httpsServer }` overrides the server, or use `ws: { noServer: true }` and call `server.ws.handleUpgrade` from your HTTPS server; (c) a second tunnel hostname for the tracker (`wss://<other>.trycloudflare.com`).
- bittorrent-tracker 11 has no built-in TLS option; `opts.http` only passes options to `http.createServer`.

### L. Shell trust boundary

**F38. The static host and its CDN are the trusted computing base on first visit and on every SW update.** Confidence: **Medium** (analysis; no precedent searched). SRI does not cover the HTML document, the SW script or the manifest; once the SW is installed it pins the shell until an update check finds a new `sw.js`. So a compromised host or an S3 bucket takeover can ship a malicious loader to new visitors and to returning visitors at the next update. Cheap mitigations that fit the design: protect the deploy path (private bucket + OAC, MFA-delete/versioning, least-privilege CI role), HSTS preload on custom domains, keep prior versions, publish the shell's expected hash in the signed pointer or in DNS (`_magnet` TXT could carry a shell-hash for per-domain deployments) so the SW can refuse a mismatching update (design idea, **unverified**, would need a decision in 05/06). Browsers do not offer a platform mechanism for this today beyond `Integrity-Policy` for subresources (F30).


---

## Concrete recommendations for magnet-web

Priority P0 = fix before any public deployment guidance is written; P1 = needed for "production-ready"; P2 = important hardening or ergonomics; P3 = watch/optional. Effort S = under a day, M = a few days, L = a week or more. Each item names the evidence (F# = finding) and an acceptance test.

**REC-1 (P0, S) Publish the correct web-seed CORS contract everywhere.** Replace "allow header Range, expose Content-Range..." (ARCHITECTURE section 1, research 01 recommendation 5, `webseed-layout.txt` in `publish.mjs`) with: respond 2xx to `OPTIONS` with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`, `Access-Control-Allow-Headers: *` (or at least `range, cache-control, user-agent`), `Access-Control-Max-Age: 7200-86400`; honour `Range` with `206` and identity bytes. Ship the exact JSON for S3, R2, B2 and CloudFront (Appendix CFG-1 to CFG-8) and state plainly that `AllowedHeaders: ["Range"]` fails. Evidence F9-F11. Acceptance: a Playwright test that makes WebTorrent's exact fetch (headers `Cache-Control`, `user-agent`, `range`) against a local server configured as documented (passes) and as `["Range"]` (fails with a CORS error).

**REC-2 (P0, M) Build a "seed doctor", offline and at runtime.** `tools/check-webseed.mjs <ws-base> <site.torrent>` and a once-per-session loader probe that, before `addWebSeed`, checks: (1) `OPTIONS` with `Access-Control-Request-Headers: cache-control,range,user-agent` returns 2xx and a matching `Access-Control-Allow-*`; (2) `GET` of the first file with `Range: bytes=0-N` and `Accept-Encoding: gzip, br` returns **206**, no `Content-Encoding`, `Content-Range` total equal to the torrent's file length, body length N+1; (3) `res.redirected === false`; (4) a missing path returns 403/404, not `200 text/html`. On failure the loader does not add that web seed and shows which check failed and the remedy. Evidence F4, F8, F12: today the failure is silent piece-hash mismatch and endless retry. Acceptance: tests against deliberately broken fixtures (gzip-ranges, 200-ignoring-range, SPA-fallback-200, 301 redirect, no ACAH).

**REC-3 (P0, S) State the host policy for web seeds.** Recommended: Cloudflare R2 on a custom domain (zero egress), or B2 behind Cloudflare (mind the CDN clause, F21), or S3 + CloudFront with compression off and the CORS setup in Appendix CFG-3/CFG-4. Not supported cross-origin by default: GitHub Pages (OPTIONS 405, measured), Netlify, Vercel, jsDelivr and cdnjs (no Allow-Headers, measured); Cloudflare Pages is unverified and offers no control over compression. A same-origin web seed (`ws=/ws/` on the loader's own host) avoids CORS but not the compression hazard, so it is allowed only if the seed doctor (REC-2) passes. Evidence F12-F14, F20-F23.

**REC-4 (P0, S-M) Correct the demo story and make the dev tooling HTTPS-capable.** Edit ARCHITECTURE section 11: the LAN URL needs HTTPS or localhost forwarding. `tools/dev-server.mjs --https --cert lan.pem --key lan-key.pem` serves the loader and **reverse-proxies `/tracker` as a WebSocket** to the local tracker (one origin, one cert, one tunnel); `npm run demo` prints the Android `localhost` forwarding steps, the mkcert command with the detected LAN IP, and tunnel commands (Appendix D). Evidence F35-F37. Acceptance: Playwright (Chromium and WebKit) loads the hub over `https://` with `wss://.../tracker`, two tabs exchange the example site.

**REC-5 (P1, M) Put every executable file under SRI.** Preferred: bundle `webtorrent.min.js` into `loader.js` (assert the vendored file's sha384 equals the pinned `IexsdEUd...` before bundling). If lazy loading is wanted: inline `<script type="importmap">` with `"integrity"` for `loader.js` and `webtorrent.min.js`, a `<link rel=modulepreload integrity>` for both, and the import map's `sha256-` in `script-src`; document that Safari/iOS below 17 get no check. Add a unit test: every `<script src>`, modulepreload and import-map target in `dist/index.html` has an integrity value that matches the file. Evidence F28-F29.

**REC-6 (P1, M) Versioned immutable shell and a deploy that cannot serve a mixed version.** Emit `dist/v/<build-id>/{boot,loader,sdk,pow-worker,ui.css,...}`; root keeps `index.html`, `404.html`, `sw.js`, `manifest.webmanifest`, icons; `PRECACHE` lists versioned URLs and install uses the default cache mode (no `cache:'reload'`); `build.mjs --host=<aws|cloudflare|ghpages|netlify|vercel>` also writes the host's header/redirect file from one source of truth (cache rules, CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy). `deploy/aws/deploy.sh` (Appendix CFG-12) uploads with explicit `Content-Type` and `Cache-Control`, then invalidates four root paths. Evidence F31-F33; model: about 1 M fewer requests/month at 10k visits/day.

**REC-7 (P1, M) Remove WebTorrent's two non-safelisted request headers so most hosts need no preflight.** In `build.mjs`, patch the vendored bundle: the web-seed `fetch` in `webtorrent.min.js` contains exactly one `headers:{"Cache-Control":"no-store","user-agent":\`WebTorrent/${cn} (https://webtorrent.io)\`,range:` (identifier `cn` is minifier output, so match on the fixed strings and assert exactly one hit). Replace with `headers:{range:`, keep `cache:"no-store"` (the user agent adds its own `Cache-Control: no-cache` after the preflight decision), record both the original and patched sha384, and fail the build if the pattern is missing after an upgrade. Effect: web-seed requests become CORS-simple (`Range: bytes=a-b` is safelisted), removing the per-URL OPTIONS requests (about -25% requests in the model) and making hosts that merely send `ACAO: *` on GET (measured: GitHub Pages, Vercel, cdnjs, jsDelivr, unpkg) pass the CORS stage; it does not fix compression (REC-2/REC-3/REC-10). Alternatives: a SW that re-issues cross-origin web-seed requests with only `range` (spec-derived, F9, untested) or a custom `connId` connection via `addWebSeed` (needs bundling bittorrent-protocol). Also propose the change upstream. Acceptance: Playwright on **Chromium, Firefox and WebKit** records zero `OPTIONS` requests and successful piece verification; Firefox/WebKit Range safelisting is unverified today.

**REC-8 (P1, M) Ship a reference AWS deployment.** IaC under `deploy/aws/` (Terraform or CloudFormation): private S3 bucket (Block Public Access, versioning), OAC and the bucket policy (CFG-2), CloudFront distribution with behaviors per Appendix CFG-3, the Function (CFG-4), ACM certificate in us-east-1 (apex + wildcard) with DNS validation, Route 53 records, response-headers policy, optional separate `seed.` distribution for the web seed. Document the flat-rate caveat (custom header policies need Business, F6) and that nothing here was tested end to end. Acceptance: `verify-deploy` (REC-14) passes against a scratch account.

**REC-9 (P1, S) Harden `publish.mjs`.** Reject or rename file paths containing `#`, `?`, `%`, backslash, control characters, or leading/trailing space (F8); set the torrent `name` to `<dn>-<first 8 hex of the content hash>` so web-seed objects can be `immutable`; print the exact upload commands with `Content-Type: application/octet-stream` and `Cache-Control: public, max-age=31536000, immutable` (S3 `aws s3 sync`, R2 via `wrangler`/rclone, B2) and the `check-webseed` command to run next.

**REC-10 (P2, L) Evaluate a single-file archive layout for web-seeded sites.** One torrent file `site.tar` (or store-only zip) means one web-seed URL, hence no per-file preflights, no `<name>/<path>` mapping, no path-encoding hazard, octet-stream MIME (outside CloudFront's compress list) and a simple same-origin story on GitHub Pages; the loader unpacks into the existing IndexedDB store (it downloads everything anyway). Needs a pointer decision (new `v=mw2`, or an explicit key old loaders must reject) and a tar reader (about 60 lines). Unverified: whether GitHub Pages' Fastly leaves `.bin`/`.tar` uncompressed under `Accept-Encoding: gzip` (test before committing). Design-critical because it changes the pointer grammar.

**REC-11 (P2, S) Per-host recipes in DEPLOY.md.** GitHub Pages: `CNAME`, `.nojekyll`, `404.html` (copy of index.html), Actions workflow deploy (avoids the 10 builds/hour soft limit), custom domain or user/org site only, and the list of headers it cannot send. Cloudflare Pages: **omit top-level `404.html`** so SPA mode applies, `_headers` block (CFG-5). Cloudflare Workers assets: `wrangler.jsonc` with `not_found_handling: "single-page-application"` (CFG-6). Netlify: `_redirects` `/*  /index.html  200` and `_headers`. Vercel: `vercel.json` rewrites and headers. Each recipe lists what was measured and what was not.

**REC-12 (P2, M) Base-path support or an explicit "root only" rule.** The loader, SW and `CONFIG.paths` use root-absolute URLs and the `/_mw/` prefix; GitHub project sites (`/repo/`) and any sub-path deployment break (F16). Either compute a base at runtime from the script's own URL, or document "custom domain or user/org site only" and make `verify-deploy` fail otherwise.

**REC-13 (P2, S) CSP profiles and conformance test.** Two builds of the policy: hub (broad `https: wss:`) and pinned per-domain (exact web-seed, tracker and DoH hosts taken from the pinned `<meta mw-pointer>`). Add the import-map hash, drop `blob:` from `worker-src` if the default OPFS store is never used, remove the `new Function` probe in `boot.js`, and add an e2e step that fails on any `securitypolicyviolation`. On header-capable hosts add `frame-ancestors 'self'`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. Evidence F26-F27.

**REC-14 (P2, S) `tools/verify-deploy.mjs <url>`.** Checks (Appendix CFG-13): HTTP to HTTPS redirect and valid cert; HSTS on header hosts; `sw.js` JavaScript MIME, `no-cache`, scope allowed; `index.html` `no-cache`; deep link returns the shell (200, or 404 accepted only for the GitHub Pages profile); `/v/*` immutable; CSP present and equal to the build's; `Content-Type` of `manifest.webmanifest`; the seed doctor (REC-2) when `ws=` is set; and `_magnet` TXT parse (05). Run in CI against staging and as a post-deploy gate.

**REC-15 (P2, M) Wildcard hub guide and PSL decision.** Reference configs for CloudFront wildcard and a Cloudflare Worker route with a proxied wildcard record (F18, F24); state that Pages and GitHub Pages cannot do hub isolation; decide whether to apply for PSL listing of the hub domain (2-year registration rule, unpredictable propagation, F25) and ship hub mode working without it.

**REC-16 (P3, S) Cost guardrails.** For S3/CloudFront web seeds add an AWS Budgets alarm and a WAF rate-based rule; prefer zero-egress stores; document that Netlify's Free plan is about 15 GB/month of bandwidth and Vercel Hobby is non-commercial (F23); keep the `max=` pointer cap so a bad pointer cannot trigger a 100 MB-per-visit download.

**REC-17 (P3, S) Watch list.** `Integrity-Policy` header on header hosts, signature-based SRI, Trusted Types in report-only mode, WAICT-style web integrity (F30).

**REC-18 (P3, M) Optional shell-hash pinning.** Let a per-domain pointer or `<meta>` carry a hash of the shell's file set and have the SW refuse an update that does not match (F38). Needs a decision with the pointer/security work in 05/06.

---

## Gotchas

1. "Range triggers a preflight" is a myth for `Range: bytes=N-M`; WebTorrent's `Cache-Control` and `user-agent` headers trigger it (F9). `AllowedHeaders: ["Range"]` therefore fails.
2. The preflight cache is per URL and defaults to 5 seconds without `Access-Control-Max-Age`; browsers cap larger values (R2 docs say about 2 hours) (F10).
3. A preflight cannot be redirected: an S3 bucket in another region answering 301, a 405 from GitHub Pages, or a 403 from S3 without CORS rules all kill it (F10, F12).
4. CloudFront `CORS-With-Preflight` sets no `Access-Control-Allow-Headers`; S3 sends CORS headers only when the request has an `Origin`; CloudFront does not vary the cache on Origin unless the cache policy says so (F5).
5. Custom error responses (403/404 to index.html 200) are distribution-wide and also rewrite missing web-seed objects into `200 text/html` (F4).
6. A private bucket behind OAC returns 403, not 404, for a missing key unless `s3:ListBucket` is granted (F4).
7. An ACM certificate for CloudFront must live in us-east-1; a wildcard covers one label and not the apex; one certificate per distribution; alternate names must be lowercase (F3).
8. Range requests on compressed representations return bytes of the compressed stream on GitHub Pages and jsDelivr, and CloudFront documents the same; the client cannot send `Accept-Encoding: identity` (F12).
9. WebTorrent builds web-seed URLs by string concatenation; `#`, `?`, `%` in file names break (F8).
10. GitHub Pages: OPTIONS 405, fallback HTTP 404, fixed `max-age=600`, no custom headers (no HSTS, nosniff or CSP observed), 100 GB/month soft limit, no commercial use, Jekyll skips `_`-prefixed files, project sites need a base path (F14-F16).
11. Cloudflare Pages: a top-level `404.html` disables SPA mode; `_headers` values for the same header are comma-joined across matching rules; headers are not applied to Functions responses; no wildcard custom domains; apex needs Cloudflare nameservers (F17-F18).
12. Cloudflare R2: `r2.dev` is rate-limited and for development only; WAF and caching need a custom domain in a zone on the same account; default caching is by extension; CORS changes can need a cache purge; `AllowedHeaders: ["*"]` acceptance is not documented (F20).
13. Cloudflare's CDN terms say video and other large files through the CDN need the Developer Platform or other paid services; a Free zone proxying a large B2/S3 web seed is a policy risk (F21).
14. Netlify's Free plan is roughly 15 GB/month of bandwidth in credits; Vercel Hobby is non-commercial and hard-capped; both defaults fail the stock WebTorrent preflight (F12, F23).
15. A `<meta>` CSP cannot carry `frame-ancestors`, `report-uri` or `sandbox` and must come first in `<head>`; an inline import map needs a hash in `script-src`; external import maps do not exist (F26).
16. `style-src 'unsafe-inline'` is needed by degraded-mode `srcdoc` rendering because `srcdoc` inherits the shell's CSP (F27).
17. Dynamic `import()` has no integrity option; import-map integrity needs Chrome 127, Firefox 138 or Safari 18; `modulepreload` needs Chrome 66, Firefox 115 or Safari 17; iOS 16 has neither (F28).
18. `sw.js` must be one classic bundled file because it is registered without `type: 'module'`; it must have a JavaScript MIME type; CDN edges can serve a stale copy for hours (F31).
19. The SW's `cache:'reload'` precache re-fetch doubles first-visit shell requests (F33).
20. Quick tunnels, ngrok and Funnel give a new origin per hostname, so the SW and IndexedDB start empty every run; quick tunnels cap at 200 in-flight requests and drop SSE; ngrok Free shows an interstitial to HTML browser traffic and caps at 1 GB and 20,000 requests per month; Funnel allows only ports 443, 8443, 10000 and publishes the machine name in CT logs (F36).
21. mkcert's root key "gives complete power to intercept secure requests"; install only the public `rootCA.pem` on phones, never share `rootCA-key.pem` (F36).
22. A 64-hex (v2) infohash does not fit one DNS label (63 octets); the hub scheme assumes 40 hex (F3).
23. The shell size used in the cost model (110 KB brotli) is an estimate because the loader does not build yet (`./cache.js` missing); re-measure after the first build (F34).
24. WebFetch returns model extractions; the numbers behind decisions were cross-checked where a second source existed, but Cloudflare/Backblaze/Netlify/Vercel/AWS pricing should be re-read on the vendor page before any budget commitment.

---

## Open questions

1. Does a CloudFront response headers policy apply to a response generated by a viewer-request Function, and does an S3 REST origin behind OAC return a 2xx preflight when the bucket has the CORS rule in CFG-1 and CloudFront forwards OPTIONS with the `CORS-S3Origin` policy? (No AWS account was used; CFG-3/CFG-4 are designed to be independent of both.)
2. Do Firefox and Safari (WebKit) treat `Range: bytes=N-M` as safelisted exactly as the Fetch Standard says, and do they add `user-agent` to `Access-Control-Request-Headers` for WebTorrent's current fetch? (Only Chromium was measured, in research 01.)
3. Does a service worker that re-issues cross-origin web-seed requests with only `range` really remove the preflight in all three engines, and from which moment (first load, before `clients.claim()`) does it apply?
4. What status code does Cloudflare Pages return for the SPA fallback, does it answer OPTIONS, and does it honour Range on assets? (Docs are silent; Workers assets return 200 for SPA fallback.)
5. Does an R2 public custom domain return identity 206 for `Range` under `Accept-Encoding: gzip, br` for common text types, and does `AllowedHeaders: ["*"]` work? Same for B2 through Cloudflare, including CORS on the custom domain.
6. Does GitHub Pages leave `.bin`/`.tar` files uncompressed under `Accept-Encoding: gzip` (needed for the archive layout, REC-10)?
7. Do quick tunnels, ngrok and Tailscale Serve pass WebSocket upgrades for `wss://.../tracker` in practice, and does the ngrok interstitial break a SW-served iframe? (cloudflared source and Cloudflare docs say yes for Cloudflare; the other two were not verified.)
8. Does Netlify support wildcard custom domains and on which plans; what happens when the Free credits reach zero?
9. How long does a PSL submission take now, and is a hub domain with user-controlled children accepted under the "minimal entries" rule?
10. Does any Cloudflare proxy feature (Rocket Loader, minification, Browser Insights, Email Obfuscation, Zaraz) rewrite the shell's HTML or JS and thereby break SRI or CSP if Cloudflare is placed in front of GitHub Pages or S3? (Not researched.)
11. Samsung Internet support for import-map `integrity` (BCD has no value) and for `modulepreload` with `integrity`.
12. What are the real shell sizes after the first successful build (brotli and gzip), and the real request count of a cold visit, so Appendix C can be re-run with measured inputs?
13. Do the hosts' acceptable-use terms (Netlify, Vercel, GitHub, Cloudflare Developer Platform) allow a site whose visitors re-serve its content to each other? Only the GitHub and Cloudflare CDN clauses were read.
14. WAICT and similar web-integrity proposals: status and whether they could replace REC-18. (Search budget exhausted.)


---

## Appendix A - Sources (all read on 2026-10-17 unless a page date is given)

AWS (all docs undated; fetched through WebFetch):
- [S1] https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteEndpoints.html
- [S2] https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html
- [S3] https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html
- [S4] https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GeneratingCustomErrorResponses.html ; .../custom-error-pages-response-code.html ; .../custom-error-pages-expiration.html ; https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_CustomErrorResponses.html
- [S5] https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html
- [S6] .../cnames-and-https-requirements.html
- [S7] .../alternate-domain-names-wildcard.html
- [S8] .../ServingCompressedFiles.html
- [S9] .../RangeGETs.html
- [S10] .../private-content-restricting-access-to-s3.html
- [S11] .../cloudfront-limits.html
- [S12] https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
- [S13] .../using-managed-response-headers-policies.html
- [S14] .../using-managed-origin-request-policies.html
- [S15] .../understanding-response-headers-policies.html
- [S16] .../header-caching.html
- [S17] .../using-managed-cache-policies.html
- [S18] .../DownloadDistValuesCacheBehavior.html
- [S19] .../flat-rate-pricing-plan.html
- [S20] https://aws.amazon.com/cloudfront/pricing/ ; https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/
- [S21] AWS Price List API: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudFront/current/index.json (publicationDate 2026-10-03T00:04:26Z) ; https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/20261015173540/us-east-1/index.json (publicationDate 2026-10-15T17:35:40Z)
- [S22] https://aws.amazon.com/amplify/pricing/

GitHub (undated): [S23] https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits ; [S24] .../configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site ; [S25] .../creating-a-custom-404-page-for-your-github-pages-site ; [S26] .../securing-your-github-pages-site-with-https ; [S27] https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/about-github-pages-and-jekyll

Cloudflare: [S28] https://developers.cloudflare.com/pages/configuration/headers/ ; [S29] .../pages/configuration/redirects/ ; [S30] .../pages/configuration/serving-pages/ ; [S31] .../pages/platform/limits/ ; [S32] .../pages/configuration/custom-domains/ ; [S33] .../pages/platform/known-issues/ ; [S34] .../dns/manage-dns-records/reference/wildcard-dns-records/ ; [S35] .../r2/pricing/ (page says "Last updated Oct 1, 2026") ; [S36] .../r2/buckets/cors/ ; [S37] .../r2/buckets/public-buckets/ ; [S38] .../r2/api/s3/api/ ; [S39] .../workers/static-assets/billing-and-limitations/ , .../workers/platform/limits/ , .../workers/configuration/routing/routes/ , .../workers/configuration/routing/custom-domains/ , .../workers/static-assets/headers/ , .../workers/static-assets/routing/single-page-application/ ; [S40] .../ssl/edge-certificates/universal-ssl/ ; [S41] https://www.cloudflare.com/service-specific-terms-application-services/ (last updated Sept 28, 2026) and https://www.cloudflare.com/terms/ (Self-Serve Subscription Agreement, last updated Sept 12, 2025) ; [S42] .../network/websockets/ ; [S43] .../speed/optimization/content/compression/ ; [S44] .../cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/ ; [S45] https://raw.githubusercontent.com/cloudflare/cloudflared/master/proxy/proxy.go

Backblaze: [S46] https://www.backblaze.com/cloud-storage/pricing ; [S47] https://www.backblaze.com/docs/cloud-storage-deliver-public-backblaze-b2-content-through-cloudflare-cdn (front matter `stale: true`) ; [S48] https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules

Netlify / Vercel: [S49] https://www.netlify.com/pricing/ (undated) ; [S50] https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/ ; [S51] https://vercel.com/pricing (undated) ; [S52] https://vercel.com/docs/domains/working-with-domains/add-a-domain (`last_updated: 2026-09-16`)

Web platform (raw text read): [S53] https://raw.githubusercontent.com/whatwg/fetch/main/fetch.bs ; [S54] https://raw.githubusercontent.com/whatwg/html/main/source ; [S55] https://w3c.github.io/webappsec-csp/ ; [S56] https://w3c.github.io/ServiceWorker/ ; [S57] browser-compat-data `main`: https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/script.json , .../html/elements/link.json , .../http/headers/Content-Security-Policy.json , .../http/headers/Integrity-Policy.json ; [S58] https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Integrity-Policy , https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_request_header , https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts ; [S59] https://publicsuffix.org/list/public_suffix_list.dat (VERSION 2026-10-16_23-32-13_UTC) and https://github.com/publicsuffix/list/wiki/Guidelines ; [S60] https://developer.chrome.com/docs/workbox/modules/workbox-precaching ; [S61] https://github.com/facebookincubator/meta-code-verify

Local: [S62] `node_modules/webtorrent/lib/webconn.js`, `lib/torrent.js`, `dist/webtorrent.min.js` (3.0.21), `node_modules/bittorrent-tracker/server.js` ; [S63] own curl measurements (Appendix E) ; [S64] project files `docs/ARCHITECTURE.md`, `docs/INTERFACES.md`, `docs/research/01,03,04,05`, `src/loader/index.html`, `config.js`, `boot.js`, `render.js`, `src/sw/sw.js`

Dev demos: [S65] https://raw.githubusercontent.com/FiloSottile/mkcert/master/README.md ; [S66] https://ngrok.com/docs/pricing-limits/free-plan-limits/ ; [S67] https://tailscale.com/kb/1242/tailscale-serve , https://tailscale.com/kb/1223/funnel , https://tailscale.com/kb/1153/enabling-https , https://raw.githubusercontent.com/tailscale/tailscale/main/ipn/ipnlocal/serve.go ; [S68] https://developer.chrome.com/docs/devtools/remote-debugging/local-server , https://www.chromium.org/Home/chromium-security/deprecating-powerful-features-on-insecure-origins/ , https://developer.android.com/tools/adb

Search-result snippets only (pages not fetched): the Cloudflare community threads on Pages wildcard domains (consistent with the official pages [S33][S34], which I did fetch) and third-party Pages-versus-Workers comparisons plus the official migration guide URL https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/ (F19).

Attempted but not usable: AWS re:Post knowledge-center article on CORS errors (HTTP 403 to WebFetch); `docs.netlify.com` custom-domain pages (404); the CloudFront Functions "generate HTTP response" page (returned only a title, so the Function-generated OPTIONS response in CFG-4 rests on general knowledge); ngrok FAQ (silent on WebSockets); WebSearch (budget exhausted).

## Appendix B - Ready-to-use configuration

**CFG-1. S3 CORS for a web-seed bucket** (console takes the bare array; the CLI wants the `CORSRules` wrapper, from the API shape, not re-fetched):
```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```
`aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{"CORSRules":[ ...the object above... ]}'`. Wrong (fails the WebTorrent preflight): `"AllowedHeaders": ["Range"]`. Use the regional virtual-hosted endpoint (`https://BUCKET.s3.REGION.amazonaws.com/...`) so S3 never answers 301.

**CFG-2. Bucket policy for CloudFront OAC** (from the AWS doc; Block Public Access stays on, Object Ownership "Bucket owner enforced"):
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontServicePrincipalReadOnly",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::BUCKET/*",
    "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID" } }
  }]
}
```

**CFG-3. CloudFront layout** (no custom error responses; HTTPS only; HTTP/2 and 3 on; certificate = apex + `*.hub.example` from ACM in us-east-1). Prefer a **separate hostname/distribution for the web seed** (`seed.example`) so its compression, CORS and cost are isolated; the table shows both as behaviors.

| Path pattern | Methods | Cache policy | Response headers policy | Compress | Function (viewer-request) |
|---|---|---|---|---|---|
| `/v/*` | GET, HEAD | CachingOptimized `658327ea-f89d-4fab-a63d-7e88639e58f6`; objects carry `Cache-Control: public, max-age=31536000, immutable` | security headers (managed `SecurityHeadersPolicy` `67f7725c-6f97-4210-82d7-5512b31e9d03`, or custom with CSP) | yes | none |
| `/ws/*` (or `seed.` distribution) | GET, HEAD, OPTIONS | CachingOptimizedForUncompressedObjects `b2884449-e4de-46a7-ac36-70bc7f1ddd6d` | custom: ACAO `*`, ACAM `GET, HEAD, OPTIONS`, ACAH `*`, ACEH `Content-Range, Content-Length, Accept-Ranges, ETag`, Max-Age 86400, origin override on (needs pay-as-you-go or Business+) | **no** | `mw-edge` (CFG-4) |
| `*` (default) | GET, HEAD | CachingOptimized | custom security headers + CSP (+ `frame-ancestors 'self'`, HSTS) | yes | `mw-edge` (SPA rewrite) |

Variant for flat-rate Free/Pro (managed policies only): `/ws/*` uses managed `UseOriginCacheControlHeaders` (`83da9c7e-98b4-4e11-a168-04f0df8e2c65`, Origin is in its cache key), origin request policy `CORS-S3Origin` (`88a5eaf4-2fd4-4709-b370-b4c650ea3fcf`), methods include OPTIONS, the S3 CORS rule CFG-1 answers preflights, and the managed `CORS-With-Preflight` (`5cc3b908-e619-4b99-88e5-2cf7f45965bd`) keeps S3's `Access-Control-Allow-Headers` because "Override origin" is off. Untested.

**CFG-4. CloudFront Function `mw-edge`** (runtime cloudfront-js-2.0, viewer-request; 10 KB limit; the OPTIONS short-circuit assumes Functions may return a response, which I could not re-read in the docs this run):
```js
var SHELL = { '/index.html': 1, '/404.html': 1, '/sw.js': 1, '/manifest.webmanifest': 1, '/robots.txt': 1, '/favicon.ico': 1 };
var CORS = {
  'access-control-allow-origin': { value: '*' },
  'access-control-allow-methods': { value: 'GET, HEAD, OPTIONS' },
  'access-control-allow-headers': { value: '*' },
  'access-control-max-age': { value: '86400' }
};
function handler(event) {
  var r = event.request, u = r.uri;
  if (r.method === 'OPTIONS') return { statusCode: 204, statusDescription: 'No Content', headers: CORS };
  // Real objects: a miss must stay a miss (403/404), never turn into index.html.
  if (u.indexOf('/v/') === 0 || u.indexOf('/ws/') === 0 || u.indexOf('/icons/') === 0 || SHELL[u]) return r;
  // Everything else is a virtual site path; the shell + SW resolve it.
  r.uri = '/index.html';
  return r;
}
```

**CFG-5. Cloudflare Pages `_headers`** (do not ship a top-level `404.html` on Pages, or SPA mode is off; do not repeat `Cache-Control` in `/*` because same-name headers from several matching rules are comma-joined):
```
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' blob: data:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'

/index.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/manifest.webmanifest
  Cache-Control: no-cache
/v/*
  Cache-Control: public, max-age=31536000, immutable
```

**CFG-6. Cloudflare Workers static assets with wildcard hub** (`wrangler.jsonc`; each hostname needs a proxied DNS record, so add a proxied wildcard `*` record with a placeholder target; Universal SSL covers `*.hub.example` on a full setup):
```jsonc
{
  "name": "magnet-web-hub",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./dist", "not_found_handling": "single-page-application" },
  "routes": [
    { "pattern": "hub.example/*", "zone_name": "hub.example" },
    { "pattern": "*.hub.example/*", "zone_name": "hub.example" }
  ]
}
```
(route syntax from general Wrangler knowledge, not re-fetched; the route and DNS rules are from [S39][S34].)

**CFG-7. R2 CORS** (dashboard JSON; headers listed explicitly because `*` acceptance is undocumented):
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
Serve through a custom domain in the same account, add a Cache Rule to cache all objects, purge the hostname after CORS edits, upload objects as `application/octet-stream`.

**CFG-8. B2 CORS rule** (native API form; operation identifiers from the B2 API, the docs page prints display names):
```json
[{ "corsRuleName": "mw-webseed", "allowedOrigins": ["*"],
   "allowedOperations": ["s3_get", "s3_head", "b2_download_file_by_name"],
   "allowedHeaders": ["*"], "exposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
   "maxAgeSeconds": 86400 }]
```

**CFG-9. GitHub Pages**: repository root of the published branch/artifact must contain `CNAME` (custom domain), `.nojekyll`, `404.html` (copy of `index.html`), and the build output; deploy with a custom workflow so the 10 builds/hour soft limit does not apply (action versions indicative, pin current majors):
```yaml
name: pages
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.d.outputs.page_url }}" }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci && npm run build -- --host=ghpages
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - id: d
        uses: actions/deploy-pages@v4
```

**CFG-10. CSP.** Baseline = the policy already in `src/loader/index.html` (kept: it is correct per F26). Additions only:
- Meta (all hosts): add `upgrade-insecure-requests`; if an inline import map is used add `'sha256-<hash of the exact script text>'` to `script-src`; drop `blob:` from `worker-src` when the OPFS default store is not used; keep `style-src 'unsafe-inline'` while degraded mode exists.
- Header (CloudFront, Cloudflare, Netlify, Vercel): the same string plus `frame-ancestors 'self'`, and optionally `report-to csp-endpoint` with a `Reporting-Endpoints` header and a `Content-Security-Policy-Report-Only: require-trusted-types-for 'script'` trial.
- Pinned per-domain profile: replace `https: wss:` by the exact origins in the pinned pointer (web seed, `xs=`, trackers) plus the DoH origins from research 05 (`https://cloudflare-dns.com https://dns.google https://doh.sb`).

**CFG-11. Import map with integrity** (only if the library stays a separate file; hashes computed by `build.mjs`):
```html
<script type="importmap">{"imports":{"webtorrent":"/v/ab12cd34/webtorrent.min.js"},
 "integrity":{"/v/ab12cd34/webtorrent.min.js":"sha384-IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7",
              "/v/ab12cd34/loader.js":"sha384-<loader hash>"}}</script>
<link rel="modulepreload" href="/v/ab12cd34/webtorrent.min.js" integrity="sha384-IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7">
```
The import map must come before any module script. If REC-7 patches the library, the hash is of the patched file.

**CFG-12. AWS deploy order** (assets first, entry files last, then invalidate):
```bash
set -euo pipefail; ID=$(cat dist/BUILD_ID)
aws s3 cp dist/v/$ID/ s3://$BUCKET/v/$ID/ --recursive --exclude '*' --include '*.js' \
  --content-type 'text/javascript; charset=utf-8' --cache-control 'public,max-age=31536000,immutable'
aws s3 cp dist/v/$ID/ s3://$BUCKET/v/$ID/ --recursive --exclude '*' --include '*.css' \
  --content-type 'text/css; charset=utf-8' --cache-control 'public,max-age=31536000,immutable'
aws s3 cp dist/v/$ID/ s3://$BUCKET/v/$ID/ --recursive --exclude '*' --include '*.svg' \
  --content-type 'image/svg+xml' --cache-control 'public,max-age=31536000,immutable'
aws s3 cp dist/sw.js s3://$BUCKET/sw.js --content-type 'text/javascript; charset=utf-8' --cache-control 'no-cache'
aws s3 cp dist/manifest.webmanifest s3://$BUCKET/manifest.webmanifest --content-type 'application/manifest+json' --cache-control 'no-cache'
aws s3 cp dist/404.html s3://$BUCKET/404.html --content-type 'text/html; charset=utf-8' --cache-control 'no-cache'
aws s3 cp dist/index.html s3://$BUCKET/index.html --content-type 'text/html; charset=utf-8' --cache-control 'no-cache'
aws cloudfront create-invalidation --distribution-id "$DIST" --paths /index.html /404.html /sw.js /manifest.webmanifest
```

**CFG-13. Post-deploy checks** (what `verify-deploy.mjs` should assert):
```bash
curl -sI https://example.com/sw.js | grep -i -E '^(content-type|cache-control)'           # JS MIME, no-cache
curl -sI https://example.com/any/deep/link.html | head -1                                  # 200 (GitHub Pages profile: 404)
curl -sI https://example.com/v/$ID/loader.js | grep -i cache-control                       # immutable
curl -si -X OPTIONS -H 'Origin: https://x.example' -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: cache-control,range,user-agent' https://seed.example/NAME/index.html   # 2xx + ACAO + ACAH
curl -sI -H 'Accept-Encoding: gzip, br' -H 'Range: bytes=0-99' https://seed.example/NAME/index.html   # 206, no content-encoding, content-range total == file length
curl -sI https://seed.example/NAME/does-not-exist.html | head -1                           # 403/404, never 200
```

## Appendix C - Cost model

Script: `cost_model.py` (kept in the session scratchpad, not in the repo; the functions below reproduce it). Prices: Appendix A [S21][S22][S35][S46][S49][S51]. All GB are GiB (a 7% unit difference between vendors is ignored). Visits = 10,000/day x 30 days = 300,000/month; every visit is a distinct "visitor" (no repeat-visit discount beyond the warm-visit share).

| Parameter | Value | Basis |
|---|---|---|
| Cold shell visit | 110 KB brotli (135 KB gzip on GitHub Pages), 11 requests | estimate: webtorrent 56 KB + other bundles; loader not buildable yet |
| Warm visit | 10 KB, 10 requests | index + sw.js update check + conditional shell revalidation |
| Piece length | 256 KiB | ARCHITECTURE section 10 |
| Web-seed requests per cold visit | `ceil(site/256 KiB) x 1.3 x (1 - P2P)`, plus up to 20 OPTIONS (one per distinct file URL) when cross-origin with non-safelisted headers | webconn per-piece-per-file requests (01 F10) |
| Cold share | 30% (typical) or 100% (worst case, e.g. iOS ITP eviction) | assumption |
| P2P share of site bytes | 0%, 90% | assumption; real swarm health unknown |
| CloudFront PAYG | 1 TB + 10 M requests + 2 M Function executions free; $0.085/GB tiers; $0.01 per 10,000 HTTPS; $0.10 per M Function executions; S3 $0.023/GB-month and 5% of requests as S3 GETs at $0.0004 per 1,000 | [S21][S20] |
| CloudFront flat plan | cheapest plan whose request/GB allowance covers usage (allowances are soft) | [S19] |
| R2 | Class B ops beyond 10 M at $0.36 per M; storage beyond 10 GB; egress $0 | [S35] |
| B2 + Cloudflare | storage $6.95/TB-month beyond 10 GB; CDN egress free | [S46] |
| Netlify | credits = 20 per GB + 2 per 10,000 requests; Free 300 credits; Personal $9 for 1,000 (+$0.01/credit); Pro $20 for 3,000 (+$10 per 1,500) | [S49] |
| Vercel Pro | $20 + $0.15/GB over 1 TB + $2 per M requests over 10 M | [S51] |
| Amplify | $0.15/GB over 15 GB | [S22] |

Result table: see F34. Sensitivity: with the preflight removed (REC-7) and versioned precache (REC-6), the 5 MB / 30% cold / 0% P2P case drops from 8.22 M to 5.43 M requests per month (-34%) with identical bytes.

## Appendix D - Phone and LAN demo recipes

1. **Android over USB (no certificates).** Enable USB debugging; Chrome DevTools "Port forwarding" maps device `localhost:8080` to the laptop's `localhost:8080` (documented, [S68]); equivalent CLI `adb reverse tcp:8080 tcp:8080` and `adb reverse tcp:8000 tcp:8000` (from `adb help`, not on the cited page). Open `http://localhost:8080/#magnet:...` on the phone; the tracker is `ws://localhost:8000` (the page is itself plain-HTTP localhost, so no mixed-content problem). Secure context holds because `localhost` is potentially trustworthy (MDN).
2. **mkcert LAN HTTPS.** `mkcert -install`; `mkcert -cert-file lan.pem -key-file lan-key.pem 192.168.1.23 mac.local localhost 127.0.0.1 ::1` (options go before the names); `mkcert -CAROOT` prints the folder with `rootCA.pem` (public, send to the phone) and `rootCA-key.pem` ("complete power to intercept secure requests", never share). iOS: AirDrop or email `rootCA.pem`, install the profile ("Settings > Profile Downloaded"), then enable full trust for it (the exact Settings path is on Apple's page, Medium). Android: install as a CA certificate; apps need "user roots" enabled, whether Chrome honours user CAs is not stated in the README. Run `node tools/dev-server.mjs --https --cert lan.pem --key lan-key.pem --port 8443` (proposed flags, REC-4) with `/tracker` proxied.
3. **Tailscale.** Enable MagicDNS and HTTPS Certificates in the admin console; `tailscale serve --https=443 --bg localhost:8080` gives `https://<machine>.<tailnet>.ts.net` (Let's Encrypt, 90-day certs, hostname in CT logs); the phone needs the Tailscale app on the same tailnet. `tailscale funnel` makes it public on ports 443/8443/10000 only with bandwidth limits. Syntax per KB 1242/1223; confirm with `tailscale serve --help`.
4. **Cloudflare quick tunnel.** `cloudflared tunnel --url http://localhost:8080` prints `https://<random>.trycloudflare.com`; no account; 200 in-flight requests; no SSE; "no uptime guarantee". Put the tracker behind the same dev server (`/tracker`) so one tunnel carries both; a second `--url http://localhost:8000` tunnel gives a separate `wss://` host if needed.
5. **ngrok Free.** `ngrok http 8080`; 1 GB/month, 20,000 requests/month (4,000/min), one dev domain, interstitial for HTML browser traffic (send `ngrok-skip-browser-warning` or a custom User-Agent to bypass; click-through sets a 7-day cookie). Lowest preference.
6. **Chromium desktop only.** `--unsafely-treat-insecure-origin-as-secure="http://192.168.1.23:8080"` treats that origin as secure for the session (single-origin example in the Chromium doc).
- In every case the proxied tracker URL must be added to the dev `CONFIG.trackers` (dev build only) and to the dev CSP (`ARCHITECTURE` section 13 already adds `ws://127.0.0.1:* ws://localhost:*` for development).

## Appendix E - Measurement log (curl, 2026-10-17, from the project machine)

```
# GitHub Pages root (pages.github.com): HTTP/2 200, server GitHub.com, cache-control: max-age=600, access-control-allow-origin: *,
#   accept-ranges: bytes, vary: Accept-Encoding, via varnish (Fastly), no strict-transport-security / x-content-type-options / content-security-policy
# OPTIONS (Origin: https://example.org, ACRM: GET) with ACRH = range | cache-control | cache-control,range,user-agent | none | and with no Origin at all
#   -> HTTP/2 405, server: Varnish, no access-control-* headers (all six variants tried)
# Missing path https://pages.github.com/this/path/does-not-exist/ -> HTTP/2 404, text/html, 9,379 bytes (GitHub's default 404 page)
# GET /css/pages.css  Accept-Encoding: gzip, br      -> 200, content-encoding: gzip, content-length: 3412
#   Range: bytes=0-99 + Accept-Encoding: gzip, br     -> 206, content-encoding: gzip, content-range: bytes 0-99/3412
#   Range: bytes=0-99 + Accept-Encoding: (none)       -> 206, content-range: bytes 0-99/12226
# GET /js/application.js: gzip 2158 bytes vs identity 8554 bytes; the Range response again reports the gzip total (0-99/2158)
# jsDelivr webtorrent.min.js: full GET content-encoding: br, 66074 bytes; Range 0-99 -> 206, content-encoding: br, content-range 0-99/66074 (identity 222929)
# cdnjs jquery.min.js: Range 0-99 -> 200, content-encoding: br, whole body (27446 bytes)
# unpkg webtorrent.min.js: Range 0-99 -> 206, no content-encoding, content-range 0-99/222929
# Netlify vuejs.org: full GET content-encoding: br (11787 B); Range 0-99 -> 206, no content-encoding, content-range 0-99/83785
# Vercel react.dev: full GET content-encoding: br; Range 0-99 -> 206, no content-encoding, content-range 0-99/272438
# OPTIONS (ACRH cache-control,range,user-agent): vuejs.org 200 no CORS headers | react.dev 204 ACAO * ACAM "OPTIONS, GET, HEAD" no ACAH |
#   unpkg 200 ACAO * ACAH * ACAM "GET, HEAD, OPTIONS, POST" | cdnjs 200 ACAO * | jsDelivr 200 ACAO * ACEH * | pages.github.com 405
# Local: webtorrent.min.js 222,929 B raw / 64,571 gzip -9 / 55,969 brotli-11; sha384 IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7
# Local esbuild: boot.js 5,637 B (1,796 br), sw.js 10,424 B (3,657 br), sdk.js 3,623 B (1,428 br); app.js fails: Could not resolve "./cache.js"
```
Caveat: vuejs.org, react.dev, cdnjs and unpkg may carry site-specific edge configuration; their rows describe those deployments, not a vendor guarantee.

## Appendix F - Edits to existing docs implied by this research

- ARCHITECTURE section 1 (web seeds): replace the CORS sentence with the REC-1 contract; add "identity bytes for ranges, no redirects, no SPA fallback on the seed path".
- Section 3 (hub wildcard): "CloudFront+ACM, Vercel, or a Cloudflare Worker route (not Pages, not GitHub Pages)"; one-label wildcard; PSL optional; 63-octet label note.
- Section 5/7 (shell and SW): versioned `/v/<build-id>/` assets, normal cache mode in precache, required vs optional precache entries, bundled classic `sw.js`.
- Section 10 (tooling): `build.mjs --host=`, header/redirect manifests, webtorrent bundling/patch step with hash assertions, `publish.mjs` filename lint and name suffix, `check-webseed.mjs`, `verify-deploy.mjs`, `dev-server.mjs --https` with `/tracker` proxy.
- Section 11 (demo): HTTPS or localhost forwarding only.
- Section 13 (security): shell integrity must name how `webtorrent.min.js` is covered (REC-5); meta CSP limits and the header-host baseline; remove the `new Function` probe.
- `src/loader/config.js`: `paths.webtorrent` disappears if bundled; otherwise versioned.
- Research 01 recommendation 5 and `webseed-layout.txt`: superseded by REC-1.
