// w2b-04 probe: STUN Binding Request (RFC 5389) over UDP using only node:dgram. Node >= 22.
// Prints one JSON line per server: ok, response type, attribute used, address FAMILY (never the address), RTT.
// Run: node stun-probe.mjs            (needs outbound UDP; unverified on GitHub-hosted runners)
import dgram from 'node:dgram'
import { randomBytes } from 'node:crypto'
import dns from 'node:dns/promises'

export function stunProbe (host, port = 3478, timeoutMs = 3000) {
  return new Promise(async (resolve) => {
    const t0 = performance.now()
    let addr
    try { addr = (await dns.lookup(host, { family: 4 })).address } catch (e) { return resolve({ host, port, ok: false, error: 'dns:' + e.code }) }
    const sock = dgram.createSocket('udp4')
    const txid = randomBytes(12)
    const req = Buffer.alloc(20)
    req.writeUInt16BE(0x0001, 0) // Binding Request
    req.writeUInt16BE(0, 2) // message length
    req.writeUInt32BE(0x2112A442, 4) // magic cookie
    txid.copy(req, 8)
    const done = (r) => { clearTimeout(timer); try { sock.close() } catch {} ; resolve(r) }
    const timer = setTimeout(() => done({ host, port, ok: false, error: 'timeout' }), timeoutMs)
    sock.on('message', (msg) => {
      if (msg.length < 20 || msg.readUInt32BE(4) !== 0x2112A442 || !msg.subarray(8, 20).equals(txid)) return
      const type = msg.readUInt16BE(0)
      let off = 20; let family = null; let attr = null
      while (off + 4 <= msg.length) { // walk TLV attributes, padded to 4 bytes
        const at = msg.readUInt16BE(off); const al = msg.readUInt16BE(off + 2)
        if (at === 0x0020 || at === 0x0001) { family = msg.readUInt8(off + 5) === 1 ? 'IPv4' : 'IPv6'; attr = at === 0x0020 ? 'XOR-MAPPED-ADDRESS' : 'MAPPED-ADDRESS'; break }
        off += 4 + al + ((4 - (al % 4)) % 4)
      }
      done({ host, port, ok: type === 0x0101 && family !== null, type: '0x' + type.toString(16).padStart(4, '0'), attr, family, rttMs: Math.round(performance.now() - t0) })
    })
    sock.send(req, port, addr, (err) => { if (err) done({ host, port, ok: false, error: 'send:' + err.code }) })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [h, p] of [['stun.cloudflare.com', 3478], ['stun.l.google.com', 19302], ['global.stun.twilio.com', 3478]]) console.log(JSON.stringify(await stunProbe(h, p)))
}
