// Deterministic "typical small site" fixture used by the P2P/web-seed labs: 15 files, ~1.43 MiB, sorted paths (as publish.mjs sorts them).
export function prng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; }; }
export function bytesFor(path, n) { const r = prng([...path].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)); const b = new Uint8Array(n); for (let i = 0; i < n; i += 4) { const v = r(); b[i] = v; if (i + 1 < n) b[i + 1] = v >>> 8; if (i + 2 < n) b[i + 2] = v >>> 16; if (i + 3 < n) b[i + 3] = v >>> 24; } return b; }
export const SITE_SPEC = [
  ['404.html', 3 * 1024], ['about.html', 5 * 1024], ['css/site.css', 30 * 1024], ['data/posts.json', 20 * 1024],
  ['fonts/inter-bold.woff2', 48 * 1024], ['fonts/inter-regular.woff2', 45 * 1024],
  ['img/hero.jpg', 420 * 1024], ['img/logo.svg', 4 * 1024], ['img/p1.jpg', 160 * 1024], ['img/p2.jpg', 150 * 1024], ['img/p3.jpg', 140 * 1024], ['img/p4.jpg', 130 * 1024],
  ['index.html', 12 * 1024], ['js/app.js', 120 * 1024], ['js/vendor.js', 180 * 1024],
];
export const CRITICAL = ['index.html', 'css/site.css', 'js/app.js', 'js/vendor.js'];
export function makeSite() { return SITE_SPEC.map(([path, n]) => ({ path, bytes: bytesFor(path, n) })); }
export const SITE_NAME = 'site';
