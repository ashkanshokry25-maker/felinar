# migration-compat: notes and deviations (documentation wave, 2026-10-19)

Agent: migration-compat. Brief: `docs/MIGRATION.md`, `docs/COMPATIBILITY.md` and `docs/recipes/*.md` for the first
public release, plus DIGEST-AMENDMENTS F1 (compatibility statement with the four feature classes and per-CMS
verdicts) and E5 (the egress multiplier in the documents). This run resumed a wave that died at 20:42 ET; nothing
of this agent's had been committed, so every file was written from scratch.

## Files

- `docs/MIGRATION.md`: the drop-in path in three steps, a local preview, the egress multiplier (E5), the shell
  path, the hybrid, what changes for visitors and crawlers, what stays on the host, the compatibility checklist, the
  four feature classes and the replacement table (F1), SEO rules, CMS exports (WordPress, Ghost, Drupal with Tome,
  Squarespace, Wix, Webflow), versions and rollback, troubleshooting, and what `publish --dropin` refuses and warns.
- `docs/COMPATIBILITY.md`: a status legend (Tested, Code, Research, Not yet tested), the browser floor and matrix,
  degradation, phones, features by mode, hosting providers, frameworks, CMS platforms, the four classes, network
  conditions, known limitations with roadmap pointers.
- `docs/recipes/README.md` (index) and 21 recipes: hugo, jekyll, eleventy, astro, nextjs-export, nuxt, gatsby,
  sveltekit-static, docusaurus, mkdocs, vite-spa (Vite and Create React App), angular, wordpress-static,
  github-pages, cloudflare-pages, cloudflare-r2, s3-cloudfront, netlify, vercel, backblaze-b2, bunny.

## Decisions

1. **Status words are explicit everywhere.** "Tested" means an automated test passes in Playwright Chromium 156 or
   WebKit 27.2 on loopback; "Research lab" means the w2a-01 lab built the tool and ran it through a model of the
   serving rules, never the shipped loader; everything else is "not yet tested". No framework or host cell claims
   more, because nothing here ran on a real host, a real phone, Safari or Firefox.
2. **The 13.3x figure is called arithmetic, not a measurement.** w2a-07 F21 labels the multiplier a model (it is the
   formula applied to a 20 MB site and a 1.5 MB visit). MIGRATION.md shows the formula and a small table, all marked
   as arithmetic.
3. **Recipes use `node tools/...`**, as the guides do (docs/README.md, conventions), and every magnet-web command in
   them was run on 2026-10-19 against `examples/existing-site-dropin/` (publish `--dropin`, the local preview with
   `tracker.mjs`, `dev-server.mjs` and `check-site --headless --consent`, `check-webseed --mode host` and
   `--mode origin`, and the refusal and warning messages quoted in "What publish --dropin checks").
4. **Ghost and Drupal stay inside MIGRATION.md** (short, nothing was run); WordPress has its own recipe. R2 has a
   recipe of its own, separate from Cloudflare Pages, because it plays a different role (web seed).
5. **Two integrations that add a separate fetch listener** (the Workbox `generateSW` glue in MIGRATION.md and the
   Angular wrapper in `recipes/angular.md`) call `event.stopImmediatePropagation()` after `respondWith`, so the
   site's own listener can't answer the same request a second time (which throws). The tested integration
   (`with-own-sw-integrated`) avoids the problem with an early `return` in one handler. Both glue variants are marked
   not yet tested.
6. **Previous-version files on atomic-deploy hosts**: MIGRATION.md gives one concrete method,
   `rsync -a --ignore-existing --exclude "*.html" --exclude "*.htm" previous-site/ dist-publish/site/`, because
   `publish` replaces `site/` on every run and GitHub Pages, Cloudflare Pages, Netlify and Vercel drop the old deploy.

## Observations for other owners (not changed here; outside this agent's files)

1. `tools/publish.mjs` `egressNote`, `README.md` and `docs/ROADMAP.md` (the migration tooling row) call 13.3x "the
   measured example"; the source (w2a-07 F21) calls it a model. Suggest "a worked example".
2. `egressNote` also says "A smaller --max (the pointer's size cap) ... limits it", but `publish` refuses a `--max`
   below the site's total, so `--max` can't shrink a copy. `--ignore <path>` does (files stay on the host, out of
   the torrent); MIGRATION.md says so.
3. `csp.txt` for a drop-in publish lists the DNS-over-HTTPS resolvers "if you also publish the pointer in DNS", but
   the drop-in runtime never reads DNS (no DoH code in `src/dropin/`). MIGRATION.md tells drop-in owners they can
   leave them out.
4. `docs/RUNBOOK.md` section 10 step 6 still says `mw.consent.accept()`, which v0.2.1 (A4) removed; it is
   `mw.consent.request()`. Section 6 says a key rotation starts a new ledger, which `lo=` (code review round 1, F09)
   changed. Section 3 still lists the v0.2 test counts.
5. `webseed-layout.txt` (written by `publish`) recommends the managed CloudFront policy
   "CORS-with-preflight-and-SecurityHeadersPolicy"; w1-10 F5 and MIGRATION-DIGEST section 11 say the managed
   CORS-With-Preflight policy sends no `Access-Control-Allow-Headers`, and DEPLOY.md now recommends a custom policy.
   For a drop-in publish the file also describes a cross-origin web seed, which drop-in doesn't use.
6. `parseRedirects` (`src/sw/lib.js`) skips unsupported `_redirects` lines (query matching, conditions, proxying)
   silently, and `publish` prints nothing about them; MIGRATION.md tells shell owners to read `/.mw/site.json`.
   MIGRATION-DIGEST M43 (per-line errors) is not built.
7. The research lint `docs/research/labs/w2a-01-lab/lint/mw-lint.mjs` is mentioned as an unsupported prototype; its
   MW-H01 message ("host config files that the loader will NOT honour") is stale since `publish` reads `_redirects`
   and `_headers`.
8. `deploy/github-actions/publish-site.yml` is linked from MIGRATION.md and `recipes/github-pages.md`. When this
   agent finished, `deploy/github-actions/` existed but was empty (another agent's file in this wave). The docs-links
   test checks only `.md` paths, so a missing template doesn't fail `npm test`.

## What was not verified

- Every framework build (no generator is installed on this machine, and none was installed for these pages); every
  host (no accounts); Firefox and Safari (Firefox doesn't launch here); real phones.
- By code reading only, and labelled so in the documents: form posts are blocked in shell limited mode
  (`form-action 'none'` inherited by the limited-mode frame); in drop-in mode requests made from a Web Worker (for
  example Pagefind's index) don't map to a page version and go to the host; the worker switches to shell mode when a
  shell page talks to it (the drop-in to shell switch itself has no test).
- `npm test` after writing: 920 of 921 pass; the one failure is the docs-links test, now only for `CRITIQUE.md`
  (another agent's file) and `CONTRIBUTING.md -> VERIFY.md`. The wording test passes over `docs/*.md`, and a
  separate check found no en or em dashes, curly quotes, banned words or unfinished markers in this agent's files,
  and every relative link and anchor in them resolves except the workflow template above.
