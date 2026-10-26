# Next.js static export

A Next.js site built with `output: 'export'`, moved to felinar in drop-in mode. Only the static export works: API
routes, middleware, server actions, on-demand rendering and the image optimiser need the Next.js server.

| | |
|---|---|
| Fits | drop-in: strong; shell: works |
| Status | research lab: Next.js 16.4.2 export built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). The shipped loader hasn't served a Next.js build, and the Next.js commands below weren't run for this page |
| You need | Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

In `next.config.mjs`:

```js
export default {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: false, // true writes about/index.html; match what your host and canonical URLs use
  // basePath stays unset: felinar needs the root of an origin
};
```

For reproducible builds, also set `generateBuildId` to your commit hash.

## 2. Build

```sh
cd ~/my-site
NEXT_TELEMETRY_DISABLED=1 npx next build
```

The export is in `out/`. The variable turns off Next.js telemetry.

## 3. Publish

```sh
node tools/publish.mjs ~/my-site/out --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

## 4. Deploy and check

Deploy `dist-publish/site/` with your host's recipe, then:

```sh
node tools/check-site.mjs https://www.example.com/
```

## Gotchas

- **Clean URLs.** With `trailingSlash: false` the export has `about.html`, and the host must answer `/about` with it.
  GitHub Pages, Netlify and Cloudflare Pages do; S3 and CloudFront need a function
  ([S3 and CloudFront](s3-cloudfront.md)).
- **`404.html` must be answered with status 404** for unknown paths, or search engines see soft 404s.
- **`/_next/`** starts with an underscore. On GitHub Pages with "Deploy from a branch", the `.nojekyll` that
  `publish` writes keeps it from being dropped.
- **Root-absolute URLs everywhere** (37 in HTML and 52 in scripts in the lab build) are fine: both modes serve the
  site at its own URLs.
