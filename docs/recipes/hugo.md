# Hugo

An existing Hugo site, moved to felinar in drop-in mode. Hugo writes a plain multi-page site, which is the easiest
case: your host keeps serving every page, and the other files come from the visitor's verified copy after the first
page view.

| | |
|---|---|
| Fits | drop-in: strong (static pages, the host's 404 and redirects stay); shell: works, but crawlers see only the loader |
| Status | research lab: Hugo 0.168.0 built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). The shipped loader hasn't served a Hugo build, and the Hugo commands below weren't run for this page |
| You need | Hugo, Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

In `hugo.toml`, set the final origin and keep root-absolute URLs (the default):

```toml
baseURL = 'https://www.example.com/'
enableRobotsTXT = true
# relativeURLs stays false (the default)
```

`baseURL` ends up in canonical links, Open Graph tags and `sitemap.xml`, so build with the production value, never
`localhost`.

## 2. Build

```sh
cd ~/my-site
hugo
```

Hugo writes the site to `public/`.

## 3. Publish

From your felinar clone:

```sh
node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

`--inject-script` adds the runtime tag to every page. To keep it in your templates instead, put this in the `<head>`
of your base layout and drop the flag:

```html
<script data-cfasync="false" type="module" src="/_mw/mw.js" async></script>
```

## 4. Deploy and check

Deploy `dist-publish/site/` with your host's recipe ([GitHub Pages](github-pages.md),
[Cloudflare Pages](cloudflare-pages.md), [Netlify](netlify.md), [S3 and CloudFront](s3-cloudfront.md)), every
non-HTML file first and the HTML last, then:

```sh
node tools/check-site.mjs https://www.example.com/
```

## Gotchas

- **Subresource integrity.** If your templates use `resources.Fingerprint` with an `integrity=` attribute, any
  rewrite of those files after the build (edge minification, image optimisation) breaks them in every browser,
  with or without felinar. `check-site` reports files whose bytes changed on the host.
- **Directory URLs.** Hugo writes `about/index.html`, so your canonical URLs end in `/` and your host redirects
  `/about` to `/about/`. In shell mode the worker does the same (`--trailing-slash auto`, the default).
- **`robots.txt`** is generated at the site root and stays on the host in drop-in mode. In shell mode copy it next to
  the loader.
- **Sub-paths.** A `baseURL` such as `https://example.com/blog/` isn't supported: felinar needs the root of an
  origin.
- **`relativeURLs = true`** changes nothing useful for drop-in or shell mode; it only mattered for the shared-origin
  demo hub.

## Shell mode instead

For a site that doesn't need search traffic, publish with `--shell --ws https://www.example.com/ws/` and deploy as in
[QUICKSTART.md](../QUICKSTART.md), track A. Hugo's `404.html` goes into the torrent and is served with status 404
for unknown paths.
