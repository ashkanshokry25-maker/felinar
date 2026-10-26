// Claim 4, current tree: does the rewritten src/loader/app.js parseFragment() (modified 18:06 ET) round-trip both forms?
import { parseFragment } from '$HOME/Documents/Projects/magnet-web/src/loader/app.js'
import { parseMagnet, formatMagnet } from '$HOME/Documents/Projects/magnet-web/src/common/magnet.js'
const hex = '0123456789abcdef0123456789abcdef01234567'
const chars = [['&', 'a&b'], ['=', 'a=b'], ['?', 'a?b'], ['#', 'a#b'], ['% (lone)', 'a%b'], ['%41 (literal escape)', 'a%41b'], ['+', 'a+b'], ['space', 'a b'], ['/', 'a/b'], [':', 'a:b'], ['@', 'a@b'], ['é', 'café'], ['plain', 'plain']]
const rows = []
for (const [label, v] of chars) {
  const tracker = 'wss://tracker.example:443/announce/' + v
  const original = formatMagnet({ btih: hex, tr: [tracker] })
  const row = { char: label }
  for (const [k, h] of Object.entries({ literal: '#' + original, handlerBuilt: '#' + encodeURIComponent(original) })) {
    const f = parseFragment(h, '')
    row[k] = f && JSON.stringify(parseMagnet(f.text)?.tr) === JSON.stringify([tracker])
  }
  rows.push(row)
}
console.table(rows)
const claim = 'magnet:?xt=urn:btih:' + hex + '&dn=My%20Site&tr=wss%3A%2F%2Ftracker.example%3A443%2Fannounce%3Fkey%3Da%26b%3Dc'
console.log('claim example, literal      :', JSON.stringify(parseMagnet(parseFragment('#' + claim, '').text).tr))
console.log('claim example, handler-built:', JSON.stringify(parseMagnet(parseFragment('#' + encodeURIComponent(claim), '').text).tr))
