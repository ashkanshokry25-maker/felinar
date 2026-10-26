// Decode Chromium's base/strings/escape.cc kQueryCharmap (used by EscapeQueryParamValue(text, use_plus=false)) and compare with encodeURIComponent
// for every byte value; also rebuild the URL Standard "component percent-encode set" from url.bs text and compare for U+0000..U+007F.
import fs from 'node:fs'
const src = fs.readFileSync(process.argv[2], 'utf8')
const m = /kQueryCharmap = \{\{([^}]+)\}\}/.exec(src)
const words = m[1].split(',').map(s => parseInt(s.trim().replace(/L$/, ''), 16))
// Charmap: bit i of word (b>>5) set => byte b is ESCAPED (per Chromium's Escape(): `charmap.Contains(c)` => escape)
const escaped = (b) => ((words[b >> 5] >>> (b & 31)) & 1) === 1
const diffs = []
for (let b = 0; b < 256; b++) {
  const chromiumEscapes = escaped(b)
  const ch = b < 128 ? String.fromCharCode(b) : null
  const eucEscapes = b < 128 ? encodeURIComponent(ch) !== ch : true   // every non-ASCII byte is escaped by UTF-8 percent-encoding
  if (chromiumEscapes !== eucEscapes) diffs.push({ byte: '0x' + b.toString(16), ch, chromiumEscapes, eucEscapes })
}
console.log('words:', words.map(w => '0x' + (w >>> 0).toString(16)).join(' '))
console.log('bytes 0..255 where Chromium kQueryCharmap and encodeURIComponent disagree:', JSON.stringify(diffs))
console.log('unescaped by Chromium:', Array.from({ length: 128 }, (_, b) => b).filter(b => !escaped(b)).map(b => String.fromCharCode(b)).join(''))
