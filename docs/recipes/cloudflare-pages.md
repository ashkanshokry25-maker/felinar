# Cloudflare Pages

Cloudflare Pages as the host of a drop-in site, or as the host of a shell site's loader. It serves static requests for
free with no bandwidth charge, which makes drop-in copies cost nothing. It can't be a web seed: it answers `Range`
requests with the whole file.

| | |
|---|---|
| Roles | drop-in host: yes; shell host: yes, with the web seed on another host ([Cloudflare R2](cloudflare-r2.md)); web seed: no |
| Status | not yet tested with a felinar deployment. The facts below come from Cloudflare's documents read on 2026-10-17 and probes of Cloudflare-served sites ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F8; [w2a-05](../research/w2a-05-seo-crawlers.md), F44) |
| Price and limits | free static requests and bandwidth on all plans; on the free plan 20,000 files per deploy and 25 MiB per file, 100 custom domains per project ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)) |

## What Cloudflare Pages does that matters

| Behaviour | Effect |
|---|---|
| "Pages currently returns 200 responses for HTTP range requests" ([Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/), updated 2026-10-10) | never use it as a web seed; drop-in doesn't need `Range` from the host, because the worker reads files same-origin and slices them itself |
| No top-level `404.html` means SPA mode: every unknown path answers 200 with `/` | multi-page drop-in sites must ship a `404.html`, or search engines see soft 404s |
| `/contact.html` redirects to `/contact` | canonical URLs must be the extension-less form |
| `_redirects` and `_headers` in the deploy are honoured | your rules keep working in drop-in mode; `publish` keeps both files in `site/` |
| No wildcard custom domains on Pages | for a hub, use Workers routes instead |

## Drop-in site

1. Publish your built site ([recipes](README.md#the-steps-every-recipe-shares)), making sure the build has a
   `404.html`:

   ```sh
   node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
     --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
     --ct mailto:abuse@example.com --out dist-publish
   ```

2. Add the worker's header to your site's `_headers` (in your build output, so it lands in `site/`):

   ```text
   /mw-sw.js
     Cache-Control: no-cache
   ```

3. Merge the previous version's non-HTML files into the upload, because each Pages deploy replaces the whole site
   ([MIGRATION.md](../MIGRATION.md#step-3-upload-non-html-files-first-then-html)), then deploy:

   ```sh
   rsync -a --ignore-existing --exclude "*.html" --exclude "*.htm" previous-site/ dist-publish/site/
   npx wrangler pages deploy dist-publish/site --project-name my-site
   ```

4. Check it:

   ```sh
   node tools/check-site.mjs https://www.example.com/
   ```

## Shell site

Deploy `dist-publish/shell/` as the Pages project and put the web seed on R2 ([Cloudflare R2](cloudflare-r2.md)),
publishing with `--ws https://seed.example.com/r/<release>/`. The shell ships a `404.html` (a copy of the loader),
so every unknown path gets the loader.

## Limits and known problems

- **Rocket Loader** rewrites script tags behind Cloudflare. The runtime tag carries `data-cfasync="false"` before
  `src`, which keeps it out; `publish` warns about pages whose tag lacks it.
- **Byte-changing features** (Polish image optimisation, minification) on a zone in front of your site change file
  bytes after you published. Those files fail verification and come from the host instead;
  `check-site` lists them. Turn the features off for site files.
- **Large files.** Cloudflare's terms require its developer platform (Pages, R2, Workers) for "video and other large
  files"; Pages is that platform, a free zone proxying another host isn't ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F26).
- **Workers static assets** is Cloudflare's newer path for static sites, with free static requests and wildcard routes
  for hubs; whether it answers `Range` correctly is unverified, and no recipe covers it yet.
