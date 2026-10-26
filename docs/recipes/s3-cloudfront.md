# Amazon S3 and CloudFront

A private S3 bucket behind CloudFront, as the host of a drop-in or shell site and, with a CORS rule, as a web seed.
It is the most configurable option and the strongest for hubs (wildcard certificates), and it bills per GB and per
request once the free allowance is used.

| | |
|---|---|
| Roles | drop-in host: yes; shell host: yes; web seed: yes (same distribution, or a separate one with CORS); hub with wildcard subdomains: yes |
| Status | not yet tested with a felinar deployment. The facts below come from AWS documents and price lists read on 2026-10-17 and probes of third-party S3 and CloudFront endpoints ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F6; [w1-10](../research/w1-10-static-hosting-bootstrap.md), F1 to F5) |
| Price (list, 2026-10-17, US) | CloudFront $0.085 per GB for the first 10 TB and $1.00 per million HTTPS requests; always free each month: 1 TB and 10 million requests. S3 storage $0.023 per GB-month. S3 served directly: $0.09 per GB after 100 GB ([CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/)) |

## Shape

- **The S3 REST endpoint with Origin Access Control**, bucket private. S3 website endpoints are HTTP only, and a
  browser runs the loader only on HTTPS.
- **An ACM certificate in us-east-1** for your domain (and `*.hub.example.com` for a hub).
- **CloudFront error responses** for unknown paths: S3 answers 403 for a missing key behind Origin Access Control, so
  map 403 and 404 to `/404.html` with response code 404.
- **Directory URLs.** CloudFront's default root object applies only to `/`. A site with `about/index.html` needs a
  viewer-request function that adds `index.html` to URLs ending in `/`:

  ```js
  function handler(event) {
    var request = event.request;
    if (request.uri.endsWith('/')) request.uri += 'index.html';
    return request;
  }
  ```

## Drop-in site

1. Publish your built site ([recipes](README.md#the-steps-every-recipe-shares)).
2. Upload non-HTML files first, HTML last, then the worker with `no-cache`:

   ```sh
   aws s3 sync dist-publish/site/ s3://<bucket>/ --exclude "*.html" --exclude "*.htm"
   aws s3 sync dist-publish/site/ s3://<bucket>/ --exclude "*" --include "*.html" --include "*.htm" \
     --cache-control no-cache
   aws s3 cp dist-publish/site/mw-sw.js s3://<bucket>/mw-sw.js \
     --cache-control no-cache --content-type text/javascript
   ```

   `sync` never deletes, so the previous version's files stay; remove old files after a week if you like.

3. Purge CloudFront so returning visitors get the new worker and pages at once. Give `/mw-sw.js` a cache policy with
   a minimum TTL of 0 (for example the managed `CachingDisabled`): a higher minimum keeps the old worker at the edge
   for that long, `no-cache` or not.

   ```sh
   aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
   ```

4. Check it:

   ```sh
   node tools/check-site.mjs https://www.example.com/
   ```

Every drop-in visitor on an unmetered network fills a copy of your non-HTML files once, and CloudFront bills those
bytes ([MIGRATION.md](../MIGRATION.md#egress-budget-for-copies-not-page-views)).

## Shell site

Upload `dist-publish/shell/` to the bucket root and the web seed (`my-site/`, `my-site.torrent`, `genesis.json`) under
`ws/`, and publish with `--ws https://example.com/ws/`. A web seed on the same distribution is same-origin, so it needs
no CORS. Send `/mw-sw.js` and `/index.html` with `Cache-Control: no-cache`.

## A web seed for another origin

Give the bucket a CORS rule. `AllowedHeaders` must be `["*"]`: the often-quoted `["Range"]` fails the preflight of a
stock WebTorrent client.

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

```sh
aws s3api put-bucket-cors --bucket <bucket> --cors-configuration '{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Range","Content-Length","Accept-Ranges","ETag"],"MaxAgeSeconds":86400}]}'
```

In CloudFront, allow `GET`, `HEAD` and `OPTIONS` on the web seed's behaviour, turn compression off there, and either
attach a custom response headers policy that allows every request header (pay-as-you-go, or the Business flat-rate
plan and up) or forward the CORS request headers to S3 with the managed origin request policy `CORS-S3Origin`, so S3
answers the preflight from the rule above. The managed `CORS-With-Preflight` policy alone sends no
`Access-Control-Allow-Headers`. The full behaviour table and the custom policy are in
[DEPLOY.md](../DEPLOY.md#amazon-s3-and-cloudfront). Both setups are designs from the research, not tested end to end
([w1-10](../research/w1-10-static-hosting-bootstrap.md), open question 1). Then:

```sh
node tools/check-webseed.mjs https://seed.example.com/r/2026-10-19/ dist-publish/site.torrent
```

## Limits and known problems

- **Requests, not bytes, decide the bill for a many-file web seed.** A cold visit costs about one request per piece
  plus one per file: about 230 for an 8 MB site of 200 files, and twice that with the preflights of a stock WebTorrent
  client (felinar's loader sends none in Chromium and WebKit). With the stock request the research's model priced
  that site at $28.79 a month on CloudFront at 10,000 visits a day, past the free allowance
  ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F5 and F20; a model, not a bill).
- **Custom response-header policies** are a Business-tier feature on CloudFront's flat-rate plans.
- **S3 REST endpoints speak HTTP/1.1 only**; CloudFront in front speaks HTTP/2 and HTTP/3.
