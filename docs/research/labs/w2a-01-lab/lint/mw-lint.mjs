#!/usr/bin/env node
// Reference implementation of the migration lint described in docs/research/w2a-01-site-generator-output.md.
// usage: node mw-lint.mjs <distDir> [--origin https://example.org] [--json]
// Zero dependencies. Heuristic (regex) scanning on purpose: it must run on any generator's output without parsing its toolchain.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const root = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
const originArg = (args[args.indexOf('--origin') + 1] || '').toLowerCase();
const asJson = args.includes('--json');
const { MIME_TYPES } = await import(new URL('../../../../../src/sw/lib.js', import.meta.url).href);

// ---------- walk
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push({ rel: path.relative(root, p).split(path.sep).join('/'), abs: p, size: fs.statSync(p).size }); } })(root);
const ext = (f) => { const b = f.rel.split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
const text = (f) => fs.readFileSync(f.abs, 'utf8');
const F = []; // findings
const add = (id, sev, msg, extra = {}) => F.push({ id, sev, msg, ...extra });
const bucket = () => new Map();
const bump = (m, k, ex) => { const v = m.get(k) || { n: 0, ex: [] }; v.n++; if (ex && v.ex.length < 3) v.ex.push(ex); m.set(k, v); };

// ---------- URL classification
const classify = (v) => {
  v = v.trim();
  if (!v || v.startsWith('#')) return 'fragment';
  if (/^(data|mailto|tel|javascript|blob|about|sms):/i.test(v)) return 'scheme';
  if (v.startsWith('//')) return 'protocol-relative';
  if (/^https?:\/\//i.test(v)) return originArg && v.toLowerCase().startsWith(originArg) ? 'absolute-own-origin' : 'absolute-external';
  if (v.startsWith('/')) return 'root-absolute';
  return 'relative';
};
const ATTR = /\b(src|href|action|poster|data-src|srcset|imagesrcset|formaction|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const htmlUrls = bucket(); const cssUrls = bucket(); const jsRoot = bucket(); const external = new Set();
const sw = { files: [], registerCalls: 0 }; const hints = bucket(); let bases = []; let integrity = 0; let csp = []; let postForms = 0; let importmaps = 0; let framebust = 0; let netlifyForms = 0; let hreflang = 0; let langRedirect = 0;
const routerSignals = new Set(); const nonGet = []; const rootUrls = []; let dialogCalls = 0; let embeds = 0; let maxHeadEnd = 0; const badHead = [];
const SWNAME = /(^|\/)(sw|service-?worker|ngsw-worker|firebase-messaging-sw|OneSignalSDK(Updater)?Worker|serviceworker|pwabuilder-sw|safety-worker|workbox-[0-9a-f]+|sw-[\w.-]+)\.js$/i;
const JSROOT = /["'`](\/(?:_next|_nuxt|_astro|_app|assets|static|build|images?|img|fonts?|js|css|api|data|media|chunks|webpack|dist|public)[A-Za-z0-9_./%\-]*)/g;
for (const f of files) {
  const e = ext(f);
  if (SWNAME.test(f.rel)) sw.files.push(f.rel);
  if (!['html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'webmanifest', 'xml', 'txt'].includes(e)) continue;
  if (f.size > 6e6) continue;
  const t = text(f);
  if (e === 'html' || e === 'htm') {
    for (const m of t.matchAll(ATTR)) {
      const name = m[1].toLowerCase(); const val = m[2] ?? m[3];
      if (name === 'content' && !/^(https?:)?\/\/|^\//.test(val.trim())) continue;
      const vals = (name === 'srcset' || name === 'imagesrcset') ? val.split(',').map((x) => x.trim().split(/\s+/)[0]) : [val];
      for (const v of vals) { const c = classify(v); if (c === 'root-absolute' && name !== 'content') rootUrls.push(v.split(/[?#]/)[0]); bump(htmlUrls, c, `${name}=${v.slice(0, 50)} (${f.rel})`); if (c === 'absolute-external' || c === 'protocol-relative') { try { external.add(new URL(v.startsWith('//') ? 'https:' + v : v).host); } catch (_) {} } }
    }
    for (const m of t.matchAll(/<base\b[^>]*>/gi)) bases.push(m[0].slice(0, 80));
    { const hm = /<head\b[^>]*>/i.exec(Buffer.from(t, 'utf8').subarray(0, 8192).toString('latin1')); const end = hm ? hm.index + hm[0].length : -1; if (end < 0 || end > 3800) badHead.push(f.rel + ':' + end); maxHeadEnd = Math.max(maxHeadEnd, end); }
    for (const m of t.matchAll(/<link\b[^>]*\brel=["']?(preload|prefetch|modulepreload|preconnect|dns-prefetch)["']?[^>]*>/gi)) bump(hints, m[1].toLowerCase(), m[0].slice(0, 90));
    integrity += (t.match(/\sintegrity=["']/gi) || []).length;
    for (const m of t.matchAll(/<meta\b[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi)) csp.push(m[0].slice(0, 160));
    for (const m of t.matchAll(/<(embed\b[^>]*\bsrc|object\b[^>]*\bdata)=["']([^"']+)["']/gi)) { if (!/^(https?:)?\/\//i.test(m[2])) embeds++; }
    for (const m of t.matchAll(/<form\b[^>]*>/gi)) { if (/method=["']?post/i.test(m[0])) { postForms++; nonGet.push(m[0].slice(0, 80)); } if (/data-netlify|netlify/i.test(m[0])) netlifyForms++; }
    importmaps += (t.match(/<script\b[^>]*type=["']importmap["']/gi) || []).length;
    hreflang += (t.match(/hreflang=/gi) || []).length;
    if (/top\s*!==?\s*self|self\s*!==?\s*top|window\.top\s*!==?\s*window|parent\s*!==?\s*window|top\.location\s*=/.test(t)) framebust++;
    if (/navigator\.(language|languages)[\s\S]{0,200}location\.(replace|href)/.test(t)) langRedirect++;
  }
  if (e === 'css') {
    for (const m of t.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi)) { if (m[2].startsWith('data:')) continue; const c = classify(m[2]); bump(cssUrls, c, `${m[2].slice(0, 50)} (${f.rel})`); if (c === 'absolute-external') { try { external.add(new URL(m[2]).host); } catch (_) {} } }
    for (const m of t.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) bump(cssUrls, classify(m[1]), `@import ${m[1]}`);
  }
  if (['html', 'htm', 'js', 'mjs', 'cjs'].includes(e)) {
    for (const m of t.matchAll(JSROOT)) bump(jsRoot, m[1].split('/')[1], `${m[1].slice(0, 50)} (${f.rel})`);
    dialogCalls += (t.match(/(^|[^.\w$])(alert|confirm|prompt)\s*\(|window\.(print|alert|confirm|prompt)\s*\(/g) || []).length;
    const reg = (t.match(/serviceWorker\s*\.\s*register\s*\(/g) || []).length; if (reg) { sw.registerCalls += reg; if (!sw.regFiles) sw.regFiles = []; if (sw.regFiles.length < 4) sw.regFiles.push(f.rel); }
    for (const [sig, re] of [['history.pushState', /history\s*\.\s*pushState|pushState\(/], ['react-router BrowserRouter', /createBrowserRouter|BrowserRouter/], ['vue-router createWebHistory', /createWebHistory/], ['angular router', /ng-version|ɵɵ|@angular\/router|provideRouter/], ['sveltekit', /__sveltekit_/], ['nuxt', /__NUXT__/], ['next', /__next_f|__NEXT_DATA__/], ['docusaurus', /__docusaurus|docusaurus/], ['astro transitions', /astro-view-transitions|astro:page-load/], ['hash router', /createHashRouter|HashRouter|createWebHashHistory|withHashLocation|experimental_router[^\n]{0,20}hash/]]) if (re.test(t)) routerSignals.add(sig);
    for (const m of t.matchAll(/fetch\(\s*["'`](\/api\/[^"'`]*)/g)) nonGet.push('fetch ' + m[1]);
    if (/new\s+WebSocket\(|new\s+EventSource\(/.test(t)) nonGet.push('WebSocket/EventSource in ' + f.rel);
  }
}
// ---------- file-level rules
const names = new Set(files.map((f) => f.rel));
const hostOnly = files.filter((f) => /^(robots\.txt|sitemap.*\.xml|ads\.txt|humans\.txt|security\.txt|\.well-known\/|CNAME$|\.nojekyll$|favicon\.ico$)/i.test(f.rel)).map((f) => f.rel);
const hostCfg = files.filter((f) => /(^|\/)(_headers|_redirects|netlify\.toml|vercel\.json|firebase\.json|\.htaccess|staticwebapp\.config\.json|web\.config|serve\.json|amplify\.yml|_routes\.json)$/.test(f.rel)).map((f) => f.rel);
const maps = files.filter((f) => ext(f) === 'map'); const pre = files.filter((f) => /\.(gz|br|zst)$/.test(f.rel));
const wasm = files.filter((f) => ext(f) === 'wasm');
const lower = new Map(); for (const f of files) { const k = f.rel.toLowerCase(); lower.set(k, (lower.get(k) || 0) + 1); }
const caseCollisions = [...lower.entries()].filter(([, n]) => n > 1).length;
const nonNFC = files.filter((f) => f.rel !== f.rel.normalize('NFC')).length;
const oddChars = files.filter((f) => /[#?%\s]/.test(f.rel)).length;
const noMime = [...new Set(files.map(ext).filter((x) => x && !(x in MIME_TYPES)))];
const HASHED = /[.\-_~]([A-Za-z0-9_-]{8}|[0-9a-f]{8,64})(\.min)?\.(js|mjs|css|map|woff2?|png|svg|jpe?g|webp|avif|gif|wasm)$/i;
const OPAQUE = /(^|\/)(_next\/static\/chunks|_next\/static\/media)\//;
const hashed = files.filter((f) => HASHED.test(f.rel) || OPAQUE.test(f.rel) || /^_app\/immutable\//.test(f.rel) || /^_astro\//.test(f.rel) || /^_nuxt\/[^/]+\.(js|css)$/.test(f.rel));
const total = files.reduce((a, f) => a + f.size, 0);
const html = files.filter((f) => ['html', 'htm'].includes(ext(f)));
const dirIdx = html.filter((f) => /\/index\.html$/.test(f.rel)).length; const flat = html.filter((f) => !/(^|\/)index\.html$/.test(f.rel) && !/^(404|200|_not-found)\.html$/.test(f.rel)).length;

// ---------- findings
const R = (m, c) => (m.get(c) || { n: 0 }).n;
const rootH = R(htmlUrls, 'root-absolute'), rootC = R(cssUrls, 'root-absolute'); const rootJ = [...jsRoot.values()].reduce((a, v) => a + v.n, 0);
if (rootH + rootC > 0) add('MW-U01', 'info', `${rootH} root-absolute URL(s) in HTML attributes, ${rootC} in CSS url()/@import: fine under same-URL serving, fatal under a path prefix`, { ex: [...(htmlUrls.get('root-absolute')?.ex || []), ...(cssUrls.get('root-absolute')?.ex || [])].slice(0, 3) });
if (rootJ > 0) add('MW-U03', 'warn', `${rootJ} root-absolute path literal(s) inside JS/inline scripts (cannot be rewritten safely): ${[...jsRoot.entries()].map(([k, v]) => `/${k}/ x${v.n}`).join(', ')}`);
if (R(htmlUrls, 'absolute-own-origin') + R(cssUrls, 'absolute-own-origin')) add('MW-U04', 'warn', `absolute URLs to the build origin ${originArg} found in resource attributes`, { ex: htmlUrls.get('absolute-own-origin')?.ex });
if (R(htmlUrls, 'protocol-relative')) add('MW-U05', 'info', `${R(htmlUrls, 'protocol-relative')} protocol-relative URL(s)`);
if (external.size) add('MW-U06', 'warn', `third-party hosts referenced (privacy/offline/CSP): ${[...external].slice(0, 6).join(', ')}`);
if (bases.length) { const bh = /href=["']([^"']*)["']/i.exec(bases[0]); add('MW-B01', 'warn', `<base> element present: ${bases[0]} -> base path ${bh ? bh[1] : '?'} (all relative URLs resolve against it; never inject a second one)`); }
if (sw.files.length || sw.registerCalls) add('MW-S01', 'block', `service worker: files=[${sw.files.join(', ')}] register() calls=${sw.registerCalls} ${sw.regFiles ? '(in ' + sw.regFiles.join(', ') + ')' : ''}`);
const manifest = files.filter((f) => /(^|\/)(manifest\.webmanifest|manifest\.json|site\.webmanifest)$/.test(f.rel)).map((f) => f.rel); if (manifest.length) add('MW-S02', 'info', `web app manifest: ${manifest.join(', ')} (PWA install uses the TOP document, i.e. the loader shell)`);
if (hostCfg.length) add('MW-H01', 'warn', `host config files that the loader will NOT honour unless imported: ${hostCfg.join(', ')}`);
if (hostOnly.length) add('MW-H02', 'info', `files crawlers/hosts fetch directly (keep on the static host, also keep in torrent if the site reads them): ${hostOnly.slice(0, 6).join(', ')}`);
if (integrity) add('MW-F01', 'warn', `${integrity} integrity= (SRI) attribute(s): any byte-level rewrite of the referenced file invalidates them`);
if (hashed.length) add('MW-F02', 'info', `${hashed.length}/${files.length} files look content-hashed or live under an immutable dir (cache-first safe across versions)`);
if (maps.length || pre.length) add('MW-F04', 'info', `${maps.length} source map(s) ${(maps.reduce((a, f) => a + f.size, 0) / 1024).toFixed(0)} KiB, ${pre.length} precompressed sibling(s) (.gz/.br) that only bloat the torrent`);
if (caseCollisions || nonNFC || oddChars) add('MW-F05', 'warn', `filename hazards: case collisions=${caseCollisions}, non-NFC=${nonNFC}, #?% or whitespace=${oddChars}`);
if (wasm.length) add('MW-F06', 'info', `${wasm.length} .wasm file(s): needs application/wasm (SW MIME table has it)`);
if (noMime.length) add('MW-F07', 'warn', `extensions missing from src/sw/lib.js MIME table (would be served as application/octet-stream): ${noMime.join(', ')}`);
if (nonGet.length) add('MW-X01', 'warn', `server-dependent behaviour: ${nonGet.slice(0, 3).join(' | ')}`);
if (netlifyForms) add('MW-X01', 'block', `${netlifyForms} Netlify-Forms style form(s): handled by the host at deploy time, will not work`);
if (csp.length) add('MW-X02', 'warn', `meta CSP present: ${csp[0].slice(0, 110)} (check script-src/worker-src/connect-src wss: for the loader)`);
if (framebust) add('MW-X03', 'block', `${framebust} file(s) contain frame-busting code (top !== self / top.location=)`);
if (importmaps) add('MW-X04', 'info', `${importmaps} <script type=importmap> (URLs in it resolve against the document base URL)`);
if (hreflang || langRedirect) add('MW-I01', 'info', `i18n: ${hreflang} hreflang link(s); ${langRedirect} page(s) redirect by navigator.language`);
const spaFallback = names.has('200.html') ? '200.html' : (html.length === 1 && routerSignals.size ? 'index.html' : null);
if (spaFallback || (names.has('404.html') && html.length > 1 && false)) add('MW-R01', 'warn', `client-side router(s) [${[...routerSignals].join(', ')}] with ${html.length} HTML file(s): unknown paths must fall back to ${spaFallback} (status 200)`);
if (routerSignals.has('hash router')) add('MW-R02', 'info', 'hash router detected: path-agnostic, safe under any prefix');
if (names.has('404.html')) add('MW-R03', 'info', '404.html present: serve it with status 404 for unknown paths');
if (dirIdx && flat) add('MW-R04', 'info', `mixed URL styles: ${dirIdx} dir/index.html and ${flat} flat .html files (clean-URL resolution p -> p/index.html | p.html needed)`);
if ([...hints.keys()].length) add('MW-P01', 'info', `resource hints: ${[...hints.entries()].map(([k, v]) => k + 'x' + v.n).join(', ')}`);


// ---- H03 reserved path collisions (ARCHITECTURE v0.2 section 3)
const reserved = files.filter((f) => /^(_mw\/|\.mw\/|ws\/|mw-sw\.js$)/.test(f.rel)).map((f) => f.rel);
if (reserved.length) add('MW-H03', 'block', `files collide with loader-reserved paths (/_mw/, /.mw/, /ws/, /mw-sw.js): ${reserved.slice(0, 4).join(', ')}`);
// ---- X06 same-origin <embed>/<object> are never offered to a service worker (Service Workers spec, Handle Fetch)
if (embeds) add('MW-X06', 'warn', `${embeds} same-origin <embed src>/<object data> reference(s): destination embed/object bypasses the SW, so they load from the host, not the torrent (use <iframe> or <img>)`);
// ---- X05 modal dialogs need allow-modals (MDN iframe sandbox)
if (dialogCalls) add('MW-X05', 'info', `${dialogCalls} alert/confirm/prompt/print call site(s) (library code included): silently ignored in a sandboxed frame without allow-modals`);
// ---- D01 drop-in stamp window (meta must sit inside the first 4 KiB)
if (html.length) add('MW-D01', badHead.length ? 'block' : 'info', badHead.length ? `<head> opens after byte 3800 or is missing in: ${badHead.slice(0, 3).join(', ')}` : `all ${html.length} HTML file(s) open <head> by byte ${maxHeadEnd}: a pointer stamped as first child fits the 4 KiB window`);
// ---- B02 build base detection + hard-coded paths outside it
{
  const KNOWN = new Set(['_next', '_nuxt', '_astro', '_app', 'assets', 'static', 'build', 'images', 'image', 'img', 'fonts', 'font', 'js', 'css', 'api', 'data', 'media', 'chunks', 'webpack', 'dist', 'public', 'about', 'blog', 'docs', 'search']);
  const seg = (u) => u.split('/')[1] || '';
  if (rootUrls.length >= 3) {
    const counts = new Map(); for (const u of rootUrls) counts.set(seg(u), (counts.get(seg(u)) || 0) + 1);
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && !top.includes('.') && !KNOWN.has(top) && n / rootUrls.length >= 0.75) {
      const outliers = [...new Set(rootUrls.filter((u) => seg(u) !== top))];
      add('MW-B02', 'warn', `site was built for base /${top}/ (${n}/${rootUrls.length} root-absolute URLs start with it): needs 'base' in /.mw/site.json and the loader mounted at /${top}/ or the SW stripping it` + (outliers.length ? `; ${outliers.length} URL(s) outside the base would 404 on the original host too: ${outliers.slice(0, 3).join(', ')}` : ''));
    }
  }
}

const summary = { root: root.replace(/^.*\/lab\/gen\//, ''), files: files.length, bytes: total, html: html.length, htmlUrls: Object.fromEntries([...htmlUrls].map(([k, v]) => [k, v.n])), cssUrls: Object.fromEntries([...cssUrls].map(([k, v]) => [k, v.n])), jsRootLiterals: rootJ, hashedFiles: hashed.length, swFiles: sw.files, findings: F };
if (asJson) console.log(JSON.stringify(summary, null, 1));
else {
  console.log(`\n=== ${summary.root}: ${files.length} files, ${(total / 1024).toFixed(0)} KiB, ${html.length} html`);
  console.log('   html URL forms:', JSON.stringify(summary.htmlUrls), ' css:', JSON.stringify(summary.cssUrls), ' js root literals:', rootJ);
  for (const f of F) console.log(`   [${f.sev.toUpperCase().padEnd(5)}] ${f.id} ${f.msg}${f.ex && f.ex.length ? '  e.g. ' + f.ex.join(' ; ') : ''}`);
}
