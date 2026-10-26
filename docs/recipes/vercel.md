# Vercel

Vercel as the host of a drop-in site, a shell site's loader, or a hub with wildcard subdomains. The Hobby plan is free
but non-commercial; Pro bills bandwidth and requests.

| | |
|---|---|
| Roles | drop-in host: yes; shell host: yes; hub with wildcard subdomains: yes; cross-origin web seed: only without a preflight, and not at scale |
| Status | not yet tested with a felinar deployment. The facts below come from Vercel's documents (updated 2026-09-14) and a probe of a Vercel-hosted site on 2026-10-17 ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F14) |
| Price (list, 2026-10-17) | Hobby: free, "personal, non-commercial use only", 100 GB of data transfer and 1 million CDN requests a month. Pro: $20 a month with $20 of usage, then $0.15 to $0.35 per GB and $2.00 to $3.20 per million requests by region, or Flat Rate CDN tiers ([Vercel pricing](https://vercel.com/pricing)) |

## Drop-in site

1. Publish your built site ([recipes](README.md#the-steps-every-recipe-shares)).
2. Put a `vercel.json` next to the files in `dist-publish/site/` with the worker's header:

   ```json
   {
     "headers": [
       { "source": "/mw-sw.js", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] }
     ]
   }
   ```

   Add your site's own redirects and headers there too; Vercel doesn't read `_redirects` or `_headers`.

3. Merge the previous version's non-HTML files into the upload
   ([MIGRATION.md](../MIGRATION.md#step-3-upload-non-html-files-first-then-html)), then deploy the folder:

   ```sh
   rsync -a --ignore-existing --exclude "*.html" --exclude "*.htm" previous-site/ dist-publish/site/
   npx vercel deploy dist-publish/site --prod
   ```

4. Check it:

   ```sh
   node tools/check-site.mjs https://www.example.com/
   ```

## Shell site

Deploy `dist-publish/shell/` as the project. Unknown paths get the shell's `404.html`, so every URL gets the loader.
Put the web seed on a host with free or flat egress ([Cloudflare R2](cloudflare-r2.md)).

## Limits and known problems

- **Commercial use** needs Pro; "commercial" includes a site built by a paid employee.
- **As a web seed** Vercel answers the preflight without `Access-Control-Allow-Headers`. The loader's own requests
  send no preflight in Chromium and WebKit, but `check-webseed` passes it only with `--allow-no-preflight`, and request
  pricing makes a many-file web seed expensive: the research's 8 MB, 200-file example needed the $100 Flat Rate tier
  at 10,000 visits a day with the stock request (a model, [w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F14 and F20).
- **Wildcard domains** need Vercel's nameservers or a delegation of `_acme-challenge`.
