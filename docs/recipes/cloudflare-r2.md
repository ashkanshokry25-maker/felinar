# Cloudflare R2 as a web seed

Cloudflare R2 as the cross-origin web seed of a shell site: the host that keeps the site loading when nobody else is
online. R2 charges nothing for egress, which makes it the research's recommended web seed. Drop-in sites don't need a
separate web seed: the drop-in worker uses your own host.

| | |
|---|---|
| Roles | cross-origin web seed: yes (recommended); site host: not researched |
| Status | not yet tested. Nobody has checked a real R2 bucket: `Range` through R2's cache on a custom domain is unverified ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F7 and open question 1). Run `check-webseed` before you rely on it |
| Price (list, 2026-10-17) | storage $0.015 per GB-month; reads $0.36 per million; writes $4.50 per million; egress $0; free each month: 10 GB-month, 1 million writes, 10 million reads ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)) |

## What R2 needs

- **A hostname on a Cloudflare zone in the same account.** A custom domain is only possible when the domain's DNS is
  on Cloudflare; the "partial" (CNAME) setup for outside DNS is a Business and Enterprise feature. The web seed's
  address isn't shown to visitors, so a separate hostname such as `seed.example.com` is fine. The `r2.dev` address is
  rate-limited and "for development" only.
- **A CORS policy.** R2 sends no CORS headers by default.
- **A cache rule.** Without "Cache Everything", Cloudflare caches only some file extensions in front of R2.

## Steps

1. Create a bucket (for example `my-site-seed`) and connect the custom domain `seed.example.com` to it in the R2
   dashboard.

2. Set the bucket's CORS policy (R2 dashboard, the bucket's Settings, CORS policy):

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

   The headers are listed one by one because R2's documents don't say whether `"*"` is accepted there. felinar's
   loader sends only `Range`; the other two keep the bucket usable by stock WebTorrent clients. After changing CORS on
   a hostname that already served traffic, purge its cache: cached answers keep their old headers.

3. Add a Cache Rule for `seed.example.com` with "Cache Everything" and a long edge TTL.

4. Publish the site with a release prefix in the web seed address, so each version has its own immutable copy:

   ```sh
   node tools/publish.mjs ~/my-site/public --name my-site --scope example.com --key ~/keys/my-site-owner.jwk \
     --ws https://seed.example.com/r/2026-10-19/ --tr public --cs https://seed.example.com/r/2026-10-19/genesis.json \
     --ct mailto:abuse@example.com --shell --out dist-publish
   ```

   The `.torrent` goes next to the files by default (`xs=` is `<ws>/my-site.torrent`).

5. Upload `dist-publish/my-site/`, `my-site.torrent` and `genesis.json` under that prefix through R2's S3-compatible
   API (an AWS CLI profile with your R2 access key and `region = auto`), as `application/octet-stream` with a long,
   immutable cache lifetime, so the edge neither compresses nor recompresses them:

   ```sh
   aws s3 sync dist-publish/my-site/ s3://my-site-seed/r/2026-10-19/my-site/ \
     --endpoint-url https://<account-id>.r2.cloudflarestorage.com --profile r2 \
     --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable, no-transform"
   aws s3 cp dist-publish/my-site.torrent s3://my-site-seed/r/2026-10-19/my-site.torrent \
     --endpoint-url https://<account-id>.r2.cloudflarestorage.com --profile r2 \
     --content-type application/octet-stream --cache-control "public, max-age=31536000, immutable, no-transform"
   aws s3 cp dist-publish/genesis.json s3://my-site-seed/r/2026-10-19/genesis.json \
     --endpoint-url https://<account-id>.r2.cloudflarestorage.com --profile r2 --content-type application/json
   ```

6. Check the web seed before the pointer goes live, then deploy `dist-publish/shell/` to your shell host
   ([Cloudflare Pages](cloudflare-pages.md) works well) and check the whole site:

   ```sh
   node tools/check-webseed.mjs https://seed.example.com/r/2026-10-19/ dist-publish/site.torrent
   node tools/check-site.mjs https://example.com/
   ```

   `check-webseed` sends the CORS preflight and a ranged GET per file the way a browser does, hashes the first and the
   last piece, and gives a verdict: PASS, PASS-needs-patched-client (fine for felinar's loader), or one of
   FAIL-range-ignored, FAIL-wrong-bytes, FAIL-cors and FAIL. Publishing again with `--verify-ws` withholds the
   pointer until it passes.

## Limits and known problems

- **The edge may ignore `Range` when it must decompress a response** (Cloudflare's cache documentation). Uploading as
  `application/octet-stream` with `no-transform` is meant to avoid that; it hasn't been checked on a real bucket.
- **Request counts.** A cold visit makes about one request per piece plus one per file. R2 bills reads only when they
  reach the bucket; whether cache hits count as reads isn't stated in the documents the research read.
- **Keep old releases** for at least 7 days after the pointer moves on: visitors still on them fetch from them.
- **Writes are limited to 1 per second per object key**, which only matters for scripts that rewrite one file in a
  loop.
