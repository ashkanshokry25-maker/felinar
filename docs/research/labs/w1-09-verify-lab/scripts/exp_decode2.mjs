// Claim 4, second pass: vary ONE special character at a time in the tracker URL path (no '?'/'=' unless that IS the character).
import { detectModeOld } from './old_detect_mode.mjs'
import { parseMagnet, formatMagnet } from '$HOME/Documents/Projects/magnet-web/src/common/magnet.js'
import * as magnetUri from '$HOME/Documents/Projects/magnet-web/node_modules/magnet-uri/index.js'
const hex = '0123456789abcdef0123456789abcdef01234567'
const loc = (hash) => ({ hostname: 'hub.example', pathname: '/', search: '', hash })
const chars = [['&', 'a&b'], ['=', 'a=b'], ['?', 'a?b'], ['#', 'a#b'], ['% (lone)', 'a%b'], ['%41 (literal escape)', 'a%41b'], ['+', 'a+b'], ['space', 'a b'], ['/', 'a/b'], [':', 'a:b'], ['@', 'a@b'], ['é', 'café'], ['(none: plain tracker)', 'plain']]
const out = []
for (const [label, v] of chars) {
  const tracker = 'wss://tracker.example:443/announce/' + v
  const original = formatMagnet({ btih: hex, tr: [tracker] })
  const lit = '#' + original
  const hand = '#' + encodeURIComponent(original)
  const trProject = parseMagnet(detectModeOld(loc(lit)).pointerText)?.tr
  const trHand = parseMagnet(detectModeOld(loc(hand)).pointerText)?.tr
  let trInstant, trInstantHand
  try { trInstant = magnetUri.decode(decodeURIComponent(lit.slice(1))).announce } catch (e) { trInstant = 'ERR ' + e.message }
  try { trInstantHand = magnetUri.decode(decodeURIComponent(hand.slice(1))).announce } catch (e) { trInstantHand = 'ERR ' + e.message }
  const ok = (a) => JSON.stringify(a) === JSON.stringify([tracker])
  out.push({ char: label, 'project literal': ok(trProject), 'project handler-built': ok(trHand), 'instant.io literal': ok(trInstant), 'instant.io handler-built': ok(trInstantHand) })
}
console.table(out)
// the exact claim string
const claim = 'magnet:?xt=urn:btih:' + hex + '&dn=My%20Site&tr=wss%3A%2F%2Ftracker.example%3A443%2Fannounce%3Fkey%3Da%26b%3Dc'
const rc = parseMagnet(detectModeOld(loc('#' + claim)).pointerText)
console.log('project, claim string literal  : tr =', JSON.stringify(rc.tr))
const mu = magnetUri.decode(decodeURIComponent(claim))
console.log('instant.io path, claim literal : announce =', JSON.stringify(mu.announce), '| stray param b =', JSON.stringify(mu.b))
const mh = magnetUri.decode(decodeURIComponent(encodeURIComponent(claim)))
console.log('instant.io path, handler-built : announce =', JSON.stringify(mh.announce))
