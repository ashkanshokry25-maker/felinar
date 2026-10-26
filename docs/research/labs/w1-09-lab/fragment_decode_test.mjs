// Scratch experiment for research note w1-09: how src/loader/render.js detectMode() copes with
// (A) the fragment a browser builds from a protocol handler template  https://hub/#%s
// (B) a hand-built share link whose fragment is a literal magnet URI.
import { detectMode } from '$HOME/Documents/Projects/magnet-web/src/loader/render.js'
import { parseMagnet } from '$HOME/Documents/Projects/magnet-web/src/common/magnet.js'

const hex = '0123456789abcdef0123456789abcdef01234567'
// A realistic magnet: space in dn, a wss tracker whose own URL has a query string with an encoded '&'
const tracker = 'wss://tracker.example:443/announce?key=a&b=c'
const magnet = 'magnet:?xt=urn:btih:' + hex + '&dn=' + encodeURIComponent('My Site') + '&tr=' + encodeURIComponent(tracker)
console.log('original magnet      :', magnet)
console.log('parsed original      :', JSON.stringify(parseMagnet(magnet)))

// (A) what Chromium/Firefox navigate to: handler URL with %s replaced by encodeURIComponent(magnet)
//     (HTML spec: UTF-8 percent-encode with the component percent-encode set; Chromium: EscapeQueryParamValue)
const hashA = '#' + encodeURIComponent(magnet)
const locA = { hostname: 'hub.example', pathname: '/', search: '', hash: hashA }
const rA = detectMode(locA)
console.log('\n(A) handler-built hash:', hashA.slice(0, 90) + '...')
console.log('    detectMode ->', rA.mode, rA.kind, 'pointerText equals original:', rA.pointerText === magnet)
console.log('    parsed        :', JSON.stringify(parseMagnet(rA.pointerText)))

// (B) hand-built share link, literal magnet in the fragment (internal %-escapes kept as in the magnet)
const hashB = '#' + magnet
const locB = { hostname: 'hub.example', pathname: '/', search: '', hash: hashB }
const rB = detectMode(locB)
console.log('\n(B) literal-magnet hash:', hashB.slice(0, 90) + '...')
console.log('    detectMode ->', rB.mode, rB.kind, 'pointerText equals original:', rB.pointerText === magnet)
console.log('    pointerText   :', rB.pointerText)
console.log('    parsed        :', JSON.stringify(parseMagnet(rB.pointerText)))
console.log('    tracker preserved:', JSON.stringify(parseMagnet(rB.pointerText)?.tr) === JSON.stringify([tracker]))

// (C) shortest form
const locC = { hostname: 'hub.example', pathname: '/', search: '', hash: '#btih:' + hex }
const rC = detectMode(locC)
console.log('\n(C) #btih:<hex> ->', rC.mode, rC.kind, rC.pointerText)

// (D) what if a browser did NOT encode '%' (non-conformant)? the single decode over-decodes
const hashD = '#' + magnet.replace(/[:?=&]/g, c => encodeURIComponent(c)) // leaves existing %XX alone
const rD = detectMode({ hostname: 'hub.example', pathname: '/', search: '', hash: hashD })
console.log('\n(D) hypothetical engine that leaves existing %XX unescaped:')
console.log('    pointerText equals original:', rD.pointerText === magnet, '| tr:', JSON.stringify(parseMagnet(rD.pointerText)?.tr))
