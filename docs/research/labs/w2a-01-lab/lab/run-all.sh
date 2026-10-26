#!/bin/zsh
# Final matrix run. usage: ENGINE=chromium|webkit ./run-all.sh   (writes gen-<prefix>-*.json, results-kitchen*.<engine>.json, matrix-<engine>.log)
export PATH=$HOME/.local/share/node/current/bin:$PATH
cd "$(dirname "$0")"
E=${ENGINE:-chromium}; P=cr; [ "$E" = webkit ] && P=wk
export ENGINE=$E
LOG=matrix-$E.log; : > $LOG
M=prefix,remap,true
run() { # name dist home about selector spa modes base
  echo "### $P-$1" >> $LOG
  node run-gen.mjs $P-$1 "$2" "$3" "$4" "$5" "$6" "${7:-$M}" "${8:-/}" 2>&1 | grep -E '^\[|^#####' >> $LOG
}
echo "### kitchen" >> $LOG
node run-kitchen.mjs $M kitchen > out-kitchen.$E.txt 2>&1; node run-kitchen.mjs $M kitchen-rel > out-kitchen-rel.$E.txt 2>&1
G=gen
V="HELLO-HOME-vite-react HELLO-ABOUT-vite-react"
run vite-root $G/vite-react/dist-root $=V '#to-about' 1
run vite-rel $G/vite-react/dist-rel $=V '#to-about' 1
run vite-repo $G/vite-react/dist-repo $=V '#to-about' 1 $M /repo/
run astro-root $G/astro/dist-root HELLO-HOME-astro HELLO-ABOUT-astro '#to-about' 0
run astro-repo $G/astro/dist-repo HELLO-HOME-astro HELLO-ABOUT-astro '#to-about' 0 $M /repo/
run next-root $G/next/out-root HELLO-HOME-next HELLO-ABOUT-next '#to-about' 0
run next-repo $G/next/out-repo HELLO-HOME-next HELLO-ABOUT-next '#to-about' 0 $M /repo/
run sveltekit-root $G/sveltekit/build-root HELLO-HOME-sveltekit HELLO-ABOUT-sveltekit '#to-about' 0
run sveltekit-repo $G/sveltekit/build-repo HELLO-HOME-sveltekit HELLO-ABOUT-sveltekit '#to-about' 0 $M /repo/
run eleventy-root $G/eleventy/_site-root HELLO-HOME-eleventy HELLO-ABOUT-eleventy '#to-about' 0
run eleventy-repo $G/eleventy/_site-repo2 HELLO-HOME-eleventy HELLO-ABOUT-eleventy '#to-about' 0 $M /repo/
run hugo-root $G/hugo/public-root HELLO-HOME-hugo HELLO-ABOUT-hugo '#to-about' 0
run hugo-rel $G/hugo/public-rel HELLO-HOME-hugo HELLO-ABOUT-hugo '#to-about' 0
run hugo-repo $G/hugo/public-repo HELLO-HOME-hugo HELLO-ABOUT-hugo '#to-about' 0 $M /repo/
run mkdocs-nofont $G/mkdocs/site-nofont HELLO-HOME-mkdocs HELLO-ABOUT-mkdocs 'a.md-nav__link[href$="/about/"]' 0
run mkdocs-gfonts $G/mkdocs/site-root HELLO-HOME-mkdocs HELLO-ABOUT-mkdocs 'a.md-nav__link[href$="/about/"]' 0
run docusaurus-root $G/docusaurus/build-root HELLO-HOME-docusaurus HELLO-ABOUT-docusaurus '#to-about' 0
run docusaurus-repo $G/docusaurus/build-repo HELLO-HOME-docusaurus HELLO-ABOUT-docusaurus '#to-about' 0 $M /repo/
run docusaurus-hash $G/docusaurus/build-hash HELLO-HOME-docusaurus HELLO-ABOUT-docusaurus '#to-about' 1
run nuxt-root $G/nuxt/out-root HELLO-HOME-nuxt HELLO-ABOUT-nuxt '#to-about' 0
run nuxt-repo $G/nuxt/out-repo HELLO-HOME-nuxt HELLO-ABOUT-nuxt '#to-about' 0 $M /repo/
run nuxt-spa $G/nuxt/out-spa HELLO-HOME-nuxt HELLO-ABOUT-nuxt '#to-about' 1
run angular-root $G/angular/ng-app/dist-root/browser HELLO-HOME-angular HELLO-ABOUT-angular '#to-about' 1
run angular-repo $G/angular/ng-app/dist-repo/browser HELLO-HOME-angular HELLO-ABOUT-angular '#to-about' 1 $M /repo/
echo "### DONE" >> $LOG
