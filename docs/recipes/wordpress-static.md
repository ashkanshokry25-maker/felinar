# WordPress through a static export

A WordPress site, exported to static files with Simply Static (recommended) or Staatic, then published with
felinar in drop-in mode on a host you control. WordPress keeps running somewhere private, where you write and
export; the public site becomes the static export.

| | |
|---|---|
| Fits | drop-in: strong after export; shell: only for sites that don't need search traffic |
| Status | not yet tested. The steps come from the exporters' documents and source read by the research ([w2a-02](../research/w2a-02-cms-export.md), recipes); no export was run for felinar. The `--from-wxr` import and the secrets check are unit-tested |
| You need | a WordPress you can install plugins on (a staging copy is best), Simply Static 3.8.18 or Staatic 1.14.0, Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS static host at the root of your domain |

## What you lose, and what replaces it

| Lost in a static export | Replacement |
|---|---|
| Comment form | new comments on the site ledger (`--policy open`); old comments as static JSON with `--from-wxr` |
| Search (`/?s=`) | Pagefind, run on the export ([MIGRATION.md](../MIGRATION.md#search-with-pagefind)) |
| Contact forms | a form relay or `mailto:` |
| WooCommerce, Easy Digital Downloads, MemberPress, Restrict Content Pro, bbPress, BuddyPress | none on a static host: Stripe Payment Links or Buy Button for simple sales; memberships stay on a server |
| REST API, oEmbed, XML-RPC, login | none; remove the links to them |
| Scheduled posts | export again on a schedule |

## 1. Prepare WordPress

1. Work on a staging copy you control.
2. Settings, Permalinks: choose a "pretty" structure. Plain permalinks (`/?p=123`) aren't exported. If the live site
   used them, record every old `?p=` URL and its new address for your host's redirects.

## 2. Export with Simply Static

1. Simply Static, General, Replacing URLs: **Absolute URLs**, scheme `https://`, host = your production domain.
   "Relative" breaks canonical, Open Graph and sitemap URLs; "Offline" is for archives.
2. Include `/robots.txt`, the 404 page export and files that no page links to (Additional Files and Directories).
   Page-builder background images need Simply Static's documented `ss_match_tags` filter.
3. Export to a local directory (or a ZIP you unpack), for example `~/exports/wp-static/`.

Staatic works too: it crawls the site like a visitor, its free edition covers redirects, 404 pages and extra URLs, and
its default time limit of 4 hours needs raising for large sites. How it rewrites URLs isn't documented, so check the
export with `check-site` before you rely on it.

No plugin possible (for example WordPress.com below the Business plan): mirror the site with
`wget --mirror --page-requisites --convert-links`, on Linux rather than a default macOS disk (macOS merges file names
that differ only in case or Unicode form).

## 3. Bring the old comments along (optional)

Export the content in WordPress (Tools, Export, All content) to get a WXR file. Then publish with `--from-wxr`:
it writes approved comments as `comments/<slug>.json` without e-mail or IP addresses and prints what it dropped. Never
put the WXR file itself in the site folder: `publish` refuses a WordPress export that carries commenter e-mail or IP
addresses.

## 4. Publish

```sh
node tools/publish.mjs ~/exports/wp-static --name my-blog --scope www.example.com \
  --key ~/keys/my-blog-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish \
  --from-wxr ~/exports/wordpress.xml --policy open --bits 16 --cs /ledger/genesis.json
```

Drop `--from-wxr`, `--policy`, `--bits` and `--cs` if the site takes no new comments. With them, upload
`dist-publish/genesis.json` to `/ledger/genesis.json` on the host, and write your comment code against `mw.db`
([CRUD.md](../CRUD.md)).

`publish` refuses to continue if the export contains `wp-config.php`, database dumps, backups, keys or tokens, and
lists every dot file it leaves out.

## 5. Deploy and check

Deploy `dist-publish/site/` to your static host, non-HTML files first ([GitHub Pages](github-pages.md),
[Cloudflare Pages](cloudflare-pages.md), [Netlify](netlify.md), [S3 and CloudFront](s3-cloudfront.md)), then:

```sh
node tools/check-site.mjs https://www.example.com/
```

## Gotchas

- **`?ver=` on every asset.** WordPress adds `?ver=6.x` to styles and scripts. The worker matches files by path and
  ignores the query, so nothing needs changing.
- **Dead endpoints in the HTML.** Exports keep `api.w.org` links, `xmlrpc` links, emoji scripts from `s.w.org` and
  absolute URLs in inline settings. They fail quietly or call a third party; remove them in your theme if you can.
- **Size.** WordPress keeps up to 8 files per uploaded photo. Export from the crawl (what pages reference), never by
  copying the raw `uploads` folder, and `--ignore` media you don't want in every visitor's copy.
- **Premium themes and plugins** may restrict redistribution of their files; check their licences.
- **Keeping WordPress live and adding drop-in on top** (only assets peer-to-peer, HTML from WordPress) is an untested
  proposal in the research, not a supported setup.
