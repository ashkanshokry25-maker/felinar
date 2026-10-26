import { pathToFileURL } from 'node:url'
const { default: Wire } = await import(pathToFileURL(process.argv[2]).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hs = new Uint8Array(68); hs[0] = 19; hs.set(new TextEncoder().encode('BitTorrent protocol'), 1); hs[25] = 0x10; hs.fill(7, 28, 48); hs.fill(9, 48)
const msg = (id, payload) => { const b = new Uint8Array(4 + 1 + payload.length); new DataView(b.buffer).setUint32(0, 1 + payload.length); b[4] = id; b.set(payload, 5); return b }
async function run (label, build) {
  const w = build(); let closed = false; const seen = []
  w.on('close', () => { closed = true }); w.on('error', (e) => seen.push('error:' + e.message))
  w.on('unchoke', () => seen.push('unchoke')); w.on('bitfield', () => seen.push('bitfield')); w.on('have', () => seen.push('have'))
  w.write(hs); await sleep(10)
  w.write(msg(1, new Uint8Array(0))); await sleep(5)                                   // unchoke
  w.write(msg(5, new Uint8Array(64)))                                                       // bitfield (512 pieces)
  w.write(msg(7, new Uint8Array(8 + 16384))); await sleep(10)                              // piece with 16 KiB block (no outstanding request -> ignored)
  w.write(msg(4, Uint8Array.of(0, 0, 0, 3)))                                                // have
  await sleep(10)
  const legitOk = !closed
  const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, 0x7fffffff)
  w.write(prefix); await sleep(10)
  const t0 = performance.now(); for (let i = 0; i < 64 && !closed; i++) { w.write(new Uint8Array(16384)); await sleep(1) }
  await sleep(30)
  console.log(JSON.stringify({ label, legitMessagesAccepted: legitOk, events: seen.join(','), closedAfter0x7fffffffPrefix: closed, bufferedMiB: +(w._bufferSize / 1048576).toFixed(2), ms: Math.round(performance.now() - t0) }))
}
await run(process.argv[2].split('/').slice(-2).join('/'), () => new (Wire)('webrtc', 0))
