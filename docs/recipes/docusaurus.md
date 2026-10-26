# Docusaurus

A Docusaurus documentation site, moved to felinar in drop-in mode.

| | |
|---|---|
| Fits | drop-in: strong; shell: works |
| Status | research lab: Docusaurus 3.10.2 built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). The shipped loader hasn't served a Docusaurus build, and the commands below weren't run for this page |
| You need | Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

In `docusaurus.config.js`:

```js
module.exports = {
  url: 'https://www.example.com',
  baseUrl: '/',
  trailingSlash: false, // say it explicitly, and match how your host serves URLs
  // keep the default browser router; the hash router isn't indexable
};
```

## 2. Build

```sh
cd ~/my-site
npx docusaurus build
```

The site is in `build/`.

## 3. Publish

```sh
node tools/publish.mjs ~/my-site/build --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

## 4. Deploy and check

Deploy `dist-publish/site/` with your host's recipe, then:

```sh
node tools/check-site.mjs https://www.example.com/
```

## Gotchas

- **Absolute own-origin URLs.** The lab build had 12 (canonical, `og:url`, `hreflang`, sitemap); all of them come from
  `url`, so build with the production value.
- **Translations** (`i18n`) build one subdirectory per locale with `hreflang` links; plain paths work in both modes.
- **Dialogs.** The bundle calls `alert()` or `confirm()` in places; in shell mode the frame's sandbox ignores them.
  Drop-in mode is unaffected.
- **Search.** The local search plugins build an index at build time and work like any other file; Algolia DocSearch
  is a third party called from the browser.
