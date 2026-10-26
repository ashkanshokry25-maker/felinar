# Bunny Storage and CDN as a web seed

Bunny's storage zone behind a Bunny pull zone, serving a shell site's web seed. It is cheap, has no request fees and
needs no Cloudflare zone; its CORS preflight behaviour is the one thing nobody has checked yet.

| | |
|---|---|
| Roles | cross-origin web seed: yes once CORS is on (preflight unverified); site host: not researched |
| Status | not yet tested. The facts below come from Bunny's documents and probes of bunny.net's own zone on 2026-10-17 ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F10) |
| Price (list, 2026-10-17) | CDN, standard network: $0.01 per GB in Europe and North America, $0.03 in Asia and Oceania, $0.045 in South America, $0.06 in the Middle East and Africa; volume network $0.005 per GB; storage from $0.01 per GB-month; no request fees; $1 a month minimum ([Bunny CDN pricing](https://bunny.net/pricing/cdn/)) |

## Steps

1. Create a storage zone and a pull zone that serves it, with a hostname such as `seed.example.com` and a free Let's
   Encrypt certificate (if Cloudflare proxies that hostname, turn the proxy off for the certificate).
2. In the pull zone, turn on CORS for the extensions the web seed uses (Headers settings) or add an edge rule that sets
   `Access-Control-Allow-Origin: *`, and turn on "Optimize for large object delivery" so uncached `Range` requests work.
3. Publish with a release prefix in the web seed address (`--ws https://seed.example.com/r/2026-10-19/`, as in the
   [R2 recipe](cloudflare-r2.md)), and upload `dist-publish/my-site/` and `my-site.torrent` under that prefix with
   Bunny's storage API, FTP or a sync tool.
4. Check the web seed. If the verdict is FAIL-cors because the preflight isn't answered, Bunny's edge doesn't answer
   `OPTIONS` the way the gate expects; felinar's loader sends no preflight in Chromium and WebKit, and
   `--allow-no-preflight` accepts that, but Firefox and Safari weren't measured:

   ```sh
   node tools/check-webseed.mjs https://seed.example.com/r/2026-10-19/ dist-publish/site.torrent
   node tools/check-site.mjs https://example.com/
   ```

## Limits and known problems

- **Compression.** Bunny compresses listed types (`.css`, `.js`, `.json`, `.svg`, `.html` among them). Browsers ask for
  identity bytes on a `Range` request, and the probe got a correct 206 that way; a request that accepts gzip gets a
  200 with the whole compressed file.
- **Wildcard certificates** are automatic only when the domain's DNS is on Bunny DNS.
- **Limits** per storage zone: 100 concurrent connections per IP per server, 500 requests per second on the S3 API.
