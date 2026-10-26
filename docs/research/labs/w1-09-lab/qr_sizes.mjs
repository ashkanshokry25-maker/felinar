// byte-mode capacities from Thonky "Character Capacities by Version, Mode, and Error Correction" (versions 1-12 fetched; 13+ appended below when known)
const CAP = {
  L: [17,32,53,78,106,134,154,192,230,271,321,367],
  M: [14,26,42,62,84,106,122,152,180,213,251,287],
  Q: [11,20,32,46,60,74,86,108,130,151,177,203],
  H: [7,14,24,34,44,58,64,84,98,119,137,155]
}
const EXTRA = JSON.parse(process.argv[2] || '{}') // {L:[...v13..], ...}
for (const k of Object.keys(CAP)) if (EXTRA[k]) CAP[k] = CAP[k].concat(EXTRA[k])
const hex = '0123456789abcdef0123456789abcdef01234567'
const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.slice(0, 32)
const hub = 'https://hub.example/'
const tr1 = encodeURIComponent('wss://tracker.openwebtorrent.com')
const tr4 = ['wss://tracker.openwebtorrent.com','wss://tracker.webtorrent.dev','wss://tracker.btorrent.xyz','wss://tracker.files.fm:7073/announce'].map(encodeURIComponent)
const samples = {
  'domain mode: https://example.com/': 'https://example.com/',
  'hub: /#btih:<40 hex>': hub + '#btih:' + hex,
  'hub: /#btih:<32 base32>': hub + '#btih:' + b32,
  'hub: /#magnet:?xt=urn:btih:<hex> (no trackers)': hub + '#magnet:?xt=urn:btih:' + hex,
  'hub: /#magnet:?xt&dn&1 wss tracker': hub + '#magnet:?xt=urn:btih:' + hex + '&dn=My%20Site&tr=' + tr1,
  'hub: /#magnet:?xt&dn&4 wss trackers (CONFIG defaults)': hub + '#magnet:?xt=urn:btih:' + hex + '&dn=My%20Site' + tr4.map(t => '&tr=' + t).join(''),
  'bare magnet:?xt&dn&1 tracker': 'magnet:?xt=urn:btih:' + hex + '&dn=My%20Site&tr=' + tr1,
}
const fit = (len, ecc) => { const i = CAP[ecc].findIndex(c => c >= len); return i === -1 ? '>v' + CAP[ecc].length : 'v' + (i + 1) + ' (' + (21 + 4 * i) + 'x' + (21 + 4 * i) + ')' }
console.log('string'.padEnd(58), 'bytes'.padStart(5), '  L          M          Q          H')
for (const [k, v] of Object.entries(samples)) {
  const n = new TextEncoder().encode(v).length
  console.log(k.padEnd(58), String(n).padStart(5), ' ', ['L','M','Q','H'].map(e => fit(n, e).padEnd(10)).join(' '))
}
