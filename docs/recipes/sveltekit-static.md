# SvelteKit static

A SvelteKit site prerendered with `adapter-static`, moved to felinar in drop-in mode. In the research lab this was
the least troublesome build: its output uses relative URLs, so it passed in every serving model.

| | |
|---|---|
| Fits | drop-in: strong; shell: works |
| Status | research lab: SvelteKit 3.1.0 with adapter-static 4.0.0 built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). The shipped loader hasn't served a SvelteKit build, and the commands below weren't run for this page |
| You need | Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

Prerender every route, in `src/routes/+layout.js`:

```js
export const prerender = true;
```

Set the adapter. The lab's SvelteKit 3.1.0 took the options in `vite.config.js`:

```js
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';
export default {
  plugins: [sveltekit({ adapter: adapter({ pages: 'build', assets: 'build' }) })],
};
```

SvelteKit 2 projects pass the same `adapter` option under `kit` in `svelte.config.js`. Leave `paths.base` empty and set
`fallback` only for a single-page build that can't prerender its routes.

## 2. Build

```sh
cd ~/my-site
npx vite build
```

The output is in `build/`.

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

- **A `fallback` page** turns the build into a single-page app for routes it couldn't prerender: the host must answer
  them with that page, and crawlers see an empty one.
- **`/_app/`** holds the hashed assets and starts with an underscore; on GitHub Pages the `.nojekyll` that `publish`
  writes keeps it.
