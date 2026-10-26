# MkDocs

A MkDocs site (with or without the Material theme), moved to felinar in drop-in mode.

| | |
|---|---|
| Fits | drop-in: strong; shell: works |
| Status | research lab: MkDocs 1.6.1 with Material 9.7.7 built and served through a model of the serving rules in Chromium 156 and WebKit 27.2 ([MIGRATION-DIGEST.md](../research/MIGRATION-DIGEST.md), section 7). The shipped loader hasn't served an MkDocs build, and the commands below weren't run for this page |
| You need | Python with MkDocs, Node 22 or newer, a clone of felinar with `npm ci` and `npm run build` done, an owner key, an HTTPS host at the root of your domain |

## 1. Configure

In `mkdocs.yml`:

```yaml
site_url: https://www.example.com/
use_directory_urls: true   # about/index.html; set false for about.html, whichever your host serves
theme:
  name: material
  font: false              # no Google Fonts: no third party, and the fonts work offline
```

## 2. Build

```sh
cd ~/my-site
mkdocs build
```

The site is in `site/`.

## 3. Publish

```sh
node tools/publish.mjs ~/my-site/site --name my-site --scope www.example.com \
  --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
  --ct mailto:abuse@example.com --out dist-publish
```

## 4. Deploy and check

Deploy `dist-publish/site/` with your host's recipe, then:

```sh
node tools/check-site.mjs https://www.example.com/
```

## Gotchas

- **Google Fonts.** With fonts on, every page loads from Google's servers, which see your visitors and don't work
  offline. In the lab the Google Fonts build stalled in WebKit in every serving model and without a Service Worker
  (a lab environment effect, but a reason to self-host).
- **Source maps and precompressed siblings** (`.map`, `.gz`, `.br`) only make the torrent bigger. The lab build had
  49 files and 2,480 KiB. If you don't need the maps, delete them before you publish:

  ```sh
  find ~/my-site/site -name '*.map' -delete
  ```

- **The search index** (`search/search_index.json`) is a plain file and comes from the copy like any other.
