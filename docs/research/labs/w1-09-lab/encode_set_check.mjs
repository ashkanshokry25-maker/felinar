// Build the URL Standard sets exactly as defined in url.bs (read above) and compare with encodeURIComponent for U+0000..U+007F.
const c0 = (cp) => cp <= 0x1F || cp > 0x7E
const frag = (cp) => c0(cp) || [0x20,0x22,0x3C,0x3E,0x60].includes(cp)
const query = (cp) => c0(cp) || [0x20,0x22,0x23,0x3C,0x3E].includes(cp)
const path = (cp) => query(cp) || [0x3F,0x5E,0x60,0x7B,0x7D].includes(cp)
const userinfo = (cp) => path(cp) || [0x2F,0x3A,0x3B,0x3D,0x40,0x5B,0x5C,0x5D,0x7C].includes(cp)
const component = (cp) => userinfo(cp) || (cp >= 0x24 && cp <= 0x26) || cp === 0x2B || cp === 0x2C
const diffs = []
for (let cp = 0; cp <= 0x7F; cp++) {
  const ch = String.fromCharCode(cp)
  const urlStd = component(cp)
  const euc = encodeURIComponent(ch) !== ch   // true if encodeURIComponent escapes it
  // DEL (0x7F) and C0 controls: encodeURIComponent escapes them too
  if (urlStd !== euc) diffs.push({ cp: '0x' + cp.toString(16), ch, urlStdEncodes: urlStd, encodeURIComponentEncodes: euc })
}
console.log('ASCII code points where "component percent-encode set" and encodeURIComponent differ:', JSON.stringify(diffs))
const unreserved = []
for (let cp = 0x20; cp < 0x7F; cp++) if (!component(cp)) unreserved.push(String.fromCharCode(cp))
console.log('left unescaped by component set:', unreserved.join(''))
