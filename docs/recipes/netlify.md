# Netlify

Netlify as the host of a drop-in site or of a shell site's loader. Your `_redirects` and `_headers` keep working, and
so do Netlify features that read your HTML at deploy time. Bandwidth costs credits, so it is no place for a web seed.

| | |
|---|---|
| Roles | drop-in host: yes (a paid plan for anything beyond a small site); shell host: yes; web seed: no |
| Status | not yet tested with a felinar deployment. The facts below come from Netlify's documents (updated 2026-09-01) and a probe of a Netlify-hosted site on 2026-10-17 ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F13) |
| Price (list, 2026-10-17) | credit plans for accounts since 2025-09-04: Free with 300 credits a month, Personal $9 with 1,000, Pro from $20 with 3,000. Bandwidth costs 20 credits per GB and requests 2 credits per 10,000, so the free plan is about 15 GB a month. When the credits run out, **every project on the account pauses** until the next cycle ([Netlify pricing](https://www.netlify.com/pricing/)) |

## Drop-in site

1. Publish your built site ([recipes](README.md#the-steps-every-recipe-shares)). Keep your `_redirects` and
   `_headers` in the build output; `publish` keeps both in `site/`.
2. Add the worker's header to `_headers`:

   ```text
   /mw-sw.js
     Cache-Control: no-cache
   ```

3. Each deploy replaces the whole site, so merge the previous version's non-HTML files into the upload
   ([MIGRATION.md](../MIGRATION.md#step-3-upload-non-html-files-first-then-html)), then deploy with the Netlify CLI:

   ```sh
   rsync -a --ignore-existing --exclude "*.html" --exclude "*.htm" previous-site/ dist-publish/site/
   npx netlify deploy --dir dist-publish/site --prod
   ```

4. Check it:

   ```sh
   node tools/check-site.mjs https://www.example.com/
   ```

## Shell site

Deploy `dist-publish/shell/` as the site. Netlify answers unknown paths with your `404.html` (the shell ships one), so
every URL gets the loader. Put the web seed on a host with free or cheap egress and CORS
([Cloudflare R2](cloudflare-r2.md)), or under `/ws/` of the same site if the traffic fits your credits.

## Limits and known problems

- **The pause.** A traffic spike that uses up the free plan's credits pauses every project on the account, the
  shell included. Drop-in copies add to the bandwidth bill ([egress](../MIGRATION.md#egress-budget-for-copies-not-page-views)).
- **Netlify Forms and other HTML features** read the deployed HTML, which drop-in leaves in place; not yet tested.
- **Not a web seed.** Netlify sends no CORS headers by default, and every byte costs credits.
- **Pretty URLs** serve `/about` from `about.html`; keep canonical links in one form.
- **Wildcards.** Netlify issues a wildcard certificate when the domain uses Netlify DNS; whether one site can take a
  wildcard domain alias for a hub is unverified.
