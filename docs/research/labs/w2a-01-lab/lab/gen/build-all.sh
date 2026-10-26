#!/bin/zsh
# Rebuilds every generator output used by the lab matrix (exact commands that produced the 2026-10-17 results).
# Needs: Node >= 22 on PATH, network for `npm install`, Python 3 (MkDocs venv), and a Hugo binary at $HUGO
# (Hugo ships macOS builds only as a .pkg: verify its sha256 against hugo_0.168.0_checksums.txt, then
#  `pkgutil --expand-full hugo_0.168.0_darwin-universal.pkg <dir>` and use <dir>/Payload/hugo; nothing is installed system-wide).
# Telemetry opt-outs are exported because Next.js and Astro send anonymous build events by default.
set -e
cd "$(dirname "$0")"
export DO_NOT_TRACK=1 NEXT_TELEMETRY_DISABLED=1 ASTRO_TELEMETRY_DISABLED=1 NUXT_TELEMETRY_DISABLED=1 NG_CLI_ANALYTICS=false CI=1 NO_MKDOCS_2_WARNING=1
HUGO=${HUGO:?set HUGO=/path/to/hugo}
for g in vite-react astro next sveltekit eleventy docusaurus nuxt; do (cd $g && npm install --no-audit --no-fund); done

(cd vite-react && for v in "root:/" "rel:./" "repo:/repo/"; do BASE=${v#*:} npx vite build --outDir dist-${v%%:*}; done)
(cd astro && BASE=/ npx astro build --outDir dist-root && BASE=/repo/ npx astro build --outDir dist-repo)
(cd next && DIST=out-root npx next build && DIST=out-repo BASE_PATH=/repo npx next build)
(cd sveltekit && OUT=build-root npx vite build && OUT=build-repo BASE_PATH=/repo npx vite build)
(cd eleventy && OUT=_site-root npx @11ty/eleventy && OUT=_site-repo2 PREFIX=/repo/ npx @11ty/eleventy)
(cd hugo && $HUGO --destination public-root --baseURL https://example.org/ && printf 'relativeURLs = true\n' > rel.toml \
  && $HUGO --destination public-rel --baseURL https://example.org/ --config hugo.toml,rel.toml \
  && $HUGO --destination public-repo --baseURL https://example.org/repo/)
(cd mkdocs && python3 -m venv venv && ./venv/bin/pip install mkdocs==1.6.1 mkdocs-material==9.7.7 \
  && ./venv/bin/mkdocs build -f mkdocs.yml -d site-root && ./venv/bin/mkdocs build -f mkdocs-nofont.yml -d site-nofont)
(cd docusaurus && BASE=/ npx docusaurus build --out-dir build-root && BASE=/repo/ npx docusaurus build --out-dir build-repo && HASH=1 BASE=/ npx docusaurus build --out-dir build-hash)
(cd nuxt && npx nuxt generate && rm -rf out-root && cp -R .output/public out-root \
  && BASE=/repo/ npx nuxt generate && rm -rf out-repo && cp -R .output/public out-repo \
  && SPA=1 npx nuxt generate && rm -rf out-spa && cp -R .output/public out-spa)
# Angular: ng-app is the scaffold of CREATE ng-app/.prettierrc (161 bytes)
CREATE ng-app/README.md (1458 bytes)
CREATE ng-app/.editorconfig (314 bytes)
CREATE ng-app/.gitignore (622 bytes)
CREATE ng-app/angular.json (1903 bytes)
CREATE ng-app/package.json (782 bytes)
CREATE ng-app/tsconfig.json (908 bytes)
CREATE ng-app/tsconfig.app.json (398 bytes)
CREATE ng-app/tsconfig.spec.json (409 bytes)
CREATE ng-app/.vscode/extensions.json (130 bytes)
CREATE ng-app/.vscode/launch.json (470 bytes)
CREATE ng-app/.vscode/tasks.json (978 bytes)
CREATE ng-app/src/main.ts (222 bytes)
CREATE ng-app/src/index.html (291 bytes)
CREATE ng-app/src/styles.css (80 bytes)
CREATE ng-app/src/app/app.css (0 bytes)
CREATE ng-app/src/app/app.spec.ts (680 bytes)
CREATE ng-app/src/app/app.ts (289 bytes)
CREATE ng-app/src/app/app.html (20144 bytes)
CREATE ng-app/src/app/app.config.ts (312 bytes)
CREATE ng-app/src/app/app.routes.ts (77 bytes)
CREATE ng-app/public/favicon.ico (15086 bytes)
# with src/app/{home,about,app,app.routes}.ts, app.html and styles.css replaced by the versions in this directory.
(cd angular/ng-app && npm install --no-audit --no-fund && npx ng build --output-path dist-root && npx ng build --base-href /repo/ --output-path dist-repo)
