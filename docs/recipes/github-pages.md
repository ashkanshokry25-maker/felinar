# GitHub Pages

GitHub Pages as the host of a drop-in site, or as the host and same-origin web seed of a shell site. It is free and
simple, with three hard limits: no custom headers, no commercial use, and only the root of a user, organisation or
custom-domain site (a project site under `/<repo>/` doesn't work). It needs no domain: a repository named
`<user>.github.io` serves the root of `https://<user>.github.io/`, and `github.io` is on the Public Suffix List, so
your site shares no cookies or storage with other users' sites. The examples below use that name; a domain you own works
the same way with a `CNAME` file.

| | |
|---|---|
| Roles | drop-in host: yes; shell host with its own web seed under `/ws/`: yes; cross-origin web seed: only without a preflight |
| Status | not yet tested with a felinar deployment. The facts below come from GitHub's documents and probes of `pages.github.com` on 2026-10-17 ([w2a-07](../research/w2a-07-hosting-cost-bandwidth.md), F12; [w2a-05](../research/w2a-05-seo-crawlers.md), F42) |
| Price and limits | free; published sites up to 1 GB; a soft limit of 100 GB of bandwidth a month; not for sites "primarily directed at either facilitating commercial transactions or providing commercial software as a service" ([GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)) |

## What GitHub Pages does that matters

| Behaviour | Effect |
|---|---|
| HTTPS with a Let's Encrypt certificate, on `<user>.github.io` or a custom domain | fine |
| Unknown paths get your `404.html` with status 404 | real 404s for drop-in sites; the shell's `404.html` answers every unknown path in shell mode |
| Every file is sent with `cache-control: max-age=600`, and you can't change headers | an update or the kill switch can take up to 10 minutes to reach returning visitors; no `Content-Security-Policy` header from the host |
| `Range` requests get a correct 206 in browsers | a web seed under `/ws/` on the same site works |
| `OPTIONS` requests are answered 405 | a cross-origin web seed on GitHub Pages fails `check-webseed` unless you pass `--allow-no-preflight` |
| Jekyll runs on "Deploy from a branch" unless `.nojekyll` is present | `publish` writes `.nojekyll` into its output, so `/_mw/` and `/.mw/` survive |

## Drop-in site

1. Publish your built site ([recipes](README.md#the-steps-every-recipe-shares)):

   ```sh
   node tools/publish.mjs ~/my-site/public --name my-site --scope <user>.github.io \
     --key ~/keys/my-site-owner.jwk --dropin --inject-script --tr public \
     --ct mailto:you@example.org --out dist-publish
   ```

   The contact (`--ct`) is a mailbox you read or an `https:` page; `<user>.github.io` receives no mail.

2. Copy `site/` over a checkout of your Pages branch and push. Copying over the checkout, instead of deleting it
   first, keeps the previous version's files for visitors still on it (prune files older than a week from time to
   time):

   ```sh
   git clone https://github.com/<user>/<user>.github.io.git ../pages   # next to this clone, not inside it
   cp -R dist-publish/site/. ../pages/
   # with a domain you own instead: echo www.example.com > ../pages/CNAME, and --scope www.example.com above
   cd ../pages && git add -A && git commit -m "Publish my-site" && git push
   ```

   GitHub switches the whole site at once, so the upload order takes care of itself.

3. Check it:

   ```sh
   node tools/check-site.mjs https://<user>.github.io/
   ```

To publish from CI instead, start from the workflow template in
[deploy/github-actions/publish-site.yml](../../deploy/github-actions/publish-site.yml).

## Shell site with its own web seed

The loader at the root and the web seed under `/ws/` on the same site, as in [QUICKSTART.md](../QUICKSTART.md),
track A:

```sh
node tools/publish.mjs ~/my-site/public --name my-site --chain my-site --scope <user>.github.io --key ~/keys/my-site-owner.jwk \
  --ws https://<user>.github.io/ws/ --tr public --cs https://<user>.github.io/ws/genesis.json \
  --ct mailto:you@example.org --exp 399 --shell --out dist-publish
rm -rf deploy-root && mkdir -p deploy-root/ws
cp -R dist-publish/shell/. deploy-root/
cp -R dist-publish/my-site dist-publish/my-site.torrent dist-publish/genesis.json deploy-root/ws/
touch deploy-root/.nojekyll
# with a domain you own instead: echo example.com > deploy-root/CNAME, and that name in --scope, --ws and --cs
```

Copy `deploy-root/.` over the Pages checkout and push as above. A web seed on the loader's own site needs no CORS, so
the 405 on `OPTIONS` doesn't matter:

```sh
node tools/check-site.mjs https://<user>.github.io/
```

`<user>.github.io` cannot carry a DNS record of yours, so the signed page tag is the only pointer and it expires
(`--exp 399` is the longest); publish again before the date ([QUICKSTART.md](../QUICKSTART.md), "What a rung without a
domain cannot do"). The site's real name is its owner key and chain (`--chain`); a host name is one door to it
([DEPLOY.md](../DEPLOY.md#doors)).

## Limits and known problems

- **No custom headers.** `/mw-sw.js` can't get `Cache-Control: no-cache`; plan for up to 10 minutes between a deploy
  and returning visitors seeing it. You can't send a CSP, HSTS or `X-Robots-Tag` header from GitHub Pages. For the same
  reason, don't host an identity page here: without its CSP and `frame-ancestors 'none'` only its in-page refusal to run
  inside a frame protects the page that unlocks roots ([DEPLOY.md](../DEPLOY.md#hosting-it-without-buying-a-domain)).
- **Project sites** under `https://<user>.github.io/<repo>/` don't work: the loader needs `/mw-sw.js` and `/_mw/` at
  the root. `check-site` reports "non-root deployment". Use a repository named `<user>.github.io` instead (free, no
  domain), or a domain you own on the repository.
- **No wildcard domains**, so no hub with per-site subdomains here.
- **Rate limits.** GitHub may answer 429 or stop serving a site that exceeds its soft limits.
