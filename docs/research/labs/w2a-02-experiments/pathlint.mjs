// Reference implementation of the "export path policy" a magnet-web migrate/publish step should enforce.
// Rules and their evidence: see docs/research/w2a-02-cms-export.md (F-PATH). Pure JS, no dependencies.
const BAD_CHARS = /[?#%\\\u0000-\u001f\u007f:*"<>|]/;           // '?#%\' break WebConn URL building (string concat, no encoding); ':*"<>|' are Windows-reserved (wget windows mode escapes them)
const enc = new TextEncoder();
export function lintPaths(paths, { reserved = ['_mw/', 'mw-sw.js', '.mw/'], maxSegBytes = 255, maxPathBytes = 1024 } = {}) {
  const issues = []; const seen = new Map();
  for (const p of paths) {
    const why = [];
    if (p !== p.normalize('NFC')) why.push('not NFC (APFS preserves NFD but treats NFC/NFD as one name; URL paths never normalize)');
    if (p.startsWith('/') || p.includes('//')) why.push('leading or empty segment');
    for (const seg of p.split('/')) {
      if (seg === '.' || seg === '..') why.push(`dot segment "${seg}" (URL parser removes it)`);
      if (BAD_CHARS.test(seg)) why.push(`forbidden character in "${seg}"`);
      if (/[. ]$/.test(seg) || /^ /.test(seg)) why.push(`leading/trailing space or trailing dot in "${seg}"`);
      if (enc.encode(seg).length > maxSegBytes) why.push(`segment > ${maxSegBytes} bytes`);
    }
    if (enc.encode(p).length > maxPathBytes) why.push(`path > ${maxPathBytes} bytes (S3 key limit)`);
    if (reserved.some(r => p === r.replace(/\/$/, '') || p.startsWith(r))) why.push('collides with reserved magnet-web path');
    const fold = p.normalize('NFC').toLowerCase();
    if (seen.has(fold) && seen.get(fold) !== p) why.push(`case/normalization collision with "${seen.get(fold)}"`); else seen.set(fold, p);
    if (why.length) issues.push({ path: p, why });
  }
  return issues;
}
if (process.argv[1] && process.argv[1].endsWith('pathlint.mjs')) {
  const vectors = [
    'wp-content/themes/t/style.css',                // ok
    'wp-content/themes/t/style.css?ver=6.4.2',      // wget unix mode, wget -E would also append .css
    'wp-content/themes/t/style.css@ver=6.4.2',      // wget --restrict-file-names=windows
    'index.php?p=123.html',                         // wget -E on a query URL: "article.cgi?25.html" in the man page
    'blog/foo4B54.html',                            // HTTrack -K0 style renamed file (hash suffix) - legal
    'blog/café/index.html', 'blog/café/index.html',   // NFC vs NFD
    'img/IMG_001.JPG', 'img/img_001.jpg',           // case collision (WordPress on Linux is case sensitive)
    'img/a#b.png', 'img/100%.png', 'img/a%41.png', 'img\\dir.png', 'img/../x.png',
    '.well-known/security.txt', '.htaccess',
    '_mw/sdk.js', 'mw-sw.js',
    'blog/' + 'x'.repeat(300) + '.html',
  ];
  const out = lintPaths(vectors);
  const flagged = new Set(out.map(i => i.path));
  for (const v of vectors) { const i = out.find(x => x.path === v); console.log((i ? 'REJECT ' : 'ok     ') + JSON.stringify(v.length > 60 ? v.slice(0, 40) + '...(' + v.length + ' chars)' : v) + (i ? '  <- ' + i.why.join('; ') : '')); }
  console.log(`\n${out.length} of ${vectors.length} test paths rejected`);
}
