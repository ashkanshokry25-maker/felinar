// Does the research note's proposed fix (R2 fragmentToPointerText) round-trip both forms for every special character? (project parseMagnet + WebTorrent magnet-uri)
import { fragmentToPointerText } from './old_detect_mode.mjs'
import { parseMagnet, formatMagnet } from '$HOME/Documents/Projects/magnet-web/src/common/magnet.js'
import * as magnetUri from '$HOME/Documents/Projects/magnet-web/node_modules/magnet-uri/index.js'
const hex = '0123456789abcdef0123456789abcdef01234567'
const chars = [['&', 'a&b'], ['=', 'a=b'], ['?', 'a?b'], ['#', 'a#b'], ['% (lone)', 'a%b'], ['%41 (literal escape)', 'a%41b'], ['+', 'a+b'], ['space', 'a b'], ['/', 'a/b'], [':', 'a:b'], ['@', 'a@b'], ['é', 'café'], ['plain', 'plain']]
const rows = []
for (const [label, v] of chars) {
  const tracker = 'wss://tracker.example:443/announce/' + v
  const original = formatMagnet({ btih: hex, tr: [tracker] })
  const forms = { literal: '#' + original, handlerBuilt: '#' + encodeURIComponent(original) }
  const row = { char: label }
  for (const [k, h] of Object.entries(forms)) {
    const text = fragmentToPointerText(h)
    row[k + ' project'] = JSON.stringify(parseMagnet(text)?.tr) === JSON.stringify([tracker])
    let a; try { a = magnetUri.decode(text).announce } catch (e) { a = 'ERR' }
    row[k + ' magnet-uri'] = JSON.stringify(a) === JSON.stringify([tracker])
  }
  rows.push(row)
}
console.table(rows)
