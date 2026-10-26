# Gatsby

A Gatsby site, moved to felinar in drop-in mode. **Gatsby wasn't covered by the research**: nothing on this page
has been tested. Follow the generic recipe, prove it on a staging host, and send what you find
([CONTRIBUTING.md](../../CONTRIBUTING.md)).

| | |
|---|---|
| Fits | unknown; Gatsby writes a static multi-page site with root-absolute URLs, which drop-in serves at its own URLs |
| Status | not yet tested (no research, no lab run) |
| You need | Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

In `gatsby-config.js`, set the production origin and leave the path prefix unset:

```js
module.exports = {
  siteMetadata: { siteUrl: 'https://www.example.com' },
  // no pathPrefix: felinar needs the root of an origin
};
```

## 2. Build

```sh
cd ~/my-site
npx gatsby build
```

Gatsby writes the site to `public/`.

## 3. Publish

```sh
node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

## 4. Deploy and check

Deploy `dist-publish/site/` with your host's recipe, then:

```sh
node tools/check-site.mjs https://www.example.com/ --headless --consent
```

## Gotchas

- **`gatsby-plugin-offline` registers its own Service Worker**, built with Workbox. felinar never registers over
  it: the ledger and sharing run, but nothing is served from the copy until your worker imports felinar's core.
  Remove the plugin, or follow the Workbox integration in
  [MIGRATION.md](../MIGRATION.md#a-site-with-its-own-service-worker) and test it.
- **Page data** (`/page-data/...json`) is fetched by the client router; those files go into the torrent and come from
  the copy on later page views.
- **Large image sets** from `gatsby-plugin-image` count against every visitor's copy; `--ignore` folders you don't want
  copied.
