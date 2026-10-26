# Astro

An existing Astro site built as static output, moved to felinar in drop-in mode.

| | |
|---|---|
| Fits | drop-in: strong (soft navigations fetch host HTML); shell: works |
| Status | research lab: Astro 7.4.0 with the client router built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). The shipped loader hasn't served an Astro build, and the Astro commands below weren't run for this page |
| You need | Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

In `astro.config.mjs`:

```js
export default {
  site: 'https://www.example.com',
  base: '/',
  // trailingSlash and build.format: keep them consistent with how your host serves URLs
};
```

With the default `build.format` (`'directory'`) Astro writes `about/index.html`; if your canonical URLs end in `/`,
set `trailingSlash: 'always'` so links agree with the host's redirects.

## 2. Build

```sh
cd ~/my-site
ASTRO_TELEMETRY_DISABLED=1 npx astro build
```

Astro writes the site to `dist/`. The variable turns off Astro's anonymous build telemetry.

## 3. Publish

```sh
node tools/publish.mjs ~/my-site/dist --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

## 4. Deploy and check

Deploy `dist-publish/site/` with your host's recipe, then:

```sh
node tools/check-site.mjs https://www.example.com/
```

## Gotchas

- **The client router** (view transitions) fetches the next page's HTML from your host and swaps it in, so the page,
  and with it felinar's engine, lives longer than on a plain multi-page site. In shell mode the loader mirrors the
  router's `pushState` calls into the address bar; no end-to-end test covers that yet.
- **`/_astro/`** holds the hashed assets; they are what a later page view takes from the copy.
- **Server endpoints and on-demand rendering** don't exist in a static build.
