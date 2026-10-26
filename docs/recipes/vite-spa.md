# Vite and Create React App single-page apps

A single-page app built with Vite (React, Vue, Svelte or plain) or Create React App, moved to felinar. The app's
HTML is one nearly empty page; the browser builds every route. That decides the mode:

- **Drop-in** keeps your host in charge. The host must answer deep links (`/settings`) with the app's page, as it does
  today, and crawlers see an empty page unless you prerender. One bonus: the app is one long page view, so the
  engine lives as long as the visitor stays, not one page view at a time.
- **Shell** suits apps that don't need search traffic: `--spa` makes the worker answer every unknown navigation with
  the app's page.

| | |
|---|---|
| Fits | drop-in: medium (the host's fallback rule is needed; search only after prerendering); shell: good |
| Status | research lab: Vite 8.3.4 with React Router 8 built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). Create React App: not yet tested. The shipped loader hasn't served these builds, and the commands below weren't run for this page |
| You need | Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

In `vite.config.js`, keep the root base:

```js
export default {
  base: '/', // './' and '/repo/' are for other setups; felinar serves the app at the root of its origin
};
```

Create React App reads `homepage` in `package.json`; leave it unset or set it to the root of your domain. Create React
App is deprecated since 2025-02-14; new work belongs in Vite or a static-site framework.

## 2. Build

```sh
cd ~/my-app
npx vite build
```

Vite writes `dist/` (Create React App: `npx react-scripts build`, output in `build/`).

## 3a. Publish in drop-in mode

```sh
node tools/publish.mjs ~/my-app/dist --name my-app --scope app.example.com \
  --key ~/keys/my-app-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

Keep your host's fallback rule, for example in a `_redirects` file (Netlify, Cloudflare Pages) in your build output:

```text
/*  /index.html  200
```

That rule turns every unknown URL into a 200, which search engines read as soft 404s. For a public app, prefer a
fallback that covers only the app's routes (`/app/*  /index.html  200`).

## 3b. Or publish in shell mode

```sh
node tools/publish.mjs ~/my-app/dist --name my-app --scope app.example.com \
  --key ~/keys/my-app-owner.jwk --ws https://app.example.com/ws/ --tr public \
  --ct mailto:abuse@example.com --spa --shell --out dist-publish
```

Deploy as in [QUICKSTART.md](../QUICKSTART.md), track A. `--spa` applies to navigations only: a missing script or image
stays a 404, never the app's page.

## 4. Check

```sh
node tools/check-site.mjs https://app.example.com/ --headless --consent
```

## Gotchas

- **Crawlers.** The app's HTML has no content until scripts run. Prerender the public routes at build time (a static
  framework does this) or accept that they aren't indexed.
- **History mirroring in shell mode.** The loader mirrors the frame's `pushState` and `replaceState` into the address
  bar, so reloads and links keep the route; no end-to-end test covers a router in shell SW mode yet.
- **Large bundles.** In shell mode the whole app downloads before it renders, within 24 MiB for most phones.
