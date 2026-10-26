import { execFileSync } from 'node:child_process';
const G = process.argv[2];
const builds = [
  ['Vite 8.3.4 base=/', 'vite-react/dist-root', 'https://example.org'], ['Vite 8.3.4 base=./', 'vite-react/dist-rel', 'https://example.org'], ['Vite 8.3.4 base=/repo/', 'vite-react/dist-repo', 'https://example.org'],
  ['Astro 7.4.0', 'astro/dist-root', 'https://example.com'], ['Next 16.4.2 export', 'next/out-root', 'https://example.org'], ['SvelteKit 3.1.0', 'sveltekit/build-root', 'https://example.org'],
  ['Eleventy 3.1.7', 'eleventy/_site-root', 'https://example.org'], ['Hugo 0.168.0', 'hugo/public-root', 'https://example.org'], ['Hugo relativeURLs', 'hugo/public-rel', 'https://example.org'],
  ['MkDocs 1.6.1+Material 9.7.7', 'mkdocs/site-root', 'https://example.org'], ['Docusaurus 3.10.2', 'docusaurus/build-root', 'https://example.org'], ['Docusaurus hash router', 'docusaurus/build-hash', 'https://example.org'],
  ['Nuxt 4.6.2 SSG', 'nuxt/out-root', 'https://example.org'], ['Nuxt 4.6.2 ssr:false', 'nuxt/out-spa', 'https://example.org'], ['Angular 22.2.3', 'angular/ng-app/dist-root/browser', 'https://example.org'],
];
const rows = [];
for (const [name, dir, origin] of builds) {
  const j = JSON.parse(execFileSync(process.execPath, ['mw-lint.mjs', G + '/' + dir, '--origin', origin, '--json'], { encoding: 'utf8' }));
  const h = j.htmlUrls, c = j.cssUrls;
  const ids = [...new Set(j.findings.map((f) => f.id))].join(' ');
  rows.push({ name, files: j.files, kib: Math.round(j.bytes / 1024), html: j.html, hRoot: h['root-absolute'] || 0, hRel: h.relative || 0, hAbsOwn: h['absolute-own-origin'] || 0, hExt: h['absolute-external'] || 0, cRoot: c['root-absolute'] || 0, cRel: c.relative || 0, jsLit: j.jsRootLiterals, hashed: j.hashedFiles, sw: j.swFiles.length, ids });
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('build', 30) + pad('files', 6) + pad('KiB', 6) + pad('html', 5) + pad('htmlRootAbs', 12) + pad('htmlRel', 8) + pad('htmlAbsOwn', 11) + pad('htmlExt', 8) + pad('cssRoot', 8) + pad('cssRel', 7) + pad('jsRootLit', 10) + pad('hashed', 7) + 'findings');
for (const r of rows) console.log(pad(r.name, 30) + pad(r.files, 6) + pad(r.kib, 6) + pad(r.html, 5) + pad(r.hRoot, 12) + pad(r.hRel, 8) + pad(r.hAbsOwn, 11) + pad(r.hExt, 8) + pad(r.cRoot, 8) + pad(r.cRel, 7) + pad(r.jsLit, 10) + pad(r.hashed, 7) + r.ids);
