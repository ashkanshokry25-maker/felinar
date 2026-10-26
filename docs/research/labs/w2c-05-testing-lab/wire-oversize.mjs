// Reproduce wave-1 review B4 against the installed bittorrent-protocol@5.0.9: 4 GiB length prefix, then drip data in data-channel-sized chunks.
import Wire from '../../../../node_modules/bittorrent-protocol/index.js';
const hs = new Uint8Array(68); hs[0] = 19; hs.set(new TextEncoder().encode('BitTorrent protocol'), 1); hs[25] = 0x10; hs.fill(7, 28, 48); hs.fill(9, 48, 68);
async function run(chunkBytes, totalMiB) {
  const w = new Wire(); let hsSeen = false; w.on('handshake', () => { hsSeen = true; }); w.on('error', (e) => { console.log('   wire error event:', String(e && e.message).slice(0,120)); });
  w.write(hs); w.write(new Uint8Array([0x7f, 0xff, 0xff, 0xff])); // declared message length = 2,147,483,647 (0xffffffff reads as signed -1 => keep-alive)
  const chunk = new Uint8Array(chunkBytes).fill(0);
  const total = totalMiB * 1024 * 1024; let sent = 0;
  const t0 = process.hrtime.bigint(); const cpu0 = process.cpuUsage(); const rss0 = process.memoryUsage().rss;
  let destroyed = false; w.on('close', () => { destroyed = true; });
  let nextLog = Infinity;
  while (sent < total && !destroyed) { if (sent >= nextLog) { console.log(`   progress fed=${(sent/1048576).toFixed(0)}MiB bufferSize=${(w._bufferSize/1048576).toFixed(1)}MiB writableLength=${w.writableLength} destroyed=${w.destroyed}`); nextLog += 8 * 1048576; } if (!w.write(chunk)) await new Promise((r) => w.once('drain', r)); sent += chunkBytes; }
  await new Promise((r) => setImmediate(r));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6; const cpu = process.cpuUsage(cpu0);
  const m = process.memoryUsage();
  console.log(`chunk=${(chunkBytes / 1024)}KiB fed=${(sent / 1048576).toFixed(0)}MiB wall=${ms.toFixed(0)}ms cpu(user+sys)=${((cpu.user + cpu.system) / 1000).toFixed(0)}ms rssDelta=${((m.rss - rss0) / 1048576).toFixed(0)}MiB bufferSize=${(w._bufferSize / 1048576).toFixed(0)}MiB destroyed=${destroyed} handshakeSeen=${hsSeen}`);
  w.destroy();
}
for (const mib of [4, 16, 32, 64]) await run(16384, mib);
await run(65535, 64);
