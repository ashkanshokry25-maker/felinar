# Jekyll

An existing Jekyll site, moved to felinar in drop-in mode. Jekyll builds a plain multi-page site; build it
yourself (in CI or locally) so that `publish` can stamp the pages before they reach the host.

| | |
|---|---|
| Fits | drop-in: good at the root of a domain; shell: not tested |
| Status | not yet tested. Jekyll 4.4.1 was read in its documents by the research, not built in the lab ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7) |
| You need | Ruby and Bundler, Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

In `_config.yml`:

```yaml
url: "https://www.example.com"
baseurl: ""
```

`url` feeds canonical links and `jekyll-seo-tag`, so it must be the production origin. A non-empty `baseurl`
(`/repo`) means a sub-path, which felinar doesn't support.

## 2. Build

```sh
cd ~/my-site
JEKYLL_ENV=production bundle exec jekyll build
```

Jekyll writes the site to `_site/`.

## 3. Publish

```sh
node tools/publish.mjs ~/my-site/_site --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

## 4. Deploy and check

On GitHub Pages, deploy the stamped output yourself instead of letting GitHub build the repository: with
"Deploy from a branch", push `dist-publish/site/` to the Pages branch ([GitHub Pages](github-pages.md)). The empty
`.nojekyll` that `publish` writes into `site/` stops GitHub from running Jekyll again, which would drop `/_mw/`
(Jekyll skips paths that start with an underscore).

```sh
node tools/check-site.mjs https://www.example.com/
```

## Gotchas

- **GitHub Pages sends no custom headers** and caches files for 10 minutes, so `/mw-sw.js` can't get
  `Cache-Control: no-cache` there and an update or the kill switch can take that long to arrive.
- **GitHub Pages rules out commercial sites** and project sites under `/<repo>/` don't work with felinar; use a
  user or organisation site, or a custom domain.
- **Plugins that call a server** (comment forms, search backends) stop working on any static host. See
  [MIGRATION.md](../MIGRATION.md#dynamic-features-and-their-replacements).
