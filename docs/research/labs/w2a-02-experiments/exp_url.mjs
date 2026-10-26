// EXP-E: how the WHATWG URL parser (as used by fetch() in WebTorrent's webconn.js) treats characters that appear in CMS-exported file names.
// webtorrent@3.0.21 lib/webconn.js builds:  url = this.url + '/' + requestedFile.path.replace(this._torrent.path, '')   (NO percent-encoding)
const t = (s) => { const u = new URL(s); return { pathname: u.pathname, search: u.search, hash: u.hash }; };
const base = 'https://cdn.example.com/ws/site/';
const cases = {
  'space':                'a b.png',
  'query-style name':     'style.css?ver=6.4.2',
  'hash in name':         'img#1.png',
  'lone percent':         '100%.png',
  'percent-escape lookalike': 'a%41.png',
  'backslash':            'dir\\file.png',
  'dot segment':          'a/../b.png',
  'tab+newline':          'a\tb\nc.png',
  'encoded slash':        'a%2Fb.png',
  'NFC e-acute':          'café.html',
  'NFD e-acute':          'café.html',
};
for (const [k, v] of Object.entries(cases)) console.log(k.padEnd(26), JSON.stringify(t(base + v)));
console.log('\nNFC === NFD (JS strings):', 'café' === 'café', '| URL pathnames equal:', t(base + cases['NFC e-acute']).pathname === t(base + cases['NFD e-acute']).pathname);
console.log('decodeURIComponent("a%2Fb.png") ->', decodeURIComponent('a%2Fb.png'), '(the SW decodes before IndexedDB lookup, so an encoded slash becomes a path separator)');
