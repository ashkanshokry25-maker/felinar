# Angular

An Angular application, moved to felinar. Angular builds a single-page app with a `<base href>`, and often its own
Service Worker (`@angular/service-worker`), so read both gotchas before you start.

| | |
|---|---|
| Fits | drop-in: medium (its own worker needs the two-line integration; the host's fallback rule is needed); shell: good |
| Status | research lab: Angular 22.2.3 built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). The shipped loader hasn't served an Angular build, and the commands below weren't run for this page |
| You need | Node 22 or newer, the Angular CLI, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Build

```sh
cd ~/my-app
NG_CLI_ANALYTICS=false npx ng build --base-href /
```

With the application builder the output is in `dist/<project>/browser/` (check `outputPath` in `angular.json`).

## 2. If the app uses Angular's Service Worker

felinar never registers over a site's worker. To let Angular's worker serve files from the visitor's copy,
register a small worker of your own that imports felinar's core first and Angular's worker second. Add this file
to your assets as `mw-ngsw.js`:

```js
importScripts('/_mw/sw-core.js');
self.addEventListener('fetch', (event) => {
  if (self.mw && self.mw.owns(event)) {
    event.respondWith(self.mw.handle(event));
    event.stopImmediatePropagation(); // a request answers once: Angular's listener must not answer it too
  }
});
importScripts('./ngsw-worker.js');
```

and register `mw-ngsw.js` instead of `ngsw-worker.js` in your app configuration. Listeners run in the order they were
added, so felinar gets the first look, and Angular's worker handles everything felinar doesn't own. **Not yet tested** with
felinar; check `window.__mwDropin.inspect().sw.mode` (it should say `integrated`) on a staging host. Keep
`/_mw/sw-core.js` on the host for as long as this worker imports it.

## 3. Publish in drop-in mode

```sh
node tools/publish.mjs ~/my-app/dist/my-app/browser --name my-app --scope app.example.com \
  --key ~/keys/my-app-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

Keep your host's deep-link fallback (for example `/*  /index.html  200` in `_redirects` on Netlify or Cloudflare
Pages). Angular's own worker skips URLs with a file extension in its navigation fallback, which is what you want.

For shell mode instead, publish with `--ws https://app.example.com/ws/ --spa --shell` and deploy as in
[QUICKSTART.md](../QUICKSTART.md), track A; Angular's own worker can't run under the shell.

## 4. Check

```sh
node tools/check-site.mjs https://app.example.com/ --headless --consent
```

## Gotchas

- **`<base href>`.** The page already carries one; never add a second. felinar doesn't touch it.
- **Search.** Crawlers see an empty page unless you prerender routes at build time.
- **One worker per scope.** Angular's worker and felinar's `/mw-sw.js` can't both control `/`; the integration
  above is the only way to have both.
