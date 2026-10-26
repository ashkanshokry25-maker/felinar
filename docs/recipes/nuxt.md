# Nuxt

A Nuxt site prerendered with `nuxt generate`, moved to felinar in drop-in mode.

| | |
|---|---|
| Fits | drop-in: strong with `ssr: true` (every route prerendered); weak for search with `ssr: false`; shell: works either way |
| Status | research lab: Nuxt 4.6.2 built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). The shipped loader hasn't served a Nuxt build, and the Nuxt commands below weren't run for this page |
| You need | Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

In `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  ssr: true,          // prerender every route; false gives crawlers an empty page
  telemetry: false,
  // app.baseURL stays '/': felinar needs the root of an origin
});
```

## 2. Build

```sh
cd ~/my-site
NUXT_TELEMETRY_DISABLED=1 npx nuxt generate
```

The output is in `.output/public/`.

## 3. Publish

```sh
node tools/publish.mjs ~/my-site/.output/public --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

## 4. Deploy and check

Deploy `dist-publish/site/` with your host's recipe, then:

```sh
node tools/check-site.mjs https://www.example.com/
```

## Gotchas

- **`ssr: false`** builds an empty page that the browser fills in: crawlers that don't run scripts see nothing, and
  the host must answer deep links with the app's page (a fallback rule). Prefer `ssr: true` for anything public.
- **Import maps.** Nuxt pages carry a `<script type="importmap">`; its URLs resolve against the page's address, which
  is unchanged in both modes.
- **`/_nuxt/`** starts with an underscore; on GitHub Pages the `.nojekyll` that `publish` writes keeps it.
- **Server routes** (`server/api/`) don't exist in a static build.
