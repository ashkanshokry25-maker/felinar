# Recipes

One page per framework, CMS export or host: the settings that matter, the exact `publish` command, how to deploy and
check, and the known problems. Read [MIGRATION.md](../MIGRATION.md) first for the path itself and
[COMPATIBILITY.md](../COMPATIBILITY.md) for what works where.

## How these recipes were checked

Read this before you trust a recipe.

- **felinar commands** (`publish`, `check-site`, `check-webseed`, the local preview) were run on 2026-10-19 with the
  0.2.1 code (never published) against the drop-in example in `examples/existing-site-dropin/`, on one machine,
  loopback only. For 0.3.0 the end-to-end suite publishes the same example on every run (scenarios 9, 10 and 10B),
  but the recipe pages were not run again by hand.
- **Framework settings** come from the research lab ([w2a-01](../research/w2a-01-site-generator-output.md)), which
  built each tool's default output on 2026-10-17 and ran it through a model of the serving rules in Chromium 156 and
  WebKit 27.2. The shipped loader has not served these builds, and the framework commands were not run for these
  pages. A recipe for a tool the lab didn't cover says so.
- **Hosts** come from vendor documents and from research probes of third-party sites on each provider on
  2026-10-17 ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md)). No recipe has been deployed to a real account.
  Prices are list prices in USD on that date.

If you run a recipe for real, add a "Tested on" line with the date and the versions to it in a pull request
([CONTRIBUTING.md](../../CONTRIBUTING.md), "Adding a recipe").

## Frameworks and generators

| Recipe | Drop-in | Shell | Status |
|---|---|---|---|
| [Hugo](hugo.md) | strong | works | research lab (Hugo 0.168.0) |
| [Jekyll](jekyll.md) | good | not tested | not yet tested |
| [Eleventy](eleventy.md) | strong | works | research lab (Eleventy 3.1.7) |
| [Astro](astro.md) | strong | works | research lab (Astro 7.4.0) |
| [Next.js static export](nextjs-export.md) | strong | works | research lab (Next.js 16.4.2) |
| [Nuxt](nuxt.md) | strong with `ssr: true` | works | research lab (Nuxt 4.6.2) |
| [Gatsby](gatsby.md) | unknown | unknown | not yet tested |
| [SvelteKit static](sveltekit-static.md) | strong | works | research lab (SvelteKit 3.1.0) |
| [Docusaurus](docusaurus.md) | strong | works | research lab (Docusaurus 3.10.2) |
| [MkDocs](mkdocs.md) | strong | works | research lab (MkDocs 1.6.1, Material 9.7.7) |
| [Vite and Create React App single-page apps](vite-spa.md) | medium | good | research lab (Vite 8.3.4); Create React App not yet tested |
| [Angular](angular.md) | medium | good | research lab (Angular 22.2.3) |

## CMS exports

| Recipe | Status |
|---|---|
| [WordPress through Simply Static or Staatic](wordpress-static.md) | not yet tested |
| Ghost, Drupal (Tome), Squarespace, Wix, Webflow: [MIGRATION.md](../MIGRATION.md#cms-exports) | not yet tested |

## Hosts

| Recipe | Shell host | Drop-in host | Cross-origin web seed |
|---|---|---|---|
| [GitHub Pages](github-pages.md) | yes, with its own `/ws/` | yes | only without a preflight |
| [Cloudflare Pages](cloudflare-pages.md) | yes, with the web seed elsewhere | yes | no (`Range` answered with 200) |
| [Cloudflare R2](cloudflare-r2.md) | no | no | yes, the recommended one |
| [S3 and CloudFront](s3-cloudfront.md) | yes | yes | yes |
| [Netlify](netlify.md) | yes | yes | no |
| [Vercel](vercel.md) | yes | yes | only without a preflight |
| [Backblaze B2](backblaze-b2.md) | no | no | yes, behind a CDN |
| [Bunny Storage and CDN](bunny.md) | not researched | not researched | yes, preflight unverified |

## Sign-in and the hub pin (v0.3)

> **Status: v0.3, built and reviewed.** These three pages describe built v0.3 features. Each page's status line
> says what has and has not been run end to end.

| Recipe | What it covers | Status |
|---|---|---|
| [Sign-in on a Node server](signin-server-node.md) | `@felinar/verify`: issue a challenge, verify a proof, a shared nonce store for more than one instance, binding accounts only after verified contact data | built: the final integration verified real proofs from the identity origin with a fixture server, on loopback (e2e E-SI-1 to E-SI-5); the project hosts no identity page, by design (owner decision N-2) |
| [Add "Sign in with felinar" to an existing site](signin-widget.md) | the self-hosted `<mw-signin>` element with a hash, the two routes it needs, the headers | built: e2e E-SI-1W ran the flow on loopback in Chromium; the project hosts no identity page, by design (owner decision N-2) |
| [A pin node for a hub](hub-pin.md) | `pin.mjs` as mailbox and file pin with a moderator queue and quarantine, and what it sees | the mailbox store (`--mailbox`), the file pin with its moderator queue (`--files`) and quarantine are built and unit-tested; no page sends mailbox frames or members' pin requests yet (proposed), and no hub pin has run end to end with members |

## The steps every recipe shares

1. **Build** at the root of your final HTTPS origin, with that origin configured, so canonical, Open Graph and
   sitemap URLs are correct.
2. **Publish** from a clone of felinar, with your build output as the site directory:

   ```sh
   node tools/publish.mjs ~/my-site/public --name my-site --scope www.example.com \
     --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
     --ct mailto:abuse@example.com --out dist-publish
   ```

3. **Deploy** `dist-publish/site/` to your host: every non-HTML file first, the HTML pages last, the previous
   version's files kept for 7 days.
4. **Check** from outside:

   ```sh
   node tools/check-site.mjs https://www.example.com/
   ```

   It exits 0 when every check passes and 1 when one fails, so it can run in CI or from cron.

Keep `--name`, `--scope`, the key and `--out` the same for every version. The rules that apply to every host (what
the host must do, deploy order, headers, the kill switch, owner duties) are in [DEPLOY.md](../DEPLOY.md); the recipes
add what is particular to one tool or one host. The owner key comes from
`node tools/keygen.mjs --out ~/keys/my-site-owner.jwk` and never goes into a browser, a web server or a repository.
