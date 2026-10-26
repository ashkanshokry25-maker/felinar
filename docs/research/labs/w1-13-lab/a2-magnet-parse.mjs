// w1-13 A2: magnet-uri 7.0.10 + parse-torrent 11.0.24 edge cases (what the library accepts, drops or throws on).
import magnet, { encode as magnetEncode } from 'magnet-uri'
import parseTorrent, { toMagnetURI, toTorrentFile } from 'parse-torrent'
import { createRequire } from 'node:module'
const H = '0123456789abcdef0123456789abcdef01234567' // 40 hex
// base32 of the same 20 bytes (RFC 4648, uppercase, no padding needed for 20 bytes = 32 chars)
const b32 = (hex) => { const b = Buffer.from(hex, 'hex'); const al = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0, o = ''; for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += al[(v >>> (bits - 5)) & 31]; bits -= 5 } } if (bits > 0) o += al[(v << (5 - bits)) & 31]; return o }
const B32 = b32(H)
const V2 = 'a'.repeat(64)
const out = {}
const tryIt = (label, fn) => { try { const r = fn(); out[label] = r } catch (e) { out[label] = { THROWS: `${e.name}: ${e.message}` } } }
const slim = (r) => { const o = { ...r }; for (const k of Object.keys(o)) if (o[k] instanceof Uint8Array) delete o[k]; return o }

out.constants = { hex40: H, base32: B32 }
tryIt('hexLower', () => slim(magnet(`magnet:?xt=urn:btih:${H}`)))
tryIt('hexUpper', () => slim(magnet(`magnet:?xt=urn:btih:${H.toUpperCase()}`)))
tryIt('base32Upper', () => slim(magnet(`magnet:?xt=urn:btih:${B32}`)))
tryIt('base32Lower', () => slim(magnet(`magnet:?xt=urn:btih:${B32.toLowerCase()}`)))
tryIt('nonHex40chars', () => slim(magnet(`magnet:?xt=urn:btih:${'z'.repeat(40)}`)))
tryIt('hex41chars_trailingGarbage', () => slim(magnet(`magnet:?xt=urn:btih:${H}ZZ`)))
tryIt('hex39chars', () => slim(magnet(`magnet:?xt=urn:btih:${H.slice(0, 39)}`)))
tryIt('v2only_btmh', () => slim(magnet(`magnet:?xt=urn:btmh:1220${V2}`)))
tryIt('hybrid_btih_btmh', () => slim(magnet(`magnet:?xt=urn:btih:${H}&xt=urn:btmh:1220${V2}`)))
tryIt('btmh_unknown_multihash_code_sha3', () => slim(magnet(`magnet:?xt=urn:btmh:1620${V2}`)))
tryIt('uppercase_scheme_and_keys_(QR_alphanumeric_mode)', () => slim(magnet(`MAGNET:?XT=URN:BTIH:${H.toUpperCase()}&DN=SITE`)))
tryIt('uppercase_scheme_only', () => slim(magnet(`MAGNET:?xt=urn:btih:${H}`)))
tryIt('stream-magnet_prefix', () => slim(magnet(`stream-magnet:?xt=urn:btih:${H}`)))
tryIt('dn_plus_and_percent', () => slim(magnet(`magnet:?xt=urn:btih:${H}&dn=My+Site%20%C3%A9`)))
tryIt('dn_malformed_percent', () => slim(magnet(`magnet:?xt=urn:btih:${H}&dn=%E0%A4%A`)))
tryIt('tr_malformed_percent', () => slim(magnet(`magnet:?xt=urn:btih:${H}&tr=%E0%A4%A`)))
tryIt('tr_encoded_two_dupe', () => slim(magnet(`magnet:?xt=urn:btih:${H}&tr=wss%3A%2F%2Fa.example%2Fannounce&tr=wss%3A%2F%2Fb.example&tr=wss%3A%2F%2Fa.example%2Fannounce`)))
tryIt('tr_unencoded_with_query_&', () => slim(magnet(`magnet:?xt=urn:btih:${H}&tr=wss://a.example/announce?k=1&x=2`)))
tryIt('xs_unencoded_url_with_equals', () => slim(magnet(`magnet:?xt=urn:btih:${H}&xs=https://h.example/a.torrent?v=1`)))
tryIt('xs_encoded_url_with_equals', () => slim(magnet(`magnet:?xt=urn:btih:${H}&xs=${encodeURIComponent('https://h.example/a.torrent?v=1')}`)))
tryIt('xs_two_values', () => slim(magnet(`magnet:?xt=urn:btih:${H}&xs=${encodeURIComponent('https://a.example/a.torrent')}&xs=${encodeURIComponent('https://b.example/a.torrent')}`)))
tryIt('xs_btpk_BEP46', () => slim(magnet(`magnet:?xt=urn:btih:${H}&xs=urn:btpk:${'b'.repeat(64)}&s=abcd`)))
tryIt('ws_and_as_both_to_urlList', () => slim(magnet(`magnet:?xt=urn:btih:${H}&ws=${encodeURIComponent('https://w.example/base/')}&as=${encodeURIComponent('https://as.example/x')}`)))
tryIt('so_BEP53', () => slim(magnet(`magnet:?xt=urn:btih:${H}&so=0,2,4-6`)))
tryIt('so_percent_encoded_commas', () => slim(magnet(`magnet:?xt=urn:btih:${H}&so=0%2C2%2C4-6`)))
tryIt('x.pe_two', () => slim(magnet(`magnet:?xt=urn:btih:${H}&x.pe=192.0.2.1:6881&x.pe=%5B2001:db8::1%5D:6881`)))
tryIt('kt_keywords', () => slim(magnet(`magnet:?xt=urn:btih:${H}&kt=a+b+c`)))
tryIt('empty_value_xs', () => slim(magnet(`magnet:?xt=urn:btih:${H}&xs=`)))
tryIt('no_xt', () => slim(magnet(`magnet:?dn=x`)))
tryIt('repeated_dn', () => slim(magnet(`magnet:?xt=urn:btih:${H}&dn=a&dn=b`)))
tryIt('fragment_after_magnet', () => slim(magnet(`magnet:?xt=urn:btih:${H}&dn=x#frag`)))

// parse-torrent (async) on identifier shapes
const pt = async (label, id) => { try { const r = await parseTorrent(id); out['pt_' + label] = slim(r) } catch (e) { out['pt_' + label] = { THROWS: `${e.name}: ${e.message}` } } }
await pt('hex40', H)
await pt('hex40_upper', H.toUpperCase())
await pt('base32_32chars', B32)
await pt('base32_lower', B32.toLowerCase())
await pt('raw20bytes', new Uint8Array(Buffer.from(H, 'hex')))
await pt('arraybuffer_not_view', new Uint8Array(Buffer.from(H, 'hex')).buffer)
await pt('v2only_magnet', `magnet:?xt=urn:btmh:1220${V2}`)
await pt('uppercase_magnet', `MAGNET:?xt=urn:btih:${H}`)
await pt('http_url_string', 'https://example.org/a.torrent')

// round-trip: toMagnetURI for a parsed object
const parsed = await parseTorrent(`magnet:?xt=urn:btih:${H}&dn=My+Site&tr=${encodeURIComponent('wss://t.example/announce')}&ws=${encodeURIComponent('https://w.example/base/')}&xs=${encodeURIComponent('https://h.example/a.torrent')}&so=1,3-4&x.pe=192.0.2.1:6881`)
out.roundTrip = { parsedKeys: Object.keys(parsed).sort(), toMagnetURI: toMagnetURI(parsed) }
out.encodeFromObject = magnetEncode({ infoHash: H, name: 'a b&c', announce: ['wss://t.example/announce?x=1&y=2'], urlList: ['https://w.example/base/'], xs: ['https://h.example/a.torrent?v=1'] })
console.log(JSON.stringify(out, null, 1))
