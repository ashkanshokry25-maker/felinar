# Eleventy

An existing Eleventy (11ty) site, moved to felinar in drop-in mode.

| | |
|---|---|
| Fits | drop-in: strong; shell: works |
| Status | research lab: Eleventy 3.1.7 built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). The shipped loader hasn't served an Eleventy build, and the Eleventy commands below weren't run for this page |
| You need | Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

Keep the default `pathPrefix` of `/` in `eleventy.config.js` and use the `url` filter for links consistently:

```js
export default function (eleventyConfig) {
  return { dir: { input: 'src', output: '_site' }, pathPrefix: '/' };
}
```

`HtmlBasePlugin` is only needed for a sub-path, which felinar doesn't support.

## 2. Build

```sh
cd ~/my-site
npx @11ty/eleventy
```

Eleventy writes the site to `_site/`.

## 3. Publish

```sh
node tools/publish.mjs ~/my-site/_site --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

## 4. Deploy and check

Deploy `dist-publish/site/` with your host's recipe, every non-HTML file first, then:

```sh
node tools/check-site.mjs https://www.example.com/
```

## Gotchas

- **Root-absolute URLs in HTML and in scripts** (the lab build had 10 in HTML) are fine: both modes serve the site at
  its own URLs. They would break only under a path prefix.
- **Passthrough copies** of large media count against every visitor's copy and your egress. Leave them out of the
  torrent with `--ignore <folder>`; in drop-in mode they stay on the host.
