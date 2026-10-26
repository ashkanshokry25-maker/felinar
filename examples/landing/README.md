# The felinar homepage

This folder is the project's own homepage: a small static site that is meant to be published through
felinar itself. It explains the project in a few screens and carries one live element, the box "How this
page reached you", which shows where the page came from (the host, other visitors or this device), how many
peers are connected and whether the visitor chose to share.

| File | What it is |
|---|---|
| `index.html` | the page: hero, why, how it works, shared data, what it is not, get started |
| `styles.css` | light and dark themes from the system setting, system fonts only |
| `app.js` | the live box; the page is complete without it |
| `README.md` | this file; `publish` leaves README files out of the torrent |

## Rules the page follows

- **Root-relative URLs** (`/styles.css`, `/app.js`), so it needs the root of a domain or subdomain, like every
  felinar site in full mode.
- **No external resources.** No web fonts, no CDN scripts, no images from elsewhere: the logo is inline SVG and
  the icon is a `data:` URL. Links to the documentation on GitHub are plain links.
- **No inline scripts.** The shell's Content Security Policy is `script-src 'self'`, so the only script is
  `/app.js`.
- **Works without JavaScript.** Every section is static HTML; only the live box needs the script.
- **Accessible.** A skip link, landmarks, one `h1`, a polite live region for the box's sentences, visible
  focus, 44 px buttons, contrast that holds in both themes, and no motion when the visitor asks for less.

## How the live box works

`app.js` imports the SDK from `/_mw/sdk.js` and reads only what the loader already reports:

| Call | Used for |
|---|---|
| `mw.site.info()` | `source` (`peers`, `webseed`, `cache` or `mixed`), `mode` (`shell` or `dropin`), `btih` |
| `mw.net.peers()` and the `peers` event | the number of peer connections right now |
| the `progress` event | bytes from other visitors and from the host, and bytes passed on |
| `mw.consent.state()` | whether the visitor chose to share, chose "Load from host only", or hasn't decided |
| `mw.consent.request()` | the "Sharing options" button opens the loader's own consent card; the visitor decides there |

It never writes to the site ledger, stores nothing and fetches nothing except `/_mw/sdk.js`. The box has four
states:

- **running**: the page came through felinar. In drop-in mode the HTML of every page comes from the host
  and the box says so; the rest of the files come from the verified copy.
- **plain**: there is no `/_mw/sdk.js` (a plain static server), or it is the static stub that `publish` writes
  as `sdk-static.js`, or the page is not inside felinar. The box says the page is a plain copy.
- **off**: the drop-in script is on the page but isn't delivering it here (an unsupported browser, or a page
  without a stamped pointer).
- **problem**: felinar is on the page but didn't answer; the page itself works.

"Passed on to others" appears only after the visitor chose to share. The counts are the loader's own
figures. For a page this small, expect the box to say the files came from the host: the host finishes before
a peer connection is ready ([docs/WHY.md](../../docs/WHY.md#honest-economics)).

## Try it on this computer

As a plain page (the box says it's a plain copy):

```sh
npx http-server examples/landing -a 127.0.0.1 -p 8081
```

Then open `http://127.0.0.1:8081/`.

Through felinar in shell mode, with a local tracker, a dev server and a headless seeder:

```sh
npm run demo -- --site examples/landing --name landing
```

Then open the printed `http://localhost:8080/` in two different browsers (or two browser profiles: the windows of
one profile are one visitor) and choose "Share and load" in both. The box counts the other browser and the seeder
as peers.

## Publish it

The page's GitHub links point at this repository once its owner has replaced the `OWNER` placeholder
([docs/PUBLISH-CHECKLIST.md](../../docs/PUBLISH-CHECKLIST.md), section 4). To publish the page from a fork, point them at
your fork (this works with the `perl` that ships with macOS and Linux):

```sh
perl -pi -e 's#github\.com/[A-Za-z0-9_.-]+/felinar#github.com/your-org/felinar#g' examples/landing/index.html
```

**Drop-in mode** is the right mode for a homepage, because search engines and link previews then see the page
itself, not the loader:

```sh
npx felinar publish examples/landing --name landing --scope www.example.org --key owner.jwk \
  --dropin --inject-script --tr public --out dist-landing
```

Upload `dist-landing/site/` to the root of `https://www.example.org/`: every non-HTML file first, then the
HTML. `publish` prints the exact order and an example command for your host.

**Shell mode** works too, and shows the whole system: returning visitors keep the page when the host is down.
Search engines then see the loader instead of the page.

```sh
npx felinar publish examples/landing --name landing --scope www.example.org --key owner.jwk \
  --shell --ws https://www.example.org/ws/ --tr public --out dist-landing
```

Upload `dist-landing/shell/` to the root, and `dist-landing/landing/` with `dist-landing/landing.torrent`
under `/ws/`. Then check the live site from outside:

```sh
npx felinar check-site https://www.example.org/
```

GitHub Pages serves a project site under `/<repo>/`, which full mode can't use: publish the homepage as a user or
organisation site, in a repository named `<owner>.github.io`, which needs no domain, or on a domain you own.
`.github/workflows/pages-demo.yml` can do that for this folder: it publishes it to GitHub Pages in shell mode on every
push to `main`, with an unsigned page tag (no owner key lives in CI, so the loader marks the page unmoderated, which
costs nothing for a page without shared data) and the files under `/ws/<commit>/` as the web seed. The project runs no
hosted demo for 0.3.0 and turns the workflow off; the free route, a repository named `<owner>.github.io`, is in
[docs/PUBLISH-CHECKLIST.md](../../docs/PUBLISH-CHECKLIST.md), section 12. Hosts, deploy order and the kill switch are in
[docs/DEPLOY.md](../../docs/DEPLOY.md); the step-by-step path from nothing to a live site is
[docs/QUICKSTART.md](../../docs/QUICKSTART.md).
