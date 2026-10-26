# Backblaze B2 as a web seed

Backblaze B2 as the storage behind a CDN, serving a shell site's web seed. B2 is cheap to store in and free to read
through its partner CDNs; read directly, it bills egress beyond a small allowance.

| | |
|---|---|
| Roles | cross-origin web seed behind a CDN: yes; site host: no (no custom domain without a CDN) |
| Status | not yet tested. The facts below come from Backblaze's documents and a probe of a public B2 file on 2026-10-17 ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F9) |
| Price (list, 2026-10-17) | $6.95 per TB-month, first 10 GB free; free egress up to 3 times your average stored data, then $0.01 per GB; unlimited free egress through partner CDNs, including Cloudflare, Fastly, bunny.net and CacheFly ([B2 pricing](https://www.backblaze.com/cloud-storage/pricing)) |

## What B2 needs

- **A CDN in front.** A custom domain on B2 needs a CDN, and the "3 times stored data" allowance is tiny for a small
  site (a 24 MB site stored in three versions earns about 0.2 GB a month). Put Cloudflare or Bunny in front.
- **CORS rules.** "By default, the Backblaze B2 servers will deny preflight requests." A bucket takes up to 100 rules.
- **A public bucket**, which B2 allows once the account has a verified e-mail address and payment history.

## Steps

1. Create a public bucket and add a CORS rule (B2 web console, the bucket's CORS Rules, custom rules):

   ```json
   [
     {
       "corsRuleName": "mw-webseed",
       "allowedOrigins": ["*"],
       "allowedOperations": ["s3_get", "s3_head", "b2_download_file_by_name"],
       "allowedHeaders": ["*"],
       "exposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
       "maxAgeSeconds": 86400
     }
   ]
   ```

2. Point a CDN hostname such as `seed.example.com` at the bucket (Backblaze documents the Cloudflare and Bunny setups).

3. Publish with a release prefix in the web seed address and upload through B2's S3-compatible API:

   ```sh
   node tools/publish.mjs ~/my-site/public --name my-site --scope example.com --key ~/keys/my-site-owner.jwk \
     --ws https://seed.example.com/r/2026-10-19/ --tr public --ct mailto:abuse@example.com --shell --out dist-publish
   aws s3 sync dist-publish/my-site/ s3://<bucket>/r/2026-10-19/my-site/ \
     --endpoint-url https://s3.<region>.backblazeb2.com --content-type application/octet-stream
   aws s3 cp dist-publish/my-site.torrent s3://<bucket>/r/2026-10-19/my-site.torrent \
     --endpoint-url https://s3.<region>.backblazeb2.com --content-type application/octet-stream
   ```

4. Check the web seed, then the site:

   ```sh
   node tools/check-webseed.mjs https://seed.example.com/r/2026-10-19/ dist-publish/site.torrent
   node tools/check-site.mjs https://example.com/
   ```

## Limits and known problems

- **B2's download hosts** (`f00X.backblazeb2.com`) speak HTTP/1.1 only; the CDN in front speaks HTTP/2.
- **A range that covers the whole file** gets 200 instead of 206 from B2's native API (the S3-compatible API answers
  206). `check-webseed` reports how your setup answers.
- **Cloudflare's terms** ask for its developer platform (R2, Pages, Workers) to serve "video and other large files";
  B2 proxied through a free Cloudflare zone is a policy risk for big payloads ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F26).
